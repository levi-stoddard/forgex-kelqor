import { useEffect, useState } from "react";
import { Alert, Badge, Card, Field, KeyValue, PageHeader, type Tone } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { AgentStatus, ChangeState, EngAction, EngMissionDetail, EngMissionInput, EngMissionSummary, EngStatus } from "@/lib/engineering/contract";
import type { ViewProps } from "../App";
import { Empty, Failure, Loading, SectionTitle } from "../components";
import { kelqor, usd, useResult } from "../lib";

// Engineering Missions (Milestone 3): the owner gives an AI agent a task in an isolated copy of a registered
// workspace, watches it, reviews the change and decides what is applied. The window only asks; the backend checks
// every action. Simulated work is always labeled.

const requestId = () => crypto.randomUUID();
const TABS = [
  ["missions", "Missions"],
  ["new", "New mission"],
  ["review", "Awaiting your review"],
  ["agents", "Agents"],
  ["workspaces", "Workspaces"],
] as const;
type Tab = (typeof TABS)[number][0];

const STATUS: Record<EngStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber" },
  approved: { label: "Approved", tone: "sky" },
  running: { label: "Running", tone: "blue" },
  review: { label: "Review", tone: "violet" },
  completed: { label: "Completed", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  interrupted: { label: "Interrupted", tone: "amber" },
};
const CHANGE: Record<ChangeState, { label: string; tone: Tone }> = {
  none: { label: "No change", tone: "neutral" },
  proposed: { label: "Proposed (not tested)", tone: "amber" },
  tested: { label: "Locally tested", tone: "sky" },
  founder_approved: { label: "Owner-approved", tone: "violet" },
  applied: { label: "Applied to a local branch", tone: "emerald" },
};
const AGENT_STATE: Record<AgentStatus["state"], { label: string; tone: Tone }> = {
  connected: { label: "Available", tone: "emerald" },
  disconnected: { label: "Not connected", tone: "rose" },
  blocked: { label: "Installed, not authorized", tone: "amber" },
};
const ACTION_LABEL: Record<EngAction, string> = {
  submit: "Submit for approval",
  approve: "Approve",
  reject: "Reject",
  start: "Start",
  cancel: "Cancel",
  resume: "Resume",
  import: "Import results",
  run_checks: "Run checks",
  approve_change: "Approve change",
  apply: "Apply to a new local branch",
  complete: "Complete without applying",
  fail: "Close as failed",
  open_agent: "Open in the agent's app",
  add_response: "Save response",
};
const OPEN_LABEL: Partial<Record<EngMissionSummary["agent"], string>> = { antigravity: "Open in Antigravity", claude_code_manual: "Open the folder" };

/** Starting points for common tasks; the owner edits them before saving. */
const TEMPLATES: { name: string; title: string; task: string; deliverables: string; editFiles: boolean }[] = [
  { name: "Fix a failing test", title: "Fix the failing test", task: "A test is failing. Find the cause, fix the code (not the test, unless the test is wrong), and explain the cause.", deliverables: "The fix, and a short explanation of the cause.", editFiles: true },
  { name: "Add tests", title: "Add tests for a module", task: "Add focused tests for the module named below, covering its normal cases, edge cases and errors. Don't change the module itself.\n\nModule: ", deliverables: "New test files only.", editFiles: true },
  { name: "Small feature", title: "Add a small feature", task: "Add the feature described below, following the code's existing style, with tests.\n\nFeature: ", deliverables: "The change and its tests.", editFiles: true },
  { name: "Investigate (read-only)", title: "Investigate and report", task: "Investigate the question below without changing any files, and report what you find with file and line references.\n\nQuestion: ", deliverables: "A written report in the summary.", editFiles: false },
];

const StatusBadge = ({ s }: { s: EngStatus }) => <Badge tone={STATUS[s].tone}>{STATUS[s].label}</Badge>;
const ChangeBadge = ({ c }: { c: ChangeState }) => <Badge tone={CHANGE[c].tone}>{CHANGE[c].label}</Badge>;
const SimBadge = ({ on }: { on: boolean }) => (on ? <Badge tone="violet">Simulated</Badge> : null);
const cost = (m: EngMissionSummary) =>
  m.costSource === "simulated" ? "$0.00 (simulated)" : m.costMicros === null ? "Unknown" : `${usd(m.costMicros / 1e6, 4)} (reported by the agent; not verified)`;

