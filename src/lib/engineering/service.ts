import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { assertFounder } from "../controls";
import type { DB } from "../db";
import { engEvents, engMissions, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import { agentAdapters, assignmentText, redactSecrets, type AgentAdapter } from "./agents";
import {
  CHECK_COMMAND_IDS,
  ENG_ACTIONS,
  ENG_AGENTS,
  LIVE_AGENT_EXECUTION_AUTHORIZED,
  MISSION_LABEL,
  RESPONSE_MAX_CHARS,
  type EngAction,
  type EngAgentId,
  type EngMissionDetail,
  type EngMissionSummary,
  type EngScope,
  type EngStatus,
} from "./contract";
import { boiseDay } from "../controls";
import { collectChange, commitOf, commitTreeToNewBranch } from "./git";
import { engineeringDir, workspaceById } from "./workspaces";
import type { EngineeringExecutor } from "./executor";

// The engineering mission service: drafting, approval, the lifecycle and the owner's review. Every owner action
// carries a request id and acts once; every state change is a check-and-set, so two windows or a double click change
// a mission once. Starting, stopping and reviewing are the owner's alone, as for AI missions.

export const EngMissionInput = z.strictObject({
  title: z.string().trim().min(3).max(120),
  task: z.string().trim().min(10).max(8000),
  deliverables: z.string().trim().max(4000),
  workspaceId: z.string().uuid(),
  agent: z.enum(ENG_AGENTS),
  permissions: z.strictObject({ editFiles: z.boolean(), checks: z.array(z.enum(CHECK_COMMAND_IDS as [string, ...string[]])).max(4) }),
});

const AGENT_LABEL: Record<EngAgentId, string> = { simulated: "Simulated agent", claude_code: "Claude Code", antigravity: "Gemini Antigravity", claude_code_manual: "Claude Code (manual handoff)" };
const AGENT_MODE = { simulated: "simulated", claude_code: "automated", antigravity: "manual", claude_code_manual: "manual" } as const;
/** The activity a manual-handoff mission shows while it waits for the owner's work. */
export const WAITING_FOR_FOUNDER = "Waiting for you to finish the task in the agent's app, then import the result";

function assert(ok: unknown, message: string, code: "conflict" | "forbidden" | "invalid" = "invalid"): asserts ok {
  if (!ok) throw new DomainError(message, code);
}

function requireOperator(actor: Actor) {
  assert(actor?.role === "operator", "Only KELQOR operators can work with engineering missions.", "forbidden");
}

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));

/** Binds what the owner approves: the task, the deliverables, the workspace and branch, the agent and its permissions. */
export function engFingerprint(scope: EngScope): string {
  return createHash("sha256").update(`kelqor-eng-scope-v1\n${canonical(scope)}`).digest("hex");
}

type Row = typeof engMissions.$inferSelect;

async function scopeOfRow(db: DB, row: Pick<Row, "title" | "task" | "deliverables" | "workspaceId" | "agent" | "permissions">): Promise<EngScope> {
  const ws = await workspaceById(db, row.workspaceId);
  assert(ws, "The mission's workspace isn't registered any more.", "conflict");
  return { title: row.title, task: row.task, deliverables: row.deliverables, workspaceId: ws.id, workspacePath: ws.path, baseBranch: ws.baseBranch, agent: row.agent, permissions: { editFiles: row.permissions.editFiles, checks: [...row.permissions.checks] } };
}

