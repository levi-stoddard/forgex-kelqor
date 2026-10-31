import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { isMissionModel, missionCostMicros, missionPrice, outputOnlyMicros, reservationFor } from "../ai/pricing";
import type { ModelReply, ModelRequest, TokenUsage } from "../ai/types";
import type { DB } from "../db";
import { aiUsageLedger, missionApprovals, missions } from "../db/schema";
import { looksLikeCredential } from "../research/agent";
import {
  DAY_CAP_MICROS,
  MISSION_CAP_MICROS,
  MISSION_OUTPUT_LIMIT,
  MONTH_CAP_MICROS,
  PAID_STATUS,
  ProviderError,
  ProviderFailure,
  REQUEST_PURPOSES,
  SpendRefused,
  TicketRefused,
  UnsafeReply,
  type LedgerPurpose,
  type MeteredContext,
  type MeteredReply,
  type MissionProvider,
  type ProviderKind,
  type ReviewChoice,
  type SpendRefusalReason,
} from "../missions/contract";
import { approvalState, scopeFingerprint, scopeOfRow, type MissionRow } from "./approvals";
import { founderRow } from "./authority";
import { boiseDay, boiseMonth } from "./boise";
import { committedTotals, providerBlocked } from "./ledger";
import { backendInstance, isTransactionHandle, lockSpending, pgErrorCode, redactSecrets } from "./shared";
import { assertTestDatabase, clockFor } from "./testmode";
import { issueTicket, requestDigest, retireTicket, ticketStatus } from "./tickets";

// The paid-request pathway: the only way a mission reaches any model provider.
//   0. A transaction handle is refused: the reservation must be committed before anything is sent.
//   1. A pre-check of everything in step 3, at the output-only maximum, under the spending lock, which also records
//      the token count's own $0 ledger row: an unapproved, blocked or over-cap mission doesn't even count.
//   2. A count ticket and the provider's own count.
//   3. One transaction under the spending lock checks it all again with the real reservation and records it.
//   4. A send ticket and the request.
//   5. Settlement at the row's own prices; a cost, input or output above the reservation settles and stops the
//      provider; a refusal before processing is not billed; anything else, and a reply without usage, counts as
//      unverified at the full reservation. A credential-like reply is recorded, then thrown away as UnsafeReply.

const REFUSED_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);
const REFUSAL_KINDS = new Set(["invalid_request", "auth", "not_found", "rate_limit"]);
const DETERMINISTIC_KINDS = new Set(["invalid_request", "auth", "not_found"]);

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;
const label = (status: string) => status.replace(/_/g, " ");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Cleared {
  mission: MissionRow;
  approvalId: string;
  approvalRemainingMs: number;
  kind: ProviderKind;
  price: { version: string; input: number; cachedInput: number; output: number };
  reservedInputTokens: number;
  reservedMicros: number;
}

const refuse = (reason: SpendRefusalReason, text: string): never => {
  throw new SpendRefused(reason, text);
};

