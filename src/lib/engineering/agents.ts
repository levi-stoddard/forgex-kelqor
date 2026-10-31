import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CHECK_COMMANDS, LIVE_AGENT_EXECUTION_AUTHORIZED, PROTECTED_COMMANDS, type AgentMode, type AgentStatus, type EngAgentId, type EngScope } from "./contract";
import { redactOutput, runProgram, scrubbedEnv, type RunOptions, type RunResult } from "./process";

// Agent adapters for engineering missions. Each is one module behind the same interface, so another agent is one more
// adapter. An adapter only works inside the worktree it is given; KELQOR, not the adapter, collects the change, runs
// the checks and decides what happens next.

export interface AgentContext {
  worktree: string;
  scope: EngScope;
  missionLabel: string;
  signal: AbortSignal;
  /** Records what the agent is doing, for the owner's live view and the mission's log. */
  activity: (summary: string, data?: Record<string, unknown>) => Promise<void>;
}

export interface AgentOutcome {
  summary: string;
  costMicros: number | null;
  costSource: "simulated" | "agent_reported" | "unknown";
}

export class AgentFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFailure";
  }
}

export interface AgentAdapter {
  id: EngAgentId;
  label: string;
  mode: AgentMode;
  status(): Promise<AgentStatus>;
  /** Simulated and automated agents: do the task in the worktree. */
  run?(ctx: AgentContext): Promise<AgentOutcome>;
  /** Manual agents: write the task where the owner can open it, and say what to do. */
  handoff?(ctx: Omit<AgentContext, "signal">, handoffDir: string): Promise<{ file: string; instructions: string }>;
  /** Manual agents: open the worktree (and the task) in the agent's app, at the owner's click. */
  open?(worktree: string, file: string): Promise<void>;
}

export function taskBrief(scope: EngScope, missionLabel: string): string {
  const checks = scope.permissions.checks.map((c) => CHECK_COMMANDS[c].label);
  return [
    `# ${missionLabel}: ${scope.title}`,
    "",
    "## Task",
    scope.task,
    "",
    "## Deliverables",
    scope.deliverables || "(none listed beyond the task)",
    "",
    "## Rules",
    "- Work only in this folder. Don't read or change anything outside it.",
    scope.permissions.editFiles ? "- You may change files in this folder." : "- Don't change any files: investigate and report only.",
    "- Don't run any commands. KELQOR runs the approved checks after you finish" + (checks.length ? ` (${checks.join(", ")}).` : "."),
    "- Don't commit, push, publish, install packages, use the network, or change credentials or settings files.",
    "- Finish with a short summary of what you changed and why. KELQOR collects the change and runs the checks itself.",
  ].join("\n");
}

/**
 * The complete assignment for a Claude conversation (workflow B). It is always read-only, whatever the mission's own
 * permissions: a conversation that can use tools must never change the owner's real workspace, which would bypass
 * the isolated worktree, the checks and the owner's review. The workspace is named for reference only. Copying it
 * starts nothing.
 */
export function assignmentText(scope: EngScope, missionLabel: string, workspace: { name: string; path: string; baseBranch: string } | null, baseCommit: string | null): string {
  return [
    `# ${missionLabel}: ${scope.title}`,
    "",
    "## Task",
    scope.task,
    "",
    "## Deliverables",
    scope.deliverables || "(none listed beyond the task)",
    "",
    "## Rules",
    "- Don't change, create or delete any files anywhere. Reply with text or a patch only.",
    "- Don't run commands, commit, push, publish, install packages, use the network, or touch credentials or settings.",
    "- Your reply is saved in KELQOR as unverified evidence only: it isn't applied, run or counted as tested. Any real change",
    "  goes through KELQOR's isolated worktree and the owner's review.",
    "",
    "## Workspace (for reference, read only; don't edit it)",
    workspace ? `- ${workspace.name}: ${workspace.path}` : "- (not registered any more)",
    `- Branch: ${scope.baseBranch}${baseCommit ? ` at commit ${baseCommit.slice(0, 12)}` : ""}`,
  ].join("\n");
}

