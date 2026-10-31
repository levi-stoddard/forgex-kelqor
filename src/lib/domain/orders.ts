import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DB } from "../db";
import {
  acceptanceCriteria,
  assignments,
  builderProfiles,
  carePlans,
  deliveries,
  events,
  messages,
  milestones,
  orgs,
  payments,
  payouts,
  reviews,
  users,
  workOrders,
} from "../db/schema";
import { money, safeUrl } from "../format";
import { draftScope, type DraftScope } from "../scoping";
import { SYSTEM_ACTOR, type Actor } from "./actor";
import { orderClass } from "./classification";
import { assert, DomainError } from "./errors";
import { careBuilderShareCents, orderEconomics, PRICING, type OrderEconomics } from "./pricing";
import { newId, notify, notifyOperators, orderRef, recordEvent, type Notice } from "./records";
import { canTransition, transition, type ActorRole, type OrderEvent } from "./state-machine";
import { TERMS_VERSION, type DataClass, type Intake, type PaymentMethod, type RecordVisibility, type Scope } from "./types";

export type WorkOrder = typeof workOrders.$inferSelect;
type WorkOrderPatch = Partial<typeof workOrders.$inferInsert>;

const appUrl = () => process.env.APP_URL || "http://localhost:3000";
export const orderUrl = (id: string) => `${appUrl()}/orders/${id}`;

/** Test payments exist only for local walkthroughs; they never count as revenue. */
export function testPaymentsAllowed(): boolean {
  return process.env.ALLOW_TEST_PAYMENTS === "true" && process.env.NODE_ENV !== "production";
}

function inTx<T>(db: DB, fn: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as DB));
}

function requireRole(actor: Actor, ...roles: ActorRole[]): void {
  if (!roles.includes(actor.role)) throw new DomainError("You don't have permission to do that.", "forbidden");
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function getOrder(db: DB, id: string): Promise<WorkOrder> {
  const [o] = await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
  if (!o) throw new DomainError("Work Order not found.", "not_found");
  return o;
}

export async function canViewOrder(db: DB, actor: Actor, o: WorkOrder): Promise<boolean> {
  switch (actor.role) {
    case "operator":
    case "system":
      return true;
    case "client":
      return actor.orgId !== null && actor.orgId === o.orgId;
    case "builder": {
      if (!actor.builderId) return false;
      if (o.assignedBuilderId === actor.builderId) return true;
      // Before accepting, only an approved builder with an open invitation may read the scope.
      const invite = await db
        .select({ id: assignments.id })
        .from(assignments)
        .innerJoin(builderProfiles, eq(builderProfiles.id, assignments.builderId))
        .where(
          and(
            eq(assignments.workOrderId, o.id),
            eq(assignments.builderId, actor.builderId),
            eq(assignments.status, "invited"),
            eq(builderProfiles.status, "approved"),
          ),
        )
        .limit(1);
      return invite.length > 0;
    }
  }
}

/** Load a Work Order the actor may see; anything else looks like it doesn't exist. */
async function getOrderFor(db: DB, actor: Actor, id: string): Promise<WorkOrder> {
  const o = await getOrder(db, id);
  if (!(await canViewOrder(db, actor, o))) throw new DomainError("Work Order not found.", "not_found");
  return o;
}

/** Apply a state-machine event, guarded so a concurrent change can't be silently overwritten. */
async function applyEvent(
  db: DB,
  o: WorkOrder,
  event: OrderEvent,
  actor: Actor,
  patch: WorkOrderPatch = {},
  data: Record<string, unknown> = {},
): Promise<WorkOrder> {
  const to = transition(o.status, event, actor.role);
  const [updated] = await db
    .update(workOrders)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(workOrders.id, o.id), eq(workOrders.status, o.status)))
    .returning();
  if (!updated) throw new DomainError("This Work Order just changed. Refresh the page and try again.", "conflict");
  await recordEvent(db, { workOrderId: o.id, actorId: actor.id, type: event, data: { from: o.status, to, ...data } });
  return updated;
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

async function clientEmails(db: DB, orgId: string): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "client")));
  return rows.map((r) => r.email);
}

async function builderEmail(db: DB, builderId: string | null): Promise<string | null> {
  if (!builderId) return null;
  const [row] = await db
    .select({ email: users.email })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(builderProfiles.id, builderId))
    .limit(1);
  return row?.email ?? null;
}

async function notifyClients(db: DB, o: WorkOrder, n: Omit<Notice, "workOrderId" | "link">) {
  for (const email of await clientEmails(db, o.orgId)) await notify(db, email, { ...n, link: orderUrl(o.id), workOrderId: o.id });
}

async function notifyBuilder(db: DB, o: WorkOrder, n: Omit<Notice, "workOrderId" | "link">, builderId = o.assignedBuilderId) {
  const email = await builderEmail(db, builderId);
  if (email) await notify(db, email, { ...n, link: orderUrl(o.id), workOrderId: o.id });
}

async function notifyOps(db: DB, o: WorkOrder, n: Omit<Notice, "workOrderId" | "link">) {
  await notifyOperators(db, { ...n, link: orderUrl(o.id), workOrderId: o.id });
}

const label = (o: WorkOrder) => `${orderRef(o.number)} ${o.title}`;

// ---------------------------------------------------------------------------
// Request and scope
// ---------------------------------------------------------------------------

async function writeScopeRows(db: DB, workOrderId: string, scope: Scope): Promise<void> {
  await db.delete(acceptanceCriteria).where(eq(acceptanceCriteria.workOrderId, workOrderId));
  await db.delete(milestones).where(eq(milestones.workOrderId, workOrderId));
  if (scope.acceptanceCriteria.length) {
    await db
      .insert(acceptanceCriteria)
      .values(scope.acceptanceCriteria.map((text, position) => ({ id: newId(), workOrderId, position, text })));
  }
  if (scope.milestones.length) {
    await db.insert(milestones).values(
      scope.milestones.map((m, position) => ({ id: newId(), workOrderId, position, title: m.title, description: m.description })),
    );
  }
}

export function validateScope(title: string, scope: Scope): void {
  assert(title.trim().length >= 3, "Give the Work Order a title.");
  assert(scope.summary.trim().length > 0, "Add a one-line summary.");
  assert(scope.acceptanceCriteria.length > 0, "Add at least one acceptance criterion.");
  assert(scope.acceptanceCriteria.length <= 15, "Keep it to 15 acceptance criteria or fewer.");
  assert(scope.milestones.length <= 6, "Keep it to 6 milestones or fewer.");
  assert(
    Number.isFinite(scope.estimateHoursLow) && scope.estimateHoursLow > 0 && scope.estimateHoursHigh >= scope.estimateHoursLow,
    "The hours estimate needs a low value above zero and a high value at least as large.",
  );
}

/**
 * A client submits a request for their own company, or an operator writes one up for a client after a sales
 * conversation (owner-led selling); the operator then passes `orgId`.
 */
