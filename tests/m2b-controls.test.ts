import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costUsd, missionCostMicros, priceFor, worstCaseUsd } from "@/lib/ai/pricing";
import {
  activeApproval,
  approvalsFor,
  boiseDay,
  boiseMonth,
  endOfBoiseDay,
  grantApproval,
  isMissionModel,
  ledgerEntries,
  markOpenReservationsUnverified,
  meteredRequest,
  missionPrice,
  missionSpend,
  recordProviderFigure,
  releaseUnverified,
  reservationFor,
  revokeFounder,
  unblockProvider,
  reviewFingerprint,
  scopeFingerprint,
  spendingSummary,
  syntheticProvider,
  voidApprovals,
} from "@/lib/controls";
import { aiUsageLedger, missionApprovals, missions, spendingReconciliations } from "@/lib/db/schema";
import {
  DAY_CAP_MICROS,
  MONTH_CAP_MICROS,
  ProviderError,
  ProviderFailure,
  SpendRefused,
  TicketRefused,
  UnsafeReply,
  type SpendRefusalReason,
} from "@/lib/missions/contract";
import { simulatedResearcher, simulatedReviewer } from "@/lib/missions/simulated";
import { redeemTicket } from "@/lib/controls";
import { TEST_PASSWORD } from "./helpers";
import {
  approve,
  approveReview,
  ctxFor,
  fakeProvider,
  fingerprintOf,
  insertMission,
  mdt,
  mst,
  reply,
  request,
  runningMission,
  scope,
  signal,
  simulatedScope,
  spend,
  startRun,
  step,
  usage,
  world,
  type World,
} from "./fixtures/sentinel/world";

// The security reviewer's control tests (docs/m2b/PLAN.md, criteria 3, 5, 8-16, 18-20 at the controls level). Everything runs on
// in-memory databases with providers that never open a connection; costs and clocks are synthetic.

// No test may reach a network: any fetch fails the test loudly.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("A test tried to open a network connection.");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function refusal(p: Promise<unknown>): Promise<SpendRefusalReason> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SpendRefused) return e.reason;
    throw e;
  }
  throw new Error("Expected a refusal, but the request was sent.");
}

const rows = (w: World, missionId: string) => w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, missionId)).orderBy(aiUsageLedger.seq);

// A Tuesday in November 2026, mid-afternoon in Boise.
const T = mst("2026-11-17T14:00:00");

