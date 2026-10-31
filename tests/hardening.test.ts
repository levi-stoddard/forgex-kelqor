// Regression tests for the issues found in the independent security review (2026-10-26).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actor";
import { getPublicRecord, reviewBuilder } from "@/lib/domain/builders";
import {
  acceptQuote,
  createWorkOrder,
  EXTRA_PAYMENT_NOTE,
  getOrderView,
  inviteBuilder,
  markStripeSession,
  recordPayment,
  recordPendingStripePayment,
  requestQuoteChanges,
  respondToAssignment,
  reviewDelivery,
  sendQuote,
  submitDelivery,
  submitReview,
} from "@/lib/domain/orders";
import { safeNext } from "@/lib/safe-next";
import { freshDb, SAMPLE_INTAKE, seedParties } from "./helpers";

process.env.ALLOW_TEST_PAYMENTS = "true";
delete process.env.ANTHROPIC_API_KEY;

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

async function quoted(price = 400_000, payout = 260_000) {
  const o = await createWorkOrder(h.db, client, SAMPLE_INTAKE);
  await sendQuote(h.db, operator, o.id, { priceCents: price, builderPayoutCents: payout, carePriceCents: null });
  return o.id;
}

describe("safe redirects after sign-in", () => {
  it("rejects off-site, control-character and backslash tricks", () => {
    expect(safeNext("/\t/evil.example")).toBe("/dashboard");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("/orders/new?template=reporting")).toBe("/orders/new?template=reporting");
  });
});

describe("re-quotes and builder status", () => {
  it("withdraws stale invitations and assignments when the client asks for changes", async () => {
    const id = await quoted();
    const assignmentId = await inviteBuilder(h.db, operator, id, { builderId: builder.builderId! });
    await requestQuoteChanges(h.db, client, id, "Please drop the SMS part.");
    await expect(respondToAssignment(h.db, builder, assignmentId, true)).rejects.toThrow(/no longer open/);
    await expect(getOrderView(h.db, builder, id)).rejects.toThrow(/not found/);
  });

  it("unassigns an accepted builder when the scope changes before work starts", async () => {
    const id = await quoted();
    const assignmentId = await inviteBuilder(h.db, operator, id, { builderId: builder.builderId! });
    await respondToAssignment(h.db, builder, assignmentId, true);
    const changed = await requestQuoteChanges(h.db, client, id, "Add a second inbox.");
    expect(changed.assignedBuilderId).toBeNull();
  });

  it("withdraws invitations from a paused builder, who can no longer read or accept them", async () => {
    const id = await quoted();
    const assignmentId = await inviteBuilder(h.db, operator, id, { builderId: builder.builderId! });
    await reviewBuilder(h.db, operator, builder.builderId!, { status: "paused", identityVerified: true, notes: "test" });
    await expect(getOrderView(h.db, builder, id)).rejects.toThrow(/not found/);
    await expect(respondToAssignment(h.db, builder, assignmentId, true)).rejects.toThrow(/no longer open/);
    await reviewBuilder(h.db, operator, builder.builderId!, { status: "approved", identityVerified: true, notes: "restored" });
  });
});

describe("Stripe sessions", () => {
  it("settles the pending row for a session instead of adding a second row", async () => {
    const id = await quoted();
    await acceptQuote(h.db, client, id, true);
    await recordPendingStripePayment(h.db, client, id, { sessionId: "cs_pending_1", amountCents: 400_000 });
    await recordPayment(h.db, SYSTEM_ACTOR, id, { method: "stripe", stripeSessionId: "cs_pending_1", amountCents: 400_000 });
    const rows = await h.db.select().from(payments).where(eq(payments.workOrderId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
  });

  it("keeps a wrong-amount payment and flags it for refund rather than rejecting it", async () => {
    const id = await quoted();
    await acceptQuote(h.db, client, id, true);
    const o = await recordPayment(h.db, SYSTEM_ACTOR, id, { method: "stripe", stripeSessionId: "cs_wrong_amount", amountCents: 1_000 });
    expect(o.status).toBe("accepted");
    const [row] = await h.db.select().from(payments).where(eq(payments.stripeSessionId, "cs_wrong_amount"));
    expect(row.reference).toBe(EXTRA_PAYMENT_NOTE);
  });

  it("marks expired or failed sessions so the client can pay again", async () => {
    const id = await quoted();
    await acceptQuote(h.db, client, id, true);
    await recordPendingStripePayment(h.db, client, id, { sessionId: "cs_expired", amountCents: 400_000 });
    await markStripeSession(h.db, "cs_expired", "failed", "Checkout expired before payment.");
    const [row] = await h.db.select().from(payments).where(eq(payments.stripeSessionId, "cs_expired"));
    expect(row.status).toBe("failed");
    expect((await getOrderView(h.db, client, id)).permissions.pay).toBe(true);
  });
});

describe("public records", () => {
  it("leaves private reviews out of the public average", async () => {
    const id = await quoted();
    await acceptQuote(h.db, client, id, true);
    await recordPayment(h.db, SYSTEM_ACTOR, id, { method: "test" });
    const assignmentId = await inviteBuilder(h.db, operator, id, { builderId: builder.builderId! });
    await respondToAssignment(h.db, builder, assignmentId, true);
    const view = await getOrderView(h.db, builder, id);
    await submitDelivery(h.db, builder, id, { summary: "Delivered and tested.", links: [], evidence: Object.fromEntries(view.criteria.map((c) => [c.id, "ok"])) });
    await reviewDelivery(h.db, client, id, { decisions: Object.fromEntries(view.criteria.map((c) => [c.id, "met"])), notes: {}, note: "" });
    await submitReview(h.db, client, id, { rating: 2, comment: "private", visibility: "private" });
    const record = await getPublicRecord(h.db, view.assignedBuilder!.slug);
    expect(record!.stats.avgRating).toBeNull();
    expect(record!.records).toHaveLength(0);
  });

  it("hides the client budget from builders", async () => {
    // Enforced in the page (RequestSummary showBudget); the view still returns the intake for clients.
    const id = await quoted();
    const v = await getOrderView(h.db, client, id);
    expect(v.order.intake.budgetBand).toBe(SAMPLE_INTAKE.budgetBand);
  });
});