/** Every check before a request, inside the caller's locked transaction. `counted` is null for the pre-check. */
async function clear(tx: DB, ctx: MeteredContext, provider: MissionProvider, request: ModelRequest, now: Date, counted: { counted: number; uncounted: number } | null): Promise<Cleared> {
  const [m] = await tx.select().from(missions).where(eq(missions.id, ctx.missionId)).limit(1);
  if (!m) return refuse("mission_not_running", "That mission doesn't exist, so nothing was sent.");
  if (m.runId !== ctx.runId) return refuse("stale_run", "Another run owns this mission now, so this one sends nothing.");
  const paid = PAID_STATUS[ctx.purpose];
  if (m.status !== paid) return refuse("mission_not_running", `The mission is ${label(m.status)}; ${ctx.purpose} requests are sent only while it is ${label(paid)}.`);
  const scope = scopeOfRow(m);
  if (scopeFingerprint(scope) !== m.scopeFingerprint) return refuse("scope_changed", "The mission's saved scope no longer matches its fingerprint, so nothing was sent.");

  // The approval that covers this purpose: the mission's, or for a review added later, the review's own.
  const review = ctx.purpose === "review";
  const kind = review && !m.review ? "review" : "mission";
  const [approval] = await tx
    .select()
    .from(missionApprovals)
    .where(and(eq(missionApprovals.missionId, m.id), eq(missionApprovals.kind, kind), isNull(missionApprovals.voidedAt)))
    .orderBy(desc(missionApprovals.approvedAt))
    .limit(1);
  if (!approval) return refuse("no_approval", review ? "No review was approved for this mission, so nothing was sent." : "The mission has no valid approval, so nothing was sent.");
  const state = approvalState(approval, m, await founderRow(tx), now);
  if (state.code === "expired") return refuse("approval_expired", "The approval lapsed at the end of the Boise day it was given. Renew it to continue.");
  if (state.code === "authority") return refuse("no_authority", "The approving account no longer holds owner spending authority, so nothing was sent.");
  if (state.code !== "active") return refuse("scope_changed", `The approval no longer holds: ${state.reason ?? "it was voided"}.`);

  // The provider, model, kind and thinking level must be the approved ones.
  const choice: ReviewChoice | null = review ? ((kind === "mission" ? m.review : approval.review) as ReviewChoice | null) : null;
  if (review && !choice) return refuse("no_approval", "No review was approved for this mission, so nothing was sent.");
  const expectedProvider = review ? choice!.provider : scope.provider;
  const expectedModel = review ? choice!.model : scope.model;
  if (provider.provider !== expectedProvider || provider.model !== expectedModel) {
    return refuse("provider_mismatch", `This was approved for ${expectedProvider} ${expectedModel}, not ${provider.provider} ${provider.model}, so nothing was sent.`);
  }
  const expectedKind: ProviderKind = expectedProvider === "simulation" ? "simulated" : expectedProvider === "synthetic" ? "synthetic" : "real";
  if (provider.kind !== expectedKind || m.simulated !== (expectedKind === "simulated")) {
    return refuse("provider_mismatch", "A simulated mission uses only the simulated provider, and a real mission never does, so nothing was sent.");
  }
  const thinkingOk = review
    ? provider.thinkingLevel === null
    : expectedKind === "real"
      ? provider.thinkingLevel === scope.thinkingLevel
      : provider.thinkingLevel === null || provider.thinkingLevel === scope.thinkingLevel;
  if (!thinkingOk) return refuse("provider_mismatch", `The provider's thinking level (${provider.thinkingLevel ?? "none"}) isn't the approved ${review ? "none" : scope.thinkingLevel}, so nothing was sent.`);
  if (request.maxOutputTokens !== scope.maxOutputTokens || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > MISSION_OUTPUT_LIMIT) {
    return refuse("output_limit", `The request's output limit isn't the approved ${scope.maxOutputTokens.toLocaleString("en-US")} tokens, so nothing was sent.`);
  }
  const approvalRemainingMs = approval.expiresAt.getTime() - now.getTime();
  if (expectedKind === "simulated") {
    const seen = counted ? counted.counted + counted.uncounted : 0;
    return { mission: m, approvalId: approval.id, approvalRemainingMs, kind: expectedKind, price: { version: "simulation@$0", input: 0, cachedInput: 0, output: 0 }, reservedInputTokens: seen, reservedMicros: 0 };
  }

  if (await providerBlocked(tx, provider.provider)) {
    return refuse("provider_blocked", `Requests to ${provider.provider} are stopped until you review a reported cost above its reservation (AI Operations > Spending).`);
  }
  if (!isMissionModel(provider.provider, provider.model)) return refuse("unpriced_model", `No mission price is recorded for ${provider.provider} ${provider.model}, so its spending can't be capped.`);
  let price: { version: string; input: number; cachedInput: number; output: number };
  let reservedInputTokens = 0;
  let reservedMicros: number;
  if (counted) {
    const r = reservationFor(provider.model, counted, request.maxOutputTokens, now);
    price = r.price;
    reservedInputTokens = r.inputTokens;
    reservedMicros = r.micros;
  } else {
    price = missionPrice(provider.model, now);
    reservedMicros = outputOnlyMicros(provider.model, request.maxOutputTokens, now);
  }

  // The caps, in order: the purpose's approved maximum, the mission's $2, the Boise day's $5, the Boise month's $20.
  const t = await committedTotals(tx, { missionId: m.id, day: boiseDay(now), month: boiseMonth(now) });
  const purposeCap = review ? choice!.maxCostMicros : m.maxCostMicros;
  const purposeCommitted = review ? t.review : t.research;
  const next = counted ? "The next request" : "Even before its input is counted, the next request";
  if (purposeCommitted + reservedMicros > purposeCap) {
    return refuse("approval_cap", `${next} could cost up to ${usd(reservedMicros)}, and ${usd(purposeCommitted)} of its approved ${usd(purposeCap)} is already committed.`);
  }
  if (t.mission + reservedMicros > MISSION_CAP_MICROS) return refuse("mission_cap", `${next} could cost up to ${usd(reservedMicros)}, and the mission has committed ${usd(t.mission)} of its ${usd(MISSION_CAP_MICROS)} limit.`);
  if (t.day + reservedMicros > DAY_CAP_MICROS) return refuse("day_cap", `${next} could cost up to ${usd(reservedMicros)}, and ${usd(t.day)} of today's ${usd(DAY_CAP_MICROS)} (Boise) is committed.`);
  if (t.month + reservedMicros > MONTH_CAP_MICROS) return refuse("month_cap", `${next} could cost up to ${usd(reservedMicros)}, and ${usd(t.month)} of this month's ${usd(MONTH_CAP_MICROS)} (Boise) is committed.`);
  return { mission: m, approvalId: approval.id, approvalRemainingMs, kind: expectedKind, price, reservedInputTokens, reservedMicros };
}

