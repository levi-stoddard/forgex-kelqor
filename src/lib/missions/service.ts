import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { anthropicKeyConfigured } from "../ai/claude";
import { activeApproval, approvalsFor, assertFounder, grantApproval, isFounder, ledgerEntries, missionSpend, scopeFingerprint, testMode, voidApprovals } from "../controls";
import type { DB } from "../db";
import { missions, missionSteps, opportunityProfiles, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { assert, DomainError } from "../domain/errors";
import { safeUrl } from "../format";
import { INDUSTRY_LABELS } from "../playbooks";
import { DOSSIER_SOURCE, getDossier } from "../research/dossiers";
import {
  FINAL_MISSION_STATUSES,
  MISSION_CAP_MICROS,
  MISSION_OUTPUT_LIMIT,
  PROTOCOLS,
  type ApprovalView,
  type LedgerEntryView,
  type MissionScope,
  type MissionSpend,
  type MissionStatus,
  type MissionSubject,
} from "./contract";
import { estimateMission, estimateReview, type MissionEstimate } from "./estimate";
import { MissionInput } from "./input";
import { geminiKeyConfigured, RESEARCH_MODELS, REVIEW_MODELS } from "./providers";
import { missionExecutor, scopeOf, type MissionExecutor, type MissionRow } from "./runner";
import { logStep } from "./steps";
import { saveResults } from "./results";
import { SIMULATED_MODEL } from "./simulated";

// The mission service: every owner action on a mission. Operators may draft and submit missions; only the
// designated owner may approve, reject, start, resume, cancel, add review, accept or close one (the controls'
// assertFounder, checked again by the controls on every paid request). Each action carries a request id and acts at
// most once, so double clicks, two windows and reconnections can't repeat it; a mission moves to Running only once.

export const missionLabel = (n: number) => `M-${String(n).padStart(4, "0")}`;

function blankToNull(s: string | null | undefined) {
  const t = s?.trim() ?? "";
  return t ? t : null;
}

/** The subject as stored: an existing company's details come from its saved research, never from the window. */
async function subjectOf(db: DB, input: MissionInput): Promise<MissionSubject> {
  const s = input.subject;
  if (input.type === "company_research") {
    assert(s.kind === "company", "A company research mission needs a company.");
    if (s.recordId && /^c\d{2}$/.test(s.recordId)) {
      const d = getDossier(s.recordId);
      if (!d) throw new DomainError("That company isn't in the Opportunity Center.", "not_found");
      const [profile] = await db
        .select({ industry: opportunityProfiles.industry })
        .from(opportunityProfiles)
        .where(and(eq(opportunityProfiles.source, DOSSIER_SOURCE.id), eq(opportunityProfiles.recordId, d.id)))
        .limit(1);
      return { kind: "company", recordId: d.id, name: d.name, website: d.website, town: d.town, state: d.state, industry: profile?.industry ?? blankToNull(s.industry) };
    }
    assert(s.name.length >= 2, "Enter the company's name.");
    const website = safeUrl(s.website.includes("://") ? s.website : `https://${s.website}`);
    assert(website, "Enter the company's official website, such as https://example.com.");
    const industry = blankToNull(s.industry);
    assert(!industry || INDUSTRY_LABELS.includes(industry), "Choose the industry from the list, or leave it unset.");
    return { kind: "company", recordId: s.recordId, name: s.name, website: website!, town: s.town, state: s.state, industry };
  }
  assert(s.kind === "industry", "An industry research mission needs an industry.");
  assert(INDUSTRY_LABELS.includes(s.industry), "Choose the industry from the list.");
  return { kind: "industry", industry: s.industry, category: blankToNull(s.category), region: blankToNull(s.region) };
}

function scopeFrom(input: MissionInput, subject: MissionSubject, syntheticAllowed: boolean): MissionScope {
  const simulated = input.simulated;
  const synthetic = Boolean(input.synthetic) && !simulated;
  if (synthetic) {
    assert(syntheticAllowed, "Synthetic test costs run only in test mode, against an isolated copy of the database.");
    assert(RESEARCH_MODELS.some((m) => m.model === input.model), "Choose one of the listed research models.");
  } else if (simulated) assert(!input.review || input.review.provider === "simulation", "A simulated mission can only have the simulated reviewer.");
  else {
    assert(RESEARCH_MODELS.some((m) => m.model === input.model), "Choose one of the listed research models.");
    assert(!input.review || REVIEW_MODELS.some((m) => m.model === input.review!.model), "Choose one of the listed Claude reviewers.");
    assert(!input.review || input.review.provider === "anthropic", "A real mission's review is by Claude.");
  }
  const reviewMax = input.review?.maxCostMicros ?? 0;
  assert(input.maxCostMicros + reviewMax <= MISSION_CAP_MICROS, "The research and review maximums together can't exceed the $2.00 mission limit.");
  const reviewProvider = simulated ? "simulation" : synthetic ? "synthetic" : "anthropic";
  return {
    type: input.type,
    subject,
    protocol: PROTOCOLS[input.type],
    provider: simulated ? "simulation" : synthetic ? "synthetic" : "google",
    model: simulated ? SIMULATED_MODEL : input.model,
    thinkingLevel: input.thinkingLevel,
    maxOutputTokens: MISSION_OUTPUT_LIMIT,
    maxCostMicros: input.maxCostMicros,
    review: input.review ? { provider: reviewProvider, model: simulated ? SIMULATED_MODEL : input.review.model, maxCostMicros: input.review.maxCostMicros } : null,
    simulated,
  };
}

const syntheticAllowed = (db: DB) => testMode(db).syntheticCosts;

function titleOf(subject: MissionSubject): string {
  if (subject.kind === "company") return subject.name;
  return [subject.industry, subject.category, subject.region].filter(Boolean).join(", ");
}

function requireOperator(actor: Actor) {
  assert(actor.role === "operator", "Only KELQOR operators can work with AI missions.", "forbidden");
}

async function load(db: DB, id: string): Promise<MissionRow> {
  const [row] = await db.select().from(missions).where(eq(missions.id, id)).limit(1);
  if (!row) throw new DomainError("That mission doesn't exist.", "not_found");
  return row;
}

/**
 * Runs an action once per request id: the action's step is written first, and a second request with the same id
 * finds it and changes nothing.
 */
async function once(db: DB, actor: Actor, missionId: string, requestId: string, summary: string, act: (stepId: string) => Promise<void>): Promise<boolean> {
  assert(/^[0-9a-f-]{36}$/.test(requestId), "The request is missing its id.");
  const [seen] = await db
    .select({ id: missionSteps.id })
    .from(missionSteps)
    .where(and(eq(missionSteps.missionId, missionId), eq(missionSteps.requestId, requestId)))
    .limit(1);
  if (seen) return false;
  let stepId: string;
  try {
    stepId = await logStep(db, missionId, "action", summary, {}, { requestId, actorId: actor.id });
  } catch {
    return false; // the same request id arrived at the same moment; the first one acts
  }
  try {
    await act(stepId);
  } catch (e) {
    await db
      .update(missionSteps)
      .set({ summary: `${summary} (refused: ${e instanceof Error ? e.message : String(e)})`.slice(0, 500) })
      .where(eq(missionSteps.id, stepId));
    throw e;
  }
  return true;
}

/** Moves a mission between states only if it is still in one of `from`; false when another request moved it first. */
async function transition(db: DB, id: string, from: MissionStatus[], patch: Partial<typeof missions.$inferInsert>): Promise<boolean> {
  const done = await db
    .update(missions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(missions.id, id), inArray(missions.status, from)))
    .returning({ id: missions.id });
  return done.length === 1;
}

