import { ChevronRight } from "lucide-react";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { money } from "@/lib/format";
import type { ViewProps } from "../App";
import { Failure, Loading } from "../components";
import { kelqor, plural, usd, useResult } from "../lib";
import { DecisionBadge } from "./Opportunities";

export function OverviewView({ status, epoch, go }: ViewProps) {
  const overview = useResult(() => kelqor().overview(), [epoch]);
  const opportunities = useResult(() => kelqor().opportunities(), [epoch]);
  const o = overview.data;
  const shortlist = (opportunities.data ?? []).filter((d) => d.category === "pursue now" || d.category === "pursue later");

  return (
    <div data-view="overview">
      <PageHeader eyebrow="Owner headquarters" title={`Good to see you, ${status.user?.name.split(" ")[0] ?? "owner"}`} description="Live from the local backend. Every company is classed real, demo or test; only real companies and real money count. Test and unverified money are shown apart." />
      {overview.result && !overview.result.ok ? <Failure result={overview.result} onRetry={overview.reload} /> : null}
      {!o && overview.loading ? <Loading /> : null}
      {o ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="overview-stats">
            <Stat label="Researched companies" value={o.opportunities.total} hint={`${o.opportunities.byCategory["pursue now"]} pursue now · ${o.opportunities.byCategory["pursue later"]} pursue later`} />
            <Stat
              label="Your qualification decisions"
              value={o.opportunities.total - o.opportunities.byDecision.undecided}
              hint={`${o.opportunities.byDecision.qualified} qualified · ${o.opportunities.byDecision.hold} hold · ${o.opportunities.byDecision.rejected} rejected`}
            />
            <Stat label="Open work orders" value={o.orders.openReal} hint={o.orders.openFixtures ? `${plural(o.orders.openFixtures, "open demo or test order")} not counted` : "Real orders only"} />
            <Stat label="Waiting on you" value={o.founderItems} hint="Items in Owner Decisions" />
            <Stat
              label="Collected (real payments)"
              value={money(o.money.collectedCents)}
              hint={[
                o.money.testCollectedCents ? `${money(o.money.testCollectedCents)} test money excluded` : "No test money",
                o.money.unverifiedCents ? `${money(o.money.unverifiedCents)} unverified` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <Stat
              label="Monthly services (real)"
              value={money(o.money.mrrCents)}
              hint={o.money.testMrrCents ? `${money(o.money.testMrrCents)}/month on test orders not counted` : "Plans on orders paid with real money"}
            />
            <Stat label="Client companies" value={o.companies.real} hint={o.companies.fixtures ? `${plural(o.companies.fixtures, "demo or test company", "demo or test companies")} not counted` : "Real companies only"} />
            <Stat label="AI spend recorded" value={usd(o.ai.researchSpendUsd + o.ai.scopingCostUsd)} hint={`Research ${usd(o.ai.researchSpendUsd)} · scoping ${usd(o.ai.scopingCostUsd)}`} />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card title="Prospects to review" description="Companies Gemini rated worth pursuing. A decision here never contacts anyone.">
              {opportunities.loading && !opportunities.data ? <Loading /> : null}
              <ul className="divide-y divide-stone-100">
                {shortlist.map((d) => (
                  <li key={d.id}>
                    <button type="button" data-open-dossier={d.id} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-stone-50" onClick={() => go("opportunities", { opportunity: d.id })}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-stone-900">{d.name}</span>
                        <span className="text-xs text-stone-500">
                          {d.town}, {d.state}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={d.category === "pursue now" ? "emerald" : "sky"}>{d.category}</Badge>
                        <DecisionBadge decision={d.decision?.decision ?? null} />
                        <ChevronRight size={14} className="text-stone-400" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Work orders by status" description={`Real orders only (${plural(o.orders.fixtures, "demo or test order")} left out).`}>
              {!o.orders.real ? <p className="text-sm text-stone-500">No real work orders yet. Demo and test orders are in the Business Workspace, labeled.</p> : null}
              <ul className="space-y-1.5 text-sm">
                {Object.entries(o.orders.byStatus)
                  .filter(([, n]) => n > 0)
                  .map(([s, n]) => (
                    <li key={s} className="flex justify-between">
                      <span className="text-stone-600">{s.replace("_", " ")}</span>
                      <span className="font-medium text-stone-900 tabular-nums">{n}</span>
                    </li>
                  ))}
              </ul>
              <button type="button" className="fx-link mt-3 text-sm" onClick={() => go("business")}>
                Open the Business Workspace
              </button>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
