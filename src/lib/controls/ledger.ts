import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import { aiUsageLedger, missionApprovals, missions } from "../db/schema";
import {
  DAY_CAP_MICROS,
  MISSION_CAP_MICROS,
  MONTH_CAP_MICROS,
  type LedgerEntryView,
  type LedgerStatus,
  type MissionSpend,
  type PeriodSpend,
  type ProviderId,
  type ReviewChoice,
  type SpendingSummary,
} from "../missions/contract";
import { boiseDay, boiseMonth } from "./boise";
import { asCount, backendInstance, redactSecrets, toIso } from "./shared";
import { clockFor } from "./testmode";

// The usage ledger: one row per AI request (and per token count), written before the request is sent and closed
// after it. What a row counts against the caps is the database's own committed_micros column: the reservation while
// open, the settled cost, the unverified amount left after releases, or nothing when not billed. Simulated rows are
// $0 and never counted. Rows are never deleted or rewritten (database triggers, drizzle/0005).

type LedgerRow = typeof aiUsageLedger.$inferSelect;

const RESEARCH_PURPOSES = sql`('research', 'repair', 'retry')`;

export interface CommittedTotals {
  research: number;
  review: number;
  mission: number;
  day: number;
  month: number;
}

/** What the mission, its research, its review, the Boise day and the Boise month have committed, in one query. */
export async function committedTotals(db: DB, at: { missionId: string; day: string; month: string }): Promise<CommittedTotals> {
  const l = aiUsageLedger;
  const [r] = await db
    .select({
      research: sql<unknown>`coalesce(sum(${l.committedMicros}) filter (where ${l.missionId} = ${at.missionId} and ${l.purpose} in ${RESEARCH_PURPOSES}), 0)`,
      review: sql<unknown>`coalesce(sum(${l.committedMicros}) filter (where ${l.missionId} = ${at.missionId} and ${l.purpose} = 'review'), 0)`,
      mission: sql<unknown>`coalesce(sum(${l.committedMicros}) filter (where ${l.missionId} = ${at.missionId}), 0)`,
      day: sql<unknown>`coalesce(sum(${l.committedMicros}) filter (where ${l.boiseDay} = ${at.day}), 0)`,
      month: sql<unknown>`coalesce(sum(${l.committedMicros}) filter (where ${l.boiseMonth} = ${at.month}), 0)`,
    })
    .from(l)
    .where(and(eq(l.simulated, false), sql`(${l.missionId} = ${at.missionId} or ${l.boiseMonth} = ${at.month})`));
  return { research: asCount(r.research), review: asCount(r.review), mission: asCount(r.mission), day: asCount(r.day), month: asCount(r.month) };
}

/** True while a provider has an over-reservation the owner hasn't reviewed. */
export async function providerBlocked(db: DB, provider: ProviderId): Promise<boolean> {
  const rows = await db
    .select({ id: aiUsageLedger.id })
    .from(aiUsageLedger)
    .where(and(eq(aiUsageLedger.provider, provider), eq(aiUsageLedger.overReservation, true), isNull(aiUsageLedger.providerReviewId)))
    .limit(1);
  return rows.length > 0;
}

export async function blockedProviders(db: DB): Promise<ProviderId[]> {
  const rows = await db
    .selectDistinct({ provider: aiUsageLedger.provider })
    .from(aiUsageLedger)
    .where(and(eq(aiUsageLedger.overReservation, true), isNull(aiUsageLedger.providerReviewId)));
  return rows.map((r) => r.provider).sort();
}

export function ledgerView(row: LedgerRow, missionNumber: number | null): LedgerEntryView {
  return {
    id: row.id,
    seq: row.seq,
    missionId: row.missionId,
    missionNumber,
    approvalId: row.approvalId,
    attempt: row.attempt,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    priceVersion: row.priceVersion,
    sentAt: row.sentAt.toISOString(),
    boiseDay: row.boiseDay,
    boiseMonth: row.boiseMonth,
    countedInputTokens: row.countedInputTokens,
    reservedInputTokens: row.reservedInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    reservedMicros: row.reservedMicros,
    status: row.status,
    settledAt: toIso(row.settledAt),
    usage: row.usage ?? null,
    actualMicros: row.actualMicros,
    committedMicros: row.committedMicros ?? 0,
    releasedMicros: row.releasedMicros,
    overReservation: row.overReservation,
    providerRequestId: row.providerRequestId,
    errorKind: row.errorKind,
    errorDetail: row.errorDetail === null ? null : redactSecrets(row.errorDetail),
    simulated: row.simulated,
    synthetic: row.synthetic,
  };
}

export async function ledgerEntries(
  db: DB,
  filter: { missionId?: string; provider?: ProviderId; boiseMonth?: string; boiseDay?: string; status?: LedgerStatus; simulated?: boolean; limit?: number },
): Promise<LedgerEntryView[]> {
  const l = aiUsageLedger;
  const where: SQL[] = [];
  if (filter.missionId) where.push(eq(l.missionId, filter.missionId));
  if (filter.provider) where.push(eq(l.provider, filter.provider));
  if (filter.boiseMonth) where.push(eq(l.boiseMonth, filter.boiseMonth));
  if (filter.boiseDay) where.push(eq(l.boiseDay, filter.boiseDay));
  if (filter.status) where.push(eq(l.status, filter.status));
  if (filter.simulated !== undefined) where.push(eq(l.simulated, filter.simulated));
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 500), 1), 5000);
  const rows = await db
    .select({ l, number: missions.number })
    .from(l)
    .leftJoin(missions, eq(missions.id, l.missionId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(l.seq))
    .limit(limit);
  return rows.map((r) => ledgerView(r.l, r.number ?? null));
}

