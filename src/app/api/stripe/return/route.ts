import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { SYSTEM_ACTOR } from "@/lib/domain/actor";
import { DomainError } from "@/lib/domain/errors";
import { EXTRA_PAYMENT_NOTE, markStripeSession, PROCESSING_NOTE, recordPayment } from "@/lib/domain/orders";
import { paidSessionFrom, retrieveCheckoutSession, stripeConfigured } from "@/lib/payments/stripe";

// Checkout's success_url. Confirms the session with Stripe directly (never trusting the query string),
// records the payment idempotently, then returns the client to the Work Order with an honest status.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!stripeConfigured() || !sessionId) return NextResponse.redirect(new URL("/dashboard", req.url));
  const session = await retrieveCheckoutSession(sessionId);
  const workOrderId = session.metadata?.workOrderId;
  if (!workOrderId) return NextResponse.redirect(new URL("/dashboard", req.url));
  const back = (status?: string) => NextResponse.redirect(new URL(`/orders/${workOrderId}${status ? `?checkout=${status}` : ""}`, req.url));
  const db = await getDb();
  const paid = paidSessionFrom(session);
  if (!paid) {
    if (session.status !== "complete") return back();
    await markStripeSession(db, session.id, "processing", PROCESSING_NOTE); // ACH: confirmed later by the webhook
    return back("processing");
  }
  try {
    await recordPayment(db, SYSTEM_ACTOR, workOrderId, {
      method: "stripe",
      stripeSessionId: paid.sessionId,
      stripePaymentIntentId: paid.paymentIntentId,
      amountCents: paid.amountCents,
      livemode: paid.livemode,
    });
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
  }
  const [row] = await db.select({ reference: payments.reference }).from(payments).where(eq(payments.stripeSessionId, paid.sessionId)).limit(1);
  return back(row?.reference === EXTRA_PAYMENT_NOTE ? "extra" : "success");
}
