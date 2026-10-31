import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { STATUS_TONE } from "./status";
import { boiseMonth } from "@/lib/controls";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { orgs } from "@/lib/db/schema";
import { date, money } from "@/lib/format";
import type { CustomerRequestView } from "@/lib/services/contract";
import { customerReport, listInvoices, listRequests, listServices } from "@/lib/services/service";

export const metadata: Metadata = { title: "Your services" };

// The customer's Command Center (Milestone 4): what KELQOR runs for them, what it has done, what is waiting on them,
// and what it costs. Everything here comes through the managed-services domain, scoped to the customer's organization.


export default async function ServicesPage() {
  const user = await requireUser(["client"]);
  const actor = toActor(user);
  const db = await getDb();
  const [org] = actor.orgId ? await db.select().from(orgs).where(eq(orgs.id, actor.orgId)).limit(1) : [];
  if (!org) return <EmptyState title="Your account isn't linked to a company yet">Ask KELQOR to finish setting up your account.</EmptyState>;
  const period = boiseMonth(new Date());
  const services = await listServices(db, actor);
  const requests = (await listRequests(db, actor)) as CustomerRequestView[];
  const report = await customerReport(db, actor, org.id, period);
  const invoices = await listInvoices(db, actor);
  const waiting = requests.filter((r) => r.allowed.approve || r.allowed.answer);
  const pending = requests.filter((r) => ["received", "processing", "in_review"].includes(r.status));
  const done = requests.filter((r) => r.status === "completed");
  return (
    <div className="space-y-6" data-testid="customer-command-center">
      <PageHeader eyebrow={org.name} title="Your services" description="What KELQOR does for you, what's finished, and what's waiting on you." />
      {report.simulated ? (
        <Alert tone="violet" title="Demonstration">
          These results come from KELQOR's simulated processing, not a live AI service, and the invoices are simulated. Nothing is charged.
        </Alert>
      ) : null}
      {waiting.length ? (
        <Card title="Waiting on you" description="These need your answer or approval before KELQOR can finish them.">
          <ul className="divide-y divide-stone-100">
            {waiting.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <Link href={`/services/requests/${r.id}`} className="font-medium text-stone-900 hover:underline">
                  {r.label} · {r.title}
                </Link>
                <Badge tone="amber">{r.statusLabel}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={`Requests in ${period}`} value={String(report.requestsReceived)} />
        <Stat label="Completed" value={String(report.requestsCompleted)} hint={report.withinCommitment.total ? `${report.withinCommitment.met} of ${report.withinCommitment.total} on time` : undefined} />
        <Stat label="Median turnaround" value={report.medianTurnaroundHours === null ? "—" : `${report.medianTurnaroundHours} h`} />
        <Stat label="Quoted for you" value={money(report.quotedValueCents)} hint="Total of the quotes delivered this month" />
      </div>
      <Card title="Active services" actions={<LinkButton href="/services/report" variant="secondary">Monthly report</LinkButton>}>
        {services.length ? (
          <ul className="space-y-3">
            {services.map((s) => {
              const usage = report.services.find((x) => x.id === s.id);
              return (
                <li key={s.id} className="rounded border border-stone-200 p-3" data-service={s.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={s.status === "active" ? "emerald" : "neutral"}>{s.status === "active" ? "Active" : s.status === "paused" ? "Paused" : "Ended"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-stone-700">{s.promise}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    You get: {s.deliverable}. {usage ? `${usage.requests} of ${s.includedRequests} requests used this month.` : ""} {s.monthlyCents ? `${money(s.monthlyCents)} a month.` : "No monthly fee."}
                  </p>
                  {s.status === "active" ? (
                    <LinkButton href={`/services/new?service=${s.id}`} className="mt-2">
                      Send a request
                    </LinkButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">KELQOR hasn't started a service for you yet.</p>
        )}
      </Card>
      <Card title="Work in progress">
        {pending.length ? <RequestList items={pending} /> : <p className="text-sm text-stone-600">Nothing in progress.</p>}
      </Card>
      <Card title="Completed work">
        {done.length ? <RequestList items={done} /> : <p className="text-sm text-stone-600">Nothing completed yet.</p>}
      </Card>
      <Card title="Invoices" description="Simulated while KELQOR is in development; nothing is charged.">
        {invoices.length ? (
          <ul className="divide-y divide-stone-100 text-sm" data-testid="customer-invoices">
            {invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span>
                  {i.label} · {i.period}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone="violet">Simulated</Badge>
                  <Badge tone={i.status === "paid" ? "emerald" : "amber"}>{i.status === "paid" ? "Paid" : "Issued"}</Badge>
                  <span className="font-medium">{money(i.totalCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">No invoices yet.</p>
        )}
      </Card>
    </div>
  );
}

function RequestList({ items }: { items: CustomerRequestView[] }) {
  return (
    <ul className="divide-y divide-stone-100">
      {items.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-request={r.id}>
          <Link href={`/services/requests/${r.id}`} className="font-medium text-stone-900 hover:underline">
            {r.label} · {r.title}
          </Link>
          <span className="flex items-center gap-2 text-xs text-stone-500">
            {r.serviceName} · {date(r.submittedAt)}
            <Badge tone={STATUS_TONE[r.status]}>{r.statusLabel}</Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}
