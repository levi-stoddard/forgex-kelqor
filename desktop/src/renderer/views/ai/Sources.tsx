import { useState } from "react";
import { Badge, Card, Field, type Tone } from "@/components/ui";
import { SOURCE_KINDS } from "@/lib/missions/contract";
import type { SourceView } from "@/lib/sources/registry";
import type { Result, SourceInput } from "../../../shared/bridge";
import { Empty, Failure, Loading } from "../../components";
import { kelqor, useResult } from "../../lib";

// Approved source lists per industry, and proposed sources waiting for you. Nothing proposed is read by any mission
// until you approve it; every change is kept as a new version.

const STATUS_TONE: Record<SourceView["status"], Tone> = { proposed: "amber", approved: "emerald", rejected: "neutral", retired: "neutral" };

export function SourcesTab({ epoch, isFounder, industries }: { epoch: number; isFounder: boolean; industries: string[] }) {
  const res = useResult(() => kelqor().aiSources(), [epoch]);
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const [draft, setDraft] = useState<SourceInput>({ name: "", match: "", kind: "government agency", industries: [], purpose: "" });
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!res.data) return <Loading />;
  const decide = async (key: string, status: "approved" | "rejected" | "retired") => {
    setFailure(null);
    const r = await kelqor().aiDecideSource(key, status, "");
    if (!r.ok) setFailure(r);
    res.reload();
  };
  const add = async () => {
    setFailure(null);
    const r = await kelqor().aiAddSource(draft);
    if (!r.ok) setFailure(r);
    else setDraft({ name: "", match: "", kind: "government agency", industries: [], purpose: "" });
    res.reload();
  };
  const groups: [string, SourceView[]][] = [
    ["Waiting for your approval", res.data.filter((s) => s.status === "proposed")],
    ["Approved", res.data.filter((s) => s.status === "approved")],
    ["Rejected or retired", res.data.filter((s) => s.status === "rejected" || s.status === "retired")],
  ];
  return (
    <div className="space-y-4" data-testid="sources">
      {failure ? <Failure result={failure} /> : null}
      {groups.map(([title, list]) => (
        <Card key={title} title={title} description={title === "Waiting for your approval" ? "Claude's starter list and sources found during missions. None of these is read until you approve it." : undefined}>
          {list.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="divide-y divide-stone-100">
              {list.map((s) => (
                <li key={s.key} className="flex items-start justify-between gap-4 py-2" data-source={s.key} data-source-status={s.status}>
                  <div className="text-sm">
                    <div className="font-medium text-stone-900">
                      {s.name} <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                    </div>
                    <div className="text-xs text-stone-600">
                      {s.match} · {s.kind} · {s.industries.length ? s.industries.join(", ") : "every industry"}
                    </div>
                    <div className="text-xs text-stone-500">
                      {s.purpose} · {s.origin} · version {s.version}
                      {s.note ? ` · ${s.note}` : ""}
                    </div>
                  </div>
                  {isFounder ? (
                    <div className="flex shrink-0 gap-1.5">
                      {s.status !== "approved" ? (
                        <button type="button" className="fx-btn fx-btn-secondary px-2 py-1 text-xs" data-action="approve-source" onClick={() => void decide(s.key, "approved")}>
                          Approve
                        </button>
                      ) : null}
                      {s.status === "proposed" ? (
                        <button type="button" className="fx-btn fx-btn-ghost px-2 py-1 text-xs" data-action="reject-source" onClick={() => void decide(s.key, "rejected")}>
                          Reject
                        </button>
                      ) : null}
                      {s.status === "approved" ? (
                        <button type="button" className="fx-btn fx-btn-ghost px-2 py-1 text-xs" data-action="retire-source" onClick={() => void decide(s.key, "retired")}>
                          Retire
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      <Card title="Add a source" description="A domain (osha.gov, subdomains included) or an address prefix (https://www.bls.gov/ooh/). Social media, review sites, job boards and search engines are refused.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="source-name">
            <input id="source-name" className="fx-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Domain or address prefix" htmlFor="source-match">
            <input id="source-match" className="fx-input" value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value })} />
          </Field>
          <Field label="Kind" htmlFor="source-kind">
            <select id="source-kind" className="fx-input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as SourceInput["kind"] })}>
              {SOURCE_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="Industries (none selected: every industry)" htmlFor="source-industries">
            <select
              id="source-industries"
              multiple
              className="fx-input h-24"
              value={draft.industries}
              onChange={(e) => setDraft({ ...draft, industries: [...e.target.selectedOptions].map((o) => o.value) })}
            >
              {industries.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </Field>
          <Field label="Purpose" htmlFor="source-purpose">
            <input id="source-purpose" className="fx-input" value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
          </Field>
        </div>
        <button type="button" className="fx-btn fx-btn-primary mt-3" data-action="add-source" disabled={!draft.name.trim() || !draft.match.trim()} onClick={() => void add()}>
          {isFounder ? "Add and approve" : "Propose"}
        </button>
      </Card>
    </div>
  );
}
