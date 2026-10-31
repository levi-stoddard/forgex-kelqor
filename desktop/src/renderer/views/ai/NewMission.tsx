import { useEffect, useMemo, useState } from "react";
import { Alert, Card, Field, KeyValue } from "@/components/ui";
import type { MissionEstimate } from "@/lib/missions/estimate";
import type { MissionInput } from "@/lib/missions/input";
import type { MissionDetail } from "@/lib/missions/service";
import { Failure, Loading } from "../../components";
import { kelqor, useResult } from "../../lib";
import type { Result } from "../../../shared/bridge";
import { money, requestId, toMicros } from "./shared";

// The mission form: type, subject, scope and model; Claude review (off) and the maximum (up to $2); the estimate,
// typical and maximum; then save it as a draft or submit it. Editing a draft or a submitted mission uses the same form,
// and any change voids an approval and returns the mission to Draft.

interface Draft {
  type: MissionInput["type"];
  simulated: boolean;
  synthetic: boolean;
  purpose: string;
  companyMode: "existing" | "new";
  recordId: string;
  name: string;
  website: string;
  town: string;
  state: string;
  industry: string;
  category: string;
  region: string;
  model: string;
  thinkingLevel: MissionInput["thinkingLevel"];
  maxUsd: string;
  review: boolean;
  reviewModel: string;
  reviewMaxUsd: string;
}

const BLANK: Draft = {
  type: "company_research",
  simulated: true,
  synthetic: false,
  purpose: "",
  companyMode: "existing",
  recordId: "",
  name: "",
  website: "",
  town: "",
  state: "ID",
  industry: "",
  category: "",
  region: "",
  model: "gemini-4-argon",
  thinkingLevel: "medium",
  maxUsd: "1.00",
  review: false,
  reviewModel: "claude-sonnet-5-5",
  reviewMaxUsd: "0.50",
};

function fromMission(m: MissionDetail): Draft {
  const s = m.subject;
  const review = m.review;
  return {
    ...BLANK,
    type: m.type,
    simulated: m.simulated,
    synthetic: m.provider === "synthetic",
    purpose: m.purpose,
    companyMode: s.kind === "company" && s.recordId ? "existing" : "new",
    recordId: s.kind === "company" ? (s.recordId ?? "") : "",
    name: s.kind === "company" ? s.name : "",
    website: s.kind === "company" ? s.website : "",
    town: s.kind === "company" ? s.town : "",
    state: s.kind === "company" ? s.state : "ID",
    industry: s.industry ?? "",
    category: s.kind === "industry" ? (s.category ?? "") : "",
    region: s.kind === "industry" ? (s.region ?? "") : "",
    model: m.simulated ? BLANK.model : m.model,
    thinkingLevel: m.thinkingLevel as Draft["thinkingLevel"],
    maxUsd: (m.maxCostMicros / 1e6).toFixed(2),
    review: Boolean(review),
    reviewModel: review && review.provider !== "simulation" ? review.model : BLANK.reviewModel,
    reviewMaxUsd: review ? (review.maxCostMicros / 1e6).toFixed(2) : BLANK.reviewMaxUsd,
  };
}

function toInput(d: Draft): MissionInput {
  const company = d.type === "company_research";
  return {
    type: d.type,
    simulated: d.simulated,
    synthetic: d.synthetic && !d.simulated,
    purpose: d.purpose,
    subject: company
      ? {
          kind: "company",
          recordId: d.companyMode === "existing" ? d.recordId || null : null,
          name: d.name,
          website: d.website,
          town: d.town,
          state: d.state,
          industry: d.industry || null,
        }
      : { kind: "industry", industry: d.industry, category: d.category || null, region: d.region || null },
    model: d.simulated ? "simulated" : d.model,
    thinkingLevel: d.thinkingLevel,
    maxCostMicros: Math.max(1, toMicros(d.maxUsd) || 0),
    review: d.review
      ? {
          provider: d.simulated ? "simulation" : d.synthetic ? "synthetic" : "anthropic",
          model: d.simulated ? "simulated" : d.reviewModel,
          maxCostMicros: Math.max(1, toMicros(d.reviewMaxUsd) || 0),
        }
      : null,
  };
}