export function EngineeringView({ epoch }: ViewProps) {
  const [tab, setTab] = useState<Tab>("missions");
  const [missionId, setMissionId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const overview = useResult(() => kelqor().engOverview(), [epoch, tick]);
  const o = overview.data;
  // Active missions are read again every few seconds; reading never starts or resends anything.
  const active = o?.missions.some((m) => m.status === "running" || m.activity) ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [active]);
  const refresh = () => setTick((n) => n + 1);
  const open = (id: string) => {
    setMissionId(id);
    setTab("missions");
  };
  const waiting = o?.missions.filter((m) => m.status === "awaiting_approval" || m.status === "review" || (m.status === "running" && m.agentMode === "manual")).length ?? 0;
  const attention = o?.missions.filter((m) => m.status === "failed" || m.status === "interrupted") ?? [];

  return (
    <div data-view="engineering">
      <PageHeader
        eyebrow="Engineering"
        title="Engineering Missions"
        description="Give an AI agent a task in an isolated copy of a workspace, follow it, and decide what is applied. Agents never work in the workspace itself, and nothing is pushed."
      />
      {overview.result && !overview.result.ok && !o ? <Failure result={overview.result} onRetry={overview.reload} /> : null}
      {o ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="eng-status">
          {o.agents.map((a) => (
            <div key={a.id} className="fx-card px-4 py-3 text-sm" data-agent={a.id} data-agent-state={a.state}>
              <div className="text-xs text-stone-500">{a.label}</div>
              <div className="mt-1 flex items-center gap-2">
                <Badge tone={AGENT_STATE[a.state].tone}>{AGENT_STATE[a.state].label}</Badge>
                {a.version ? <span className="text-xs text-stone-500">{a.version}</span> : null}
              </div>
            </div>
          ))}
          <div className="fx-card px-4 py-3 text-sm">
            <div className="text-xs text-stone-500">Live agent execution</div>
            <div className="mt-1 text-sm font-medium" data-testid="eng-live">{o.liveAgentExecution ? "Authorized" : "Off: not authorized yet"}</div>
          </div>
        </div>
      ) : null}
      {attention.length ? (
        <div className="mb-4">
          <Alert tone="amber" title="Needs your attention">
            {attention.map((m) => (
              <button key={m.id} type="button" className="mr-3 underline" onClick={() => open(m.id)}>
                {m.label} {STATUS[m.status].label.toLowerCase()}
              </button>
            ))}
          </Alert>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-stone-200" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            data-eng-tab={key}
            aria-selected={tab === key}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}
            onClick={() => {
              setTab(key);
              if (key !== "missions") setMissionId(null);
              refresh();
            }}
          >
            {label}
            {key === "review" && waiting ? <span className="ml-1 rounded-full bg-ember-500 px-1.5 text-xs text-white">{waiting}</span> : null}
          </button>
        ))}
      </div>
      {!o ? (
        overview.result?.ok === false ? null : <Loading />
      ) : tab === "missions" ? (
        missionId ? (
          <MissionDetailView id={missionId} epoch={epoch * 1000 + tick} back={() => setMissionId(null)} changed={refresh} />
        ) : (
          <MissionList missions={o.missions} open={open} />
        )
      ) : tab === "review" ? (
        <MissionList missions={o.missions.filter((m) => m.status === "awaiting_approval" || m.status === "review" || (m.status === "running" && m.agentMode === "manual"))} open={open} empty="Nothing is waiting for you." />
      ) : tab === "new" ? (
        <NewMission o={o} created={(id) => (refresh(), open(id))} />
      ) : tab === "agents" ? (
        <Agents agents={o.agents} live={o.liveAgentExecution} />
      ) : (
        <Workspaces o={o} changed={refresh} />
      )}
    </div>
  );
}

