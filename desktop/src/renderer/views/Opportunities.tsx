import { ExternalLink, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, BulletList, Card, EmptyState, KeyValue, PageHeader, type Tone } from "@/components/ui";
import type { DecisionRecord, DossierClaim, EvidenceLevel, OpportunityDetail, OpportunitySummary, OpportunityWorkflow } from "@/lib/desktop/types";
import { OPPORTUNITY_DECISION_LABELS, OPPORTUNITY_DECISIONS, type OpportunityDecision } from "@/lib/domain/types";
import { dateTime } from "@/lib/format";
import type { ViewProps } from "../App";
import { Empty, EvidenceBadge, Failure, Loading, SectionTitle } from "../components";
import { kelqor, usd, useResult } from "../lib";
import { CustomerFigures, DiscoveryCalls, FounderChecks, LevelBadge, Problems, WorkflowSummary } from "./Discovery";

const CATEGORY_TONE: Record<string, Tone> = { "pursue now": "emerald", "pursue later": "sky", "not a fit": "neutral", "insufficient evidence": "violet" };
const DECISION_TONE: Record<OpportunityDecision, Tone> = { qualified: "emerald", hold: "amber", rejected: "rose" };
type Filter = "all" | "prospects" | "undecided" | OpportunityDecision;

const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const isProspect = (d: OpportunitySummary) => d.category === "pursue now" || d.category === "pursue later";

export function DecisionBadge({ decision }: { decision: OpportunityDecision | null }) {
  if (!decision) return <Badge>Undecided</Badge>;
  return (
    <span data-decision={decision}>
      <Badge tone={DECISION_TONE[decision]}>{OPPORTUNITY_DECISION_LABELS[decision]}</Badge>
    </span>
  );
}

function CategoryBadge({ category }: { category: string | null }) {
  return <Badge tone={CATEGORY_TONE[category ?? ""] ?? "neutral"}>{category ?? "no report"}</Badge>;
}

function SourceLink({ url }: { url: string }) {
  return (
    <button type="button" title={`Open ${url} in your browser`} className="inline-flex max-w-full items-center gap-1 truncate text-xs text-ember-700 hover:underline" onClick={() => void kelqor().openSource(url)}>
      <ExternalLink size={11} className="shrink-0" /> <span className="truncate">{shortUrl(url)}</span>
    </button>
  );
}