/** A database or internal failure while checking becomes "cap_unconfirmed": nothing is sent. */
async function confirmed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof SpendRefused) throw e;
    throw new SpendRefused("cap_unconfirmed", `The approval and budget couldn't be confirmed, so nothing was sent: ${redactSecrets(message(e), process.env, 300)}`);
  }
}

interface NewEntry {
  id: string;
  ctx: MeteredContext;
  purpose: LedgerPurpose;
  provider: MissionProvider;
  cleared: Cleared;
  now: Date;
  countedInputTokens: number;
  reservedInputTokens: number;
  reservedMicros: number;
  maxOutputTokens: number;
  priceVersion: string;
  prices: { input: number; cachedInput: number; output: number };
}

async function insertEntry(tx: DB, e: NewEntry): Promise<void> {
  try {
    await tx.insert(aiUsageLedger).values({
      id: e.id,
      missionId: e.ctx.missionId,
      approvalId: e.cleared.approvalId,
      stepId: e.ctx.stepId,
      attempt: e.ctx.attempt,
      purpose: e.purpose,
      provider: e.provider.provider,
      model: e.provider.model,
      priceVersion: e.priceVersion,
      prices: e.prices,
      sentAt: e.now,
      boiseDay: boiseDay(e.now),
      boiseMonth: boiseMonth(e.now),
      countedInputTokens: e.countedInputTokens,
      reservedInputTokens: e.reservedInputTokens,
      maxOutputTokens: e.maxOutputTokens,
      reservedMicros: e.reservedMicros,
      status: "reserved",
      simulated: e.cleared.kind === "simulated",
      synthetic: e.cleared.kind === "synthetic",
      backendInstance: backendInstance(),
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === "23505") refuse("stale_run", "This step's attempt is already in the ledger, so it wasn't sent again.");
    if (code === "23503") refuse("cap_unconfirmed", "The request's mission step isn't recorded, so nothing was sent.");
    throw err;
  }
}

type EntryPatch = Partial<typeof aiUsageLedger.$inferInsert>;

/** Closes an open entry; a closed one is never changed again. */
async function closeEntry(db: DB, id: string, patch: EntryPatch): Promise<boolean> {
  const done = await db
    .update(aiUsageLedger)
    .set(patch)
    .where(and(eq(aiUsageLedger.id, id), eq(aiUsageLedger.status, "reserved")))
    .returning({ id: aiUsageLedger.id });
  return done.length === 1;
}

/** What a failed call counts as. Not billed only when it never left, or the provider refused it before processing. */
function failureOutcome(e: unknown, redeemed: boolean): { status: "not_billed" | "unverified"; error: ProviderError } {
  if (e instanceof TicketRefused && !redeemed) return { status: "not_billed", error: new ProviderError(e.message, "other", "no") };
  if (e instanceof ProviderError) {
    const refused = e.sent === "no" || (e.status !== undefined && REFUSED_STATUSES.has(e.status) && REFUSAL_KINDS.has(e.kind));
    return { status: refused ? "not_billed" : "unverified", error: new ProviderError(redactSecrets(e.message, process.env, 500), e.kind, e.sent, e.status) };
  }
  return { status: "unverified", error: new ProviderError(redactSecrets(message(e), process.env, 500), "other", "unknown") };
}

function failurePatch(outcome: { status: "not_billed" | "unverified"; error: ProviderError }, at: Date): EntryPatch {
  const status = outcome.error.status !== undefined ? ` (HTTP ${outcome.error.status})` : "";
  return { status: outcome.status, errorKind: outcome.error.kind, errorDetail: redactSecrets(`${outcome.error.message}${status}`), settledAt: at };
}

const wholeTokens = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000_000;

function validUsage(u: unknown): TokenUsage | null {
  const v = u as TokenUsage | null;
  if (!v || typeof v !== "object") return null;
  const fields = [v.input, v.cachedInput, v.output, v.thinking, v.toolUse, v.total];
  if (!fields.every(wholeTokens)) return null;
  if (v.cacheWriteInput !== undefined && !wholeTokens(v.cacheWriteInput)) return null;
  if (v.cachedInput > v.input) return null;
  return {
    input: v.input,
    cachedInput: v.cachedInput,
    output: v.output,
    thinking: v.thinking,
    toolUse: v.toolUse,
    total: v.total,
    ...(v.cacheWriteInput !== undefined ? { cacheWriteInput: v.cacheWriteInput } : {}),
  };
}

const replyShaped = (r: unknown): r is ModelReply =>
  Boolean(r && typeof r === "object" && typeof (r as ModelReply).status === "string" && typeof (r as ModelReply).text === "string" && Array.isArray((r as ModelReply).toolCalls));

function settlement(c: Cleared, maxOutputTokens: number, reply: ModelReply, at: Date): { patch: EntryPatch; committed: number } {
  const providerRequestId = typeof reply.id === "string" ? reply.id.slice(0, 200) : null;
  if (c.kind === "simulated") return { patch: { status: "settled", usage: validUsage(reply.usage), actualMicros: 0, providerRequestId, settledAt: at }, committed: 0 };
  const reported = reply.usageReported === true ? validUsage(reply.usage) : null;
  // Every real request has input; a reply reporting none (an empty usage object) can't be settled at $0.
  const usage = reported && reported.input > 0 ? reported : null;
  if (!usage) {
    const why = reply.usageReported === true ? "usage_malformed" : "usage_not_reported";
    return {
      patch: {
        status: "unverified",
        errorKind: why,
        errorDetail: why === "usage_malformed" ? "The response's usage figures weren't usable, so it counts at its full reservation until reconciled." : "The response carried no usage, so it counts at its full reservation until reconciled.",
        providerRequestId,
        settledAt: at,
      },
      committed: c.reservedMicros,
    };
  }
  const actual = missionCostMicros(c.price, usage);
  const over: string[] = [];
  if (actual > c.reservedMicros) over.push(`The reported cost ${usd(actual)} is above the ${usd(c.reservedMicros)} reserved.`);
  if (usage.input + usage.toolUse > c.reservedInputTokens) over.push(`The reported input of ${(usage.input + usage.toolUse).toLocaleString("en-US")} tokens is above the ${c.reservedInputTokens.toLocaleString("en-US")} reserved.`);
  if (usage.output + usage.thinking > maxOutputTokens) over.push(`The reported output and thinking of ${(usage.output + usage.thinking).toLocaleString("en-US")} tokens is above the ${maxOutputTokens.toLocaleString("en-US")}-token limit.`);
  if ((usage.cacheWriteInput ?? 0) > 0) over.push(`The provider reported ${usage.cacheWriteInput!.toLocaleString("en-US")} tokens written to a prompt cache, which bills above the input price.`);
  return {
    patch: {
      status: "settled",
      usage,
      actualMicros: actual,
      overReservation: over.length > 0,
      errorKind: over.length ? "over_reservation" : null,
      errorDetail: over.length ? `${over.join(" ")} Requests to this provider are stopped until you review it.` : null,
      providerRequestId,
      settledAt: at,
    },
    committed: actual,
  };
}

const countShaped = (r: unknown): r is { counted: number; uncounted: number } =>
  Boolean(r && typeof r === "object" && wholeTokens((r as { counted: number }).counted) && (r as { counted: number }).counted > 0 && wholeTokens((r as { uncounted: number }).uncounted));

/** The only way a mission's model request is sent. See the steps above. */
export async function meteredRequest(db: DB, ctx: MeteredContext, provider: MissionProvider, request: ModelRequest, signal: AbortSignal): Promise<MeteredReply> {
  if (isTransactionHandle(db)) throw new Error("meteredRequest can't run inside a transaction: its reservation must be committed before anything is sent.");
  if (!ctx || typeof ctx.missionId !== "string" || typeof ctx.runId !== "string" || typeof ctx.stepId !== "string") {
    throw new SpendRefused("mission_not_running", "The request isn't tied to a mission run, so nothing was sent.");
  }
  if (!REQUEST_PURPOSES.includes(ctx.purpose)) throw new SpendRefused("provider_mismatch", "The request has no known purpose, so nothing was sent.");
  if (!Number.isInteger(ctx.attempt) || ctx.attempt < 1 || ctx.attempt > 3) throw new SpendRefused("attempt_limit", "A step is tried at most three times (two retries), so nothing was sent.");
  const clock = clockFor(db, ctx.now);
  if (provider?.kind === "synthetic") assertTestDatabase(db);
  if (signal?.aborted) throw new SpendRefused("mission_not_running", "The run was cancelled, so nothing was sent.");
  const snapshot = structuredClone(request);
  const digest = requestDigest(snapshot);

  // 1. Pre-check, and the token count's own $0 entry.
  const pre = await confirmed(() =>
    db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      await lockSpending(tx);
      const now = clock();
      const c = await clear(tx, ctx, provider, snapshot, now, null);
      const countId = randomUUID();
      await insertEntry(tx, {
        id: countId,
        ctx,
        purpose: "count",
        provider,
        cleared: c,
        now,
        countedInputTokens: 0,
        reservedInputTokens: 0,
        reservedMicros: 0,
        maxOutputTokens: snapshot.maxOutputTokens,
        priceVersion: "count:no-charge",
        prices: { input: 0, cachedInput: 0, output: 0 },
      });
      return { countId, c };
    }),
  );

  // 2. The count.
  const countTicket = issueTicket({
    use: "count",
    reservationId: pre.countId,
    provider: provider.provider,
    model: provider.model,
    kind: provider.kind,
    maxOutputTokens: snapshot.maxOutputTokens,
    digest,
    validForMs: pre.c.approvalRemainingMs,
  });
  let counted: { counted: number; uncounted: number };
  try {
    const r = await provider.countInputTokens(snapshot, countTicket, signal);
    if (ticketStatus(countTicket) !== "redeemed") throw new ProviderError("The provider counted the input without redeeming its ticket.", "other", "unknown");
    if (!countShaped(r)) throw new ProviderError("The token counter returned no usable count.", "other", "unknown");
    counted = { counted: r.counted, uncounted: r.uncounted };
  } catch (e) {
    const outcome = failureOutcome(e, ticketStatus(countTicket) === "redeemed");
    retireTicket(countTicket);
    await closeEntry(db, pre.countId, failurePatch(outcome, clock())).catch(() => false);
    // An invalid, unauthorized or unknown-model count is refused identically on every try, so it isn't retried.
    const reason = DETERMINISTIC_KINDS.has(outcome.error.kind) ? "count_rejected" : "count_failed";
    throw new SpendRefused(reason, `The request's input couldn't be counted, so nothing was sent: ${outcome.error.message}`);
  }
  retireTicket(countTicket);
  await closeEntry(db, pre.countId, {
    status: "settled",
    actualMicros: 0,
    countedInputTokens: counted.counted,
    reservedInputTokens: counted.counted + counted.uncounted,
    settledAt: clock(),
  });

  // 3. The reservation.
  const res = await confirmed(() =>
    db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      await lockSpending(tx);
      const now = clock();
      const c = await clear(tx, ctx, provider, snapshot, now, counted);
      const ledgerId = randomUUID();
      await insertEntry(tx, {
        id: ledgerId,
        ctx,
        purpose: ctx.purpose,
        provider,
        cleared: c,
        now,
        countedInputTokens: counted.counted,
        reservedInputTokens: c.reservedInputTokens,
        reservedMicros: c.reservedMicros,
        maxOutputTokens: snapshot.maxOutputTokens,
        priceVersion: c.price.version,
        prices: { input: c.price.input, cachedInput: c.price.cachedInput, output: c.price.output },
      });
      return { ledgerId, c };
    }),
  );

  // 4. The request.
  const sendTicket = issueTicket({
    use: "send",
    reservationId: res.ledgerId,
    provider: provider.provider,
    model: provider.model,
    kind: provider.kind,
    maxOutputTokens: snapshot.maxOutputTokens,
    digest,
    validForMs: res.c.approvalRemainingMs,
  });
  let reply: unknown;
  try {
    reply = await provider.respond(snapshot, sendTicket, signal);
  } catch (e) {
    const outcome = failureOutcome(e, ticketStatus(sendTicket) === "redeemed");
    retireTicket(sendTicket);
    await closeEntry(db, res.ledgerId, failurePatch(outcome, clock()));
    throw new ProviderFailure(res.ledgerId, outcome.status, outcome.error);
  }
  const redeemed = ticketStatus(sendTicket) === "redeemed";
  retireTicket(sendTicket);
  if (!redeemed || !replyShaped(reply)) {
    // An answer without a redeemed ticket reached the provider outside the controls; a malformed one can't be settled.
    const error = !redeemed
      ? new ProviderError("The provider answered without redeeming its ticket, so the request counts as unverified and the provider is stopped until you review it.", "other", "unknown")
      : new ProviderError("The provider's answer was malformed, so the request counts as unverified at its full reservation.", "other", "unknown");
    await closeEntry(db, res.ledgerId, {
      status: "unverified",
      errorKind: !redeemed ? "ticket_not_redeemed" : "reply_malformed",
      errorDetail: error.message,
      overReservation: !redeemed && res.c.kind !== "simulated",
      settledAt: clock(),
    });
    throw new ProviderFailure(res.ledgerId, "unverified", error);
  }

  // 5. Settlement.
  const s = settlement(res.c, snapshot.maxOutputTokens, reply, clock());
  await closeEntry(db, res.ledgerId, s.patch);
  if (looksLikeCredential(reply.text) || reply.toolCalls.some((call) => looksLikeCredential(JSON.stringify(call?.args ?? {})))) throw new UnsafeReply(res.ledgerId);
  return {
    reply,
    ledgerId: res.ledgerId,
    countedInputTokens: counted.counted,
    reservedInputTokens: res.c.reservedInputTokens,
    reservedMicros: res.c.reservedMicros,
    actualMicros: s.committed,
  };
}