describe("the Boise calendar", () => {
  it("places instants on Boise days, across both daylight-saving changes", () => {
    expect(boiseDay(new Date("2026-11-01T05:59:59Z"))).toBe("2026-10-31");
    expect(boiseDay(new Date("2026-11-01T06:00:00Z"))).toBe("2026-11-01");
    expect(boiseDay(new Date("2026-11-02T06:59:59Z"))).toBe("2026-11-01"); // 25-hour day
    expect(boiseDay(new Date("2026-11-02T07:00:00Z"))).toBe("2026-11-02");
    expect(boiseDay(new Date("2027-03-14T06:59:59Z"))).toBe("2027-03-13");
    expect(boiseDay(new Date("2027-03-15T05:59:59Z"))).toBe("2027-03-14"); // 23-hour day
    expect(boiseMonth(new Date("2026-12-01T06:59:59Z"))).toBe("2026-11");
    expect(boiseMonth(new Date("2026-12-01T07:00:00Z"))).toBe("2026-12");
  });

  it("ends a Boise day at the next Boise midnight", () => {
    expect(endOfBoiseDay(new Date("2026-10-31T12:00:00Z")).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(endOfBoiseDay(new Date("2026-11-01T06:00:00Z")).toISOString()).toBe("2026-11-02T07:00:00.000Z");
    expect(endOfBoiseDay(new Date("2027-03-14T07:00:00Z")).toISOString()).toBe("2027-03-15T06:00:00.000Z");
    expect(endOfBoiseDay(mst("2026-11-30T23:59:59")).toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(endOfBoiseDay(mst("2026-12-31T08:00:00")).toISOString()).toBe("2027-01-01T07:00:00.000Z");
    expect(endOfBoiseDay(mdt("2026-07-04T00:00:00")).toISOString()).toBe("2026-07-05T06:00:00.000Z");
    expect(() => endOfBoiseDay(new Date(Number.NaN))).toThrow();
  });

  it("agrees with the database's own America/Boise conversion, hour by hour around both changes", async () => {
    const w = await world();
    const instants: Date[] = [];
    for (const start of ["2026-10-31T00:00:00Z", "2027-03-13T00:00:00Z"]) {
      for (let h = 0; h < 72; h++) instants.push(new Date(Date.parse(start) + h * 3_600_000 + 59 * 60_000));
    }
    for (const at of instants) {
      const r = (await w.db.execute(sql`select to_char(${at.toISOString()}::timestamptz at time zone 'America/Boise', 'YYYY-MM-DD') as d`)) as unknown as { rows: { d: string }[] };
      expect(boiseDay(at)).toBe(r.rows[0].d);
    }
  });
});

describe("mission prices", () => {
  it("applies the listed price, and the higher one within 24 hours of a change (criterion 16)", () => {
    expect(missionPrice("gemini-4-argon", new Date("2026-11-29T23:59:59Z"))).toMatchObject({ input: 2, output: 10, rule: "listed", version: "gemini-4-argon@2026-01-01" });
    expect(missionPrice("gemini-4-argon", new Date("2026-11-30T00:00:00Z"))).toMatchObject({ input: 4, output: 20, cachedInput: 0.2, rule: "higher near a change" });
    expect(missionPrice("gemini-4-argon", new Date("2026-12-01T23:59:59Z"))).toMatchObject({ input: 4, output: 20, rule: "higher near a change" });
    expect(missionPrice("gemini-4-argon", new Date("2026-12-02T00:00:00Z"))).toMatchObject({ input: 4, output: 20, rule: "listed", version: "gemini-4-argon@2026-12-01" });
    expect(missionPrice("gemini-3.8-flash", new Date("2026-12-31T12:00:00Z"))).toMatchObject({ input: 1.5, output: 7.5, rule: "higher near a change" });
    expect(missionPrice("gemini-3.8-flash", new Date("2026-12-30T23:00:00Z"))).toMatchObject({ input: 0.75, output: 3.75, rule: "listed" });
  });

  it("refuses unpriced models, and Claude before its prices were recorded", () => {
    const at = new Date("2026-11-15T12:00:00Z");
    expect(() => missionPrice("gemini-9-ultra", at)).toThrow(SpendRefused);
    expect(() => missionPrice("constructor", at)).toThrow(SpendRefused);
    expect(() => missionPrice("claude-opus-5-5", new Date("2026-10-27T12:00:00Z"))).toThrow(SpendRefused);
    expect(missionPrice("claude-opus-5-5", at)).toMatchObject({ input: 4, output: 20, maxInputTokens: 100_000 });
    expect(isMissionModel("google", "gemini-4-argon")).toBe(true);
    expect(isMissionModel("anthropic", "gemini-4-argon")).toBe(false);
    expect(isMissionModel("synthetic", "gemini-4-argon")).toBe(true);
    expect(isMissionModel("synthetic", "simulated")).toBe(false);
    expect(isMissionModel("google", "toString")).toBe(false);
  });

  it("reserves the counted input with the margin and the output limit once", () => {
    const listed = reservationFor("gemini-4-argon", { counted: 10_000, uncounted: 0 }, 20_000, new Date("2026-11-15T12:00:00Z"));
    expect(listed.inputTokens).toBe(12_012); // ceil(10,000 x 1.15) + 512
    expect(listed.micros).toBe(12_012 * 2 + 20_000 * 10);
    const december = reservationFor("gemini-4-argon", { counted: 10_000, uncounted: 300 }, 20_000, new Date("2026-12-10T12:00:00Z"));
    expect(december.inputTokens).toBe(12_357);
    expect(december.micros).toBe(12_357 * 4 + 20_000 * 20);
    const flash = reservationFor("gemini-3.8-flash", { counted: 7, uncounted: 0 }, 1, new Date("2026-11-15T12:00:00Z"));
    expect(flash.inputTokens).toBe(521);
    expect(flash.micros).toBe(395); // 521 x $0.75/M + 1 x $3.75/M = 394.5 micro-dollars, rounded up
  });

  it("refuses inputs beyond the price tier and output limits beyond 20,000", () => {
    const at = new Date("2026-11-15T12:00:00Z");
    expect(() => reservationFor("gemini-4-argon", { counted: 180_000, uncounted: 0 }, 20_000, at)).toThrow(/beyond/);
    expect(() => reservationFor("claude-haiku-5-5", { counted: 90_000, uncounted: 0 }, 20_000, at)).toThrow(/beyond/);
    expect(() => reservationFor("gemini-4-argon", { counted: 1_000, uncounted: 0 }, 20_001, at)).toThrow(SpendRefused);
    expect(() => reservationFor("gemini-4-argon", { counted: 1.5, uncounted: 0 }, 20_000, at)).toThrow(SpendRefused);
  });

  it("settles at the recorded prices, cached input, thinking and cache writes included", () => {
    const p = { input: 2, cachedInput: 0.1, output: 10 };
    expect(missionCostMicros(p, usage({ input: 10_000, cachedInput: 2_000, output: 1_000, thinking: 500 }))).toBe(31_200); // 8,000 x 2 + 2,000 x 0.1 + 1,500 x 10
    expect(missionCostMicros({ input: 0.75, cachedInput: 0.075, output: 3.75 }, usage({ input: 3, cachedInput: 1, output: 1, thinking: 0 }))).toBe(6); // 5.325, rounded up
    expect(missionCostMicros(p, usage({ input: 1_000, output: 0, thinking: 0, cacheWriteInput: 1_000 }))).toBe(4_000);
  });

  it("leaves the frozen benchmark's price functions exactly as they were", () => {
    expect(priceFor("gemini-4-argon", new Date("2026-11-30T23:00:00Z"))).toMatchObject({ input: 2, output: 10 });
    expect(worstCaseUsd("gemini-4-argon", 1_000, 1_000, new Date("2026-11-15T00:00:00Z"))).toBeCloseTo((1_000 * 2 + 2 * 1_000 * 10) / 1e6, 12);
    expect(costUsd("gemini-4-argon", usage({ input: 1_000, cachedInput: 0, output: 100, thinking: 100 }), new Date("2026-11-15T00:00:00Z"))).toBeCloseTo((1_000 * 2 + 200 * 10) / 1e6, 12);
  });
});

describe("approvals", () => {
  it("binds the owner's approval to the scope and the Boise day (criterion 5)", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const at = mst("2026-11-17T23:59:00");
    const a = await approve(w.db, w.founder, missionId, at);
    expect(a).toMatchObject({ kind: "mission", state: "active", boiseDay: "2026-11-17", expiresAt: "2026-11-18T07:00:00.000Z", maxCostMicros: 1_000_000 });
    expect(a.scopeFingerprint).toBe(await fingerprintOf(w.db, missionId));
    expect(await activeApproval(w.db, missionId, "mission", mst("2026-11-17T23:59:59"))).not.toBeNull();
    expect(await activeApproval(w.db, missionId, "mission", mst("2026-11-18T00:00:00"))).toBeNull();
  });

  it("expires at the end of the 25-hour Boise day on November 1, 2026", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const a = await approve(w.db, w.founder, missionId, new Date("2026-11-01T06:30:00Z")); // 00:30 MDT
    expect(a.expiresAt).toBe("2026-11-02T07:00:00.000Z");
    expect(await activeApproval(w.db, missionId, "mission", new Date("2026-11-02T06:59:59Z"))).not.toBeNull();
    expect(await activeApproval(w.db, missionId, "mission", new Date("2026-11-02T07:00:00Z"))).toBeNull();
  });

  it("is refused for anyone but the owner, a stale fingerprint, or the wrong state", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const fp = await fingerprintOf(w.db, missionId);
    for (const actor of [w.other, w.demo, w.client, w.builder]) {
      await expect(grantApproval(w.db, actor, { missionId, kind: "mission", seenFingerprint: fp, requestId: randomUUID(), now: T })).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(grantApproval(w.db, w.founder, { missionId, kind: "mission", seenFingerprint: "0".repeat(64), requestId: randomUUID(), now: T })).rejects.toMatchObject({ code: "conflict" });
    const draft = await insertMission(w.db, w.founder, scope(), "draft");
    await expect(approve(w.db, w.founder, draft, T)).rejects.toMatchObject({ code: "conflict" });
    expect(await w.db.select().from(missionApprovals)).toHaveLength(0);
  });

  it("acts once per request id, and keeps one open approval per mission", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const fp = await fingerprintOf(w.db, missionId);
    const requestId = randomUUID();
    const first = await grantApproval(w.db, w.founder, { missionId, kind: "mission", seenFingerprint: fp, requestId, now: T });
    const again = await grantApproval(w.db, w.founder, { missionId, kind: "mission", seenFingerprint: fp, requestId, now: T });
    expect(again.id).toBe(first.id);
    await expect(grantApproval(w.db, w.founder, { missionId, kind: "mission", seenFingerprint: fp, requestId: randomUUID(), now: T })).rejects.toMatchObject({ code: "conflict" });
    // A renewal the next day replaces the expired one.
    const renewed = await approve(w.db, w.founder, missionId, new Date(T.getTime() + 24 * 3_600_000));
    expect(renewed.id).not.toBe(first.id);
    const all = await approvalsFor(w.db, missionId);
    expect(all.map((a) => a.voidReason)).toContain("expired");
  });

  it("is void once the scope changes, and can't be used for another mission", async () => {
    const w = await world();
    const { missionId, runId } = await runningMission(w, scope(), T);
    const otherMission = await runningMission(w, scope(), T);
    // The mission's scope is edited behind the approval's back (model and fingerprint both changed).
    const edited = scope({ model: "gemini-3.8-flash" });
    await w.db.update(missions).set({ model: edited.model, scopeFingerprint: scopeFingerprint(edited) }).where(eq(missions.id, missionId));
    expect(await activeApproval(w.db, missionId, "mission", T)).toBeNull();
    const p = fakeProvider({ model: "gemini-3.8-flash" });
    expect(await refusal(meteredRequest(w.db, ctxFor({ missionId, runId }, await step(w.db, missionId), T), p, request(), signal()))).toBe("scope_changed");
    // The scope columns changed without the fingerprint: also refused.
    await w.db.update(missions).set({ maxCostMicros: 2_000_000 }).where(eq(missions.id, otherMission.missionId));
    const q = fakeProvider();
    expect(await refusal(meteredRequest(w.db, ctxFor(otherMission, await step(w.db, otherMission.missionId), T), q, request(), signal()))).toBe("scope_changed");
    expect(p.counts + p.sends + q.counts + q.sends).toBe(0);
  });

  it("is void once the owner's authority is revoked or moved", async () => {
    const w = await world();
    const { missionId } = await runningMission(w, scope(), T);
    await revokeFounder(w.db, { email: w.founder.email!, password: TEST_PASSWORD });
    expect(await activeApproval(w.db, missionId, "mission", T)).toBeNull();
    expect((await approvalsFor(w.db, missionId))[0]).toMatchObject({ state: "void", voidReason: "Owner spending authority was revoked." });
  });

  it("adds a later review on its own approval, within the mission's $2", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope({ maxCostMicros: 1_500_000 }));
    const review = { provider: "anthropic" as const, model: "claude-sonnet-5-5", maxCostMicros: 400_000 };
    await expect(approveReview(w.db, w.founder, missionId, review, T)).rejects.toMatchObject({ code: "conflict" }); // not approved yet
    await approve(w.db, w.founder, missionId, T);
    await w.db.update(missions).set({ status: "approved" }).where(eq(missions.id, missionId));
    await expect(approveReview(w.db, w.founder, missionId, { ...review, maxCostMicros: 600_000 }, T)).rejects.toMatchObject({ code: "conflict" }); // 1.5 + 0.6 > 2
    await expect(approveReview(w.db, w.founder, missionId, { ...review, provider: "simulation", model: "simulated" }, T)).rejects.toMatchObject({ code: "invalid" });
    await expect(approveReview(w.db, w.founder, missionId, { ...review, model: "claude-unknown" }, T)).rejects.toMatchObject({ code: "invalid" });
    const a = await approveReview(w.db, w.founder, missionId, review, T);
    expect(a).toMatchObject({ kind: "review", review, maxCostMicros: 400_000, state: "active" });
    expect(a.scopeFingerprint).toBe(reviewFingerprint(await fingerprintOf(w.db, missionId), review));
    expect((await missionSpend(w.db, missionId)).approvedMicros).toBe(1_900_000);
  });

  it("must fit what is left of today's $5 and this month's $20", async () => {
    const w = await world();
    const history = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
    await spend(w.db, { missionId: history.missionId, micros: 4_500_000, at: T });
    const missionId = await insertMission(w.db, w.founder, scope({ maxCostMicros: 1_000_000 }));
    await expect(approve(w.db, w.founder, missionId, T)).rejects.toThrow(/remaining AI budget is \$0\.50/);
    const small = await insertMission(w.db, w.founder, scope({ maxCostMicros: 400_000 }));
    expect((await approve(w.db, w.founder, small, T)).state).toBe("active");
  });

  it("voids open approvals on request, and the database keeps them void", async () => {
    const w = await world();
    const { missionId } = await runningMission(w, scope(), T);
    expect(await voidApprovals(w.db, missionId, "The mission's scope was edited.", T)).toBe(1);
    const [row] = await w.db.select().from(missionApprovals).where(eq(missionApprovals.missionId, missionId));
    await expect(w.db.update(missionApprovals).set({ voidedAt: null, voidReason: null }).where(eq(missionApprovals.id, row.id))).rejects.toThrow();
    await expect(w.db.update(missionApprovals).set({ maxCostMicros: 2_000_000 }).where(eq(missionApprovals.id, row.id))).rejects.toThrow();
    await expect(w.db.delete(missionApprovals).where(eq(missionApprovals.id, row.id))).rejects.toThrow();
  });
});

