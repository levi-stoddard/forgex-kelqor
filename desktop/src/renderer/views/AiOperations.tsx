import { useEffect, useState } from "react";
import { Alert, PageHeader } from "@/components/ui";
import type { ViewProps } from "../App";
import { kelqor, useResult } from "../lib";
import { ApprovalsTab } from "./ai/Approvals";
import { CapabilitiesTab, IntelligenceTab } from "./ai/Intelligence";
import { MissionDetailView } from "./ai/MissionDetail";
import { MissionsTab } from "./ai/Missions";
import { MissionForm } from "./ai/NewMission";
import { money } from "./ai/shared";
import { SourcesTab } from "./ai/Sources";
import { SpendingTab } from "./ai/Spending";

// AI Operations, the command center for AI missions you control (Milestone 2B): missions, a new mission, the
// Approval Center, each mission's detail, spending, sources, industry intelligence and capabilities. The window only
// asks; the backend checks your authority, the approval and the budget before anything is sent.

const TABS = [
  ["missions", "Missions"],
  ["new", "New mission"],
  ["approvals", "Approval Center"],
  ["spending", "Spending"],
  ["sources", "Sources"],
  ["intelligence", "Industry intelligence"],
  ["capabilities", "Capabilities"],
] as const;
type Tab = (typeof TABS)[number][0];

export function AiOperationsView({ epoch }: ViewProps) {
  const [tab, setTab] = useState<Tab>("missions");
  const [missionId, setMissionId] = useState<string | null>(null);
  const [counter, setCounter] = useState(0);
  // The remaining budget is read again whenever a mission's state or spending changes, and every 15 seconds while the
  // view is open, so a mission settling in the background shows at once. Reading never sends anything.
  const [headTick, setHeadTick] = useState(0);
  const head = useResult(() => kelqor().aiApprovals(), [epoch, counter, headTick]);
  useEffect(() => {
    const t = setInterval(() => setHeadTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const options = useResult(() => kelqor().aiOptions(), [epoch]);
  const isFounder = head.data?.isFounder ?? false;
  const refresh = epoch * 1000 + counter;
  const open = (id: string) => {
    setMissionId(id);
    setTab("missions");
  };
  const waiting = head.data?.waiting.length ?? 0;
  return (
    <div data-view="ai">
      <PageHeader
        eyebrow="AI Operations"
        title="Missions you control"
        description="On-demand AI research under your approval, with enforced spending limits and a durable ledger. Nothing runs by itself, and simulated work is always labeled."
      />
      {head.data ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="ai-status">
          <div className="fx-card px-4 py-3 text-sm">
            <div className="text-xs text-stone-500">Left today (Boise)</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="left-today">
              {money(head.data.spending.day.remainingMicros)} <span className="text-xs font-normal text-stone-500">of $5.00</span>
            </div>
          </div>
          <div className="fx-card px-4 py-3 text-sm">
            <div className="text-xs text-stone-500">Left this month</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="left-month">
              {money(head.data.spending.month.remainingMicros)} <span className="text-xs font-normal text-stone-500">of $20.00</span>
            </div>
          </div>
          <div className="fx-card px-4 py-3 text-sm">
            <div className="text-xs text-stone-500">Owner authority</div>
            <div className="text-sm font-medium">{head.data.founder ? (isFounder ? "Yours" : head.data.founder.name) : "Not designated yet"}</div>
          </div>
        </div>
      ) : head.result && !head.result.ok ? (
        <div className="mb-4">
          <Alert tone="rose" title="AI Operations couldn't load">
            {head.result.error}
          </Alert>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-stone-200" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            data-ai-tab={key}
            aria-selected={tab === key}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}
            onClick={() => {
              setTab(key);
              if (key !== "missions") setMissionId(null);
              setCounter((c) => c + 1);
            }}
          >
            {label}
            {key === "approvals" && waiting ? <span className="ml-1 rounded-full bg-ember-500 px-1.5 text-xs text-white">{waiting}</span> : null}
          </button>
        ))}
      </div>
      {tab === "missions" ? (
        missionId ? (
          <MissionDetailView id={missionId} epoch={refresh} back={() => setMissionId(null)} onSpendChange={() => setHeadTick((n) => n + 1)} />
        ) : (
          <MissionsTab epoch={refresh} open={open} create={() => setTab("new")} />
        )
      ) : null}
      {tab === "new" ? <MissionForm done={(id) => open(id)} /> : null}
      {tab === "approvals" ? <ApprovalsTab epoch={refresh} open={open} /> : null}
      {tab === "spending" ? <SpendingTab epoch={refresh} isFounder={isFounder} /> : null}
      {tab === "sources" ? <SourcesTab epoch={refresh} isFounder={isFounder} industries={options.data?.industries ?? []} /> : null}
      {tab === "intelligence" ? <IntelligenceTab epoch={refresh} isFounder={isFounder} /> : null}
      {tab === "capabilities" ? <CapabilitiesTab epoch={refresh} /> : null}
    </div>
  );
}
