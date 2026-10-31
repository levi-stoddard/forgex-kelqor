import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { boiseMonth } from "../controls";
import type { DB } from "../db";
import { customerServices, invites, invoiceLines, invoices, orgs, serviceEvents, serviceRequests, sessions, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import { createClientForSale, inviteUrl, issueInvite } from "../domain/invites";
import { CATEGORIES, planByKey, REVIEW_LABOR_CENTS_PER_HOUR, SERVICE_CATEGORIES, type ServiceCategory, type ServiceConfig } from "./catalog";
import {
  INVOICE_LABEL,
  REQUEST_LABEL,
  STATUS_LABEL,
  type CustomerCosts,
  type CustomerReport,
  type CustomerRequestView,
  type CustomerServiceView,
  type InvoiceView,
  type OperatorRequestView,
  type ServiceRequestStatus,
} from "./contract";
import { processRequest, type Deliverable } from "./processors";

// Milestone 4: customer AI operations. One rule runs through every function here: a customer account sees and acts
// only within its own organization, and anything outside it answers "not found" (so its existence doesn't show).
// KELQOR's operators manage every customer; builders have no part in managed services. Owner actions elsewhere stay
// the owner's; here the operator role reviews, configures and bills, and the customer approves its own results.

function assert(ok: unknown, message: string, code: "invalid" | "forbidden" | "not_found" | "conflict" = "invalid"): asserts ok {
  if (!ok) throw new DomainError(message, code);
}

const isOperator = (a: Actor) => a.role === "operator" && Boolean(a.id);
const isClient = (a: Actor) => a.role === "client" && Boolean(a.id && a.orgId);
function requireOperator(a: Actor) {
  assert(isOperator(a), "Only KELQOR operators can do that.", "forbidden");
}
function requireParty(a: Actor) {
  assert(isOperator(a) || isClient(a), "Managed services are for KELQOR operators and customer accounts.", "forbidden");
}
/** A customer may reach only its own organization's records; anything else is "not found". */
function inScope(a: Actor, orgId: string): boolean {
  return isOperator(a) || (isClient(a) && a.orgId === orgId);
}

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
/** The hash every review and approval decision is bound to: the exact draft or result the person saw. */
export const deliverableHash = (d: Deliverable | null) => (d ? createHash("sha256").update(`kelqor-deliverable-v1\n${canonical(d)}`).digest("hex") : null);

async function logEvent(db: DB, e: { orgId: string; serviceId?: string | null; requestId?: string | null; kind: string; summary: string; customerVisible?: boolean; actorId?: string | null; requestKey?: string | null; data?: Record<string, unknown> }) {
  await db.insert(serviceEvents).values({
    id: randomUUID(),
    orgId: e.orgId,
    serviceId: e.serviceId ?? null,
    requestId: e.requestId ?? null,
    kind: e.kind,
    summary: e.summary.slice(0, 500),
    customerVisible: e.customerVisible ?? true,
    actorId: e.actorId ?? null,
    requestKey: e.requestKey ?? null,
    data: e.data ?? {},
  });
}

/** Acts once per request key within an organization: a repeat or simultaneous request with the same key does nothing. */
async function once(db: DB, orgId: string, actor: Actor, requestKey: string, summary: string, act: () => Promise<void>, customerVisible = true, ids: { serviceId?: string; requestId?: string } = {}): Promise<boolean> {
  assert(/^[0-9a-f-]{36}$/.test(requestKey), "The request is missing its id.");
  const [seen] = await db.select({ id: serviceEvents.id }).from(serviceEvents).where(and(eq(serviceEvents.orgId, orgId), eq(serviceEvents.requestKey, requestKey))).limit(1);
  if (seen) return false;
  const eventId = randomUUID();
  try {
    await db.insert(serviceEvents).values({ id: eventId, orgId, kind: "action", summary: summary.slice(0, 500), customerVisible, actorId: actor.id ?? null, requestKey, serviceId: ids.serviceId ?? null, requestId: ids.requestId ?? null, data: {} });
  } catch {
    return false;
  }
  try {
    await act();
  } catch (e) {
    // It didn't happen: say so, keep it out of the customer's history, and free the key so the same request can retry.
    await db
      .update(serviceEvents)
      .set({ kind: "refused", summary: `${summary} (refused: ${e instanceof Error ? e.message : String(e)})`.slice(0, 500), customerVisible: false, requestKey: null })
      .where(eq(serviceEvents.id, eventId));
    throw e;
  }
  return true;
}

// ---- Customers and onboarding ----------------------------------------------------------------------------------

export const OnboardInput = z.strictObject({
  companyName: z.string().trim().min(2).max(120),
  contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().max(200),
  industry: z.string().trim().max(80).optional(),
  dataClass: z.enum(["real", "test"]),
});

/**
 * A new customer organization and its first contact, who gets a one-time link to set a password (the existing invite
 * flow). A synthetic customer is a "test" record, so it never counts as real business.
 */
export async function onboardCustomer(db: DB, actor: Actor, raw: unknown): Promise<{ orgId: string; userId: string; inviteUrl: string }> {
  requireOperator(actor);
  const input = OnboardInput.parse(raw);
  const { orgId, userId } = await createClientForSale(db, actor, { ...input, sizeBand: "" });
  const token = await issueInvite(db, actor, { userId });
  await logEvent(db, { orgId, kind: "onboarding", summary: `Customer onboarded by ${actor.name}; an invitation was created for ${input.contactName}.`, actorId: actor.id });
  return { orgId, userId, inviteUrl: inviteUrl(token) };
}

/**
 * Offboards a customer: every service ends, its accounts can't sign in, their open sessions end and any unused
 * invitation stops working. Nothing is
 * deleted: requests, events and invoices stay for the record (export them first with npm run customer:export).
 */
export async function offboardCustomer(db: DB, actor: Actor, orgId: string, requestKey: string): Promise<{ servicesEnded: number; accountsDisabled: number }> {
  requireOperator(actor);
  const [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  assert(org, "That customer doesn't exist.", "not_found");
  let result = { servicesEnded: 0, accountsDisabled: 0 };
  await once(db, orgId, actor, requestKey, `Offboarded by ${actor.name}`, async () => {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      const ended = await tx.update(customerServices).set({ status: "ended", endedAt: new Date(), updatedAt: new Date() }).where(and(eq(customerServices.orgId, orgId), inArray(customerServices.status, ["draft", "active", "paused"]))).returning({ id: customerServices.id });
      const people = await tx.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "client")));
      if (people.length) {
        await tx.update(users).set({ signInDisabledAt: new Date() }).where(inArray(users.id, people.map((u) => u.id)));
        await tx.delete(sessions).where(inArray(sessions.userId, people.map((u) => u.id)));
        await tx.update(invites).set({ revokedAt: new Date() }).where(and(inArray(invites.userId, people.map((u) => u.id)), isNull(invites.usedAt), isNull(invites.revokedAt)));
      }
      result = { servicesEnded: ended.length, accountsDisabled: people.length };
    });
  }, false);
  return result;
}