export interface MissionStep {
  seq: number;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
  at: string;
  actor: string | null;
}

export interface MissionSummary {
  id: string;
  number: number;
  label: string;
  type: MissionRow["type"];
  status: MissionStatus;
  simulated: boolean;
  title: string;
  purpose: string;
  subject: MissionSubject;
  protocol: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  maxOutputTokens: number;
  maxCostMicros: number;
  review: MissionScope["review"];
  scopeFingerprint: string;
  stateReason: string | null;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  running: boolean;
  spend: MissionSpend | null;
  estimate: MissionEstimate;
  /** What the signed-in account may do now; the backend checks every action again. */
  allowed: Record<"edit" | "submit" | "approve" | "reject" | "start" | "resume" | "cancel" | "addReview" | "accept" | "close", boolean>;
}

export interface MissionDetail extends MissionSummary {
  approvals: ApprovalView[];
  steps: MissionStep[];
  ledger: LedgerEntryView[];
  result: Record<string, unknown> | null;
  /** True while page text is kept for a resume; it's removed when the mission ends. */
  holdsPageText: boolean;
}

async function summaryOf(db: DB, row: MissionRow, founder: boolean, executor: MissionExecutor, createdBy: string): Promise<MissionSummary> {
  let spend: MissionSpend | null = null;
  try {
    spend = await missionSpend(db, row.id);
  } catch {
    spend = null;
  }
  const s = row.status;
  const open = ["approved", "interrupted", "budget_blocked", "needs_review"].includes(s);
  const approval = open ? await activeApproval(db, row.id, "mission") : null;
  const review = open ? await activeApproval(db, row.id, "review") : null;
  const reviewResume = (row.workingState as { resumeReview?: boolean } | null)?.resumeReview === true;
  const final = FINAL_MISSION_STATUSES.includes(s);
  return {
    id: row.id,
    number: row.number,
    label: missionLabel(row.number),
    type: row.type,
    status: s,
    simulated: row.simulated,
    title: row.title,
    purpose: row.purpose,
    subject: row.subject,
    protocol: row.protocol,
    provider: row.provider,
    model: row.model,
    thinkingLevel: row.thinkingLevel,
    maxOutputTokens: row.maxOutputTokens,
    maxCostMicros: row.maxCostMicros,
    review: row.review ?? review?.review ?? null,
    scopeFingerprint: row.scopeFingerprint,
    stateReason: row.stateReason,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    running: executor.isRunning(row.id),
    spend,
    estimate: estimateMission(scopeOf(row)),
    allowed: {
      edit: s === "draft" || s === "awaiting_approval" || s === "approved",
      submit: s === "draft",
      approve: founder && (s === "awaiting_approval" || ((s === "approved" || s === "interrupted" || s === "budget_blocked") && !approval)),
      reject: founder && s === "awaiting_approval",
      start: founder && s === "approved" && Boolean(approval),
      resume:
        founder &&
        (((s === "interrupted" || s === "budget_blocked") && Boolean(reviewResume ? review : approval)) || (s === "needs_review" && Boolean(review) && !row.result?.["review"])),
      cancel: founder && !final && s !== "needs_review",
      addReview: founder && !row.review && !review && ["approved", "interrupted", "budget_blocked", "needs_review"].includes(s),
      accept: founder && s === "needs_review",
      close: founder && s === "needs_review",
    },
  };
}

