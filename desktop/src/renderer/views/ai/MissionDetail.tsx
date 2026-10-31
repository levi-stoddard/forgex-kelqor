import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, Badge, Card, KeyValue } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { EvidenceCategory } from "@/lib/missions/contract";
import type { MissionAction } from "@/lib/missions/input";
import type { MissionDetail } from "@/lib/missions/service";
import type { MissionActionInput, Result } from "../../../shared/bridge";
import { Empty, Failure, Loading, SectionTitle } from "../../components";
import { kelqor, plural, useResult } from "../../lib";
import { MissionForm } from "./NewMission";
import { CategoryBadge, exact, KindBadge, money, MissionStatusBadge, requestId, SECTION_LABEL, shortHash, TYPE_LABEL } from "./shared";

// One mission: its live state and step log, cost so far, the actions you may take, and its results with their
// categories, sources with retrieval times, checks, gaps, review results and errors. The window only shows what the
// backend reports and never resends anything: reconnecting just reloads.

interface ClaimCheckView {
  where: string;
  statement: string;
  category: EvidenceCategory;
  finalCategory: EvidenceCategory;
  sourceUrl: string | null;
  quote: string | null;
  verdict: string;
  foundOn?: string;
  reasons: string[];
  staleSince?: string;
  review?: { verdict: string; note: string };
}

interface ResultView {
  report?: Record<string, unknown>;
  checks?: {
    claims: ClaimCheckView[];
    channels: { kind: string; value: string; sourceUrl: string; verdict: string }[];
    flags: { rule: string; where: string; detail: string }[];
    proposedSources: { url: string; name: string; kind: string; why: string; foundOn: string }[];
    summary: Record<string, number | boolean>;
    needsReview: string[];
  };
  review?: {
    finished: boolean;
    reason: string | null;
    model: string | null;
    reads: { url: string; retrievedAt: string; outcome: string; textSha256: string | null; changed: boolean }[];
    verdicts: { id: string; where: string; verdict: string; note: string }[];
    countedInputTokens: number | null;
    reservedMicros: number | null;
    actualMicros: number | null;
    summary: string | null;
  } | null;
  sources?: { url: string; finalUrl: string; outcome: string; retrievedAt: string; textSha256: string | null; sourceKey: string | null; detail: string }[];
  reviewReasons?: string[];
}

const ACTION_LABEL: Record<MissionAction, string> = {
  submit: "Submit for approval",
  approve: "Approve exactly this scope",
  reject: "Reject",
  start: "Start",
  resume: "Resume",
  cancel: "Cancel mission",
  review: "Add Claude review",
  accept: "Accept with its issues",
  close: "Close as not usable",
};