export async function listCustomers(db: DB, actor: Actor) {
  requireOperator(actor);
  const orgRows = await db.select().from(orgs).orderBy(asc(orgs.name));
  const services = await db.select().from(customerServices);
  const requests = await db.select({ orgId: serviceRequests.orgId, status: serviceRequests.status, createdAt: serviceRequests.createdAt, serviceId: serviceRequests.serviceId }).from(serviceRequests);
  const contacts = await db.select({ orgId: users.orgId, n: users.id }).from(users).where(eq(users.role, "client"));
  return orgRows
    .filter((o) => services.some((s) => s.orgId === o.id) || contacts.some((c) => c.orgId === o.id))
    .map((o) => {
      const mine = requests.filter((r) => r.orgId === o.id);
      const svc = services.filter((s) => s.orgId === o.id);
      const overdue = mine.filter((r) => ["received", "processing", "in_review"].includes(r.status) && isOverdue(r.createdAt, svc.find((s) => s.id === r.serviceId)?.config.turnaroundHours)).length;
      return {
        orgId: o.id,
        name: o.name,
        industry: o.industry,
        dataClass: o.dataClass,
        contacts: contacts.filter((c) => c.orgId === o.id).length,
        services: svc.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        open: mine.filter((r) => !["completed", "declined", "failed"].includes(r.status)).length,
        awaitingReview: mine.filter((r) => r.status === "in_review").length,
        awaitingCustomer: mine.filter((r) => r.status === "awaiting_customer" || r.status === "needs_info").length,
        failed: mine.filter((r) => r.status === "failed").length,
        overdue,
      };
    });
}

const isOverdue = (created: Date, hours: number | undefined) => Date.now() - created.getTime() > (hours ?? 24) * 3_600_000;

// ---- Services --------------------------------------------------------------------------------------------------

const RateCardInput = z.strictObject({
  hourlyCents: z.number().int().min(0).max(10_000_00),
  minimumCents: z.number().int().min(0).max(10_000_000),
  items: z.array(z.strictObject({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), label: z.string().max(80), unit: z.string().max(20), cents: z.number().int().min(0).max(10_000_000) })).max(20),
  jobHours: z.record(z.string().max(40), z.number().min(0).max(1000)),
});
const ConfigInput = z.strictObject({
  customerApprovalAboveCents: z.number().int().min(0).max(1_000_000_000).nullable(),
  rateCard: RateCardInput.optional(),
  requiredFields: z.array(z.string().max(40)).max(20),
  jobTypes: z.array(z.string().max(40)).max(40),
  turnaroundHours: z.number().int().min(1).max(24 * 30),
});
export const ServiceInput = z.strictObject({
  orgId: z.string().uuid(),
  category: z.enum(SERVICE_CATEGORIES),
  name: z.string().trim().min(2).max(120).optional(),
  planKey: z.string().max(40),
  config: ConfigInput.partial().optional(),
});

const serviceView = (s: typeof customerServices.$inferSelect): CustomerServiceView => ({
  id: s.id,
  orgId: s.orgId,
  category: s.category,
  categoryName: CATEGORIES[s.category].name,
  name: s.name,
  status: s.status,
  planKey: s.planKey,
  monthlyCents: s.monthlyCents,
  includedRequests: s.includedRequests,
  overageCents: s.overageCents,
  setupCents: s.setupCents,
  agreementStartedAt: s.agreementStartedAt?.toISOString() ?? null,
  config: s.config,
  promise: CATEGORIES[s.category].promise,
  deliverable: CATEGORIES[s.category].deliverable,
});

