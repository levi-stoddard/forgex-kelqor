import { and, asc, eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DB } from "../db";
import { discoveryCalls, discoveryFigures, opportunityChecks, opportunityProblems, opportunityProfiles, users, workOrders } from "../db/schema";
import { safeUrl } from "../format";
import { isIndustry } from "../playbooks";
import type { Actor } from "./actor";
import { assert, DomainError } from "./errors";
import { newId, orderRef, recordEvent } from "./records";
import {
  DECISION_MAKER_ANSWERS,
  PROBLEM_STATUSES,
  SOLUTION_RUNGS,
  SOLUTION_RUNG_LABELS,
  type DecisionMakerAnswer,
  type OpportunityDecision,
  type ProblemStatus,
  type SolutionRung,
  type WorkOrderStatus,
} from "./types";

// Discovery-first work on a researched company (Milestone 2A): the owner's own checks, discovery conversations in
// the customer's words, problems the customer confirmed or dismissed, the simplest solution for each, and the Work
// Order drafted from one. Research files stay read-only; everything here is the owner's record, audited in events.
// Nothing here contacts anyone, and a drafted Work Order commits no one: it starts as "submitted", unquoted.

export interface OpportunityRef {
  source: string;
  recordId: string;
  companyName: string;
}

/** The operator's user id; anyone else (including the system actor, which has none) is refused. */
function requireOperator(actor: Actor): string {
  if (actor.role !== "operator" || !actor.id) throw new DomainError("Only KELQOR operators can work on researched companies.", "forbidden");
  return actor.id;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUESTION_ID = /^[a-z0-9-]{2,40}$/;
const FINDING_KEY = /^[a-zA-Z]+\.\d{1,3}$/;
// A day of slack: in time zones ahead of UTC, the owner's local date is already tomorrow's UTC date.
const latestDate = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function text(value: string | undefined, max: number, what: string): string {
  const v = (value ?? "").trim();
  assert(v.length <= max, `Keep ${what} under ${max.toLocaleString("en-US")} characters.`);
  return v;
}

function pastDate(value: string, what: string): string {
  assert(DATE.test(value) && !Number.isNaN(Date.parse(value)), `Give ${what} as a date.`);
  assert(value <= latestDate(), `${what[0].toUpperCase()}${what.slice(1)} can't be in the future.`);
  return value;
}

async function touchProfile(db: DB, by: string, ref: OpportunityRef, patch: { industry?: string | null; workOrderId?: string | null }) {
  const now = new Date();
  await db
    .insert(opportunityProfiles)
    .values({ id: newId(), source: ref.source, recordId: ref.recordId, companyName: ref.companyName, industry: patch.industry ?? null, workOrderId: patch.workOrderId ?? null, updatedById: by, updatedAt: now })
    .onConflictDoUpdate({
      target: [opportunityProfiles.source, opportunityProfiles.recordId],
      set: { ...(patch.industry !== undefined ? { industry: patch.industry } : {}), ...(patch.workOrderId !== undefined ? { workOrderId: patch.workOrderId } : {}), updatedById: by, updatedAt: now },
    });
}

/** The industry the owner confirms for a researched company; null goes back to research's suggestion. */
export async function setOpportunityIndustry(db: DB, actor: Actor, input: OpportunityRef & { industry: string | null }) {
  const by = requireOperator(actor);
  assert(input.industry === null || isIndustry(input.industry), "Choose one of the industries in the list.");
  await touchProfile(db, by, input, { industry: input.industry });
  await recordEvent(db, { actorId: actor.id, type: "opportunity_industry_set", data: { source: input.source, recordId: input.recordId, companyName: input.companyName, industry: input.industry } });
}

/** A fact the owner checked outside the saved research. It needs a source address or a note saying where it came from. */
export async function addOpportunityCheck(db: DB, actor: Actor, input: OpportunityRef & { statement: string; sourceUrl: string; checkedOn: string; note: string }) {
  const by = requireOperator(actor);
  const statement = text(input.statement, 1000, "the finding");
  assert(statement.length >= 3, "Say what you found.");
  const raw = input.sourceUrl.trim();
  const sourceUrl = raw ? safeUrl(raw) : null;
  assert(!raw || sourceUrl, "The source must be a web address (http or https).");
  const note = text(input.note, 2000, "the note");
  assert(sourceUrl || note, "Add where you found it: a link, or a note such as \"phone call with the owner\".");
  const checkedOn = pastDate(input.checkedOn, "the date you checked");
  const id = newId();
  await db.insert(opportunityChecks).values({ id, source: input.source, recordId: input.recordId, statement, sourceUrl, checkedOn, note, createdById: by });
  await recordEvent(db, { actorId: actor.id, type: "opportunity_checked", data: { source: input.source, recordId: input.recordId, companyName: input.companyName, checkId: id } });
  return id;
}

export interface CallInput {
  heldOn: string;
  contactName: string;
  contactRole: string;
  decisionMaker: DecisionMakerAnswer;
  software: string;
  priorities: string;
  desiredOutcome: string;
  valueToThem: string;
  tried: string;
  pain: number | null;
  nextStep: string;
  notes: string;
  answers: Record<string, string>;
  /** Problems the customer raised, in their words. */
  problems: string[];
  /** Research findings the customer confirmed or dismissed; the statement comes from the saved research, not the form. */
  findings: { key: string; statement: string; status: ProblemStatus }[];
}

/**
 * Records one discovery conversation, with everything it confirmed, in one transaction. This is the only way a problem
 * becomes customer-confirmed: each one is tied to this call.
 */
export async function recordDiscoveryCall(db: DB, actor: Actor, input: OpportunityRef & CallInput) {
  const by = requireOperator(actor);
  const heldOn = pastDate(input.heldOn, "the date of the conversation");
  assert((DECISION_MAKER_ANSWERS as readonly string[]).includes(input.decisionMaker), "Say whether they can decide on a purchase.");
  assert(input.pain === null || (Number.isInteger(input.pain) && input.pain >= 0 && input.pain <= 3), "Pain is 0 to 3.");
  const entries = Object.entries(input.answers ?? {})
    .map(([k, v]) => [k, text(v, 2000, "each answer")] as const)
    .filter(([, v]) => v);
  assert(entries.length <= 40 && entries.every(([k]) => QUESTION_ID.test(k)), "Those answers don't match the discovery questions.");
  const problems = (input.problems ?? []).map((p) => text(p, 1000, "each problem")).filter(Boolean);
  assert(problems.length <= 10, "Record at most 10 problems per conversation.");
  assert(problems.every((p) => p.length >= 3), "Describe each problem in a few words.");
  const findings = input.findings ?? [];
  assert(findings.length <= 40, "Too many findings.");
  assert(findings.every((f) => FINDING_KEY.test(f.key) && (PROBLEM_STATUSES as readonly string[]).includes(f.status) && f.statement.trim()), "Those findings don't match the research.");
  assert(new Set(findings.map((f) => f.key)).size === findings.length, "Each finding can be marked once per conversation.");
  const call = {
    contactName: text(input.contactName, 200, "the name"),
    contactRole: text(input.contactRole, 200, "the role"),
    software: text(input.software, 2000, "the software"),
    priorities: text(input.priorities, 2000, "their priorities"),
    desiredOutcome: text(input.desiredOutcome, 2000, "the outcome they want"),
    valueToThem: text(input.valueToThem, 2000, "what it's worth to them"),
    tried: text(input.tried, 2000, "what they've tried"),
    nextStep: text(input.nextStep, 1000, "the next step"),
    notes: text(input.notes, 4000, "the notes"),
  };
  assert(
    entries.length || problems.length || findings.length || call.priorities || call.desiredOutcome || call.software || call.tried || call.notes,
    "Record at least something they said: an answer, a problem, their priorities or the outcome they want.",
  );
  const callId = newId();
  await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.insert(discoveryCalls).values({
      id: callId,
      source: input.source,
      recordId: input.recordId,
      heldOn,
      ...call,
      decisionMaker: input.decisionMaker,
      pain: input.pain,
      answers: Object.fromEntries(entries),
      recordedById: by,
    });
    const rows = [
      ...problems.map((statement) => ({ findingKey: null, statement, status: "confirmed" as const })),
      ...findings.map((f) => ({ findingKey: f.key, statement: f.statement.trim().slice(0, 1000), status: f.status })),
    ];
    if (rows.length) {
      await tx.insert(opportunityProblems).values(rows.map((r) => ({ id: newId(), source: input.source, recordId: input.recordId, callId, ...r, createdById: by })));
    }
    await recordEvent(tx, {
      actorId: actor.id,
      type: "discovery_recorded",
      data: {
        source: input.source,
        recordId: input.recordId,
        companyName: input.companyName,
        callId,
        reported: problems.length,
        confirmed: findings.filter((f) => f.status === "confirmed").length,
        dismissed: findings.filter((f) => f.status === "not_a_problem").length,
      },
    });
  });
  return callId;
}

