import { disputeAction, respondInviteAction, submitDeliveryAction } from "@/app/actions/orders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, KeyValue } from "@/components/ui";
import type { OrderView } from "@/lib/domain/orders";
import { date, money } from "@/lib/format";

export function BuilderPanels({ view }: { view: OrderView }) {
  const { order, permissions, viewer, payout, myInvite } = view;
  return (
    <>
      {permissions.respondToInvite && myInvite ? (
        <Card title="You're invited">
          <div className="text-3xl font-semibold tracking-tight tabular-nums">{money(myInvite.payoutCents)}</div>
          <p className="mt-1 text-sm text-stone-500">
            Fixed payout, released when the client accepts. Estimated {order.scope.estimateHoursLow}–{order.scope.estimateHoursHigh} hours.
          </p>
          {myInvite.note ? <p className="mt-2 rounded-md bg-stone-50 px-3 py-2 text-sm">ForgeX: {myInvite.note}</p> : null}
          <ActionForm action={respondInviteAction} className="mt-4 flex gap-2">
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="assignmentId" value={myInvite.id} />
            <SubmitButton name="decision" value="accept" className="flex-1" pendingText="Saving…">
              Accept
            </SubmitButton>
            <SubmitButton name="decision" value="decline" variant="secondary" className="flex-1" pendingText="Saving…">
              Decline
            </SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {viewer.isAssignedBuilder ? (
        <Card title="Your payout">
          <KeyValue
            rows={[
              ["Fixed payout", money(order.builderPayoutCents)],
              [
                "Status",
                payout
                  ? payout.status === "paid"
                    ? `Sent ${date(payout.paidAt)} (${payout.method} ${payout.reference})`
                    : "Queued for payment"
                  : "Released when the client accepts",
              ],
            ]}
          />
        </Card>
      ) : null}

      {permissions.openDispute && viewer.isAssignedBuilder ? (
        <details className="fx-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-stone-700">Blocked? Ask ForgeX to step in</summary>
          <ActionForm action={disputeAction} className="mt-3 space-y-2">
            <input type="hidden" name="orderId" value={order.id} />
            <textarea name="reason" rows={3} required className="fx-input" placeholder="What's blocking you?" />
            <SubmitButton variant="secondary" pendingText="Sending…">
              Open a dispute
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </>
  );
}

export function DeliveryForm({ view }: { view: OrderView }) {
  return (
    <Card
      title={view.order.revisionCount ? `Resubmit the delivery (revision ${view.order.revisionCount})` : "Submit the delivery"}
      description="Give evidence for every acceptance criterion: what you tested, the result, and where the client can see it."
    >
      <ActionForm action={submitDeliveryAction} className="space-y-4">
        <input type="hidden" name="orderId" value={view.order.id} />
        <label className="block">
          <span className="fx-label">What you delivered</span>
          <textarea name="summary" rows={3} required className="fx-input" />
        </label>
        <label className="block">
          <span className="fx-label">Links</span>
          <textarea name="links" rows={2} className="fx-input" placeholder="One per line: recorded walkthrough, runbook, repository" />
        </label>
        {view.criteria.map((c, i) => (
          <label key={c.id} className="block">
            <span className="fx-label">
              {i + 1}. {c.text}
            </span>
            {c.status === "not_met" && c.reviewNote ? <span className="mb-1 block text-xs text-rose-700">Client: {c.reviewNote}</span> : null}
            <textarea name={`evidence:${c.id}`} rows={2} required defaultValue={c.evidence} className="fx-input" />
          </label>
        ))}
        <SubmitButton pendingText="Submitting…">Submit for client review</SubmitButton>
      </ActionForm>
    </Card>
  );
}
