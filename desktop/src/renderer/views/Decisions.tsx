import { ChevronRight, ExternalLink } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader, type Tone } from "@/components/ui";
import type { FounderItem } from "@/lib/desktop/types";
import { date } from "@/lib/format";
import type { ViewProps } from "../App";
import { Failure, FixtureBadge, Loading } from "../components";
import { kelqor, usd, useResult } from "../lib";

const KIND: Record<FounderItem["kind"], { label: string; tone: Tone }> = {
  opportunity: { label: "Qualify", tone: "ember" },
  quote: { label: "Quote", tone: "violet" },
  payment: { label: "Payment", tone: "teal" },
  dispute: { label: "Dispute", tone: "rose" },
  payout: { label: "Payout", tone: "blue" },
  builder: { label: "Builder", tone: "indigo" },
  care: { label: "Monthly service", tone: "sky" },
};

export function DecisionsView({ online, epoch, go }: ViewProps) {
  const res = useResult(() => kelqor().founderQueue(), [epoch]);
  const q = res.data;
  return (
    <div data-view="decisions">
      <PageHeader
        eyebrow="Owner Decisions"
        title="What's waiting on you"
        description="Real items from the business records and the research. Qualifying happens here; everything else opens in the established web workflow."
      />
      {res.result && !res.result.ok ? <Failure result={res.result} onRetry={res.reload} /> : null}
      {!q ? (
        res.loading ? <Loading /> : null
      ) : (
        <div className="space-y-4">
          <Card title={`Items (${q.items.length})`}>
            {q.items.length ? (
              <ul className="divide-y divide-stone-100" data-testid="founder-items">
                {q.items.map((item, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={KIND[item.kind].tone}>{KIND[item.kind].label}</Badge>
                        <span className="text-sm font-medium text-stone-900">{item.title}</span>
                        <FixtureBadge fixture={item.fixture} />
                      </div>
                      <p className="mt-0.5 text-xs text-stone-500">{item.detail}</p>
                    </div>
                    {item.opportunityId ? (
                      <button type="button" className="fx-btn fx-btn-secondary shrink-0 px-3 py-1.5 text-xs" onClick={() => go("opportunities", { opportunity: item.opportunityId })}>
                        Open dossier <ChevronRight size={13} />
                      </button>
                    ) : item.kind === "opportunity" ? (
                      <button type="button" className="fx-btn fx-btn-secondary shrink-0 px-3 py-1.5 text-xs" onClick={() => go("opportunities")}>
                        Opportunity Center <ChevronRight size={13} />
                      </button>
                    ) : item.webPath ? (
                      <button type="button" className="fx-btn fx-btn-secondary shrink-0 px-3 py-1.5 text-xs" disabled={!online} onClick={() => void kelqor().openWebApp(item.webPath!)}>
                        <ExternalLink size={13} /> Open in web app
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing is waiting on you" />
            )}
          </Card>
          <Card title="Research spending you approved" description="Recorded in authorizations.json; the runner refuses any stage not listed there.">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className="py-1 font-medium">Stage</th>
                  <th className="py-1 font-medium">Approved</th>
                  <th className="py-1 font-medium">Models</th>
                  <th className="py-1 text-right font-medium">Spent of cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {q.spendingApprovals.map((s) => (
                  <tr key={s.stage}>
                    <td className="py-1.5 font-medium text-stone-900">{s.stage}</td>
                    <td className="py-1.5 text-stone-700">{date(s.approvedOn)}</td>
                    <td className="py-1.5 text-stone-700">{s.models.join(", ")}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {usd(s.spentUsd, 2)} / {usd(s.capUsd, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-stone-500">A general approval center for AI actions is planned for a later milestone and isn't built.</p>
        </div>
      )}
    </div>
  );
}