export async function addService(db: DB, actor: Actor, raw: unknown, requestKey: string): Promise<CustomerServiceView> {
  requireOperator(actor);
  const input = ServiceInput.parse(raw);
  const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, input.orgId)).limit(1);
  assert(org, "That customer doesn't exist.", "not_found");
  const plan = planByKey(input.planKey);
  assert(plan, "Choose one of the plans.");
  const cat = CATEGORIES[input.category];
  const config: ServiceConfig = { ...cat.defaults, ...(input.config ?? {}) } as ServiceConfig;
  const id = randomUUID();
  await once(db, input.orgId, actor, requestKey, `${cat.name} configured by ${actor.name} on the ${plan.name} plan`, async () => {
    await db.insert(customerServices).values({ id, orgId: input.orgId, category: input.category, name: input.name ?? cat.name, status: "draft", config, planKey: plan.key, monthlyCents: plan.monthlyCents, includedRequests: plan.includedRequests, overageCents: plan.overageCents, setupCents: plan.setupCents, createdById: actor.id! });
  }, false);
  const [row] = await db.select().from(customerServices).where(eq(customerServices.id, id)).limit(1);
  assert(row, "The service was already created by this request.", "conflict");
  return serviceView(row);
}

export async function configureService(db: DB, actor: Actor, id: string, rawConfig: unknown, requestKey: string): Promise<CustomerServiceView> {
  requireOperator(actor);
  const s = await serviceById(db, actor, id);
  assert(s.status !== "ended", "An ended service can't be changed.", "conflict");
  const config = { ...s.config, ...ConfigInput.partial().parse(rawConfig) } as ServiceConfig;
  await once(db, s.orgId, actor, requestKey, `${s.name} settings changed by ${actor.name}`, async () => {
    await db.update(customerServices).set({ config, updatedAt: new Date() }).where(eq(customerServices.id, id));
  }, false, { serviceId: id });
  return serviceView((await db.select().from(customerServices).where(eq(customerServices.id, id)).limit(1))[0]);
}

/** Starts, pauses, resumes or ends a service. Starting copies the plan's terms into the agreement, once. */
export async function setServiceStatus(db: DB, actor: Actor, id: string, action: "activate" | "pause" | "resume" | "end", requestKey: string): Promise<CustomerServiceView> {
  requireOperator(actor);
  const s = await serviceById(db, actor, id);
  const move: Record<typeof action, { from: string[]; to: "active" | "paused" | "ended"; label: string }> = {
    activate: { from: ["draft"], to: "active", label: "activated" },
    pause: { from: ["active"], to: "paused", label: "paused" },
    resume: { from: ["paused"], to: "active", label: "resumed" },
    end: { from: ["draft", "active", "paused"], to: "ended", label: "ended" },
  };
  const m = move[action];
  assert(m.from.includes(s.status), `A ${s.status} service can't be ${m.label}.`, "conflict");
  await once(db, s.orgId, actor, requestKey, `${s.name} ${m.label} by ${actor.name}`, async () => {
    const patch: Partial<typeof customerServices.$inferInsert> = { status: m.to, updatedAt: new Date() };
    if (action === "activate") {
      const plan = planByKey(s.planKey);
      assert(plan, "The service's plan no longer exists.");
      Object.assign(patch, { monthlyCents: plan.monthlyCents, includedRequests: plan.includedRequests, overageCents: plan.overageCents, setupCents: plan.setupCents, agreementStartedAt: new Date() });
    }
    if (action === "end") patch.endedAt = new Date();
    const done = await db.update(customerServices).set(patch).where(and(eq(customerServices.id, id), inArray(customerServices.status, m.from as never))).returning({ id: customerServices.id });
    assert(done.length === 1, "The service changed state.", "conflict");
  }, true, { serviceId: id });
  return serviceView((await db.select().from(customerServices).where(eq(customerServices.id, id)).limit(1))[0]);
}

async function serviceById(db: DB, actor: Actor, id: string): Promise<CustomerServiceView> {
  requireParty(actor);
  const [s] = await db.select().from(customerServices).where(eq(customerServices.id, id)).limit(1);
  assert(s && inScope(actor, s.orgId), "That service doesn't exist.", "not_found");
  return serviceView(s);
}

/** A customer sees its own services that have started (never a draft); operators see all, or one customer's. */
export async function listServices(db: DB, actor: Actor, orgId?: string): Promise<CustomerServiceView[]> {
  requireParty(actor);
  const target = isClient(actor) ? actor.orgId! : orgId;
  const rows = target ? await db.select().from(customerServices).where(eq(customerServices.orgId, target)).orderBy(asc(customerServices.createdAt)) : await db.select().from(customerServices).orderBy(asc(customerServices.createdAt));
  return rows.filter((s) => isOperator(actor) || s.status !== "draft").map(serviceView);
}

// ---- Requests --------------------------------------------------------------------------------------------------