describe("the paid-request pathway", () => {
  it("counts, reserves, sends and settles one request (criteria 13, 14)", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const p = fakeProvider({ counted: 10_000, uncounted: 200, answer: () => reply({ usage: usage({ input: 10_150, cachedInput: 4_000, output: 2_000, thinking: 3_000 }) }) });
    const stepId = await step(w.db, m.missionId);
    const out = await meteredRequest(w.db, ctxFor(m, stepId, T), p, request(), signal());
    const reserved = 12_242 * 2 + 20_000 * 10; // ceil(10,200 x 1.15) + 512 input tokens, and the output limit once
    expect(out).toMatchObject({ countedInputTokens: 10_000, reservedInputTokens: 12_242, reservedMicros: reserved, actualMicros: 62_700 }); // 6,150 x 2 + 4,000 x 0.1 + 5,000 x 10
    const [count, req] = await rows(w, m.missionId);
    expect(count).toMatchObject({ purpose: "count", status: "settled", reservedMicros: 0, actualMicros: 0, countedInputTokens: 10_000, stepId });
    expect(req).toMatchObject({ purpose: "research", status: "settled", priceVersion: "gemini-4-argon@2026-01-01", boiseDay: "2026-11-17", boiseMonth: "2026-11", reservedMicros: reserved, committedMicros: out.actualMicros, providerRequestId: "resp-1", overReservation: false });
    expect(req.approvalId).toBe(m.approval.id);
    expect(p.counts).toBe(1);
    expect(p.sends).toBe(1);
  });

  it("sends nothing, not even a count, for an unapproved, unstarted or stale mission (criteria 3, 15)", async () => {
    const w = await world();
    const unapproved = await insertMission(w.db, w.founder, scope());
    const runId = await startRun(w.db, unapproved);
    const p = fakeProvider();
    expect(await refusal(meteredRequest(w.db, ctxFor({ missionId: unapproved, runId }, await step(w.db, unapproved), T), p, request(), signal()))).toBe("no_approval");
    const m = await runningMission(w, scope(), T);
    await w.db.update(missions).set({ status: "approved" }).where(eq(missions.id, m.missionId));
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), p, request(), signal()))).toBe("mission_not_running");
    await w.db.update(missions).set({ status: "running" }).where(eq(missions.id, m.missionId));
    expect(await refusal(meteredRequest(w.db, ctxFor({ missionId: m.missionId, runId: randomUUID() }, await step(w.db, m.missionId), T), p, request(), signal()))).toBe("stale_run");
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T, { purpose: "review" }), p, request(), signal()))).toBe("mission_not_running");
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T, { attempt: 4 }), p, request(), signal()))).toBe("attempt_limit");
    expect(p.counts + p.sends).toBe(0);
    expect(await w.db.select().from(aiUsageLedger)).toHaveLength(0);
  });

  it("stops before the next request when the approval expires mid-mission (criterion 5)", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), mst("2026-11-17T23:58:00"));
    const p = fakeProvider();
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), mst("2026-11-17T23:59:00")), p, request(), signal());
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), mst("2026-11-18T00:00:01")), p, request(), signal()))).toBe("approval_expired");
    expect(p.counts).toBe(1);
    expect(p.sends).toBe(1);
  });

  it("refuses a provider, model, kind, thinking level or output limit other than the approved ones", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const cases: [ReturnType<typeof fakeProvider>, ReturnType<typeof request>, SpendRefusalReason][] = [
      [fakeProvider({ model: "gemini-3.8-flash" }), request(), "provider_mismatch"],
      [fakeProvider({ provider: "anthropic", model: "gemini-4-argon" }), request(), "provider_mismatch"],
      [fakeProvider({ kind: "simulated" }), request(), "provider_mismatch"],
      [fakeProvider({ kind: "synthetic" }), request(), "provider_mismatch"],
      [fakeProvider({ thinkingLevel: "high" }), request(), "provider_mismatch"],
      [fakeProvider({ thinkingLevel: null }), request(), "provider_mismatch"],
      [fakeProvider(), request({ maxOutputTokens: 32_000 }), "output_limit"],
      [fakeProvider(), request({ maxOutputTokens: 8_000 }), "output_limit"],
    ];
    for (const [p, req, reason] of cases) {
      expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), p, req, signal()))).toBe(reason);
      expect(p.counts + p.sends).toBe(0);
    }
    // A simulated mission can't reach a real provider either.
    const sim = await runningMission(w, simulatedScope(), T);
    const real = fakeProvider({ provider: "simulation", model: "simulated", kind: "real", thinkingLevel: null });
    expect(await refusal(meteredRequest(w.db, ctxFor(sim, await step(w.db, sim.missionId), T), real, request(), signal()))).toBe("provider_mismatch");
    expect(real.counts + real.sends).toBe(0);
  });

  it("refuses an unpriced model and records a failed count as not sent (criterion 15)", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ model: "gemini-9-ultra" }), T);
    const p = fakeProvider({ model: "gemini-9-ultra" });
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), p, request(), signal()))).toBe("unpriced_model");
    expect(p.counts + p.sends).toBe(0);
    const n = await runningMission(w, scope(), T);
    const q = fakeProvider({ countError: () => new ProviderError("count endpoint down", "server", "yes", 503) });
    expect(await refusal(meteredRequest(w.db, ctxFor(n, await step(w.db, n.missionId), T), q, request(), signal()))).toBe("count_failed");
    expect(q.sends).toBe(0);
    const [count] = await rows(w, n.missionId);
    expect(count).toMatchObject({ purpose: "count", status: "unverified", reservedMicros: 0, errorKind: "server" });
    expect(await rows(w, n.missionId)).toHaveLength(1);
  });

  it("classifies failures: refused before processing is not billed, anything uncertain is unverified in full (criterion 14)", async () => {
    const w = await world();
    const cases: [Error, "not_billed" | "unverified"][] = [
      [new ProviderError("rate limited", "rate_limit", "yes", 429), "not_billed"],
      [new ProviderError("bad request", "invalid_request", "yes", 400), "not_billed"],
      [new ProviderError("bad key", "auth", "yes", 401), "not_billed"],
      [new ProviderError("connection refused", "network", "no"), "not_billed"],
      [new ProviderError("server error", "server", "yes", 500), "unverified"],
      [new ProviderError("timed out after sending", "timeout", "unknown"), "unverified"],
      [new ProviderError("socket hang up", "network", "unknown"), "unverified"],
      [new ProviderError("odd 429 without a refusal kind", "server", "yes", 429), "unverified"],
      [new TypeError("an adapter bug after sending"), "unverified"],
    ];
    for (const [error, outcome] of cases) {
      const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
      const p = fakeProvider({
        answer: () => {
          throw error;
        },
      });
      const e = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), p, request(), signal()).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderFailure);
      expect((e as ProviderFailure).outcome).toBe(outcome);
      const req = (await rows(w, m.missionId)).find((r) => r.purpose === "research")!;
      expect(req.status).toBe(outcome);
      expect(req.committedMicros).toBe(outcome === "not_billed" ? 0 : req.reservedMicros);
      expect(req.errorKind).not.toBeNull();
    }
  });

  it("counts a reply without usage as unverified, and an overrun settles and stops the provider", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
    const silent = fakeProvider({ answer: () => reply({ usageReported: false }) });
    const out = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), silent, request(), signal());
    expect(out.actualMicros).toBe(out.reservedMicros);
    expect((await rows(w, m.missionId)).at(-1)).toMatchObject({ status: "unverified", errorKind: "usage_not_reported" });
    // Usage "reported" as an empty object (all zeros) is no evidence either.
    const empty = fakeProvider({ answer: () => reply({ usage: usage({ input: 0, output: 0, thinking: 0 }) }) });
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), empty, request(), signal());
    expect((await rows(w, m.missionId)).at(-1)).toMatchObject({ status: "unverified", errorKind: "usage_malformed" });
    // Reported input above the reservation: settled, and Google is stopped until the owner reviews it.
    const over = fakeProvider({ counted: 1_000, answer: () => reply({ usage: usage({ input: 5_000 }) }) });
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), over, request(), signal());
    expect((await rows(w, m.missionId)).at(-1)).toMatchObject({ status: "settled", overReservation: true, errorKind: "over_reservation" });
    expect((await spendingSummary(w.db, T)).blockedProviders).toEqual(["google"]);
    const next = fakeProvider();
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), next, request(), signal()))).toBe("provider_blocked");
    expect(next.counts).toBe(0);
  });

  it("stops the provider on output above the limit and on cache writes", async () => {
    for (const u of [usage({ output: 19_000, thinking: 1_500 }), usage({ cacheWriteInput: 100 })]) {
      const w = await world();
      const m = await runningMission(w, scope(), T);
      await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider({ answer: () => reply({ usage: u }) }), request(), signal());
      expect((await spendingSummary(w.db, T)).blockedProviders).toEqual(["google"]);
    }
  });

  it("records a credential-like reply, then throws it away", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const leaky = fakeProvider({ answer: () => reply({ text: `here: AIza${"x".repeat(35)}` }) });
    const e = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), leaky, request(), signal()).catch((x) => x);
    expect(e).toBeInstanceOf(UnsafeReply);
    expect((await rows(w, m.missionId)).at(-1)).toMatchObject({ status: "settled" });
  });

  it("treats a cancelled in-flight request as unverified (criterion 20)", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const controller = new AbortController();
    const hanging = fakeProvider({
      answer: (_req, _n, s) =>
        new Promise((_, reject) => s.addEventListener("abort", () => reject(new ProviderError("Cancelled while the request was in flight.", "cancelled", "unknown")), { once: true })),
    });
    const pending = meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), hanging, request(), controller.signal).catch((x) => x);
    await vi.waitFor(() => expect(hanging.sends).toBe(1));
    controller.abort();
    const e = await pending;
    expect(e).toBeInstanceOf(ProviderFailure);
    expect((e as ProviderFailure).outcome).toBe("unverified");
    // And nothing is sent once the run is cancelled.
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), hanging, request(), controller.signal))).toBe("mission_not_running");
  });

  it("refuses to run inside a transaction", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const stepId = await step(w.db, m.missionId);
    await expect(w.db.transaction(async (tx) => meteredRequest(tx as never, ctxFor(m, stepId, T), fakeProvider(), request(), signal()))).rejects.toThrow(/inside a transaction/);
  });

  it("refuses a provider that answers without redeeming its ticket, and stops it", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const sneaky = fakeProvider({ redeem: false });
    expect(await refusal(meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), sneaky, request(), signal()))).toBe("count_failed");
    expect(sneaky.sends).toBe(0);
  });
});

