import { useState } from "react";
import { Alert, Card, Field, KeyValue } from "@/components/ui";
import type { ReconciliationView } from "@/lib/controls";
import type { PeriodSpend } from "@/lib/missions/contract";
import { dateTime } from "@/lib/format";
import type { Result } from "../../../shared/bridge";
import { Empty, Failure, Loading, SectionTitle } from "../../components";
import { kelqor, usd, useResult } from "../../lib";
import { exact, money, toMicros } from "./shared";

// Remaining amounts, the ledger, unverified items and manual reconciliation, with the benchmark's historical
// spending kept separate. Reconciliation needs no billing credentials: you read the provider's own figure in its
// console and enter it here with a note.

function Period({ title, p }: { title: string; p: PeriodSpend }) {
  return (
    <Card title={title}>
      <KeyValue
        rows={[
          ["Remaining", <span key="r" className="font-semibold">{money(p.remainingMicros)}</span>],
          ["Cap", money(p.capMicros)],
          ["Settled", exact(p.settledMicros)],
          ["Unverified", exact(p.unverifiedMicros)],
          ["Reserved now", exact(p.reservedMicros)],
        ]}
      />
    </Card>
  );
}

export function SpendingTab({ epoch, isFounder }: { epoch: number; isFounder: boolean }) {
  const res = useResult(() => kelqor().aiSpending(), [epoch]);
  const [show, setShow] = useState<"real" | "simulated" | "all">("real");
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  const s = res.data;
  const rows = s.ledger.filter((l) => (show === "all" ? true : show === "simulated" ? l.simulated : !l.simulated));
  const unverified = s.ledger.filter((l) => l.status === "unverified" && !l.simulated);
  return (
    <div className="space-y-4" data-testid="spending">
      {s.summary.blockedProviders.length ? (
        <Alert tone="rose" title="Requests to a provider are blocked">
          {s.summary.blockedProviders.join(", ")}: a reported cost or usage exceeded its reservation. Review it under Reconciliation to unblock it.
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Period title={`Today, ${s.summary.day.period} (America/Boise)`} p={s.summary.day} />
        <Period title={`${s.summary.month.period} (America/Boise)`} p={s.summary.month} />
      </div>
      <p className="text-xs text-stone-500">These are ceilings, not spending authorization. KELQOR caps what it sends; Google offers no per-request billing ceiling, so reconciliation catches any difference afterwards.</p>
      <Card
        title="Ledger"
        description="Every AI request, recorded before it was sent and updated afterwards. Entries are never edited away."
        actions={
          <select className="fx-input py-1 text-xs" value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Which entries">
            <option value="real">Real requests</option>
            <option value="simulated">Simulated ($0)</option>
            <option value="all">All</option>
          </select>
        }
      >
        {rows.length === 0 ? (
          <Empty>No requests.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="ledger">
              <thead>
                <tr className="border-b border-stone-200 text-left text-stone-500">
                  <th className="py-1.5 pr-2 font-medium">#</th>
                  <th className="py-1.5 pr-2 font-medium">Mission</th>
                  <th className="py-1.5 pr-2 font-medium">Purpose</th>
                  <th className="py-1.5 pr-2 font-medium">Model and price</th>
                  <th className="py-1.5 pr-2 font-medium">Sent (Boise day)</th>
                  <th className="py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Reserved</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Actual</th>
                  <th className="py-1.5 text-right font-medium">Counts now</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="border-b border-stone-100" data-ledger-status={l.status} data-ledger-simulated={String(l.simulated)} data-ledger-synthetic={String(l.synthetic)}>
                    <td className="py-1.5 pr-2">{l.seq}</td>
                    <td className="py-1.5 pr-2">{l.missionNumber ? `M-${String(l.missionNumber).padStart(4, "0")}` : "Adjustment"}</td>
                    <td className="py-1.5 pr-2">
                      {l.purpose}
                      {l.attempt > 1 ? ` (attempt ${l.attempt})` : ""}
                    </td>
                    <td className="py-1.5 pr-2">
                      {l.model} · {l.priceVersion}
                      {l.simulated ? " · simulated" : l.synthetic ? " · synthetic" : ""}
                    </td>
                    <td className="py-1.5 pr-2">
                      {dateTime(l.sentAt)} ({l.boiseDay})
                    </td>
                    <td className="py-1.5 pr-2">
                      {l.status}
                      {l.overReservation ? " · over reservation" : ""}
                      {l.errorKind ? ` · ${l.errorKind}` : ""}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{exact(l.reservedMicros)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{exact(l.actualMicros)}</td>
                    <td className="py-1.5 text-right tabular-nums">{exact(l.committedMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Reconciliation isFounder={isFounder} unverifiedCount={unverified.length} reloadAll={res.reload} blocked={s.summary.blockedProviders} />
      <Card title="Historical benchmark spending" description={s.historical.note}>
        <KeyValue
          rows={[
            ["Total", usd(s.historical.totalUsd, 2)],
            ...s.historical.stages.map((h) => [h.stage, `${usd(h.spentUsd, 4)} over ${h.requests} requests (cap ${usd(h.capUsd, 0)})`] as [string, string]),
          ]}
        />
      </Card>
    </div>
  );
}

function boiseMonthNow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Boise", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

function Reconciliation({ isFounder, unverifiedCount, reloadAll, blocked }: { isFounder: boolean; unverifiedCount: number; reloadAll: () => void; blocked: string[] }) {
  const [provider, setProvider] = useState("google");
  const [periodKind, setPeriodKind] = useState<"day" | "month">("month");
  const [period, setPeriod] = useState(boiseMonthNow());
  const [view, setView] = useState<ReconciliationView | null>(null);
  const [figure, setFigure] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const load = async () => {
    setFailure(null);
    const r = await kelqor().aiReconciliation(provider, periodKind, period);
    if (r.ok) setView(r.data);
    else setFailure(r);
  };
  const after = async (r: Result<unknown>) => {
    if (!r.ok) setFailure(r);
    else {
      setNote("");
      setFigure("");
      setPicked({});
      await load();
      reloadAll();
    }
  };
  const latest = view?.figures[0];
  return (
    <Card title="Reconciliation" description={`Compare KELQOR's ledger with the provider's own figure. ${unverifiedCount} unverified ${unverifiedCount === 1 ? "request" : "requests"} in the ledger.`}>
      <div className="space-y-3" data-testid="reconciliation">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Provider" htmlFor="rec-provider">
            <select id="rec-provider" className="fx-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="google">Google (Gemini)</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </Field>
          <Field label="Period" htmlFor="rec-kind">
            <select id="rec-kind" className="fx-input" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as "day" | "month")}>
              <option value="month">Month</option>
              <option value="day">Day</option>
            </select>
          </Field>
          <Field label={periodKind === "month" ? "YYYY-MM" : "YYYY-MM-DD"} htmlFor="rec-period">
            <input id="rec-period" className="fx-input w-36" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <button type="button" className="fx-btn fx-btn-secondary" data-action="load-reconciliation" onClick={() => void load()}>
            Show
          </button>
        </div>
        {failure ? <Failure result={failure} /> : null}
        {view ? (
          <div className="space-y-3">
            <KeyValue
              rows={[
                ["KELQOR settled", exact(view.settledMicros)],
                ["KELQOR unverified", exact(view.unverifiedMicros)],
                ["Released so far", exact(view.releasedMicros)],
                ["Adjustments", exact(view.adjustmentMicros)],
                ["Latest provider figure", latest ? `${exact(latest.providerMicros)} (difference ${exact(latest.differenceMicros)}) · ${latest.note}` : "None entered"],
              ]}
            />
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Provider's figure (USD)" htmlFor="rec-figure" hint="Read it in the provider's console for the same period.">
                <input id="rec-figure" className="fx-input w-36" inputMode="decimal" value={figure} onChange={(e) => setFigure(e.target.value)} />
              </Field>
              <Field label="Where you read it" htmlFor="rec-note">
                <input id="rec-note" className="fx-input w-72" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button
                type="button"
                className="fx-btn fx-btn-primary"
                data-action="record-figure"
                disabled={!isFounder || figure === "" || note.trim().length < 3}
                onClick={() => void kelqor().aiRecordFigure({ provider, periodKind, period, providerMicros: toMicros(figure), note }).then(after)}
              >
                Record the figure
              </button>
            </div>
            {latest && view.unverified.length ? (
              <div>
                <SectionTitle>Release unverified amounts against the latest figure</SectionTitle>
                <p className="text-xs text-stone-500">Never below the settled total or the provider's figure. Each release is a new record.</p>
                <ul className="mt-1 space-y-1 text-xs">
                  {view.unverified.map((u) => (
                    <li key={u.id} className="flex items-center gap-2">
                      <input
                        className="fx-input w-28 py-1 text-xs"
                        placeholder="0.0000"
                        value={picked[u.id] ?? ""}
                        onChange={(e) => setPicked((p) => ({ ...p, [u.id]: e.target.value }))}
                        aria-label={`Release from request ${u.seq}`}
                      />
                      #{u.seq} · {u.model} · {dateTime(u.sentAt)} · counts {exact(u.committedMicros)} · {u.errorDetail ?? u.errorKind ?? ""}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="fx-btn fx-btn-secondary mt-2"
                  data-action="release-unverified"
                  disabled={!isFounder || note.trim().length < 3 || !Object.values(picked).some((v) => Number(v) > 0)}
                  onClick={() =>
                    void kelqor()
                      .aiRelease({
                        figureId: latest.id,
                        entries: Object.entries(picked)
                          .filter(([, v]) => Number(v) > 0)
                          .map(([ledgerId, v]) => ({ ledgerId, micros: toMicros(v) })),
                        note,
                      })
                      .then(after)
                  }
                >
                  Release
                </button>
              </div>
            ) : null}
            {view.history.length ? (
              <ul className="space-y-0.5 text-xs text-stone-600">
                {view.history.map((h) => (
                  <li key={h.id}>
                    {dateTime(h.at)} · {h.kind} · {exact(h.micros)} · {h.recordedBy}: {h.note}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {blocked.length && isFounder ? (
          <div className="flex flex-wrap items-end gap-2">
            {blocked.map((b) => (
              <button key={b} type="button" className="fx-btn fx-btn-secondary" data-action="unblock-provider" disabled={note.trim().length < 3} onClick={() => void kelqor().aiUnblock(b, note).then(after)}>
                Unblock {b} after review
              </button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-stone-500">Provider dashboards update late, may use other time zones and total a whole project. Compare whole months where you can, using a Google project and key used only by KELQOR.</p>
      </div>
    </Card>
  );
}
