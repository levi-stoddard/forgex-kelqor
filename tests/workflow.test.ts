import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/lib/db";
import { outbox, payouts } from "@/lib/db/schema";
import { authenticate, registerClient } from "@/lib/domain/accounts";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actor";
import { getPublicRecord, reviewBuilder } from "@/lib/domain/builders";
import { DomainError } from "@/lib/domain/errors";
import { computeMetrics } from "@/lib/domain/metrics";
import {
  acceptQuote,
  cancelOrder,
  createWorkOrder,
  getOrderView,
  inviteBuilder,
  listOrders,
  markPayoutPaid,
  openDispute,
  postMessage,
  recordPayment,
  recordRefund,
  requestCarePlan,
  resolveDispute,
  respondToAssignment,
  reviewDelivery,
  sendQuote,
  setCarePlanStatus,
  submitDelivery,
  submitReview,
} from "@/lib/domain/orders";
import { actorFor, freshDb, SAMPLE_INTAKE, seedParties, TEST_PASSWORD } from "./helpers";

process.env.ALLOW_TEST_PAYMENTS = "true";
delete process.env.ANTHROPIC_API_KEY; // tests always use the deterministic template scoper

let h: DbHandle;
let operator: Actor;
let client: Actor;
let builder: Actor;

beforeAll(async () => {
  h = await freshDb();
  ({ operator, client, builder } = await seedParties(h.db));
});
afterAll(async () => {
  await h.close();
});

const evidenceFor = (criteria: { id: string }[]) => Object.fromEntries(criteria.map((c) => [c.id, `Tested: see recording for ${c.id}`]));