export const RequestInput = z.strictObject({
  serviceId: z.string().uuid(),
  title: z.string().trim().max(160).optional(),
  text: z.string().trim().min(10).max(20_000),
  from: z.string().trim().max(200).optional(),
});

type RequestRow = typeof serviceRequests.$inferSelect;

async function requestRow(db: DB, actor: Actor, id: string): Promise<RequestRow> {
  requireParty(actor);
  const [r] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id)).limit(1);
  assert(r && inScope(actor, r.orgId), "That request doesn't exist.", "not_found");
  return r;
}

async function moveRequest(db: DB, id: string, from: ServiceRequestStatus[], patch: Partial<typeof serviceRequests.$inferInsert>): Promise<boolean> {
  const done = await db
    .update(serviceRequests)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(serviceRequests.id, id), inArray(serviceRequests.status, from)))
    .returning({ id: serviceRequests.id });
  return done.length === 1;
}

/** Runs the service's processor on the request and puts the draft in KELQOR's review queue. Simulated: no AI is called. */
async function processNow(db: DB, r: RequestRow, s: CustomerServiceView) {
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, r.orgId)).limit(1);
  assert(await moveRequest(db, r.id, ["received"], { status: "processing" }), "The request changed state.", "conflict");
  try {
    const result = processRequest(CATEGORIES[s.category], s.config, r.input, org?.name ?? "our team");
    await moveRequest(db, r.id, ["processing"], { status: "in_review", processing: result, draft: result.draft, draftHash: deliverableHash(result.draft), aiCostMicros: 0, costSource: "simulated", title: r.title || result.draft.title });
    await logEvent(db, { orgId: r.orgId, serviceId: s.id, requestId: r.id, kind: "processed", summary: `Processed (simulated, no AI model): ${result.questions.length} question${result.questions.length === 1 ? "" : "s"}, ${result.flags.length} flag${result.flags.length === 1 ? "" : "s"}. In KELQOR's review.`, customerVisible: true });
  } catch (e) {
    await moveRequest(db, r.id, ["processing"], { status: "failed", stateReason: "The request couldn't be processed. KELQOR has been told." });
    await logEvent(db, { orgId: r.orgId, requestId: r.id, kind: "error", summary: `Processing failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), customerVisible: false });
  }
}

/** A customer submits a request to one of its active services (or an operator does, for it). It is processed at once. */
export async function submitRequest(db: DB, actor: Actor, raw: unknown, requestKey: string): Promise<CustomerRequestView | OperatorRequestView> {
  requireParty(actor);
  const input = RequestInput.parse(raw);
  const s = await serviceById(db, actor, input.serviceId);
  assert(s.status === "active", "That service isn't active, so it can't take requests right now.", "conflict");
  const id = randomUUID();
  const acted = await once(db, s.orgId, actor, requestKey, `Request submitted by ${actor.name}`, async () => {
    await db.insert(serviceRequests).values({
      id,
      orgId: s.orgId,
      serviceId: s.id,
      title: input.title ?? "",
      input: { text: input.text, from: input.from ?? null, channel: isClient(actor) ? "portal" : "operator" },
      status: "received",
      submittedById: actor.id!,
    });
  }, true, { serviceId: s.id });
  if (!acted) {
    // The same submission again: answer with the request it created.
    const [prior] = await db.select({ requestId: serviceEvents.requestId }).from(serviceEvents).where(and(eq(serviceEvents.orgId, s.orgId), eq(serviceEvents.requestKey, requestKey))).limit(1);
    assert(prior?.requestId, "That request is still being submitted.", "conflict");
    return getRequest(db, actor, prior.requestId);
  }
  const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id)).limit(1);
  await db.update(serviceEvents).set({ requestId: id }).where(and(eq(serviceEvents.orgId, s.orgId), eq(serviceEvents.requestKey, requestKey)));
  await processNow(db, row, s);
  return getRequest(db, actor, id);
}

const Edits = z.strictObject({
  summary: z.string().max(2000).optional(),
  reply: z.string().max(8000).optional(),
  lines: z.array(z.strictObject({ description: z.string().max(200), quantity: z.number().min(0).max(100_000), unit: z.string().max(20), unitCents: z.number().int().min(0).max(100_000_000), estimated: z.boolean() })).max(40).optional(),
  actions: z.array(z.string().max(300)).max(20).optional(),
});
export const ReviewInput = z.strictObject({
  decision: z.enum(["approve", "ask_customer", "fail"]),
  draftHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().max(2000).default(""),
  minutes: z.number().int().min(0).max(600),
  edits: Edits.optional(),
  questions: z.array(z.string().max(400)).max(20).optional(),
  customerMessage: z.string().max(1000).optional(),
});

/**
 * KELQOR's review of a processed request, bound to the exact draft the reviewer saw. Approving releases the result:
 * to the customer for approval when the service's rule asks for it, or straight to completed. Asking sends questions
 * to the customer; failing closes it with a message the customer sees. The review note itself stays internal.
 */
export async function reviewRequest(db: DB, actor: Actor, id: string, raw: unknown, requestKey: string): Promise<OperatorRequestView> {
  requireOperator(actor);
  const input = ReviewInput.parse(raw);
  const r = await requestRow(db, actor, id);
  assert(r.status === "in_review" && r.draft, "Only a request in KELQOR's review can be reviewed.", "conflict");
  assert(input.draftHash === r.draftHash, "The draft changed since you opened it. Review it again.", "conflict");
  const [s] = await db.select().from(customerServices).where(eq(customerServices.id, r.serviceId)).limit(1);
  await once(db, r.orgId, actor, requestKey, `Reviewed by ${actor.name}: ${input.decision.replace("_", " ")}`, async () => {
    const base = { reviewNote: input.note || null, reviewMinutes: input.minutes, reviewedById: actor.id!, reviewedAt: new Date() };
    if (input.decision === "approve") {
      const e = input.edits ?? {};
      const lines = e.lines ? e.lines.map((l) => ({ ...l, amountCents: Math.round(l.quantity * l.unitCents) })) : r.draft!.lines;
      const minimum = s.config.rateCard?.minimumCents ?? 0;
      const subtotal = lines.reduce((n, l) => n + l.amountCents, 0);
      const result: Deliverable = { ...r.draft!, summary: e.summary ?? r.draft!.summary, reply: e.reply ?? r.draft!.reply, actions: e.actions ?? r.draft!.actions, lines, totalCents: r.draft!.kind === "quote" ? Math.max(minimum, subtotal) : r.draft!.totalCents };
      const threshold = s.config.customerApprovalAboveCents;
      const needs = threshold !== null && result.totalCents > threshold;
      const ok = await moveRequest(db, id, ["in_review"], { ...base, deliverable: result, needsCustomerApproval: needs, status: needs ? "awaiting_customer" : "completed", completedAt: needs ? null : new Date(), stateReason: null });
      assert(ok, "The request changed state.", "conflict");
      await logEvent(db, { orgId: r.orgId, requestId: id, kind: "released", summary: needs ? "KELQOR reviewed the result; it's waiting for your approval." : "KELQOR reviewed the result; it's complete." });
    } else if (input.decision === "ask_customer") {
      const questions = input.questions?.length ? input.questions : r.processing?.questions ?? [];
      assert(questions.length > 0, "Say what to ask the customer.");
      const ok = await moveRequest(db, id, ["in_review"], { ...base, status: "needs_info", stateReason: questions.join("\n") });
      assert(ok, "The request changed state.", "conflict");
      await logEvent(db, { orgId: r.orgId, requestId: id, kind: "questions", summary: `KELQOR needs ${questions.length} detail${questions.length === 1 ? "" : "s"} from you.`, data: { questions } });
    } else {
      const message = (input.customerMessage ?? "").trim() || "KELQOR couldn't complete this request.";
      const ok = await moveRequest(db, id, ["in_review"], { ...base, status: "failed", stateReason: message });
      assert(ok, "The request changed state.", "conflict");
      await logEvent(db, { orgId: r.orgId, requestId: id, kind: "failed", summary: message });
    }
  }, false, { requestId: id });
  return (await getRequest(db, actor, id)) as OperatorRequestView;
}

/** The customer's answer to KELQOR's questions: added to the request, which is processed again and goes back to review. */
export async function answerRequest(db: DB, actor: Actor, id: string, raw: unknown, requestKey: string): Promise<CustomerRequestView | OperatorRequestView> {
  const r = await requestRow(db, actor, id);
  assert(isClient(actor), "The customer answers its own request.", "forbidden");
  const { text } = z.strictObject({ text: z.string().trim().min(2).max(10_000) }).parse(raw);
  assert(r.status === "needs_info", "This request isn't waiting for your information.", "conflict");
  const [s] = await db.select().from(customerServices).where(eq(customerServices.id, r.serviceId)).limit(1);
  await once(db, r.orgId, actor, requestKey, `Answered by ${actor.name}`, async () => {
    const input = { ...r.input, text: `${r.input.text}\n\nMore details from ${actor.name}:\n${text}`.slice(0, 20_000) };
    assert(await moveRequest(db, id, ["needs_info"], { input, status: "received", stateReason: null }), "The request changed state.", "conflict");
    const [fresh] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id)).limit(1);
    await processNow(db, fresh, serviceView(s));
  }, true, { requestId: id });
  return getRequest(db, actor, id);
}

export const DecisionInput = z.strictObject({
  decision: z.enum(["approve", "request_changes", "decline"]),
  resultHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().max(2000).default(""),
});

/** The customer's decision on a result KELQOR released for its approval, bound to the exact result it saw. */
export async function decideRequest(db: DB, actor: Actor, id: string, raw: unknown, requestKey: string): Promise<CustomerRequestView | OperatorRequestView> {
  const r = await requestRow(db, actor, id);
  assert(isClient(actor), "Only the customer approves its own results.", "forbidden");
  const input = DecisionInput.parse(raw);
  assert(r.status === "awaiting_customer" && r.deliverable, "This request isn't waiting for your approval.", "conflict");
  assert(input.resultHash === deliverableHash(r.deliverable), "The result changed since you opened it. Look at it again.", "conflict");
  if (input.decision !== "approve") assert(input.note.trim().length > 1, "Say what should change, or why you're declining.");
  await once(db, r.orgId, actor, requestKey, `${input.decision === "approve" ? "Approved" : input.decision === "decline" ? "Declined" : "Changes requested"} by ${actor.name}`, async () => {
    const base = { customerNote: input.note || null, customerDecidedById: actor.id!, customerDecidedAt: new Date() };
    const to: Partial<typeof serviceRequests.$inferInsert> =
      input.decision === "approve" ? { status: "completed", completedAt: new Date() } : input.decision === "decline" ? { status: "declined" } : { status: "in_review", deliverable: null, needsCustomerApproval: false };
    assert(await moveRequest(db, id, ["awaiting_customer"], { ...base, ...to }), "The request changed state.", "conflict");
  }, true, { requestId: id });
  return getRequest(db, actor, id);
}

function customerAllowed(r: RequestRow) {
  return { approve: r.status === "awaiting_customer", requestChanges: r.status === "awaiting_customer", decline: r.status === "awaiting_customer", answer: r.status === "needs_info" };
}

export async function getRequest(db: DB, actor: Actor, id: string): Promise<CustomerRequestView | OperatorRequestView> {
  const r = await requestRow(db, actor, id);
  const [s] = await db.select().from(customerServices).where(eq(customerServices.id, r.serviceId)).limit(1);
  const ev = await db
    .select({ e: serviceEvents, name: users.name })
    .from(serviceEvents)
    .leftJoin(users, eq(users.id, serviceEvents.actorId))
    .where(and(eq(serviceEvents.orgId, r.orgId), eq(serviceEvents.requestId, id)))
    .orderBy(asc(serviceEvents.createdAt));
  const released = r.status === "awaiting_customer" || r.status === "completed" || r.status === "declined";
  const ordinal = isOperator(actor) ? r.number : (await db.select({ id: serviceRequests.id }).from(serviceRequests).where(and(eq(serviceRequests.orgId, r.orgId), lte(serviceRequests.createdAt, r.createdAt)))).length;
  const base = {
    id: r.id,
    number: ordinal,
    label: isOperator(actor) ? REQUEST_LABEL(r.number) : `Request ${ordinal}`,
    serviceId: r.serviceId,
    serviceName: s?.name ?? "",
    title: r.title,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    submittedAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    input: { text: r.input.text, from: r.input.from },
    result: released ? r.deliverable : null,
    questions: r.status === "needs_info" ? (r.stateReason ?? "").split("\n").filter(Boolean) : [],
    needsCustomerApproval: r.needsCustomerApproval,
    simulated: r.simulated,
    history: ev.filter(({ e }) => e.customerVisible).map(({ e }) => ({ at: e.createdAt.toISOString(), summary: e.summary })),
  };
  if (!isOperator(actor)) return { ...base, allowed: customerAllowed(r) } satisfies CustomerRequestView;
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, r.orgId)).limit(1);
  const reviewer = r.reviewedById ? (await db.select({ name: users.name }).from(users).where(eq(users.id, r.reviewedById)).limit(1))[0]?.name ?? null : null;
  return {
    ...base,
    result: r.deliverable,
    orgId: r.orgId,
    orgName: org?.name ?? "",
    processing: r.processing,
    draft: r.draft,
    draftHash: r.draftHash,
    reviewNote: r.reviewNote,
    reviewMinutes: r.reviewMinutes,
    reviewedBy: reviewer,
    customerNote: r.customerNote,
    aiCostMicros: r.aiCostMicros,
    costSource: r.costSource,
    stateReason: r.stateReason,
    overdue: ["received", "processing", "in_review"].includes(r.status) && isOverdue(r.createdAt, s?.config.turnaroundHours),
    events: ev.map(({ e, name }) => ({ at: e.createdAt.toISOString(), kind: e.kind, summary: e.summary, actor: name ?? null, customerVisible: e.customerVisible })),
    allowed: { process: false, review: r.status === "in_review", askCustomer: r.status === "in_review", fail: r.status === "in_review" },
  } satisfies OperatorRequestView;
}

/** A customer's requests, or (for operators) every customer's or one customer's. */
export async function listRequests(db: DB, actor: Actor, opts: { orgId?: string; status?: ServiceRequestStatus[] } = {}): Promise<(CustomerRequestView | OperatorRequestView)[]> {
  requireParty(actor);
  const target = isClient(actor) ? actor.orgId! : opts.orgId;
  const where = [target ? eq(serviceRequests.orgId, target) : undefined, opts.status?.length ? inArray(serviceRequests.status, opts.status) : undefined].filter(Boolean);
  const rows = await db.select({ id: serviceRequests.id }).from(serviceRequests).where(where.length ? and(...(where as never[])) : undefined).orderBy(desc(serviceRequests.createdAt)).limit(200);
  return Promise.all(rows.map((r) => getRequest(db, actor, r.id)));
}

// ---- Billing (simulated) ---------------------------------------------------------------------------------------

const monthBounds = (period: string) => {
  assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), "A period is a month, written YYYY-MM.");
  const [y, m] = period.split("-").map(Number);
  // Boise is UTC-7 or UTC-6; a margin of a day either side is filtered precisely with boiseMonth below.
  return { start: new Date(Date.UTC(y, m - 1, 1) - 86_400_000), end: new Date(Date.UTC(y, m, 1) + 86_400_000) };
};

async function periodRequests(db: DB, orgId: string, period: string) {
  const { start, end } = monthBounds(period);
  const rows = await db.select().from(serviceRequests).where(and(eq(serviceRequests.orgId, orgId), gte(serviceRequests.createdAt, start), lt(serviceRequests.createdAt, end)));
  return rows.filter((r) => boiseMonth(r.createdAt) === period);
}

const invoiceView = async (db: DB, inv: typeof invoices.$inferSelect, actor: Actor): Promise<InvoiceView> => ({
  id: inv.id,
  number: isOperator(actor) ? inv.number : 0,
  label: isOperator(actor) ? INVOICE_LABEL(inv.number) : `Invoice ${inv.period}`,
  orgId: inv.orgId,
  period: inv.period,
  status: inv.status,
  simulated: true,
  totalCents: inv.totalCents,
  issuedAt: inv.issuedAt?.toISOString() ?? null,
  paidAt: inv.paidAt?.toISOString() ?? null,
  lines: (await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))).map((l) => ({ description: l.description, kind: l.kind, quantity: l.quantity, unitCents: l.unitCents, amountCents: l.amountCents })),
});

/**
 * The month's invoice for a customer, from its agreements: each active service's monthly fee, its setup fee in the
 * month it started, and requests beyond those included. Simulated: no payment system is called, and the database
 * refuses any invoice that isn't marked simulated. A draft is rebuilt; an issued invoice is never changed.
 */
export async function generateInvoice(db: DB, actor: Actor, input: { orgId: string; period: string }, requestKey: string): Promise<InvoiceView> {
  requireOperator(actor);
  const { orgId, period } = input;
  monthBounds(period);
  const services = (await db.select().from(customerServices).where(eq(customerServices.orgId, orgId))).filter((s) => s.agreementStartedAt && boiseMonth(s.agreementStartedAt) <= period && (!s.endedAt || boiseMonth(s.endedAt) >= period));
  const requests = await periodRequests(db, orgId, period);
  const lines: (typeof invoiceLines.$inferInsert)[] = [];
  for (const s of services) {
    if (s.monthlyCents > 0) lines.push({ id: randomUUID(), orgId, invoiceId: "", serviceId: s.id, kind: "subscription", description: `${s.name}: ${planByKey(s.planKey)?.name ?? s.planKey} plan, ${period}`, quantity: 1, unitCents: s.monthlyCents, amountCents: s.monthlyCents });
    if (s.setupCents > 0 && boiseMonth(s.agreementStartedAt!) === period) lines.push({ id: randomUUID(), orgId, invoiceId: "", serviceId: s.id, kind: "setup", description: `${s.name}: setup`, quantity: 1, unitCents: s.setupCents, amountCents: s.setupCents });
    const used = requests.filter((r) => r.serviceId === s.id && r.status !== "failed").length;
    const over = Math.max(0, used - s.includedRequests);
    if (over > 0 && s.overageCents > 0) lines.push({ id: randomUUID(), orgId, invoiceId: "", serviceId: s.id, kind: "overage", description: `${s.name}: ${over} request${over === 1 ? "" : "s"} beyond the ${s.includedRequests} included`, quantity: over, unitCents: s.overageCents, amountCents: over * s.overageCents });
  }
  const total = lines.reduce((n, l) => n + l.amountCents, 0);
  await once(db, orgId, actor, requestKey, `Invoice for ${period} prepared by ${actor.name} (simulated)`, async () => {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      const month = await tx.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.period, period))).orderBy(desc(invoices.number));
      const existing = month.find((i) => i.status !== "void");
      assert(!existing || existing.status === "draft", "This month's invoice was already issued; it can't be rebuilt. Void it to issue a replacement.", "conflict");
      const voided = month.find((i) => i.status === "void");
      const invoiceId = existing?.id ?? randomUUID();
      if (existing) {
        await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
        await tx.update(invoices).set({ totalCents: total }).where(eq(invoices.id, invoiceId));
      } else await tx.insert(invoices).values({ id: invoiceId, orgId, period, status: "draft", simulated: true, totalCents: total, createdById: actor.id!, replacesInvoiceId: voided?.id ?? null });
      if (lines.length) await tx.insert(invoiceLines).values(lines.map((l) => ({ ...l, orgId, invoiceId })));
    });
  }, false);
  const [inv] = (await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.period, period)))).filter((i) => i.status !== "void");
  return invoiceView(db, inv, actor);
}

/** Issues, records the (simulated) payment of, or voids an invoice. Nothing is charged or sent anywhere. */
export async function setInvoiceStatus(db: DB, actor: Actor, id: string, action: "issue" | "mark_paid" | "void", requestKey: string): Promise<InvoiceView> {
  requireOperator(actor);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  assert(inv, "That invoice doesn't exist.", "not_found");
  const move = { issue: { from: ["draft"], to: "issued" as const }, mark_paid: { from: ["issued"], to: "paid" as const }, void: { from: ["draft", "issued"], to: "void" as const } }[action];
  assert(move.from.includes(inv.status), `A ${inv.status} invoice can't be ${action === "mark_paid" ? "marked paid" : `${action}d`}.`, "conflict");
  await once(db, inv.orgId, actor, requestKey, `Invoice ${INVOICE_LABEL(inv.number)} ${action === "mark_paid" ? "marked paid (simulated)" : `${action}d`} by ${actor.name}`, async () => {
    const patch: Partial<typeof invoices.$inferInsert> = { status: move.to };
    if (action === "issue") patch.issuedAt = new Date();
    if (action === "mark_paid") patch.paidAt = new Date();
    const done = await db.update(invoices).set(patch).where(and(eq(invoices.id, id), inArray(invoices.status, move.from as never))).returning({ id: invoices.id });
    assert(done.length === 1, "The invoice changed state.", "conflict");
  }, action !== "void");
  return invoiceView(db, (await db.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0], actor);
}

/** A customer sees its own issued and paid invoices; operators see every one of a customer's, drafts included. */
export async function listInvoices(db: DB, actor: Actor, orgId?: string): Promise<InvoiceView[]> {
  requireParty(actor);
  const target = isClient(actor) ? actor.orgId! : orgId;
  const rows = target ? await db.select().from(invoices).where(eq(invoices.orgId, target)).orderBy(desc(invoices.period)) : await db.select().from(invoices).orderBy(desc(invoices.period));
  return Promise.all(rows.filter((i) => isOperator(actor) || i.status === "issued" || i.status === "paid").map((i) => invoiceView(db, i, actor)));
}

// ---- Reports and costs -----------------------------------------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The customer's report for a month: what KELQOR handled, how fast, against what was committed, and what it produced. */
export async function customerReport(db: DB, actor: Actor, orgId: string, period: string): Promise<CustomerReport> {
  requireParty(actor);
  assert(inScope(actor, orgId), "That report doesn't exist.", "not_found");
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  assert(org, "That customer doesn't exist.", "not_found");
  const services = (await db.select().from(customerServices).where(eq(customerServices.orgId, orgId))).filter((s) => s.status !== "draft");
  const requests = await periodRequests(db, orgId, period);
  const completed = requests.filter((r) => r.status === "completed" && r.completedAt);
  const hours = completed.map((r) => (r.completedAt!.getTime() - r.createdAt.getTime()) / 3_600_000);
  const commitment = (r: RequestRow) => services.find((s) => s.id === r.serviceId)?.config.turnaroundHours ?? 24;
  const [inv] = (await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.period, period)))).filter((i) => i.status !== "void");
  return {
    orgId,
    orgName: org.name,
    period,
    services: services.map((s) => {
      const mine = requests.filter((r) => r.serviceId === s.id);
      return { id: s.id, name: s.name, status: s.status, requests: mine.length, completed: mine.filter((r) => r.status === "completed").length, included: s.includedRequests, overage: Math.max(0, mine.filter((r) => r.status !== "failed").length - s.includedRequests) };
    }),
    requestsReceived: requests.length,
    requestsCompleted: completed.length,
    medianTurnaroundHours: median(hours) === null ? null : Math.round(median(hours)! * 10) / 10,
    withinCommitment: { met: completed.filter((r) => (r.completedAt!.getTime() - r.createdAt.getTime()) / 3_600_000 <= commitment(r)).length, total: completed.length },
    quotedValueCents: completed.filter((r) => r.deliverable?.kind === "quote").reduce((n, r) => n + (r.deliverable?.totalCents ?? 0), 0),
    questionsRaised: requests.reduce((n, r) => n + (r.processing?.questions.length ?? 0), 0),
    approvalsGiven: requests.filter((r) => r.needsCustomerApproval && r.status === "completed" && r.customerDecidedAt).length,
    invoiceTotalCents: inv && (isOperator(actor) || inv.status !== "draft") ? inv.totalCents : null,
    simulated: requests.some((r) => r.simulated),
  };
}