async function periodSpend(db: DB, kind: "day" | "month", period: string): Promise<PeriodSpend> {
  const l = aiUsageLedger;
  const [r] = await db
    .select({
      settled: sql<unknown>`coalesce(sum(${l.actualMicros}) filter (where ${l.status} = 'settled'), 0)`,
      unverified: sql<unknown>`coalesce(sum(${l.reservedMicros} - ${l.releasedMicros}) filter (where ${l.status} = 'unverified'), 0)`,
      reserved: sql<unknown>`coalesce(sum(${l.reservedMicros}) filter (where ${l.status} = 'reserved'), 0)`,
      committed: sql<unknown>`coalesce(sum(${l.committedMicros}), 0)`,
    })
    .from(l)
    .where(and(eq(l.simulated, false), kind === "day" ? eq(l.boiseDay, period) : eq(l.boiseMonth, period)));
  const capMicros = kind === "day" ? DAY_CAP_MICROS : MONTH_CAP_MICROS;
  const committedMicros = asCount(r.committed);
  return {
    period,
    capMicros,
    settledMicros: asCount(r.settled),
    unverifiedMicros: asCount(r.unverified),
    reservedMicros: asCount(r.reserved),
    committedMicros,
    remainingMicros: Math.max(0, capMicros - committedMicros),
  };
}

/** Today's and this month's spending in Boise, and the providers stopped until the owner reviews them. */
export async function spendingSummary(db: DB, now?: Date): Promise<SpendingSummary> {
  const at = clockFor(db, now)();
  return {
    at: at.toISOString(),
    day: await periodSpend(db, "day", boiseDay(at)),
    month: await periodSpend(db, "month", boiseMonth(at)),
    blockedProviders: await blockedProviders(db),
  };
}

/** The approved review choice: chosen with the mission, or the latest review approval that wasn't voided. */
async function approvedReview(db: DB, missionId: string, chosen: ReviewChoice | null): Promise<ReviewChoice | null> {
  if (chosen) return chosen;
  const rows = await db
    .select({ review: missionApprovals.review, voidedAt: missionApprovals.voidedAt, voidReason: missionApprovals.voidReason })
    .from(missionApprovals)
    .where(and(eq(missionApprovals.missionId, missionId), eq(missionApprovals.kind, "review")))
    .orderBy(desc(missionApprovals.approvedAt));
  const held = rows.find((r) => !r.voidedAt || r.voidReason === "expired");
  return (held?.review as ReviewChoice | null) ?? null;
}

/** What one mission has committed, its approved maximums and what remains of them. */
export async function missionSpend(db: DB, missionId: string): Promise<MissionSpend> {
  const [m] = await db.select({ simulated: missions.simulated, maxCostMicros: missions.maxCostMicros, review: missions.review }).from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!m) throw new Error("That mission doesn't exist.");
  const l = aiUsageLedger;
  const [r] = await db
    .select({
      settled: sql<unknown>`coalesce(sum(${l.actualMicros}) filter (where ${l.status} = 'settled'), 0)`,
      unverified: sql<unknown>`coalesce(sum(${l.reservedMicros} - ${l.releasedMicros}) filter (where ${l.status} = 'unverified'), 0)`,
      reserved: sql<unknown>`coalesce(sum(${l.reservedMicros}) filter (where ${l.status} = 'reserved'), 0)`,
      committed: sql<unknown>`coalesce(sum(${l.committedMicros}), 0)`,
    })
    .from(l)
    .where(and(eq(l.missionId, missionId), eq(l.simulated, false)));
  const review = await approvedReview(db, missionId, (m.review as ReviewChoice | null) ?? null);
  const approvedMicros = m.simulated ? 0 : m.maxCostMicros + (review?.maxCostMicros ?? 0);
  const committedMicros = asCount(r.committed);
  return {
    missionId,
    capMicros: MISSION_CAP_MICROS,
    approvedMicros,
    settledMicros: asCount(r.settled),
    unverifiedMicros: asCount(r.unverified),
    reservedMicros: asCount(r.reserved),
    committedMicros,
    remainingMicros: Math.max(0, Math.min(MISSION_CAP_MICROS, approvedMicros) - committedMicros),
  };
}

/**
 * At backend start: reservations still open from another backend process may have reached the provider, so they
 * become unverified at their full amount. This process's own open reservations are left alone. Nothing is resent.
 */
export async function markOpenReservationsUnverified(db: DB, reason: string, now?: Date): Promise<number> {
  const at = clockFor(db, now)();
  const done = await db
    .update(aiUsageLedger)
    .set({ status: "unverified", errorKind: "interrupted", errorDetail: redactSecrets(reason.trim() || "The backend stopped while this request was in flight."), settledAt: at })
    .where(and(eq(aiUsageLedger.status, "reserved"), ne(aiUsageLedger.backendInstance, backendInstance())))
    .returning({ id: aiUsageLedger.id });
  return done.length;
}
