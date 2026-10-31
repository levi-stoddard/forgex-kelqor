// Owner-led selling: operator-written Work Orders, one-time client links, setup + monthly, in-house delivery.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/lib/db";
import { carePlans, invites, payouts } from "@/lib/db/schema";
import { authenticate } from "@/lib/domain/accounts";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actor";
import { acceptInvite, createClientForSale, findInvite, issueInvite, PENDING_PASSWORD } from "@/lib/domain/invites";
import {
  acceptQuote,
  createWorkOrder,
  getOrderView,
  inviteBuilder,
  recordPayment,
  respondToAssignment,
  reviewDelivery,
  sendQuote,
  submitDelivery,
} from "@/lib/domain/orders";
import { actorFor, freshDb, SAMPLE_INTAKE, seedParties } from "./helpers";

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

const NEW_PASSWORD = "a-new-password-456";
const LEAK_CHECK = { ...SAMPLE_INTAKE, templateSlug: "revenue-leak-check" };

async function sale(email: string) {
  const { orgId, userId } = await createClientForSale(h.db, operator, { companyName: "Northside Plumbing", contactName: "Nora North", email, dataClass: "real" });
  const order = await createWorkOrder(h.db, operator, LEAK_CHECK, { orgId });
  const token = await issueInvite(h.db, operator, { userId, workOrderId: order.id });
  return { userId, order, token };
}

describe("operator-written Work Orders", () => {
  it("lets only operators write up a sale, and only for a company that exists", async () => {
    await expect(createClientForSale(h.db, client, { companyName: "X Co", contactName: "Xavier", email: "x@x.test", dataClass: "real" })).rejects.toThrow(/permission/);
    await expect(createWorkOrder(h.db, operator, LEAK_CHECK)).rejects.toThrow(/client company/);
    await expect(createWorkOrder(h.db, operator, LEAK_CHECK, { orgId: "no-such-org" })).rejects.toThrow(/not found/);
    await expect(
      createClientForSale(h.db, operator, { companyName: "Acme Again", contactName: "Casey", email: "CASEY@acme.test", dataClass: "real" }),
    ).rejects.toThrow(/already has/);
  });

  it("ignores an orgId from a client: their own company always owns the request", async () => {
    const own = await createWorkOrder(h.db, client, LEAK_CHECK, { orgId: "someone-else" });
    expect(own.orgId).toBe(client.orgId);
  });
});

describe("one-time client links", () => {
  it("turns a link into a working sign-in that opens the Work Order, once", async () => {
    const { userId, order, token } = await sale("nora@northside.test");
    await expect(authenticate(h.db, "nora@northside.test", PENDING_PASSWORD)).rejects.toThrow(/don't match/);
    expect((await findInvite(h.db, token))?.orgName).toBe("Northside Plumbing");
    await expect(acceptInvite(h.db, token, { name: "Nora North", password: "short" })).rejects.toThrow(/10 characters/);

    expect(await acceptInvite(h.db, token, { name: "Nora North", password: NEW_PASSWORD })).toEqual({ userId, workOrderId: order.id });
    expect(await authenticate(h.db, "nora@northside.test", NEW_PASSWORD)).toBe(userId);
    const nora = await actorFor(h.db, userId);
    expect((await getOrderView(h.db, nora, order.id)).order.id).toBe(order.id);

    expect(await findInvite(h.db, token)).toBeNull();
    await expect(acceptInvite(h.db, token, { name: "Mallory", password: "mallory-password-1" })).rejects.toThrow(/expired or was already used/);
    await expect(issueInvite(h.db, operator, { userId, workOrderId: order.id })).rejects.toThrow(/active account/);
    expect(await authenticate(h.db, "nora@northside.test", NEW_PASSWORD)).toBe(userId);
  });

  it("revokes the older link when a new one is issued, and refuses expired links", async () => {
    const { userId, order, token: first } = await sale("omar@northside.test");
    const second = await issueInvite(h.db, operator, { userId, workOrderId: order.id });
    expect(await findInvite(h.db, first)).toBeNull();
    expect(await findInvite(h.db, second)).not.toBeNull();
    await h.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.userId, userId));
    await expect(acceptInvite(h.db, second, { name: "Omar", password: NEW_PASSWORD })).rejects.toThrow(/expired/);
  });

  it("can't be issued by a client or for an operator", async () => {
    await expect(issueInvite(h.db, client, { userId: client.id! })).rejects.toThrow(/permission/);
    await expect(issueInvite(h.db, operator, { userId: operator.id! })).rejects.toThrow(/client contacts/);
  });
});

describe("setup + monthly, delivered in-house", () => {
  it("creates no payout, keeps the margin visible, and starts the monthly service at acceptance", async () => {
    const o = await createWorkOrder(h.db, client, { ...SAMPLE_INTAKE, templateSlug: "lead-response" });
    await sendQuote(h.db, operator, o.id, { priceCents: 180_000, builderPayoutCents: 0, carePriceCents: 14_900, careIncluded: true });
    expect((await getOrderView(h.db, client, o.id)).order.careIncluded).toBe(true);
    expect((await getOrderView(h.db, operator, o.id)).economics?.grossMarginCents).toBe(180_000);
    await acceptQuote(h.db, client, o.id, true);
    await recordPayment(h.db, SYSTEM_ACTOR, o.id, { method: "test" });
    const assignmentId = await inviteBuilder(h.db, operator, o.id, { builderId: builder.builderId! });
    await respondToAssignment(h.db, builder, assignmentId, true);

    const { criteria } = await getOrderView(h.db, builder, o.id);
    await submitDelivery(h.db, builder, o.id, { summary: "Pipeline live.", links: [], evidence: Object.fromEntries(criteria.map((c) => [c.id, "Tested together"])) });
    const done = await reviewDelivery(h.db, client, o.id, { decisions: Object.fromEntries(criteria.map((c) => [c.id, "met"])), notes: {}, note: "" });

    expect(done.status).toBe("completed");
    expect(await h.db.select().from(payouts).where(eq(payouts.workOrderId, o.id))).toHaveLength(0);
    const [plan] = await h.db.select().from(carePlans).where(eq(carePlans.workOrderId, o.id));
    expect(plan).toMatchObject({ monthlyPriceCents: 14_900, builderShareCents: 0, status: "requested" });
    expect((await getOrderView(h.db, client, o.id)).permissions.requestCare).toBe(false);
  });

  it("refuses a negative payout and prices below the $250 minimum", async () => {
    const o = await createWorkOrder(h.db, client, SAMPLE_INTAKE);
    await expect(sendQuote(h.db, operator, o.id, { priceCents: 180_000, builderPayoutCents: -100, carePriceCents: null })).rejects.toThrow();
    await expect(sendQuote(h.db, operator, o.id, { priceCents: 10_000, builderPayoutCents: 0, carePriceCents: null })).rejects.toThrow();
  });
});
