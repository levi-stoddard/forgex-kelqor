import {
  careStatusAction,
  cancelAction,
  inviteBuilderAction,
  operatorAcceptAction,
  payoutPaidAction,
  recordOfflinePaymentAction,
  redraftScopeAction,
  refundAction,
  resolveDisputeAction,
  saveScopeAction,
  sendQuoteAction,
} from "@/app/actions/orders";
import { newInviteAction } from "@/app/actions/sales";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, KeyValue } from "@/components/ui";
import { inviteUrl } from "@/lib/domain/invites";
import type { OrderView } from "@/lib/domain/orders";
import { suggestPricing } from "@/lib/domain/pricing";
import { dateTime, money, pct } from "@/lib/format";
import { stripeConfigured } from "@/lib/payments/stripe";
import { aiScopingConfigured } from "@/lib/scoping/ai";
import { getOutcome } from "@/lib/scoping/catalog";
import { PricingCalculator } from "./pricing-calculator";

type BuilderOption = { id: string; name: string; headline: string; skills: string[]; hourlyRateCents: number | null };

function Area({ name, label, items, rows = 4, hint }: { name: string; label: string; items: string[]; rows?: number; hint?: string }) {
  return (
    <label className="block">
      <span className="fx-label">{label}</span>
      <textarea name={name} rows={rows} defaultValue={items.join("\n")} className="fx-input text-[13px]" />
      {hint ? <span className="fx-hint block">{hint}</span> : null}
    </label>
  );
}

export function ScopeEditor({ view }: { view: OrderView }) {
  const s = view.order.scope;
  return (
    <Card title="Scope (editable until the quote is sent)" description="One item per line. Saving replaces the acceptance criteria and milestones.">
      <ActionForm action={saveScopeAction} className="space-y-4">
        <input type="hidden" name="orderId" value={view.order.id} />
        <label className="block">
          <span className="fx-label">Title</span>
          <input name="title" defaultValue={view.order.title} className="fx-input" required />
        </label>
        <label className="block">
          <span className="fx-label">Summary</span>
          <textarea name="summary" rows={2} defaultValue={s.summary} className="fx-input" required />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Area name="objectives" label="Objectives" items={s.objectives} />
          <Area name="deliverables" label="Deliverables" items={s.deliverables} />
          <Area name="inScope" label="In scope" items={s.inScope} rows={5} />
          <Area name="outOfScope" label="Not in scope" items={s.outOfScope} rows={5} />
        </div>
        <Area
          name="acceptanceCriteria"
          label="Acceptance criteria"
          items={s.acceptanceCriteria}
          rows={7}
          hint="Each one must be testable in a single acceptance session: test data, threshold and time limit."
        />
        <Area name="milestones" label="Milestones" items={s.milestones.map((m) => `${m.title}: ${m.description}`)} rows={3} hint="Format: Title: description" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Area name="assumptions" label="Assumptions" items={s.assumptions} />
          <Area name="clientResponsibilities" label="What the client provides" items={s.clientResponsibilities} />
          <Area name="risks" label="Risks" items={s.risks} />
          <Area name="clarifyingQuestions" label="Open questions" items={s.clarifyingQuestions} />
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <label className="block">
            <span className="fx-label">Hours (low)</span>
            <input name="hoursLow" type="number" min={1} defaultValue={s.estimateHoursLow} className="fx-input" />
          </label>
          <label className="block">
            <span className="fx-label">Hours (high)</span>
            <input name="hoursHigh" type="number" min={1} defaultValue={s.estimateHoursHigh} className="fx-input" />
          </label>
          <label className="block">
            <span className="fx-label">Complexity</span>
            <select name="complexity" defaultValue={s.complexity} className="fx-input">
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label className="block">
            <span className="fx-label">Skills</span>
            <input name="skills" defaultValue={s.recommendedSkills.join(", ")} className="fx-input" />
          </label>
        </div>
        <SubmitButton pendingText="Saving…">Save scope</SubmitButton>
      </ActionForm>
    </Card>
  );
}