describe("the caps", () => {
  it("enforce the approval's maximum and the $2 mission limit across retries (criteria 8, 12)", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ maxCostMicros: 500_000 }), T);
    const p = fakeProvider({ answer: () => reply({ usage: usage({ input: 10_000, output: 15_000, thinking: 4_000 }) }) });
    const sent: number[] = [];
    let reason: SpendRefusalReason | null = null;
    for (let attempt = 1; attempt <= 3 && !reason; attempt++) {
      try {
        sent.push((await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T, { attempt, purpose: attempt > 1 ? "retry" : "research" }), p, request(), signal())).actualMicros);
      } catch (e) {
        reason = (e as SpendRefused).reason;
      }
    }
    expect(reason).toBe("approval_cap");
    const spent = await missionSpend(w.db, m.missionId);
    expect(spent.committedMicros).toBeLessThanOrEqual(500_000);
    expect(spent.committedMicros + 224_024).toBeGreaterThan(500_000);
    // The $2 mission limit holds even when research overran its own maximum and review still fits its own.
    const review = { provider: "anthropic" as const, model: "claude-haiku-5-5", maxCostMicros: 500_000 };
    const big = await runningMission(w, scope({ maxCostMicros: 1_500_000, review }), T);
    await spend(w.db, { missionId: big.missionId, micros: 1_600_000, at: T });
    await spend(w.db, { missionId: big.missionId, micros: 395_000, at: T, purpose: "review" });
    await w.db.update(missions).set({ status: "verification" }).where(eq(missions.id, big.missionId));
    const reviewer = fakeProvider({ provider: "anthropic", model: "claude-haiku-5-5", thinkingLevel: null });
    expect(await refusal(meteredRequest(w.db, ctxFor(big, await step(w.db, big.missionId), T, { purpose: "review" }), reviewer, request(), signal()))).toBe("mission_cap");
  });

  it("enforce $5 a Boise day across missions, and a new Boise day starts fresh (criterion 9)", async () => {
    const w = await world();
    const late = mst("2026-11-17T23:50:00");
    const a = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), late);
    const b = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), late);
    const c = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), late);
    await spend(w.db, { missionId: a.missionId, micros: 1_900_000, at: late });
    await spend(w.db, { missionId: b.missionId, micros: 1_900_000, at: late });
    await spend(w.db, { missionId: c.missionId, micros: 1_000_000, at: late });
    // $4.80 committed today: the output-only pre-check ($0.20) fits, the $0.22 reservation doesn't.
    expect(await refusal(meteredRequest(w.db, ctxFor(c, await step(w.db, c.missionId), mst("2026-11-17T23:59:59")), fakeProvider(), request(), signal()))).toBe("day_cap");
    // After Boise midnight the day is new, but yesterday's approval has lapsed: renew it, then it fits.
    const morning = mst("2026-11-18T00:00:05");
    expect(await refusal(meteredRequest(w.db, ctxFor(c, await step(w.db, c.missionId), morning), fakeProvider(), request(), signal()))).toBe("approval_expired");
    await w.db.update(missions).set({ status: "interrupted" }).where(eq(missions.id, c.missionId));
    await approve(w.db, w.founder, c.missionId, morning);
    await w.db.update(missions).set({ status: "running" }).where(eq(missions.id, c.missionId));
    await meteredRequest(w.db, ctxFor(c, await step(w.db, c.missionId), morning), fakeProvider(), request(), signal());
    const s = await spendingSummary(w.db, morning);
    expect(s.day.period).toBe("2026-11-18");
    expect(s.day.committedMicros).toBeGreaterThan(0);
    expect(s.day.committedMicros).toBeLessThan(300_000);
  });

  it("enforce $20 a Boise month, and a new Boise month starts fresh (criterion 10)", async () => {
    const w = await world();
    const days = ["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12", "2026-11-16", "2026-11-20", "2026-11-24", "2026-11-27", "2026-11-28", "2026-11-29"];
    for (const d of days) {
      const at = mst(`${d}T12:00:00`);
      const m = await runningMission(w, scope({ maxCostMicros: 1_850_000 }), at);
      await spend(w.db, { missionId: m.missionId, micros: 1_810_000, at });
    }
    // Approved on November 30 while it still fits; then another mission spends the 30th's share.
    const last = await runningMission(w, scope({ maxCostMicros: 500_000 }), mst("2026-11-30T13:00:00"));
    const eleventh = await runningMission(w, scope({ maxCostMicros: 1_850_000 }), mst("2026-11-30T14:00:00"));
    await spend(w.db, { missionId: eleventh.missionId, micros: 1_810_000, at: mst("2026-11-30T14:00:00") });
    // $19.91 committed in November: refused at 23:59 on November 30, Boise time, before anything is counted.
    const end = mst("2026-11-30T23:59:00");
    expect((await spendingSummary(w.db, end)).month.committedMicros).toBe(19_910_000);
    const p = fakeProvider();
    expect(await refusal(meteredRequest(w.db, ctxFor(last, await step(w.db, last.missionId), end), p, request(), signal()))).toBe("month_cap");
    expect(p.counts).toBe(0);
    // December 1 in Boise: a new month (and the higher price applies near the change).
    const dec = mst("2026-12-01T00:00:30");
    await w.db.update(missions).set({ status: "interrupted" }).where(eq(missions.id, last.missionId));
    await approve(w.db, w.founder, last.missionId, dec);
    await w.db.update(missions).set({ status: "running" }).where(eq(missions.id, last.missionId));
    const out = await meteredRequest(w.db, ctxFor(last, await step(w.db, last.missionId), dec), fakeProvider(), request(), signal());
    const [row] = (await rows(w, last.missionId)).filter((r) => r.purpose === "research");
    expect(row).toMatchObject({ boiseMonth: "2026-12", priceVersion: "gemini-4-argon@2026-01-01..2026-12-01:higher" });
    expect(out.reservedMicros).toBe(12_012 * 4 + 20_000 * 20);
  });

  it("can't be overspent by concurrent missions (criterion 11)", async () => {
    const w = await world();
    const filler = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
    await spend(w.db, { missionId: filler.missionId, micros: 1_900_000, at: T });
    const filler2 = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
    await spend(w.db, { missionId: filler2.missionId, micros: 1_900_000, at: T });
    // $3.80 committed; $1.20 left today. Eight missions each try to reserve $0.22 at once: at most five fit.
    const ms = [];
    for (let i = 0; i < 8; i++) ms.push(await runningMission(w, scope({ maxCostMicros: 300_000 }), T));
    const slow = () =>
      fakeProvider({
        answer: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return reply({ usage: usage({ input: 10_000, output: 15_000, thinking: 4_900 }) });
        },
      });
    const results = await Promise.allSettled(ms.map(async (m) => meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), slow(), request(), signal())));
    const sentCount = results.filter((r) => r.status === "fulfilled").length;
    expect(sentCount).toBe(5);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.reason === "day_cap")).toBe(true);
    const s = await spendingSummary(w.db, T);
    expect(s.day.committedMicros).toBeLessThanOrEqual(DAY_CAP_MICROS);
  });

  it("refuses the same step's attempt twice (duplicate execution)", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const stepId = await step(w.db, m.missionId);
    const results = await Promise.allSettled([
      meteredRequest(w.db, ctxFor(m, stepId, T), fakeProvider(), request(), signal()),
      meteredRequest(w.db, ctxFor(m, stepId, T), fakeProvider(), request(), signal()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.reason).toBe("stale_run");
  });

  it("count unverified charges in full until released, and summarize them (criterion 14)", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), T);
    await spend(w.db, { missionId: m.missionId, micros: 700_000, at: T, status: "unverified" });
    await spend(w.db, { missionId: m.missionId, micros: 100_000, at: T });
    const s = await spendingSummary(w.db, T);
    expect(s.day).toMatchObject({ settledMicros: 100_000, unverifiedMicros: 700_000, committedMicros: 800_000, remainingMicros: DAY_CAP_MICROS - 800_000 });
    expect(s.month).toMatchObject({ committedMicros: 800_000, remainingMicros: MONTH_CAP_MICROS - 800_000 });
    expect(await missionSpend(w.db, m.missionId)).toMatchObject({ settledMicros: 100_000, unverifiedMicros: 700_000, committedMicros: 800_000, approvedMicros: 2_000_000, remainingMicros: 1_200_000 });
  });
});