/** The simplest kind of solution for a problem the customer confirmed, with what it would be. */
export async function setProblemSolution(db: DB, actor: Actor, input: { source: string; recordId: string; problemId: string; rung: SolutionRung; solution: string }) {
  requireOperator(actor);
  assert((SOLUTION_RUNGS as readonly string[]).includes(input.rung), "Choose the kind of solution.");
  const solution = text(input.solution, 2000, "the solution");
  assert(solution.length >= 3, "Say what the solution would be.");
  const [p] = await db
    .select({ id: opportunityProblems.id, status: opportunityProblems.status })
    .from(opportunityProblems)
    .where(and(eq(opportunityProblems.id, input.problemId), eq(opportunityProblems.source, input.source), eq(opportunityProblems.recordId, input.recordId)))
    .limit(1);
  assert(p, "That problem isn't recorded for this company.", "not_found");
  assert(p.status === "confirmed", "Only a problem the customer confirmed gets a solution.");
  await db.update(opportunityProblems).set({ solutionRung: input.rung, solution, updatedAt: new Date() }).where(eq(opportunityProblems.id, p.id));
  await recordEvent(db, { actorId: actor.id, type: "problem_solution_set", data: { source: input.source, recordId: input.recordId, problemId: p.id, rung: input.rung } });
}