/** Text with anything shaped like a credential replaced, and whether something was. For pasted text before it is saved. */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = redactOutput(text);
  // Whole tokens with a known shape.
  const tokens: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /AIza[0-9A-Za-z_-]{30,}/g,
    /sk-ant-[0-9A-Za-z_-]{20,}/g,
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
    /(?<![A-Za-z0-9])[sr]k_(live|test)_[0-9A-Za-z]{16,}/g,
    /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
    /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/g,
    /(?<![A-Za-z0-9])glpat-[\w-]{20,}/g,
    /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g,
    /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
    /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
    /ya29\.[\w-]{20,}/g,
    /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  ];
  for (const re of tokens) out = out.replace(re, "[redacted]");
  // Bearer tokens, keeping the word.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[redacted]");
  // Credentials in a URL, keeping the scheme, user and host; the password runs to the last "@" before the host.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/]+(@)/gi, "$1[redacted]$2");
  // name = value and "name": "value", for any name containing a secret's word (DB_PASSWORD, GITHUB_TOKEN, x-api-key).
  // The runs around the word are bounded: unbounded ones backtrack for minutes on a long line full of "token".
  const NAME = "[A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,40}";
  // A quoted value is removed up to its own closing quote, spaces and the other kind of quote included.
  out = out.replace(new RegExp(`(${NAME})(["']?\\s*[:=]\\s*)(["'])((?:(?!\\3)[^\\r\\n]){1,500})\\3`, "gi"), (m, name: string, sep: string, q: string, value: string) => (value === "[redacted]" ? m : `${name}${sep}${q}[redacted]${q}`));
  out = out.replace(new RegExp(`(${NAME})(["']?\\s*[:=]\\s*)([^\\s"',;]{6,})`, "gi"), (m, name: string, sep: string, value: string) => (value === "[redacted]" ? m : `${name}${sep}[redacted]`));
  return { text: out, redacted: out !== text };
}

// ---- The simulated agent ------------------------------------------------------------------------------------------

const SIM_DELAY_MS = () => Number(process.env.KELQOR_SIM_AGENT_DELAY_MS ?? 400);
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AgentFailure("Cancelled."));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new AgentFailure("Cancelled."))), { once: true });
  });

/**
 * A scripted stand-in for an agent. It calls no AI and costs nothing; every mission it runs is labeled simulated. In
 * KELQOR's demo workspace it makes a small real change (a discount rule and its test), so the review, the checks and
 * applying a change can be shown end to end; anywhere else it only writes a notes file.
 */
