import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isMissionModel } from "../ai/pricing";
import type { DB } from "../db";
import { missionApprovals, missions, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import {
  DAY_CAP_MICROS,
  MISSION_CAP_MICROS,
  MONTH_CAP_MICROS,
  type ApprovalKind,
  type ApprovalView,
  type MissionScope,
  type MissionStatus,
  type ReviewChoice,
} from "../missions/contract";
import { founderRow, type FounderRow } from "./authority";
import { boiseDay, boiseMonth, endOfBoiseDay } from "./boise";
import { committedTotals } from "./ledger";
import { inTransaction, lockSpending, pgErrorCode } from "./shared";
import { clockFor } from "./testmode";
import { canonicalJson, sha256 } from "./tickets";

// Approvals. An approval binds one mission's exact scope (its fingerprint), its maximum, its review choice and the
// approving owner, and lapses at the end of the Boise day it was given. The scope, fingerprint and maximum are read
// from the mission row inside the transaction, never taken from the caller; the caller passes only the fingerprint
// the window showed, so an edit made after the owner opened the mission can't be approved by accident. One open
// approval per mission and kind (a partial unique index); a repeated request id returns the approval it made.

export type MissionRow = typeof missions.$inferSelect;
type ApprovalRow = typeof missionApprovals.$inferSelect;

export const EXPIRED_REASON = "expired";

/** The scope a mission row binds, exactly the fields of MissionScope. */
export function scopeOfRow(m: MissionRow): MissionScope {
  return {
    type: m.type,
    subject: m.subject,
    protocol: m.protocol,
    provider: m.provider,
    model: m.model,
    thinkingLevel: m.thinkingLevel,
    maxOutputTokens: m.maxOutputTokens,
    maxCostMicros: m.maxCostMicros,
    review: m.review ?? null,
    simulated: m.simulated,
  };
}

function pickScope(s: MissionScope): MissionScope {
  return {
    type: s.type,
    subject: s.subject,
    protocol: s.protocol,
    provider: s.provider,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    maxOutputTokens: s.maxOutputTokens,
    maxCostMicros: s.maxCostMicros,
    review: s.review ? { provider: s.review.provider, model: s.review.model, maxCostMicros: s.review.maxCostMicros } : null,
    simulated: s.simulated,
  };
}

export function scopeFingerprint(scope: MissionScope): string {
  return sha256(`kelqor-scope-v1\n${canonicalJson(pickScope(scope))}`);
}

export function reviewFingerprint(missionFingerprint: string, review: ReviewChoice): string {
  return sha256(`kelqor-review-v1\n${missionFingerprint}\n${canonicalJson({ provider: review.provider, model: review.model, maxCostMicros: review.maxCostMicros })}`);
}

function isReviewChoice(r: unknown): r is ReviewChoice {
  const v = r as ReviewChoice | null;
  return Boolean(
    v &&
      typeof v === "object" &&
      (v.provider === "anthropic" || v.provider === "simulation" || v.provider === "synthetic") &&
      typeof v.model === "string" &&
      v.model.length > 0 &&
      Number.isInteger(v.maxCostMicros) &&
      v.maxCostMicros >= 0 &&
      v.maxCostMicros <= MISSION_CAP_MICROS,
  );
}

export interface ApprovalState {
  state: ApprovalView["state"];
  reason: string | null;
  /** Why it no longer holds, for the paid-request refusal. */
  code: "active" | "voided" | "expired" | "scope" | "authority";
}

/** Whether an approval still holds: not voided, from today in Boise, for the mission's scope, by the current owner. */
export function approvalState(row: ApprovalRow, mission: MissionRow | null, founder: FounderRow | null, now: Date): ApprovalState {
  if (row.voidedAt) return { state: row.voidReason === EXPIRED_REASON ? "expired" : "void", reason: row.voidReason, code: row.voidReason === EXPIRED_REASON ? "expired" : "voided" };
  if (!(now.getTime() < row.expiresAt.getTime()) || boiseDay(now) !== row.boiseDay) {
    return { state: "expired", reason: "It lapsed at the end of the Boise day it was given.", code: "expired" };
  }
  if (!mission || mission.id !== row.missionId) return { state: "void", reason: "Its mission no longer exists.", code: "scope" };
  const stored = mission.scopeFingerprint;
  if (scopeFingerprint(scopeOfRow(mission)) !== stored) return { state: "void", reason: "The mission's scope no longer matches its fingerprint.", code: "scope" };
  const expected = row.kind === "mission" ? stored : isReviewChoice(row.review) ? reviewFingerprint(stored, row.review) : null;
  if (!expected || row.scopeFingerprint !== expected) return { state: "void", reason: "The mission's scope changed after it was approved.", code: "scope" };
  if (!founder || founder.id !== row.approvedById || founder.spendingAuthorityAt.getTime() !== row.authorityGrantedAt.getTime()) {
    return { state: "void", reason: "The approving account no longer holds owner spending authority.", code: "authority" };
  }
  return { state: "active", reason: null, code: "active" };
}

async function viewsOf(db: DB, rows: ApprovalRow[], now: Date): Promise<ApprovalView[]> {
  if (rows.length === 0) return [];
  const missionIds = [...new Set(rows.map((r) => r.missionId))];
  const ms = await db.select().from(missions).where(inArray(missions.id, missionIds));
  const approverIds = [...new Set(rows.map((r) => r.approvedById))];
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds))).map((u) => [u.id, u.name]));
  const founder = await founderRow(db);
  return rows.map((row) => {
    const s = approvalState(row, ms.find((m) => m.id === row.missionId) ?? null, founder, now);
    return {
      id: row.id,
      missionId: row.missionId,
      kind: row.kind,
      scopeFingerprint: row.scopeFingerprint,
      maxCostMicros: row.maxCostMicros,
      review: isReviewChoice(row.review) ? row.review : null,
      approvedBy: { id: row.approvedById, name: names.get(row.approvedById) ?? "" },
      approvedAt: row.approvedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      boiseDay: row.boiseDay,
      state: s.state,
      voidReason: s.reason,
    };
  });
}