export async function listMissions(db: DB, actor: Actor, executor: MissionExecutor = missionExecutor()): Promise<MissionSummary[]> {
  requireOperator(actor);
  const founder = await isFounder(db, actor.id);
  const rows = await db.select({ m: missions, by: users.name }).from(missions).innerJoin(users, eq(users.id, missions.createdById)).orderBy(desc(missions.number));
  return Promise.all(rows.map((r) => summaryOf(db, r.m, founder, executor, r.by)));
}

export async function getMission(db: DB, actor: Actor, id: string, executor: MissionExecutor = missionExecutor()): Promise<MissionDetail> {
  requireOperator(actor);
  const row = await load(db, id);
  const [by] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdById));
  const founder = await isFounder(db, actor.id);
  const steps = await db
    .select({ s: missionSteps, actor: users.name })
    .from(missionSteps)
    .leftJoin(users, eq(users.id, missionSteps.actorId))
    .where(eq(missionSteps.missionId, id))
    .orderBy(missionSteps.seq);
  let ledger: LedgerEntryView[] = [];
  try {
    ledger = await ledgerEntries(db, { missionId: id });
  } catch {
    ledger = [];
  }
  return {
    ...(await summaryOf(db, row, founder, executor, by?.name ?? "")),
    approvals: await approvalsFor(db, id),
    steps: steps.map(({ s, actor }) => ({ seq: s.seq, kind: s.kind, summary: s.summary, data: s.data, at: s.createdAt.toISOString(), actor })),
    ledger,
    result: row.result ?? null,
    holdsPageText: Boolean(row.workingState),
  };
}