export const simulatedAgent: AgentAdapter = {
  id: "simulated",
  label: "Simulated agent",
  mode: "simulated",
  async status() {
    return { id: "simulated", label: "Simulated agent", mode: "simulated", state: "connected", version: null, detail: "Built into KELQOR. Calls no AI and costs nothing; its missions are labeled simulated.", remedy: null, costReporting: "Always $0." };
  },
  async run(ctx) {
    await ctx.activity("Reading the task (simulated)");
    await pause(SIM_DELAY_MS(), ctx.signal);
    await ctx.activity("Looking through the workspace (simulated)", { files: fs.readdirSync(ctx.worktree).filter((f) => f !== ".git").slice(0, 20) });
    await pause(SIM_DELAY_MS(), ctx.signal);
    if (!ctx.scope.permissions.editFiles) {
      await ctx.activity("Writing the report (simulated)");
      return { summary: "Simulated investigation: no files were changed. A real agent would report its findings here.", costMicros: 0, costSource: "simulated" };
    }
    const pricing = path.join(ctx.worktree, "src", "pricing.js");
    if (fs.existsSync(pricing) && fs.readFileSync(pricing, "utf8").includes("quoteTotal")) {
      await ctx.activity("Editing src/pricing.js (simulated)");
      fs.appendFileSync(pricing, "\n// Repeat customers get a discount, never below the shop's minimum.\nexport function discountedTotal(total, percent, minimum = 0) {\n  if (percent < 0 || percent > 50) throw new RangeError(\"discount must be 0-50%\");\n  return Math.max(minimum, Math.round(total * (100 - percent)) / 100);\n}\n");
      await pause(SIM_DELAY_MS(), ctx.signal);
      await ctx.activity("Adding test/discount.test.js (simulated)");
      fs.writeFileSync(
        path.join(ctx.worktree, "test", "discount.test.js"),
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { discountedTotal } from "../src/pricing.js";\n\ntest("a 10% discount", () => {\n  assert.equal(discountedTotal(285, 10), 256.5);\n});\n\ntest("never below the minimum", () => {\n  assert.equal(discountedTotal(100, 50, 60), 60);\n});\n\ntest("refuses an out-of-range discount", () => {\n  assert.throws(() => discountedTotal(100, 80), RangeError);\n});\n',
      );
      return { summary: "Simulated change: added discountedTotal() with a 0-50% range and a minimum, plus three tests.", costMicros: 0, costSource: "simulated" };
    }
    await ctx.activity("Writing KELQOR-SIMULATED-NOTES.md (simulated)");
    fs.writeFileSync(path.join(ctx.worktree, "KELQOR-SIMULATED-NOTES.md"), `# Simulated agent notes for ${ctx.missionLabel}\n\nThis file was written by KELQOR's simulated agent, not by a real AI agent.\n\n${ctx.scope.task}\n`);
    return { summary: "Simulated change: wrote KELQOR-SIMULATED-NOTES.md only.", costMicros: 0, costSource: "simulated" };
  },
};

// ---- Claude Code ------------------------------------------------------------------------------------------------

/** Each automated run's spending ceiling, passed to Claude Code itself: the same $2 as an AI mission's limit. */
export const CLAUDE_RUN_BUDGET_USD = 2;
const CLAUDE_TIMEOUT_MS = 45 * 60_000;

/** The installed Claude Code: KELQOR_CLAUDE_CODE_PATH, then PATH, then the copy the Claude desktop app keeps. */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.KELQOR_CLAUDE_CODE_PATH) return fs.existsSync(env.KELQOR_CLAUDE_CODE_PATH) ? env.KELQOR_CLAUDE_CODE_PATH : null;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of (env.PATH ?? "").split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Claude-Data") : null;
  if (!base || !fs.existsSync(base)) return null;
  const found: { file: string; version: number[] }[] = [];
  for (const profile of fs.readdirSync(base)) {
    const cc = path.join(base, profile, "claude-code");
    if (!fs.existsSync(cc)) continue;
    for (const version of fs.readdirSync(cc)) {
      const vdir = path.join(cc, version);
      if (!/^\d+\.\d+\.\d+$/.test(version) || !fs.statSync(vdir).isDirectory()) continue;
      for (const build of fs.readdirSync(vdir)) if (fs.existsSync(path.join(vdir, build, exe))) found.push({ file: path.join(vdir, build, exe), version: version.split(".").map(Number) });
    }
  }
  found.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return found[0]?.file ?? null;
}

/**
 * The headless Claude Code command line for a mission: restricted mode, and only file tools, named exactly. No shell
 * tool at all: a command it could run (even a test) would run code it wrote, before the owner has seen it.
 */
