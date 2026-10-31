import { z } from "zod";
import { boiseMonth } from "../controls";
import type { DB } from "../db";
import type { Actor } from "../domain/actor";
import { CATEGORIES, PLANS, REVIEW_LABOR_CENTS_PER_HOUR, SERVICE_CATEGORIES } from "../services/catalog";
import type { OperatorRequestView } from "../services/contract";
import {
  addService,
  configureService,
  customerCosts,
  customerReport,
  generateInvoice,
  getRequest,
  listCustomers,
  listInvoices,
  listRequests,
  listServices,
  offboardCustomer,
  onboardCustomer,
  reviewRequest,
  setInvoiceStatus,
  setServiceStatus,
  submitRequest,
} from "../services/service";

// Customer AI Operations routes for the desktop app (Milestone 4), under /api/desktop/cust/, for operators only (the
// caller checks that). The managed-services domain checks every action again.

const Key = z.object({ requestKey: z.string().regex(/^[0-9a-f-]{36}$/) });
const ID = /^[0-9a-f-]{36}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

type Body = <T>(schema: z.ZodType<T>) => Promise<T>;

export async function customersOverview(db: DB, actor: Actor) {
  const queue = (await listRequests(db, actor, { status: ["in_review", "received", "processing"] })) as OperatorRequestView[];
  return {
    period: boiseMonth(new Date()),
    customers: await listCustomers(db, actor),
    reviewQueue: queue.map((r) => ({ id: r.id, label: r.label, orgName: r.orgName, serviceName: r.serviceName, title: r.title, status: r.status, submittedAt: r.submittedAt, overdue: r.overdue, simulated: r.simulated })),
    plans: PLANS,
    categories: SERVICE_CATEGORIES.map((k) => ({ key: k, name: CATEGORIES[k].name, promise: CATEGORIES[k].promise, processor: CATEGORIES[k].processor })),
    laborCentsPerHour: REVIEW_LABOR_CENTS_PER_HOUR,
  };
}
export type CustomersOverview = Awaited<ReturnType<typeof customersOverview>>;

export async function customerDetail(db: DB, actor: Actor, orgId: string, period: string) {
  return {
    orgId,
    period,
    services: await listServices(db, actor, orgId),
    requests: (await listRequests(db, actor, { orgId })) as OperatorRequestView[],
    invoices: await listInvoices(db, actor, orgId),
    report: await customerReport(db, actor, orgId, period),
    costs: await customerCosts(db, actor, orgId, period),
  };
}
export type CustomerDetail = Awaited<ReturnType<typeof customerDetail>>;

/** Answers a Customer AI Operations route, or returns undefined when the path isn't one. */
export async function customersRoute(db: DB, actor: Actor, method: string, p: string[], body: Body): Promise<unknown | undefined> {
  const at = (m: string, ...parts: (string | RegExp)[]) =>
    method === m && p.length === parts.length && parts.every((part, i) => (typeof part === "string" ? part === p[i] : part.test(p[i])));

  if (at("GET", "cust")) return customersOverview(db, actor);
  if (at("GET", "cust", "orgs", ID, PERIOD)) return customerDetail(db, actor, p[2], p[3]);
  if (at("GET", "cust", "requests", ID)) return getRequest(db, actor, p[2]);
  if (at("POST", "cust", "onboard")) return onboardCustomer(db, actor, (await body(z.object({ customer: z.unknown() }))).customer);
  if (at("POST", "cust", "orgs", ID, "offboard")) return offboardCustomer(db, actor, p[2], (await body(Key)).requestKey);
  if (at("POST", "cust", "services")) {
    const b = await body(Key.extend({ service: z.unknown() }));
    return addService(db, actor, b.service, b.requestKey);
  }
  if (at("POST", "cust", "services", ID, /^(activate|pause|resume|end)$/)) return setServiceStatus(db, actor, p[2], p[3] as "activate", (await body(Key)).requestKey);
  if (at("PUT", "cust", "services", ID, "config")) {
    const b = await body(Key.extend({ config: z.unknown() }));
    return configureService(db, actor, p[2], b.config, b.requestKey);
  }
  if (at("POST", "cust", "requests")) {
    const b = await body(Key.extend({ request: z.unknown() }));
    return submitRequest(db, actor, b.request, b.requestKey);
  }
  if (at("POST", "cust", "requests", ID, "review")) {
    const b = await body(Key.extend({ review: z.unknown() }));
    return reviewRequest(db, actor, p[2], b.review, b.requestKey);
  }
  if (at("POST", "cust", "invoices")) {
    const b = await body(Key.extend({ orgId: z.string().regex(ID), period: z.string().regex(PERIOD) }));
    return generateInvoice(db, actor, { orgId: b.orgId, period: b.period }, b.requestKey);
  }
  if (at("POST", "cust", "invoices", ID, /^(issue|mark_paid|void)$/)) return setInvoiceStatus(db, actor, p[2], p[3] as "issue", (await body(Key)).requestKey);
  return undefined;
}
