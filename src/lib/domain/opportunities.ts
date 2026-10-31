import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import { opportunityDecisions, users } from "../db/schema";
import type { Actor } from "./actor";
import { assert, DomainError } from "./errors";
import { newId, recordEvent } from "./records";
import { OPPORTUNITY_DECISIONS, type OpportunityDecision } from "./types";

export interface OpportunityDecisionRecord {
  source: string;
  recordId: string;
  companyName: string;
  decision: OpportunityDecision;
  note: string;
  decidedAt: Date;
  decidedBy: string;
}

const MAX_NOTE = 2000;

function requireOperator(actor: Actor) {
  if (actor.role !== "operator") throw new DomainError("Only KELQOR operators can qualify researched companies.", "forbidden");
}

/** Every saved decision for one research source, keyed by record id. Operators only: this is internal sales research. */
export async function listOpportunityDecisions(db: DB, actor: Actor, source: string): Promise<Map<string, OpportunityDecisionRecord>> {
  requireOperator(actor);
  const rows = await db
    .select({
      source: opportunityDecisions.source,
      recordId: opportunityDecisions.recordId,
      companyName: opportunityDecisions.companyName,
      decision: opportunityDecisions.decision,
      note: opportunityDecisions.note,
      decidedAt: opportunityDecisions.decidedAt,
      decidedBy: users.name,
    })
    .from(opportunityDecisions)
    .innerJoin(users, eq(users.id, opportunityDecisions.decidedById))
    .where(eq(opportunityDecisions.source, source));
  return new Map(rows.map((r) => [r.recordId, r]));
}

/**
 * Saves the owner's qualification of a researched company, replacing any earlier call on the same record, and
 * logs it to the audit trail. A decision is never permission to contact the company.
 */
export async function setOpportunityDecision(
  db: DB,
  actor: Actor,
  input: { source: string; recordId: string; companyName: string; decision: string; note?: string },
): Promise<OpportunityDecisionRecord> {
  requireOperator(actor);
  assert((OPPORTUNITY_DECISIONS as readonly string[]).includes(input.decision), "Choose Qualified, Hold or Rejected.");
  const decision = input.decision as OpportunityDecision;
  const note = (input.note ?? "").trim();
  assert(note.length <= MAX_NOTE, `Keep the note under ${MAX_NOTE} characters.`);
  assert(input.source && input.recordId && input.companyName.trim(), "The research record is incomplete.");

  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ decision: opportunityDecisions.decision })
      .from(opportunityDecisions)
      .where(and(eq(opportunityDecisions.source, input.source), eq(opportunityDecisions.recordId, input.recordId)))
      .limit(1);
    const decidedAt = new Date();
    await tx
      .insert(opportunityDecisions)
      .values({
        id: newId(),
        source: input.source,
        recordId: input.recordId,
        companyName: input.companyName.trim(),
        decision,
        note,
        decidedById: actor.id!,
        decidedAt,
      })
      .onConflictDoUpdate({
        target: [opportunityDecisions.source, opportunityDecisions.recordId],
        set: { decision, note, decidedById: actor.id!, decidedAt, companyName: input.companyName.trim() },
      });
    await recordEvent(tx, {
      actorId: actor.id,
      type: "opportunity_decided",
      data: { source: input.source, recordId: input.recordId, companyName: input.companyName.trim(), decision, previous: previous?.decision ?? null },
    });
    return { source: input.source, recordId: input.recordId, companyName: input.companyName.trim(), decision, note, decidedAt, decidedBy: actor.name };
  });
}