export async function createWorkOrder(
  db: DB,
  actor: Actor,
  intake: Intake,
  opts: { draft?: DraftScope; isDemo?: boolean; orgId?: string } = {},
): Promise<WorkOrder> {
  requireRole(actor, "client", "operator");
  const orgId = actor.role === "operator" ? opts.orgId : actor.orgId;
  assert(orgId && actor.id, actor.role === "operator" ? "Choose the client company." : "Your account isn't linked to a company.", "forbidden");
  if (actor.role === "operator") {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    assert(org, "Client company not found.", "not_found");
  }
  const problem = intake.problem.trim();
  assert(problem.length >= 20, "Describe the problem in a sentence or two (at least 20 characters).");
  assert(problem.length <= 5000, "Please keep the description under 5,000 characters.");
  // AI drafting happens before the transaction: it can take a while and must not hold the database.
  const draft = opts.draft ?? (await draftScope(intake));
  const createdById = actor.id;
  return inTx(db, async (tx) => {
    const id = newId();
    const [o] = await tx
      .insert(workOrders)
      .values({
        id,
        orgId,
        createdById,
        title: draft.title,
        category: draft.category,
        status: "submitted",
        intake,
        scope: draft.scope,
        scopeSource: draft.source,
        scopeModel: draft.model,
        aiCostMicros: draft.costMicros,
        isDemo: opts.isDemo ?? false,
      })
      .returning();
    await writeScopeRows(tx, id, draft.scope);
    await recordEvent(tx, {
      workOrderId: id,
      actorId: actor.id,
      type: "created",
      data: { scopeSource: draft.source, model: draft.model, aiError: draft.aiError ?? null },
    });
    if (actor.role === "client") {
      await notifyOps(tx, o, {
        subject: `New request ${label(o)}`,
        body: `${actor.name} submitted a request. A ${draft.source === "ai" ? "AI-drafted" : "template"} scope is ready for review and pricing.`,
      });
    }
    return o;
  });
}

export async function saveScope(db: DB, actor: Actor, orderId: string, input: { title: string; scope: Scope }): Promise<WorkOrder> {
  requireRole(actor, "operator");
  validateScope(input.title, input.scope);
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    assert(o.status === "submitted", "The scope can only be edited before the quote is sent.", "conflict");
    const [updated] = await tx
      .update(workOrders)
      .set({ title: input.title.trim(), scope: input.scope, scopeSource: "operator", updatedAt: new Date() })
      .where(and(eq(workOrders.id, orderId), eq(workOrders.status, "submitted")))
      .returning();
    if (!updated) throw new DomainError("This Work Order just changed. Refresh and try again.", "conflict");
    await writeScopeRows(tx, orderId, input.scope);
    await recordEvent(tx, { workOrderId: orderId, actorId: actor.id, type: "scope_edited" });
    return updated;
  });
}

export async function redraftScope(db: DB, actor: Actor, orderId: string, operatorNotes: string): Promise<DraftScope> {
  requireRole(actor, "operator");
  const before = await getOrder(db, orderId);
  assert(before.status === "submitted", "The scope can only be redrafted before the quote is sent.", "conflict");
  const draft = await draftScope(before.intake, { operatorNotes: operatorNotes.trim() || undefined });
  await inTx(db, async (tx) => {
    const [updated] = await tx
      .update(workOrders)
      .set({
        title: draft.title,
        category: draft.category,
        scope: draft.scope,
        scopeSource: draft.source,
        scopeModel: draft.model,
        aiCostMicros: sql`${workOrders.aiCostMicros} + ${draft.costMicros}`,
        updatedAt: new Date(),
      })
      .where(and(eq(workOrders.id, orderId), eq(workOrders.status, "submitted")))
      .returning();
    if (!updated) throw new DomainError("This Work Order just changed. Refresh and try again.", "conflict");
    await writeScopeRows(tx, orderId, draft.scope);
    await recordEvent(tx, {
      workOrderId: orderId,
      actorId: actor.id,
      type: "scope_redrafted",
      data: { scopeSource: draft.source, model: draft.model, aiError: draft.aiError ?? null },
    });
  });
  return draft;
}

// ---------------------------------------------------------------------------
// Quote, acceptance and payment
// ---------------------------------------------------------------------------

export async function sendQuote(
  db: DB,
  actor: Actor,
  orderId: string,
  q: { priceCents: number; builderPayoutCents: number; carePriceCents: number | null; careIncluded?: boolean },
): Promise<WorkOrder> {
  requireRole(actor, "operator");
  assert(Number.isInteger(q.priceCents) && q.priceCents >= 25_000, "Set a price of at least $250.");
  assert(Number.isInteger(q.builderPayoutCents) && q.builderPayoutCents >= 0, "Set the builder payout (0 when ForgeX delivers in-house).");
  assert(q.builderPayoutCents < q.priceCents, "The builder payout must be less than the client price.");
  assert(q.carePriceCents === null || (Number.isInteger(q.carePriceCents) && q.carePriceCents > 0), "The monthly price must be a positive amount, or blank.");
  assert(!q.careIncluded || q.carePriceCents !== null, "Set the monthly fee, or untick 'monthly fee is part of the service'.");
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.workOrderId, orderId));
    assert(n > 0, "Add at least one acceptance criterion before sending the quote.");
    const now = new Date();
    const updated = await applyEvent(
      tx,
      o,
      "send_quote",
      actor,
      {
        priceCents: q.priceCents,
        builderPayoutCents: q.builderPayoutCents,
        carePriceCents: q.carePriceCents,
        careIncluded: Boolean(q.careIncluded && q.carePriceCents),
        quoteSentAt: now,
        quoteExpiresAt: new Date(now.getTime() + PRICING.quoteValidDays * 24 * 60 * 60 * 1000),
      },
      { priceCents: q.priceCents },
    );
    const monthly = updated.careIncluded ? `, then ${money(q.carePriceCents)}/month after go-live` : "";
    await notifyClients(tx, updated, {
      subject: `Your fixed-price quote for ${label(o)} is ready`,
      body: `${money(q.priceCents)} fixed price${monthly}, valid for ${PRICING.quoteValidDays} days. Review the scope and acceptance criteria, then accept to get started.`,
    });
    return updated;
  });
}

export async function requestQuoteChanges(db: DB, actor: Actor, orderId: string, message: string): Promise<WorkOrder> {
  requireRole(actor, "client");
  const text = message.trim();
  assert(text.length >= 3, "Tell us what should change.");
  assert(text.length <= 5000, "Please keep it under 5,000 characters.");
  return inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    // A scope change voids staffing: the old payout no longer matches, so invitations and any assignment are withdrawn.
    await tx
      .update(assignments)
      .set({ status: "withdrawn", respondedAt: new Date() })
      .where(and(eq(assignments.workOrderId, o.id), inArray(assignments.status, ["invited", "accepted"])));
    if (o.assignedBuilderId) {
      await notifyBuilder(tx, o, {
        subject: `Scope changing: ${label(o)}`,
        body: "The client asked for changes before work started, so this assignment is withdrawn. ForgeX will re-invite you if the revised scope fits.",
      });
    }
    const updated = await applyEvent(tx, o, "request_quote_changes", actor, { assignedBuilderId: null });
    await tx.insert(messages).values({ id: newId(), workOrderId: o.id, authorId: actor.id!, body: `Requested changes to the quote: ${text}` });
    await notifyOps(tx, o, { subject: `Quote changes requested on ${label(o)}`, body: text });
    return updated;
  });
}

