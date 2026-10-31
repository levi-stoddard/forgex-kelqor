import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import { aiUsageLedger, spendingReconciliations, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import { PROVIDERS, type LedgerEntryView, type ProviderId, type SpendingSummary } from "../missions/contract";
import { assertFounder } from "./authority";
import { boiseDay, boiseMonth } from "./boise";
import { ledgerView, spendingSummary } from "./ledger";
import { asCount, backendInstance, inTransaction, lockSpending, redactSecrets } from "./shared";

// Manual reconciliation against a provider's own console, with no billing credentials (docs/m2b/AUTHORIZATION.md).
// The owner enters the provider's figure for a day or a month, with a note on where it was read. When the provider
// shows more than KELQOR recorded, the difference becomes an unverified adjustment that counts against the caps until
// it is resolved; it is dated when it is recorded and linked to the period it reconciles. When the provider shows
// less, unverified amounts may be released down to the provider's figure, never below KELQOR's settled total. Every
// figure, adjustment, release and unblock is a new record; nothing is edited or deleted.

export interface ReconciliationView {
  provider: ProviderId;
  periodKind: "day" | "month";
  period: string;
  settledMicros: number;
  unverifiedMicros: number;
  releasedMicros: number;
  adjustmentMicros: number;
  unverified: LedgerEntryView[];
  figures: { id: string; providerMicros: number; note: string; recordedBy: string; at: string; differenceMicros: number }[];
  history: { id: string; kind: "figure" | "release" | "adjustment" | "unblock"; micros: number; note: string; recordedBy: string; at: string }[];
}

type PeriodKind = "day" | "month";

const MAX_FIGURE_MICROS = 100_000 * 1_000_000;
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function checkPeriod(provider: ProviderId, periodKind: PeriodKind, period: string, now: Date) {
  if (!PROVIDERS.includes(provider) || provider === "simulation") throw new DomainError("Choose a provider that bills KELQOR's requests.", "invalid");
  if (periodKind === "day") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || Number.isNaN(Date.parse(`${period}T12:00:00Z`)) || new Date(`${period}T12:00:00Z`).toISOString().slice(0, 10) !== period) {
      throw new DomainError("Enter the day as YYYY-MM-DD.", "invalid");
    }
    if (period > boiseDay(now)) throw new DomainError("That day hasn't happened yet in Boise.", "invalid");
  } else if (periodKind === "month") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new DomainError("Enter the month as YYYY-MM.", "invalid");
    if (period > boiseMonth(now)) throw new DomainError("That month hasn't started yet in Boise.", "invalid");
  } else {
    throw new DomainError("Reconcile a day or a month.", "invalid");
  }
}

function checkNote(note: string): string {
  const text = (note ?? "").trim();
  if (text.length < 3) throw new DomainError("Add a note saying where you read the figure.", "invalid");
  return text.slice(0, 2000);
}

/** The ledger entries of a period: mission requests sent in it (not simulated). */
const inPeriod = (periodKind: PeriodKind, period: string): SQL => (periodKind === "day" ? eq(aiUsageLedger.boiseDay, period) : eq(aiUsageLedger.boiseMonth, period));

/** The figures an adjustment can belong to for this period: its own, and for a month the days within it. */
function figuresOfPeriod(provider: ProviderId, periodKind: PeriodKind, period: string): SQL {
  const r = spendingReconciliations;
  const own = and(eq(r.kind, "figure"), eq(r.provider, provider), eq(r.periodKind, periodKind), eq(r.period, period))!;
  if (periodKind === "day") return own;
  return or(own, and(eq(r.kind, "figure"), eq(r.provider, provider), eq(r.periodKind, "day"), sql`${r.period} like ${`${period}-%`}`))!;
}

interface Totals {
  settled: number;
  unverified: number;
  released: number;
  adjustment: number;
  open: number;
  adjustmentIds: string[];
}