/** Ties a Work Order drafted from a confirmed problem back to the researched company it came from. */
export async function linkOpportunityWorkOrder(db: DB, actor: Actor, input: OpportunityRef & { workOrderId: string; problemId: string | null }) {
  const by = requireOperator(actor);
  await touchProfile(db, by, input, { workOrderId: input.workOrderId });
  await recordEvent(db, { workOrderId: input.workOrderId, actorId: actor.id, type: "drafted_from_discovery", data: { source: input.source, recordId: input.recordId, companyName: input.companyName, problemId: input.problemId } });
}

/** Everything the owner has recorded about one researched company, oldest first. */
export async function loadDiscovery(db: DB, actor: Actor, source: string, recordId: string) {
  requireOperator(actor);
  const where = (t: { source: AnyPgColumn; recordId: AnyPgColumn }) => and(eq(t.source, source), eq(t.recordId, recordId));
  const [profile] = await db.select().from(opportunityProfiles).where(where(opportunityProfiles)).limit(1);
  const checks = await db
    .select({ row: opportunityChecks, by: users.name })
    .from(opportunityChecks)
    .innerJoin(users, eq(users.id, opportunityChecks.createdById))
    .where(where(opportunityChecks))
    .orderBy(asc(opportunityChecks.createdAt));
  const calls = await db
    .select({ row: discoveryCalls, by: users.name })
    .from(discoveryCalls)
    .innerJoin(users, eq(users.id, discoveryCalls.recordedById))
    .where(where(discoveryCalls))
    .orderBy(asc(discoveryCalls.heldOn), asc(discoveryCalls.createdAt));
  const problems = await db.select().from(opportunityProblems).where(where(opportunityProblems)).orderBy(asc(opportunityProblems.createdAt));
  const figures = await db.select().from(discoveryFigures).where(where(discoveryFigures)).orderBy(asc(discoveryFigures.createdAt));
  const [order] = profile?.workOrderId
    ? await db.select({ id: workOrders.id, number: workOrders.number, status: workOrders.status }).from(workOrders).where(eq(workOrders.id, profile.workOrderId)).limit(1)
    : [];
  return {
    industry: profile?.industry ?? null,
    workOrder: order ? { id: order.id, ref: orderRef(order.number), status: order.status as WorkOrderStatus } : null,
    checks: checks.map((c) => ({ ...c.row, createdBy: c.by })),
    calls: calls.map((c) => ({ ...c.row, recordedBy: c.by })),
    problems,
    figures,
  };
}

