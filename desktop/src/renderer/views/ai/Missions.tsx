import { Card, EmptyState } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { Failure, Loading } from "../../components";
import { kelqor, useResult } from "../../lib";
import { KindBadge, money, MissionStatusBadge, TYPE_LABEL } from "./shared";

/** Every mission with its type, subject, model, state, cost (actual, unverified and maximum) and its Real or Simulated label. */
export function MissionsTab({ epoch, open, create }: { epoch: number; open: (id: string) => void; create: () => void }) {
  const res = useResult(() => kelqor().aiMissions(), [epoch]);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  if (res.data.length === 0)
    return (
      <EmptyState
        title="No missions yet"
        action={
          <button type="button" className="fx-btn fx-btn-primary" data-action="new-mission" onClick={create}>
            New mission
          </button>
        }
      >
        A mission is one piece of AI research you approve: a company or an industry. Start with a simulated one; it costs $0 and calls no AI.
      </EmptyState>
    );
  return (
    <Card title="Missions" description="Nothing starts by itself: each mission runs only when you start it, under your approval.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="missions-table">
          <thead>
            <tr className="border-b border-stone-200 text-left text-xs text-stone-500">
              <th className="py-2 pr-3 font-medium">Mission</th>
              <th className="py-2 pr-3 font-medium">Subject</th>
              <th className="py-2 pr-3 font-medium">Model</th>
              <th className="py-2 pr-3 font-medium">State</th>
              <th className="py-2 pr-3 text-right font-medium">Actual</th>
              <th className="py-2 pr-3 text-right font-medium">Unverified</th>
              <th className="py-2 text-right font-medium">Maximum</th>
            </tr>
          </thead>
          <tbody>
            {res.data.map((m) => (
              <tr
                key={m.id}
                data-mission={m.id}
                data-mission-label={m.label}
                data-status={m.status}
                data-simulated={String(m.simulated)}
                className="cursor-pointer border-b border-stone-100 hover:bg-stone-50"
                onClick={() => open(m.id)}
              >
                <td className="py-2 pr-3">
                  <div className="font-medium text-stone-900">{m.label}</div>
                  <div className="text-xs text-stone-500">{TYPE_LABEL[m.type]}</div>
                </td>
                <td className="py-2 pr-3">
                  <div className="text-stone-800">{m.title}</div>
                  <div className="mt-0.5">
                    <KindBadge simulated={m.simulated} provider={m.provider} />
                  </div>
                </td>
                <td className="py-2 pr-3 text-xs text-stone-600">{m.model}</td>
                <td className="py-2 pr-3">
                  <MissionStatusBadge status={m.status} />
                  <div className="mt-0.5 text-xs text-stone-500">{dateTime(m.updatedAt)}</div>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(m.spend?.settledMicros, 4)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(m.spend?.unverifiedMicros, 4)}</td>
                <td className="py-2 text-right tabular-nums">{money(m.maxCostMicros + (m.review?.maxCostMicros ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
