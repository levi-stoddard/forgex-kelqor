import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designateFounder } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { engMissions } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { createUserWithRole } from "@/lib/domain/accounts";
import { antigravityAgent, claudeArgs, claudeCodeAgent, claudeCodeManualAgent, simulatedAgent, taskBrief, type AgentAdapter } from "@/lib/engineering/agents";
import type { EngAgentId, EngScope } from "@/lib/engineering/contract";
import { EngineeringExecutor, recoverEngineeringAtStartup } from "@/lib/engineering/executor";
import { git } from "@/lib/engineering/git";
import { createEngMission, engMissionAction, getEngMission, updateEngMission } from "@/lib/engineering/service";
import { addWorkspace, demoWorkspace } from "@/lib/engineering/workspaces";
import { actorFor, freshDb, TEST_PASSWORD } from "./helpers";

// Milestone 3, the implementation agent's tests: the engineering mission lifecycle end to end with the simulated agent on KELQOR's demo
// workspace, in a temporary folder, plus the Claude Code and Antigravity adapters with fake processes. No real agent is
// ever started and nothing reaches the network.

const ENG = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-m3-"));
process.env.KELQOR_ENG_DIR = ENG;
process.env.KELQOR_SIM_AGENT_DELAY_MS = "5";
const rid = () => randomUUID();
// Fake PEM blocks for the redaction tests, assembled at run time.
const fakePem = (kind: string, body: string) => `-----BEGIN ${kind}PRIVATE` + ` KEY-----\n${body}\n-----END ${kind}PRIVATE` + ` KEY-----`;

let db: DB;
let close: () => Promise<void>;
let founder: Actor;
let operator: Actor;
let demoId: string;

function adapters(over: Partial<Record<EngAgentId, AgentAdapter>> = {}): Record<EngAgentId, AgentAdapter> {
  return {
    simulated: simulatedAgent,
    claude_code: claudeCodeAgent({ find: () => "C:/fake/claude.exe", run: async () => ({ exitCode: 0, stdout: "2.1.309 (Claude Code)", stderr: "", timedOut: false, cancelled: false, durationMs: 1 }) }),
    antigravity: antigravityAgent({ find: () => "C:/fake/Antigravity.exe", launch: () => undefined }),
    claude_code_manual: claudeCodeManualAgent({ find: () => "C:/fake/claude.exe", run: async () => ({ exitCode: 0, stdout: "2.1.309 (Claude Code)", stderr: "", timedOut: false, cancelled: false, durationMs: 1 }), launch: () => undefined }),
    ...over,
  };
}
const executor = (a = adapters()) => new EngineeringExecutor(() => a);

const input = (patch: Record<string, unknown> = {}) => ({
  title: "Add a repeat-customer discount",
  task: "Add a discount for repeat customers to the quote pricing, with tests.",
  deliverables: "The function and its tests.",
  workspaceId: demoId,
  agent: "simulated",
  permissions: { editFiles: true, checks: ["node-test"] },
  ...patch,
});

async function approved(patch: Record<string, unknown> = {}, a = adapters()) {
  const m = await createEngMission(db, operator, input(patch), rid());
  await engMissionAction(db, operator, m.id, "submit", { requestId: rid() }, { executor: executor(a), adapters: a });
  const d = await getEngMission(db, founder, m.id, a);
  return engMissionAction(db, founder, m.id, "approve", { requestId: rid(), fingerprint: d.scopeFingerprint }, { executor: executor(a), adapters: a });
}

beforeAll(async () => {
  const h = await freshDb();
  db = h.db;
  close = h.close;
  await createUserWithRole(db, { name: "Fran Owner", email: "fran@test.local", password: TEST_PASSWORD, role: "operator" });
  await designateFounder(db, { email: "fran@test.local", password: TEST_PASSWORD });
  founder = await actorFor(db, (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, "fran@test.local") }))!.id);
  operator = await actorFor(db, await createUserWithRole(db, { name: "Oscar Operator", email: "oscar@test.local", password: TEST_PASSWORD, role: "operator" }));
  demoId = (await demoWorkspace(db, founder)).id;
});

afterAll(async () => {
  await close();
  fs.rmSync(ENG, { recursive: true, force: true });
});

