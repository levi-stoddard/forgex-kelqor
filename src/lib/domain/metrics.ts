import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { carePlans, events, payments, payouts, reviews, workOrders } from "../db/schema";
import { moneyClass, orderClasses, type MoneyClass } from "./classification";
import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "./types";

const HOUR = 60 * 60 * 1000;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const total = (xs: { amountCents: number }[]) => xs.reduce((a, p) => a + p.amountCents, 0);

/**
 * Operating metrics for the ForgeX pipeline. By default only real companies' orders count (see classification.ts);
 * "include demo data" adds demo and test companies back for exploring. Either way money is kept in three separate
 * buckets: real, test and unverified. Nothing but real money counts as cash, margin or monthly revenue.
 */
export async function computeMetrics(db: DB, opts: { includeDemo?: boolean } = {}) {
  const includeDemo = opts.includeDemo ?? false;
  const classes = await orderClasses(db);
  const allOrders = await db.select().from(workOrders);
  const orders = includeDemo ? allOrders : allOrders.filter((o) => classes.get(o.id) === "real");
  const ids = new Set(orders.map((o) => o.id));
  const pays = (await db.select().from(payments)).filter((p) => ids.has(p.workOrderId));
  const outs = (await db.select().from(payouts)).filter((p) => ids.has(p.workOrderId));
  const plans = (await db.select().from(carePlans)).filter((c) => ids.has(c.workOrderId));
  const revs = (await db.select().from(reviews)).filter((r) => ids.has(r.workOrderId));
  const disputes = (await db.select({ workOrderId: events.workOrderId }).from(events).where(eq(events.type, "open_dispute"))).filter(
    (e) => e.workOrderId && ids.has(e.workOrderId),
  );

  const byStatus = Object.fromEntries(WORK_ORDER_STATUSES.map((s) => [s, 0])) as Record<WorkOrderStatus, number>;
  for (const o of orders) byStatus[o.status] += 1;

  const kind = (p: (typeof pays)[number]): MoneyClass => moneyClass(p, classes.get(p.workOrderId) ?? "real");
  const succeeded = pays.filter((p) => p.status === "succeeded");
  const real = succeeded.filter((p) => kind(p) === "real");
  const test = succeeded.filter((p) => kind(p) === "test");
  const unverified = succeeded.filter((p) => kind(p) === "unverified");
  const realFundedIds = new Set(real.map((p) => p.workOrderId));
  const realFunded = orders.filter((o) => realFundedIds.has(o.id));
  const margin = (list: typeof orders) => list.reduce((a, o) => a + ((o.priceCents ?? 0) - (o.builderPayoutCents ?? 0)), 0);

  const completed = orders.filter((o) => o.status === "completed");
  const quoted = orders.filter((o) => o.quoteSentAt);

  return {
    includeDemo,
    byStatus,
    funnel: {
      requests: orders.length,
      quoted: quoted.length,
      accepted: orders.filter((o) => o.acceptedAt).length,
      funded: orders.filter((o) => o.fundedAt).length,
      completed: completed.length,
    },
    cash: {
      collectedCents: total(real),
      refundedCents: total(pays.filter((p) => p.status === "refunded" && kind(p) === "real")),
      testCollectedCents: total(test),
      testOrders: test.length,
      // Stripe payments recorded before their live/test mode was stored: neither real nor test until checked.
      unverifiedCents: total(unverified),
      unverifiedPayments: unverified.length,
    },
    grossMarginCents: margin(realFunded),
    grossMarginPct: realFunded.length ? margin(realFunded) / realFunded.reduce((a, o) => a + (o.priceCents ?? 0), 0) : null,
    avgOrderCents: avg(realFunded.map((o) => o.priceCents ?? 0)),
    // In-house orders have no payout, so their margin excludes the owner's own time.
    inHouseFunded: realFunded.filter((o) => o.builderPayoutCents === 0).length,
    // Payouts are a real liability only when the order was funded with real money.
    payouts: {
      pendingCents: outs.filter((p) => p.status === "pending" && realFundedIds.has(p.workOrderId)).reduce((a, p) => a + p.amountCents, 0),
      paidCents: outs.filter((p) => p.status === "paid" && realFundedIds.has(p.workOrderId)).reduce((a, p) => a + p.amountCents, 0),
      testPendingCents: outs.filter((p) => p.status === "pending" && !realFundedIds.has(p.workOrderId)).reduce((a, p) => a + p.amountCents, 0),
    },
    speed: {
      hoursToQuote: avg(quoted.map((o) => (o.quoteSentAt!.getTime() - o.createdAt.getTime()) / HOUR)),
      daysFundedToComplete: avg(
        completed.filter((o) => o.fundedAt && o.completedAt).map((o) => (o.completedAt!.getTime() - o.fundedAt!.getTime()) / (24 * HOUR)),
      ),
    },
    quality: {
      firstPassRate: completed.length ? completed.filter((o) => o.revisionCount === 0).length / completed.length : null,
      avgRating: avg(revs.map((r) => r.rating)),
      reviews: revs.length,
      disputes: new Set(disputes.map((d) => d.workOrderId)).size,
    },
    // Monthly revenue counts only plans on orders funded with real money; the rest are reported apart.
    care: {
      activeCount: plans.filter((p) => p.status === "active" && realFundedIds.has(p.workOrderId)).length,
      requestedCount: plans.filter((p) => p.status === "requested").length,
      mrrCents: plans.filter((p) => p.status === "active" && realFundedIds.has(p.workOrderId)).reduce((a, p) => a + p.monthlyPriceCents, 0),
      testActiveCount: plans.filter((p) => p.status === "active" && !realFundedIds.has(p.workOrderId)).length,
      testMrrCents: plans.filter((p) => p.status === "active" && !realFundedIds.has(p.workOrderId)).reduce((a, p) => a + p.monthlyPriceCents, 0),
    },
    aiCostDollars: orders.reduce((a, o) => a + o.aiCostMicros, 0) / 1_000_000,
  };
}

export type Metrics = Awaited<ReturnType<typeof computeMetrics>>;