async function totals(db: DB, provider: ProviderId, periodKind: PeriodKind, period: string): Promise<Totals> {
  const l = aiUsageLedger;
  const [r] = await db
    .select({
      settled: sql<unknown>`coalesce(sum(${l.actualMicros}) filter (where ${l.status} = 'settled'), 0)`,
      unverified: sql<unknown>`coalesce(sum(${l.reservedMicros} - ${l.releasedMicros}) filter (where ${l.status} = 'unverified'), 0)`,
      released: sql<unknown>`coalesce(sum(${l.releasedMicros}), 0)`,
      open: sql<unknown>`count(*) filter (where ${l.status} = 'reserved')`,
    })
    .from(l)
    .where(and(eq(l.provider, provider), eq(l.simulated, false), sql`${l.purpose} <> 'adjustment'`, inPeriod(periodKind, period)));
  // Adjustments recorded against this period's figures (wherever they are dated).
  const adjustments = await db
    .select({ id: l.id, remaining: sql<unknown>`${l.reservedMicros} - ${l.releasedMicros}`, released: l.releasedMicros })
    .from(l)
    .innerJoin(spendingReconciliations, eq(spendingReconciliations.id, l.reconciliationId))
    .where(
      and(
        eq(l.purpose, "adjustment"),
        eq(l.provider, provider),
        inArray(
          spendingReconciliations.figureId,
          db.select({ id: spendingReconciliations.id }).from(spendingReconciliations).where(figuresOfPeriod(provider, periodKind, period)),
        ),
      ),
    );
  return {
    settled: asCount(r.settled),
    unverified: asCount(r.unverified),
    released: asCount(r.released) + adjustments.reduce((s, a) => s + a.released, 0),
    adjustment: adjustments.reduce((s, a) => s + asCount(a.remaining), 0),
    open: asCount(r.open),
    adjustmentIds: adjustments.map((a) => a.id),
  };
}

export async function reconciliationView(db: DB, input: { provider: ProviderId; periodKind: PeriodKind; period: string }): Promise<ReconciliationView> {
  const { provider, periodKind, period } = input;
  checkPeriod(provider, periodKind, period, new Date());
  const t = await totals(db, provider, periodKind, period);
  const l = aiUsageLedger;
  const unverifiedRows = await db
    .select()
    .from(l)
    .where(
      and(
        eq(l.provider, provider),
        eq(l.status, "unverified"),
        eq(l.simulated, false),
        sql`${l.reservedMicros} > ${l.releasedMicros}`,
        or(and(sql`${l.purpose} <> 'adjustment'`, inPeriod(periodKind, period)), t.adjustmentIds.length ? inArray(l.id, t.adjustmentIds) : sql`false`),
      ),
    )
    .orderBy(l.seq);
  const r = spendingReconciliations;
  const records = await db
    .select({ rec: r, by: users.name })
    .from(r)
    .innerJoin(users, eq(users.id, r.recordedById))
    .where(or(and(eq(r.provider, provider), eq(r.periodKind, periodKind), eq(r.period, period)), and(eq(r.provider, provider), eq(r.kind, "unblock"))))
    .orderBy(desc(r.createdAt));
  return {
    provider,
    periodKind,
    period,
    settledMicros: t.settled,
    unverifiedMicros: t.unverified,
    releasedMicros: t.released,
    adjustmentMicros: t.adjustment,
    unverified: unverifiedRows.map((row) => ledgerView(row, null)),
    figures: records
      .filter((x) => x.rec.kind === "figure")
      .map((x) => ({
        id: x.rec.id,
        providerMicros: x.rec.providerMicros ?? 0,
        note: x.rec.note,
        recordedBy: x.by,
        at: x.rec.createdAt.toISOString(),
        differenceMicros: (x.rec.providerMicros ?? 0) - (x.rec.settledMicros + x.rec.unverifiedMicros),
      })),
    history: records.map((x) => ({
      id: x.rec.id,
      kind: x.rec.kind,
      micros: x.rec.kind === "figure" ? (x.rec.providerMicros ?? 0) : x.rec.kind === "release" ? x.rec.releasedMicros : x.rec.kind === "adjustment" ? x.rec.adjustmentMicros : 0,
      note: x.rec.note,
      recordedBy: x.by,
      at: x.rec.createdAt.toISOString(),
    })),
  };
}