describe("simulated and synthetic work (criterion 18)", () => {
  it("records simulated requests at $0, flagged, outside every budget", async () => {
    const w = await world();
    const m = await runningMission(w, simulatedScope(), T);
    const out = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), simulatedResearcher("company_research", redeemTicket), request(), signal());
    expect(out).toMatchObject({ reservedMicros: 0, actualMicros: 0 });
    for (const r of await rows(w, m.missionId)) expect(r).toMatchObject({ simulated: true, synthetic: false, provider: "simulation", reservedMicros: 0, committedMicros: 0 });
    expect((await spendingSummary(w.db, T)).day.committedMicros).toBe(0);
    expect(await missionSpend(w.db, m.missionId)).toMatchObject({ committedMicros: 0, approvedMicros: 0 });
  });

  it("prices synthetic usage at the real model's price, on test databases only", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ provider: "synthetic", model: "gemini-4-argon" }), T);
    const p = syntheticProvider({
      inner: simulatedResearcher("company_research", redeemTicket),
      model: "gemini-4-argon",
      plan: { count: () => 30_000, usage: () => ({ input: 30_000, output: 15_000, thinking: 0 }) },
    });
    const out = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), p, request(), signal());
    expect(out.actualMicros).toBe(30_000 * 2 + 15_000 * 10);
    const req = (await rows(w, m.missionId)).find((r) => r.purpose === "research")!;
    expect(req).toMatchObject({ synthetic: true, simulated: false, provider: "synthetic", committedMicros: 210_000 });
    expect((await spendingSummary(w.db, T)).day.committedMicros).toBe(210_000);
    expect(() => syntheticProvider({ inner: fakeProvider(), model: "gemini-4-argon" })).toThrow(/only a simulated provider/);
  });

  it("runs the simulated reviewer under a review approval in Verification", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, simulatedScope({ review: { provider: "simulation", model: "simulated", maxCostMicros: 0 } }));
    await approve(w.db, w.founder, missionId, T);
    const runId = await startRun(w.db, missionId, "verification");
    const out = await meteredRequest(w.db, ctxFor({ missionId, runId }, await step(w.db, missionId), T, { purpose: "review" }), simulatedReviewer(redeemTicket), request(), signal());
    expect(out.actualMicros).toBe(0);
  });
});