export function claudeArgs(scope: EngScope, prompt: string): string[] {
  const readTools = ["Read", "Grep", "Glob"];
  const editTools = scope.permissions.editFiles ? ["Edit", "Write"] : [];
  const tools = [...readTools, ...editTools];
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Removes code-running tools and WebFetch unless named, ignores user/project/local settings, confines file tools to
    // the working folder and refuses bypassPermissions.
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    tools.join(","),
    "--allowedTools",
    tools.join(","),
    "--disallowedTools",
    // The worktree's .git file points git at its repository; an agent rewriting it could redirect KELQOR's own git calls.
    ["Bash", "PowerShell", "WebFetch", "WebSearch", "Edit(.git)", "Write(.git)", "Edit(.git/**)", "Write(.git/**)", ...PROTECTED_COMMANDS.map((c) => `Bash(${c.trim()}:*)`)].join(","),
    // Anything not allowed above is refused without asking: there is no one to ask in a headless run.
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    String(CLAUDE_RUN_BUDGET_USD),
  ];
}

type Runner = (program: string, args: string[], o: RunOptions) => Promise<RunResult>;

export function claudeCodeAgent(opts: { find?: () => string | null; run?: Runner; live?: boolean } = {}): AgentAdapter {
  const find = opts.find ?? (() => findClaudeCode());
  const run = opts.run ?? runProgram;
  const live = opts.live ?? LIVE_AGENT_EXECUTION_AUTHORIZED;
  return {
    id: "claude_code",
    label: "Claude Code",
    mode: "automated",
    async status() {
      const base = { id: "claude_code" as const, label: "Claude Code", mode: "automated" as const, costReporting: "Claude Code reports a cost for each run (total_cost_usd). KELQOR records it as agent-reported; with a Claude subscription it may not be what you're billed." };
      const exe = find();
      if (!exe) return { ...base, state: "disconnected", version: null, detail: "Claude Code wasn't found.", remedy: "Install Claude Code, or set KELQOR_CLAUDE_CODE_PATH to claude.exe, then refresh." };
      const v = await run(exe, ["--version"], { cwd: path.dirname(exe), timeoutMs: 20_000, env: scrubbedEnv() });
      const version = v.exitCode === 0 ? (v.stdout.trim().split(/\s/)[0] ?? null) : null;
      if (!version) return { ...base, state: "disconnected", version: null, detail: `Claude Code at ${exe} didn't answer --version.`, remedy: "Open Claude Code once yourself to finish its setup, then refresh." };
      if (!live)
        return { ...base, state: "blocked", version, detail: `Claude Code ${version} is installed (headless mode, restricted). KELQOR won't start it until you authorize live agent execution.`, remedy: "Missions can be drafted and approved now; starting one needs your authorization of live agent execution." };
      return { ...base, state: "connected", version, detail: `Claude Code ${version}, run headless in restricted mode.`, remedy: null };
    },
    async run(ctx) {
      if (!live) throw new AgentFailure("Live agent execution isn't authorized, so Claude Code wasn't started.");
      const exe = find();
      if (!exe) throw new AgentFailure("Claude Code wasn't found.");
      let cost: number | null = null;
      let result = "";
      let isError = false;
      const r = await run(exe, claudeArgs(ctx.scope, taskBrief(ctx.scope, ctx.missionLabel)), {
        cwd: ctx.worktree,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        signal: ctx.signal,
        env: scrubbedEnv(),
        onLine: (line) => {
          let ev: { type?: string; subtype?: string; is_error?: boolean; total_cost_usd?: number; result?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } };
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.type === "assistant") {
            for (const c of ev.message?.content ?? []) {
              if (c.type === "tool_use") void ctx.activity(`Claude Code: ${c.name}${typeof c.input?.file_path === "string" ? ` ${path.relative(ctx.worktree, c.input.file_path as string) || c.input.file_path}` : typeof c.input?.command === "string" ? ` ${String(c.input.command).slice(0, 80)}` : ""}`);
            }
          }
          if (ev.type === "result") {
            result = typeof ev.result === "string" ? ev.result : "";
            isError = ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== "success");
            if (typeof ev.total_cost_usd === "number" && Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0) cost = Math.round(ev.total_cost_usd * 1e6);
          }
        },
      });
      if (r.cancelled) throw new AgentFailure("Cancelled.");
      if (r.timedOut) throw new AgentFailure(`Claude Code didn't finish within ${CLAUDE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
      if (r.exitCode !== 0 || isError) throw new AgentFailure(`Claude Code stopped with an error: ${redactOutput((result || r.stderr || `exit code ${r.exitCode}`).slice(0, 600))}`);
      return { summary: redactOutput(result).slice(0, 4000) || "Claude Code finished without a summary.", costMicros: cost, costSource: cost === null ? "unknown" : "agent_reported" };
    },
  };
}

// ---- Gemini Antigravity (manual handoff) ----------------------------------------------------------------------------

export function findAntigravity(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.KELQOR_ANTIGRAVITY_PATH) return fs.existsSync(env.KELQOR_ANTIGRAVITY_PATH) ? env.KELQOR_ANTIGRAVITY_PATH : null;
  const file = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Antigravity", "Antigravity.exe") : null;
  return file && fs.existsSync(file) ? file : null;
}

/**
 * Antigravity has no supported way for another program to give it a task and follow it, so KELQOR doesn't pretend
 * to. It hands the task over: it writes the brief, opens the mission's worktree in Antigravity when the owner asks,
 * and the owner runs the task there and then imports the result. KELQOR then collects and checks the change exactly
 * as for any other agent. Nothing about Antigravity's own run (its model, its steps, its cost) is known to KELQOR.
 */
export function antigravityAgent(opts: { find?: () => string | null; launch?: (exe: string, args: string[]) => void } = {}, env: NodeJS.ProcessEnv = process.env): AgentAdapter {
  const find = opts.find ?? (() => findAntigravity());
  const launch =
    opts.launch ??
    ((exe: string, args: string[]) => {
      const child = spawn(exe, args, { detached: true, stdio: "ignore", shell: false, windowsHide: false, env: scrubbedEnv() });
      child.unref();
    });
  return {
    id: "antigravity",
    label: "Gemini Antigravity",
    mode: "manual",
    async status() {
      const exe = find();
      const base = { id: "antigravity" as const, label: "Gemini Antigravity", mode: "manual" as const, version: null, costReporting: "Unknown: Antigravity doesn't report usage to KELQOR." };
      if (!exe) return { ...base, state: "disconnected", detail: "Antigravity wasn't found.", remedy: "Install Antigravity, or set KELQOR_ANTIGRAVITY_PATH to Antigravity.exe, then refresh." };
      const cli = env.LOCALAPPDATA && fs.existsSync(path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
      return {
        ...base,
        state: "connected",
        detail: `Found at ${exe}. Manual handoff: you run the task in Antigravity, then import the result. KELQOR can't start, watch or limit it: inside Antigravity the mission's permissions are only advice, and only the import is controlled.${cli ? " Its command-line tool (agy) is installed too, but KELQOR doesn't drive it: it has no way to name the only tools allowed or keep file access inside one folder." : ""}`,
        remedy: null,
      };
    },
    async handoff(ctx, handoffDir) {
      fs.mkdirSync(handoffDir, { recursive: true });
      const file = path.join(handoffDir, `${ctx.missionLabel}.md`);
      fs.writeFileSync(file, `${taskBrief(ctx.scope, ctx.missionLabel)}\n\n## Where to work\n${ctx.worktree}\n`);
      return {
        file,
        instructions: [
          "1. Click Open in Antigravity (or open the folder below in Antigravity yourself).",
          `2. Give Antigravity the task in ${path.basename(file)}, and let it work only in that folder.`,
          "3. When it's done, come back here and click Import results. KELQOR collects the change for your review.",
          "KELQOR can't enforce this mission's permissions inside Antigravity, which has its own file and terminal access. Only the import is controlled.",
        ].join("\n"),
      };
    },
    async open(worktree, file) {
      const exe = find();
      if (!exe) throw new AgentFailure("Antigravity wasn't found.");
      launch(exe, [worktree, file]);
    },
  };
}

