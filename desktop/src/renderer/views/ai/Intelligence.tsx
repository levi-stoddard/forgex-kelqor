import { CircleCheck, CircleDashed, CircleOff, CircleSlash } from "lucide-react";
import { useState } from "react";
import { Badge, Card, EmptyState } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { Result } from "../../../shared/bridge";
import { Failure, Loading } from "../../components";
import { kelqor, useResult } from "../../lib";
import { money } from "./shared";

/** Industry research records and their versions. Company research uses a version only after you mark it reviewed. */
export function IntelligenceTab({ epoch, isFounder }: { epoch: number; isFounder: boolean }) {
  const res = useResult(() => kelqor().aiIntelligence(), [epoch]);
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  if (res.data.length === 0)
    return (
      <EmptyState title="No industry records yet">
        A completed real industry mission adds a version here. Simulated missions never do. Nothing here ever rewrites a playbook.
      </EmptyState>
    );
  return (
    <div className="space-y-3" data-testid="intelligence">
      {failure ? <Failure result={failure} /> : null}
      {res.data.map((v) => (
        <Card
          key={v.id}
          title={`${[v.industry, v.category, v.region].filter(Boolean).join(" · ")} · version ${v.version}`}
          description={`M-${String(v.missionNumber ?? 0).padStart(4, "0")} · ${v.protocol} · ${v.model} · ${money(v.costMicros, 4)} · ${dateTime(v.createdAt)}`}
          actions={
            <span className="flex items-center gap-2">
              {v.withIssues ? <Badge tone="amber">Accepted with issues</Badge> : null}
              {v.reviewedAt ? (
                <Badge tone="emerald">Reviewed by {v.reviewedBy}</Badge>
              ) : isFounder ? (
                <button
                  type="button"
                  className="fx-btn fx-btn-secondary px-2 py-1 text-xs"
                  data-action="mark-reviewed"
                  onClick={() =>
                    void kelqor()
                      .aiMarkReviewed(v.id)
                      .then((r) => {
                        if (!r.ok) setFailure(r);
                        res.reload();
                      })
                  }
                >
                  Mark reviewed
                </button>
              ) : (
                <Badge tone="amber">Not reviewed</Badge>
              )}
            </span>
          }
        >
          <button type="button" className="text-xs text-sky-700 hover:underline" onClick={() => setOpen(open === v.id ? null : v.id)}>
            {open === v.id ? "Hide the report" : "Show the report"}
          </button>
          {open === v.id ? <pre className="mt-2 max-h-96 overflow-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(v.report, null, 2)}</pre> : null}
        </Card>
      ))}
    </div>
  );
}

const STATE_ICON = { working: CircleCheck, built: CircleCheck, unavailable: CircleOff, off: CircleSlash, planned: CircleDashed } as const;

/** What is working, simulated or planned, so nothing looks more capable than it is. */
export function CapabilitiesTab({ epoch }: { epoch: number }) {
  const res = useResult(() => kelqor().aiCapabilities(), [epoch]);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  return (
    <Card title="Capabilities" description="M2B is built and tested with simulated providers. It isn't described as operational until one real, separately authorized mission passes (Gate 2).">
      <ul className="space-y-2" data-testid="capabilities">
        {res.data.map((c) => {
          const Icon = STATE_ICON[c.state as keyof typeof STATE_ICON] ?? CircleDashed;
          return (
            <li key={c.name} className="flex items-start gap-2 text-sm" data-capability={c.name} data-state={c.state}>
              <Icon size={15} className="mt-0.5 shrink-0 text-stone-500" />
              <span>
                <span className="font-medium text-stone-900">{c.name}</span> <Badge>{c.state}</Badge>
                <span className="block text-xs text-stone-500">
                  {c.area} · {c.detail}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 text-xs text-stone-500">
        Operating functions, not agents: Sales & Research (Missions A and B), Verification (automated checks; Claude review once authorized), Finance & Reporting (ledger,
        budgets, reconciliation) and Operations Coordinator (your queue, approvals and recovery) are working. Engineering (M3), Customer Support (M4) and Shared Learning &
        Memory are planned; reviewed industry records are its first building block.
      </div>
    </Card>
  );
}