describe("a Work Order from request to paid-out, reviewed record", () => {
  let orderId: string;

  it("creates the request with a draft scope and acceptance criteria", async () => {
    const o = await createWorkOrder(h.db, client, SAMPLE_INTAKE);
    orderId = o.id;
    expect(o.status).toBe("submitted");
    expect(o.scopeSource).toBe("template");
    const view = await getOrderView(h.db, client, o.id);
    expect(view.criteria.length).toBeGreaterThan(0);
    const notices = await h.db.select().from(outbox).where(eq(outbox.toEmail, "ops@test.local"));
    expect(notices.some((n) => n.subject.startsWith("New request"))).toBe(true);
  });

  it("refuses to let the client accept before a quote exists", async () => {
    await expect(acceptQuote(h.db, client, orderId, true)).rejects.toBeInstanceOf(DomainError);
  });

  it("quotes, accepts, funds with a TEST payment and staffs the order", async () => {
    await sendQuote(h.db, operator, orderId, { priceCents: 435_000, builderPayoutCents: 280_000, carePriceCents: 29_900 });
    await expect(acceptQuote(h.db, client, orderId, false)).rejects.toThrow(/agree/);
    await acceptQuote(h.db, client, orderId, true);
    await expect(recordPayment(h.db, client, orderId, { method: "test" })).rejects.toThrow(/permission/);
    await expect(recordPayment(h.db, SYSTEM_ACTOR, orderId, { method: "test", amountCents: 1_000 })).rejects.toThrow(/match/);
    const funded = await recordPayment(h.db, SYSTEM_ACTOR, orderId, { method: "test" });
    expect(funded.status).toBe("funded");

    const assignmentId = await inviteBuilder(h.db, operator, orderId, { builderId: builder.builderId! });
    const started = await respondToAssignment(h.db, builder, assignmentId, true);
    expect(started.status).toBe("in_progress");
  });

  it("keeps prices and payouts separated by role", async () => {
    const asBuilder = await getOrderView(h.db, builder, orderId);
    expect(asBuilder.order.priceCents).toBeNull();
    expect(asBuilder.order.builderPayoutCents).toBe(280_000);
    const asClient = await getOrderView(h.db, client, orderId);
    expect(asClient.order.priceCents).toBe(435_000);
    expect(asClient.order.builderPayoutCents).toBeNull();
    const builderList = await listOrders(h.db, builder);
    expect(builderList[0].priceCents).toBeNull();
  });

  it("hides the order from another company", async () => {
    const other = await registerClient(h.db, { name: "Mallory", email: "mallory@other.test", password: TEST_PASSWORD, companyName: "Other Co" });
    const mallory = await actorFor(h.db, other.userId);
    await expect(getOrderView(h.db, mallory, orderId)).rejects.toThrow(/not found/);
    await expect(postMessage(h.db, mallory, orderId, "hello")).rejects.toThrow(/not found/);
    expect(await listOrders(h.db, mallory)).toEqual([]);
  });

  it("requires evidence for every criterion, then supports a revision round", async () => {
    const view = await getOrderView(h.db, builder, orderId);
    await expect(
      submitDelivery(h.db, builder, orderId, { summary: "Everything is done.", links: [], evidence: {} }),
    ).rejects.toThrow(/evidence/);
    await expect(
      submitDelivery(h.db, builder, orderId, { summary: "Everything is done.", links: ["javascript:alert(1)"], evidence: evidenceFor(view.criteria) }),
    ).rejects.toThrow(/valid/);
    await submitDelivery(h.db, builder, orderId, { summary: "Lead capture and routing live.", links: ["https://loom.example/demo"], evidence: evidenceFor(view.criteria) });

    const decisions = Object.fromEntries(view.criteria.map((c, i) => [c.id, i === 0 ? "not_met" : "met"]));
    await expect(reviewDelivery(h.db, client, orderId, { decisions, notes: {}, note: "" })).rejects.toThrow(/missing/);
    const revised = await reviewDelivery(h.db, client, orderId, { decisions, notes: { [view.criteria[0].id]: "The web form lead took 6 minutes." }, note: "" });
    expect(revised.status).toBe("in_progress");
    expect(revised.revisionCount).toBe(1);
  });

  it("completes on full acceptance and queues exactly one payout", async () => {
    const view = await getOrderView(h.db, builder, orderId);
    await submitDelivery(h.db, builder, orderId, { summary: "Fixed the web form delay.", links: [], evidence: evidenceFor(view.criteria) });
    const decisions = Object.fromEntries(view.criteria.map((c) => [c.id, "met"]));
    const done = await reviewDelivery(h.db, client, orderId, { decisions, notes: {}, note: "Works great." });
    expect(done.status).toBe("completed");
    const pays = await h.db.select().from(payouts).where(eq(payouts.workOrderId, orderId));
    expect(pays).toHaveLength(1);
    expect(pays[0].amountCents).toBe(280_000);
    await markPayoutPaid(h.db, operator, pays[0].id, { method: "ACH", reference: "ACH-0001" });
    await expect(markPayoutPaid(h.db, operator, pays[0].id, { method: "ACH", reference: "ACH-0001" })).rejects.toThrow(/already/);
  });

  it("publishes the verified record only with the client's permission", async () => {
    const slug = (await getOrderView(h.db, client, orderId)).assignedBuilder!.slug;
    expect((await getPublicRecord(h.db, slug))!.records).toHaveLength(0);
    await submitReview(h.db, client, orderId, { rating: 5, comment: "Fast and clear.", visibility: "public_anonymous" });
    const record = await getPublicRecord(h.db, slug);
    expect(record!.records).toHaveLength(1);
    expect(record!.records[0].client).toContain("business");
    expect(record!.records[0].client).not.toContain("Acme");
    expect(record!.records[0].testData).toBe(true); // funded by a TEST payment, so labeled as test data
    expect(record!.stats.firstPassRate).toBe(0);
  });

  it("starts and activates Care, but a plan on a TEST-funded order is never real MRR", async () => {
    await requestCarePlan(h.db, client, orderId);
    const view = await getOrderView(h.db, operator, orderId);
    await setCarePlanStatus(h.db, operator, view.carePlan!.id, "active");
    const m = await computeMetrics(h.db);
    // This order was paid with a TEST payment, so its monthly plan is reported apart, not as revenue.
    expect(m.care.mrrCents).toBe(0);
    expect(m.care.activeCount).toBe(0);
    expect(m.care.testMrrCents).toBe(29_900);
    expect(m.care.testActiveCount).toBe(1);
  });

  it("never counts TEST payments as revenue", async () => {
    const m = await computeMetrics(h.db);
    expect(m.cash.collectedCents).toBe(0);
    expect(m.cash.testCollectedCents).toBe(435_000);
    expect(m.grossMarginCents).toBe(0);
    expect(m.funnel.completed).toBe(1);
    // A payout on a TEST-funded order is not real money owed or paid.
    expect(m.payouts.paidCents).toBe(0);
    expect(m.payouts.pendingCents).toBe(0);
  });
});