/** What a customer cost KELQOR to serve in a month, against what it was invoiced. Operators only. */
export async function customerCosts(db: DB, actor: Actor, orgId: string, period: string): Promise<CustomerCosts> {
  requireOperator(actor);
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  assert(org, "That customer doesn't exist.", "not_found");
  const requests = await periodRequests(db, orgId, period);
  const [inv] = (await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.period, period)))).filter((i) => i.status !== "void");
  const revenue = inv ? inv.totalCents : 0;
  const ai = requests.reduce((n, r) => n + r.aiCostMicros, 0);
  const minutes = requests.reduce((n, r) => n + (r.reviewMinutes ?? 0), 0);
  const reviewCost = Math.round((minutes / 60) * REVIEW_LABOR_CENTS_PER_HOUR);
  const sources = new Set(requests.map((r) => r.costSource));
  return {
    orgId,
    orgName: org.name,
    period,
    revenueCents: revenue,
    aiCostMicros: ai,
    aiCostSource: requests.length === 0 ? "none" : sources.size > 1 ? "mixed" : ([...sources][0] as "simulated" | "ledger"),
    reviewMinutes: minutes,
    reviewCostCents: reviewCost,
    marginCents: revenue - reviewCost - Math.ceil(ai / 10_000),
    estimated: true,
  };
}
