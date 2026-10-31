import { ExternalLink, Plus, X } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Card, Field, KeyValue, type Tone } from "@/components/ui";
import type { CallInputDto, EvidenceLevel, OpportunityDetail, OpportunityWorkflow, ProblemRecord, ReadinessStage } from "@/lib/desktop/types";
import { DECISION_MAKER_ANSWERS, SOLUTION_RUNG_LABELS, SOLUTION_RUNGS, type DecisionMakerAnswer, type ProblemStatus, type SolutionRung } from "@/lib/domain/types";
import { date } from "@/lib/format";
import type { Result } from "../../shared/bridge";
import { Empty, SectionTitle } from "../components";
import { kelqor, usd } from "../lib";

// The discovery-first workflow for one researched company (Milestone 2A): readiness, industry, evidence levels, the
// owner's own checks, discovery conversations, customer-confirmed problems and their simplest solutions, and the
// hand-off to a Work Order draft. Everything here is internal: nothing is sent to the company.

type Props = { d: OpportunityDetail; wf: OpportunityWorkflow; online: boolean; onChange: (wf: OpportunityWorkflow) => void };

const READINESS_TONE: Record<ReadinessStage, Tone> = {
  not_pursuing: "rose",
  on_hold: "amber",
  not_qualified: "neutral",
  ready_for_discovery: "sky",
  no_confirmed_problem: "amber",
  choose_solution: "violet",
  confirm_decision_maker: "violet",
  ready_to_propose: "emerald",
  work_order_drafted: "emerald",
};

export const LEVEL: Record<EvidenceLevel, { label: string; tone: Tone }> = {
  1: { label: "Level 1 · verified company information", tone: "emerald" },
  2: { label: "Level 2 · observed defect", tone: "amber" },
  3: { label: "Level 3 · hypothesis or unverified", tone: "neutral" },
};

export function LevelBadge({ level }: { level: EvidenceLevel }) {
  return (
    <span data-level={level}>
      <Badge tone={LEVEL[level].tone}>{LEVEL[level].label}</Badge>
    </span>
  );
}