export { MissionInput };

export async function createMission(db: DB, actor: Actor, raw: unknown, requestId: string): Promise<MissionDetail> {
  requireOperator(actor);
  const input = MissionInput.parse(raw);
  assert(/^[0-9a-f-]{36}$/.test(requestId), "The request is missing its id.");
  const [dup] = await db.select({ missionId: missionSteps.missionId }).from(missionSteps).where(eq(missionSteps.requestId, requestId)).limit(1);
  if (dup) return getMission(db, actor, dup.missionId);
  const subject = await subjectOf(db, input);
  const scope = scopeFrom(input, subject, syntheticAllowed(db));
  const id = randomUUID();
  await db.insert(missions).values({
    id,
    type: scope.type,
    simulated: scope.simulated,
    subject,
    title: titleOf(subject),
    purpose: input.purpose,
    protocol: scope.protocol,
    provider: scope.provider,
    model: scope.model,
    thinkingLevel: scope.thinkingLevel,
    maxOutputTokens: scope.maxOutputTokens,
    maxCostMicros: scope.maxCostMicros,
    review: scope.review,
    scopeFingerprint: scopeFingerprint(scope),
    createdById: actor.id!,
  });
  await logStep(db, id, "action", `Drafted by ${actor.name}`, {}, { requestId, actorId: actor.id });
  return getMission(db, actor, id);
}

export async function updateMission(db: DB, actor: Actor, id: string, raw: unknown, requestId: string): Promise<MissionDetail> {
  requireOperator(actor);
  const input = MissionInput.parse(raw);
  await once(db, actor, id, requestId, `Edited by ${actor.name}`, async () => {
    const row = await load(db, id);
    const editable: MissionStatus[] = ["draft", "awaiting_approval", "approved"];
    assert(editable.includes(row.status), "Only a draft, a mission awaiting approval or an approved mission that hasn't started can be edited.", "conflict");
    const subject = await subjectOf(db, input);
    const scope = scopeFrom(input, subject, syntheticAllowed(db));
    // Any change after approval voids the approval and returns the mission to Awaiting approval; an edit before
    // approval returns it to Draft, to be submitted again (docs/m2b/AUTHORIZATION.md).
    const approved = row.status === "approved";
    const patch: Partial<typeof missions.$inferInsert> = {
      status: approved ? "awaiting_approval" : "draft",
      simulated: scope.simulated,
      subject,
      title: titleOf(subject),
      purpose: input.purpose,
      provider: scope.provider,
      model: scope.model,
      thinkingLevel: scope.thinkingLevel,
      maxCostMicros: scope.maxCostMicros,
      review: scope.review,
      scopeFingerprint: scopeFingerprint(scope),
      submittedAt: approved ? new Date() : null,
    };
    await db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      assert(await transition(tx, id, editable, patch), "The mission changed state while you edited it.", "conflict");
      await voidApprovals(tx, id, "The mission's scope was edited.");
    });
  });
  return getMission(db, actor, id);
}

export async function submitMission(db: DB, actor: Actor, id: string, requestId: string): Promise<MissionDetail> {
  requireOperator(actor);
  await once(db, actor, id, requestId, `Submitted for approval by ${actor.name}`, async () => {
    assert(await transition(db, id, ["draft"], { status: "awaiting_approval", submittedAt: new Date() }), "Only a draft can be submitted.", "conflict");
  });
  return getMission(db, actor, id);
}

function keyProblem(scope: MissionScope): string | null {
  if (scope.simulated) return null;
  if (scope.provider === "google" && !geminiKeyConfigured()) return "A real Gemini mission needs GEMINI_API_KEY in .env.local, which you add yourself.";
  if (scope.review?.provider === "anthropic" && !anthropicKeyConfigured()) return "Claude review is unavailable: no Anthropic key is configured.";
  return null;
}

/**
 * The owner approves the mission's exact scope as it stands now (the fingerprint they were shown). The approval and
 * the move to Approved happen in one transaction; the controls read the scope and maximum from the mission itself.
 */
/**
 * Approve exactly what the owner was shown. The scope fingerprint binds what is sent and spent; the purpose isn't
 * part of it (it never reaches the model), so it is checked separately. An edit made while the window was open is
 * refused here rather than approved unseen. The window always sends the purpose; internal callers may omit it.
 */
