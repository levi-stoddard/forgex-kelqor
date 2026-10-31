import { eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { orgs, payments, workOrders } from "../db/schema";
import type { DataClass, PaymentMethod } from "./types";

// What counts as real business. Every company carries an explicit class (orgs.data_class: real, demo or test), set
// when it is created and changed only by an operator; names are never read. Money is then real, test or unverified,
// and no total ever mixes them.

/** An order is its company's class, unless the order itself was seeded as demo data. */
export function orderClass(orderIsDemo: boolean, orgClass: DataClass): DataClass {
  return orderIsDemo ? "demo" : orgClass;
}

/** Real money, test money (test payments, Stripe test mode, any demo or test company), or not yet known. */
export type MoneyClass = "real" | "test" | "unverified";

/**
 * What a payment is as money. Only a real company's payment can be real: a bank transfer an operator recorded, or a
 * Stripe payment Stripe marked live. A Stripe payment saved before its mode was recorded is unverified until checked.
 */
export function moneyClass(p: { method: PaymentMethod; livemode: boolean | null }, order: DataClass): MoneyClass {
  if (order !== "real" || p.method === "test") return "test";
  if (p.method === "stripe") return p.livemode === true ? "real" : p.livemode === false ? "test" : "unverified";
  return "real";
}

/** Each order's class, for the given orders or all of them. */
export async function orderClasses(db: DB, ids?: string[]): Promise<Map<string, DataClass>> {
  if (ids && !ids.length) return new Map();
  const query = db
    .select({ id: workOrders.id, isDemo: workOrders.isDemo, orgClass: orgs.dataClass })
    .from(workOrders)
    .innerJoin(orgs, eq(orgs.id, workOrders.orgId));
  const rows = ids ? await query.where(inArray(workOrders.id, ids)) : await query;
  return new Map(rows.map((r) => [r.id, orderClass(r.isDemo, r.orgClass)]));
}

/** Orders funded with real money: at least one succeeded payment that is real. Only these create real liabilities. */
export async function realFundedOrderIds(db: DB, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const classes = await orderClasses(db, ids);
  const rows = await db
    .select({ workOrderId: payments.workOrderId, method: payments.method, livemode: payments.livemode, status: payments.status })
    .from(payments)
    .where(inArray(payments.workOrderId, ids));
  return new Set(
    rows.filter((p) => p.status === "succeeded" && moneyClass(p, classes.get(p.workOrderId) ?? "real") === "real").map((p) => p.workOrderId),
  );
}
