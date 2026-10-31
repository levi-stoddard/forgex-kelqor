import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, KeyValue, PageHeader } from "@/components/ui";
import { boiseMonth } from "@/lib/controls";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { money } from "@/lib/format";
import { customerReport } from "@/lib/services/service";

export const metadata: Metadata = { title: "Monthly report" };

export default async function ServiceReportPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const user = await requireUser(["client"]);
  const actor = toActor(user);
  const db = await getDb();
  const asked = (await searchParams).period;
  const period = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : boiseMonth(new Date());
  const r = await customerReport(db, actor, actor.orgId ?? "", period);
  return (
    <div className="space-y-6" data-testid="customer-report">
      <Link href="/services" className="inline-block py-2 text-sm text-stone-600 hover:underline">
        ← Your services
      </Link>
      <PageHeader eyebrow={r.orgName} title={`Your ${period} report`} description="What KELQOR handled for you this month, and how it went." />
      {r.simulated ? <Alert tone="violet">Includes simulated work: the processing was done without a live AI service while KELQOR is in development.</Alert> : null}
      <Card title="Results">
        <KeyValue
          rows={[
            ["Requests received", String(r.requestsReceived)],
            ["Completed", String(r.requestsCompleted)],
            ["Median time to a result", r.medianTurnaroundHours === null ? "—" : `${r.medianTurnaroundHours} hours`],
            ["Within KELQOR's committed time", r.withinCommitment.total ? `${r.withinCommitment.met} of ${r.withinCommitment.total}` : "—"],
            ["Value of the quotes delivered", money(r.quotedValueCents)],
            ["Missing details caught before quoting", String(r.questionsRaised)],
            ["Results you approved", String(r.approvalsGiven)],
            ["This month's invoice", r.invoiceTotalCents === null ? "Not issued yet" : `${money(r.invoiceTotalCents)} (simulated)`],
          ]}
        />
      </Card>
      <Card title="By service">
        <KeyValue rows={r.services.map((s) => [s.name, `${s.completed} of ${s.requests} completed · ${s.requests} of ${s.included} included${s.overage ? ` · ${s.overage} over` : ""}`] as [string, string])} />
      </Card>
    </div>
  );
}