describe("offline payments, disputes, cancellation and refunds", () => {
  it("records a bank transfer, resolves a dispute and refunds on cancellation", async () => {
    const o = await createWorkOrder(h.db, client, { ...SAMPLE_INTAKE, templateSlug: "reporting" });
    await sendQuote(h.db, operator, o.id, { priceCents: 300_000, builderPayoutCents: 195_000, carePriceCents: null });
    await acceptQuote(h.db, client, o.id, true);
    await expect(recordPayment(h.db, operator, o.id, { method: "offline" })).rejects.toThrow(/reference/);
    await recordPayment(h.db, operator, o.id, { method: "offline", reference: "WIRE-778" });
    await expect(cancelOrder(h.db, client, o.id, "changed our mind")).rejects.toThrow();

    const assignmentId = await inviteBuilder(h.db, operator, o.id, { builderId: builder.builderId! });
    await respondToAssignment(h.db, builder, assignmentId, true);
    await openDispute(h.db, client, o.id, "The builder has not responded for a week.");
    const resumed = await resolveDispute(h.db, operator, o.id, "continue", "Builder confirmed a new delivery date.");
    expect(resumed.status).toBe("in_progress");

    const cancelled = await cancelOrder(h.db, operator, o.id, "Client and ForgeX agreed to stop.");
    expect(cancelled.status).toBe("cancelled");
    const view = await getOrderView(h.db, operator, o.id);
    await recordRefund(h.db, operator, view.payments[0].id, "REF-1");
    const m = await computeMetrics(h.db);
    expect(m.cash.collectedCents).toBe(0); // refunded payments are no longer counted as collected
    expect(m.cash.refundedCents).toBe(300_000);
  });

  it("records an extra Stripe payment instead of losing it, and lets ForgeX refund it", async () => {
    const o = await createWorkOrder(h.db, client, SAMPLE_INTAKE);
    await sendQuote(h.db, operator, o.id, { priceCents: 300_000, builderPayoutCents: 195_000, carePriceCents: null });
    await acceptQuote(h.db, client, o.id, true);
    await recordPayment(h.db, SYSTEM_ACTOR, o.id, { method: "stripe", stripeSessionId: "cs_test_first", amountCents: 300_000 });
    // Same session reported twice (webhook + redirect): recorded once.
    await recordPayment(h.db, SYSTEM_ACTOR, o.id, { method: "stripe", stripeSessionId: "cs_test_first", amountCents: 300_000 });
    // A second checkout tab paid too: kept and flagged, not dropped.
    await recordPayment(h.db, SYSTEM_ACTOR, o.id, { method: "stripe", stripeSessionId: "cs_test_second", amountCents: 300_000 });
    const view = await getOrderView(h.db, operator, o.id);
    expect(view.payments.filter((p) => p.status === "succeeded")).toHaveLength(2);
    const extra = view.payments.find((p) => p.stripeSessionId === "cs_test_second")!;
    await recordRefund(h.db, operator, extra.id, "re_test_1");
    const sole = view.payments.find((p) => p.stripeSessionId === "cs_test_first")!;
    await expect(recordRefund(h.db, operator, sole.id, "re_test_2")).rejects.toThrow(/only payment/);
  });

  it("rejects suspended builders and bad credentials", async () => {
    await reviewBuilder(h.db, operator, builder.builderId!, { status: "paused", identityVerified: true, notes: "Paused for testing" });
    const o = await createWorkOrder(h.db, client, SAMPLE_INTAKE);
    await sendQuote(h.db, operator, o.id, { priceCents: 300_000, builderPayoutCents: 195_000, carePriceCents: null });
    await expect(inviteBuilder(h.db, operator, o.id, { builderId: builder.builderId! })).rejects.toThrow(/approved/);
    await expect(reviewBuilder(h.db, operator, builder.builderId!, { status: "approved", identityVerified: false, notes: "" })).rejects.toThrow(/identity/);
    await expect(authenticate(h.db, "casey@acme.test", "wrong-password")).rejects.toThrow(/match/);
    expect(await authenticate(h.db, " Casey@Acme.test ", TEST_PASSWORD)).toBe(client.id);
  });
});