describe("an engineering mission with the simulated agent, end to end", () => {
  it("drafts, approves, runs in an isolated worktree, is tested, reviewed and applied to a new local branch", async () => {
    const ex = executor();
    const m = await approved();
    expect(m.status).toBe("approved");
    expect(m.simulated).toBe(true);
    const demo = m.workspace!.path;
    const headBefore = (await git(demo, ["rev-parse", "HEAD"])).trim();
    const started = await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex, adapters: adapters() });
    expect(started.status).toBe("running");
    await ex.idle(m.id);
    const done = await getEngMission(db, founder, m.id);
    expect(done.status).toBe("review");
    expect(done.changeState).toBe("tested");
    expect(done.worktreePath).toContain(path.join(ENG, "worktrees"));
    expect(done.deliverable!.files.map((f) => f.path).sort()).toEqual(["src/pricing.js", "test/discount.test.js"]);
    expect(done.deliverable!.checks).toEqual([expect.objectContaining({ check: "node-test", passed: true })]);
    expect(done.deliverable!.diff).toContain("discountedTotal");
    expect(done.costSource).toBe("simulated");
    expect(done.costMicros).toBe(0);
    // The workspace itself is untouched: same commit, clean working tree, no new file.
    expect((await git(demo, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect((await git(demo, ["status", "--porcelain"])).trim()).toBe("");
    expect(fs.existsSync(path.join(demo, "test", "discount.test.js"))).toBe(false);
    // Applying needs the owner's approval of the change first.
    await expect(engMissionAction(db, founder, m.id, "apply", { requestId: rid() }, { executor: ex })).rejects.toMatchObject({ code: "conflict" });
    await engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: done.deliverable!.tree }, { executor: ex });
    const applied = await engMissionAction(db, founder, m.id, "apply", { requestId: rid() }, { executor: ex });
    expect(applied.status).toBe("completed");
    expect(applied.changeState).toBe("applied");
    expect(applied.appliedBranch).toBe(`kelqor/eng/${applied.label.toLowerCase()}`);
    // The branch exists in the workspace's repository; its checked-out branch and files are unchanged.
    expect((await git(demo, ["rev-parse", applied.appliedBranch!])).trim()).toBe(applied.appliedCommit);
    // The commit holds exactly the reviewed and tested tree.
    expect((await git(demo, ["rev-parse", `${applied.appliedCommit}^{tree}`])).trim()).toBe(done.deliverable!.tree);
    expect(done.deliverable!.checkedTree).toBe(done.deliverable!.tree);
    expect((await git(demo, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect((await git(demo, ["status", "--porcelain"])).trim()).toBe("");
    expect(applied.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["action", "state", "activity", "check", "artifact"]));
  });

  it("only the owner approves, starts or reviews; an operator can draft and submit", async () => {
    const m = await createEngMission(db, operator, input(), rid());
    await engMissionAction(db, operator, m.id, "submit", { requestId: rid() }, { executor: executor() });
    const d = await getEngMission(db, operator, m.id);
    expect(d.allowed.approve).toBe(false);
    await expect(engMissionAction(db, operator, m.id, "approve", { requestId: rid(), fingerprint: d.scopeFingerprint }, { executor: executor() })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("an edit voids the approval, and a stale approval is refused", async () => {
    const m = await approved();
    const edited = await updateEngMission(db, operator, m.id, input({ task: "Add a discount for repeat customers, capped at 20%, with tests." }), rid());
    expect(edited.status).toBe("awaiting_approval");
    expect(edited.approval).toBeNull();
    expect(edited.scopeFingerprint).not.toBe(m.scopeFingerprint);
    await expect(engMissionAction(db, founder, m.id, "approve", { requestId: rid(), fingerprint: m.scopeFingerprint }, { executor: executor() })).rejects.toMatchObject({ code: "conflict" });
    await expect(engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: executor() })).rejects.toMatchObject({ code: "conflict" });
  });

  it("starts once, whatever the clicks: the same request twice, or two requests at once", async () => {
    const ex = executor();
    const m = await approved();
    const req = rid();
    const results = await Promise.allSettled([
      engMissionAction(db, founder, m.id, "start", { requestId: req }, { executor: ex }),
      engMissionAction(db, founder, m.id, "start", { requestId: req }, { executor: ex }),
      engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await ex.idle(m.id);
    const d = await getEngMission(db, founder, m.id);
    expect(d.events.filter((e) => e.kind === "state" && e.summary.startsWith("running"))).toHaveLength(1);
    expect(d.status).toBe("review");
  });

  it("cancels a running mission into Interrupted, keeps its worktree, and resumes on the owner's word", async () => {
    process.env.KELQOR_SIM_AGENT_DELAY_MS = "400";
    const ex = executor();
    try {
      const m = await approved();
      await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex });
      await new Promise((r) => setTimeout(r, 150));
      const c = await engMissionAction(db, founder, m.id, "cancel", { requestId: rid() }, { executor: ex });
      expect(c.status).toBe("interrupted");
      await ex.idle(m.id);
      expect((await getEngMission(db, founder, m.id)).status).toBe("interrupted");
      process.env.KELQOR_SIM_AGENT_DELAY_MS = "5";
      await engMissionAction(db, founder, m.id, "resume", { requestId: rid() }, { executor: ex });
      await ex.idle(m.id);
      expect((await getEngMission(db, founder, m.id)).status).toBe("review");
    } finally {
      process.env.KELQOR_SIM_AGENT_DELAY_MS = "5";
    }
  });

  it("makes a mission left running Interrupted at start-up, and starts nothing", async () => {
    const m = await approved();
    await db.update(engMissions).set({ status: "running", runId: rid(), activity: "Simulated agent is working" }).where(eq(engMissions.id, m.id));
    expect(await recoverEngineeringAtStartup(db)).toBeGreaterThanOrEqual(1);
    const d = await getEngMission(db, founder, m.id);
    expect(d.status).toBe("interrupted");
    expect(d.stateReason).toMatch(/KELQOR closed/);
  });

  it("blocks a change that touches a protected file, so it can't be approved or applied", async () => {
    const sneaky: AgentAdapter = {
      ...simulatedAgent,
      async run(ctx) {
        fs.writeFileSync(path.join(ctx.worktree, ".env"), "GEMINI_API_KEY=not-a-key\n");
        fs.appendFileSync(path.join(ctx.worktree, "README.md"), "\nchanged\n");
        return { summary: "wrote .env", costMicros: 0, costSource: "simulated" };
      },
    };
    const a = adapters({ simulated: sneaky });
    const ex = executor(a);
    const m = await approved({}, a);
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const d = await getEngMission(db, founder, m.id, a);
    expect(d.status).toBe("review");
    expect(d.deliverable!.protectedFiles).toEqual([".env"]);
    expect(d.allowed.approve_change).toBe(false);
    await expect(engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: d.deliverable!.tree }, { executor: ex, adapters: a })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the simulated agent outside the demo workspace, and real agents in it", async () => {
    await expect(createEngMission(db, operator, input({ agent: "claude_code" }), rid())).rejects.toThrow(/demo workspace is for the simulated agent/);
  });
});

describe("the change applied is exactly the change reviewed (the security reviewer H1, H2)", () => {
  it("refuses a worktree whose .git file the agent rewrote, and never runs the git config it planted", async () => {
    const marker = path.join(ENG, `planted-${Date.now()}.txt`);
    const sneaky: AgentAdapter = {
      ...simulatedAgent,
      async run(ctx) {
        const evil = path.join(ctx.worktree, "evilrepo");
        await git(ctx.worktree, ["init", evil]);
        const nodeCmd = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`;
        fs.appendFileSync(path.join(evil, ".git", "config"), `[filter "x"]\n\tclean = ${nodeCmd.replace(/\\/g, "/")}\n`);
        fs.writeFileSync(path.join(ctx.worktree, ".gitattributes"), "* filter=x\n");
        // git hides the .git file on Windows, which refuses to overwrite a hidden file in place; an agent just replaces it.
        fs.rmSync(path.join(ctx.worktree, ".git"), { force: true });
        fs.writeFileSync(path.join(ctx.worktree, ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
        return { summary: "redirected .git", costMicros: 0, costSource: "simulated" };
      },
    };
    const a = adapters({ simulated: sneaky });
    const ex = executor(a);
    const m = await approved({}, a);
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const d = await getEngMission(db, founder, m.id, a);
    expect(d.status).toBe("failed");
    expect(d.stateReason).toMatch(/\.git file was changed/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses to approve or apply a change that moved after it was collected or approved", async () => {
    const ex = executor();
    const m = await approved();
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex });
    await ex.idle(m.id);
    const d = await getEngMission(db, founder, m.id);
    expect(d.status).toBe("review");
    // A tree the window didn't show is refused.
    await expect(engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: "0".repeat(40) }, { executor: ex })).rejects.toThrow(/differs from the one you reviewed/);
    // An edit after collection: approval is refused.
    const file = path.join(d.worktreePath!, "src", "pricing.js");
    const original = fs.readFileSync(file, "utf8");
    fs.appendFileSync(file, "// slipped in after review\n");
    await expect(engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: d.deliverable!.tree }, { executor: ex })).rejects.toThrow(/worktree changed/);
    fs.writeFileSync(file, original);
    await engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: d.deliverable!.tree }, { executor: ex });
    // An edit after approval: nothing is applied, and no branch appears.
    fs.writeFileSync(path.join(d.worktreePath!, "extra.js"), "export const sneaky = true;\n");
    await expect(engMissionAction(db, founder, m.id, "apply", { requestId: rid() }, { executor: ex })).rejects.toThrow(/changed after you approved/);
    expect((await git(d.workspace!.path, ["branch", "--list", `kelqor/eng/${d.label.toLowerCase()}`])).trim()).toBe("");
    expect((await getEngMission(db, founder, m.id)).status).toBe("review");
  });

  it("lets an approval lapse at Boise midnight, and the owner renews it", async () => {
    const m = await approved();
    await db.update(engMissions).set({ approvedAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(engMissions.id, m.id));
    const lapsed = await getEngMission(db, founder, m.id);
    expect(lapsed.allowed.start).toBe(false);
    expect(lapsed.allowed.approve).toBe(true);
    await expect(engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: executor() })).rejects.toThrow(/lapsed at Boise midnight/);
    const renewed = await engMissionAction(db, founder, m.id, "approve", { requestId: rid(), fingerprint: m.scopeFingerprint }, { executor: executor() });
    expect(renewed.status).toBe("approved");
    expect(renewed.allowed.start).toBe(true);
  });
});

describe("checks on Windows (the security reviewer M1, M2)", () => {
  it.runIf(process.platform === "win32")("runs an npm test check through cmd, and never a planted npm.cmd", async () => {
    const { runChecks } = await import("@/lib/engineering/checks");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-m3-npm-"));
    const marker = path.join(dir, "planted-ran.txt");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }));
    fs.writeFileSync(path.join(dir, "npm.cmd"), `@echo planted > "${marker}"\r\n@exit /b 0\r\n`);
    fs.writeFileSync(path.join(dir, "node.cmd"), `@echo planted > "${marker}"\r\n@exit /b 0\r\n`);
    const [r] = await runChecks(dir, ["npm-test"], new AbortController().signal);
    expect(r).toMatchObject({ check: "npm-test", passed: true, exitCode: 0 });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("real agents", () => {
  let repoWs: string;
  beforeAll(async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-m3-repo-"));
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "index.js"), "export const x = 1;\n");
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    repoWs = (await addWorkspace(db, founder, { name: "A repo", path: repo, baseBranch: "main" })).id;
  });

  it("Claude Code can be drafted and approved, but not started until live execution is authorized", async () => {
    const m = await approved({ agent: "claude_code", workspaceId: repoWs });
    expect(m.allowed.start).toBe(false);
    await expect(engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: executor() })).rejects.toThrow(/Live agent execution isn't authorized/);
    expect((await getEngMission(db, founder, m.id)).status).toBe("approved");
    expect((await claudeCodeAgent({ find: () => "C:/fake/claude.exe", run: async () => ({ exitCode: 0, stdout: "2.1.309 (Claude Code)", stderr: "", timedOut: false, cancelled: false, durationMs: 1 }) }).status()).state).toBe("blocked");
  });

  it("runs Claude Code headless in restricted mode, with only the file tools the mission allows and no shell", () => {
    const scope: EngScope = { title: "t", task: "do it", deliverables: "", workspaceId: "w", workspacePath: "C:/r", baseBranch: "main", agent: "claude_code", permissions: { editFiles: true, checks: ["vitest"] } };
    const args = claudeArgs(scope, taskBrief(scope, "E-0001"));
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--tools")).toBe("Read,Grep,Glob,Edit,Write");
    expect(flag("--allowedTools")).toBe("Read,Grep,Glob,Edit,Write");
    expect(flag("--disallowedTools").split(",")).toEqual(expect.arrayContaining(["Bash", "PowerShell", "WebFetch", "WebSearch"]));
    expect(flag("--disallowedTools")).toMatch(/Bash\(git push:\*\)/);
    expect(flag("--max-budget-usd")).toBe("2");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("--add-dir");
    const readOnly = claudeArgs({ ...scope, permissions: { editFiles: false, checks: [] } }, "x");
    expect(readOnly[readOnly.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  });

  it("reads Claude Code's reported cost as agent-reported, and refuses to run while live execution is off", async () => {
    const lines = [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:/w/index.js" } }] } }), JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0421, result: "Done." })];
    const fakeRun = async (_p: string, _a: string[], o: { onLine?: (l: string) => void }) => {
      for (const l of lines) o.onLine?.(l);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, durationMs: 1 };
    };
    const ctx = { worktree: "C:/w", scope: { title: "t", task: "t", deliverables: "", workspaceId: "w", workspacePath: "C:/r", baseBranch: "main", agent: "claude_code" as const, permissions: { editFiles: true, checks: [] } }, missionLabel: "E-0009", signal: new AbortController().signal, activity: async () => undefined };
    await expect(claudeCodeAgent({ find: () => "C:/fake/claude.exe", run: fakeRun }).run!(ctx)).rejects.toThrow(/isn't authorized/);
    const out = await claudeCodeAgent({ find: () => "C:/fake/claude.exe", run: fakeRun, live: true }).run!(ctx);
    expect(out).toEqual({ summary: "Done.", costMicros: 42_100, costSource: "agent_reported" });
  });

  it("hands an Antigravity mission over, waits for the owner, then imports, checks and reviews it", async () => {
    let launched: string[] | null = null;
    const a = adapters({ antigravity: antigravityAgent({ find: () => "C:/fake/Antigravity.exe", launch: (_exe, args) => void (launched = args) }) });
    const ex = executor(a);
    const m = await approved({ agent: "antigravity", workspaceId: repoWs, permissions: { editFiles: true, checks: ["node-test"] } }, a);
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const waiting = await getEngMission(db, founder, m.id, a);
    expect(waiting.status).toBe("running");
    expect(waiting.handoff?.instructions).toMatch(/Import results/);
    expect(fs.readFileSync(waiting.handoff!.file, "utf8")).toContain("Work only in this folder");
    expect(waiting.allowed.import).toBe(true);
    await engMissionAction(db, founder, m.id, "open_agent", { requestId: rid() }, { executor: ex, adapters: a });
    expect(launched).toEqual([waiting.worktreePath, waiting.handoff!.file]);
    // Recovery leaves a handoff waiting: nothing of KELQOR's was running.
    await recoverEngineeringAtStartup(db);
    expect((await getEngMission(db, founder, m.id, a)).status).toBe("running");
    // The owner's work in Antigravity, simulated here by editing the worktree.
    fs.appendFileSync(path.join(waiting.worktreePath!, "index.js"), "export const y = 2;\n");
    await engMissionAction(db, founder, m.id, "import", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const reviewed = await getEngMission(db, founder, m.id, a);
    expect(reviewed.status).toBe("review");
    expect(reviewed.changeState).toBe("proposed");
    expect(reviewed.costSource).toBe("none");
    expect(reviewed.costMicros).toBeNull();
    expect(reviewed.deliverable!.files).toEqual([expect.objectContaining({ path: "index.js", status: "modified", additions: 1 })]);
    // A real agent's checks run the agent's code, so they wait for the owner to start them.
    expect(reviewed.deliverable!.checks).toEqual([]);
    expect(reviewed.allowed.run_checks).toBe(true);
    await engMissionAction(db, founder, m.id, "run_checks", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const checked = await getEngMission(db, founder, m.id, a);
    expect(checked.deliverable!.checks).toEqual([expect.objectContaining({ check: "node-test", passed: true })]);
    expect(checked.changeState).toBe("tested");
  });

  it("never runs a program an agent planted in its worktree: programs resolve on PATH only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-m3-plant-"));
    for (const name of ["node.exe", "npm.cmd", "git.exe", "node", "git"]) fs.writeFileSync(path.join(dir, name), "planted");
    const { resolveProgram } = await import("@/lib/engineering/process");
    for (const name of ["node", "git"]) {
      const found = resolveProgram(name);
      expect(found).toBeTruthy();
      expect(path.dirname(found!).toLowerCase()).not.toBe(dir.toLowerCase());
    }
    expect(resolveProgram("..\\node.exe")).toBeNull();
  });

  it("runs Claude Code as a manual handoff beside the automated adapter, which stays built and off", async () => {
    let launched: string[] | null = null;
    let ran: string[][] = [];
    const fakeRun = async (_p: string, args: string[]) => ((ran = [...ran, args]), { exitCode: 0, stdout: "2.1.309 (Claude Code)", stderr: "", timedOut: false, cancelled: false, durationMs: 1 });
    const manual = claudeCodeManualAgent({ find: () => "C:/fake/claude.exe", run: fakeRun, launch: (_exe, args) => void (launched = args) });
    const a = adapters({ claude_code_manual: manual });
    const ex = executor(a);
    // Both Claude modes are listed: the automated one blocked until authorized, the manual one available now.
    const s = await manual.status();
    expect(s).toMatchObject({ id: "claude_code_manual", mode: "manual", state: "connected", version: "2.1.309" });
    expect(s.detail).toMatch(/can't enforce/);
    expect((await a.claude_code.status()).state).toBe("blocked");
    const m = await approved({ agent: "claude_code_manual", workspaceId: repoWs, permissions: { editFiles: true, checks: ["node-test"] } }, a);
    expect(m.allowed.start).toBe(true);
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const waiting = await getEngMission(db, founder, m.id, a);
    expect(waiting.status).toBe("running");
    expect(waiting.agentMode).toBe("manual");
    expect(waiting.handoff?.instructions).toMatch(/Claude app's Code tab/);
    expect(fs.readFileSync(waiting.handoff!.file, "utf8")).toContain("Don't run any commands");
    // KELQOR only ever asked Claude Code for its version; it never started a task.
    expect(ran.every((args) => args.length === 1 && args[0] === "--version")).toBe(true);
    await engMissionAction(db, founder, m.id, "open_agent", { requestId: rid() }, { executor: ex, adapters: a });
    expect(launched).toEqual([waiting.worktreePath]);
    // The owner's Claude Code session, simulated here by editing the worktree; then import, checks, review, apply.
    fs.appendFileSync(path.join(waiting.worktreePath!, "index.js"), "export const z = 3;\n");
    await engMissionAction(db, founder, m.id, "import", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const reviewed = await getEngMission(db, founder, m.id, a);
    expect(reviewed).toMatchObject({ status: "review", changeState: "proposed", costSource: "none", costMicros: null, simulated: false });
    await engMissionAction(db, founder, m.id, "run_checks", { requestId: rid() }, { executor: ex, adapters: a });
    await ex.idle(m.id);
    const checked = await getEngMission(db, founder, m.id, a);
    expect(checked.changeState).toBe("tested");
    await engMissionAction(db, founder, m.id, "approve_change", { requestId: rid(), tree: checked.deliverable!.tree }, { executor: ex, adapters: a });
    const applied = await engMissionAction(db, founder, m.id, "apply", { requestId: rid() }, { executor: ex, adapters: a });
    expect(applied).toMatchObject({ status: "completed", changeState: "applied" });
  });

  it("keeps an existing automated Claude Code mission record valid and still gated", async () => {
    const m = await approved({ agent: "claude_code", workspaceId: repoWs, permissions: { editFiles: true, checks: [] } });
    const d = await getEngMission(db, founder, m.id);
    expect(d).toMatchObject({ agent: "claude_code", agentMode: "automated", status: "approved" });
    expect(d.allowed.start).toBe(false);
  });

  it("refuses a workspace that isn't a repository's top folder, or KELQOR's own data", async () => {
    await expect(addWorkspace(db, founder, { name: "Not a repo", path: os.tmpdir(), baseBranch: "main" })).rejects.toThrow();
    await expect(addWorkspace(db, operator, { name: "x", path: ENG, baseBranch: "main" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(addWorkspace(db, founder, { name: "Worktrees", path: path.join(ENG, "worktrees"), baseBranch: "main" })).rejects.toThrow(/can't be an engineering workspace/);
  });
});

describe("working with Claude by copy and paste (workflow B)", () => {
  const KEY = `AIza${"Q".repeat(35)}`;
  const pasted = [
    "I'd add discountedTotal() to src/pricing.js and three tests. All tests pass!",
    `Use this key: ${KEY} and sk-ant-${"z".repeat(30)}`,
    "password: hunter2hunter2",
    fakePem("RSA ", "MIIEabc"),
  ].join("\n");

  it("gives a complete assignment for an approved mission without starting anything", async () => {
    const m = await approved({ title: "Copy-paste mission", task: "Explain how quote totals are computed and propose a discount rule." });
    const d = await getEngMission(db, founder, m.id);
    for (const part of ["E-", "Copy-paste mission", "Explain how quote totals are computed", "## Deliverables", "## Rules", "commit, push", "## Workspace", d.workspace!.path, "Branch: main", "unverified evidence"]) expect(d.assignment).toContain(part);
    expect(d.status).toBe("approved");
    expect(d.worktreePath).toBeNull();
    expect(d.events.filter((e) => e.kind === "state").map((e) => e.summary)).toEqual(["awaiting_approval", "approved"]);
  });

  it("saves a pasted response as unverified evidence, with secrets removed, and changes nothing about the mission", async () => {
    const ex = executor();
    const m = await approved();
    await engMissionAction(db, founder, m.id, "start", { requestId: rid() }, { executor: ex });
    await ex.idle(m.id);
    const before = await getEngMission(db, founder, m.id);
    expect(before.status).toBe("review");
    const after = await engMissionAction(db, founder, m.id, "add_response", { requestId: rid(), response: pasted }, { executor: ex });
    expect(after.responses).toHaveLength(1);
    const r = after.responses[0];
    expect(r.redacted).toBe(true);
    expect(r.text).toContain("All tests pass!");
    for (const secret of [KEY, "sk-ant-", "hunter2hunter2", "MIIEabc"]) expect(r.text).not.toContain(secret);
    // The log names the response but never repeats its text.
    expect(JSON.stringify(after.events)).not.toContain("All tests pass");
    expect(JSON.stringify(after.events)).not.toContain(KEY);
    // Nothing about execution, the change, its checks, approval or what may be applied moved.
    for (const k of ["status", "changeState", "scopeFingerprint", "approval", "deliverable", "appliedBranch", "appliedCommit", "costMicros", "costSource"] as const) expect(after[k]).toEqual(before[k]);
    expect(after.allowed).toEqual(before.allowed);
    await expect(engMissionAction(db, founder, m.id, "apply", { requestId: rid() }, { executor: ex })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the copied assignment read-only even when the mission may change files (the security reviewer R1)", async () => {
    const m = await approved({ permissions: { editFiles: true, checks: ["node-test"] } });
    const d = await getEngMission(db, founder, m.id);
    expect(d.assignment).not.toContain("You may change files");
    expect(d.assignment).not.toContain("Work only in this folder");
    expect(d.assignment).toContain("Don't change, create or delete any files anywhere. Reply with text or a patch only.");
    expect(d.assignment).toContain("for reference, read only; don't edit it");
  });

  it("removes the common secret formats from a pasted response (the security reviewer R2)", async () => {
    const { redactSecrets } = await import("@/lib/engineering/agents");
    const cases: Record<string, [string, string]> = {
      envPrefixed: ["DB_PASSWORD=Sup3rS3cretValue", "Sup3rS3cretValue"],
      githubTokenEnv: ["GITHUB_TOKEN=abcdef1234567890abcdef", "abcdef1234567890abcdef"],
      awsSecret: ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
      jsonKey: ['"api_key": "abcd1234efgh5678"', "abcd1234efgh5678"],
      jsonPassword: ['{"password":"hunter2hunter2"}', "hunter2hunter2"],
      bearer: [`Authorization: Bearer ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcDEF123"].join(".")}`, "eyJhbGciOiJIUzI1NiJ9"],
      stripe: ["sk_" + "live_51HabcdefghijklmnopqrstuVWX", "51Habcdefghij"],
      connStr: ["postgres://admin:Pa55word99@db.example.com:5432/app", "Pa55word99"],
      googleOauth: ["ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz0123", "a0AfH6SMB"],
      plainPassword: ["password: hunter2xyz", "hunter2xyz"],
      ghp: [`ghp_${"a".repeat(36)}`, "a".repeat(36)],
      pemRsa: [fakePem("RSA ", "MIIabc"), "MIIabc"],
      openssh: [fakePem("OPENSSH ", "b3Bl"), "b3Bl"],
      jwt: [`token ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcDEF123456"].join(".")}`, "eyJzdWIiOiIxIn0"],
      gitlab: [`glpat-${"x".repeat(20)}`, "x".repeat(20)],
      npm: [`npm_${"y".repeat(36)}`, "y".repeat(36)],
    };
    for (const [name, [input, secret]] of Object.entries(cases)) {
      const r = redactSecrets(input);
      expect(r.redacted, name).toBe(true);
      expect(r.text, name).not.toContain(secret);
    }
    // Ordinary text is left alone, and what isn't secret around a secret stays readable.
    expect(redactSecrets("All 12 tests pass; I changed src/pricing.js.")).toEqual({ text: "All 12 tests pass; I changed src/pricing.js.", redacted: false });
    expect(redactSecrets("postgres://admin:Pa55word99@db.example.com:5432/app").text).toBe("postgres://admin:[redacted]@db.example.com:5432/app");
    expect(redactSecrets("DB_PASSWORD=Sup3rS3cretValue").text).toBe("DB_PASSWORD=[redacted]");
    // Partial leaks the security reviewer found: an "@" inside a URL password, and a quoted value with spaces.
    expect(redactSecrets("postgres://admin:p@ss@word99@db.example.com/app").text).toBe("postgres://admin:[redacted]@db.example.com/app");
    expect(redactSecrets('"password": "correct horse battery staple"').text).toBe('"password": "[redacted]"');
    expect(redactSecrets("x-api-key: abcdef123456").text).toBe("x-api-key: [redacted]");
    expect(redactSecrets(`password: "it's a secret phrase"`).text).toBe('password: "[redacted]"');
  });

  it("removes secrets quickly even from a long, repetitive paste (the security reviewer R2: no catastrophic backtracking)", async () => {
    const { redactSecrets } = await import("@/lib/engineering/agents");
    for (const word of ["token", "pwd", "secret", "a"]) {
      const started = Date.now();
      redactSecrets(word.repeat(Math.floor(20_000 / word.length)));
      expect(Date.now() - started, word).toBeLessThan(2_000);
    }
  });

  it("refuses an empty, oversized or operator's response, and a draft's", async () => {
    const m = await approved();
    await expect(engMissionAction(db, founder, m.id, "add_response", { requestId: rid(), response: "   " }, { executor: executor() })).rejects.toThrow(/Paste the response/);
    await expect(engMissionAction(db, founder, m.id, "add_response", { requestId: rid(), response: "x".repeat(20_001) }, { executor: executor() })).rejects.toThrow(/at most 20,000/);
    await expect(engMissionAction(db, operator, m.id, "add_response", { requestId: rid(), response: "hi" }, { executor: executor() })).rejects.toMatchObject({ code: "forbidden" });
    const draft = await createEngMission(db, operator, input(), rid());
    expect((await getEngMission(db, founder, draft.id)).allowed.add_response).toBe(false);
  });
});

describe("rollback", () => {
  it("undoes migration 0006 alone, keeps M2B, and lets it apply again", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { MIGRATIONS_FOLDER } = await import("@/lib/db");
    const client = new PGlite();
    const d = drizzle(client);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const since = journal.entries.find((e) => e.tag.startsWith("0006_"))!.when;
    const sql = fs.readFileSync(path.join(process.cwd(), "docs", "m3", "rollback.sql"), "utf8").replaceAll(":m3_since", String(since));
    await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    const count = async (names: string) => (await client.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_name in (${names})`)).rows[0].n;
    expect(await count("'eng_missions','eng_events','eng_workspaces'")).toBe(0);
    expect(await count("'missions','ai_usage_ledger'")).toBe(2);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    expect(await count("'eng_missions','eng_events','eng_workspaces'")).toBe(3);
    await client.close();
  });
});