export async function acceptQuote(db: DB, actor: Actor, orderId: string, agreed: boolean): Promise<WorkOrder> {
  requireRole(actor, "client");
  assert(agreed, "Please confirm that you agree to the Work Order terms.");
  return inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    assert(
      o.quoteExpiresAt !== null && o.quoteExpiresAt.getTime() > Date.now(),
      "This quote has expired. Use \"Request changes\" to ask for a refreshed quote.",
      "conflict",
    );
    const updated = await applyEvent(tx, o, "accept_quote", actor, {
      acceptedAt: new Date(),
      acceptedById: actor.id,
      termsVersion: TERMS_VERSION,
    });
    await notifyOps(tx, o, { subject: `Quote accepted: ${label(o)}`, body: `${actor.name} accepted the ${money(o.priceCents)} quote. Payment is next.` });
    return updated;
  });
}

/** Start work automatically once the order is both funded and staffed. */
async function maybeStart(db: DB, o: WorkOrder): Promise<WorkOrder> {
  if (o.status !== "funded" || !o.assignedBuilderId) return o;
  const started = await applyEvent(db, o, "start_work", SYSTEM_ACTOR, { startedAt: new Date() });
  await notifyBuilder(db, started, { subject: `Start work: ${label(o)}`, body: "The Work Order is funded and assigned to you. You can begin." });
  await notifyClients(db, started, { subject: `Work has started on ${label(o)}`, body: "Your builder is confirmed and the work has started." });
  return started;
}

export const EXTRA_PAYMENT_NOTE = "Unexpected extra payment: refund required";
export const PROCESSING_NOTE = "Bank payment processing";

/** Remember a Checkout session as soon as it exists, so a later Stripe report can never go unmatched. */
export async function recordPendingStripePayment(
  db: DB,
  actor: Actor,
  orderId: string,
  s: { sessionId: string; amountCents: number },
): Promise<void> {
  requireRole(actor, "client");
  await inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    assert(o.status === "accepted", "This Work Order isn't waiting for payment.", "conflict");
    await tx.insert(payments).values({
      id: newId(),
      workOrderId: o.id,
      amountCents: s.amountCents,
      method: "stripe",
      status: "pending",
      stripeSessionId: s.sessionId,
      recordedById: actor.id,
    });
  });
}

/** Stripe reported that a session is still processing (ACH) or will not pay (expired, bank payment failed). */
export async function markStripeSession(db: DB, sessionId: string, state: "processing" | "failed", note: string): Promise<void> {
  await inTx(db, async (tx) => {
    const [row] = await tx.select().from(payments).where(eq(payments.stripeSessionId, sessionId)).for("update").limit(1);
    if (!row || row.status !== "pending") return;
    await tx
      .update(payments)
      .set(state === "failed" ? { status: "failed", reference: note } : { reference: note })
      .where(eq(payments.id, row.id));
    await recordEvent(tx, { workOrderId: row.workOrderId, type: state === "failed" ? "payment_failed" : "payment_processing", data: { note } });
    if (state === "failed") {
      const o = await getOrder(tx, row.workOrderId);
      await notifyClients(tx, o, { subject: `Payment didn't go through for ${label(o)}`, body: `${note} You can try again from the Work Order page.` });
    }
  });
}

export async function recordPayment(
  db: DB,
  actor: Actor,
  orderId: string,
  p: { method: PaymentMethod; reference?: string; stripeSessionId?: string; stripePaymentIntentId?: string | null; amountCents?: number; livemode?: boolean },
): Promise<WorkOrder> {
  requireRole(actor, "operator", "system");
  if (p.method === "test") assert(testPaymentsAllowed(), "Test payments are turned off.", "forbidden");
  if (p.method === "offline") assert((p.reference ?? "").trim().length >= 3, "Add the bank or invoice reference for this payment.");
  if (p.method === "stripe") assert(p.stripeSessionId, "A Stripe payment needs its Checkout session.");
  return inTx(db, async (tx) => {
    let pendingId: string | null = null;
    if (p.stripeSessionId) {
      // Lock the session's row: the webhook and the success redirect can report the same payment at once.
      const [existing] = await tx.select().from(payments).where(eq(payments.stripeSessionId, p.stripeSessionId)).for("update").limit(1);
      if (existing && existing.status !== "pending") return getOrder(tx, orderId); // already settled
      pendingId = existing?.id ?? null;
    }
    const o = await getOrder(tx, orderId);
    assert(o.priceCents, "This Work Order has no price yet.");
    const amount = p.amountCents ?? o.priceCents;
    const settled = {
      workOrderId: o.id,
      amountCents: amount,
      method: p.method,
      status: "succeeded" as const,
      stripeSessionId: p.stripeSessionId ?? null,
      stripePaymentIntentId: p.stripePaymentIntentId ?? null,
      // Stripe's own live/test flag decides whether a Stripe payment can count as real money.
      livemode: p.method === "stripe" ? (p.livemode ?? null) : null,
      recordedById: actor.id,
      succeededAt: new Date(),
    };
    const save = async (reference: string) => {
      if (pendingId) await tx.update(payments).set({ ...settled, reference }).where(eq(payments.id, pendingId));
      else await tx.insert(payments).values({ id: newId(), ...settled, reference });
    };
    if (p.method === "stripe" && (o.status !== "accepted" || amount !== o.priceCents)) {
      // Money Stripe already captured (a second tab, a late ACH payment, a cancelled order) must never go
      // unrecorded: keep it and flag it for refund instead of rejecting it.
      await save(EXTRA_PAYMENT_NOTE);
      await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "extra_payment", data: { amountCents: amount, status: o.status } });
      await notifyOps(tx, o, {
        subject: `Refund needed: extra payment on ${label(o)}`,
        body: `Stripe reported a ${money(amount)} payment while the Work Order was ${o.status.replaceAll("_", " ")}. Refund it from the Work Order page.`,
      });
      return o;
    }
    assert(amount === o.priceCents, `The payment (${money(amount)}) doesn't match the price (${money(o.priceCents)}).`);
    const funded = await applyEvent(tx, o, "record_payment", actor, { fundedAt: new Date() }, { method: p.method });
    await save((p.reference ?? "").trim());
    const testNote = p.method === "test" ? " (TEST payment: no money moved)" : "";
    await notifyClients(tx, funded, { subject: `Payment received for ${label(o)}${testNote}`, body: `We received ${money(amount)}. Work starts now, and you'll check the delivery against the acceptance criteria before it's complete.` });
    await notifyOps(tx, funded, { subject: `Funded: ${label(o)}${testNote}`, body: funded.assignedBuilderId ? "Builder already assigned; work starts now." : "Assign a builder to start work." });
    return maybeStart(tx, funded);
  });
}

