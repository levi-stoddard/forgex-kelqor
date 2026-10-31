import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { engMissions } from "../db/schema";
import { agentAdapters, AgentFailure, type AgentAdapter } from "./agents";
import { runChecks } from "./checks";
import { MISSION_LABEL, type ChangeState, type EngAgentId, type EngDeliverable } from "./contract";
import { addWorktree, collectChange } from "./git";
import { logEvent, transition, WAITING_FOR_FOUNDER } from "./service";
import { engineeringDir, workspaceById } from "./workspaces";

// Runs engineering missions inside the backend, one task per mission. Each run is owned by its run id: a write from a
// run that no longer owns the mission (cancelled, or superseded after a restart) changes nothing. Progress, the
// worktree, the change and every check survive a restart; a mission left running when KELQOR closed becomes Interrupted
// and resumes only when the owner says so. Nothing ever starts by itself.

declare global {
  var __kelqorEngExecutor: EngineeringExecutor | undefined;
}

export class EngineeringExecutor {
  private readonly running = new Map<string, { runId: string; abort: AbortController; done: Promise<void> }>();

  constructor(private readonly adapters: () => Record<EngAgentId, AgentAdapter> = agentAdapters) {}

  isRunning(missionId: string): boolean {
    return this.running.has(missionId);
  }

  /** Resolves when the mission's current task (if any) has finished. For tests and shutdown. */
  async idle(missionId: string): Promise<void> {
    await this.running.get(missionId)?.done;
  }

  cancel(missionId: string): void {
    this.running.get(missionId)?.abort.abort();
  }

  launch(db: DB, missionId: string, runId: string): void {
    this.task(missionId, runId, (signal) => this.execute(db, missionId, runId, signal));
  }

  /** After a manual handoff: collect what the owner's agent produced, then run the checks. */
  collect(db: DB, missionId: string, runId: string): void {
    this.task(missionId, runId, (signal) => this.review(db, missionId, runId, signal, null));
  }

