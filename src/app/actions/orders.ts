"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionContext, run, str, type ActionState } from "@/lib/actions";
import { allowAttempt } from "@/lib/auth/rate-limit";
import { SYSTEM_ACTOR } from "@/lib/domain/actor";
import { DomainError } from "@/lib/domain/errors";
import * as orders from "@/lib/domain/orders";
import type { Complexity, Intake, Scope } from "@/lib/domain/types";
import { lines, parseDollars } from "@/lib/format";
import { createCheckoutSession, refundPaymentIntent, retrieveCheckoutSession, stripeConfigured } from "@/lib/payments/stripe";

function refresh(orderId: string) {
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard");
}

const done = (message: string): ActionState => ({ ok: true, message });

// --- Client: request -------------------------------------------------------

export async function createRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const result = await run(async () => {
    const { db, actor, user } = await actionContext();
    if (!allowAttempt(`request:${user.id}`, 10, 60 * 60 * 1000)) throw new DomainError("You've submitted a lot of requests this hour. Try again later.");
    const intake: Intake = {
      problem: str(form, "problem"),
      currentTools: str(form, "currentTools"),
      desiredOutcome: str(form, "desiredOutcome"),
      volume: str(form, "volume"),
      deadline: str(form, "deadline"),
      budgetBand: str(form, "budgetBand"),
      templateSlug: str(form, "templateSlug") || null,
    };
    id = (await orders.createWorkOrder(db, actor, intake)).id;
  });
  if (result?.error) return result;
  revalidatePath("/dashboard");
  redirect(`/orders/${id}?created=1`);
}

// --- Operator: scope and quote -------------------------------------------------

function parseMilestone(line: string) {
  const i = line.indexOf(":");
  return i > 0 ? { title: line.slice(0, i).trim(), description: line.slice(i + 1).trim() } : { title: line.trim(), description: "" };
}

export async function saveScopeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    const complexity = str(form, "complexity");
    const scope: Scope = {
      summary: str(form, "summary").trim(),
      objectives: lines(form.get("objectives")),
      inScope: lines(form.get("inScope")),
      outOfScope: lines(form.get("outOfScope")),
      deliverables: lines(form.get("deliverables")),
      acceptanceCriteria: lines(form.get("acceptanceCriteria")),
      milestones: lines(form.get("milestones")).map(parseMilestone),
      assumptions: lines(form.get("assumptions")),
      clientResponsibilities: lines(form.get("clientResponsibilities")),
      risks: lines(form.get("risks")),
      estimateHoursLow: Number(str(form, "hoursLow")),
      estimateHoursHigh: Number(str(form, "hoursHigh")),
      complexity: (["small", "medium", "large"].includes(complexity) ? complexity : "medium") as Complexity,
      recommendedSkills: str(form, "skills")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      clarifyingQuestions: lines(form.get("clarifyingQuestions")),
    };
    await orders.saveScope(db, actor, id, { title: str(form, "title"), scope });
    refresh(id);
    return done("Scope saved.");
  });
}

export async function redraftScopeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor, user } = await actionContext();
    if (!allowAttempt(`redraft:${user.id}`, 20, 60 * 60 * 1000)) throw new DomainError("Too many redrafts this hour.");
    const draft = await orders.redraftScope(db, actor, id, str(form, "notes"));
    refresh(id);
    if (draft.aiError) return { ok: true, message: `AI drafting failed (${draft.aiError}); the template scope was used instead.` };
    return done(draft.source === "ai" ? `Redrafted with ${draft.model}.` : "Redrafted from the catalog template (no AI key configured).");
  });
}

export async function sendQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    const priceCents = parseDollars(form.get("price"));
    const builderPayoutCents = parseDollars(form.get("payout"));
    if (priceCents === null || builderPayoutCents === null) throw new DomainError("Enter both the client price and the builder payout (0 for in-house).");
    await orders.sendQuote(db, actor, id, {
      priceCents,
      builderPayoutCents,
      carePriceCents: parseDollars(form.get("care")),
      careIncluded: form.get("careIncluded") === "on",
    });
    refresh(id);
    return done("Quote sent to the client.");
  });
}

// --- Client: quote, payment ------------------------------------------------------

export async function requestChangesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.requestQuoteChanges(db, actor, id, str(form, "message"));
    refresh(id);
    return done("Sent. ForgeX will revise the scope and quote.");
  });
}

export async function acceptQuoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.acceptQuote(db, actor, id, form.get("agree") === "on");
    refresh(id);
    return done("Quote accepted. Payment is the last step before work starts.");
  });
}

export async function payWithStripeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  let url = "";
  const result = await run(async () => {
    const { db, actor, user } = await actionContext();
    if (!stripeConfigured()) throw new DomainError("Card and ACH payments aren't switched on yet. Please pay by bank transfer.");
    const view = await orders.getOrderView(db, actor, id);
    if (!view.permissions.pay || !view.order.priceCents) throw new DomainError("This Work Order isn't waiting for payment.", "conflict");
    // Reuse an open Checkout session instead of opening a second one the client could also pay.
    for (const p of view.payments.filter((x) => x.method === "stripe" && x.status === "pending" && x.stripeSessionId)) {
      const open = await retrieveCheckoutSession(p.stripeSessionId!);
      if (open.status === "open" && open.url) {
        url = open.url;
        return;
      }
      if (open.status === "complete") throw new DomainError("Your payment is already processing. Bank payments can take a few business days to confirm.", "conflict");
      await orders.markStripeSession(db, p.stripeSessionId!, "failed", "Checkout expired before payment.");
    }
    const session = await createCheckoutSession(
      { id, number: view.order.number, title: view.order.title, priceCents: view.order.priceCents },
      user.email,
    );
    await orders.recordPendingStripePayment(db, actor, id, { sessionId: session.id, amountCents: view.order.priceCents });
    url = session.url;
  });
  if (result?.error) return result;
  redirect(url);
}

