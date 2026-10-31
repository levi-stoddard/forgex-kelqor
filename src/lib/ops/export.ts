import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { customerServices, invoiceLines, invoices, orgs, serviceEvents, serviceRequests, users, workOrders } from "../db/schema";

// Milestone 5 groundwork: what KELQOR holds for one customer organization that the customer can see, for offboarding
// or a data request. Only that organization's rows; never a password hash, a session, KELQOR's internal review notes,
// processing internals, operating costs or internal events. Internal research and other customers are never included.

export async function exportCustomer(db: DB, orgId: string) {
  const [org] = await db.select({ id: orgs.id, name: orgs.name, website: orgs.website, industry: orgs.industry, createdAt: orgs.createdAt }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw new Error("That customer doesn't exist.");
  const people = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.orgId, orgId));
  const services = await db
    .select({ id: customerServices.id, category: customerServices.category, name: customerServices.name, status: customerServices.status, planKey: customerServices.planKey, monthlyCents: customerServices.monthlyCents, includedRequests: customerServices.includedRequests, overageCents: customerServices.overageCents, setupCents: customerServices.setupCents, agreementStartedAt: customerServices.agreementStartedAt, endedAt: customerServices.endedAt })
    .from(customerServices)
    .where(eq(customerServices.orgId, orgId));
  const rows = await db.select().from(serviceRequests).where(eq(serviceRequests.orgId, orgId));
  const released = (s: string) => s === "awaiting_customer" || s === "completed" || s === "declined";
  const requests = rows.map((r) => ({ id: r.id, serviceId: r.serviceId, title: r.title, status: r.status, input: r.input, result: released(r.status) ? r.deliverable : null, customerNote: r.customerNote, customerDecidedAt: r.customerDecidedAt, createdAt: r.createdAt, completedAt: r.completedAt, simulated: r.simulated }));
  const events = await db
    .select({ id: serviceEvents.id, requestId: serviceEvents.requestId, serviceId: serviceEvents.serviceId, summary: serviceEvents.summary, createdAt: serviceEvents.createdAt })
    .from(serviceEvents)
    .where(and(eq(serviceEvents.orgId, orgId), eq(serviceEvents.customerVisible, true)));
  const inv = (await db.select().from(invoices).where(eq(invoices.orgId, orgId))).filter((i) => i.status === "issued" || i.status === "paid");
  return {
    exportedAt: new Date().toISOString(),
    organization: org,
    people,
    workOrders: await db.select({ id: workOrders.id, title: workOrders.title, status: workOrders.status, priceCents: workOrders.priceCents, createdAt: workOrders.createdAt, completedAt: workOrders.completedAt }).from(workOrders).where(eq(workOrders.orgId, orgId)),
    services,
    requests,
    history: events,
    invoices: inv.map((i) => ({ id: i.id, period: i.period, status: i.status, simulated: i.simulated, totalCents: i.totalCents, issuedAt: i.issuedAt, paidAt: i.paidAt })),
    invoiceLines: inv.length ? await db.select({ invoiceId: invoiceLines.invoiceId, description: invoiceLines.description, quantity: invoiceLines.quantity, unitCents: invoiceLines.unitCents, amountCents: invoiceLines.amountCents }).from(invoiceLines).where(inArray(invoiceLines.invoiceId, inv.map((i) => i.id))) : [],
  };
}