const DECISION_MAKER_LABELS: Record<DecisionMakerAnswer, string> = { yes: "Can decide", no: "Can't decide", unknown: "Not sure" };
const localToday = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/** Runs one change, reporting the outcome plainly; nothing is retried behind the owner's back. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  async function save<T>(action: () => Promise<Result<T>>, done: (data: T) => void, success: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const res = await action();
    setBusy(false);
    if (res.ok) {
      done(res.data);
      setMessage({ tone: "emerald", text: success });
      return true;
    }
    setMessage({ tone: "rose", text: res.offline ? "Not saved: the local backend is unavailable. Your entries are kept; save again once it reconnects." : `Not saved: ${res.error}` });
    return false;
  }
  return { busy, message, save };
}

function Message({ m }: { m: { tone: Tone; text: string } | null }) {
  return m ? (
    <div className="mt-3" data-testid="workflow-message">
      <Alert tone={m.tone}>{m.text}</Alert>
    </div>
  ) : null;
}

export function WorkflowSummary({ d, wf, online, onChange }: Props) {
  const { busy, message, save } = useSave();
  const industry = wf.industry.value ?? "";
  const c = wf.counts;
  return (
    <Card title="Discovery-first workflow" description="Research prepares the conversation; only the customer confirms a problem. Internal only: nothing here contacts the company.">
      <div className="flex flex-wrap items-center gap-3" data-testid="readiness" data-stage={wf.readiness.stage}>
        <Badge tone={READINESS_TONE[wf.readiness.stage]}>{wf.readiness.label}</Badge>
        <span className="text-sm text-stone-700">{wf.readiness.next}</span>
      </div>
      {wf.workOrder ? (
        <p className="mt-2 text-sm text-stone-700" data-testid="linked-work-order">
          Work Order {wf.workOrder.ref} ({wf.workOrder.status}) was drafted from this discovery.{" "}
          <button type="button" className="text-ember-700 hover:underline" disabled={!online} onClick={() => void kelqor().openWebApp(wf.workOrder!.webPath)}>
            Open it in the web app
          </button>
        </p>
      ) : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field
          label="Industry"
          htmlFor="industry"
          hint={wf.industry.suggested ? `Research suggests: ${wf.industry.suggested}. The discovery questions follow this choice.` : "Research didn't say. Choose one so the right questions appear."}
        >
          <select
            id="industry"
            data-setting="industry"
            className="fx-input"
            value={industry}
            disabled={!online || busy}
            onChange={(e) => void save(() => kelqor().setIndustry(d.id, e.target.value || null), onChange, "Industry saved.")}
          >
            <option value="">{wf.industry.suggested ? `Research's suggestion (${wf.industry.suggested})` : "Not chosen"}</option>
            {wf.industry.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <div data-testid="evidence-levels">
          <div className="fx-label">Evidence so far</div>
          <KeyValue
            rows={[
              ["Level 1 · verified company information", c.verified],
              ["Level 2 · observed defects", c.defects],
              ["Level 3 · hypotheses or unverified", c.hypotheses],
              ["Your own checks", c.founderChecks],
              ["Confirmed by the customer", c.customerConfirmed],
              ["Not a problem for them", c.dismissed],
            ]}
          />
        </div>
      </div>
      <Message m={message} />
    </Card>
  );
}

export function FounderChecks({ d, wf, online, onChange }: Props) {
  const { busy, message, save } = useSave();
  const [statement, setStatement] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [checkedOn, setCheckedOn] = useState(localToday());
  const [note, setNote] = useState("");
  async function add() {
    const ok = await save(() => kelqor().addCheck(d.id, { statement, sourceUrl, checkedOn, note }), onChange, "Check saved.");
    if (ok) {
      setStatement("");
      setSourceUrl("");
      setNote("");
    }
  }
  return (
    <Card title="Your own checks" description="Facts you verified outside the saved research, such as a registry, a directory or a job posting. Each keeps its source and date.">
      {wf.checks.length ? (
        <ul className="divide-y divide-stone-100" data-testid="checks">
          {wf.checks.map((c) => (
            <li key={c.id} className="py-2 text-sm" data-check={c.id}>
              <p className="text-stone-800">{c.statement}</p>
              <p className="mt-0.5 text-xs text-stone-500">
                Checked {date(c.checkedOn)} by {c.createdBy}
                {c.note ? ` · ${c.note}` : ""}
              </p>
              {c.sourceUrl ? (
                <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-xs text-ember-700 hover:underline" onClick={() => void kelqor().openSource(c.sourceUrl!)}>
                  <ExternalLink size={11} /> {c.sourceUrl}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>None yet.</Empty>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="What you found" htmlFor="check-statement">
          <input id="check-statement" className="fx-input" maxLength={1000} placeholder="e.g. LinkedIn lists 11–50 employees" value={statement} onChange={(e) => setStatement(e.target.value)} />
        </Field>
        <Field label="Where (a link)" htmlFor="check-url">
          <input id="check-url" className="fx-input" maxLength={2000} placeholder="https://…" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </Field>
        <Field label="Checked on" htmlFor="check-date">
          <input id="check-date" type="date" className="fx-input" value={checkedOn} onChange={(e) => setCheckedOn(e.target.value)} />
        </Field>
        <Field label="Note (or the source, if there's no link)" htmlFor="check-note">
          <input id="check-note" className="fx-input" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <button type="button" data-action="add-check" className="fx-btn fx-btn-secondary mt-3 px-3 py-1.5 text-xs" disabled={!online || busy || !statement.trim()} onClick={() => void add()}>
        <Plus size={13} /> Add check
      </button>
      <Message m={message} />
    </Card>
  );
}

type FindingChoice = "" | ProblemStatus;

export function DiscoveryCalls({ d, wf, online, onChange }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Discovery conversations" description="What the customer told you, in their words. This is the only place a problem becomes customer-confirmed.">
      {wf.calls.length ? (
        <ul className="space-y-3" data-testid="calls">
          {wf.calls.map((c) => (
            <li key={c.id} className="rounded-lg border border-stone-200 px-4 py-3" data-call={c.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-stone-900">
                  {date(c.heldOn)} · {[c.contactName, c.contactRole].filter(Boolean).join(", ") || "Contact not recorded"}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={c.decisionMaker === "yes" ? "emerald" : "neutral"}>{DECISION_MAKER_LABELS[c.decisionMaker]}</Badge>
                  {c.pain !== null ? <Badge tone={c.pain >= 2 ? "amber" : "neutral"}>Pain {c.pain}/3</Badge> : null}
                </span>
              </div>
              {c.answers.length ? (
                <dl className="mt-2 space-y-1.5 text-sm">
                  {c.answers.map((a) => (
                    <div key={a.questionId}>
                      <dt className="text-xs text-stone-500">{a.question}</dt>
                      <dd className="text-stone-800">{a.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <div className="mt-2">
                <KeyValue
                  rows={(
                    [
                      ["Software they use", c.software],
                      ["Their priorities", c.priorities],
                      ["Outcome they want", c.desiredOutcome],
                      ["What it's worth to them", c.valueToThem],
                      ["What they've tried", c.tried],
                      ["Agreed next step", c.nextStep],
                      ["Notes", c.notes],
                    ] as [string, string][]
                  ).filter(([, v]) => v)}
                />
              </div>
              <p className="mt-1 text-xs text-stone-500">Recorded by {c.recordedBy}</p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No conversation recorded yet.</Empty>
      )}
      {open ? (
        <CallForm d={d} wf={wf} online={online} onChange={onChange} close={() => setOpen(false)} />
      ) : (
        <button type="button" data-action="new-call" className="fx-btn fx-btn-primary mt-3 px-3 py-1.5 text-xs" disabled={!online} onClick={() => setOpen(true)}>
          <Plus size={13} /> Record a discovery conversation
        </button>
      )}
    </Card>
  );
}

function CallForm({ d, wf, online, onChange, close }: Props & { close: () => void }) {
  const { busy, message, save } = useSave();
  const [f, setF] = useState({
    heldOn: localToday(),
    contactName: "",
    contactRole: "",
    decisionMaker: "unknown" as DecisionMakerAnswer,
    pain: "" as "" | "0" | "1" | "2" | "3",
    software: "",
    priorities: "",
    desiredOutcome: "",
    valueToThem: "",
    tried: "",
    nextStep: "",
    notes: "",
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [raised, setRaised] = useState<string[]>([""]);
  const [findings, setFindings] = useState<Record<string, FindingChoice>>({});
  const predicted = wf.evidence.filter((e) => e.predictedPain);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function submit() {
    const call: CallInputDto = {
      ...f,
      pain: f.pain === "" ? null : Number(f.pain),
      answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())),
      problems: raised.map((p) => p.trim()).filter(Boolean),
      findings: Object.entries(findings)
        .filter(([, v]) => v)
        .map(([key, status]) => ({ key, status: status as ProblemStatus })),
    };
    if (await save(() => kelqor().recordCall(d.id, call), onChange, "Conversation saved.")) close();
  }

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-ember-200 bg-ember-50/40 p-4" data-testid="call-form">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Date" htmlFor="call-date">
          <input id="call-date" type="date" className="fx-input" value={f.heldOn} onChange={set("heldOn")} />
        </Field>
        <Field label="Who" htmlFor="call-name">
          <input id="call-name" className="fx-input" maxLength={200} value={f.contactName} onChange={set("contactName")} />
        </Field>
        <Field label="Their role" htmlFor="call-role">
          <input id="call-role" className="fx-input" maxLength={200} placeholder="e.g. Owner" value={f.contactRole} onChange={set("contactRole")} />
        </Field>
        <Field label="Can they decide?" htmlFor="call-dm">
          <select id="call-dm" className="fx-input" value={f.decisionMaker} onChange={set("decisionMaker")}>
            {DECISION_MAKER_ANSWERS.map((a) => (
              <option key={a} value={a}>
                {DECISION_MAKER_LABELS[a]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div>
        <SectionTitle>Questions</SectionTitle>
        <div className="space-y-2.5">
          {wf.questions.map((q) => (
            <Field key={q.id} label={q.text} htmlFor={`q-${q.id}`} hint={q.playbook === "Any industry" ? undefined : q.playbook}>
              <textarea
                id={`q-${q.id}`}
                data-question={q.id}
                rows={2}
                maxLength={2000}
                className="fx-input"
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </div>

      {predicted.length ? (
        <div>
          <SectionTitle>What research predicted</SectionTitle>
          <p className="mb-2 text-xs text-stone-500">Mark only what came up in this conversation. A finding stays a prediction until the customer confirms it.</p>
          <ul className="space-y-2">
            {predicted.map((e) => (
              <li key={e.key} className="flex flex-col gap-1.5 md:flex-row md:items-start md:justify-between">
                <span className="text-sm text-stone-800">
                  {e.statement} <LevelBadge level={e.level} />
                </span>
                <select
                  className="fx-input md:w-56 md:shrink-0"
                  data-finding={e.key}
                  value={findings[e.key] ?? ""}
                  onChange={(ev) => setFindings((x) => ({ ...x, [e.key]: ev.target.value as FindingChoice }))}
                >
                  <option value="">Not discussed</option>
                  <option value="confirmed">Confirmed by the customer</option>
                  <option value="not_a_problem">Not a problem for them</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <SectionTitle>Problems they raised, in their words</SectionTitle>
        <div className="space-y-2">
          {raised.map((p, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="fx-input"
                data-raised={i}
                maxLength={1000}
                value={p}
                placeholder="e.g. We lose track of quote follow-ups after the first call"
                onChange={(e) => setRaised((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {raised.length > 1 ? (
                <button type="button" className="fx-btn fx-btn-ghost px-2" aria-label="Remove" onClick={() => setRaised((xs) => xs.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ))}
          {raised.length < 10 ? (
            <button type="button" className="fx-btn fx-btn-ghost px-2 py-1 text-xs" onClick={() => setRaised((xs) => [...xs, ""])}>
              <Plus size={13} /> Another problem
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Software they already use" htmlFor="call-software">
          <textarea id="call-software" rows={2} maxLength={2000} className="fx-input" value={f.software} onChange={set("software")} />
        </Field>
        <Field label="Their priorities" htmlFor="call-priorities">
          <textarea id="call-priorities" rows={2} maxLength={2000} className="fx-input" value={f.priorities} onChange={set("priorities")} />
        </Field>
        <Field label="The outcome they want" htmlFor="call-outcome">
          <textarea id="call-outcome" rows={2} maxLength={2000} className="fx-input" value={f.desiredOutcome} onChange={set("desiredOutcome")} />
        </Field>
        <Field label="What it would be worth to them" htmlFor="call-value">
          <textarea id="call-value" rows={2} maxLength={2000} className="fx-input" value={f.valueToThem} onChange={set("valueToThem")} />
        </Field>
        <Field label="What they've tried" htmlFor="call-tried">
          <textarea id="call-tried" rows={2} maxLength={2000} className="fx-input" value={f.tried} onChange={set("tried")} />
        </Field>
        <Field label="Agreed next step" htmlFor="call-next">
          <textarea id="call-next" rows={2} maxLength={1000} className="fx-input" value={f.nextStep} onChange={set("nextStep")} />
        </Field>
        <Field label="Pain, as you judge it" htmlFor="call-pain">
          <select id="call-pain" className="fx-input" value={f.pain} onChange={set("pain")}>
            <option value="">Not judged</option>
            <option value="0">0 · none</option>
            <option value="1">1 · mild</option>
            <option value="2">2 · real</option>
            <option value="3">3 · urgent</option>
          </select>
        </Field>
        <Field label="Notes" htmlFor="call-notes">
          <textarea id="call-notes" rows={2} maxLength={4000} className="fx-input" value={f.notes} onChange={set("notes")} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-action="save-call" className="fx-btn fx-btn-primary" disabled={!online || busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save conversation"}
        </button>
        <button type="button" className="fx-btn fx-btn-ghost" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
      <Message m={message} />
    </div>
  );
}

export function Problems({ d, wf, online, onChange }: Props) {
  const tools = wf.evidence.filter((e) => e.key.startsWith("software.")).map((e) => e.statement.split(":")[0]);
  const confirmed = wf.problems.filter((p) => p.status === "confirmed");
  const dismissed = wf.problems.filter((p) => p.status === "not_a_problem");
  return (
    <Card title="Customer-confirmed problems" description="Each comes from a recorded conversation. Choose the simplest solution that works before proposing anything.">
      {confirmed.length ? (
        <ul className="space-y-3" data-testid="problems">
          {confirmed.map((p) => (
            <ProblemRow key={p.id} d={d} p={p} online={online} onChange={onChange} />
          ))}
        </ul>
      ) : (
        <Empty>None yet. Problems appear here once a customer confirms them in a recorded conversation.</Empty>
      )}
      {tools.length ? <p className="mt-3 text-xs text-stone-500">Tools research found on their site, worth checking first: {[...new Set(tools)].join(", ")}.</p> : null}
      {dismissed.length ? (
        <>
          <SectionTitle>Not a problem for them</SectionTitle>
          <ul className="space-y-1 text-sm text-stone-600" data-testid="dismissed">
            {dismissed.map((p) => (
              <li key={p.id}>
                {p.statement} <span className="text-xs text-stone-500">({date(p.heldOn)})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

function ProblemRow({ d, p, online, onChange }: { d: OpportunityDetail; p: ProblemRecord; online: boolean; onChange: (wf: OpportunityWorkflow) => void }) {
  const { busy, message, save } = useSave();
  const [rung, setRung] = useState<SolutionRung | "">(p.solutionRung ?? "");
  const [solution, setSolution] = useState(p.solution);
  const dirty = rung !== (p.solutionRung ?? "") || solution.trim() !== p.solution;
  return (
    <li className="rounded-lg border border-stone-200 px-4 py-3" data-problem={p.id} data-origin={p.origin}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-stone-900">{p.statement}</p>
        <Badge tone="emerald">{p.origin === "customer" ? "They raised it" : "Research finding they confirmed"}</Badge>
      </div>
      <p className="mt-0.5 text-xs text-stone-500">Confirmed in the conversation on {date(p.heldOn)}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,240px)_1fr]">
        <Field label="Simplest solution that works" htmlFor={`rung-${p.id}`}>
          <select id={`rung-${p.id}`} data-solution-rung={p.id} className="fx-input" value={rung} disabled={!online || busy} onChange={(e) => setRung(e.target.value as SolutionRung | "")}>
            <option value="">Not chosen</option>
            {SOLUTION_RUNGS.map((r) => (
              <option key={r} value={r}>
                {SOLUTION_RUNG_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What it would be" htmlFor={`solution-${p.id}`}>
          <input id={`solution-${p.id}`} data-solution-text={p.id} className="fx-input" maxLength={2000} value={solution} disabled={!online || busy} onChange={(e) => setSolution(e.target.value)} />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="save-solution"
          className="fx-btn fx-btn-secondary px-3 py-1.5 text-xs"
          disabled={!online || busy || !rung || !solution.trim() || !dirty}
          onClick={() => void save(() => kelqor().setSolution(d.id, p.id, rung as SolutionRung, solution.trim()), onChange, "Solution saved.")}
        >
          Save solution
        </button>
        {p.workOrderPath ? (
          <button type="button" data-action="draft-work-order" data-path={p.workOrderPath} className="fx-btn fx-btn-primary px-3 py-1.5 text-xs" disabled={!online} onClick={() => void kelqor().openWebApp(p.workOrderPath!)}>
            <ExternalLink size={13} /> Draft a Work Order from this problem
          </button>
        ) : null}
      </div>
      {p.workOrderPath ? <p className="mt-1 text-xs text-stone-500">Opens the New Work Order page in your browser, filled in from this problem. You review it; nothing is sent, quoted or charged.</p> : null}
      <Message m={message} />
    </li>
  );
}

/**
 * Financial figures the customer gave in a recorded conversation. Each stays an estimate until you write out the
 * calculation and name the evidence that validate it; no research or AI step can add or validate one.
 */