export async function simulatePaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor, user } = await actionContext();
    if (!orders.testPaymentsAllowed()) throw new DomainError("Test payments are turned off.", "forbidden");
    const view = await orders.getOrderView(db, actor, id);
    if (!view.permissions.pay) throw new DomainError("This Work Order isn't waiting for payment.", "conflict");
    await orders.recordPayment(db, SYSTEM_ACTOR, id, { method: "test", reference: `Simulated by ${user.email}` });
    refresh(id);
    return done("TEST payment recorded. No money moved, and it is excluded from revenue metrics.");
  });
}

export async function recordOfflinePaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.recordPayment(db, actor, id, { method: "offline", reference: str(form, "reference") });
    refresh(id);
    return done("Payment recorded.");
  });
}

// --- Staffing and delivery ---------------------------------------------------------

export async function inviteBuilderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.inviteBuilder(db, actor, id, {
      builderId: str(form, "builderId"),
      payoutCents: parseDollars(form.get("payout")),
      note: str(form, "note"),
    });
    refresh(id);
    return done("Invitation sent.");
  });
}

export async function respondInviteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  const accept = str(form, "decision") === "accept";
  const result = await run(async () => {
    const { db, actor } = await actionContext();
    await orders.respondToAssignment(db, actor, str(form, "assignmentId"), accept);
    refresh(id);
  });
  if (result?.error) return result;
  if (!accept) redirect("/dashboard");
  return done("You're assigned. Work starts as soon as the client's payment is in.");
}

export async function milestoneAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.setMilestoneDone(db, actor, str(form, "milestoneId"), str(form, "done") === "true");
    refresh(id);
  });
}

function prefixed(form: FormData, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith(prefix) && typeof v === "string") out[k.slice(prefix.length)] = v;
  return out;
}

export async function submitDeliveryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.submitDelivery(db, actor, id, {
      summary: str(form, "summary"),
      links: lines(form.get("links")),
      evidence: prefixed(form, "evidence:"),
    });
    refresh(id);
    return done("Delivery submitted. The client has been asked to review it.");
  });
}

export async function reviewDeliveryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    const result = await orders.reviewDelivery(db, actor, id, {
      decisions: prefixed(form, "decision:"),
      notes: prefixed(form, "note:"),
      note: str(form, "overall"),
    });
    refresh(id);
    return done(result.status === "completed" ? "Accepted. The builder's payout is released." : "Revision requested. The builder can see your notes.");
  });
}

export async function operatorAcceptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.operatorAcceptDelivery(db, actor, id, str(form, "reason"));
    refresh(id);
    return done("Accepted on the client's behalf.");
  });
}

// --- Exceptions: disputes, cancellation, refunds -------------------------------------

export async function disputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.openDispute(db, actor, id, str(form, "reason"));
    refresh(id);
    return done("Dispute opened. A ForgeX operator will step in.");
  });
}

export async function resolveDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    const outcome = str(form, "outcome");
    if (outcome !== "continue" && outcome !== "complete" && outcome !== "cancel") throw new DomainError("Choose an outcome.");
    await orders.resolveDispute(db, actor, id, outcome, str(form, "note"));
    refresh(id);
    return done("Dispute resolved.");
  });
}

export async function cancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.cancelOrder(db, actor, id, str(form, "reason"));
    refresh(id);
    return done("Work Order cancelled.");
  });
}

export async function refundAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    // Permission and refund rules are checked before Stripe is asked to move any money.
    const payment = await orders.refundablePayment(db, actor, str(form, "paymentId"));
    let reference = str(form, "reference");
    if (payment.method === "stripe" && payment.stripePaymentIntentId && stripeConfigured()) {
      reference = await refundPaymentIntent(payment.stripePaymentIntentId, `forgex-refund-${payment.id}`);
    }
    await orders.recordRefund(db, actor, payment.id, reference);
    refresh(payment.workOrderId || id);
    return done("Refund recorded.");
  });
}

export async function payoutPaidAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.markPayoutPaid(db, actor, str(form, "payoutId"), { method: str(form, "method"), reference: str(form, "reference") });
    if (id) refresh(id);
    revalidatePath("/dashboard");
    return done("Payout marked as paid.");
  });
}

// --- After completion ------------------------------------------------------------------

export async function reviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.submitReview(db, actor, id, {
      rating: Number(str(form, "rating")),
      comment: str(form, "comment"),
      visibility: str(form, "visibility"),
    });
    refresh(id);
    return done("Thanks for the review.");
  });
}

export async function requestCareAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.requestCarePlan(db, actor, id);
    refresh(id);
    return done("Care requested. ForgeX will confirm billing and activate it.");
  });
}

export async function careStatusAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    const status = str(form, "status");
    if (status !== "active" && status !== "cancelled") throw new DomainError("Choose a Care status.");
    await orders.setCarePlanStatus(db, actor, str(form, "carePlanId"), status);
    if (id) refresh(id);
    revalidatePath("/dashboard");
    return done(status === "active" ? "Care plan activated." : "Care plan cancelled.");
  });
}

// --- Conversation ------------------------------------------------------------------------

export async function messageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = str(form, "orderId");
  return run(async () => {
    const { db, actor } = await actionContext();
    await orders.postMessage(db, actor, id, str(form, "body"), form.get("internal") === "on");
    refresh(id);
    return { ok: true };
  });
}