// ---- Claude Code (manual handoff) ----------------------------------------------------------------------------------

/**
 * Claude Code run by the owner, not by KELQOR: an operating mode beside the automated adapter above, which stays built
 * and switched off. KELQOR prepares the isolated worktree and the brief, opens the folder at the owner's click, and
 * imports what is there when the owner says it's done; then it collects, checks and reviews the change like any
 * other. KELQOR never starts Claude Code in this mode, so it can't enforce the mission's permissions inside it, and
 * it doesn't know the run's cost (it is billed to the owner's own Claude plan).
 */
export function claudeCodeManualAgent(opts: { find?: () => string | null; run?: Runner; launch?: (exe: string, args: string[]) => void } = {}): AgentAdapter {
  const find = opts.find ?? (() => findClaudeCode());
  const run = opts.run ?? runProgram;
  const launch =
    opts.launch ??
    ((exe: string, args: string[]) => {
      const child = spawn(exe, args, { detached: true, stdio: "ignore", shell: false, windowsHide: false, env: scrubbedEnv() });
      child.unref();
    });
  return {
    id: "claude_code_manual",
    label: "Claude Code (manual handoff)",
    mode: "manual",
    async status() {
      const exe = find();
      const v = exe ? await run(exe, ["--version"], { cwd: path.dirname(exe), timeoutMs: 20_000, env: scrubbedEnv() }) : null;
      const version = v && v.exitCode === 0 ? (v.stdout.trim().split(/\s/)[0] ?? null) : null;
      return {
        id: "claude_code_manual",
        label: "Claude Code (manual handoff)",
        mode: "manual",
        state: "connected",
        version,
        detail: `${version ? `Claude Code ${version} is installed. ` : ""}Manual handoff: you run Claude Code yourself in the mission's folder (the Claude app's Code tab, or claude in a terminal there), then import the result. KELQOR doesn't start Claude Code in this mode, so it can't enforce the mission's permissions inside it; only the import is controlled.`,
        remedy: null,
        costReporting: "Unknown: a run you start yourself is billed to your own Claude plan, and KELQOR doesn't see it.",
      };
    },
    async handoff(ctx, handoffDir) {
      fs.mkdirSync(handoffDir, { recursive: true });
      const file = path.join(handoffDir, `${ctx.missionLabel}.md`);
      fs.writeFileSync(file, `${taskBrief(ctx.scope, ctx.missionLabel)}\n\n## Where to work\n${ctx.worktree}\n`);
      return {
        file,
        instructions: [
          "1. Click Open the folder to see the mission's isolated folder (it's a separate copy; your workspace isn't touched).",
          "2. Open Claude Code in that folder: in the Claude app's Code tab choose that folder, or run claude in a terminal there.",
          `3. Give it the task in ${path.basename(file)} (paste it in), keep Claude Code's own permission prompts on, and let it work only in that folder.`,
          "4. When it's done, come back here and click Import results. KELQOR collects the change for your review.",
          "KELQOR doesn't start or watch Claude Code in this mode, so it can't enforce this mission's permissions there. Only the import is controlled.",
        ].join("\n"),
      };
    },
    async open(worktree) {
      const explorer = process.env.SystemRoot ? path.join(process.env.SystemRoot, "explorer.exe") : null;
      if (!explorer || !fs.existsSync(explorer)) throw new AgentFailure("File Explorer wasn't found, so open the folder yourself.");
      launch(explorer, [worktree]);
    },
  };
}

export function agentAdapters(): Record<EngAgentId, AgentAdapter> {
  return { simulated: simulatedAgent, claude_code: claudeCodeAgent(), antigravity: antigravityAgent(), claude_code_manual: claudeCodeManualAgent() };
}