export function CustomerFigures({ d, wf, online, onChange }: Props) {
  const { busy, message, save } = useSave();
  const [callId, setCallId] = useState(wf.calls.at(-1)?.id ?? "");
  const [statement, setStatement] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState("per month");
  const [basis, setBasis] = useState("");
  const [validating, setValidating] = useState<string | null>(null);
  const [validated, setValidated] = useState("");
  const [calculation, setCalculation] = useState("");
  const [evidence, setEvidence] = useState("");
  const cents = (dollars: string) => Math.round(Number(dollars.replace(/[$,]/g, "")) * 100);
  async function add() {
    const ok = await save(() => kelqor().addFigure(d.id, { callId, statement, amountCents: cents(amount), period, basis }), onChange, "Figure saved as the customer's estimate.");
    if (ok) {
      setStatement("");
      setAmount("");
      setBasis("");
    }
  }
  async function validate(figureId: string) {
    const ok = await save(() => kelqor().validateFigure(d.id, figureId, { validatedCents: cents(validated), calculation, evidence }), onChange, "Figure validated.");
    if (ok) {
      setValidating(null);
      setValidated("");
      setCalculation("");
      setEvidence("");
    }
  }
  return (
    <Card title="Customer-reported figures" description="The customer's own numbers. Each stays an estimate until you record the calculation and the evidence that validate it.">
      {wf.figures.length ? (
        <ul className="divide-y divide-stone-100" data-testid="figures">
          {wf.figures.map((f) => (
            <li key={f.id} className="py-2 text-sm" data-figure={f.id} data-figure-status={f.status}>
              <p className="text-stone-800">
                {f.statement}: {usd(f.amountCents / 100, 0)} {f.period}{" "}
                <Badge tone={f.status === "validated" ? "emerald" : "amber"}>{f.status === "validated" ? "Validated impact" : "Customer-reported estimate"}</Badge>
              </p>
              <p className="mt-0.5 text-xs text-stone-500">
                From the conversation on {date(f.heldOn)}
                {f.basis ? ` · their basis: ${f.basis}` : ""}
              </p>
              {f.status === "validated" ? (
                <p className="mt-0.5 text-xs text-stone-600">
                  Validated at {usd((f.validatedCents ?? 0) / 100, 0)}: {f.calculation} · Evidence: {f.evidence}
                </p>
              ) : validating === f.id ? (
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <input className="fx-input" placeholder="Validated amount ($)" inputMode="decimal" value={validated} onChange={(e) => setValidated(e.target.value)} />
                  <input className="fx-input" placeholder="Your calculation" value={calculation} onChange={(e) => setCalculation(e.target.value)} />
                  <input className="fx-input" placeholder="Evidence (e.g. their exported data)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
                  <button type="button" data-action="validate-figure" className="fx-btn fx-btn-secondary px-3 py-1.5 text-xs" disabled={!online || busy} onClick={() => void validate(f.id)}>
                    Save validation
                  </button>
                </div>
              ) : (
                <button type="button" className="mt-1 text-xs text-ember-700 hover:underline" disabled={!online} onClick={() => setValidating(f.id)}>
                  Validate with your calculation and evidence
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>None yet.</Empty>
      )}
      {wf.calls.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="From the conversation" htmlFor="figure-call">
            <select id="figure-call" className="fx-input" value={callId} onChange={(e) => setCallId(e.target.value)}>
              {wf.calls.map((c) => (
                <option key={c.id} value={c.id}>
                  {date(c.heldOn)} · {c.contactName || "contact not named"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What it is, in their words" htmlFor="figure-statement">
            <input id="figure-statement" className="fx-input" maxLength={500} placeholder="e.g. Jobs lost to slow callbacks" value={statement} onChange={(e) => setStatement(e.target.value)} />
          </Field>
          <Field label="Amount ($)" htmlFor="figure-amount">
            <input id="figure-amount" className="fx-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Period" htmlFor="figure-period">
            <input id="figure-period" className="fx-input" maxLength={60} value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <Field label="Their basis" htmlFor="figure-basis">
            <input id="figure-basis" className="fx-input" maxLength={1000} placeholder="How they arrived at it" value={basis} onChange={(e) => setBasis(e.target.value)} />
          </Field>
        </div>
      ) : (
        <p className="mt-2 text-xs text-stone-500">Record a discovery conversation first: a figure always comes from one.</p>
      )}
      {wf.calls.length ? (
        <button type="button" data-action="add-figure" className="fx-btn fx-btn-secondary mt-3 px-3 py-1.5 text-xs" disabled={!online || busy || !statement.trim() || !amount.trim() || !callId} onClick={() => void add()}>
          <Plus size={13} /> Add figure
        </button>
      ) : null}
      <Message m={message} />
    </Card>
  );
}