export function MissionDetailView({ id, epoch, back, onSpendChange }: { id: string; epoch: number; back: () => void; onSpendChange?: () => void }) {
  const [tick, setTick] = useState(0);
  const res = useResult(() => kelqor().aiMission(id), [id, epoch, tick]);
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [reviewModel, setReviewModel] = useState("claude-sonnet-5-5");
  const [reviewMax, setReviewMax] = useState("0.50");
  const [reviewEstimate, setReviewEstimate] = useState<{ pages: number; inputTokens: number; micros: number | null } | null>(null);
  const m = res.data;
  const live = m ? m.status === "running" || m.status === "verification" : false;

  // What review would reserve: the report and the cited pages, read again, at the reviewer's price.
  const reviewable = Boolean(m?.allowed.addReview);
  useEffect(() => {
    if (!reviewable || !m) return;
    void kelqor()
      .aiReviewEstimate(m.id, m.simulated ? "simulated" : reviewModel)
      .then((r) => setReviewEstimate(r.ok ? r.data : null));
  }, [reviewable, reviewModel, m?.id, m?.simulated]);

  // A change in the mission's state or spending refreshes the remaining budget shown above.
  const status = m?.status;
  const committed = m?.spend?.committedMicros;
  useEffect(() => {
    if (status !== undefined) onSpendChange?.();
  }, [status, committed]);

  // While a mission runs, its state is read again every two seconds; nothing is ever resent.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [live]);

  if (res.result && !res.result.ok && !m) return <Failure result={res.result} onRetry={res.reload} />;
  if (!m) return <Loading />;
  if (editing)
    return (
      <div>
        <button type="button" className="fx-btn fx-btn-ghost mb-3 px-2 py-1 text-xs" onClick={() => setEditing(false)}>
          <ArrowLeft size={14} /> Back to {m.label}
        </button>
        <MissionForm
          editing={m}
          done={() => {
            setEditing(false);
            res.reload();
          }}
        />
      </div>
    );

  const act = async (action: MissionAction, input: MissionActionInput = {}) => {
    setBusy(true);
    setFailure(null);
    const r = await kelqor().aiMissionAction(m.id, action, requestId(), input);
    setBusy(false);
    if (!r.ok) setFailure(r);
    res.reload();
  };
  const result = (m.result ?? {}) as ResultView;
  const checks = result.checks;
  const a = m.allowed;

  return (
    <div className="space-y-4" data-testid="mission-detail" data-mission={m.id} data-status={m.status} data-simulated={String(m.simulated)}>
      <button type="button" className="fx-btn fx-btn-ghost px-2 py-1 text-xs" onClick={back}>
        <ArrowLeft size={14} /> All missions
      </button>
      <Card
        title={`${m.label} · ${m.title}`}
        description={`${TYPE_LABEL[m.type]} · protocol ${m.protocol} · drafted by ${m.createdBy} ${dateTime(m.createdAt)}`}
        actions={
          <span className="flex items-center gap-2">
            <KindBadge simulated={m.simulated} provider={m.provider} />
            <MissionStatusBadge status={m.status} />
          </span>
        }
      >
        {m.stateReason ? (
          <div className="mb-3">
            <Alert tone={["failed", "interrupted", "budget_blocked"].includes(m.status) ? "rose" : "amber"} title="Why it's in this state">
              <span data-testid="state-reason">{m.stateReason}</span>
            </Alert>
          </div>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <KeyValue
            rows={[
              ["Provider and model", `${m.provider} · ${m.model} · thinking ${m.thinkingLevel}`],
              ["Output limit", `${m.maxOutputTokens.toLocaleString("en-US")} tokens per request`],
              ["Research maximum", money(m.maxCostMicros)],
              ["Claude review", m.review ? `${m.review.model}, up to ${money(m.review.maxCostMicros)}` : "Off"],
              ["Scope fingerprint", <code key="fp">{shortHash(m.scopeFingerprint)}</code>],
              ["Purpose", m.purpose || "—"],
            ]}
          />
          <div data-testid="mission-spend">
            <KeyValue
              rows={[
                ["Settled", exact(m.spend?.settledMicros)],
                ["Unverified", exact(m.spend?.unverifiedMicros)],
                ["Reserved now", exact(m.spend?.reservedMicros)],
                ["Committed", exact(m.spend?.committedMicros)],
                ["Approved maximum", money(m.spend?.approvedMicros)],
                [m.spend ? `Left of the ${money(Math.min(m.spend.capMicros, m.spend.approvedMicros))} approved` : "Left of the approval", money(m.spend?.remainingMicros)],
              ]}
            />
            {m.holdsPageText ? <p className="mt-2 text-xs text-stone-500">Unfinished: the pages it read are kept so it can resume; they're removed when it ends.</p> : null}
          </div>
        </div>
        {failure ? (
          <div className="mt-3">
            <Failure result={failure} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-end gap-2" data-testid="mission-actions">
          {a.edit ? (
            <button type="button" className="fx-btn fx-btn-secondary" data-action="edit-mission" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          {a.submit ? <ActionButton action="submit" busy={busy} onClick={() => void act("submit")} /> : null}
          {a.approve ? <ActionButton action="approve" primary busy={busy} onClick={() => void act("approve", { fingerprint: m.scopeFingerprint, purpose: m.purpose })} /> : null}
          {a.reject ? <ActionButton action="reject" busy={busy} onClick={() => void act("reject", { reason: note })} /> : null}
          {a.start ? <ActionButton action="start" primary busy={busy} onClick={() => void act("start")} /> : null}
          {a.resume ? <ActionButton action="resume" primary busy={busy} onClick={() => void act("resume")} /> : null}
          {a.accept ? <ActionButton action="accept" busy={busy} onClick={() => void act("accept", { note })} /> : null}
          {a.close ? <ActionButton action="close" busy={busy} onClick={() => void act("close", { note })} /> : null}
          {a.cancel ? (
            <ActionButton
              action="cancel"
              busy={busy}
              onClick={() => {
                if (window.confirm("Cancel this mission? No further request is sent. A request in flight is abandoned and counts as unverified until reconciled.")) void act("cancel");
              }}
            />
          ) : null}
          {a.reject || a.accept || a.close ? (
            <input className="fx-input max-w-xs" placeholder="Reason or note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          ) : null}
        </div>
        {a.addReview ? (
          <div className="mt-4 rounded-lg border border-stone-200 p-3" data-testid="add-review">
            <div className="text-sm font-medium text-stone-800">Add Claude review</div>
            <p className="text-xs text-stone-500">It needs its own approval, inside the mission's $2 and today's and this month's caps. Cited pages are read again at review time.</p>
            {reviewEstimate ? (
              <p className="text-xs text-stone-600" data-testid="review-estimate">
                Estimate: the report and {reviewEstimate.pages} cited {reviewEstimate.pages === 1 ? "page" : "pages"}, about {reviewEstimate.inputTokens.toLocaleString("en-US")} input tokens; reserved up to{" "}
                {money(reviewEstimate.micros)} before it is sent.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              {m.simulated ? (
                <span className="text-sm text-stone-600">Simulated reviewer ($0)</span>
              ) : (
                <select className="fx-input max-w-xs" value={reviewModel} onChange={(e) => setReviewModel(e.target.value)}>
                  <option value="claude-opus-5-5">Claude Opus 5.5</option>
                  <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
                  <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
                </select>
              )}
              <input className="fx-input w-28" inputMode="decimal" value={reviewMax} onChange={(e) => setReviewMax(e.target.value)} aria-label="Review maximum (USD)" />
              <ActionButton action="review" busy={busy} onClick={() => void act("review", { model: m.simulated ? "simulated" : reviewModel, maxCostMicros: Math.round(Number(reviewMax) * 1e6) })} />
            </div>
          </div>
        ) : null}
        {live ? <p className="mt-3 text-xs text-stone-500">Running. This page follows its progress from the backend.</p> : null}
      </Card>

      {checks ? <Results result={result} /> : null}

      <Card title="Approvals">
        {m.approvals.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="approvals">
            {m.approvals.map((ap) => (
              <li key={ap.id} data-approval-state={ap.state}>
                <Badge tone={ap.state === "active" ? "emerald" : "neutral"}>{ap.state}</Badge> {ap.kind === "review" ? "Review" : "Mission"} approved by {ap.approvedBy.name}{" "}
                {dateTime(ap.approvedAt)}, up to {money(ap.maxCostMicros)}, expires {dateTime(ap.expiresAt)}
                {ap.voidReason ? ` · ${ap.voidReason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Ledger" description="Every AI request this mission made, recorded before it was sent.">
        {m.ledger.length === 0 ? (
          <Empty>No requests yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="mission-ledger">
              <thead>
                <tr className="border-b border-stone-200 text-left text-stone-500">
                  <th className="py-1.5 pr-2 font-medium">#</th>
                  <th className="py-1.5 pr-2 font-medium">Purpose</th>
                  <th className="py-1.5 pr-2 font-medium">Sent</th>
                  <th className="py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Counted in</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Reserved</th>
                  <th className="py-1.5 text-right font-medium">Actual</th>
                </tr>
              </thead>
              <tbody>
                {m.ledger.map((l) => (
                  <tr key={l.id} className="border-b border-stone-100" data-ledger-status={l.status} data-ledger-purpose={l.purpose}>
                    <td className="py-1.5 pr-2">{l.seq}</td>
                    <td className="py-1.5 pr-2">
                      {l.purpose} {l.attempt > 1 ? `(attempt ${l.attempt})` : ""}
                    </td>
                    <td className="py-1.5 pr-2">{dateTime(l.sentAt)}</td>
                    <td className="py-1.5 pr-2">
                      {l.status}
                      {l.errorKind ? ` · ${l.errorKind}` : ""}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{l.countedInputTokens.toLocaleString("en-US")}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{exact(l.reservedMicros)}</td>
                    <td className="py-1.5 text-right tabular-nums">{exact(l.actualMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Step log">
        <ol className="space-y-1 text-xs" data-testid="step-log">
          {m.steps.map((s) => (
            <li key={s.seq} data-step-kind={s.kind} className="flex gap-2">
              <span className="w-32 shrink-0 text-stone-400">{dateTime(s.at)}</span>
              <span className="w-24 shrink-0 text-stone-500">{s.kind.replace(/_/g, " ")}</span>
              <span className="text-stone-800">
                {s.summary}
                {s.actor ? <span className="text-stone-400"> · {s.actor}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function ActionButton({ action, busy, primary = false, onClick }: { action: MissionAction; busy: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`fx-btn ${primary ? "fx-btn-primary" : "fx-btn-secondary"}`} data-action={`mission-${action}`} disabled={busy} onClick={onClick}>
      {ACTION_LABEL[action]}
    </button>
  );
}

function Results({ result }: { result: ResultView }) {
  const checks = result.checks!;
  const report = (result.report ?? {}) as Record<string, unknown>;
  const groups = new Map<string, ClaimCheckView[]>();
  for (const c of checks.claims) groups.set(c.where.split(".")[0], [...(groups.get(c.where.split(".")[0]) ?? []), c]);
  const evidence = (report.evidence ?? {}) as { gaps?: { missing: string; wouldSettle: string }[]; limitations?: string[] };
  const list = (key: string) => (Array.isArray(report[key]) ? (report[key] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const solutions = Array.isArray(report.possibleSolutions) ? (report.possibleSolutions as { addresses: string; rung: string; solution: string; why: string; confirmFirst: string }[]) : [];
  return (
    <Card title="Results" description={`${checks.summary.quoted ?? 0} quoted claims, ${checks.summary.quotedFailed ?? 0} failed their checks · ${plural(checks.flags.length, "flag")}`}>
      <div data-testid="mission-results">
        {result.reviewReasons?.length ? (
          <Alert tone="amber" title="Needs your review">
            <ul className="list-disc pl-4" data-testid="review-reasons">
              {result.reviewReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {[...groups.entries()].map(([section, claims]) => (
          <div key={section}>
            <SectionTitle>{SECTION_LABEL[section] ?? section}</SectionTitle>
            <ul className="space-y-2">
              {claims.map((c) => (
                <li key={c.where} className="text-sm" data-claim={c.where} data-final-category={c.finalCategory} data-verdict={c.verdict}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CategoryBadge category={c.finalCategory} />
                    {c.finalCategory !== c.category ? <span className="text-xs text-stone-500">(given as {c.category.replace(/_/g, " ")})</span> : null}
                    {c.staleSince ? <Badge tone="amber">Possibly stale: {c.staleSince}</Badge> : null}
                    {c.review ? <Badge tone={c.review.verdict === "supported" ? "emerald" : "rose"}>Review: {c.review.verdict}</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-stone-800">{c.statement}</div>
                  {c.quote ? <div className="mt-0.5 text-xs text-stone-600">“{c.quote}”</div> : null}
                  {c.sourceUrl ? (
                    <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-xs text-sky-700 hover:underline" onClick={() => void kelqor().openSource(c.sourceUrl!)}>
                      <ExternalLink size={11} /> {c.sourceUrl}
                    </button>
                  ) : null}
                  {c.reasons.length ? <div className="mt-0.5 text-xs text-rose-700">{c.reasons.join(" ")}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {list("notVisible").length ? (
          <>
            <SectionTitle>What public information can't show</SectionTitle>
            <ul className="list-disc pl-4 text-sm">{list("notVisible").map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        ) : null}
        {solutions.length ? (
          <>
            <SectionTitle>Possible solutions, simplest first</SectionTitle>
            <ul className="space-y-1 text-sm">
              {solutions.map((s, i) => (
                <li key={i}>
                  <Badge>{s.rung.replace(/_/g, " ")}</Badge> {s.solution} <span className="text-xs text-stone-500">· confirm first: {s.confirmFirst}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {list("discoveryQuestions").length ? (
          <>
            <SectionTitle>Discovery questions</SectionTitle>
            <ul className="list-disc pl-4 text-sm">{list("discoveryQuestions").map((q) => <li key={q}>{q}</li>)}</ul>
          </>
        ) : null}
        {checks.channels.length ? (
          <>
            <SectionTitle>Business contact channels</SectionTitle>
            <ul className="space-y-0.5 text-sm">
              {checks.channels.map((ch, i) => (
                <li key={i}>
                  {ch.kind}: {ch.value} <span className="text-xs text-stone-500">({ch.verdict})</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <SectionTitle>Source gaps</SectionTitle>
        {evidence.gaps?.length ? (
          <ul className="space-y-0.5 text-sm" data-testid="gaps">
            {evidence.gaps.map((g, i) => (
              <li key={i}>
                {g.missing} <span className="text-xs text-stone-500">· would settle it: {g.wouldSettle}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>None reported.</Empty>
        )}
        {checks.proposedSources.length ? (
          <>
            <SectionTitle>Proposed sources (not read; waiting for you in Sources)</SectionTitle>
            <ul className="space-y-0.5 text-sm">
              {checks.proposedSources.map((p) => (
                <li key={p.url}>
                  {p.name} · {p.url} <span className="text-xs text-stone-500">({p.kind}; linked from {p.foundOn})</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {checks.flags.length ? (
          <>
            <SectionTitle>Checks flagged</SectionTitle>
            <ul className="space-y-0.5 text-xs" data-testid="flags">
              {checks.flags.map((f, i) => (
                <li key={i} data-flag={f.rule}>
                  <span className="font-medium">{f.rule}</span> · {f.where}: {f.detail}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <SectionTitle>Pages read</SectionTitle>
        <ul className="space-y-0.5 text-xs" data-testid="sources-read">
          {(result.sources ?? []).map((s, i) => (
            <li key={i} data-source-outcome={s.outcome}>
              {s.outcome === "ok" ? "Read" : `Not read (${s.outcome})`} {s.finalUrl} · {dateTime(s.retrievedAt)} · fingerprint {shortHash(s.textSha256)}
              {s.sourceKey ? ` · approved source ${s.sourceKey}` : ""}
            </li>
          ))}
        </ul>
        {result.review ? (
          <>
            <SectionTitle>Claude review</SectionTitle>
            <div className="text-sm" data-testid="review-result" data-review-finished={String(result.review.finished)}>
              {result.review.finished ? (result.review.summary ?? "Finished.") : `Didn't finish: ${result.review.reason}`}
              <div className="mt-1 text-xs text-stone-500">
                {plural(result.review.reads.length, "cited page")} read again, {result.review.reads.filter((r) => r.changed).length} changed since the research · reviewer input{" "}
                {result.review.countedInputTokens?.toLocaleString("en-US") ?? "—"} tokens, reserved {exact(result.review.reservedMicros)}, actual {exact(result.review.actualMicros)}
              </div>
            </div>
          </>
        ) : null}
        {evidence.limitations?.length ? (
          <>
            <SectionTitle>Limitations</SectionTitle>
            <ul className="list-disc pl-4 text-xs text-stone-600">{evidence.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          </>
        ) : null}
      </div>
    </Card>
  );
}
