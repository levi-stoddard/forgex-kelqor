import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { SYSTEM_ACTOR } from "@/lib/domain/actor";
import { DomainError } from "@/lib/domain/errors";
import { markStripeSession, recordPayment } from "@/lib/domain/orders";
import { paidSessionFrom, stripeConfigured, verifyWebhook } from "@/lib/payments/stripe";

// Stripe calls this after Checkout. Subscribe the endpoint to: checkout.session.completed,
// checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired.
export async function POST(req: Request) {
  if (!stripeConfigured()) return NextResponse.json({ error: "Stripe not configured" }, { status: 404 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  let event;
  try {
    event = verifyWebhook(await req.text(), signature);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  const db = await getDb();
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const paid = paidSessionFrom(event.data.object);
    if (paid) {
      try {
        // Unexpected payments are recorded and flagged for refund inside recordPayment, never dropped.
        await recordPayment(db, SYSTEM_ACTOR, paid.workOrderId, {
          method: "stripe",
          stripeSessionId: paid.sessionId,
          stripePaymentIntentId: paid.paymentIntentId,
          amountCents: paid.amountCents,
          livemode: paid.livemode,
        });
      } catch (err) {
        if (err instanceof DomainError) console.warn("[stripe webhook]", paid.workOrderId, err.message);
        else throw err; // a 500 makes Stripe retry
      }
    }
  } else if (event.type === "checkout.session.async_payment_failed") {
    await markStripeSession(db, event.data.object.id, "failed", "The bank payment failed.");
  } else if (event.type === "checkout.session.expired") {
    await markStripeSession(db, event.data.object.id, "failed", "Checkout expired before payment.");
  }
  return NextResponse.json({ received: true });
}