// Customer-reported financial figures (Milestone 2B). A figure the customer gave in a recorded discovery call stays
// an estimate until the owner records the calculation and the evidence that validate it. Nothing an AI produces can
// create or validate one: only these two operator actions write the table.

export async function recordCustomerFigure(
  db: DB,
  actor: Actor,
  input: OpportunityRef & { callId: string; statement: string; amountCents: number; period: string; basis: string },
) {
  const by = requireOperator(actor);
  const [call] = await db
    .select({ id: discoveryCalls.id })
    .from(discoveryCalls)
    .where(and(eq(discoveryCalls.id, input.callId), eq(discoveryCalls.source, input.source), eq(discoveryCalls.recordId, input.recordId)))
    .limit(1);
  assert(call, "A customer's figure comes from a recorded discovery conversation with this company.", "not_found");
  const statement = text(input.statement, 500, "what the figure is");
  assert(statement.length >= 3, "Say what the figure is, in the customer's words.");
  assert(Number.isInteger(input.amountCents) && input.amountCents >= 0 && input.amountCents <= 100_000_000_00, "Give the amount in dollars.");
  const period = text(input.period, 60, "the period");
  assert(period.length >= 2, "Give the figure's period, such as per month or per year.");
  const id = newId();
  await db.insert(discoveryFigures).values({
    id,
    source: input.source,
    recordId: input.recordId,
    callId: input.callId,
    statement,
    amountCents: input.amountCents,
    period,
    basis: text(input.basis, 1000, "the customer's basis"),
    createdById: by,
  });
  await recordEvent(db, { actorId: by, type: "customer_figure_recorded", data: { source: input.source, recordId: input.recordId, figureId: id } });
  return id;
}

export async function validateCustomerFigure(
  db: DB,
  actor: Actor,
  input: { source: string; recordId: string; figureId: string; validatedCents: number; calculation: string; evidence: string },
) {
  const by = requireOperator(actor);
  const [figure] = await db
    .select()
    .from(discoveryFigures)
    .where(and(eq(discoveryFigures.id, input.figureId), eq(discoveryFigures.source, input.source), eq(discoveryFigures.recordId, input.recordId)))
    .limit(1);
  assert(figure, "That figure doesn't exist.", "not_found");
  assert(!figure.validatedAt, "That figure is already validated.", "conflict");
  const calculation = text(input.calculation, 2000, "the calculation");
  const evidence = text(input.evidence, 2000, "the evidence");
  assert(calculation.length >= 10, "Write out the calculation that validates it.");
  assert(evidence.length >= 10, "Name the evidence, such as the customer's own exported data.");
  assert(Number.isInteger(input.validatedCents) && input.validatedCents >= 0 && input.validatedCents <= 100_000_000_00, "Give the validated amount in dollars.");
  await db
    .update(discoveryFigures)
    .set({ validatedCents: input.validatedCents, calculation, evidence, validatedById: by, validatedAt: new Date() })
    .where(eq(discoveryFigures.id, input.figureId));
  await recordEvent(db, { actorId: by, type: "customer_figure_validated", data: { source: input.source, recordId: input.recordId, figureId: input.figureId } });
}
export type DiscoveryRecords = Awaited<ReturnType<typeof loadDiscovery>>;

export const READINESS_STAGES = [
  "not_pursuing",
  "on_hold",
  "not_qualified",
  "ready_for_discovery",
  "no_confirmed_problem",
  "choose_solution",
  "confirm_decision_maker",
  "ready_to_propose",
  "work_order_drafted",
] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];

