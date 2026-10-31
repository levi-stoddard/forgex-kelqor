import { useState } from "react";
import { Alert, Badge, Card, Field, KeyValue, PageHeader, Stat, type Tone } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { CustomerDetail } from "@/lib/desktop/customers";
import type { OperatorRequestView, ServiceRequestStatus } from "@/lib/services/contract";
import type { QuoteLine } from "@/lib/services/processors";
import type { ViewProps } from "../App";
import { Empty, Failure, Loading, SectionTitle } from "../components";
import { kelqor, usd, useResult } from "../lib";

// Customer Operations (Milestone 4): KELQOR's side of managed services. Onboard a customer, configure and run its
// services, review what processing produced before the customer sees it, and bill (simulated) and report. The
// backend checks every action; this view only asks.

const requestKey = () => crypto.randomUUID();
const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "—" : usd(cents / 100));
const TONE: Record<ServiceRequestStatus, Tone> = { received: "neutral", processing: "sky", in_review: "violet", needs_info: "amber", awaiting_customer: "amber", completed: "emerald", declined: "neutral", failed: "rose" };

export function CustomersView({ epoch }: ViewProps) {
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<"customers" | "queue">("customers");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const o = useResult(() => kelqor().custOverview(), [epoch, tick]);
  const refresh = () => setTick((n) => n + 1);
  if (o.result && !o.result.ok && !o.data) return <Failure result={o.result} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  return (
    <div data-view="customers">
      <PageHeader eyebrow="Customer Operations" title="Managed services for your customers" description="Onboard customers, run their services, review the work before they see it, and bill and report. Processing and billing are simulated until live use is authorized." />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Customers" value={String(d.customers.length)} />
        <Stat label="Waiting for your review" value={String(d.reviewQueue.filter((r) => r.status === "in_review").length)} />
        <Stat label="Overdue" value={String(d.reviewQueue.filter((r) => r.overdue).length)} />
        <Stat label="Waiting on customers" value={String(d.customers.reduce((n, c) => n + c.awaitingCustomer, 0))} />
      </div>
      <div className="mb-4 flex gap-1 border-b border-stone-200" role="tablist">
        {(
          [
            ["customers", "Customers"],
            ["queue", "Review queue"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" data-cust-tab={k} aria-selected={tab === k} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-stone-900" : "border-transparent text-stone-500"}`} onClick={() => (setTab(k), setOrgId(null), setRequestId(null), refresh())}>
            {label}
          </button>
        ))}
      </div>
      {requestId ? (
        <RequestReview id={requestId} back={() => (setRequestId(null), refresh())} />
      ) : orgId ? (
        <CustomerPage orgId={orgId} period={d.period} plans={d.plans} categories={d.categories} back={() => (setOrgId(null), refresh())} openRequest={setRequestId} />
      ) : tab === "queue" ? (
        <Card title="Review queue" description="Requests every customer sent that are waiting for KELQOR. Nothing reaches a customer until it's reviewed here.">
          {d.reviewQueue.length ? (
            <ul className="divide-y divide-stone-100 text-sm" data-testid="review-queue">
              {d.reviewQueue.map((r) => (
                <li key={r.id} className="flex cursor-pointer items-center justify-between py-2 hover:bg-stone-50" data-queue-request={r.id} onClick={() => setRequestId(r.id)}>
                  <span>
                    <span className="font-medium">
                      {r.label} · {r.title || r.serviceName}
                    </span>
                    <span className="ml-2 text-xs text-stone-500">
                      {r.orgName} · {dateTime(r.submittedAt)}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    {r.simulated ? <Badge tone="violet">Simulated</Badge> : null}
                    {r.overdue ? <Badge tone="rose">Overdue</Badge> : null}
                    <Badge tone={TONE[r.status]}>{r.status.replace("_", " ")}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing is waiting for review.</Empty>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="Customers">
            {d.customers.length ? (
              <table className="w-full text-sm" data-testid="customers-table">
                <thead>
                  <tr className="text-left text-xs text-stone-500">
                    <th className="py-2">Customer</th>
                    <th>Services</th>
                    <th>Open</th>
                    <th>Needs review</th>
                    <th>Waiting on them</th>
                    <th>Attention</th>
                  </tr>
                </thead>
                <tbody>
                  {d.customers.map((c) => (
                    <tr key={c.orgId} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" data-customer={c.orgId} onClick={() => setOrgId(c.orgId)}>
                      <td className="py-2">
                        <span className="font-medium">{c.name}</span> {c.dataClass !== "real" ? <Badge tone="neutral">{c.dataClass}</Badge> : null}
                      </td>
                      <td>{c.services.filter((s) => s.status === "active").length} active</td>
                      <td>{c.open}</td>
                      <td>{c.awaitingReview}</td>
                      <td>{c.awaitingCustomer}</td>
                      <td>{c.overdue || c.failed ? <Badge tone="rose">{[c.overdue ? `${c.overdue} overdue` : "", c.failed ? `${c.failed} failed` : ""].filter(Boolean).join(", ")}</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No customers yet. Onboard one below.</Empty>
            )}
          </Card>
          <Onboard done={(id) => (refresh(), setOrgId(id))} />
        </div>
      )}
    </div>
  );
}

function Onboard({ done }: { done: (orgId: string) => void }) {
  const [f, setF] = useState({ companyName: "", contactName: "", email: "", industry: "", dataClass: "test" as "real" | "test" });
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    const r = await kelqor().custOnboard({ ...f, industry: f.industry || undefined });
    if (!r.ok) return setError(r.error);
    setInvite(r.data.inviteUrl);
    done(r.data.orgId);
  };
  return (
    <Card title="Onboard a customer" description="Creates the customer's organization and its first contact, with a one-time link to set a password. A synthetic or practice customer is a test record and never counts as business.">
      <div className="grid gap-3 sm:grid-cols-2" data-testid="onboard-form">
        <Field label="Company" htmlFor="ob-company">
          <input id="ob-company" className="fx-input" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} />
        </Field>
        <Field label="Industry" htmlFor="ob-industry">
          <input id="ob-industry" className="fx-input" value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} />
        </Field>
        <Field label="Contact's name" htmlFor="ob-contact">
          <input id="ob-contact" className="fx-input" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        </Field>
        <Field label="Contact's email" htmlFor="ob-email">
          <input id="ob-email" className="fx-input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Record" htmlFor="ob-class">
          <select id="ob-class" className="fx-input" value={f.dataClass} onChange={(e) => setF({ ...f, dataClass: e.target.value as "real" | "test" })}>
            <option value="test">Test (synthetic or practice)</option>
            <option value="real">Real customer</option>
          </select>
        </Field>
      </div>
      <button type="button" className="fx-btn fx-btn-primary mt-3" data-action="cust-onboard" onClick={() => void submit()}>
        Onboard
      </button>
      {invite ? (
        <p className="mt-2 text-sm text-emerald-800" data-testid="invite-link">
          Invitation link (give it to the contact yourself; KELQOR sends nothing): <code>{invite}</code>
        </p>
      ) : null}
      {error ? <Alert tone="rose">{error}</Alert> : null}
    </Card>
  );
}

function CustomerPage({ orgId, period: initial, plans, categories, back, openRequest }: { orgId: string; period: string; plans: { key: string; name: string; monthlyCents: number; includedRequests: number }[]; categories: { key: string; name: string }[]; back: () => void; openRequest: (id: string) => void }) {
  const [period, setPeriod] = useState(initial);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState({ category: "quote_intake", planKey: "starter", approvalAbove: "2500" });
  const [demoText, setDemoText] = useState("");
  const res = useResult(() => kelqor().custCustomer(orgId, period), [orgId, period, tick]);
  const refresh = () => setTick((n) => n + 1);
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    const r = await p;
    if (!r.ok) setError(r.error ?? "That didn't work.");
    refresh();
  };
  if (res.result && !res.result.ok && !res.data) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  const c: CustomerDetail = res.data;
  return (
    <div className="space-y-4" data-testid="customer-page">
      <button type="button" className="text-sm text-stone-600 hover:underline" onClick={back}>
        ← All customers
      </button>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{c.report.orgName}</h2>
        <input className="fx-input w-32 text-sm" value={period} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setPeriod(e.target.value)} aria-label="Month" />
      </div>
      {error ? <Alert tone="rose">{error}</Alert> : null}
      <Card title="Services">
        {c.services.length ? (
          <ul className="space-y-2" data-testid="customer-services">
            {c.services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 p-2 text-sm" data-cust-service={s.id} data-status={s.status}>
                <span>
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 text-xs text-stone-500">
                    {s.planKey} · {money(s.monthlyCents)}/mo · {s.includedRequests} included · approval above {s.config.customerApprovalAboveCents === null ? "never" : money(s.config.customerApprovalAboveCents)} · {s.config.turnaroundHours} h turnaround
                  </span>
                </span>
                <span className="flex gap-1">
                  <Badge tone={s.status === "active" ? "emerald" : s.status === "draft" ? "neutral" : "amber"}>{s.status}</Badge>
                  {s.status === "draft" ? (
                    <button type="button" className="fx-btn fx-btn-primary text-xs" data-action="cust-activate" onClick={() => void act(kelqor().custServiceAction(s.id, "activate", requestKey()))}>
                      Activate
                    </button>
                  ) : null}
                  {s.status === "active" ? (
                    <button type="button" className="fx-btn fx-btn-secondary text-xs" onClick={() => void act(kelqor().custServiceAction(s.id, "pause", requestKey()))}>
                      Pause
                    </button>
                  ) : null}
                  {s.status === "paused" ? (
                    <button type="button" className="fx-btn fx-btn-secondary text-xs" onClick={() => void act(kelqor().custServiceAction(s.id, "resume", requestKey()))}>
                      Resume
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">No services yet.</p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Add a service" htmlFor="svc-cat">
            <select id="svc-cat" className="fx-input" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })}>
              {categories.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan" htmlFor="svc-plan">
            <select id="svc-plan" className="fx-input" value={add.planKey} onChange={(e) => setAdd({ ...add, planKey: e.target.value })}>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({money(p.monthlyCents)}/mo, {p.includedRequests} requests)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Customer approves results above ($; blank = never)" htmlFor="svc-approval">
            <input id="svc-approval" className="fx-input w-28" value={add.approvalAbove} onChange={(e) => setAdd({ ...add, approvalAbove: e.target.value })} />
          </Field>
          <button
            type="button"
            className="fx-btn fx-btn-secondary"
            data-action="cust-add-service"
            onClick={() =>
              void act(
                kelqor().custAddService(
                  { orgId, category: add.category, planKey: add.planKey, config: { customerApprovalAboveCents: add.approvalAbove.trim() === "" ? null : Math.round(Number(add.approvalAbove) * 100) || 0 } },
                  requestKey(),
                ),
              )
            }
          >
            Add (as a draft)
          </button>
        </div>
      </Card>
      {c.services.some((s) => s.status === "active") ? (
        <Card title="Enter a request for this customer" description="For a request that reached KELQOR outside the portal, or for a demonstration. It's processed at once (simulated) and goes to the review queue.">
          <textarea className="fx-input h-24 w-full" value={demoText} onChange={(e) => setDemoText(e.target.value)} data-testid="operator-request-text" />
          <button type="button" className="fx-btn fx-btn-secondary mt-2" data-action="cust-submit" disabled={demoText.trim().length < 10} onClick={() => void act(kelqor().custSubmit({ serviceId: c.services.find((s) => s.status === "active")!.id, text: demoText }, requestKey()).then((r) => (r.ok && setDemoText(""), r)))}>
            Submit
          </button>
        </Card>
      ) : null}
      <Card title="Requests">
        {c.requests.length ? (
          <ul className="divide-y divide-stone-100 text-sm">
            {c.requests.map((r) => (
              <li key={r.id} className="flex cursor-pointer items-center justify-between py-2 hover:bg-stone-50" data-cust-request={r.id} onClick={() => openRequest(r.id)}>
                <span>
                  {r.label} · {r.title}
                </span>
                <span className="flex gap-1">
                  {r.overdue ? <Badge tone="rose">Overdue</Badge> : null}
                  <Badge tone={TONE[r.status]}>{r.statusLabel}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">No requests yet.</p>
        )}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`Report, ${period}`} description={c.report.simulated ? "Includes simulated work." : undefined}>
          <KeyValue
            rows={[
              ["Requests", `${c.report.requestsCompleted} completed of ${c.report.requestsReceived}`],
              ["Median turnaround", c.report.medianTurnaroundHours === null ? "—" : `${c.report.medianTurnaroundHours} h`],
              ["On time", c.report.withinCommitment.total ? `${c.report.withinCommitment.met} of ${c.report.withinCommitment.total}` : "—"],
              ["Quoted value delivered", money(c.report.quotedValueCents)],
              ["Missing details caught", String(c.report.questionsRaised)],
            ]}
          />
        </Card>
        <Card title={`Operating cost and margin, ${period}`} description="Estimates: processing is simulated, and the review labor rate is an assumption until you set it.">
          <KeyValue
            rows={[
              ["Invoiced (simulated)", money(c.costs.revenueCents)],
              ["AI processing", `${usd(c.costs.aiCostMicros / 1e6, 4)} (${c.costs.aiCostSource})`],
              ["Review time", `${c.costs.reviewMinutes} min · ${money(c.costs.reviewCostCents)}`],
              ["Margin", money(c.costs.marginCents)],
            ]}
          />
        </Card>
      </div>
      <Card title="Invoices (simulated)" description="No payment system is connected, and nothing is charged or sent. The database refuses any invoice that isn't simulated.">
        <ul className="space-y-2 text-sm" data-testid="customer-invoices-op">
          {c.invoices.map((i) => (
            <li key={i.id} className="rounded border border-stone-200 p-2" data-invoice={i.id} data-status={i.status}>
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {i.label} · {i.period}
                </span>
                <span className="flex items-center gap-1">
                  <Badge tone="violet">Simulated</Badge>
                  <Badge tone={i.status === "paid" ? "emerald" : i.status === "issued" ? "amber" : "neutral"}>{i.status}</Badge>
                  <span className="font-medium">{money(i.totalCents)}</span>
                  {i.status === "draft" ? (
                    <button type="button" className="fx-btn fx-btn-primary text-xs" data-action="cust-issue" onClick={() => void act(kelqor().custInvoiceAction(i.id, "issue", requestKey()))}>
                      Issue
                    </button>
                  ) : null}
                  {i.status === "issued" ? (
                    <button type="button" className="fx-btn fx-btn-secondary text-xs" data-action="cust-mark-paid" onClick={() => void act(kelqor().custInvoiceAction(i.id, "mark_paid", requestKey()))}>
                      Record payment (simulated)
                    </button>
                  ) : null}
                </span>
              </div>
              <ul className="mt-1 text-xs text-stone-600">
                {i.lines.map((l, n) => (
                  <li key={n}>
                    {l.description}: {l.quantity} × {money(l.unitCents)} = {money(l.amountCents)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <button type="button" className="fx-btn fx-btn-secondary mt-2" data-action="cust-invoice" onClick={() => void act(kelqor().custInvoice(orgId, period, requestKey()))}>
          Prepare the {period} invoice
        </button>
      </Card>
      <Card title="Offboard" description="Ends every service, turns off the customer's sign-in and ends their sessions. Nothing is deleted; export their records first (npm run customer:export).">
        <button
          type="button"
          className="fx-btn fx-btn-secondary"
          data-action="cust-offboard"
          onClick={() => {
            if (window.confirm(`Offboard ${c.report.orgName}? Its services end and its accounts can't sign in.`)) void act(kelqor().custOffboard(orgId, requestKey()));
          }}
        >
          Offboard this customer
        </button>
      </Card>
    </div>
  );
}

function RequestReview({ id, back }: { id: string; back: () => void }) {
  const [tick, setTick] = useState(0);
  const res = useResult(() => kelqor().custRequest(id), [id, tick]);
  const [note, setNote] = useState("");
  const [minutes, setMinutes] = useState("5");
  const [reply, setReply] = useState<string | null>(null);
  const [lines, setLines] = useState<QuoteLine[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (res.result && !res.result.ok && !res.data) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  const r: OperatorRequestView = res.data;
  const draft = r.draft;
  const shownLines = lines ?? draft?.lines ?? [];
  const decide = async (decision: "approve" | "ask_customer" | "fail") => {
    setError(null);
    const edits = decision === "approve" ? { ...(reply !== null ? { reply } : {}), ...(lines ? { lines: lines.map(({ amountCents: _a, ...l }) => l) } : {}) } : undefined;
    const out = await kelqor().custReview(r.id, { decision, draftHash: r.draftHash, note, minutes: Number(minutes) || 0, edits, customerMessage: message || undefined }, requestKey());
    if (!out.ok) return setError(out.error);
    setTick((n) => n + 1);
  };
  return (
    <div className="space-y-4" data-testid="request-review" data-status={r.status}>
      <button type="button" className="text-sm text-stone-600 hover:underline" onClick={back}>
        ← Back
      </button>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {r.label} · {r.title} <Badge tone={TONE[r.status]}>{r.statusLabel}</Badge> {r.simulated ? <Badge tone="violet">Simulated processing</Badge> : null} {r.overdue ? <Badge tone="rose">Overdue</Badge> : null}
          </span>
        }
        description={`${r.orgName} · ${r.serviceName} · ${dateTime(r.submittedAt)}`}
      >
        <SectionTitle>The request</SectionTitle>
        <pre className="whitespace-pre-wrap rounded bg-stone-50 p-2 text-sm">{r.input.text}</pre>
        {r.processing ? (
          <>
            <SectionTitle>What processing found (simulated, no AI)</SectionTitle>
            <ul className="text-sm" data-testid="extracted">
              {Object.entries(r.processing.extracted).map(([k, v]) => (
                <li key={k}>
                  <span className="font-medium">{k}:</span> {v ? <>{v.value} <span className="text-xs text-stone-500">“{v.evidence}”</span></> : <span className="text-amber-700">not found</span>}
                </li>
              ))}
            </ul>
            {r.processing.flags.length ? <Alert tone="amber">{r.processing.flags.join(" ")}</Alert> : null}
            {r.processing.questions.length ? (
              <>
                <SectionTitle>Questions for the customer</SectionTitle>
                <ul className="list-disc pl-5 text-sm">{r.processing.questions.map((q) => <li key={q}>{q}</li>)}</ul>
              </>
            ) : null}
            {r.processing.assumptions.length ? (
              <>
                <SectionTitle>Assumptions</SectionTitle>
                <ul className="list-disc pl-5 text-sm text-stone-700">{r.processing.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              </>
            ) : null}
          </>
        ) : null}
      </Card>
      {draft ? (
        <Card title={r.allowed.review ? "Draft for your review" : "Result"} description={r.allowed.review ? "Edit what's wrong, then decide. Your decision is bound to this draft; the customer doesn't see it until you release it." : undefined}>
          {shownLines.length ? (
            <table className="w-full text-sm" data-testid="draft-lines">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Rate ($)</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {shownLines.map((l, i) => (
                  <tr key={i} className="border-t border-stone-100">
                    <td className="py-1">{l.description}</td>
                    <td>
                      {r.allowed.review ? (
                        <input className="fx-input w-20" value={l.quantity} onChange={(e) => setLines(shownLines.map((x, n) => (n === i ? { ...x, quantity: Number(e.target.value) || 0, amountCents: Math.round((Number(e.target.value) || 0) * x.unitCents) } : x)))} />
                      ) : (
                        l.quantity
                      )}{" "}
                      {l.unit}
                    </td>
                    <td>
                      {r.allowed.review ? (
                        <input className="fx-input w-24" value={l.unitCents / 100} onChange={(e) => setLines(shownLines.map((x, n) => (n === i ? { ...x, unitCents: Math.round((Number(e.target.value) || 0) * 100), amountCents: Math.round(x.quantity * Math.round((Number(e.target.value) || 0) * 100)) } : x)))} />
                      ) : (
                        money(l.unitCents)
                      )}
                    </td>
                    <td className="text-right">{money(l.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">{draft.summary}</p>
          )}
          {draft.kind === "quote" ? <p className="mt-2 text-sm font-medium" data-testid="draft-total">Lines total: {money(shownLines.reduce((n, l) => n + l.amountCents, 0))} (the shop's minimum applies if it's higher)</p> : null}
          {r.allowed.review ? (
            <>
              <Field label="Reply for the customer to send" htmlFor="rv-reply">
                <textarea id="rv-reply" className="fx-input h-40" value={reply ?? draft.reply} onChange={(e) => setReply(e.target.value)} />
              </Field>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Field label="Internal note (the customer never sees it)" htmlFor="rv-note">
                  <input id="rv-note" className="fx-input" value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <Field label="Review minutes" htmlFor="rv-min">
                  <input id="rv-min" className="fx-input" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                </Field>
                <Field label="Message if you fail it" htmlFor="rv-msg">
                  <input id="rv-msg" className="fx-input" value={message} onChange={(e) => setMessage(e.target.value)} />
                </Field>
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="fx-btn fx-btn-primary" data-action="cust-approve" onClick={() => void decide("approve")}>
                  Approve and release
                </button>
                <button type="button" className="fx-btn fx-btn-secondary" data-action="cust-ask" onClick={() => void decide("ask_customer")}>
                  Ask the customer
                </button>
                <button type="button" className="fx-btn fx-btn-secondary" data-action="cust-fail" onClick={() => void decide("fail")}>
                  Fail it
                </button>
              </div>
            </>
          ) : (
            <pre className="mt-2 whitespace-pre-wrap text-sm">{(r.result ?? draft).reply}</pre>
          )}
          {error ? <Alert tone="rose">{error}</Alert> : null}
        </Card>
      ) : null}
      <Card title="Log">
        <ul className="space-y-1 text-sm" data-testid="request-log">
          {r.events.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-36 shrink-0 text-xs text-stone-500">{dateTime(e.at)}</span>
              {e.customerVisible ? null : <Badge tone="neutral">internal</Badge>}
              <span>{e.summary}</span>
            </li>
          ))}
        </ul>
        {r.reviewNote ? <p className="mt-2 text-xs text-stone-600">Internal note: {r.reviewNote}</p> : null}
        {r.customerNote ? <p className="mt-1 text-xs text-stone-600">Customer's note: {r.customerNote}</p> : null}
      </Card>
    </div>
  );
}