// ---------------------------------------------------------------------------
// Staffing
// ---------------------------------------------------------------------------

const STAFFABLE = ["quoted", "accepted", "funded"] as const;

export async function inviteBuilder(
  db: DB,
  actor: Actor,
  orderId: string,
  input: { builderId: string; payoutCents?: number | null; note?: string },
): Promise<string> {
  requireRole(actor, "operator");
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    assert((STAFFABLE as readonly string[]).includes(o.status), "Invite a builder after the quote is sent and before work starts.", "conflict");
    assert(!o.assignedBuilderId, "A builder is already assigned.", "conflict");
    const [b] = await tx.select().from(builderProfiles).where(eq(builderProfiles.id, input.builderId)).limit(1);
    assert(b && b.status === "approved", "Only approved builders can be invited.");
    const payout = input.payoutCents ?? o.builderPayoutCents;
    assert(payout !== null && payout >= 0, "Set a builder payout first (0 when ForgeX delivers in-house).");
    assert(!o.priceCents || payout < o.priceCents, "The payout must be less than the client price.");
    // One open invitation at a time keeps it clear who is expected to respond.
    await tx
      .update(assignments)
      .set({ status: "withdrawn", respondedAt: new Date() })
      .where(and(eq(assignments.workOrderId, o.id), eq(assignments.status, "invited")));
    const id = newId();
    await tx.insert(assignments).values({ id, workOrderId: o.id, builderId: b.id, payoutCents: payout, note: (input.note ?? "").trim() });
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "builder_invited", data: { builderId: b.id } });
    await notifyBuilder(
      tx,
      o,
      {
        subject: `Work Order invitation: ${label(o)}`,
        body: payout
          ? `You're invited to deliver this Work Order for a fixed payout of ${money(payout)}. Review the scope and acceptance criteria, then accept or decline.`
          : "You're invited to deliver this Work Order in-house (no payout). Review the scope and acceptance criteria, then accept or decline.",
      },
      b.id,
    );
    return id;
  });
}

export async function respondToAssignment(db: DB, actor: Actor, assignmentId: string, accept: boolean): Promise<WorkOrder> {
  requireRole(actor, "builder");
  assert(actor.builderId, "Your builder profile is missing.", "forbidden");
  const builderId = actor.builderId;
  return inTx(db, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).limit(1);
    assert(a && a.builderId === builderId, "Invitation not found.", "not_found");
    assert(a.status === "invited", "This invitation is no longer open.", "conflict");
    const o = await getOrder(tx, a.workOrderId);
    // Respond only while the invitation is still open (it may be withdrawn at the same moment).
    const respond = async (status: "accepted" | "declined") => {
      const [row] = await tx
        .update(assignments)
        .set({ status, respondedAt: new Date() })
        .where(and(eq(assignments.id, a.id), eq(assignments.status, "invited")))
        .returning({ id: assignments.id });
      assert(row, "This invitation is no longer open.", "conflict");
    };
    if (!accept) {
      await respond("declined");
      await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "assignment_declined" });
      await notifyOps(tx, o, { subject: `Invitation declined: ${label(o)}`, body: `${actor.name} declined. Invite another builder.` });
      return o;
    }
    const [profile] = await tx.select({ status: builderProfiles.status }).from(builderProfiles).where(eq(builderProfiles.id, builderId)).limit(1);
    assert(profile?.status === "approved", "Your builder account isn't active, so this invitation can't be accepted.", "forbidden");
    assert((STAFFABLE as readonly string[]).includes(o.status), "This Work Order is no longer open for assignment.", "conflict");
    assert(!o.priceCents || a.payoutCents < o.priceCents, "This invitation is out of date. ForgeX will send a new one.", "conflict");
    await respond("accepted");
    const [assigned] = await tx
      .update(workOrders)
      .set({ assignedBuilderId: builderId, builderPayoutCents: a.payoutCents, updatedAt: new Date() })
      .where(and(eq(workOrders.id, o.id), isNull(workOrders.assignedBuilderId)))
      .returning();
    if (!assigned) throw new DomainError("Another builder was just assigned.", "conflict");
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "assignment_accepted" });
    await notifyOps(tx, o, { subject: `Builder confirmed: ${label(o)}`, body: `${actor.name} accepted the Work Order.` });
    await notifyClients(tx, o, { subject: `Your builder is confirmed for ${label(o)}`, body: `${actor.name} will deliver this Work Order.` });
    return maybeStart(tx, assigned);
  });
}

// ---------------------------------------------------------------------------
// Delivery and acceptance
// ---------------------------------------------------------------------------

export async function setMilestoneDone(db: DB, actor: Actor, milestoneId: string, done: boolean): Promise<void> {
  requireRole(actor, "builder", "operator");
  await inTx(db, async (tx) => {
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
    assert(m, "Milestone not found.", "not_found");
    const o = await getOrder(tx, m.workOrderId);
    if (actor.role === "builder") assert(o.assignedBuilderId === actor.builderId, "Only the assigned builder can update milestones.", "forbidden");
    assert(o.status === "in_progress", "Milestones can be updated while work is in progress.", "conflict");
    await tx
      .update(milestones)
      .set({ status: done ? "done" : "planned", completedAt: done ? new Date() : null })
      .where(eq(milestones.id, m.id));
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: done ? "milestone_done" : "milestone_reopened", data: { title: m.title } });
  });
}

export async function submitDelivery(
  db: DB,
  actor: Actor,
  orderId: string,
  input: { summary: string; links: string[]; evidence: Record<string, string> },
): Promise<WorkOrder> {
  requireRole(actor, "builder");
  const summary = input.summary.trim();
  assert(summary.length >= 10, "Summarize what you delivered (at least 10 characters).");
  const links: string[] = [];
  for (const raw of input.links.map((l) => l.trim()).filter(Boolean)) {
    const url = safeUrl(raw);
    assert(url, `"${raw}" isn't a valid http(s) link.`);
    links.push(url);
  }
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    assert(o.assignedBuilderId !== null && o.assignedBuilderId === actor.builderId, "Only the assigned builder can deliver.", "forbidden");
    const criteria = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.workOrderId, o.id)).orderBy(asc(acceptanceCriteria.position));
    assert(
      criteria.every((c) => (input.evidence[c.id] ?? "").trim().length > 0),
      "Add evidence for every acceptance criterion: what you tested and where the client can see it.",
    );
    const delivered = await applyEvent(tx, o, "submit_delivery", actor, { deliveredAt: new Date() });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveries).where(eq(deliveries.workOrderId, o.id));
    await tx.insert(deliveries).values({ id: newId(), workOrderId: o.id, builderId: o.assignedBuilderId, round: n + 1, summary, links });
    for (const c of criteria) {
      await tx
        .update(acceptanceCriteria)
        .set({ evidence: input.evidence[c.id].trim(), status: "pending", reviewNote: "", updatedAt: new Date() })
        .where(eq(acceptanceCriteria.id, c.id));
    }
    await notifyClients(tx, delivered, {
      subject: `Ready for your review: ${label(o)}`,
      body: "The builder submitted the delivery with evidence for each acceptance criterion. Check each one and accept or request a revision.",
    });
    return delivered;
  });
}

