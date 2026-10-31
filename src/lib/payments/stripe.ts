import Stripe from "stripe";
import { orderRef } from "../domain/records";

// Stripe is optional. Without STRIPE_SECRET_KEY, payments are recorded by an operator (bank transfer / invoice).
// Use TEST-mode keys until a live launch is approved.

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

const appUrl = () => process.env.APP_URL || "http://localhost:3000";

export async function createCheckoutSession(
  order: { id: string; number: number; title: string; priceCents: number },
  customerEmail: string,
): Promise<{ id: string; url: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: order.priceCents,
          product_data: { name: `ForgeX Work Order ${orderRef(order.number)}`, description: order.title.slice(0, 200) },
        },
      },
    ],
    metadata: { workOrderId: order.id },
    payment_intent_data: { metadata: { workOrderId: order.id } },
    success_url: `${appUrl()}/api/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/orders/${order.id}?checkout=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return { id: session.id, url: session.url };
}

export interface PaidSession {
  sessionId: string;
  workOrderId: string;
  amountCents: number;
  paymentIntentId: string | null;
  livemode: boolean;
}

/** A completed, fully paid Checkout Session for a Work Order, or null (unpaid, still processing, or not ours). */
export function paidSessionFrom(session: Stripe.Checkout.Session): PaidSession | null {
  const workOrderId = session.metadata?.workOrderId;
  if (!workOrderId || session.payment_status !== "paid" || session.amount_total === null) return null;
  const pi = session.payment_intent;
  return {
    sessionId: session.id,
    workOrderId,
    amountCents: session.amount_total,
    paymentIntentId: typeof pi === "string" ? pi : (pi?.id ?? null),
    // Stripe's own flag: a test-mode payment never counts as real money, whatever key the app was given.
    livemode: session.livemode,
  };
}

export async function retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  return stripe().checkout.sessions.retrieve(sessionId);
}

export function verifyWebhook(rawBody: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

/** Idempotent per ForgeX payment: retrying after a failure returns the same Stripe refund instead of a second one. */
export async function refundPaymentIntent(paymentIntentId: string, idempotencyKey: string): Promise<string> {
  const refund = await stripe().refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey });
  return refund.id;
}