  private task(missionId: string, runId: string, work: (signal: AbortSignal) => Promise<void>) {
    if (this.running.has(missionId)) return; // one task per mission, whatever else asks
    const abort = new AbortController();
    const done = work(abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(missionId)?.runId === runId) this.running.delete(missionId);
      });
    this.running.set(missionId, { runId, abort, done });
  }

  private async owned(db: DB, missionId: string, runId: string) {
    const [m] = await db.select().from(engMissions).where(and(eq(engMissions.id, missionId), eq(engMissions.runId, runId))).limit(1);
    return m && m.status === "running" ? m : null;
  }

  private async setActivity(db: DB, missionId: string, runId: string, activity: string | null) {
    await db.update(engMissions).set({ activity, updatedAt: new Date() }).where(and(eq(engMissions.id, missionId), eq(engMissions.runId, runId), eq(engMissions.status, "running")));
  }

  private async execute(db: DB, missionId: string, runId: string, signal: AbortSignal) {
    try {
      const m = await this.owned(db, missionId, runId);
      if (!m) return;
      const ws = await workspaceById(db, m.workspaceId);
      if (!ws || !m.baseCommit || !m.worktreePath) throw new AgentFailure("The mission's workspace or base commit is missing.");
      await this.setActivity(db, missionId, runId, "Preparing an isolated worktree");
      await addWorktree(ws.path, m.baseCommit, m.worktreePath);
      await logEvent(db, missionId, "activity", `Worktree ready at ${m.worktreePath} (base ${m.baseCommit.slice(0, 10)}). The workspace itself isn't touched.`, { worktree: m.worktreePath, baseCommit: m.baseCommit });
      const adapter = this.adapters()[m.agent];
      const label = MISSION_LABEL(m.number);
      const scope = { title: m.title, task: m.task, deliverables: m.deliverables, workspaceId: ws.id, workspacePath: ws.path, baseBranch: ws.baseBranch, agent: m.agent, permissions: m.permissions };
      const activity = async (summary: string, data: Record<string, unknown> = {}) => {
        if (!(await this.owned(db, missionId, runId))) return;
        await this.setActivity(db, missionId, runId, summary);
        await logEvent(db, missionId, "activity", summary, data);
      };
      if (adapter.mode === "manual") {
        const handoff = await adapter.handoff!({ worktree: m.worktreePath, scope, missionLabel: label, activity }, path.join(engineeringDir(db), "handoffs"));
        if (!(await this.owned(db, missionId, runId))) return;
        await logEvent(db, missionId, "artifact", `Task handed over to ${adapter.label}: ${handoff.file}`, { file: handoff.file, instructions: handoff.instructions });
        await this.setActivity(db, missionId, runId, WAITING_FOR_FOUNDER);
        return;
      }
      await this.setActivity(db, missionId, runId, `${adapter.label} is working`);
      const outcome = await adapter.run!({ worktree: m.worktreePath, scope, missionLabel: label, signal, activity });
      if (!(await this.owned(db, missionId, runId))) return;
      await db.update(engMissions).set({ costMicros: outcome.costMicros, costSource: outcome.costSource }).where(and(eq(engMissions.id, missionId), eq(engMissions.runId, runId)));
      await this.review(db, missionId, runId, signal, outcome.summary);
    } catch (e) {
      await this.fail(db, missionId, runId, signal, e);
    }
  }

  private async review(db: DB, missionId: string, runId: string, signal: AbortSignal, summary: string | null) {
    try {
      const m = await this.owned(db, missionId, runId);
      if (!m || !m.worktreePath || !m.baseCommit) return;
      const ws = await workspaceById(db, m.workspaceId);
      if (!ws) throw new AgentFailure("The mission's workspace isn't registered any more.");
      await this.setActivity(db, missionId, runId, "Collecting the change");
      const change = await collectChange(ws.path, m.worktreePath, m.baseCommit);
      // A real agent's checks would run code it wrote, so they wait for the owner to read the change and start them.
      const automatic = m.agent === "simulated";
      const checks = automatic
        ? await runChecks(m.worktreePath, m.permissions.checks, signal, async (label) => {
            await this.setActivity(db, missionId, runId, `Running ${label}`);
            await logEvent(db, missionId, "check", `Running ${label} in the worktree`);
          })
        : [];
      if (signal.aborted || !(await this.owned(db, missionId, runId))) return;
      // A check that changed the change's files tested something else.
      const checkedTree = checks.length ? (await collectChange(ws.path, m.worktreePath, m.baseCommit)).tree : null;
      for (const c of checks) await logEvent(db, missionId, "check", `${c.label}: ${c.passed ? "passed" : c.timedOut ? "timed out" : `failed (exit ${c.exitCode})`}`, { check: c.check, passed: c.passed, durationMs: c.durationMs });
      const deliverable: EngDeliverable = { ...change, checks, checkedTree, summary: summary ?? "Imported from the agent's app. KELQOR has no account of the agent's own steps.", collectedAt: new Date().toISOString() };
      const tested = change.files.length > 0 && checks.length > 0 && checks.every((c) => c.passed) && checkedTree === change.tree;
      const changeState: ChangeState = change.files.length === 0 ? "none" : tested ? "tested" : "proposed";
      const reasons = [
        change.protectedFiles.length ? `The change touches files no mission may change (${change.protectedFiles.join(", ")}); it can't be approved or applied.` : null,
        checks.some((c) => !c.passed) ? "At least one check failed." : null,
        checkedTree && checkedTree !== change.tree ? "The checks changed the change's files, so it isn't counted as tested." : null,
        !automatic && m.permissions.checks.length && change.files.length ? "Read the change, then run the approved checks yourself: they run the agent's code." : null,
        change.files.length === 0 ? "The agent made no change." : null,
      ].filter(Boolean);
      await logEvent(db, missionId, "artifact", `${change.files.length} file${change.files.length === 1 ? "" : "s"} changed (+${change.files.reduce((n, f) => n + f.additions, 0)} −${change.files.reduce((n, f) => n + f.deletions, 0)})`, { files: change.files.map((f) => f.path) });
      await transition(db, missionId, ["running"], { status: "review", changeState, deliverable, activity: null, stateReason: reasons.join(" ") || null }, runId);
    } catch (e) {
      await this.fail(db, missionId, runId, signal, e);
    }
  }

  /**
   * The owner's Run checks, for a mission in review: runs the approved checks on the change as it stands and records
   * them. Passing every check makes a proposed change tested; a failed check leaves it proposed.
   */
  runFounderChecks(db: DB, missionId: string): void {
    const runId = `checks-${Date.now()}`;
    this.task(missionId, runId, async (signal) => {
      const claimed = await db
        .update(engMissions)
        .set({ activity: "Running the approved checks", updatedAt: new Date() })
        .where(and(eq(engMissions.id, missionId), eq(engMissions.status, "review"), isNull(engMissions.activity)))
        .returning();
      const m = claimed[0];
      if (!m?.worktreePath || !m.deliverable || !m.baseCommit) return;
      try {
        const ws = await workspaceById(db, m.workspaceId);
        if (!ws) throw new AgentFailure("The mission's workspace isn't registered any more.");
        // The checks run on the change the owner reviewed, or not at all.
        const before = await collectChange(ws.path, m.worktreePath, m.baseCommit);
        if (before.tree !== m.deliverable.tree) throw new AgentFailure("The worktree changed after the change was collected, so the checks weren't run. Close this mission and start a new one.");
        const checks = await runChecks(m.worktreePath, m.permissions.checks, signal, async (label) => {
          await logEvent(db, missionId, "check", `Running ${label} in the worktree, started by the owner`);
        });
        for (const c of checks) await logEvent(db, missionId, "check", `${c.label}: ${c.passed ? "passed" : c.timedOut ? "timed out" : `failed (exit ${c.exitCode})`}`, { check: c.check, passed: c.passed, durationMs: c.durationMs });
        const checkedTree = (await collectChange(ws.path, m.worktreePath, m.baseCommit)).tree;
        const unchanged = checkedTree === m.deliverable.tree;
        const passed = checks.length > 0 && checks.every((c) => c.passed) && unchanged;
        await db
          .update(engMissions)
          .set({
            deliverable: { ...m.deliverable, checks, checkedTree },
            changeState: m.changeState === "proposed" || m.changeState === "tested" ? (passed ? "tested" : "proposed") : m.changeState,
            stateReason: passed ? null : unchanged ? "At least one check failed." : "The checks changed the change's files, so it isn't counted as tested. Close this mission and start a new one.",
            activity: null,
            updatedAt: new Date(),
          })
          .where(and(eq(engMissions.id, missionId), eq(engMissions.status, "review")));
      } catch (e) {
        await logEvent(db, missionId, "error", `The checks couldn't run: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
        await db.update(engMissions).set({ activity: null }).where(eq(engMissions.id, missionId));
      }
    });
  }

  private async fail(db: DB, missionId: string, runId: string, signal: AbortSignal, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (!(await this.owned(db, missionId, runId))) return;
    await logEvent(db, missionId, "error", message.slice(0, 500));
    if (signal.aborted) {
      await transition(db, missionId, ["running"], { status: "interrupted", stateReason: "Stopped before it finished. Its worktree and log are kept.", activity: null, runId: null }, runId);
      return;
    }
    await transition(db, missionId, ["running"], { status: "failed", stateReason: message.slice(0, 500), activity: null, finishedAt: new Date(), runId: null }, runId);
  }
}

export function engineeringExecutor(): EngineeringExecutor {
  return (globalThis.__kelqorEngExecutor ??= new EngineeringExecutor());
}

/**
 * At backend start: a mission left running had its agent stopped with the backend, so it becomes Interrupted, with its
 * worktree kept. A manual handoff waiting for the owner is left waiting: nothing of KELQOR's was running.
 */
export async function recoverEngineeringAtStartup(db: DB): Promise<number> {
  const rows = await db.select().from(engMissions).where(eq(engMissions.status, "running"));
  let n = 0;
  for (const r of rows) {
    if (r.activity === WAITING_FOR_FOUNDER) continue;
    if (await transition(db, r.id, ["running"], { status: "interrupted", stateReason: "KELQOR closed while this mission ran. Its worktree and log are kept; resume it when you're ready.", activity: null, runId: null }, r.runId ?? undefined)) n++;
  }
  return n;
}