/**
 * Records a provider's figure for a day or a month. When it is more than KELQOR's settled, unverified and adjusted
 * total, the difference is recorded as an unverified adjustment, dated now, that counts against the caps.
 */
export async function recordProviderFigure(
  db: DB,
  actor: Actor,
  input: { provider: ProviderId; periodKind: PeriodKind; period: string; providerMicros: number; note: string },
): Promise<ReconciliationView> {
  const note = checkNote(input.note);
  const now = new Date();
  checkPeriod(input.provider, input.periodKind, input.period, now);
  if (!Number.isInteger(input.providerMicros) || input.providerMicros < 0 || input.providerMicros > MAX_FIGURE_MICROS) {
    throw new DomainError("Enter the provider's figure in dollars and cents.", "invalid");
  }
  await inTransaction(db, async (tx) => {
    await lockSpending(tx);
    await assertFounder(tx, actor);
    const t = await totals(tx, input.provider, input.periodKind, input.period);
    if (t.open > 0) throw new DomainError("A request in this period is still in flight. Reconcile once it has settled.", "conflict");
    const figureId = randomUUID();
    await tx.insert(spendingReconciliations).values({
      id: figureId,
      kind: "figure",
      provider: input.provider,
      periodKind: input.periodKind,
      period: input.period,
      providerMicros: input.providerMicros,
      settledMicros: t.settled,
      unverifiedMicros: t.unverified + t.adjustment,
      note,
      recordedById: actor.id!,
    });
    const recorded = t.settled + t.unverified + t.adjustment;
    if (input.providerMicros > recorded) {
      const difference = input.providerMicros - recorded;
      const adjustmentId = randomUUID();
      const detail = `${input.provider} shows ${usd(input.providerMicros)} for ${input.period}, ${usd(difference)} more than KELQOR recorded. It counts against the caps until you resolve it.`;
      await tx.insert(spendingReconciliations).values({
        id: adjustmentId,
        kind: "adjustment",
        provider: input.provider,
        periodKind: input.periodKind,
        period: input.period,
        adjustmentMicros: difference,
        settledMicros: t.settled,
        unverifiedMicros: t.unverified + t.adjustment,
        figureId,
        note: detail,
        recordedById: actor.id!,
      });
      await tx.insert(aiUsageLedger).values({
        id: randomUUID(),
        purpose: "adjustment",
        provider: input.provider,
        model: "reconciliation",
        priceVersion: "adjustment",
        prices: { input: 0, cachedInput: 0, output: 0 },
        sentAt: now,
        boiseDay: boiseDay(now),
        boiseMonth: boiseMonth(now),
        countedInputTokens: 0,
        reservedInputTokens: 0,
        maxOutputTokens: 0,
        reservedMicros: difference,
        status: "unverified",
        errorKind: "reconciliation_adjustment",
        errorDetail: redactSecrets(detail),
        simulated: false,
        synthetic: input.provider === "synthetic",
        backendInstance: backendInstance(),
        reconciliationId: adjustmentId,
        settledAt: now,
      });
    }
  });
  return reconciliationView(db, input);
}