export function MissionForm({ editing, done }: { editing?: MissionDetail; done: (id: string) => void }) {
  const options = useResult(() => kelqor().aiOptions(), []);
  const companies = useResult(() => kelqor().opportunities(), []);
  const [d, setD] = useState<Draft>(editing ? fromMission(editing) : BLANK);
  const [estimate, setEstimate] = useState<MissionEstimate | null>(null);
  const [failure, setFailure] = useState<Result<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const input = useMemo(() => toInput(d), [d]);
  const company = d.type === "company_research";
  const total = toMicros(d.maxUsd) + (d.review ? toMicros(d.reviewMaxUsd) : 0);
  const overCap = !(total > 0) || total > 2_000_000;
  const subjectMissing = company ? (d.companyMode === "existing" ? !d.recordId : !d.name.trim() || !d.website.trim()) : !d.industry;

  useEffect(() => {
    if (overCap) return;
    const t = setTimeout(() => {
      void kelqor()
        .aiEstimate(input)
        .then((r) => setEstimate(r.ok ? r.data : null));
    }, 250);
    return () => clearTimeout(t);
  }, [input, overCap]);

  if (options.result && !options.result.ok) return <Failure result={options.result} onRetry={options.reload} />;
  if (!options.data) return <Loading />;
  const o = options.data;

  const save = async (submit: boolean) => {
    setBusy(true);
    setFailure(null);
    const saved = await kelqor().aiSaveMission(editing?.id ?? null, input, requestId());
    if (!saved.ok) {
      setFailure(saved);
      setBusy(false);
      return;
    }
    if (submit) {
      const sub = await kelqor().aiMissionAction(saved.data.id, "submit", requestId(), {});
      if (!sub.ok) setFailure(sub);
    }
    setBusy(false);
    done(saved.data.id);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="mission-form">
      <div className="space-y-4 lg:col-span-2">
        <Card title={editing ? `Edit ${editing.label}` : "New mission"} description={editing ? "Saving returns the mission to Draft and voids any approval." : undefined}>
          <div className="space-y-4">
            <Field label="Mission type" htmlFor="mission-type">
              <select id="mission-type" className="fx-input" value={d.type} onChange={(e) => set("type", e.target.value as Draft["type"])}>
                <option value="company_research">Company research and discovery preparation</option>
                <option value="industry_research">Industry intelligence and operational pain points</option>
              </select>
            </Field>
            <Field label="Run as" htmlFor="mission-kind" hint="A simulated mission goes through the same approval, page reader and checks, calls no AI and costs $0.">
              <select
                id="mission-kind"
                className="fx-input"
                value={d.simulated ? "simulated" : d.synthetic ? "synthetic" : "real"}
                onChange={(e) => setD((x) => ({ ...x, simulated: e.target.value === "simulated", synthetic: e.target.value === "synthetic" }))}
              >
                <option value="simulated">Simulated, no AI, $0</option>
                <option value="real">Real: Gemini research, under your approval and the spending limits</option>
                {o.testMode.syntheticCosts ? <option value="synthetic">Synthetic test costs (test mode, isolated copy only)</option> : null}
              </select>
            </Field>
            {company ? (
              <>
                <Field label="Company" htmlFor="mission-company-mode">
                  <select id="mission-company-mode" className="fx-input" value={d.companyMode} onChange={(e) => set("companyMode", e.target.value as Draft["companyMode"])}>
                    <option value="existing">A company in the Opportunity Center</option>
                    <option value="new">A new company</option>
                  </select>
                </Field>
                {d.companyMode === "existing" ? (
                  <Field label="Opportunity Center company" htmlFor="mission-record">
                    <select id="mission-record" className="fx-input" value={d.recordId} onChange={(e) => set("recordId", e.target.value)}>
                      <option value="">Choose a company…</option>
                      {(companies.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id} · {c.name} ({c.town})
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name" htmlFor="mission-name">
                      <input id="mission-name" className="fx-input" value={d.name} onChange={(e) => set("name", e.target.value)} />
                    </Field>
                    <Field label="Official website" htmlFor="mission-website">
                      <input id="mission-website" className="fx-input" placeholder="https://" value={d.website} onChange={(e) => set("website", e.target.value)} />
                    </Field>
                    <Field label="Town" htmlFor="mission-town">
                      <input id="mission-town" className="fx-input" value={d.town} onChange={(e) => set("town", e.target.value)} />
                    </Field>
                    <Field label="State" htmlFor="mission-state">
                      <input id="mission-state" className="fx-input" value={d.state} onChange={(e) => set("state", e.target.value)} />
                    </Field>
                    <Field label="Industry (optional)" htmlFor="mission-industry">
                      <select id="mission-industry" className="fx-input" value={d.industry} onChange={(e) => set("industry", e.target.value)}>
                        <option value="">Not set: research identifies it</option>
                        {o.industries.map((i) => (
                          <option key={i}>{i}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
              </>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Industry" htmlFor="mission-industry">
                  <select id="mission-industry" className="fx-input" value={d.industry} onChange={(e) => set("industry", e.target.value)}>
                    <option value="">Choose…</option>
                    {o.industries.map((i) => (
                      <option key={i}>{i}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Category or operating model (optional)" htmlFor="mission-category">
                  <input id="mission-category" className="fx-input" placeholder="metal fabrication job shops" value={d.category} onChange={(e) => set("category", e.target.value)} />
                </Field>
                <Field label="Region (optional)" htmlFor="mission-region">
                  <input id="mission-region" className="fx-input" placeholder="Idaho" value={d.region} onChange={(e) => set("region", e.target.value)} />
                </Field>
              </div>
            )}
            <Field label="Business purpose" htmlFor="mission-purpose" hint="Shown in the Approval Center beside the scope.">
              <textarea id="mission-purpose" className="fx-input" rows={2} value={d.purpose} onChange={(e) => set("purpose", e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card title="Model and limits">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Research model" htmlFor="mission-model">
              <select id="mission-model" className="fx-input" value={d.simulated ? "simulated" : d.model} disabled={d.simulated} onChange={(e) => set("model", e.target.value)}>
                {d.simulated ? <option value="simulated">Simulated</option> : null}
                {o.researchModels.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.label}
                    {m.available ? "" : " (no key configured)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Thinking level" htmlFor="mission-thinking" hint="Guides how much the model thinks; the output limit caps it.">
              <select id="mission-thinking" className="fx-input" value={d.thinkingLevel} onChange={(e) => set("thinkingLevel", e.target.value as Draft["thinkingLevel"])}>
                {o.thinkingLevels.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Research maximum (USD)" htmlFor="mission-max" hint="Up to $2.00, review included.">
              <input id="mission-max" className="fx-input" inputMode="decimal" value={d.maxUsd} onChange={(e) => set("maxUsd", e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" id="mission-review" checked={d.review} onChange={(e) => set("review", e.target.checked)} /> Add Claude review of the finished report (off by default)
            </label>
            {d.review ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Reviewer" htmlFor="mission-reviewer">
                  <select id="mission-reviewer" className="fx-input" value={d.simulated ? "simulated" : d.reviewModel} disabled={d.simulated} onChange={(e) => set("reviewModel", e.target.value)}>
                    {d.simulated ? <option value="simulated">Simulated reviewer</option> : null}
                    {o.reviewModels.map((m) => (
                      <option key={m.model} value={m.model} disabled={!m.available && !d.synthetic}>
                        {m.label}
                        {m.available ? "" : " (unavailable: no Anthropic key)"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Review maximum (USD)" htmlFor="mission-review-max">
                  <input id="mission-review-max" className="fx-input" inputMode="decimal" value={d.reviewMaxUsd} onChange={(e) => set("reviewMaxUsd", e.target.value)} />
                </Field>
              </div>
            ) : null}
            <p className="text-xs text-stone-500">Output limit: 20,000 tokens per request, thinking included. Every request is counted and reserved before it is sent.</p>
          </div>
        </Card>
        {failure ? <Failure result={failure} /> : null}
        <div className="flex gap-2">
          <button type="button" className="fx-btn fx-btn-secondary" data-action="save-draft" disabled={busy || overCap || subjectMissing} onClick={() => void save(false)}>
            Save draft
          </button>
          <button type="button" className="fx-btn fx-btn-primary" data-action="submit-mission" disabled={busy || overCap || subjectMissing} onClick={() => void save(true)}>
            Save and submit for approval
          </button>
        </div>
      </div>
      <Card title="Estimate" description="Before anyone approves anything.">
        {overCap ? (
          <Alert tone="rose" title="Over the mission limit">
            The research and review maximums together must be more than $0 and at most $2.00.
          </Alert>
        ) : estimate ? (
          <div data-testid="mission-estimate">
            <KeyValue
              rows={[
                ["Typical", estimate.typicalMicros === null ? "—" : money(estimate.typicalMicros)],
                ["Heaviest so far", estimate.heaviestMicros === null ? "—" : money(estimate.heaviestMicros)],
                ["Reserved per large request", estimate.largestRequestMicros === null ? "—" : money(estimate.largestRequestMicros)],
                ["Research maximum", money(estimate.maxMicros)],
                ["Review maximum", estimate.reviewMaxMicros ? money(estimate.reviewMaxMicros) : "No review"],
                ["Price version", estimate.priceVersion ?? "—"],
              ]}
            />
            <p className="mt-2 text-xs text-stone-500">{estimate.basis}</p>
            {estimate.largestRequestMicros ? (
              <p className="mt-2 text-xs text-stone-500">
                Each request reserves its maximum before it is sent, so a mission stops when the next reservation wouldn't fit what's left of its maximum.
              </p>
            ) : null}
          </div>
        ) : (
          <Loading label="Estimating…" />
        )}
      </Card>
    </div>
  );
}