/** Mark delivered work complete and queue the builder's payout. */
async function completeOrder(
  tx: DB,
  o: WorkOrder,
  event: "accept_delivery" | "resolve_complete",
  actor: Actor,
  note: string,
): Promise<WorkOrder> {
  assert(o.assignedBuilderId && o.builderPayoutCents !== null, "This Work Order has no assigned builder or payout.", "conflict");
  const completed = await applyEvent(tx, o, event, actor, { completedAt: new Date() }, note ? { note } : {});
  const inHouse = o.builderPayoutCents === 0;
  if (!inHouse) {
    await tx
      .insert(payouts)
      .values({ id: newId(), workOrderId: o.id, builderId: o.assignedBuilderId, amountCents: o.builderPayoutCents })
      .onConflictDoNothing();
  }
  // Setup + monthly services: the monthly service starts at go-live, as the client agreed in the quote.
  if (o.careIncluded && o.carePriceCents) {
    await tx
      .insert(carePlans)
      .values({
        id: newId(),
        workOrderId: o.id,
        orgId: o.orgId,
        builderId: o.assignedBuilderId,
        monthlyPriceCents: o.carePriceCents,
        builderShareCents: inHouse ? 0 : careBuilderShareCents(o.carePriceCents),
      })
      .onConflictDoNothing();
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "care_requested", data: { included: true } });
  }
  await notifyBuilder(tx, completed, {
    subject: `Accepted: ${label(o)}`,
    body: inHouse ? "The work was accepted (in-house delivery, no payout)." : `The work was accepted. Your payout of ${money(o.builderPayoutCents)} is queued.`,
  });
  await notifyOps(tx, completed, {
    subject: `Completed: ${label(o)}`,
    body: [inHouse ? "Delivered in-house." : `Pay the builder ${money(o.builderPayoutCents)}.`, o.careIncluded ? "Start monthly billing and activate Care." : ""]
      .filter(Boolean)
      .join(" "),
  });
  await notifyClients(tx, completed, {
    subject: `Completed: ${label(o)}`,
    body: o.careIncluded
      ? `Thanks for accepting the work. Your monthly service (${money(o.carePriceCents)}/month) starts now.`
      : "Thanks for accepting the work. You can leave a review and add a Care plan to keep it running.",
  });
  return completed;
}

export async function reviewDelivery(
  db: DB,
  actor: Actor,
  orderId: string,
  input: { decisions: Record<string, string>; notes: Record<string, string>; note: string },
): Promise<WorkOrder> {
  requireRole(actor, "client");
  return inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    assert(o.status === "delivered", "There's no delivery waiting for review.", "conflict");
    const criteria = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.workOrderId, o.id)).orderBy(asc(acceptanceCriteria.position));
    for (const c of criteria) {
      const d = input.decisions[c.id];
      assert(d === "met" || d === "not_met", "Mark every criterion as met or not met.");
      if (d === "not_met") assert((input.notes[c.id] ?? "").trim().length > 0, "Say what's missing for each criterion you mark as not met.");
    }
    for (const c of criteria) {
      await tx
        .update(acceptanceCriteria)
        .set({ status: input.decisions[c.id] as "met" | "not_met", reviewNote: (input.notes[c.id] ?? "").trim(), updatedAt: new Date() })
        .where(eq(acceptanceCriteria.id, c.id));
    }
    const allMet = criteria.every((c) => input.decisions[c.id] === "met");
    const [latest] = await tx.select().from(deliveries).where(eq(deliveries.workOrderId, o.id)).orderBy(desc(deliveries.round)).limit(1);
    if (latest) {
      await tx
        .update(deliveries)
        .set({ decision: allMet ? "accepted" : "revision_requested", decisionNote: input.note.trim(), decidedAt: new Date() })
        .where(eq(deliveries.id, latest.id));
    }
    if (allMet) return completeOrder(tx, o, "accept_delivery", actor, input.note.trim());
    const unmet = criteria.filter((c) => input.decisions[c.id] === "not_met").length;
    const revised = await applyEvent(tx, o, "request_revision", actor, { revisionCount: o.revisionCount + 1 }, { unmet });
    await notifyBuilder(tx, revised, {
      subject: `Revision requested: ${label(o)}`,
      body: `${unmet} acceptance criterion${unmet === 1 ? "" : "s"} not met yet. See the client's notes on each one.`,
    });
    if (o.revisionCount + 1 >= 2) {
      await notifyOps(tx, revised, { subject: `Second revision on ${label(o)}`, body: "Consider stepping in before this turns into a dispute." });
    }
    return revised;
  });
}

/** Operator accepts on the client's behalf (e.g. the review window lapsed). Always recorded with a reason. */
export async function operatorAcceptDelivery(db: DB, actor: Actor, orderId: string, reason: string): Promise<WorkOrder> {
  requireRole(actor, "operator");
  const why = reason.trim();
  assert(why.length >= 10, "Record why ForgeX is accepting on the client's behalf.");
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    assert(o.status === "delivered", "There's no delivery waiting for review.", "conflict");
    await tx
      .update(acceptanceCriteria)
      .set({ status: "met", reviewNote: `Accepted by ForgeX: ${why}`, updatedAt: new Date() })
      .where(eq(acceptanceCriteria.workOrderId, o.id));
    return completeOrder(tx, o, "accept_delivery", actor, why);
  });
}

// ---------------------------------------------------------------------------
// Disputes, cancellation, refunds and payouts
// ---------------------------------------------------------------------------

export async function openDispute(db: DB, actor: Actor, orderId: string, reason: string): Promise<WorkOrder> {
  requireRole(actor, "client", "builder", "operator");
  const why = reason.trim();
  assert(why.length >= 10, "Describe the problem (at least 10 characters).");
  return inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    if (actor.role === "builder") assert(o.assignedBuilderId === actor.builderId, "Only the assigned builder can open a dispute.", "forbidden");
    const disputed = await applyEvent(tx, o, "open_dispute", actor, {}, { reason: why });
    await tx.insert(messages).values({ id: newId(), workOrderId: o.id, authorId: actor.id!, body: `Opened a dispute: ${why}` });
    await notifyOps(tx, o, { subject: `Dispute opened on ${label(o)}`, body: why });
    if (actor.role !== "client") await notifyClients(tx, o, { subject: `ForgeX is reviewing ${label(o)}`, body: "A dispute was opened. A ForgeX operator will step in." });
    if (actor.role !== "builder") await notifyBuilder(tx, o, { subject: `ForgeX is reviewing ${label(o)}`, body: "A dispute was opened. A ForgeX operator will step in." });
    return disputed;
  });
}