export async function approveMission(db: DB, actor: Actor, id: string, input: { fingerprint: string; purpose?: string; requestId: string }): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, input.requestId, `Approved by ${actor.name}`, async () => {
    const row = await load(db, id);
    assert(["awaiting_approval", "approved", "interrupted", "budget_blocked"].includes(row.status), "This mission isn't waiting for an approval.", "conflict");
    assert(input.fingerprint === row.scopeFingerprint, "The mission changed since you opened it. Review it again before approving.", "conflict");
    assert(input.purpose === undefined || input.purpose === row.purpose, "The mission's purpose changed since you opened it. Review it again before approving.", "conflict");
    const problem = keyProblem(scopeOf(row));
    assert(!problem, problem ?? "");
    await db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      await grantApproval(tx, actor, { missionId: id, kind: "mission", seenFingerprint: input.fingerprint, requestId: input.requestId });
      if (row.status === "awaiting_approval") assert(await transition(tx, id, ["awaiting_approval"], { status: "approved" }), "The mission changed state.", "conflict");
    });
  });
  return getMission(db, actor, id);
}

export async function rejectMission(db: DB, actor: Actor, id: string, input: { reason: string; requestId: string }): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, input.requestId, `Rejected by ${actor.name}${input.reason.trim() ? `: ${input.reason.trim()}` : ""}`, async () => {
    assert(
      await transition(db, id, ["awaiting_approval"], { status: "rejected", stateReason: input.reason.trim().slice(0, 1000) || null, finishedAt: new Date() }),
      "Only a mission awaiting approval can be rejected.",
      "conflict",
    );
  });
  return getMission(db, actor, id);
}

/** Moves the mission to Running once, for the one request that wins, and hands it to the runner. */
export async function startMission(db: DB, actor: Actor, id: string, requestId: string, executor: MissionExecutor = missionExecutor()): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, requestId, `Started by ${actor.name}`, async () => {
    const row = await load(db, id);
    assert(row.status === "approved", "Only an approved mission can be started.", "conflict");
    assert(await activeApproval(db, id, "mission"), "The approval has expired or no longer matches. Approve the mission again.", "conflict");
    const problem = keyProblem(scopeOf(row));
    assert(!problem, problem ?? "");
    const runId = randomUUID();
    assert(await transition(db, id, ["approved"], { status: "running", runId, startedAt: new Date(), stateReason: null }), "The mission has already started.", "conflict");
    await logStep(db, id, "state", "running", { status: "running", runId });
    executor.start(id, runId);
  });
  return getMission(db, actor, id, executor);
}

/** Continues an interrupted or budget-blocked mission from its saved step, under a valid approval. */
export async function resumeMission(db: DB, actor: Actor, id: string, requestId: string, executor: MissionExecutor = missionExecutor()): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, requestId, `Resumed by ${actor.name}`, async () => {
    const row = await load(db, id);
    const reviewOnly = row.status === "needs_review" || (row.workingState as { resumeReview?: boolean } | null)?.resumeReview === true;
    assert(row.status === "interrupted" || row.status === "budget_blocked" || reviewOnly, "Only an interrupted or budget-blocked mission can be resumed.", "conflict");
    assert(!executor.isRunning(id), "The mission is still running.", "conflict");
    if (reviewOnly) assert(await activeApproval(db, id, "review"), "Add and approve Claude review first.", "conflict");
    else assert(await activeApproval(db, id, "mission"), "The approval has expired or no longer matches. Approve the mission again, then resume it.", "conflict");
    const runId = randomUUID();
    // Review alone needs no working state: it re-reads the cited pages.
    const patch: Partial<typeof missions.$inferInsert> = { status: reviewOnly ? "verification" : "running", runId, stateReason: null, finishedAt: null };
    if (reviewOnly) patch.workingState = { v: 1, phase: "verification", resumeReview: true } as Record<string, unknown>;
    assert(await transition(db, id, [row.status], patch), "The mission changed state.", "conflict");
    await logStep(db, id, "state", reviewOnly ? "verification (review)" : "running", { status: patch.status, runId });
    executor.start(id, runId);
  });
  return getMission(db, actor, id, executor);
}

