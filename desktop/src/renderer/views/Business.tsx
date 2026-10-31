import { ArrowLeft, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Badge, BulletList, Card, EmptyState, KeyValue, PageHeader, StatusBadge, type Tone } from "@/components/ui";
import { EVENT_LABELS } from "@/components/order/labels";
import type { CompanySummary, OrderDetail } from "@/lib/desktop/types";
import { DATA_CLASS_LABELS, DATA_CLASSES, type DataClass } from "@/lib/domain/types";
import { date, dateTime, money, pct } from "@/lib/format";
import type { ViewProps } from "../App";
import { Empty, Failure, FixtureBadge, Loading, SectionTitle } from "../components";
import { kelqor, plural, useResult } from "../lib";

type Tab = "orders" | "companies";

export function BusinessView({ online, epoch, initialOrder }: ViewProps & { initialOrder?: string }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [orderId, setOrderId] = useState<string | null>(initialOrder ?? null);

  if (orderId) return <OrderPanel id={orderId} online={online} epoch={epoch} back={() => setOrderId(null)} />;
  return (
    <div data-view="business">
      <PageHeader eyebrow="Business Workspace" title="Companies and work orders" description="Read from the existing business records. Quoting, payments and deliveries stay in the established web workflow." />
      <div className="mb-4 flex gap-1">
        {(["orders", "companies"] as Tab[]).map((t) => (
          <button key={t} type="button" data-tab={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-stone-900 text-white" : "bg-white text-stone-700 ring-1 ring-stone-200 hover:bg-stone-100"}`}>
            {t === "orders" ? "Work orders" : "Companies"}
          </button>
        ))}
      </div>
      {tab === "orders" ? <OrdersTable epoch={epoch} open={setOrderId} /> : <CompaniesList epoch={epoch} online={online} />}
    </div>
  );
}

function OrdersTable({ epoch, open }: { epoch: number; open: (id: string) => void }) {
  const res = useResult(() => kelqor().orders(), [epoch]);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  if (!res.data.length) return <EmptyState title="No work orders yet">Orders written up in the web app appear here.</EmptyState>;
  return (
    <div className="fx-card overflow-hidden">
      <table className="w-full text-left text-sm" data-testid="orders-table">
        <thead className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
          <tr>
            <th className="px-4 py-2 font-medium">Order</th>
            <th className="px-4 py-2 font-medium">Company</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Price</th>
            <th className="px-4 py-2 text-right font-medium">Payout</th>
            <th className="px-4 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {res.data.map((o) => (
            <tr key={o.id} className="cursor-pointer hover:bg-stone-50" data-order={o.id} onClick={() => open(o.id)}>
              <td className="px-4 py-2.5">
                <div className="font-medium text-stone-900">
                  {o.ref} · {o.title}
                </div>
                {o.fixture ? (
                  <div className="mt-0.5">
                    <FixtureBadge fixture={o.fixture} />
                  </div>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-stone-700">{o.orgName}</td>
              <td className="px-4 py-2.5">
                <StatusBadge status={o.status} />
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(o.priceCents)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{o.builderPayoutCents === 0 ? "In-house" : money(o.builderPayoutCents)}</td>
              <td className="px-4 py-2.5 text-stone-500">{date(o.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompaniesList({ epoch, online }: { epoch: number; online: boolean }) {
  const res = useResult(() => kelqor().companies(), [epoch]);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  if (!res.data.length) return <EmptyState title="No client companies yet">Companies appear here once a Work Order is written up for them.</EmptyState>;
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="companies">
      {res.data.map((c) => (
        <div key={c.id} className="fx-card px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium text-stone-900">{c.name}</div>
              <div className="text-xs text-stone-500">{[c.industry, c.sizeBand].filter(Boolean).join(" · ") || "No details recorded"}</div>
            </div>
            <FixtureBadge fixture={c.fixture} />
          </div>
          <div className="mt-2 text-xs text-stone-600">
            {plural(c.orders, "work order")} · {c.openOrders} open
          </div>
          <ClassPicker c={c} online={online} onSaved={() => void res.reload()} />
          {c.contacts.length ? (
            <ul className="mt-2 space-y-0.5 text-xs text-stone-700">
              {c.contacts.map((u) => (
                <li key={u.email}>
                  {u.name} · {u.email} {u.activated ? "" : <span className="text-amber-700">(hasn't set a password)</span>}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A company's explicit class. Only real companies count as business; the change is recorded in the audit log. */
function ClassPicker({ c, online, onSaved }: { c: CompanySummary; online: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function change(dataClass: DataClass) {
    setBusy(true);
    setError(null);
    const res = await kelqor().setCompanyClass(c.id, dataClass);
    setBusy(false);
    if (res.ok) onSaved();
    else setError(res.offline ? "Not saved: the local backend is unavailable." : res.error);
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <label className="text-stone-500" htmlFor={`class-${c.id}`}>
        Counts as
      </label>
      <select id={`class-${c.id}`} data-company-class={c.id} className="fx-input w-auto! py-1! text-xs" value={c.dataClass} disabled={!online || busy} onChange={(e) => void change(e.target.value as DataClass)}>
        {DATA_CLASSES.map((k) => (
          <option key={k} value={k}>
            {DATA_CLASS_LABELS[k]}
          </option>
        ))}
      </select>
      {error ? <span className="text-rose-700">{error}</span> : null}
    </div>
  );
}

const CRITERION_TONE: Record<string, Tone> = { met: "emerald", not_met: "rose", pending: "neutral" };

function OrderPanel({ id, online, epoch, back }: { id: string; online: boolean; epoch: number; back: () => void }) {
  const res = useResult(() => kelqor().order(id), [id, epoch]);
  const v: OrderDetail | null = res.data;
  return (
    <div data-view="order" data-order-detail={id}>
      <button type="button" className="fx-btn fx-btn-ghost mb-3 px-2 py-1 text-sm" onClick={back}>
        <ArrowLeft size={15} /> All work orders
      </button>
      {res.result && !res.result.ok ? <Failure result={res.result} onRetry={res.reload} /> : null}
      {!v ? (
        res.loading ? <Loading /> : null
      ) : (
        <div className="space-y-4">
          <PageHeader
            eyebrow={`${v.order.ref} · ${v.org.name}`}
            title={v.order.title}
            description={v.nextStep}
            actions={
              <button type="button" data-action="open-order-web" className="fx-btn fx-btn-secondary" disabled={!online} onClick={() => void kelqor().openWebApp(v.webPath)}>
                <ExternalLink size={14} /> Open in web app
              </button>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={v.order.status} />
            <FixtureBadge fixture={v.order.fixture} />
            <Badge>{v.order.scopeSource === "ai" ? "Scoped by Claude" : v.order.scopeSource === "template" ? "Scoped from a template" : "Scoped by the operator"}</Badge>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Scope" className="lg:col-span-2">
              <p className="text-sm text-stone-800">{v.order.summary}</p>
              <SectionTitle>Deliverables</SectionTitle>
              <BulletList items={v.order.deliverables} />
            </Card>
            <Card title="Money" description="Operators see price, payout and margin.">
              <KeyValue
                rows={[
                  ["Price", money(v.order.priceCents)],
                  ["Builder payout", v.order.builderPayoutCents === 0 ? "In-house" : money(v.order.builderPayoutCents)],
                  ["Monthly service", v.order.careIncluded || v.order.carePriceCents ? money(v.order.carePriceCents) : "—"],
                  ...(v.economics ? ([["Gross margin", `${money(v.economics.grossMarginCents)} (${pct(v.economics.grossMarginPct)})`], ["Contribution", money(v.economics.contributionCents)]] as [string, string][]) : []),
                ]}
              />
            </Card>
          </div>
          <Card title="Acceptance criteria" description="The client accepts the work criterion by criterion.">
            {v.criteria.length ? (
              <ul className="divide-y divide-stone-100" data-testid="criteria">
                {v.criteria.map((c, i) => (
                  <li key={i} className="py-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-stone-800">{c.text}</span>
                      <Badge tone={CRITERION_TONE[c.status]}>{c.status.replace("_", " ")}</Badge>
                    </div>
                    {c.evidence ? <p className="mt-0.5 text-xs text-stone-500">Evidence: {c.evidence}</p> : null}
                    {c.reviewNote ? <p className="mt-0.5 text-xs text-stone-500">Client note: {c.reviewNote}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No criteria yet.</Empty>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Delivery">
              {v.milestones.length ? (
                <ul className="space-y-1 text-sm">
                  {v.milestones.map((m, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="text-stone-800">{m.title}</span>
                      <Badge tone={m.status === "done" ? "emerald" : "neutral"}>{m.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No milestones.</Empty>
              )}
              <SectionTitle>Deliveries</SectionTitle>
              {v.deliveries.length ? (
                <ul className="space-y-2 text-sm">
                  {v.deliveries.map((d) => (
                    <li key={d.round}>
                      <div className="flex justify-between gap-3">
                        <span className="font-medium text-stone-900">Round {d.round}</span>
                        <Badge tone={d.decision === "accepted" ? "emerald" : d.decision === "revision_requested" ? "amber" : "neutral"}>{d.decision.replace("_", " ")}</Badge>
                      </div>
                      <p className="text-xs text-stone-600">{d.summary}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nothing delivered yet.</Empty>
              )}
              {v.assignedBuilder ? <p className="mt-3 text-xs text-stone-500">Assigned to {v.assignedBuilder}.</p> : null}
            </Card>
            <Card title="Payments">
              {v.payments.length ? (
                <ul className="space-y-1.5 text-sm">
                  {v.payments.map((p, i) => (
                    <li key={i} className="flex items-center justify-between gap-3">
                      <span className="tabular-nums">
                        {money(p.amountCents)} · {date(p.createdAt)}
                      </span>
                      <span className="flex gap-1">
                        {p.method === "test" ? <Badge tone="amber">TEST, not revenue</Badge> : <Badge>{p.method}</Badge>}
                        <Badge tone={p.status === "succeeded" ? "emerald" : p.status === "refunded" ? "rose" : "neutral"}>{p.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No payments.</Empty>
              )}
              {v.payout ? (
                <p className="mt-3 text-xs text-stone-600">
                  Payout {money(v.payout.amountCents)}: {v.payout.status}
                  {v.payout.paidAt ? ` on ${date(v.payout.paidAt)}` : ""}
                </p>
              ) : null}
              {v.carePlan ? (
                <p className="mt-1 text-xs text-stone-600">
                  Monthly service {money(v.carePlan.monthlyPriceCents)}: {v.carePlan.status}
                </p>
              ) : null}
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Client contacts">
              {v.contacts.length ? (
                <ul className="space-y-1 text-sm">
                  {v.contacts.map((c) => (
                    <li key={c.email}>
                      {c.name} · <span className="text-stone-600">{c.email}</span> {c.activated ? null : <span className="text-xs text-amber-700">(hasn't set a password)</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No contacts.</Empty>
              )}
              <p className="mt-3 text-xs text-stone-500">{plural(v.messageCount, "message")} in the conversation (read them in the web app).</p>
            </Card>
            <Card title="Timeline">
              <ul className="space-y-1 text-sm">
                {v.timeline.map((t, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-stone-800">{EVENT_LABELS[t.type] ?? t.type.replaceAll("_", " ")}</span>
                    <span className="shrink-0 text-xs text-stone-500">{dateTime(t.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