export function OpportunitiesView({ online, epoch, initialId }: ViewProps & { initialId?: string }) {
  const list = useResult(() => kelqor().opportunities(), [epoch]);
  const [items, setItems] = useState<OpportunitySummary[]>([]);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (list.data) setItems(list.data);
  }, [list.data]);
  useEffect(() => {
    if (!selected && items.length) setSelected((items.find(isProspect) ?? items[0]).id);
  }, [items, selected]);

  const shown = useMemo(
    () =>
      items.filter((d) => {
        if (query && !d.name.toLowerCase().includes(query.toLowerCase())) return false;
        if (filter === "prospects") return isProspect(d);
        if (filter === "undecided") return !d.decision;
        if (filter !== "all") return d.decision?.decision === filter;
        return true;
      }),
    [items, filter, query],
  );

  const decided = (id: string, decision: DecisionRecord) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, decision } : x)));
  const filters: [Filter, string][] = [
    ["all", "All"],
    ["prospects", "Prospects"],
    ["undecided", "Undecided"],
    ...OPPORTUNITY_DECISIONS.map((d) => [d, OPPORTUNITY_DECISION_LABELS[d]] as [Filter, string]),
  ];

  return (
    <div data-view="opportunities">
      <PageHeader
        eyebrow="Opportunity Center"
        title="Researched companies"
        description="Saved Gemini 4 Argon research from the full benchmark (dataset B, frozen). Internal sales research: it is never shown to customers, and a decision never contacts anyone."
      />
      {list.result && !list.result.ok ? <Failure result={list.result} onRetry={list.reload} /> : null}
      <div className="grid grid-cols-[300px_1fr] items-start gap-4">
        <div className="fx-card sticky top-4 overflow-hidden">
          <div className="space-y-2 border-b border-stone-100 p-3">
            <label className="relative block">
              <Search size={14} className="absolute top-2.5 left-2.5 text-stone-400" />
              <input className="fx-input pl-8!" placeholder="Search companies" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-1">
              {filters.map(([f, label]) => (
                <button key={f} type="button" data-filter={f} onClick={() => setFilter(f)} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${filter === f ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700 hover:bg-stone-200"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {list.loading && !items.length ? <Loading /> : null}
          <ul className="kq-scroll max-h-[calc(100vh-260px)] divide-y divide-stone-100" data-testid="opportunity-list">
            {shown.map((d) => (
              <li key={d.id}>
                <button type="button" data-select-dossier={d.id} onClick={() => setSelected(d.id)} className={`w-full px-3 py-2.5 text-left ${selected === d.id ? "bg-ember-50" : "hover:bg-stone-50"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm leading-snug font-medium text-stone-900">{d.name}</span>
                    <DecisionBadge decision={d.decision?.decision ?? null} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-stone-500">
                    <CategoryBadge category={d.category} />
                    <span>{d.access === "restricted" ? "site not read" : `${d.quotesVerified}/${d.facts} quotes verified`}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500" data-readiness={d.readiness.stage}>
                    {d.industry ?? "Industry not known"} · {d.readiness.label}
                  </div>
                </button>
              </li>
            ))}
            {!shown.length && items.length ? <li className="p-4 text-sm text-stone-500">No companies match.</li> : null}
          </ul>
        </div>
        <div>{selected ? <Dossier key={selected} id={selected} online={online} epoch={epoch} onDecided={decided} /> : <EmptyState title="Choose a company" />}</div>
      </div>
    </div>
  );
}

function Dossier({ id, online, epoch, onDecided }: { id: string; online: boolean; epoch: number; onDecided: (id: string, d: DecisionRecord) => void }) {
  const res = useResult(() => kelqor().opportunity(id), [id, epoch]);
  const [wf, setWf] = useState<OpportunityWorkflow | null>(null);
  useEffect(() => {
    if (res.data) setWf(res.data.workflow);
  }, [res.data]);
  const d = res.data;
  if (res.result && !res.result.ok) return <Failure result={res.result} onRetry={res.reload} />;
  if (!d || !wf) return <Loading label="Opening dossier…" />;
  const flow = { d, wf, online, onChange: setWf };
  // Readiness depends on the decision, so it's refreshed from the backend after each save.
  const decided = (rid: string, r: DecisionRecord) => {
    onDecided(rid, r);
    void kelqor()
      .opportunity(rid)
      .then((x) => (x.ok ? setWf(x.data.workflow) : undefined));
  };
  return (
    <div className="space-y-4" data-dossier={d.id}>
      <Header d={d} wf={wf} />
      <ResearchVersions d={d} />
      <DecisionPanel d={d} online={online} onDecided={decided} />
      <WorkflowSummary {...flow} />
      <Problems {...flow} />
      <CustomerFigures {...flow} />
      <DiscoveryCalls {...flow} />
      <FounderChecks {...flow} />
      {d.access === "restricted" ? (
        <Alert tone="violet" title="This website wasn't read">
          {d.accessNote} Gemini was told only the company's name, town and website, so this dossier states no facts and is rated insufficient evidence.
        </Alert>
      ) : null}
      <Qualification d={d} wf={wf} />
      {d.access === "full" ? (
        <>
          <Opportunity d={d} />
          <Evidence d={d} wf={wf} />
          <Contacts d={d} />
        </>
      ) : null}
      <Checks d={d} />
    </div>
  );
}

function Header({ d, wf }: { d: OpportunityDetail; wf: OpportunityWorkflow }) {
  const industry = wf.industry.value ?? wf.industry.suggested;
  return (
    <div className="fx-card px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-stone-900" data-testid="dossier-name">
            {d.name}
          </h2>
          <p className="mt-0.5 text-sm text-stone-600">
            {d.identity.location}
            {d.industry.industry ? ` · ${d.industry.industry}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-stone-500" data-testid="industry-shown">
            Industry: {industry ?? "not known"}
            {industry ? (wf.industry.value ? " (confirmed by you)" : " (suggested from research)") : ""}
          </p>
          <div className="mt-1">
            <SourceLink url={d.website} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <CategoryBadge category={d.category} />
          <span className="inline-flex items-center gap-1 text-xs text-stone-500">
            <Lock size={11} /> Internal research
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-stone-500" data-testid="research-source" data-historical={String(d.historical)}>
        {d.source.label} · {d.source.dataset} · researched {dateTime(d.run.finishedAt)}
        {d.historical ? ` · ${d.run.turns} turns` : ""} · {usd(d.run.costUsd, 4)}
      </p>
    </div>
  );
}

/** Company research from real missions, beside the frozen benchmark dossier; AI results never change your records. */
function ResearchVersions({ d }: { d: OpportunityDetail }) {
  if (d.researchVersions.length === 0) return null;
  return (
    <Card title="Research versions from missions" description="Each completed real mission adds a version; nothing earlier is overwritten. Your decisions and discovery records stay as you left them.">
      <ul className="space-y-1 text-sm" data-testid="research-versions">
        {d.researchVersions.map((v) => (
          <li key={v.id} data-research-version={v.version}>
            Version {v.version} · M-{String(v.missionNumber ?? 0).padStart(4, "0")} · {v.protocol} · {v.model} · {dateTime(v.createdAt)} · {usd(v.costMicros / 1e6, 4)}
            {v.withIssues ? " · accepted with issues" : ""}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DecisionPanel({ d, online, onDecided }: { d: OpportunityDetail; online: boolean; onDecided: (id: string, r: DecisionRecord) => void }) {
  const [saved, setSaved] = useState<DecisionRecord | null>(d.decision);
  const [choice, setChoice] = useState<OpportunityDecision | null>(d.decision?.decision ?? null);
  const [note, setNote] = useState(d.decision?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const dirty = choice !== (saved?.decision ?? null) || note.trim() !== (saved?.note ?? "");

  async function save() {
    if (!choice) return;
    setBusy(true);
    setMessage(null);
    const res = await kelqor().decide(d.id, choice, note.trim());
    setBusy(false);
    if (res.ok) {
      setSaved(res.data);
      onDecided(d.id, res.data);
      setMessage({ tone: "emerald", text: `Saved to the business database at ${dateTime(res.data.decidedAt)}.` });
    } else {
      setMessage({ tone: "rose", text: res.offline ? "Not saved: the local backend is unavailable. Your choice is still selected; save again once it reconnects." : `Not saved: ${res.error}` });
    }
  }

  return (
    <Card title="Your decision" description="Internal only. Qualifying a company doesn't contact it or create a customer record.">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Qualification">
        {OPPORTUNITY_DECISIONS.map((v) => (
          <button
            key={v}
            type="button"
            data-choice={v}
            aria-pressed={choice === v}
            disabled={!online || busy}
            onClick={() => setChoice(v)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold tracking-wide ring-1 transition-colors ring-inset disabled:cursor-not-allowed disabled:opacity-50 ${
              choice === v ? (v === "qualified" ? "bg-emerald-600 text-white ring-emerald-600" : v === "hold" ? "bg-amber-500 text-white ring-amber-500" : "bg-rose-600 text-white ring-rose-600") : "bg-white text-stone-700 ring-stone-300 hover:bg-stone-50"
            }`}
          >
            {OPPORTUNITY_DECISION_LABELS[v].toUpperCase()}
          </button>
        ))}
      </div>
      <textarea className="fx-input mt-3" rows={2} maxLength={2000} placeholder="Note for yourself (optional)" value={note} disabled={!online || busy} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-action="save-decision" className="fx-btn fx-btn-primary" disabled={!online || busy || !choice || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save decision"}
        </button>
        <span className="text-xs text-stone-500" data-saved-decision={saved?.decision ?? "none"}>
          {saved ? `Saved: ${OPPORTUNITY_DECISION_LABELS[saved.decision]} · ${dateTime(saved.decidedAt)} · ${saved.decidedBy}` : "No decision saved yet."}
        </span>
      </div>
      {!online ? <p className="mt-2 text-xs font-medium text-rose-700">Paused while the local backend is unavailable.</p> : null}
      {message ? (
        <div className="mt-3" data-testid="decision-message">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      ) : null}
      {saved?.decision === "qualified" ? (
        <div className="mt-4 rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-700">
          <p>
            <span className="font-medium">Next: a discovery conversation.</span> Record it below; a Work Order is drafted from a problem the customer
            confirms. If you have already agreed on the work, you can also start a blank one with only the name and industry.
          </p>
          <button type="button" data-action="open-sale" className="fx-btn fx-btn-secondary mt-2 px-3 py-1.5 text-xs" disabled={!online} onClick={() => void kelqor().openWebApp(d.salePath)}>
            <ExternalLink size={13} /> Open a blank New Work Order in the web app
          </button>
          <p className="mt-1 text-xs text-stone-500">Opens your browser with the company name filled in. Nothing is sent to the company.</p>
        </div>
      ) : null}
    </Card>
  );
}

function Qualification({ d, wf }: { d: OpportunityDetail; wf: OpportunityWorkflow }) {
  return (
    <Card title="Research qualification" description="Gemini's category and reasoning, with the independent review where one exists.">
      <p className="mb-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600" data-testid="research-frame">
        {wf.researchFrame}
      </p>
      <p className="text-sm text-stone-800">{d.rationale || "No rationale recorded."}</p>
      {d.review?.assessment || d.review?.keyEvidence ? (
        <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <div className="text-xs font-semibold tracking-wide uppercase">Independent review (dataset C, by Claude)</div>
          {d.review.assessment ? <p className="mt-1">{d.review.assessment}</p> : null}
          {d.review.keyEvidence ? <p className="mt-1">Checked evidence: {d.review.keyEvidence}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

const labelTone = (l: string): Tone => (l === "fact" ? "emerald" : l === "inference" ? "sky" : "neutral");

function Opportunity({ d }: { d: OpportunityDetail }) {
  return (
    <Card title="Business opportunity" description="Problems, the ForgeX offers that fit, and what the company already owns.">
      <SectionTitle>Problems the model predicted (level 3: never checked, confirmed by no one)</SectionTitle>
      {d.problems.length ? (
        <ul className="space-y-2">
          {d.problems.map((p, i) => (
            <li key={i} className="text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="text-stone-800">{p.problem}</span>
                <Badge tone={labelTone(p.label)}>{p.label}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-stone-500">Basis: {p.basis}</p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>None identified.</Empty>
      )}
      <SectionTitle>Offers that fit</SectionTitle>
      {d.offers.length ? (
        <ul className="space-y-2">
          {d.offers.map((o, i) => (
            <li key={i} className="rounded-lg border border-stone-200 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-stone-900">{o.name}</span>
                <Badge tone={o.kind === "catalog" ? "ember" : "violet"}>{o.kind}</Badge>
              </div>
              <p className="mt-1 text-stone-700">{o.description}</p>
              <p className="mt-1 text-xs text-stone-500">Problem: {o.problem}</p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No ForgeX offer is justified.</Empty>
      )}
      <SectionTitle>What they already have</SectionTitle>
      {d.existingSolutions.length ? (
        <BulletList items={d.existingSolutions.map((s) => `${s.solution}${s.alreadyOwned ? " (already owned)" : ""}: ${s.addresses}`)} />
      ) : (
        <Empty>Nothing recorded.</Empty>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <SectionTitle>Commercial value</SectionTitle>
          {d.commercial.value ? <p className="text-sm text-stone-800">{d.commercial.value}</p> : <Empty>Not supportable from the site's prices.</Empty>}
          {d.commercial.assumptions.length ? <BulletList items={d.commercial.assumptions} /> : null}
          {d.commercial.implementationCost ? <p className="mt-2 text-xs text-stone-500">Implementation: {d.commercial.implementationCost}</p> : null}
        </div>
        <div>
          <SectionTitle>Feasibility</SectionTitle>
          <KeyValue rows={[["Technical feasibility", d.feasibility.rating], ["AI could deliver", d.aiDelivery.rating]]} />
          <p className="mt-2 text-xs text-stone-500">{d.feasibility.explanation}</p>
        </div>
      </div>
      {d.risks.length ? (
        <>
          <SectionTitle>Risks</SectionTitle>
          <BulletList items={d.risks.map((r) => `${r.type}: ${r.description}`)} />
        </>
      ) : null}
      {d.humanReview.length ? (
        <>
          <SectionTitle>Human review needed</SectionTitle>
          <BulletList items={d.humanReview} />
        </>
      ) : null}
    </Card>
  );
}

function ClaimRow({ c, level }: { c: DossierClaim; level?: EvidenceLevel }) {
  return (
    <li className="py-2.5" data-claim-evidence={c.evidence} data-claim-level={level}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-stone-800">{c.statement}</p>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <EvidenceBadge status={c.evidence} />
          {level ? <LevelBadge level={level} /> : null}
        </span>
      </div>
      {c.quote ? <blockquote className="mt-1 border-l-2 border-stone-200 pl-3 text-xs text-stone-600 italic">“{c.quote}”</blockquote> : null}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {c.sourceUrl ? <SourceLink url={c.sourceUrl} /> : null}
        {c.foundOn ? <span className="text-xs text-amber-700">Found on {shortUrl(c.foundOn)}</span> : null}
      </div>
      {c.reviewNote ? <p className="mt-1 text-xs text-sky-800">Review: {c.reviewNote}</p> : null}
    </li>
  );
}

function Evidence({ d, wf }: { d: OpportunityDetail; wf: OpportunityWorkflow }) {
  const levelOf = (key: string) => wf.evidence.find((e) => e.key === key)?.level;
  return (
    <Card
      title="Evidence"
      description="Every statement carries its support (a quote checked against the page it cites, an inference, or an unsupported hypothesis) and its level. Research reaches level 3 at most; only the customer can confirm a problem."
    >
      {d.claimSections
        .filter((s) => s.claims.length)
        .map((s) => (
          <div key={s.key}>
            <SectionTitle>{s.title}</SectionTitle>
            <ul className="divide-y divide-stone-100">
              {s.claims.map((c, i) => (
                <ClaimRow key={i} c={c} level={levelOf(`${s.key}.${i}`)} />
              ))}
            </ul>
          </div>
        ))}
      {d.software.length ? (
        <>
          <SectionTitle>Software in use</SectionTitle>
          <ul className="divide-y divide-stone-100">
            {d.software.map((s, i) => (
              <li key={i} className="py-2">
                <div className="text-sm font-medium text-stone-900">
                  {s.product} <span className="font-normal text-stone-500">· {s.purpose}</span>
                </div>
                <ul>
                  <ClaimRow c={s.evidence} level={levelOf(`software.${i}`)} />
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {d.limitations.length ? (
        <>
          <SectionTitle>Limitations of the evidence</SectionTitle>
          <BulletList items={d.limitations} />
        </>
      ) : null}
    </Card>
  );
}

const VERDICT_TONE: Record<string, Tone> = { found: "emerald", "found on another page": "amber", "not found": "rose", "source not read": "rose" };

function Contacts({ d }: { d: OpportunityDetail }) {
  return (
    <Card title="Contacts" description="Business channels shown on the company's own pages. None has been contacted.">
      {d.contacts.roles.length ? <p className="text-sm text-stone-700">Decision-maker roles: {d.contacts.roles.join(", ")}</p> : null}
      {d.contacts.people.length ? (
        <>
          <SectionTitle>People the site presents</SectionTitle>
          <ul className="space-y-2">
            {d.contacts.people.map((p, i) => (
              <li key={i} className="text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span>
                    <span className="font-medium text-stone-900">{p.name}</span> <span className="text-stone-500">· {p.role}</span>
                  </span>
                  <EvidenceBadge status={p.evidence} />
                </div>
                <SourceLink url={p.sourceUrl} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <SectionTitle>Channels</SectionTitle>
      {d.contacts.channels.length ? (
        <ul className="space-y-2">
          {d.contacts.channels.map((c, i) => (
            <li key={i} className="text-sm">
              <div className="flex items-start justify-between gap-3">
                <span>
                  <span className="text-stone-500">{c.kind}:</span> <span className="font-medium break-all text-stone-900">{c.value}</span>
                </span>
                <Badge tone={VERDICT_TONE[c.verdict] ?? "neutral"}>{c.verdict === "found" ? "on the page" : c.verdict}</Badge>
              </div>
              {c.reviewNote ? <p className="text-xs text-sky-800">Review: {c.reviewNote}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No channel recorded.</Empty>
      )}
      {d.discovery.questions.length ? (
        <>
          <SectionTitle>Discovery questions</SectionTitle>
          <BulletList items={d.discovery.questions} />
        </>
      ) : null}
      {d.discovery.outreachBody.trim() ? (
        <details className="mt-4 rounded-lg border border-stone-200 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-stone-800">Draft outreach email (never sent)</summary>
          <p className="mt-2 text-xs font-medium text-rose-700">Draft only. Contacting this company needs your separate approval.</p>
          <p className="mt-2 text-sm font-medium text-stone-900">{d.discovery.outreachSubject}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-stone-700">{d.discovery.outreachBody}</p>
        </details>
      ) : null}
    </Card>
  );
}

function Checks({ d }: { d: OpportunityDetail }) {
  const c = d.checks;
  return (
    <Card title="Run-time checks and sources" description="Recorded when the page text was in memory. Pages are kept as fingerprints, never copies.">
      {c ? (
        <KeyValue
          rows={[
            ["Facts with quotes", c.facts],
            ["Quotes found on the cited page", c.quotesFound],
            ["…of which in page details", c.quotesFoundInDetails],
            ["Quotes on another page", c.quotesOnAnotherPage],
            ["Quotes not found", c.quotesNotFound],
            ["Inferences / hypotheses", `${c.inferences} / ${c.hypotheses}`],
            ["Rule flags", c.flags],
          ]}
        />
      ) : (
        <Empty>No checks recorded.</Empty>
      )}
      {d.ruleFlags.length ? (
        <>
          <SectionTitle>Rule flags</SectionTitle>
          <ul className="space-y-1.5 text-sm">
            {d.ruleFlags.map((f, i) => (
              <li key={i}>
                <Badge tone="rose">{f.rule}</Badge> <span className="text-stone-700">{f.detail}</span>
                {f.reviewNote ? <p className="text-xs text-sky-800">Review: {f.reviewNote}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <SectionTitle>Pages read ({d.sources.length})</SectionTitle>
      {d.sources.length ? (
        <table className="w-full text-left text-xs">
          <thead className="text-stone-500">
            <tr>
              <th className="py-1 font-medium">Page</th>
              <th className="py-1 font-medium">Outcome</th>
              <th className="py-1 font-medium">Retrieved</th>
              <th className="py-1 font-medium">Fingerprint</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {d.sources.map((s, i) => (
              <tr key={i}>
                <td className="max-w-xs py-1 pr-2">
                  <SourceLink url={s.finalUrl} />
                </td>
                <td className="py-1 pr-2 text-stone-700">{s.outcome}</td>
                <td className="py-1 pr-2 text-stone-700">{dateTime(s.retrievedAt)}</td>
                <td className="py-1 font-mono text-stone-500">{s.sha256 ? s.sha256.slice(0, 12) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No page was read.</Empty>
      )}
    </Card>
  );
}