/** Cancels the mission: nothing more is sent, and a request in flight is abandoned and recorded as unverified. */
export async function cancelMission(db: DB, actor: Actor, id: string, requestId: string, executor: MissionExecutor = missionExecutor()): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, requestId, `Cancelled by ${actor.name}`, async () => {
    const row = await load(db, id);
    const open: MissionStatus[] = ["draft", "awaiting_approval", "approved", "running", "verification", "interrupted", "budget_blocked"];
    assert(open.includes(row.status), "This mission has already ended.", "conflict");
    assert(
      await transition(db, id, open, { status: "cancelled", stateReason: `Cancelled by ${actor.name}.`, finishedAt: new Date(), workingState: null }),
      "The mission changed state.",
      "conflict",
    );
    executor.cancel(id);
    await voidApprovals(db, id, "The mission was cancelled.");
    await logStep(db, id, "state", "cancelled", { status: "cancelled" });
  });
  return getMission(db, actor, id, executor);
}

/** Adds Claude review to an approved or paused mission, under its own approval within the mission's $2. */
export async function addReview(db: DB, actor: Actor, id: string, input: { model: string; maxCostMicros: number; requestId: string }): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, input.requestId, `Claude review added by ${actor.name}`, async () => {
    const row = await load(db, id);
    assert(!row.review, "This mission already has a review.", "conflict");
    assert(["approved", "interrupted", "budget_blocked", "needs_review"].includes(row.status), "Review can be added to an approved, paused or Needs review mission.", "conflict");
    const review = row.simulated
      ? { provider: "simulation" as const, model: SIMULATED_MODEL, maxCostMicros: input.maxCostMicros }
      : { provider: "anthropic" as const, model: input.model, maxCostMicros: input.maxCostMicros };
    assert(row.simulated || REVIEW_MODELS.some((m) => m.model === input.model), "Choose one of the listed Claude reviewers.");
    assert(!(await activeApproval(db, id, "review")), "This mission already has an approved review.", "conflict");
    const problem = keyProblem({ ...scopeOf(row), review });
    assert(!problem, problem ?? "");
    // The mission's own scope and fingerprint don't change: the review lives on its own approval.
    await grantApproval(db, actor, { missionId: id, kind: "review", seenFingerprint: row.scopeFingerprint, review, requestId: input.requestId });
  });
  return getMission(db, actor, id);
}

/** What adding Claude review to this mission would reserve, from the report and the sizes of the pages it cites. */
export async function reviewEstimate(db: DB, actor: Actor, id: string, model: string) {
  requireOperator(actor);
  const row = await load(db, id);
  const result = (row.result ?? {}) as { report?: unknown; sources?: { outcome: string; bytes?: number }[] };
  const pages = (result.sources ?? []).filter((s) => s.outcome === "ok").map((s) => s.bytes ?? 12_000);
  const reportChars = result.report ? JSON.stringify(result.report).length : 20_000;
  return { pages: pages.length, ...estimateReview(row.simulated ? SIMULATED_MODEL : model, { reportChars, pageChars: pages }) };
}

export async function acceptWithIssues(db: DB, actor: Actor, id: string, input: { note: string; requestId: string }): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, input.requestId, `Accepted with its issues by ${actor.name}${input.note.trim() ? `: ${input.note.trim()}` : ""}`, async () => {
    assert(await transition(db, id, ["needs_review"], { status: "completed_with_issues", finishedAt: new Date() }), "Only a mission in Needs review can be accepted.", "conflict");
    await saveResults(db, id, { withIssues: true });
  });
  return getMission(db, actor, id);
}

export async function closeAsFailed(db: DB, actor: Actor, id: string, input: { note: string; requestId: string }): Promise<MissionDetail> {
  await assertFounder(db, actor);
  await once(db, actor, id, input.requestId, `Closed as not usable by ${actor.name}${input.note.trim() ? `: ${input.note.trim()}` : ""}`, async () => {
    assert(
      await transition(db, id, ["needs_review"], { status: "failed", stateReason: `Closed as not usable${input.note.trim() ? `: ${input.note.trim()}` : "."}`, finishedAt: new Date() }),
      "Only a mission in Needs review can be closed.",
      "conflict",
    );
  });
  return getMission(db, actor, id);
}