describe("recovery", () => {
  it("marks another backend's open reservations unverified at full, and leaves this one's alone (criteria 14, 21)", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    const hanging = fakeProvider({ answer: (_r, _n, s) => new Promise((_, reject) => s.addEventListener("abort", () => reject(new ProviderError("lost", "network", "unknown")), { once: true })) });
    const controller = new AbortController();
    const pending = meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), hanging, request(), controller.signal).catch((x) => x);
    await vi.waitFor(() => expect(hanging.sends).toBe(1));
    expect(await markOpenReservationsUnverified(w.db, "The backend stopped.", T)).toBe(0);
    // The backend "restarts": a new process id, and the old reservation is still open.
    const before = globalThis.__kelqorBackendInstance;
    globalThis.__kelqorBackendInstance = randomUUID();
    try {
      expect(await markOpenReservationsUnverified(w.db, "The backend stopped while this request was in flight.", T)).toBe(1);
    } finally {
      globalThis.__kelqorBackendInstance = before;
    }
    const row = (await rows(w, m.missionId)).find((r) => r.purpose === "research")!;
    expect(row).toMatchObject({ status: "unverified", errorKind: "interrupted", committedMicros: row.reservedMicros });
    controller.abort();
    expect(await pending).toBeInstanceOf(ProviderFailure);
    // The late failure doesn't rewrite what recovery recorded.
    expect((await rows(w, m.missionId)).find((r) => r.purpose === "research")).toMatchObject({ status: "unverified", errorKind: "interrupted" });
  });
});