const READINESS: Record<ReadinessStage, { label: string; next: string }> = {
  not_pursuing: { label: "Not pursuing", next: "You rejected this company. Nothing more to do unless you change the decision." },
  on_hold: { label: "On hold", next: "Revisit when it suits you. Nothing happens meanwhile." },
  not_qualified: { label: "Not qualified yet", next: "Review the research and decide whether it's worth a discovery conversation." },
  ready_for_discovery: {
    label: "Ready for discovery",
    next: "Arrange a conversation to learn what their real problems are. You make the contact; nothing is sent from KELQOR. Record it here afterwards.",
  },
  no_confirmed_problem: { label: "Discovery held, no confirmed problem", next: "Follow up, or close it. Don't propose anything until they confirm a problem." },
  choose_solution: { label: "Problem confirmed", next: `Choose the simplest solution for it: ${Object.values(SOLUTION_RUNG_LABELS).map((l) => l.toLowerCase()).join(", then ")}.` },
  confirm_decision_maker: { label: "Solution identified", next: "Confirm who decides on the purchase. Record a conversation with a decision-maker before proposing." },
  ready_to_propose: { label: "Ready to propose", next: "Draft a Work Order from the confirmed problem and review it. Drafting sends nothing, quotes nothing and charges nothing." },
  work_order_drafted: { label: "Work Order drafted", next: "Review its scope and price in the web app, then send the quote yourself when you're ready." },
};

/** The next commercial action, from the owner's decision and the discovery records. Research alone never gets past "ready for discovery". */
export function readinessOf(input: {
  decision: OpportunityDecision | null;
  calls: { decisionMaker: DecisionMakerAnswer }[];
  problems: { status: ProblemStatus; solutionRung: SolutionRung | null }[];
  workOrderId: string | null;
}): { stage: ReadinessStage; label: string; next: string } {
  const stage = ((): ReadinessStage => {
    if (input.workOrderId) return "work_order_drafted";
    if (input.decision === "rejected") return "not_pursuing";
    if (!input.calls.length) return input.decision === "qualified" ? "ready_for_discovery" : input.decision === "hold" ? "on_hold" : "not_qualified";
    const confirmed = input.problems.filter((p) => p.status === "confirmed");
    if (!confirmed.length) return "no_confirmed_problem";
    if (!confirmed.some((p) => p.solutionRung)) return "choose_solution";
    if (!input.calls.some((c) => c.decisionMaker === "yes")) return "confirm_decision_maker";
    return "ready_to_propose";
  })();
  return { stage, ...READINESS[stage] };
}

/**
 * What the New Work Order page starts from for a confirmed problem: the problem in the customer's words, the
 * simplest solution chosen, and their desired outcome and tools from the latest conversation that recorded them.
 */
export async function workOrderPrefill(db: DB, actor: Actor, input: { source: string; recordId: string; problemId: string }) {
  requireOperator(actor);
  const records = await loadDiscovery(db, actor, input.source, input.recordId);
  const problem = records.problems.find((p) => p.id === input.problemId);
  if (!problem || problem.status !== "confirmed" || !problem.solutionRung) return null;
  const latest = <K extends "desiredOutcome" | "software">(k: K) => [...records.calls].reverse().find((c) => c[k])?.[k] ?? "";
  return {
    industry: records.industry,
    problem: `${problem.statement}\n\nSimplest solution identified: ${SOLUTION_RUNG_LABELS[problem.solutionRung]}: ${problem.solution}`.slice(0, 5000),
    desiredOutcome: latest("desiredOutcome").slice(0, 2000),
    currentTools: latest("software").slice(0, 500),
  };
}

/** For the company list: each record's confirmed industry, Work Order link, calls and problems, in four queries. */
export async function discoveryIndex(db: DB, actor: Actor, source: string) {
  requireOperator(actor);
  const index = new Map<string, { industry: string | null; workOrderId: string | null; calls: { decisionMaker: DecisionMakerAnswer }[]; problems: { status: ProblemStatus; solutionRung: SolutionRung | null }[] }>();
  const entry = (id: string) => {
    let e = index.get(id);
    if (!e) index.set(id, (e = { industry: null, workOrderId: null, calls: [], problems: [] }));
    return e;
  };
  for (const p of await db.select().from(opportunityProfiles).where(eq(opportunityProfiles.source, source))) Object.assign(entry(p.recordId), { industry: p.industry, workOrderId: p.workOrderId });
  for (const c of await db.select({ recordId: discoveryCalls.recordId, decisionMaker: discoveryCalls.decisionMaker }).from(discoveryCalls).where(eq(discoveryCalls.source, source))) entry(c.recordId).calls.push(c);
  for (const p of await db
    .select({ recordId: opportunityProblems.recordId, status: opportunityProblems.status, solutionRung: opportunityProblems.solutionRung })
    .from(opportunityProblems)
    .where(eq(opportunityProblems.source, source)))
    entry(p.recordId).problems.push(p);
  return index;
}
