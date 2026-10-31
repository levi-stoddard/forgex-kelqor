import Link from "next/link";
import {
  acceptQuoteAction,
  cancelAction,
  disputeAction,
  payWithStripeAction,
  requestCareAction,
  requestChangesAction,
  reviewAction,
  reviewDeliveryAction,
  simulatePaymentAction,
} from "@/app/actions/orders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card } from "@/components/ui";
import { testPaymentsAllowed, type OrderView } from "@/lib/domain/orders";
import { date, money, safeUrl } from "@/lib/format";
import { stripeConfigured } from "@/lib/payments/stripe";

function Hidden({ id }: { id: string }) {
  return <input type="hidden" name="orderId" value={id} />;
}

export function ClientPanels({ view }: { view: OrderView }) {
  const { order, permissions } = view;
  return (
    <>
      {permissions.acceptQuote ? (
        <Card title="Your fixed-price quote">
          <div className="text-3xl font-semibold tracking-tight tabular-nums">
            {money(order.priceCents)}
            {order.careIncluded && order.carePriceCents ? <span className="text-base font-medium text-stone-500"> setup</span> : null}
          </div>
          {order.careIncluded && order.carePriceCents ? (
            <p className="mt-1 text-sm font-medium text-stone-700">
              Then {money(order.carePriceCents)} a month, starting at go-live. You can cancel the monthly service any month.
            </p>
          ) : null}
          <p className="mt-1 text-sm text-stone-500">
            Valid until {date(order.quoteExpiresAt)}.
            {order.carePriceCents && !order.careIncluded ? ` Optional Care after delivery: ${money(order.carePriceCents)} a month.` : ""}
          </p>
          <ActionForm action={acceptQuoteAction} className="mt-4 space-y-3">
            <Hidden id={order.id} />
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input type="checkbox" name="agree" required className="mt-0.5 rounded border-stone-300" />
              <span>
                I agree to the scope and acceptance criteria on this page and the{" "}
                <Link href="/terms" className="fx-link" target="_blank">
                  Work Order terms
                </Link>{" "}
                (draft).
              </span>
            </label>
            <SubmitButton pendingText="Accepting…" className="w-full">
              Accept quote
            </SubmitButton>
          </ActionForm>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-stone-700">Request changes instead</summary>
            <ActionForm action={requestChangesAction} className="mt-2 space-y-2" resetOnSuccess>
              <Hidden id={order.id} />
              <textarea name="message" rows={3} required className="fx-input" placeholder="What should change in the scope or the price?" />
              <SubmitButton variant="secondary" pendingText="Sending…">
                Send change request
              </SubmitButton>
            </ActionForm>
          </details>
        </Card>
      ) : null}

      {permissions.pay ? (
        <Card
          title="Pay to start"
          description="Work starts when your payment clears. You check the delivery against the acceptance criteria before the Work Order is complete."
        >
          <div className="text-3xl font-semibold tracking-tight tabular-nums">{money(order.priceCents)}</div>
          {stripeConfigured() ? (
            <ActionForm action={payWithStripeAction} className="mt-3">
              <Hidden id={order.id} />
              <SubmitButton pendingText="Opening checkout…" className="w-full">
                Pay by card or bank account
              </SubmitButton>
            </ActionForm>
          ) : null}
          <div className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">
            <p className="font-medium">{stripeConfigured() ? "Prefer bank transfer?" : "Pay by bank transfer"}</p>
            <p>ForgeX emails you an invoice with bank details. Work starts when the transfer arrives.</p>
          </div>
          {testPaymentsAllowed() ? (
            <ActionForm action={simulatePaymentAction} className="mt-3">
              <Hidden id={order.id} />
              <SubmitButton variant="secondary" pendingText="Recording…" className="w-full">
                Simulate a TEST payment
              </SubmitButton>
              <p className="fx-hint">Local development only. No money moves, and it never counts as revenue.</p>
            </ActionForm>
          ) : null}
        </Card>
      ) : null}

      {order.status === "accepted" && view.paymentProcessing ? (
        <Card title="Payment processing" description="Bank payments can take a few business days to confirm. Work starts as soon as it clears.">
          <div className="text-3xl font-semibold tracking-tight tabular-nums">{money(order.priceCents)}</div>
        </Card>
      ) : null}

      {order.status === "completed" ? <CompletionPanels view={view} /> : null}

      {permissions.openDispute ? (
        <details className="fx-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-stone-700">Something wrong? Ask ForgeX to step in</summary>
          <ActionForm action={disputeAction} className="mt-3 space-y-2">
            <Hidden id={order.id} />
            <textarea name="reason" rows={3} required className="fx-input" placeholder="What's going wrong?" />
            <SubmitButton variant="secondary" pendingText="Sending…">
              Open a dispute
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}

      {permissions.cancel ? (
        <details className="fx-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-stone-700">Cancel this request</summary>
          <ActionForm action={cancelAction} className="mt-3 space-y-2" confirmText="Cancel this request?">
            <Hidden id={order.id} />
            <input name="reason" required placeholder="Reason (helps us improve)" className="fx-input" />
            <SubmitButton variant="danger" pendingText="Cancelling…">
              Cancel request
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </>
  );
}

function CompletionPanels({ view }: { view: OrderView }) {
  const { order, permissions, review, carePlan } = view;
  return (
    <>
      {permissions.review ? (
        <Card title="How did it go?" description="Your review helps other businesses trust this builder.">
          <ActionForm action={reviewAction} className="space-y-3">
            <Hidden id={order.id} />
            <fieldset>
              <legend className="fx-label">Rating</legend>
              <div className="flex gap-3 text-sm">
                {[5, 4, 3, 2, 1].map((r) => (
                  <label key={r} className="flex items-center gap-1">
                    <input type="radio" name="rating" value={r} required defaultChecked={r === 5} /> {r}
                  </label>
                ))}
              </div>
            </fieldset>
            <textarea name="comment" rows={3} className="fx-input" placeholder="What changed for your team?" />
            <label className="block">
              <span className="fx-label">Show this on the builder's public record?</span>
              <select name="visibility" defaultValue="public_anonymous" className="fx-input">
                <option value="public_named">Yes, with our company name</option>
                <option value="public_anonymous">Yes, without our name</option>
                <option value="private">No, keep it private</option>
              </select>
            </label>
            <SubmitButton pendingText="Saving…">Submit review</SubmitButton>
          </ActionForm>
        </Card>
      ) : review ? (
        <Card title="Your review">
          <p className="text-sm">
            <Badge tone="ember">{review.rating}/5</Badge> {review.comment ? `“${review.comment}”` : null}
          </p>
        </Card>
      ) : null}

      {permissions.requestCare ? (
        <Card title="Keep it running with Care" description="Monitoring, fixes and small changes from the builder who built it.">
          <div className="text-2xl font-semibold tabular-nums">{money(order.carePriceCents)} / month</div>
          <ActionForm action={requestCareAction} className="mt-3">
            <Hidden id={order.id} />
            <SubmitButton pendingText="Requesting…" className="w-full">
              Start Care
            </SubmitButton>
          </ActionForm>
        </Card>
      ) : carePlan ? (
        <Card title={order.careIncluded ? "Monthly service" : "Care"}>
          <p className="text-sm">
            {money(carePlan.monthlyPriceCents)} / month ·{" "}
            <Badge tone={carePlan.status === "active" ? "emerald" : carePlan.status === "requested" ? "amber" : "neutral"}>{carePlan.status}</Badge>
          </p>
        </Card>
      ) : null}
    </>
  );
}

export function ReviewDeliveryForm({ view }: { view: OrderView }) {
  const latest = view.deliveries[0];
  return (
    <Card title="Review the delivery" description="Mark each criterion met or not met. If something isn't met, say what's missing; the builder revises and resubmits.">
      {latest ? (
        <div className="mb-4 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-950 ring-1 ring-indigo-200 ring-inset">
          <p className="font-semibold">Builder's summary, round {latest.round}</p>
          <p className="mt-0.5 whitespace-pre-line">{latest.summary}</p>
          {latest.links
            .map((l) => safeUrl(l))
            .filter((l): l is string => Boolean(l))
            .map((l) => (
              <a key={l} href={l} target="_blank" rel="noopener noreferrer nofollow" className="fx-link block break-all">
                {l}
              </a>
            ))}
        </div>
      ) : null}
      <ActionForm action={reviewDeliveryAction} className="space-y-4">
        <Hidden id={view.order.id} />
        {view.criteria.map((c, i) => (
          <fieldset key={c.id} className="rounded-lg border border-stone-200 px-3 py-3">
            <legend className="px-1 text-sm font-medium text-stone-900">
              {i + 1}. {c.text}
            </legend>
            <p className="mt-1 rounded-md bg-stone-50 px-3 py-2 text-sm whitespace-pre-line text-stone-700">
              <span className="font-medium">Evidence: </span>
              {c.evidence || "None provided."}
            </p>
            <div className="mt-2 flex gap-5 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" name={`decision:${c.id}`} value="met" required /> Met
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name={`decision:${c.id}`} value="not_met" /> Not met
              </label>
            </div>
            <input name={`note:${c.id}`} className="fx-input mt-2" placeholder="If not met: what's missing?" aria-label={`Note for criterion ${i + 1}`} />
          </fieldset>
        ))}
        <label className="block">
          <span className="fx-label">Overall note (optional)</span>
          <textarea name="overall" rows={2} className="fx-input" />
        </label>
        <SubmitButton pendingText="Submitting…">Submit review</SubmitButton>
      </ActionForm>
    </Card>
  );
}