describe("the ledger's own rules (drizzle/0005)", () => {
  it("never deletes or rewrites an entry", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider(), request(), signal());
    const [, req] = await rows(w, m.missionId);
    const id = req.id;
    await expect(w.db.delete(aiUsageLedger).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    await expect(w.db.execute(sql`truncate ai_usage_ledger`)).rejects.toThrow();
    await expect(w.db.update(aiUsageLedger).set({ reservedMicros: 1 }).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    await expect(w.db.update(aiUsageLedger).set({ actualMicros: 1 }).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    await expect(w.db.update(aiUsageLedger).set({ status: "not_billed" }).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    await expect(w.db.update(aiUsageLedger).set({ simulated: true }).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    expect(await rows(w, m.missionId)).toHaveLength(2);
  });

  it("refuses impossible entries and missions", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider(), request(), signal());
    const settled = (await rows(w, m.missionId)).find((r) => r.purpose === "research")!;
    const { seq: _seq, committedMicros: _committed, ...base } = settled;
    const bad = (over: Record<string, unknown>) => w.db.insert(aiUsageLedger).values({ ...base, id: randomUUID(), ...over } as never);
    const stepFor = async () => ({ stepId: await step(w.db, m.missionId) });
    await bad(await stepFor()); // the valid shape itself is accepted
    await expect(bad({ ...(await stepFor()), status: "unverified", errorKind: null, settledAt: T, purpose: "research" })).rejects.toThrow(); // unverified without a reason
    await expect(bad({ ...(await stepFor()), simulated: true, purpose: "research" })).rejects.toThrow(); // simulated from google
    await expect(bad({ ...(await stepFor()), purpose: "research", reservedMicros: -1 })).rejects.toThrow();
    await expect(bad({ ...(await stepFor()), purpose: "research", attempt: 4 })).rejects.toThrow();
    await expect(bad({ ...(await stepFor()), purpose: "research", status: "settled", actualMicros: null })).rejects.toThrow();
    await expect(bad({ ...(await stepFor()), purpose: "research", approvalId: null })).rejects.toThrow();
    await expect(bad({ ...(await stepFor()), purpose: "research", boiseMonth: "2026-12" })).rejects.toThrow();
    // Missions: a simulated one on a real provider, a real one with the $0 reviewer, a maximum above $2.
    const insert = (over: Record<string, unknown>) =>
      w.db.insert(missions).values({ id: randomUUID(), type: "company_research", subject: scope().subject, title: "x", protocol: "p", provider: "google", model: "gemini-4-argon", thinkingLevel: "medium", maxOutputTokens: 20_000, maxCostMicros: 1_000_000, scopeFingerprint: "f", createdById: w.founder.id!, ...over } as never);
    await expect(insert({ simulated: true })).rejects.toThrow();
    await expect(insert({ review: { provider: "simulation", model: "simulated", maxCostMicros: 0 } })).rejects.toThrow();
    await expect(insert({ maxCostMicros: 1_500_000, review: { provider: "anthropic", model: "claude-opus-5-5", maxCostMicros: 600_000 } })).rejects.toThrow();
    await expect(insert({ maxOutputTokens: 32_000 })).rejects.toThrow();
    await expect(insert({ status: "running" })).rejects.toThrow(); // running without a run id
    await expect(insert({ status: "completed", workingState: { turns: [] } })).rejects.toThrow(); // page text after the end
    await expect(insert({ status: "runing" })).rejects.toThrow();
  });

  it("keeps approvals to one Boise day at most", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const a = await approve(w.db, w.founder, missionId, T);
    await expect(
      w.db.insert(missionApprovals).values({
        id: randomUUID(),
        missionId,
        kind: "mission",
        scopeFingerprint: a.scopeFingerprint,
        maxCostMicros: 1_000_000,
        approvedById: w.founder.id!,
        approvedAt: T,
        expiresAt: new Date(T.getTime() + 26 * 3_600_000),
        boiseDay: "2026-11-17",
        authorityGrantedAt: T,
        requestId: randomUUID(),
        voidedAt: T,
        voidReason: "test",
      }),
    ).rejects.toThrow();
  });
});

describe("ledger views", () => {
  it("lists entries with their filters and mission numbers", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider(), request(), signal());
    const all = await ledgerEntries(w.db, { missionId: m.missionId });
    expect(all.map((e) => e.purpose)).toEqual(["research", "count"]);
    expect(all[0]).toMatchObject({ provider: "google", status: "settled", boiseDay: "2026-11-17", simulated: false, synthetic: false });
    expect(all[0].missionNumber).toBeGreaterThan(0);
    expect(await ledgerEntries(w.db, { status: "unverified" })).toHaveLength(0);
    expect(await ledgerEntries(w.db, { boiseDay: "2026-11-18" })).toHaveLength(0);
    const [count] = await w.db.select().from(aiUsageLedger).where(and(eq(aiUsageLedger.missionId, m.missionId), eq(aiUsageLedger.purpose, "count")));
    expect(count.committedMicros).toBe(0);
  });
});