/** Releases unverified amounts against the latest figure for their period, down to it and never below the settled total. */
export async function releaseUnverified(db: DB, actor: Actor, input: { figureId: string; entries: { ledgerId: string; micros: number }[]; note: string }): Promise<ReconciliationView> {
  const note = checkNote(input.note);
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw new DomainError("Choose the unverified requests to release.", "invalid");
  const ids = input.entries.map((e) => e.ledgerId);
  if (new Set(ids).size !== ids.length) throw new DomainError("Each request can appear once in a release.", "invalid");
  if (!input.entries.every((e) => typeof e.ledgerId === "string" && Number.isInteger(e.micros) && e.micros > 0)) throw new DomainError("Each release must be a positive amount.", "invalid");
  const view = await inTransaction(db, async (tx) => {
    await lockSpending(tx);
    await assertFounder(tx, actor);
    const r = spendingReconciliations;
    const [figure] = await tx.select().from(r).where(and(eq(r.id, input.figureId), eq(r.kind, "figure"))).limit(1);
    if (!figure || !figure.periodKind || !figure.period || figure.providerMicros === null) throw new DomainError("That provider figure doesn't exist.", "not_found");
    const periodKind = figure.periodKind;
    const period = figure.period;
    const [latest] = await tx
      .select({ id: r.id })
      .from(r)
      .where(and(eq(r.kind, "figure"), eq(r.provider, figure.provider), eq(r.periodKind, periodKind), eq(r.period, period)))
      .orderBy(desc(r.createdAt))
      .limit(1);
    if (latest?.id !== figure.id) throw new DomainError("A newer figure was recorded for this period; release against it.", "conflict");
    const t = await totals(tx, figure.provider, periodKind, period);
    if (t.open > 0) throw new DomainError("A request in this period is still in flight. Release once it has settled.", "conflict");
    const releasable = Math.max(0, t.settled + t.unverified + t.adjustment - Math.max(figure.providerMicros, t.settled));
    const total = input.entries.reduce((s, e) => s + e.micros, 0);
    if (total > releasable) {
      throw new DomainError(
        `You can release at most ${usd(releasable)} for ${period}: ${figure.provider} shows ${usd(figure.providerMicros)}, and KELQOR has ${usd(t.settled)} settled, which is never released.`,
        "conflict",
      );
    }
    const l = aiUsageLedger;
    const rows = await tx.select().from(l).where(inArray(l.id, ids));
    for (const e of input.entries) {
      const row = rows.find((x) => x.id === e.ledgerId);
      const belongs =
        row &&
        row.provider === figure.provider &&
        row.status === "unverified" &&
        !row.simulated &&
        (row.purpose === "adjustment" ? t.adjustmentIds.includes(row.id) : periodKind === "day" ? row.boiseDay === period : row.boiseMonth === period);
      if (!row || !belongs) throw new DomainError("Only this period's unverified requests can be released against its figure.", "invalid");
      if (e.micros > row.reservedMicros - row.releasedMicros) throw new DomainError(`At most ${usd(row.reservedMicros - row.releasedMicros)} of that request is still unverified.`, "invalid");
    }
    await tx.insert(r).values({
      id: randomUUID(),
      kind: "release",
      provider: figure.provider,
      periodKind,
      period,
      releasedMicros: total,
      settledMicros: t.settled,
      unverifiedMicros: t.unverified + t.adjustment,
      figureId: figure.id,
      entries: input.entries.map((e) => ({ ledgerId: e.ledgerId, micros: e.micros })),
      note,
      recordedById: actor.id!,
    });
    for (const e of input.entries) {
      await tx
        .update(l)
        .set({ releasedMicros: sql`${l.releasedMicros} + ${e.micros}` })
        .where(and(eq(l.id, e.ledgerId), eq(l.status, "unverified")));
    }
    return { provider: figure.provider, periodKind, period };
  });
  return reconciliationView(db, view);
}

/** The owner has reviewed a provider's overrun: requests to it may be sent again. */
export async function unblockProvider(db: DB, actor: Actor, input: { provider: ProviderId; note: string }): Promise<SpendingSummary> {
  const note = checkNote(input.note);
  if (!PROVIDERS.includes(input.provider)) throw new DomainError("Unknown provider.", "invalid");
  await inTransaction(db, async (tx) => {
    await lockSpending(tx);
    await assertFounder(tx, actor);
    const l = aiUsageLedger;
    const blocking = await tx
      .select({ id: l.id, actual: l.actualMicros, reserved: l.reservedMicros })
      .from(l)
      .where(and(eq(l.provider, input.provider), eq(l.overReservation, true), isNull(l.providerReviewId)));
    if (blocking.length === 0) throw new DomainError(`Nothing is stopping requests to ${input.provider}.`, "conflict");
    const id = randomUUID();
    await tx.insert(spendingReconciliations).values({
      id,
      kind: "unblock",
      provider: input.provider,
      entries: blocking.map((b) => ({ ledgerId: b.id, micros: b.actual ?? b.reserved })),
      note,
      recordedById: actor.id!,
    });
    await tx
      .update(l)
      .set({ providerReviewId: id })
      .where(inArray(l.id, blocking.map((b) => b.id)));
  });
  return spendingSummary(db);
}