function MissionList({ missions, open, empty = "No engineering missions yet. Create one under New mission." }: { missions: EngMissionSummary[]; open: (id: string) => void; empty?: string }) {
  if (!missions.length) return <Empty>{empty}</Empty>;
  return (
    <Card>
      <table className="w-full text-sm" data-testid="eng-missions">
        <thead>
          <tr className="text-left text-xs text-stone-500">
            <th className="py-2">Mission</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Change</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {missions.map((m) => (
            <tr key={m.id} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" data-eng-mission={m.id} onClick={() => open(m.id)}>
              <td className="py-2">
                <div className="font-medium">
                  {m.label} · {m.title}
                </div>
                <div className="text-xs text-stone-500">{m.workspaceName}</div>
              </td>
              <td>
                {m.agentLabel} <SimBadge on={m.simulated} />
              </td>
              <td>
                <StatusBadge s={m.status} />
              </td>
              <td>
                <ChangeBadge c={m.changeState} />
              </td>
              <td className="max-w-xs truncate text-xs text-stone-600">{m.activity ?? m.stateReason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MissionDetailView({ id, epoch, back, changed }: { id: string; epoch: number; back: () => void; changed: () => void }) {
  const [tick, setTick] = useState(0);
  const res = useResult(() => kelqor().engMission(id), [id, epoch, tick]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const m = res.data;
  const live = Boolean(m && (m.status === "running" || m.activity));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [live]);
  if (res.result && !res.result.ok && !m) return <Failure result={res.result} onRetry={res.reload} />;
  if (!m) return <Loading />;

  const act = async (action: EngAction) => {
    setBusy(true);
    setError(null);
    // Approving a change sends the tree the window showed: the backend refuses it if the change is no longer that tree.
    const input = action === "approve" ? { fingerprint: m.scopeFingerprint } : action === "approve_change" ? { tree: m.deliverable?.tree } : action === "reject" || action === "fail" ? { reason } : {};
    if (action === "run_checks" && !window.confirm("Every check runs code from this change on this computer, with your rights and no sandbox (npx tsc included). Run them now?")) return;
    const r = await kelqor().engMissionAction(m.id, action, requestId(), input);
    setBusy(false);
    if (!r.ok) setError(r.error);
    setTick((n) => n + 1);
    changed();
  };
  // Saving a response has its own box below; it isn't one of the mission's buttons.
  const actions = (Object.keys(m.allowed) as EngAction[]).filter((a) => m.allowed[a] && a !== "add_response");
  const primary: EngAction[] = ["submit", "approve", "start", "import", "run_checks", "approve_change", "apply"];

  return (
    <div className="space-y-4" data-testid="eng-mission" data-status={m.status} data-change={m.changeState}>
      <button type="button" className="text-sm text-stone-600 hover:underline" onClick={back}>
        ← All missions
      </button>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {m.label} · {m.title} <StatusBadge s={m.status} /> <ChangeBadge c={m.changeState} /> <SimBadge on={m.simulated} />
          </span>
        }
        description={
          m.simulated
            ? "Simulated: KELQOR's built-in stand-in did this work. No AI agent ran, and it cost nothing."
            : m.agentMode === "manual"
              ? "Manual handoff: KELQOR can't enforce this mission's permissions inside the agent's app; only the import is controlled."
              : undefined
        }
      >
        {m.activity ? (
          <p className="mb-3 text-sm text-blue-800" data-testid="eng-activity">
            Now: {m.activity}
          </p>
        ) : null}
        {m.stateReason ? (
          <div className="mb-3">
            <Alert tone={m.status === "failed" ? "rose" : "amber"}>{m.stateReason}</Alert>
          </div>
        ) : null}
        <KeyValue
          rows={[
            ["Agent", `${m.agentLabel}${m.agentMode === "manual" ? " (manual handoff)" : m.agentMode === "simulated" ? " (simulated)" : " (automated)"}`],
            ["Workspace", m.workspace ? `${m.workspace.name} · ${m.workspace.path} · branch ${m.workspace.baseBranch}` : "(removed)"],
            ["May change files", m.permissions.editFiles ? "Yes, in its worktree only" : "No (read-only investigation)"],
            ["Approved checks", m.permissions.checks.length ? m.permissions.checks.join(", ") : "None"],
            ["Base commit", m.baseCommit ? <code key="b">{m.baseCommit.slice(0, 12)}</code> : "Fixed when it starts"],
            ["Worktree", m.worktreePath ?? "Made when it starts"],
            ["Approval", m.approval ? `${m.approval.approvedBy}, ${dateTime(m.approval.approvedAt)}` : "Not approved"],
            ["Cost", cost(m)],
            ...(m.appliedBranch ? ([["Applied", `${m.appliedBranch} at ${m.appliedCommit?.slice(0, 12)} (local only, not pushed)`]] as [string, string][]) : []),
          ]}
        />
        <SectionTitle>Task</SectionTitle>
        <p className="whitespace-pre-wrap text-sm text-stone-800">{m.task}</p>
        {m.deliverables ? (
          <>
            <SectionTitle>Deliverables</SectionTitle>
            <p className="whitespace-pre-wrap text-sm text-stone-800">{m.deliverables}</p>
          </>
        ) : null}
        {m.handoff ? (
          <div className="mt-3">
            <Alert tone="sky" title={`Your turn: ${m.agentLabel}`}>
              <p className="whitespace-pre-wrap">{m.handoff.instructions}</p>
              <p className="mt-1 text-xs">
                Task file: <code>{m.handoff.file}</code>
                <br />
                Folder: <code>{m.worktreePath}</code>
              </p>
            </Alert>
          </div>
        ) : null}
        {actions.length ? (
          <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="eng-actions">
            {actions.map((a) => (
              <button key={a} type="button" className={`fx-btn ${primary.includes(a) ? "fx-btn-primary" : "fx-btn-secondary"}`} data-action={`eng-${a}`} disabled={busy} onClick={() => void act(a)}>
                {a === "open_agent" ? (OPEN_LABEL[m.agent] ?? ACTION_LABEL[a]) : ACTION_LABEL[a]}
              </button>
            ))}
            {m.allowed.reject || m.allowed.fail ? <input className="fx-input w-64 text-sm" placeholder="Reason (for reject or close)" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
          </div>
        ) : null}
        {m.agentMode === "automated" && m.status === "approved" && !m.allowed.start ? (
          <p className="mt-2 text-xs text-stone-500">Starting {m.agentLabel} needs your authorization of live agent execution. The mission stays approved until then.</p>
        ) : null}
        {error ? (
          <div className="mt-3">
            <Alert tone="rose">{error}</Alert>
          </div>
        ) : null}
      </Card>
      <ClaudeCollaboration m={m} saved={() => (setTick((n) => n + 1), changed())} />
      {m.deliverable ? <DeliverableView m={m} /> : null}
      <Card title="Log" description="Every action, state change, agent activity, check and error, in order.">
        <ul className="divide-y divide-stone-100 text-sm" data-testid="eng-log">
          {m.events.map((e) => (
            <li key={e.id} className="flex gap-3 py-1.5">
              <span className="w-36 shrink-0 text-xs text-stone-500">{dateTime(e.at)}</span>
              <Badge tone={e.kind === "error" ? "rose" : e.kind === "check" ? "sky" : e.kind === "artifact" ? "violet" : "neutral"}>{e.kind}</Badge>
              <span className="text-stone-800">{e.summary}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Workflow B: copy the assignment into a Claude conversation, and paste Claude's answer back as evidence. A pasted
 * response is shown as text only, labeled unverified, and changes nothing about the mission.
 */
function ClaudeCollaboration({ m, saved }: { m: EngMissionDetail; saved: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAssignment, setShowAssignment] = useState(false);
  const copy = async () => {
    const r = await kelqor().copyText(m.assignment);
    setCopied(r.ok ? "Copied. Paste it into your Claude conversation." : "Couldn't copy; select the text below and copy it yourself.");
    if (!r.ok) setShowAssignment(true);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await kelqor().engMissionAction(m.id, "add_response", requestId(), { response: text });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setText("");
    saved();
  };
  return (
    <Card title="Work with Claude by copy and paste" description="Copy the assignment into an existing Claude conversation, then paste Claude's answer back here. Copying starts nothing.">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="fx-btn fx-btn-secondary" data-action="eng-copy-assignment" onClick={() => void copy()}>
          Copy assignment
        </button>
        <button type="button" className="text-sm text-stone-600 underline" onClick={() => setShowAssignment((v) => !v)}>
          {showAssignment ? "Hide" : "Show"} the assignment
        </button>
        {copied ? <span className="text-sm text-emerald-700" data-testid="eng-copied">{copied}</span> : null}
      </div>
      {showAssignment ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-3 text-xs text-stone-800" data-testid="eng-assignment">
          {m.assignment}
        </pre>
      ) : null}
      {m.allowed.add_response ? (
        <div className="mt-4">
          <Field label="Paste Claude's response" htmlFor="eng-response" hint="Up to 20,000 characters. Common key and password formats are removed before it's saved; don't paste secrets.">
            <textarea id="eng-response" className="fx-input h-32" maxLength={20_000} value={text} onChange={(e) => setText(e.target.value)} data-testid="eng-response-input" />
          </Field>
          <button type="button" className="fx-btn fx-btn-primary mt-2" data-action="eng-save-response" disabled={busy || !text.trim()} onClick={() => void save()}>
            Save response
          </button>
          {error ? (
            <div className="mt-2">
              <Alert tone="rose">{error}</Alert>
            </div>
          ) : null}
        </div>
      ) : null}
      {m.responses.length ? (
        <div className="mt-4 space-y-3" data-testid="eng-responses">
          {m.responses.map((r) => (
            <div key={r.id} className="rounded border border-amber-200 bg-amber-50/40 p-3" data-response={r.id}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="amber">Unverified · pasted manually</Badge>
                <span className="text-stone-600">
                  {r.actor ?? "Someone"}, {dateTime(r.at)} · {r.chars.toLocaleString("en-US")} characters
                </span>
                {r.redacted ? <Badge tone="rose">A possible secret was removed</Badge> : null}
              </div>
              <p className="mb-2 text-xs text-amber-900">Claude's own account, saved as evidence. It isn't a code change, a test result or an approval, and nothing in it can be applied.</p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm text-stone-800">{r.text}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function DeliverableView({ m }: { m: EngMissionDetail }) {
  const d = m.deliverable!;
  const steps: ChangeState[] = ["proposed", "tested", "founder_approved", "applied"];
  const reached = steps.indexOf(m.changeState);
  return (
    <Card title="Deliverable" description={`Collected ${dateTime(d.collectedAt)} from the worktree, against base ${m.baseCommit?.slice(0, 12)}. Change tree ${d.tree.slice(0, 12)}: what you approve and apply is exactly this tree.`}>
      <ol className="mb-3 flex flex-wrap gap-2 text-xs" data-testid="eng-change-steps">
        {steps.map((s, i) => (
          <li key={s} className={`rounded-full px-2 py-0.5 ring-1 ${i <= reached ? "bg-stone-900 text-white ring-stone-900" : "text-stone-500 ring-stone-200"}`}>
            {CHANGE[s].label}
          </li>
        ))}
      </ol>
      <SectionTitle>Agent's summary{m.simulated ? " (simulated)" : ""}</SectionTitle>
      <p className="whitespace-pre-wrap text-sm text-stone-800">{d.summary}</p>
      <SectionTitle>Changed files</SectionTitle>
      {d.files.length ? (
        <ul className="text-sm" data-testid="eng-files">
          {d.files.map((f) => (
            <li key={f.path} className="flex gap-2">
              <code>{f.path}</code>
              <span className="text-xs text-stone-500">
                {f.status} · +{f.additions} −{f.deletions}
              </span>
              {d.protectedFiles.includes(f.path) ? <Badge tone="rose">Protected: can't be applied</Badge> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-600">No files changed.</p>
      )}
      <SectionTitle>Checks</SectionTitle>
      {d.checks.length ? (
        <ul className="space-y-2" data-testid="eng-checks">
          {d.checks.map((c) => (
            <li key={c.check}>
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={c.passed ? "emerald" : "rose"}>{c.passed ? "Passed" : c.timedOut ? "Timed out" : "Failed"}</Badge>
                <code>{c.label}</code>
                <span className="text-xs text-stone-500">{(c.durationMs / 1000).toFixed(1)} s</span>
              </div>
              {c.output ? <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-50 p-2 text-xs text-stone-700">{c.output}</pre> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-600">{m.permissions.checks.length ? "Not run yet. Every check runs code from this change on this computer, with your rights and no sandbox, so a real agent's checks wait for you: read the change, then click Run checks." : "No checks were approved for this mission."}</p>
      )}
      <SectionTitle aside={d.diffTruncated ? <span className="text-xs text-amber-700">Shortened for display</span> : undefined}>Diff</SectionTitle>
      <pre className="max-h-[32rem] overflow-auto rounded bg-stone-900 p-3 text-xs leading-5 text-stone-100" data-testid="eng-diff">
        {d.diff || "(empty)"}
      </pre>
    </Card>
  );
}

function NewMission({ o, created }: { o: NonNullable<ReturnType<typeof useResult<import("@/lib/desktop/engineering").EngineeringOverview>>["data"]>; created: (id: string) => void }) {
  const [form, setForm] = useState<EngMissionInput>({ title: "", task: "", deliverables: "", workspaceId: o.workspaces[0]?.id ?? "", agent: "simulated", permissions: { editFiles: true, checks: [] } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = o.workspaces.find((w) => w.id === form.workspaceId);
  const set = (patch: Partial<EngMissionInput>) => setForm((f) => ({ ...f, ...patch }));
  if (!o.workspaces.length) return <Empty>Register a workspace first, or set up the demo workspace, under Workspaces.</Empty>;
  const save = async (submit: boolean) => {
    setBusy(true);
    setError(null);
    const r = await kelqor().engSaveMission(null, form, requestId());
    if (r.ok && submit) {
      const s = await kelqor().engMissionAction(r.data.id, "submit", requestId(), {});
      if (!s.ok) setError(s.error);
    }
    setBusy(false);
    if (!r.ok) return setError(r.error);
    created(r.data.id);
  };
  return (
    <Card title="New engineering mission" description="Describe the task. The owner approves exactly what is shown here; any later edit voids the approval.">
      <form className="grid gap-3" data-testid="eng-form" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-stone-600">Start from:</span>
          {TEMPLATES.map((t) => (
            <button key={t.name} type="button" className="fx-btn fx-btn-secondary text-xs" onClick={() => set({ title: t.title, task: t.task, deliverables: t.deliverables, permissions: { ...form.permissions, editFiles: t.editFiles } })}>
              {t.name}
            </button>
          ))}
        </div>
        <Field label="Title" htmlFor="eng-title">
          <input id="eng-title" className="fx-input" value={form.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Task" htmlFor="eng-task" hint="What the agent should do, in plain words.">
          <textarea id="eng-task" className="fx-input h-28" value={form.task} onChange={(e) => set({ task: e.target.value })} />
        </Field>
        <Field label="Deliverables" htmlFor="eng-deliverables" hint="What you expect back: files, tests, a report.">
          <textarea id="eng-deliverables" className="fx-input h-16" value={form.deliverables} onChange={(e) => set({ deliverables: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workspace" htmlFor="eng-ws">
            <select
              id="eng-ws"
              className="fx-input"
              value={form.workspaceId}
              onChange={(e) => {
                const w = o.workspaces.find((x) => x.id === e.target.value);
                set({ workspaceId: e.target.value, agent: w?.demo ? "simulated" : form.agent === "simulated" ? "claude_code" : form.agent });
              }}
            >
              {o.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent" htmlFor="eng-agent" hint={ws?.demo ? "The demo workspace is for the simulated agent." : "The simulated agent works only in the demo workspace."}>
            <select id="eng-agent" className="fx-input" value={form.agent} onChange={(e) => set({ agent: e.target.value as EngMissionInput["agent"] })}>
              {o.agents
                .filter((a) => (ws?.demo ? a.id === "simulated" : a.id !== "simulated"))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({AGENT_STATE[a.state].label.toLowerCase()})
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.permissions.editFiles} onChange={(e) => set({ permissions: { ...form.permissions, editFiles: e.target.checked } })} />
          The agent may change files (in its isolated worktree only)
        </label>
        <fieldset className="text-sm">
          <legend className="mb-1 text-stone-600">Checks KELQOR may run on the change</legend>
          {o.checks.map((c) => (
            <label key={c.id} className="mr-4 inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={form.permissions.checks.includes(c.id as never)}
                onChange={(e) => set({ permissions: { ...form.permissions, checks: e.target.checked ? [...form.permissions.checks, c.id as never] : form.permissions.checks.filter((x) => x !== c.id) } })}
              />
              <code>{c.label}</code>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-stone-500">No agent may run commands itself, push, publish, use the network, or change credentials. A change reaches the workspace only when you apply it, as a commit on a new local branch.</p>
        {error ? <Alert tone="rose">{error}</Alert> : null}
        <div className="flex gap-2">
          <button type="button" className="fx-btn fx-btn-primary" data-action="eng-save-submit" disabled={busy} onClick={() => void save(true)}>
            Save and submit for approval
          </button>
          <button type="button" className="fx-btn fx-btn-secondary" data-action="eng-save" disabled={busy} onClick={() => void save(false)}>
            Save as draft
          </button>
        </div>
      </form>
    </Card>
  );
}

function Agents({ agents, live }: { agents: AgentStatus[]; live: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-3" data-testid="eng-agents">
      {agents.map((a) => (
        <Card key={a.id} title={<span className="flex items-center gap-2">{a.label} <Badge tone={AGENT_STATE[a.state].tone}>{AGENT_STATE[a.state].label}</Badge></span>} description={a.mode === "manual" ? "Manual handoff" : a.mode === "simulated" ? "Simulated" : "Automated"}>
          <p className="text-sm text-stone-800">{a.detail}</p>
          {a.remedy ? <p className="mt-2 text-sm text-amber-800">{a.remedy}</p> : null}
          <p className="mt-2 text-xs text-stone-500">Cost: {a.costReporting}</p>
        </Card>
      ))}
      <p className="text-xs text-stone-500 md:col-span-3">Live agent execution is {live ? "authorized" : "off"}. Real-agent integration stays labeled unverified until an owner-authorized run succeeds.</p>
    </div>
  );
}

function Workspaces({ o, changed }: { o: NonNullable<ReturnType<typeof useResult<import("@/lib/desktop/engineering").EngineeringOverview>>["data"]>; changed: () => void }) {
  const [form, setForm] = useState({ name: "", path: "", baseBranch: "main" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) setError(r.error ?? "That didn't work.");
    changed();
  };
  return (
    <div className="space-y-4">
      <Card title="Registered workspaces" description="Missions work in isolated copies (git worktrees) of these. KELQOR never changes their files or checked-out branch.">
        {o.workspaces.length ? (
          <ul className="text-sm" data-testid="eng-workspaces">
            {o.workspaces.map((w) => (
              <li key={w.id} className="py-1">
                <span className="font-medium">{w.name}</span> {w.demo ? <Badge tone="violet">Demo</Badge> : null} <code className="text-xs">{w.path}</code> · {w.baseBranch}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">None yet.</p>
        )}
        {o.isFounder && !o.workspaces.some((w) => w.demo) ? (
          <button type="button" className="fx-btn fx-btn-secondary mt-3" data-action="eng-demo-workspace" disabled={busy} onClick={() => void run(kelqor().engDemoWorkspace())}>
            Set up the demo workspace
          </button>
        ) : null}
      </Card>
      {o.isFounder ? (
        <Card title="Register a workspace" description="The top folder of a git repository you want agents to work on.">
          <div className="grid gap-3 sm:grid-cols-3">
            <input className="fx-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="fx-input" placeholder="C:\\path\\to\\repository" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
            <input className="fx-input" placeholder="Base branch" value={form.baseBranch} onChange={(e) => setForm({ ...form, baseBranch: e.target.value })} />
          </div>
          <button type="button" className="fx-btn fx-btn-primary mt-3" disabled={busy} onClick={() => void run(kelqor().engAddWorkspace(form))}>
            Register
          </button>
        </Card>
      ) : null}
      {error ? <Alert tone="rose">{error}</Alert> : null}
    </div>
  );
}