describe("reconciliation (criterion 17)", () => {
  // Reconciliation reads the real clock and refuses periods that haven't happened, so its history is in the past.
  const PAST = mdt("2026-10-20T15:00:00");
  const DAY = "2026-10-20";

  async function history(w: World, settled: number, unverified: number) {
    const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }), PAST);
    if (settled) await spend(w.db, { missionId: m.missionId, micros: settled, at: PAST });
    const unverifiedId = unverified ? await spend(w.db, { missionId: m.missionId, micros: unverified, at: PAST, status: "unverified" }) : null;
    return { m, unverifiedId };
  }

  it("releases only against the owner's figure and note, never below the settled total", async () => {
    const w = await world();
    const { unverifiedId } = await history(w, 300_000, 700_000);
    const figure = { provider: "google" as const, periodKind: "day" as const, period: DAY, providerMicros: 500_000, note: "Google Cloud console, Billing > Reports, read 2026-10-22" };
    await expect(recordProviderFigure(w.db, w.other, figure)).rejects.toMatchObject({ code: "forbidden" });
    await expect(recordProviderFigure(w.db, w.demo, figure)).rejects.toMatchObject({ code: "forbidden" });
    await expect(recordProviderFigure(w.db, w.founder, { ...figure, note: " " })).rejects.toMatchObject({ code: "invalid" });
    await expect(recordProviderFigure(w.db, w.founder, { ...figure, period: "2099-01-01" })).rejects.toMatchObject({ code: "invalid" });
    const v = await recordProviderFigure(w.db, w.founder, figure);
    expect(v).toMatchObject({ settledMicros: 300_000, unverifiedMicros: 700_000, adjustmentMicros: 0 });
    expect(v.figures[0]).toMatchObject({ providerMicros: 500_000, differenceMicros: -500_000 });
    const figureId = v.figures[0].id;
    // At most down to the provider's $0.50: $0.50 of the $0.70 unverified.
    await expect(releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 600_000 }], note: "Console shows $0.50" })).rejects.toMatchObject({ code: "conflict" });
    await expect(releaseUnverified(w.db, w.other, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 100_000 }], note: "Console shows $0.50" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 100_000 }], note: "" })).rejects.toMatchObject({ code: "invalid" });
    const after = await releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 500_000 }], note: "Console shows $0.50 for the day" });
    expect(after).toMatchObject({ settledMicros: 300_000, unverifiedMicros: 200_000, releasedMicros: 500_000 });
    expect(after.history.map((h) => h.kind).sort()).toEqual(["figure", "release"]);
    await expect(releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 1 }], note: "one more micro" })).rejects.toMatchObject({ code: "conflict" });
    // A later, lower figure releases the rest down to the settled $0.30, never further; the older figure no longer can.
    const lower = await recordProviderFigure(w.db, w.founder, { ...figure, providerMicros: 100_000, note: "Console after its corrections" });
    const lowerId = lower.figures.find((f) => f.providerMicros === 100_000)!.id;
    await expect(releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: unverifiedId!, micros: 100_000 }], note: "against the old figure" })).rejects.toMatchObject({ code: "conflict" });
    await expect(releaseUnverified(w.db, w.founder, { figureId: lowerId, entries: [{ ledgerId: unverifiedId!, micros: 200_001 }], note: "beyond what is unverified" })).rejects.toMatchObject({ code: "conflict" });
    const final = await releaseUnverified(w.db, w.founder, { figureId: lowerId, entries: [{ ledgerId: unverifiedId!, micros: 200_000 }], note: "Down to the settled total" });
    expect(final).toMatchObject({ settledMicros: 300_000, unverifiedMicros: 0, releasedMicros: 700_000 });
    const [row] = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.id, unverifiedId!));
    expect(row).toMatchObject({ status: "unverified", releasedMicros: 700_000, committedMicros: 0 });
    await expect(w.db.update(aiUsageLedger).set({ releasedMicros: 0 }).where(eq(aiUsageLedger.id, unverifiedId!))).rejects.toThrow();
  });

  it("records an adjustment when the provider shows more, which counts against the caps until released", async () => {
    const w = await world();
    await history(w, 300_000, 0);
    const base = { provider: "google" as const, periodKind: "day" as const, period: DAY, note: "Google Cloud console, Billing > Reports" };
    const before = await spendingSummary(w.db);
    const v = await recordProviderFigure(w.db, w.founder, { ...base, providerMicros: 800_000 });
    expect(v).toMatchObject({ settledMicros: 300_000, adjustmentMicros: 500_000 });
    expect(v.unverified).toHaveLength(1);
    expect(v.unverified[0]).toMatchObject({ purpose: "adjustment", status: "unverified", reservedMicros: 500_000, missionId: null });
    const now = await spendingSummary(w.db);
    expect(now.day.committedMicros - before.day.committedMicros).toBe(500_000); // dated when recorded
    // A higher figure later adds only the new difference; a lower one lets the adjustment be released, down to it.
    expect((await recordProviderFigure(w.db, w.founder, { ...base, providerMicros: 900_000 })).adjustmentMicros).toBe(600_000);
    const lower = await recordProviderFigure(w.db, w.founder, { ...base, providerMicros: 350_000 });
    const figureId = lower.figures.find((f) => f.providerMicros === 350_000)!.id;
    const adjustments = lower.unverified.filter((u) => u.purpose === "adjustment");
    expect(adjustments.reduce((s, a) => s + a.committedMicros, 0)).toBe(600_000);
    await expect(
      releaseUnverified(w.db, w.founder, { figureId, entries: adjustments.map((a) => ({ ledgerId: a.id, micros: a.committedMicros })), note: "All of it would go below the figure" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const first = adjustments.find((a) => a.committedMicros === 500_000)!;
    const released = await releaseUnverified(w.db, w.founder, { figureId, entries: [{ ledgerId: first.id, micros: 500_000 }], note: "The console's corrected figure" });
    expect(released.adjustmentMicros).toBe(100_000);
  });

  it("waits for requests in flight before reconciling their period", async () => {
    const w = await world();
    const { m } = await history(w, 300_000, 0);
    await spend(w.db, { missionId: m.missionId, micros: 220_000, at: PAST, status: "reserved" });
    await expect(recordProviderFigure(w.db, w.founder, { provider: "google", periodKind: "day", period: DAY, providerMicros: 300_000, note: "Console" })).rejects.toMatchObject({ code: "conflict" });
    const month = await recordProviderFigure(w.db, w.founder, { provider: "anthropic", periodKind: "month", period: "2026-10", providerMicros: 0, note: "Anthropic console" });
    expect(month).toMatchObject({ settledMicros: 0, unverifiedMicros: 0 });
  });

  it("unblocks a provider after the owner reviews its overrun", async () => {
    const w = await world();
    const m = await runningMission(w, scope(), T);
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider({ counted: 1_000, answer: () => reply({ usage: usage({ input: 9_000 }) }) }), request(), signal());
    expect((await spendingSummary(w.db, T)).blockedProviders).toEqual(["google"]);
    await expect(unblockProvider(w.db, w.other, { provider: "google", note: "Reviewed" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(unblockProvider(w.db, w.founder, { provider: "google", note: "" })).rejects.toMatchObject({ code: "invalid" });
    const s = await unblockProvider(w.db, w.founder, { provider: "google", note: "Reviewed: the counter undercounted the schema" });
    expect(s.blockedProviders).toEqual([]);
    await expect(unblockProvider(w.db, w.founder, { provider: "google", note: "Again" })).rejects.toMatchObject({ code: "conflict" });
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), T), fakeProvider(), request(), signal());
  });

  it("keeps every reconciliation record", async () => {
    const w = await world();
    await history(w, 100_000, 0);
    await recordProviderFigure(w.db, w.founder, { provider: "google", periodKind: "day", period: DAY, providerMicros: 100_000, note: "Console" });
    await expect(w.db.update(spendingReconciliations).set({ note: "changed" })).rejects.toThrow();
    await expect(w.db.delete(spendingReconciliations)).rejects.toThrow();
  });
});