export async function logEvent(db: DB, missionId: string, kind: EngMissionDetail["events"][number]["kind"], summary: string, data: Record<string, unknown> = {}, extra: { requestId?: string; actorId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(engEvents).values({ id, missionId, kind, summary: summary.slice(0, 500), data, requestId: extra.requestId ?? null, actorId: extra.actorId ?? null });
  return id;
}

/** Acts once per request id; a repeated or simultaneous request with the same id does nothing. */
async function once(db: DB, actor: Actor, missionId: string, requestId: string, summary: string, act: () => Promise<void>): Promise<boolean> {
  assert(/^[0-9a-f-]{36}$/.test(requestId), "The request is missing its id.");
  const [seen] = await db.select({ id: engEvents.id }).from(engEvents).where(and(eq(engEvents.missionId, missionId), eq(engEvents.requestId, requestId))).limit(1);
  if (seen) return false;
  let eventId: string;
  try {
    eventId = await logEvent(db, missionId, "action", summary, {}, { requestId, actorId: actor.id ?? undefined });
  } catch {
    return false;
  }
  try {
    await act();
  } catch (e) {
    await db.update(engEvents).set({ summary: `${summary} (refused: ${e instanceof Error ? e.message : String(e)})`.slice(0, 500) }).where(eq(engEvents.id, eventId));
    throw e;
  }
  return true;
}

/** Moves a mission only if it is still in one of `from` (and, when given, still owned by `runId`). */
export async function transition(db: DB, id: string, from: EngStatus[], patch: Partial<typeof engMissions.$inferInsert>, runId?: string): Promise<boolean> {
  const where = [eq(engMissions.id, id), inArray(engMissions.status, from)];
  if (runId !== undefined) where.push(eq(engMissions.runId, runId));
  const done = await db.update(engMissions).set({ ...patch, updatedAt: new Date() }).where(and(...where)).returning({ id: engMissions.id });
  if (done.length && patch.status) await logEvent(db, id, "state", `${patch.status}${patch.stateReason ? `: ${patch.stateReason}` : ""}`, { status: patch.status });
  return done.length === 1;
}

async function load(db: DB, id: string): Promise<Row> {
  const [row] = await db.select().from(engMissions).where(eq(engMissions.id, id)).limit(1);
  assert(row, "That engineering mission doesn't exist.", "conflict");
  return row;
}

async function checkInput(db: DB, raw: unknown) {
  const input = EngMissionInput.parse(raw);
  const ws = await workspaceById(db, input.workspaceId);
  assert(ws, "Choose a registered workspace.");
  assert(!(ws.demo && input.agent !== "simulated"), "The demo workspace is for the simulated agent only.");
  assert(!(input.agent === "simulated" && !ws.demo && input.permissions.editFiles), "The simulated agent only changes files in KELQOR's demo workspace.");
  return { ...input, permissions: { editFiles: input.permissions.editFiles, checks: [...new Set(input.permissions.checks)] as EngScope["permissions"]["checks"] } };
}

export async function createEngMission(db: DB, actor: Actor, raw: unknown, requestId: string): Promise<EngMissionDetail> {
  requireOperator(actor);
  assert(/^[0-9a-f-]{36}$/.test(requestId), "The request is missing its id.");
  const input = await checkInput(db, raw);
  const scope = await scopeOfRow(db, input);
  const id = randomUUID();
  // The request id makes a repeated create return the same draft.
  const [prior] = await db.select({ missionId: engEvents.missionId }).from(engEvents).where(eq(engEvents.requestId, requestId)).limit(1);
  if (prior) return getEngMission(db, actor, prior.missionId);
  await db.insert(engMissions).values({ id, ...input, status: "draft", scopeFingerprint: engFingerprint(scope), createdById: actor.id! });
  await logEvent(db, id, "action", `Drafted by ${actor.name}`, {}, { requestId, actorId: actor.id ?? undefined });
  return getEngMission(db, actor, id);
}

export async function updateEngMission(db: DB, actor: Actor, id: string, raw: unknown, requestId: string): Promise<EngMissionDetail> {
  requireOperator(actor);
  await once(db, actor, id, requestId, `Edited by ${actor.name}`, async () => {
    const row = await load(db, id);
    const editable: EngStatus[] = ["draft", "awaiting_approval", "approved"];
    assert(editable.includes(row.status), "Only a draft, a mission awaiting approval or an approved mission that hasn't started can be edited.", "conflict");
    const input = await checkInput(db, raw);
    const scope = await scopeOfRow(db, input);
    // Any edit voids an approval: an approved mission goes back to Awaiting approval, others back to Draft.
    const patch = { ...input, status: (row.status === "approved" ? "awaiting_approval" : "draft") as EngStatus, scopeFingerprint: engFingerprint(scope), approvedById: null, approvedAt: null, approvedFingerprint: null, baseCommit: null };
    assert(await transition(db, id, editable, patch), "The mission changed state while you edited it.", "conflict");
  });
  return getEngMission(db, actor, id);
}

/** The mission's scope as it is now, checked against what was approved. */
async function boundScope(db: DB, row: Row): Promise<EngScope> {
  const scope = await scopeOfRow(db, row);
  assert(engFingerprint(scope) === row.scopeFingerprint, "The mission's saved scope no longer matches its fingerprint.", "conflict");
  assert(row.approvedFingerprint && row.approvedFingerprint === row.scopeFingerprint, "The mission isn't approved as it stands.", "conflict");
  return scope;
}

async function ensureStartable(adapter: AgentAdapter) {
  if (adapter.mode === "automated") assert(LIVE_AGENT_EXECUTION_AUTHORIZED, `Live agent execution isn't authorized, so ${adapter.label} can't be started yet. The mission stays approved.`, "conflict");
  const status = await adapter.status();
  assert(status.state === "connected", `${adapter.label} isn't available: ${status.detail}${status.remedy ? ` ${status.remedy}` : ""}`, "conflict");
}

export interface EngDeps {
  executor: EngineeringExecutor;
  adapters?: Record<EngAgentId, AgentAdapter>;
}

export async function engMissionAction(db: DB, actor: Actor, id: string, action: EngAction, input: { requestId: string; fingerprint?: string; reason?: string; tree?: string; response?: string }, deps: EngDeps): Promise<EngMissionDetail> {
  requireOperator(actor);
  assert((ENG_ACTIONS as readonly string[]).includes(action), "That isn't an engineering mission action.");
  const adapters = deps.adapters ?? agentAdapters();
  if (action !== "submit") await assertFounder(db, actor);
  const label = { submit: "Submitted", approve: "Approved", reject: "Rejected", start: "Started", cancel: "Cancelled", resume: "Resumed", import: "Results imported", run_checks: "Checks started", add_response: "Response saved (unverified)", approve_change: "Change approved", apply: "Change applied", complete: "Completed", fail: "Closed as failed", open_agent: "Opened in the agent's app" }[action];
  await once(db, actor, id, input.requestId, `${label} by ${actor.name}`, async () => {
    const row = await load(db, id);
    const adapter = adapters[row.agent];
    switch (action) {
      case "submit":
        assert(await transition(db, id, ["draft"], { status: "awaiting_approval" }), "Only a draft can be submitted.", "conflict");
        return;
      case "approve": {
        // An interrupted mission's approval may have lapsed; approving it again renews it for today.
        const renewable = (row.status === "approved" || row.status === "interrupted") && !(row.approvedAt && boiseDay(row.approvedAt) === boiseDay(new Date()) && row.approvedFingerprint === row.scopeFingerprint);
        assert(row.status === "awaiting_approval" || renewable, "This mission isn't waiting for approval.", "conflict");
        assert(input.fingerprint === row.scopeFingerprint, "The mission changed since you opened it. Review it again before approving.", "conflict");
        const scope = await scopeOfRow(db, row);
        assert(engFingerprint(scope) === row.scopeFingerprint, "The mission's workspace changed since it was drafted. Edit and resubmit it.", "conflict");
        // The approval is for the branch as it is now: its commit is fixed here; a mission already under way keeps its own.
        const base =
          row.baseCommit ??
          (await commitOf(scope.workspacePath, scope.baseBranch).catch(() => {
            throw new DomainError(`The workspace has no branch "${scope.baseBranch}" any more.`, "conflict");
          }));
        const patch = { approvedById: actor.id!, approvedAt: new Date(), approvedFingerprint: row.scopeFingerprint, baseCommit: base };
        assert(await transition(db, id, [row.status], row.status === "awaiting_approval" ? { ...patch, status: "approved" as EngStatus } : patch), "The mission changed state.", "conflict");
        return;
      }
      case "reject":
        assert(await transition(db, id, ["awaiting_approval", "approved"], { status: "failed", stateReason: `Rejected: ${(input.reason ?? "").trim() || "no reason given"}`, finishedAt: new Date(), approvedFingerprint: null }), "Only a mission awaiting approval or approved can be rejected.", "conflict");
        return;
      case "start":
      case "resume": {
        const from: EngStatus[] = action === "start" ? ["approved"] : ["interrupted"];
        assert(from.includes(row.status), action === "start" ? "Only an approved mission can be started." : "Only an interrupted mission can be resumed.", "conflict");
        const scope = await boundScope(db, row);
        assert(row.approvedAt && boiseDay(row.approvedAt) === boiseDay(new Date()), "The approval lapsed at Boise midnight. Approve the mission again to start it today.", "conflict");
        await ensureStartable(adapter);
        const baseCommit = row.baseCommit ?? (await commitOf(scope.workspacePath, scope.baseBranch));
        const runId = randomUUID();
        assert(
          await transition(db, id, from, { status: "running", runId, baseCommit, worktreePath: row.worktreePath ?? path.join(engineeringDir(db), "worktrees", id), stateReason: null, activity: "Starting", startedAt: row.startedAt ?? new Date() }),
          "The mission changed state; it was started once.",
          "conflict",
        );
        deps.executor.launch(db, id, runId);
        return;
      }
      case "cancel":
        assert(row.status === "running", "Only a running mission can be cancelled.", "conflict");
        deps.executor.cancel(id);
        assert(await transition(db, id, ["running"], { status: "interrupted", stateReason: "You cancelled the mission. Its worktree and log are kept; resume it or close it.", activity: null, runId: null }), "The mission changed state.", "conflict");
        return;
      case "import": {
        assert(row.status === "running" && row.activity === WAITING_FOR_FOUNDER && row.runId, "Results can be imported only while a handoff mission waits for you.", "conflict");
        await boundScope(db, row);
        deps.executor.collect(db, id, row.runId);
        return;
      }
      case "open_agent": {
        assert(row.status === "running" && row.activity === WAITING_FOR_FOUNDER && adapter.open && row.worktreePath, "This mission isn't waiting for you in an agent's app.", "conflict");
        const handoff = path.join(engineeringDir(db), "handoffs", `${MISSION_LABEL(row.number)}.md`);
        await adapter.open(row.worktreePath, handoff);
        return;
      }
      case "run_checks": {
        assert(row.status === "review" && row.deliverable && row.worktreePath, "Checks run on a change in review.", "conflict");
        assert(row.permissions.checks.length > 0, "This mission has no approved checks.", "conflict");
        assert(row.changeState === "proposed" || row.changeState === "tested", "Checks run before you approve the change.", "conflict");
        assert(!row.activity && !deps.executor.isRunning(id), "Something is already running for this mission.", "conflict");
        deps.executor.runFounderChecks(db, id);
        return;
      }
      case "approve_change": {
        assert(row.status === "review", "Only a mission in review has a change to approve.", "conflict");
        assert(row.changeState === "proposed" || row.changeState === "tested", "There's no change waiting for your approval.", "conflict");
        assert(!(row.deliverable?.protectedFiles.length ?? 0), `The change touches files no mission may change (${row.deliverable?.protectedFiles.join(", ")}), so it can't be approved.`, "conflict");
        assert(input.tree && input.tree === row.deliverable?.tree, "The change differs from the one you reviewed. Open it again before approving.", "conflict");
        const now = await collectChange((await boundScope(db, row)).workspacePath, row.worktreePath!, row.baseCommit!);
        assert(now.tree === row.deliverable!.tree && now.protectedFiles.length === 0, "The worktree changed after the change was collected, so it can't be approved. Close this mission and start a new one.", "conflict");
        const updated = await db
          .update(engMissions)
          .set({ changeState: "founder_approved", updatedAt: new Date() })
          .where(and(eq(engMissions.id, id), eq(engMissions.status, "review"), inArray(engMissions.changeState, ["proposed", "tested"])))
          .returning({ id: engMissions.id });
        assert(updated.length === 1, "The mission changed state.", "conflict");
        return;
      }
      case "apply": {
        assert(row.status === "review" && row.changeState === "founder_approved" && row.worktreePath && row.deliverable, "Only a change you approved can be applied.", "conflict");
        const branch = `kelqor/eng/${MISSION_LABEL(row.number).toLowerCase()}`;
        // Claim the mission first, so two applies can't both commit.
        const claimed = await db
          .update(engMissions)
          .set({ activity: "Applying", updatedAt: new Date() })
          .where(and(eq(engMissions.id, id), eq(engMissions.status, "review"), eq(engMissions.changeState, "founder_approved"), or(isNull(engMissions.activity), ne(engMissions.activity, "Applying"))))
          .returning({ id: engMissions.id });
        assert(claimed.length === 1, "The change is already being applied.", "conflict");
        try {
          const scope = await boundScope(db, row);
          // Exactly the approved tree is committed; the worktree is checked to still hold it, and nothing is re-read from it.
          const now = await collectChange(scope.workspacePath, row.worktreePath, row.baseCommit!);
          assert(now.tree === row.deliverable.tree, "The worktree changed after you approved the change, so nothing was applied. Close this mission and start a new one.", "conflict");
          const commit = await commitTreeToNewBranch(scope.workspacePath, row.worktreePath, row.baseCommit!, row.deliverable.tree, branch, `${MISSION_LABEL(row.number)}: ${row.title}\n\nApplied by ${actor.name} through KELQOR. Agent: ${AGENT_LABEL[row.agent]}${row.agent === "simulated" ? " (simulated)" : ""}.`);
          assert(await transition(db, id, ["review"], { status: "completed", changeState: "applied", appliedBranch: branch, appliedCommit: commit, activity: null, finishedAt: new Date() }), "The mission changed state.", "conflict");
          await logEvent(db, id, "artifact", `Committed ${commit.slice(0, 10)} to the new local branch ${branch}. Nothing was pushed.`, { branch, commit });
        } catch (e) {
          await db.update(engMissions).set({ activity: null }).where(eq(engMissions.id, id));
          throw e;
        }
        return;
      }
      case "complete":
        assert(await transition(db, id, ["review"], { status: "completed", finishedAt: new Date(), activity: null }), "Only a mission in review can be completed.", "conflict");
        return;
      case "add_response": {
        // Evidence only: written to the log, never to the mission itself, so it can't change its state, its change,
        // its checks or what may be applied.
        const raw = (input.response ?? "").replace(/\r\n/g, "\n");
        assert(raw.trim().length > 0, "Paste the response first.");
        assert(raw.length <= RESPONSE_MAX_CHARS, `A response can be at most ${RESPONSE_MAX_CHARS.toLocaleString("en-US")} characters; this one is ${raw.length.toLocaleString("en-US")}. Save it in parts.`);
        const { text, redacted } = redactSecrets(raw);
        await logEvent(db, id, "response", `Response pasted by ${actor.name} (unverified${redacted ? "; something that looked like a secret was removed" : ""})`, { text, chars: text.length, redacted }, { actorId: actor.id ?? undefined });
        return;
      }
      case "fail":
        assert(await transition(db, id, ["review", "interrupted"], { status: "failed", stateReason: (input.reason ?? "").trim() || "Closed as failed by the owner.", finishedAt: new Date(), activity: null, runId: null }), "Only a mission in review or interrupted can be closed as failed.", "conflict");
        return;
    }
  });
  return getEngMission(db, actor, id);
}

function allowedFor(row: Row, founder: boolean, adapter: AgentAdapter | undefined): Record<EngAction, boolean> {
  const s = row.status;
  const waiting = s === "running" && row.activity === WAITING_FOR_FOUNDER;
  const automatedBlocked = adapter?.mode === "automated" && !LIVE_AGENT_EXECUTION_AUTHORIZED;
  const approvedToday = Boolean(row.approvedAt && row.approvedFingerprint === row.scopeFingerprint && boiseDay(row.approvedAt) === boiseDay(new Date()));
  return {
    submit: s === "draft",
    approve: founder && (s === "awaiting_approval" || ((s === "interrupted" || s === "approved") && !approvedToday)),
    reject: founder && (s === "awaiting_approval" || s === "approved"),
    start: founder && s === "approved" && !automatedBlocked && approvedToday,
    cancel: founder && s === "running",
    resume: founder && s === "interrupted" && !automatedBlocked && approvedToday,
    import: founder && waiting,
    open_agent: founder && waiting && Boolean(adapter?.open),
    run_checks: founder && s === "review" && row.permissions.checks.length > 0 && (row.changeState === "proposed" || row.changeState === "tested") && !row.activity,
    approve_change: founder && s === "review" && (row.changeState === "proposed" || row.changeState === "tested") && !(row.deliverable?.protectedFiles.length ?? 0) && !row.activity,
    apply: founder && s === "review" && row.changeState === "founder_approved",
    complete: founder && s === "review",
    add_response: founder && s !== "draft",
    fail: founder && (s === "review" || s === "interrupted"),
  };
}

function summaryOf(row: Row, workspaceName: string): EngMissionSummary {
  return {
    id: row.id,
    number: row.number,
    label: MISSION_LABEL(row.number),
    title: row.title,
    status: row.status,
    changeState: row.changeState,
    agent: row.agent,
    agentLabel: AGENT_LABEL[row.agent],
    agentMode: AGENT_MODE[row.agent],
    simulated: row.agent === "simulated",
    workspaceName,
    activity: row.activity,
    stateReason: row.stateReason,
    updatedAt: row.updatedAt.toISOString(),
    costMicros: row.costMicros,
    costSource: row.costSource,
  };
}

export async function listEngMissions(db: DB, actor: Actor): Promise<EngMissionSummary[]> {
  requireOperator(actor);
  const rows = await db.select().from(engMissions).orderBy(desc(engMissions.number));
  const names = new Map<string, string>();
  for (const r of rows) if (!names.has(r.workspaceId)) names.set(r.workspaceId, (await workspaceById(db, r.workspaceId))?.name ?? "(removed)");
  return rows.map((r) => summaryOf(r, names.get(r.workspaceId) ?? ""));
}

export async function getEngMission(db: DB, actor: Actor, id: string, adapters: Record<EngAgentId, AgentAdapter> = agentAdapters()): Promise<EngMissionDetail> {
  requireOperator(actor);
  const row = await load(db, id);
  const ws = await workspaceById(db, row.workspaceId);
  const events = await db
    .select({ e: engEvents, name: users.name })
    .from(engEvents)
    .leftJoin(users, eq(users.id, engEvents.actorId))
    .where(eq(engEvents.missionId, id))
    .orderBy(asc(engEvents.createdAt));
  const approver = row.approvedById ? (await db.select({ name: users.name }).from(users).where(eq(users.id, row.approvedById)).limit(1))[0]?.name ?? "" : "";
  const founder = await assertFounder(db, actor).then(() => true, () => false);
  const handoffFile = path.join(engineeringDir(db), "handoffs", `${MISSION_LABEL(row.number)}.md`);
  const handoffEvent = [...events].reverse().find((e) => e.e.kind === "artifact" && typeof e.e.data.instructions === "string");
  return {
    ...summaryOf(row, ws?.name ?? "(removed)"),
    task: row.task,
    deliverables: row.deliverables,
    permissions: row.permissions,
    workspace: ws,
    baseCommit: row.baseCommit,
    worktreePath: row.worktreePath,
    appliedBranch: row.appliedBranch,
    appliedCommit: row.appliedCommit,
    scopeFingerprint: row.scopeFingerprint,
    approval: row.approvedAt && row.approvedFingerprint ? { approvedBy: approver, approvedAt: row.approvedAt.toISOString(), fingerprint: row.approvedFingerprint } : null,
    deliverable: row.deliverable,
    events: events.map(({ e, name }) => ({ id: e.id, at: e.createdAt.toISOString(), kind: e.kind, summary: e.summary, actor: name ?? null, data: e.kind === "response" ? { chars: e.data.chars, redacted: e.data.redacted } : e.data })),
    allowed: allowedFor(row, founder, adapters[row.agent]),
    handoff: row.status === "running" && row.activity === WAITING_FOR_FOUNDER && handoffEvent ? { file: handoffFile, instructions: String(handoffEvent.e.data.instructions) } : null,
    assignment: assignmentText(
      { title: row.title, task: row.task, deliverables: row.deliverables, workspaceId: row.workspaceId, workspacePath: ws?.path ?? "", baseBranch: ws?.baseBranch ?? "", agent: row.agent, permissions: row.permissions },
      MISSION_LABEL(row.number),
      ws,
      row.baseCommit,
    ),
    responses: events
      .filter(({ e }) => e.kind === "response")
      .map(({ e, name }) => ({ id: e.id, at: e.createdAt.toISOString(), actor: name ?? null, text: String(e.data.text ?? ""), chars: Number(e.data.chars ?? 0), redacted: e.data.redacted === true })),
  };
}

export async function agentStatuses(adapters: Record<EngAgentId, AgentAdapter> = agentAdapters()) {
  return Promise.all(ENG_AGENTS.map((a) => adapters[a].status()));
}