const MISSION_FROM: MissionStatus[] = ["awaiting_approval", "approved", "interrupted", "budget_blocked"];
const REVIEW_FROM: MissionStatus[] = ["approved", "interrupted", "budget_blocked", "needs_review"];

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * The owner approves a mission's scope ("mission") or a review added later ("review"). Scope, fingerprint and
 * maximum come from the mission row; seenFingerprint is the mission fingerprint the window showed.
 */
export async function grantApproval(
  db: DB,
  actor: Actor,
  input: { missionId: string; kind: ApprovalKind; seenFingerprint: string; review?: ReviewChoice; requestId: string; now?: Date },
): Promise<ApprovalView> {
  const clock = clockFor(db, input.now);
  if (input.kind !== "mission" && input.kind !== "review") throw new DomainError("Unknown approval kind.", "invalid");
  if (typeof input.requestId !== "string" || !/^[0-9a-f-]{36}$/.test(input.requestId)) throw new DomainError("The approval is missing its request id.", "invalid");
  const id = await inTransaction(db, async (tx) => {
    await lockSpending(tx);
    const now = clock();
    const founder = await founderRow(tx);
    if (!founder || actor?.role !== "operator" || actor.id !== founder.id) {
      throw new DomainError("Only the owner's account can approve AI missions.", "forbidden");
    }
    const [dup] = await tx
      .select()
      .from(missionApprovals)
      .where(and(eq(missionApprovals.missionId, input.missionId), eq(missionApprovals.requestId, input.requestId)))
      .limit(1);
    if (dup) {
      if (dup.kind !== input.kind) throw new DomainError("That request id was already used for another approval.", "conflict");
      return dup.id;
    }
    const [m] = await tx.select().from(missions).where(eq(missions.id, input.missionId)).limit(1);
    if (!m) throw new DomainError("That mission doesn't exist.", "not_found");
    const stored = m.scopeFingerprint;
    if (scopeFingerprint(scopeOfRow(m)) !== stored) throw new DomainError("The mission's saved scope doesn't match its fingerprint, so it can't be approved.", "conflict");
    if (input.seenFingerprint !== stored) throw new DomainError("The mission changed since you opened it. Review it again before approving.", "conflict");

    let review: ReviewChoice | null;
    let fingerprint: string;
    let maxCost: number;
    if (input.kind === "mission") {
      if (!MISSION_FROM.includes(m.status)) throw new DomainError("This mission isn't waiting for an approval.", "conflict");
      if (input.review) throw new DomainError("A mission approval covers the review chosen with the mission; a later review has its own approval.", "invalid");
      review = isReviewChoice(m.review) ? m.review : null;
      fingerprint = stored;
      maxCost = m.maxCostMicros;
    } else {
      if (!REVIEW_FROM.includes(m.status)) throw new DomainError("Review can be added to an approved, paused or Needs review mission.", "conflict");
      if (m.review) throw new DomainError("This mission's review was chosen with it and is covered by its approval.", "conflict");
      if (!isReviewChoice(input.review)) throw new DomainError("Choose a reviewer and a maximum for the review.", "invalid");
      review = { provider: input.review.provider, model: input.review.model, maxCostMicros: input.review.maxCostMicros };
      const expected = m.simulated ? "simulation" : m.provider === "synthetic" ? "synthetic" : "anthropic";
      if (review.provider !== expected || !isMissionModel(review.provider, review.model)) {
        throw new DomainError(m.simulated ? "A simulated mission can only have the simulated reviewer." : "Choose one of the listed Claude reviewers.", "invalid");
      }
      const approvedBefore = await tx
        .select({ id: missionApprovals.id })
        .from(missionApprovals)
        .where(and(eq(missionApprovals.missionId, m.id), eq(missionApprovals.kind, "mission"), eq(missionApprovals.scopeFingerprint, stored)))
        .limit(1);
      if (approvedBefore.length === 0) throw new DomainError("Approve the mission itself before adding a review.", "conflict");
      fingerprint = reviewFingerprint(stored, review);
      maxCost = review.maxCostMicros;
    }

    // One open approval per mission and kind: an open one that no longer holds is closed first.
    const [open] = await tx
      .select()
      .from(missionApprovals)
      .where(and(eq(missionApprovals.missionId, m.id), eq(missionApprovals.kind, input.kind), isNull(missionApprovals.voidedAt)))
      .limit(1);
    if (open) {
      const s = approvalState(open, m, founder, now);
      if (s.state === "active") {
        throw new DomainError(`This mission already has a ${input.kind === "mission" ? "" : "review "}approval valid until the end of ${open.boiseDay} (Boise).`, "conflict");
      }
      await tx
        .update(missionApprovals)
        .set({ voidedAt: now, voidReason: s.state === "expired" ? EXPIRED_REASON : (s.reason ?? "It no longer held.") })
        .where(and(eq(missionApprovals.id, open.id), isNull(missionApprovals.voidedAt)));
    }

    // It must fit what is left of the mission's $2, today's $5 and this month's $20 (simulated missions cost nothing).
    if (!m.simulated) {
      const day = boiseDay(now);
      const t = await committedTotals(tx, { missionId: m.id, day, month: boiseMonth(now) });
      let need: number;
      if (input.kind === "mission") {
        need = Math.max(0, m.maxCostMicros - t.research) + Math.max(0, (review?.maxCostMicros ?? 0) - t.review);
      } else {
        need = Math.max(0, maxCost - t.review);
        if (Math.max(m.maxCostMicros, t.research) + maxCost > MISSION_CAP_MICROS) {
          throw new DomainError(`The review's ${usd(maxCost)} maximum doesn't fit the mission's ${usd(MISSION_CAP_MICROS)} limit beside its research maximum.`, "conflict");
        }
      }
      if (t.mission + need > MISSION_CAP_MICROS) throw new DomainError(`This would let the mission pass its ${usd(MISSION_CAP_MICROS)} limit (${usd(t.mission)} already committed).`, "conflict");
      if (t.day + need > DAY_CAP_MICROS) throw new DomainError(`Today's remaining AI budget is ${usd(Math.max(0, DAY_CAP_MICROS - t.day))}, less than the ${usd(need)} this approval allows. Lower the maximum or approve it another day.`, "conflict");
      if (t.month + need > MONTH_CAP_MICROS) throw new DomainError(`This month's remaining AI budget is ${usd(Math.max(0, MONTH_CAP_MICROS - t.month))}, less than the ${usd(need)} this approval allows.`, "conflict");
    }

    const approvalId = randomUUID();
    try {
      await tx.insert(missionApprovals).values({
        id: approvalId,
        missionId: m.id,
        kind: input.kind,
        scopeFingerprint: fingerprint,
        maxCostMicros: maxCost,
        review,
        approvedById: founder.id,
        approvedAt: now,
        expiresAt: endOfBoiseDay(now),
        boiseDay: boiseDay(now),
        authorityGrantedAt: founder.spendingAuthorityAt,
        requestId: input.requestId,
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("This mission was just approved from another window.", "conflict");
      throw e;
    }
    return approvalId;
  });
  const [row] = await db.select().from(missionApprovals).where(eq(missionApprovals.id, id)).limit(1);
  return (await viewsOf(db, [row], clock()))[0];
}

/** The mission's approval of this kind that still holds now, or null. */
export async function activeApproval(db: DB, missionId: string, kind: ApprovalKind, now?: Date): Promise<ApprovalView | null> {
  const at = clockFor(db, now)();
  const rows = await db
    .select()
    .from(missionApprovals)
    .where(and(eq(missionApprovals.missionId, missionId), eq(missionApprovals.kind, kind), isNull(missionApprovals.voidedAt)))
    .orderBy(desc(missionApprovals.approvedAt))
    .limit(1);
  const view = (await viewsOf(db, rows, at))[0];
  return view && view.state === "active" ? view : null;
}

/** Every approval the mission has had, newest first, with its state now. */
export async function approvalsFor(db: DB, missionId: string): Promise<ApprovalView[]> {
  const rows = await db.select().from(missionApprovals).where(eq(missionApprovals.missionId, missionId)).orderBy(desc(missionApprovals.approvedAt));
  return viewsOf(db, rows, new Date());
}

/** Voids the mission's open approvals (an edit, a cancel). Returns how many. */
export async function voidApprovals(db: DB, missionId: string, reason: string, now?: Date): Promise<number> {
  const at = clockFor(db, now)();
  const text = reason.trim().slice(0, 500) || "Voided.";
  const done = await db
    .update(missionApprovals)
    .set({ voidedAt: at, voidReason: text === EXPIRED_REASON ? "expired (voided)" : text })
    .where(and(eq(missionApprovals.missionId, missionId), isNull(missionApprovals.voidedAt)))
    .returning({ id: missionApprovals.id });
  return done.length;
}
