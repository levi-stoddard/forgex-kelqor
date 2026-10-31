import { Ban, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { Alert, Card, EmptyState, KeyValue } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { MissionSummary } from "@/lib/missions/service";
import type { Result } from "../../../shared/bridge";
import { Failure, Loading } from "../../components";
import { kelqor, useResult } from "../../lib";
import { KindBadge, money, MissionStatusBadge, requestId, shortHash, TYPE_LABEL } from "./shared";

/** Missions awaiting you, with their purpose, scope, model, estimate, maximum and the remaining budgets. */
export function ApprovalsTab({ epoch, open }: { epoch: number; open: (id: string) => void }) {
  const res = useResult(() => kelqor().aiApprovals(), [epoch]);
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  const a = res.data;
  return (
    <div className="space-y-4" data-testid="approval-center">
      {a.founder ? (
        <Alert tone={a.isFounder ? "emerald" : "sky"} title={a.isFounder ? "You hold owner spending authority" : `Owner spending authority: ${a.founder.name}`}>
          <span className="flex items-center gap-1.5" data-testid="founder-authority" data-founder={String(a.isFounder)}>
            <ShieldCheck size={14} /> Only {a.isFounder ? "your account" : "that account"} can approve, start or resume a mission, add Claude review, or release an unverified charge. Granted{" "}
            {dateTime(a.founder.since)}.
          </span>
        </Alert>
      ) : (
        <Alert tone="amber" title="No account holds owner spending authority yet">
          <span className="flex items-center gap-1.5" data-testid="founder-authority" data-founder="none">
            <ShieldOff size={14} /> Nothing can be approved until you designate your account. Close KELQOR and run{" "}
            <code className="rounded bg-white/70 px-1">npm run designate-founder -- --email your@email</code> in the project folder; it asks for that account's password.
          </span>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Today (America/Boise)">
          <KeyValue
            rows={[
              ["Remaining", money(a.spending.day.remainingMicros)],
              ["Committed", `${money(a.spending.day.committedMicros, 4)} of ${money(a.spending.day.capMicros)}`],
            ]}
          />
        </Card>
        <Card title="This month (America/Boise)">
          <KeyValue
            rows={[
              ["Remaining", money(a.spending.month.remainingMicros)],
              ["Committed", `${money(a.spending.month.committedMicros, 4)} of ${money(a.spending.month.capMicros)}`],
            ]}
          />
        </Card>
      </div>
      {a.waiting.length === 0 ? (
        <EmptyState title="Nothing is waiting for you">Submitted missions appear here for your approval.</EmptyState>
      ) : (
        a.waiting.map((m) => <ApprovalCard key={m.id} m={m} isFounder={a.isFounder} open={open} reload={res.reload} />)
      )}
      <Card title="Never approvable in M2B" description="No mission can do these, whatever is approved.">
        <ul className="space-y-1 text-sm" data-testid="never-approvable">
          {a.neverApprovable.map((n) => (
            <li key={n} className="flex items-center gap-2">
              <Ban size={13} className="text-stone-400" /> {n}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ApprovalCard({ m, isFounder, open, reload }: { m: MissionSummary; isFounder: boolean; open: (id: string) => void; reload: () => void }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    setFailure(null);
    const r = await kelqor().aiMissionAction(m.id, action, requestId(), action === "approve" ? { fingerprint: m.scopeFingerprint, purpose: m.purpose } : { reason });
    setBusy(false);
    if (!r.ok) setFailure(r);
    else reload();
  };
  const s = m.subject;
  return (
    <Card
      title={`${m.label} · ${m.title}`}
      description={m.purpose || "No business purpose given."}
      actions={
        <button type="button" className="fx-btn fx-btn-ghost px-2 py-1 text-xs" onClick={() => open(m.id)}>
          Open
        </button>
      }
    >
      <div data-approval={m.id}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MissionStatusBadge status={m.status} />
          <KindBadge simulated={m.simulated} provider={m.provider} />
        </div>
        <KeyValue
          rows={[
            ["Type", `${TYPE_LABEL[m.type]} · protocol ${m.protocol}`],
            ["Subject", s.kind === "company" ? `${s.name}, ${s.website}${s.town ? ` (${s.town}, ${s.state})` : ""}` : [s.industry, s.category, s.region].filter(Boolean).join(" · ")],
            ["Provider and model", `${m.provider} · ${m.model} · thinking ${m.thinkingLevel}`],
            ["Output limit", `${m.maxOutputTokens.toLocaleString("en-US")} tokens per request, thinking included`],
            ["Estimate", m.estimate.typicalMicros === null ? m.estimate.basis : `typical ${money(m.estimate.typicalMicros)}, heaviest so far ${money(m.estimate.heaviestMicros)}`],
            ["Reserved per large request", money(m.estimate.largestRequestMicros)],
            ["Research maximum", money(m.maxCostMicros)],
            ["Claude review", m.review ? `${m.review.model}, up to ${money(m.review.maxCostMicros)}` : "Off"],
            ["Scope fingerprint", <code key="fp">{shortHash(m.scopeFingerprint)}</code>],
          ]}
        />
        {m.stateReason ? <p className="mt-2 text-xs text-stone-600">{m.stateReason}</p> : null}
        {failure ? (
          <div className="mt-3">
            <Failure result={failure} />
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <button type="button" className="fx-btn fx-btn-primary" data-action="approve-mission" disabled={busy || !isFounder} title={isFounder ? undefined : "Only the owner's account can approve."} onClick={() => void act("approve")}>
            Approve exactly this scope
          </button>
          {m.status === "awaiting_approval" ? (
            <>
              <input className="fx-input max-w-xs" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="fx-btn fx-btn-secondary" data-action="reject-mission" disabled={busy || !isFounder} onClick={() => void act("reject")}>
                Reject
              </button>
            </>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-stone-500">An approval covers this mission's exact scope and expires at the end of today in Boise. Any change voids it.</p>
      </div>
    </Card>
  );
}