export function OpsPanels({ view, builders, inviteToken }: { view: OrderView; builders: BuilderOption[]; inviteToken?: string }) {
  const { order, permissions } = view;
  const suggestion = suggestPricing({ hoursLow: order.scope.estimateHoursLow, hoursHigh: order.scope.estimateHoursHigh });
  const template = getOutcome(order.category);
  const listPriced = Boolean(template?.listPriceCents);
  const succeeded = view.payments.filter((p) => p.status === "succeeded");
  const hidden = <input type="hidden" name="orderId" value={order.id} />;
  const pending = view.clientContacts.filter((c) => !c.activated);

  return (
    <>
      {inviteToken ? (
        <Card title="Client link" description="Copy it now and send it yourself: it isn't shown again once you leave this page. It lets them set a password and open this Work Order, once, within 14 days.">
          <p className="rounded-md bg-stone-50 px-3 py-2 font-mono text-xs break-all text-stone-800">{inviteUrl(inviteToken)}</p>
        </Card>
      ) : null}

      {view.clientContacts.length ? (
        <Card title="Client access">
          <ul className="space-y-2 text-sm">
            {view.clientContacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {c.name} <span className="text-stone-500">· {c.email}</span>
                </span>
                {c.activated ? <Badge tone="emerald">Active</Badge> : <Badge tone="amber">Hasn't set a password</Badge>}
              </li>
            ))}
          </ul>
          {pending.map((c) => (
            <ActionForm key={c.id} action={newInviteAction} className="mt-3">
              {hidden}
              <input type="hidden" name="userId" value={c.id} />
              <SubmitButton variant="secondary" pendingText="Creating…">
                New link for {c.name.split(" ")[0]}
              </SubmitButton>
            </ActionForm>
          ))}
        </Card>
      ) : null}

      {permissions.sendQuote ? (
        <Card title="Price and send the quote">
          <PricingCalculator
            action={sendQuoteAction}
            orderId={order.id}
            listPriced={listPriced}
            hours={{ low: order.scope.estimateHoursLow, high: order.scope.estimateHoursHigh }}
            initial={{
              priceCents: order.priceCents ?? template?.listPriceCents ?? suggestion.priceCents,
              // List-priced launch offers are delivered in-house by default (no builder payout).
              builderPayoutCents: order.builderPayoutCents ?? (listPriced ? 0 : suggestion.builderPayoutCents),
              // A list-priced offer has a monthly fee only if the catalog gives one (the Leak Check has none).
              carePriceCents: order.carePriceCents ?? (listPriced ? (template?.monthlyCents ?? null) : suggestion.carePriceCents),
              careIncluded: order.careIncluded || Boolean(template?.monthlyCents),
            }}
          />
        </Card>
      ) : null}

      {permissions.editScope ? (
        <Card
          title="Redraft the scope"
          description={aiScopingConfigured() ? "Claude redrafts from the request plus your notes." : "AI scoping is off until it has a spending limit and your authorization, so redrafts use the catalog template."}
        >
          <ActionForm action={redraftScopeAction} className="space-y-2">
            {hidden}
            <textarea name="notes" rows={3} className="fx-input" placeholder="For example: they use Outlook, not Gmail; leave reporting for a phase 2." />
            <SubmitButton variant="secondary" pendingText="Redrafting… (up to a minute)">
              Redraft scope
            </SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {permissions.inviteBuilder ? (
        <Card title="Assign a builder" description="One open invitation at a time. Work starts when the order is funded and the builder accepts.">
          {builders.length ? (
            <ActionForm action={inviteBuilderAction} className="space-y-3">
              {hidden}
              <label className="block">
                <span className="fx-label">Approved builder</span>
                <select name="builderId" className="fx-input" required defaultValue="">
                  <option value="" disabled>
                    Choose a builder
                  </option>
                  {builders.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}: {b.skills.slice(0, 3).join(", ") || b.headline}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="fx-label">Payout</span>
                <input name="payout" defaultValue={order.builderPayoutCents != null ? String(order.builderPayoutCents / 100) : ""} className="fx-input" inputMode="decimal" />
                <span className="fx-hint block">0 when you deliver it yourself through your own builder account.</span>
              </label>
              <label className="block">
                <span className="fx-label">Note to the builder (optional)</span>
                <input name="note" className="fx-input" />
              </label>
              <SubmitButton pendingText="Inviting…">Send invitation</SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-sm text-stone-500">No approved builders yet. Approve one under Builders first.</p>
          )}
        </Card>
      ) : null}

      {view.assignments.length ? (
        <Card title="Invitations">
          <ul className="space-y-1.5 text-sm">
            {view.assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span>
                  {a.builderName} · {a.payoutCents === 0 ? "in-house" : money(a.payoutCents)}
                </span>
                <Badge tone={a.status === "accepted" ? "emerald" : a.status === "invited" ? "sky" : "neutral"}>{a.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {permissions.recordPayment ? (
        <Card
          title="Record a bank transfer"
          description={stripeConfigured() ? "Card and ACH payments through Stripe are recorded automatically." : "Stripe isn't configured, so payments are recorded here."}
        >
          <ActionForm action={recordOfflinePaymentAction} className="space-y-2">
            {hidden}
            <input name="reference" required placeholder="Bank or invoice reference" className="fx-input" />
            <SubmitButton pendingText="Recording…">Record {money(order.priceCents)} received</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {permissions.operatorAccept ? (
        <Card title="Accept on the client's behalf" description="Only after the review window lapses, or with the client's written approval.">
          <ActionForm action={operatorAcceptAction} className="space-y-2" confirmText="Accept this delivery on the client's behalf and release the builder's payout?">
            {hidden}
            <textarea name="reason" rows={2} required className="fx-input" placeholder="Why ForgeX is accepting" />
            <SubmitButton variant="secondary" pendingText="Accepting…">
              Accept delivery
            </SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {permissions.resolveDispute ? (
        <Card title="Resolve the dispute">
          <ActionForm action={resolveDisputeAction} className="space-y-2">
            {hidden}
            <select name="outcome" className="fx-input" defaultValue="continue">
              <option value="continue">Continue the work</option>
              <option value="complete">Complete and release the payout</option>
              <option value="cancel">Cancel (then refund)</option>
            </select>
            <textarea name="note" rows={2} required className="fx-input" placeholder="What was agreed" />
            <SubmitButton pendingText="Saving…">Resolve</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {(order.status === "cancelled" && succeeded.length) || succeeded.length > 1 ? (
        <Card
          title="Refund the client"
          description={order.status === "cancelled" ? undefined : "More than one payment was received for this Work Order. Refund the extra one."}
        >
          {succeeded.map((p) => (
            <ActionForm key={p.id} action={refundAction} className="space-y-2" confirmText={`Refund ${money(p.amountCents)}?`}>
              {hidden}
              <input type="hidden" name="paymentId" value={p.id} />
              <p className="text-sm">
                {money(p.amountCents)} · {p.method === "test" ? "TEST payment" : p.method} · {dateTime(p.succeededAt)}
              </p>
              {p.method === "stripe" && stripeConfigured() ? null : <input name="reference" required placeholder="Refund reference" className="fx-input" />}
              <SubmitButton variant="danger" pendingText="Refunding…">
                {p.method === "stripe" && stripeConfigured() ? "Refund through Stripe" : "Record refund"}
              </SubmitButton>
            </ActionForm>
          ))}
        </Card>
      ) : null}

      {view.payout?.status === "pending" ? (
        <Card
          title="Pay the builder"
          description={
            view.payments.some((p) => p.method === "test" && p.status === "succeeded") && !view.payments.some((p) => p.method !== "test" && p.status === "succeeded")
              ? `TEST order: funded with a simulated payment, so no real ${money(view.payout.amountCents)} payout is due.`
              : `${money(view.payout.amountCents)} is due on acceptance.`
          }
        >
          <ActionForm action={payoutPaidAction} className="space-y-2">
            {hidden}
            <input type="hidden" name="payoutId" value={view.payout.id} />
            <input name="method" required defaultValue="ACH" className="fx-input" aria-label="Payout method" />
            <input name="reference" required placeholder="Transfer reference" className="fx-input" aria-label="Transfer reference" />
            <SubmitButton pendingText="Saving…">Mark payout sent</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {view.carePlan && view.carePlan.status !== "cancelled" ? (
        <Card title="Care plan" description={`${money(view.carePlan.monthlyPriceCents)}/month · builder share ${money(view.carePlan.builderShareCents)}`}>
          <p className="mb-2 text-sm">
            Status: <Badge tone={view.carePlan.status === "active" ? "emerald" : "amber"}>{view.carePlan.status}</Badge>
          </p>
          <div className="flex gap-2">
            {view.carePlan.status === "requested" ? (
              <ActionForm action={careStatusAction}>
                {hidden}
                <input type="hidden" name="carePlanId" value={view.carePlan.id} />
                <input type="hidden" name="status" value="active" />
                <SubmitButton pendingText="…">Activate</SubmitButton>
              </ActionForm>
            ) : null}
            <ActionForm action={careStatusAction} confirmText="Cancel this Care plan?">
              {hidden}
              <input type="hidden" name="carePlanId" value={view.carePlan.id} />
              <input type="hidden" name="status" value="cancelled" />
              <SubmitButton variant="secondary" pendingText="…">
                Cancel
              </SubmitButton>
            </ActionForm>
          </div>
        </Card>
      ) : null}

      {view.economics ? (
        <Card title="Economics" description="Visible to ForgeX only.">
          <KeyValue
            rows={[
              ["Client price", money(order.priceCents)],
              ["Builder payout", order.builderPayoutCents === 0 ? "In-house (none)" : money(order.builderPayoutCents)],
              ...(order.careIncluded && order.carePriceCents ? ([["Monthly after go-live", `${money(order.carePriceCents)}/month`]] as [string, string][]) : []),
              ["Gross margin", `${money(view.economics.grossMarginCents)} (${pct(view.economics.grossMarginPct)})`],
              ["Payment fees (ACH)", money(view.economics.processingFeeCents)],
              ["QA time", money(view.economics.qaCostCents)],
              ["Refund reserve", money(view.economics.reserveCents)],
              ["Contribution", `${money(view.economics.contributionCents)} (${pct(view.economics.contributionPct)})`],
            ]}
          />
        </Card>
      ) : null}

      <Card title="Scoping">
        <KeyValue
          rows={[
            ["Scope source", order.scopeSource === "ai" ? `AI (${order.scopeModel})` : order.scopeSource === "template" ? "Catalog template" : "Edited by ForgeX"],
            ["AI cost so far", `$${(order.aiCostMicros / 1_000_000).toFixed(2)}`],
            ["Revisions", String(order.revisionCount)],
          ]}
        />
      </Card>

      {permissions.cancel ? (
        <details className="fx-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-rose-700">Cancel this Work Order</summary>
          <ActionForm action={cancelAction} className="mt-3 space-y-2" confirmText="Cancel this Work Order?">
            {hidden}
            <input name="reason" required placeholder="Reason" className="fx-input" />
            <SubmitButton variant="danger" pendingText="Cancelling…">
              Cancel Work Order
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </>
  );
}