async function cancelInTx(tx: DB, o: WorkOrder, actor: Actor, reason: string): Promise<WorkOrder> {
  const cancelled = await applyEvent(tx, o, "cancel", actor, { cancelledAt: new Date(), cancelReason: reason }, { reason });
  await tx
    .update(assignments)
    .set({ status: "withdrawn", respondedAt: new Date() })
    .where(and(eq(assignments.workOrderId, o.id), eq(assignments.status, "invited")));
  const paid = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.workOrderId, o.id), eq(payments.status, "succeeded")));
  await notifyOps(tx, o, {
    subject: `${paid.length ? "Refund needed" : "Cancelled"}: ${label(o)}`,
    body: paid.length ? `Cancelled after payment (${reason}). Refund the client and record it.` : `Cancelled: ${reason}`,
  });
  if (actor.role !== "client") await notifyClients(tx, o, { subject: `Cancelled: ${label(o)}`, body: reason });
  await notifyBuilder(tx, o, { subject: `Cancelled: ${label(o)}`, body: reason });
  return cancelled;
}

export async function cancelOrder(db: DB, actor: Actor, orderId: string, reason: string): Promise<WorkOrder> {
  requireRole(actor, "client", "operator");
  const why = reason.trim();
  assert(why.length >= 3, "Give a short reason for cancelling.");
  return inTx(db, async (tx) => cancelInTx(tx, await getOrderFor(tx, actor, orderId), actor, why));
}

export async function resolveDispute(
  db: DB,
  actor: Actor,
  orderId: string,
  outcome: "continue" | "complete" | "cancel",
  note: string,
): Promise<WorkOrder> {
  requireRole(actor, "operator");
  const why = note.trim();
  assert(why.length >= 10, "Record how the dispute was resolved.");
  return inTx(db, async (tx) => {
    const o = await getOrder(tx, orderId);
    assert(o.status === "disputed", "This Work Order isn't in dispute.", "conflict");
    if (outcome === "cancel") return cancelInTx(tx, o, actor, `Dispute resolved: ${why}`);
    if (outcome === "complete") {
      await tx
        .update(acceptanceCriteria)
        .set({ status: "met", reviewNote: `Resolved by ForgeX: ${why}`, updatedAt: new Date() })
        .where(eq(acceptanceCriteria.workOrderId, o.id));
      return completeOrder(tx, o, "resolve_complete", actor, why);
    }
    const resumed = await applyEvent(tx, o, "resolve_continue", actor, {}, { note: why });
    await notifyClients(tx, resumed, { subject: `Dispute resolved: ${label(o)}`, body: why });
    await notifyBuilder(tx, resumed, { subject: `Dispute resolved: ${label(o)}`, body: why });
    return resumed;
  });
}

/**
 * The payment, if it may be refunded now: every payment of a cancelled order, or an extra payment while
 * another one still funds the order. Call this BEFORE asking Stripe to refund anything.
 */
export async function refundablePayment(db: DB, actor: Actor, paymentId: string) {
  requireRole(actor, "operator");
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  assert(p && p.status === "succeeded", "Only a received payment can be refunded.", "conflict");
  const o = await getOrder(db, p.workOrderId);
  const received = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.workOrderId, o.id), eq(payments.status, "succeeded")));
  assert(o.status === "cancelled" || received.length > 1, "Cancel the Work Order before refunding its only payment.", "conflict");
  return p;
}

export async function recordRefund(db: DB, actor: Actor, paymentId: string, reference: string): Promise<void> {
  requireRole(actor, "operator");
  const ref = reference.trim();
  assert(ref.length >= 3, "Add the refund reference.");
  await inTx(db, async (tx) => {
    const p = await refundablePayment(tx, actor, paymentId);
    const o = await getOrder(tx, p.workOrderId);
    await tx
      .update(payments)
      .set({ status: "refunded", refundedAt: new Date(), reference: p.reference ? `${p.reference} · refund ${ref}` : `refund ${ref}` })
      .where(eq(payments.id, p.id));
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "refund_recorded", data: { paymentId: p.id } });
    await notifyClients(tx, o, { subject: `Refund issued for ${label(o)}`, body: `We refunded ${money(p.amountCents)} (reference ${ref}).` });
  });
}

export async function markPayoutPaid(db: DB, actor: Actor, payoutId: string, input: { method: string; reference: string }): Promise<void> {
  requireRole(actor, "operator");
  const method = input.method.trim();
  const reference = input.reference.trim();
  assert(method.length > 0 && reference.length >= 3, "Record how the payout was sent and its reference.");
  await inTx(db, async (tx) => {
    const [paid] = await tx
      .update(payouts)
      .set({ status: "paid", method, reference, recordedById: actor.id, paidAt: new Date() })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")))
      .returning();
    assert(paid, "This payout is already paid or doesn't exist.", "conflict");
    const o = await getOrder(tx, paid.workOrderId);
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "payout_paid" });
    await notifyBuilder(tx, o, { subject: `Payout sent for ${label(o)}`, body: `${money(paid.amountCents)} via ${method} (reference ${reference}).` }, paid.builderId);
  });
}

// ---------------------------------------------------------------------------
// After completion: review and Care
// ---------------------------------------------------------------------------

const VISIBILITIES: RecordVisibility[] = ["public_named", "public_anonymous", "private"];

export async function submitReview(
  db: DB,
  actor: Actor,
  orderId: string,
  input: { rating: number; comment: string; visibility: string },
): Promise<void> {
  requireRole(actor, "client");
  assert(Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5, "Choose a rating from 1 to 5.");
  assert(VISIBILITIES.includes(input.visibility as RecordVisibility), "Choose how this record may be shown.");
  assert(input.comment.length <= 2000, "Please keep the comment under 2,000 characters.");
  await inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    assert(o.status === "completed", "You can review a Work Order once it's completed.", "conflict");
    const [existing] = await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.workOrderId, o.id)).limit(1);
    assert(!existing, "You've already reviewed this Work Order.", "conflict");
    await tx.insert(reviews).values({
      id: newId(),
      workOrderId: o.id,
      rating: input.rating,
      comment: input.comment.trim(),
      visibility: input.visibility as RecordVisibility,
    });
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "review_submitted", data: { rating: input.rating } });
    await notifyBuilder(tx, o, { subject: `New review on ${label(o)}`, body: `The client rated the work ${input.rating}/5.` });
  });
}

