// Milestone 3, engineering missions: the shared contract between the mission service, the executor, the agent
// adapters, the desktop routes and the tests. An engineering mission gives one AI agent one task in an isolated copy of
// an owner-registered git workspace. KELQOR never lets the agent touch the workspace itself: the agent works in a
// detached worktree, KELQOR runs the approved checks there, and a change reaches the workspace's repository only when
// the owner applies it, as a commit on a new local branch. Nothing is ever pushed.

export const ENG_STATUSES = ["draft", "awaiting_approval", "approved", "running", "review", "completed", "failed", "interrupted"] as const;
export type EngStatus = (typeof ENG_STATUSES)[number];

/** Where a mission's change stands. Each state is only ever reached in this order. */
export const CHANGE_STATES = ["none", "proposed", "tested", "founder_approved", "applied"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

// claude_code is the automated adapter (built, off until live execution is authorized); claude_code_manual is the same
// Claude Code run by the owner through a handoff. Values are only ever added, so existing mission records stay valid.
export const ENG_AGENTS = ["simulated", "claude_code", "antigravity", "claude_code_manual"] as const;
export type EngAgentId = (typeof ENG_AGENTS)[number];

/** How an agent is driven: automatically by KELQOR, or by the owner in the agent's own app (manual handoff). */
export type AgentMode = "simulated" | "automated" | "manual";

/**
 * Live, KELQOR-started agent execution (Claude Code) is off until the owner authorizes it. With it off, a mission for
 * an automated real agent can be drafted and approved but not started. The simulated agent and the manual handoff
 * aren't affected: neither starts an agent.
 */
export const LIVE_AGENT_EXECUTION_AUTHORIZED = false;

/**
 * The checks KELQOR may run in a mission's worktree, chosen per mission by the owner. Each is an exact program and
 * arguments, resolved on the backend's PATH and run without a shell, with secrets removed from the environment and a
 * time limit. A check runs the code it tests, which for a real agent is code the agent wrote, so a real agent's checks
 * run only when the owner starts them, after reading the change. The simulated agent's run automatically.
 */
export const CHECK_COMMANDS = {
  "node-test": { label: "node --test", program: "node", args: ["--test"] },
  "npm-test": { label: "npm test", program: "npm", args: ["test", "--silent"] },
  vitest: { label: "npx vitest run", program: "npx", args: ["--no-install", "vitest", "run"] },
  tsc: { label: "npx tsc --noEmit", program: "npx", args: ["--no-install", "tsc", "--noEmit"] },
} as const;
export type CheckCommandId = keyof typeof CHECK_COMMANDS;
export const CHECK_COMMAND_IDS = Object.keys(CHECK_COMMANDS) as CheckCommandId[];

/** What an agent may do inside its worktree. File access never reaches outside the worktree. */
export interface EngPermissions {
  /** May the agent change files (in its worktree)? Off = a read-only investigation that produces only a report. */
  editFiles: boolean;
  /** Checks KELQOR runs on the change. No agent may run commands itself. */
  checks: CheckCommandId[];
}

/** Commands and tools no engineering mission may ever use, whatever its permissions. */
export const PROTECTED_COMMANDS = [
  "git push",
  "git remote",
  "git config",
  "git credential",
  "gh ",
  "curl",
  "wget",
  "Invoke-WebRequest",
  "npm publish",
  "npm login",
  "ssh",
  "scp",
  "rm -rf /",
  "Remove-Item -Recurse",
  "setx",
  "reg ",
] as const;

/** Files an agent's change may never include, wherever they sit in the worktree. */
export const PROTECTED_PATHS = [/(^|\/)\.env(\..*)?$/i, /(^|\/)\.git(\/|$)/, /(^|\/)\.data(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.(pem|key|pfx|p12)$/i, /(^|\/)id_(rsa|ed25519)/i];

export interface EngWorkspaceView {
  id: string;
  name: string;
  path: string;
  /** The branch new missions start from; its commit is fixed when the mission is approved. */
  baseBranch: string;
  /** The demo workspace KELQOR creates for simulated missions; it holds no real project. */
  demo: boolean;
  createdAt: string;
}

export interface EngMissionInput {
  title: string;
  task: string;
  deliverables: string;
  workspaceId: string;
  agent: EngAgentId;
  permissions: EngPermissions;
}

/** What the approval binds: changing any of it voids an approval. */
export interface EngScope {
  title: string;
  task: string;
  deliverables: string;
  workspaceId: string;
  workspacePath: string;
  baseBranch: string;
  agent: EngAgentId;
  permissions: EngPermissions;
}

export interface EngCheckResult {
  check: CheckCommandId;
  label: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  /** The end of the output, with anything that looks like a secret removed. */
  output: string;
}

export interface EngChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface EngDeliverable {
  /** The full diff of the worktree against the approved base commit, capped for display. */
  diff: string;
  diffTruncated: boolean;
  files: EngChangedFile[];
  /** Files the change touched that no mission may change; any of them blocks applying it. */
  protectedFiles: string[];
  checks: EngCheckResult[];
  /** The agent's own account of what it did. */
  summary: string;
  collectedAt: string;
  /** The git tree of the change as collected. Review, checks, approval and applying all refer to exactly this tree. */
  tree: string;
  /** The tree the recorded checks ran on; a change is locally tested only when it equals `tree`. */
  checkedTree: string | null;
}

export interface EngEventView {
  id: string;
  at: string;
  kind: "action" | "state" | "activity" | "check" | "error" | "artifact" | "response";
  summary: string;
  actor: string | null;
  data: Record<string, unknown>;
}

export interface EngMissionSummary {
  id: string;
  number: number;
  label: string;
  title: string;
  status: EngStatus;
  changeState: ChangeState;
  agent: EngAgentId;
  agentLabel: string;
  agentMode: AgentMode;
  simulated: boolean;
  workspaceName: string;
  activity: string | null;
  stateReason: string | null;
  updatedAt: string;
  /** Unknown (null) unless the agent reported a cost KELQOR can rely on. */
  costMicros: number | null;
  costSource: "none" | "simulated" | "agent_reported" | "unknown";
}

export interface EngMissionDetail extends EngMissionSummary {
  task: string;
  deliverables: string;
  permissions: EngPermissions;
  workspace: EngWorkspaceView | null;
  baseCommit: string | null;
  worktreePath: string | null;
  appliedBranch: string | null;
  appliedCommit: string | null;
  scopeFingerprint: string;
  approval: { approvedBy: string; approvedAt: string; fingerprint: string } | null;
  deliverable: EngDeliverable | null;
  events: EngEventView[];
  /** What the owner may do now; the backend checks every action again. */
  allowed: Record<EngAction, boolean>;
  /** Shown for a manual-handoff agent while the mission waits for the owner's work. */
  handoff: { file: string; instructions: string } | null;
  /** The complete assignment, to copy into a Claude conversation: the task brief plus the workspace. Never starts anything. */
  assignment: string;
  /** Responses the owner pasted back. Unverified evidence: never a code change, a test result or an approval. */
  responses: EngResponseView[];
}

export const ENG_ACTIONS = ["submit", "approve", "reject", "start", "cancel", "resume", "import", "run_checks", "approve_change", "apply", "complete", "fail", "open_agent", "add_response"] as const;

/** The longest response that can be saved; anything longer is refused, never cut silently. */
export const RESPONSE_MAX_CHARS = 20_000;

export interface EngResponseView {
  id: string;
  at: string;
  actor: string | null;
  text: string;
  chars: number;
  /** True when something that looked like a secret was replaced before it was saved. */
  redacted: boolean;
}
export type EngAction = (typeof ENG_ACTIONS)[number];

export interface AgentStatus {
  id: EngAgentId;
  label: string;
  mode: AgentMode;
  /** Connected = found and usable; disconnected = not found; blocked = found, but KELQOR may not start it yet. */
  state: "connected" | "disconnected" | "blocked";
  version: string | null;
  detail: string;
  /** What the owner can do about it, when something is missing. */
  remedy: string | null;
  costReporting: string;
}

export const MISSION_LABEL = (n: number) => `E-${String(n).padStart(4, "0")}`;