export async function requestCarePlan(db: DB, actor: Actor, orderId: string): Promise<void> {
  requireRole(actor, "client");
  await inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    assert(o.status === "completed", "Care starts once the Work Order is completed.", "conflict");
    assert(o.carePriceCents, "This Work Order doesn't include a Care option.", "conflict");
    const [existing] = await tx.select({ id: carePlans.id }).from(carePlans).where(eq(carePlans.workOrderId, o.id)).limit(1);
    assert(!existing, "A Care plan already exists for this Work Order.", "conflict");
    await tx.insert(carePlans).values({
      id: newId(),
      workOrderId: o.id,
      orgId: o.orgId,
      builderId: o.assignedBuilderId,
      monthlyPriceCents: o.carePriceCents,
      builderShareCents: careBuilderShareCents(o.carePriceCents),
    });
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: "care_requested" });
    await notifyOps(tx, o, { subject: `Care requested: ${label(o)}`, body: `${money(o.carePriceCents)}/month. Set up billing, then activate it.` });
  });
}

export async function setCarePlanStatus(db: DB, actor: Actor, carePlanId: string, status: "active" | "cancelled"): Promise<void> {
  requireRole(actor, "operator", "client");
  if (status === "active") requireRole(actor, "operator");
  await inTx(db, async (tx) => {
    const [plan] = await tx.select().from(carePlans).where(eq(carePlans.id, carePlanId)).limit(1);
    assert(plan, "Care plan not found.", "not_found");
    if (actor.role === "client") assert(plan.orgId === actor.orgId, "Care plan not found.", "not_found");
    assert(plan.status !== status && plan.status !== "cancelled", "That change isn't possible for this Care plan.", "conflict");
    await tx
      .update(carePlans)
      .set(status === "active" ? { status, activatedAt: new Date() } : { status, cancelledAt: new Date() })
      .where(eq(carePlans.id, plan.id));
    const o = await getOrder(tx, plan.workOrderId);
    await recordEvent(tx, { workOrderId: o.id, actorId: actor.id, type: status === "active" ? "care_activated" : "care_cancelled" });
    const subject = `${status === "active" ? "Care plan active" : "Care plan cancelled"}: ${label(o)}`;
    await notifyClients(tx, o, { subject, body: status === "active" ? `Billing at ${money(plan.monthlyPriceCents)}/month.` : "Your Care plan has ended." });
    await notifyBuilder(tx, o, { subject, body: status === "active" ? `You are the Care owner (${money(plan.builderShareCents)}/month).` : "This Care plan has ended." }, plan.builderId);
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function postMessage(db: DB, actor: Actor, orderId: string, body: string, internal = false): Promise<void> {
  requireRole(actor, "client", "builder", "operator");
  if (internal) requireRole(actor, "operator");
  const text = body.trim();
  assert(text.length > 0, "Write a message first.");
  assert(text.length <= 5000, "Please keep messages under 5,000 characters.");
  await inTx(db, async (tx) => {
    const o = await getOrderFor(tx, actor, orderId);
    if (actor.role === "builder") assert(o.assignedBuilderId === actor.builderId, "Accept the invitation to join the conversation.", "forbidden");
    await tx.insert(messages).values({ id: newId(), workOrderId: o.id, authorId: actor.id!, body: text, internal });
    if (internal) return;
    const n = { subject: `New message on ${label(o)}`, body: `${actor.name}: ${text.slice(0, 280)}` };
    if (actor.role !== "client") await notifyClients(tx, o, n);
    if (actor.role !== "builder") await notifyBuilder(tx, o, n);
    if (actor.role !== "operator") await notifyOps(tx, o, n);
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface OrderListItem {
  id: string;
  number: number;
  title: string;
  status: WorkOrder["status"];
  orgName: string;
  priceCents: number | null;
  builderPayoutCents: number | null;
  createdAt: Date;
  updatedAt: Date;
  isDemo: boolean;
  /** real, demo or test: the company's explicit class, or demo for a seeded order (classification.ts). */
  dataClass: DataClass;
  invited: boolean;
}

export async function listOrders(db: DB, actor: Actor): Promise<OrderListItem[]> {
  const base = db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      title: workOrders.title,
      status: workOrders.status,
      orgName: orgs.name,
      priceCents: workOrders.priceCents,
      builderPayoutCents: workOrders.builderPayoutCents,
      assignedBuilderId: workOrders.assignedBuilderId,
      createdAt: workOrders.createdAt,
      updatedAt: workOrders.updatedAt,
      isDemo: workOrders.isDemo,
      orgClass: orgs.dataClass,
    })
    .from(workOrders)
    .innerJoin(orgs, eq(orgs.id, workOrders.orgId));
  const classed = <T extends { isDemo: boolean; orgClass: DataClass }>({ orgClass, ...r }: T) => ({ ...r, dataClass: orderClass(r.isDemo, orgClass) });

  if (actor.role === "operator") {
    const rows = await base.orderBy(desc(workOrders.updatedAt));
    return rows.map((r) => ({ ...classed(r), invited: false }));
  }
  if (actor.role === "client") {
    if (!actor.orgId) return [];
    const rows = await base.where(eq(workOrders.orgId, actor.orgId)).orderBy(desc(workOrders.updatedAt));
    return rows.map((r) => ({ ...classed(r), builderPayoutCents: null, invited: false }));
  }
  if (actor.role === "builder" && actor.builderId) {
    const invites = await db
      .select({ workOrderId: assignments.workOrderId, payoutCents: assignments.payoutCents })
      .from(assignments)
      .where(and(eq(assignments.builderId, actor.builderId), eq(assignments.status, "invited")));
    const invitedIds = invites.map((i) => i.workOrderId);
    const rows = await base
      .where(
        invitedIds.length
          ? or(eq(workOrders.assignedBuilderId, actor.builderId), inArray(workOrders.id, invitedIds))
          : eq(workOrders.assignedBuilderId, actor.builderId),
      )
      .orderBy(desc(workOrders.updatedAt));
    return rows.map((r) => {
      const invite = invites.find((i) => i.workOrderId === r.id);
      const mine = r.assignedBuilderId === actor.builderId;
      return {
        ...classed(r),
        priceCents: null,
        builderPayoutCents: mine ? r.builderPayoutCents : (invite?.payoutCents ?? null),
        invited: !mine && Boolean(invite),
      };
    });
  }
  return [];
}

export async function listCarePlans(db: DB, actor: Actor) {
  const base = db
    .select({
      id: carePlans.id,
      status: carePlans.status,
      monthlyPriceCents: carePlans.monthlyPriceCents,
      builderShareCents: carePlans.builderShareCents,
      createdAt: carePlans.createdAt,
      activatedAt: carePlans.activatedAt,
      workOrderId: workOrders.id,
      number: workOrders.number,
      title: workOrders.title,
      orgName: orgs.name,
      isDemo: workOrders.isDemo,
      orgClass: orgs.dataClass,
    })
    .from(carePlans)
    .innerJoin(workOrders, eq(workOrders.id, carePlans.workOrderId))
    .innerJoin(orgs, eq(orgs.id, carePlans.orgId));
  const classed = (rows: Awaited<typeof base>) => rows.map(({ orgClass, ...r }) => ({ ...r, dataClass: orderClass(r.isDemo, orgClass) }));
  if (actor.role === "operator") return classed(await base.orderBy(desc(carePlans.createdAt)));
  if (actor.role === "client" && actor.orgId) return classed(await base.where(eq(carePlans.orgId, actor.orgId)).orderBy(desc(carePlans.createdAt)));
  if (actor.role === "builder" && actor.builderId) return classed(await base.where(eq(carePlans.builderId, actor.builderId)).orderBy(desc(carePlans.createdAt)));
  return [];
}

export async function getOrderView(db: DB, actor: Actor, orderId: string) {
  const o = await getOrderFor(db, actor, orderId);
  const isOperator = actor.role === "operator";
  const isClient = actor.role === "client";
  const isAssignedBuilder = actor.role === "builder" && o.assignedBuilderId !== null && o.assignedBuilderId === actor.builderId;
  const insider = isOperator || isClient || isAssignedBuilder; // invited builders see the scope only

  const [org] = await db.select().from(orgs).where(eq(orgs.id, o.orgId)).limit(1);
  const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.workOrderId, o.id)).orderBy(asc(acceptanceCriteria.position));
  const milestoneRows = await db.select().from(milestones).where(eq(milestones.workOrderId, o.id)).orderBy(asc(milestones.position));
  const assignmentRows = await db
    .select({
      id: assignments.id,
      builderId: assignments.builderId,
      builderName: users.name,
      status: assignments.status,
      payoutCents: assignments.payoutCents,
      note: assignments.note,
      createdAt: assignments.createdAt,
    })
    .from(assignments)
    .innerJoin(builderProfiles, eq(builderProfiles.id, assignments.builderId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(assignments.workOrderId, o.id))
    .orderBy(desc(assignments.createdAt));
  const myInvite =
    actor.role === "builder" ? (assignmentRows.find((a) => a.builderId === actor.builderId && a.status === "invited") ?? null) : null;

  const deliveryRows = insider
    ? await db.select().from(deliveries).where(eq(deliveries.workOrderId, o.id)).orderBy(desc(deliveries.round))
    : [];
  const messageRows = insider
    ? await db
        .select({ id: messages.id, body: messages.body, internal: messages.internal, createdAt: messages.createdAt, authorName: users.name, authorRole: users.role })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.authorId))
        .where(isOperator ? eq(messages.workOrderId, o.id) : and(eq(messages.workOrderId, o.id), eq(messages.internal, false)))
        .orderBy(asc(messages.createdAt))
    : [];
  const paymentRows = isOperator || isClient ? await db.select().from(payments).where(eq(payments.workOrderId, o.id)).orderBy(desc(payments.createdAt)) : [];
  const [payout] = isOperator || isAssignedBuilder ? await db.select().from(payouts).where(eq(payouts.workOrderId, o.id)).limit(1) : [];
  const [review] = await db.select().from(reviews).where(eq(reviews.workOrderId, o.id)).limit(1);
  const [carePlan] = insider ? await db.select().from(carePlans).where(eq(carePlans.workOrderId, o.id)).limit(1) : [];
  const timeline = insider
    ? await db
        .select({ id: events.id, type: events.type, createdAt: events.createdAt, actorName: users.name })
        .from(events)
        .leftJoin(users, eq(users.id, events.actorId))
        .where(eq(events.workOrderId, o.id))
        .orderBy(asc(events.createdAt))
    : [];
  const [assignedBuilder] = o.assignedBuilderId
    ? await db
        .select({ id: builderProfiles.id, name: users.name, slug: builderProfiles.slug, headline: builderProfiles.headline, identityVerified: builderProfiles.identityVerified })
        .from(builderProfiles)
        .innerJoin(users, eq(users.id, builderProfiles.userId))
        .where(eq(builderProfiles.id, o.assignedBuilderId))
        .limit(1)
    : [];

  // Operators see who at the client can act on the quote, and whether they have set a password yet.
  const clientContacts = isOperator
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, activated: sql<boolean>`(${users.passwordHash} not like '!%')` })
        .from(users)
        .where(and(eq(users.orgId, o.orgId), eq(users.role, "client")))
    : [];

  const role = actor.role;
  const can = (e: OrderEvent) => canTransition(o.status, e, role);
  const paymentProcessing = paymentRows.some((p) => p.method === "stripe" && p.status === "pending" && p.reference === PROCESSING_NOTE);
  const economics: OrderEconomics | null =
    isOperator && o.priceCents && o.builderPayoutCents !== null ? orderEconomics(o.priceCents, o.builderPayoutCents) : null;

  return {
    order: {
      ...o,
      // Clients see the price; builders see their payout; only operators see both (the margin).
      priceCents: isOperator || isClient ? o.priceCents : null,
      carePriceCents: isOperator || isClient ? o.carePriceCents : null,
      builderPayoutCents: isOperator || isAssignedBuilder ? o.builderPayoutCents : (myInvite?.payoutCents ?? null),
      aiCostMicros: isOperator ? o.aiCostMicros : 0,
    },
    org: { name: org.name, industry: org.industry, sizeBand: org.sizeBand, dataClass: org.dataClass },
    criteria,
    milestones: milestoneRows,
    assignments: isOperator ? assignmentRows : [],
    myInvite,
    deliveries: deliveryRows,
    messages: messageRows,
    payments: paymentRows,
    payout: payout ?? null,
    review: review ?? null,
    carePlan: carePlan ?? null,
    timeline,
    assignedBuilder: assignedBuilder ?? null,
    economics,
    paymentProcessing,
    clientContacts,
    viewer: { role, isOperator, isClient, isAssignedBuilder, isInvitedBuilder: Boolean(myInvite) },
    permissions: {
      editScope: isOperator && o.status === "submitted",
      sendQuote: isOperator && can("send_quote"),
      acceptQuote: isClient && can("accept_quote"),
      requestQuoteChanges: isClient && can("request_quote_changes"),
      pay: isClient && o.status === "accepted" && !paymentProcessing,
      recordPayment: isOperator && can("record_payment"),
      inviteBuilder: isOperator && !o.assignedBuilderId && (STAFFABLE as readonly string[]).includes(o.status),
      respondToInvite: Boolean(myInvite) && (STAFFABLE as readonly string[]).includes(o.status) && !o.assignedBuilderId,
      updateMilestones: (isAssignedBuilder || isOperator) && o.status === "in_progress",
      submitDelivery: isAssignedBuilder && can("submit_delivery"),
      reviewDelivery: isClient && o.status === "delivered",
      operatorAccept: isOperator && o.status === "delivered",
      openDispute: (isClient || isAssignedBuilder || isOperator) && can("open_dispute"),
      resolveDispute: isOperator && o.status === "disputed",
      cancel: (isClient || isOperator) && can("cancel"),
      message: insider && (actor.role !== "builder" || isAssignedBuilder),
      review: isClient && o.status === "completed" && !review,
      requestCare: isClient && o.status === "completed" && Boolean(o.carePriceCents) && !carePlan && !o.careIncluded,
    },
  };
}

export type OrderView = Awaited<ReturnType<typeof getOrderView>>;
