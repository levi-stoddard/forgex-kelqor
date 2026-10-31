import { messageAction, milestoneAction } from "@/app/actions/orders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, BulletList, Card } from "@/components/ui";
import type { OrderView } from "@/lib/domain/orders";
import type { Intake, Scope } from "@/lib/domain/types";
import { dateTime, safeUrl } from "@/lib/format";
import { EVENT_LABELS, ROLE_LABELS } from "./labels";

export function RequestSummary({ intake, showBudget }: { intake: Intake; showBudget: boolean }) {
  const rows: [string, string][] = [
    ["The problem", intake.problem],
    ["What success looks like", intake.desiredOutcome],
    ["Current tools", intake.currentTools],
    ["Volume", intake.volume],
    ["Timeline", intake.deadline],
    // The budget hints at the client price, which builders never see.
    ["Budget", showBudget ? intake.budgetBand : ""],
  ];
  return (
    <details className="fx-card px-4 py-3 sm:px-5">
      <summary className="cursor-pointer text-sm font-semibold text-stone-800">The request, in the client's words</summary>
      <dl className="mt-3 space-y-3 text-sm">
        {rows
          .filter(([, v]) => v.trim())
          .map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs font-medium text-stone-500">{k}</dt>
              <dd className="whitespace-pre-line text-stone-800">{v}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}

export function ScopeView({ scope, showEstimate, showQuestions }: { scope: Scope; showEstimate: boolean; showQuestions: boolean }) {
  const blocks: [string, string[]][] = [
    ["Objectives", scope.objectives],
    ["In scope", scope.inScope],
    ["Not in scope", scope.outOfScope],
    ["Deliverables", scope.deliverables],
    ["Assumptions", scope.assumptions],
    ["What the client provides", scope.clientResponsibilities],
    ["Risks", scope.risks],
  ];
  return (
    <Card title="Scope" description={scope.summary}>
      <div className="grid gap-5 sm:grid-cols-2">
        {blocks.map(([title, items]) => (
          <div key={title}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">{title}</h3>
            <BulletList items={items} />
          </div>
        ))}
      </div>
      {showEstimate ? (
        <p className="mt-5 border-t border-stone-100 pt-3 text-sm text-stone-600">
          Estimated effort: <span className="font-semibold">{scope.estimateHoursLow}–{scope.estimateHoursHigh} builder hours</span> ·{" "}
          {scope.complexity} complexity{scope.recommendedSkills.length ? ` · ${scope.recommendedSkills.join(", ")}` : ""}
        </p>
      ) : null}
      {showQuestions && scope.clarifyingQuestions.length ? (
        <div className="mt-4 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 ring-inset">
          <p className="font-semibold">Open questions before pricing</p>
          <ul className="mt-1 list-disc pl-5">
            {scope.clarifyingQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

const CRITERION_BADGE = {
  pending: <Badge>Not reviewed</Badge>,
  met: <Badge tone="emerald">Met</Badge>,
  not_met: <Badge tone="rose">Not met</Badge>,
};

export function CriteriaList({ criteria, showEvidence }: { criteria: OrderView["criteria"]; showEvidence: boolean }) {
  return (
    <Card title="Acceptance criteria" description="The Work Order is done when every criterion is met.">
      <ol className="space-y-3">
        {criteria.map((c, i) => (
          <li key={c.id} className="rounded-lg border border-stone-200 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-stone-900">
                <span className="mr-1.5 text-stone-400">{i + 1}.</span>
                {c.text}
              </p>
              {showEvidence ? CRITERION_BADGE[c.status] : null}
            </div>
            {showEvidence && c.evidence ? (
              <p className="mt-2 rounded-md bg-stone-50 px-3 py-2 text-sm whitespace-pre-line text-stone-700">
                <span className="font-medium">Evidence: </span>
                {c.evidence}
              </p>
            ) : null}
            {c.reviewNote ? <p className="mt-2 text-sm text-rose-800">Review note: {c.reviewNote}</p> : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Milestones({ view }: { view: OrderView }) {
  if (!view.milestones.length) return null;
  const canEdit = view.permissions.updateMilestones;
  return (
    <Card title="Milestones">
      <ol className="space-y-2">
        {view.milestones.map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-3 text-sm">
            <div className="flex gap-2">
              <span
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${m.status === "done" ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-500"}`}
                aria-label={m.status === "done" ? "Done" : "Planned"}
              >
                {m.status === "done" ? "✓" : m.position + 1}
              </span>
              <div>
                <p className="font-medium text-stone-900">{m.title}</p>
                {m.description ? <p className="text-stone-600">{m.description}</p> : null}
              </div>
            </div>
            {canEdit ? (
              <ActionForm action={milestoneAction}>
                <input type="hidden" name="orderId" value={view.order.id} />
                <input type="hidden" name="milestoneId" value={m.id} />
                <input type="hidden" name="done" value={m.status === "done" ? "false" : "true"} />
                <SubmitButton variant="ghost" pendingText="…" className="px-2 py-1 text-xs">
                  {m.status === "done" ? "Reopen" : "Mark done"}
                </SubmitButton>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function DeliveryHistory({ deliveries }: { deliveries: OrderView["deliveries"] }) {
  if (!deliveries.length) return null;
  return (
    <Card title="Deliveries">
      <ol className="space-y-4">
        {deliveries.map((d) => (
          <li key={d.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Round {d.round}</span>
              <span className="text-stone-500">{dateTime(d.createdAt)}</span>
              {d.decision === "accepted" ? <Badge tone="emerald">Accepted</Badge> : null}
              {d.decision === "revision_requested" ? <Badge tone="amber">Revision requested</Badge> : null}
              {d.decision === "pending" ? <Badge tone="indigo">Awaiting review</Badge> : null}
            </div>
            <p className="mt-1 whitespace-pre-line text-stone-700">{d.summary}</p>
            {d.links.length ? (
              <ul className="mt-1 space-y-0.5">
                {d.links
                  .map((l) => safeUrl(l))
                  .filter((l): l is string => Boolean(l))
                  .map((l) => (
                    <li key={l}>
                      <a href={l} target="_blank" rel="noopener noreferrer nofollow" className="fx-link break-all">
                        {l}
                      </a>
                    </li>
                  ))}
              </ul>
            ) : null}
            {d.decisionNote ? <p className="mt-1 text-stone-600">Client: “{d.decisionNote}”</p> : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Thread({ view }: { view: OrderView }) {
  const { messages, permissions, viewer, order } = view;
  return (
    <Card title="Conversation" description={viewer.isOperator ? "Internal notes are visible to ForgeX only." : "You, your builder and ForgeX see this thread."}>
      {messages.length ? (
        <ul className="space-y-3">
          {messages.map((m) => (
            <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.internal ? "bg-amber-50 ring-1 ring-amber-200 ring-inset" : "bg-stone-50"}`}>
              <div className="flex flex-wrap justify-between gap-2 text-xs text-stone-500">
                <span>
                  <span className="font-semibold text-stone-700">{m.authorName}</span> · {ROLE_LABELS[m.authorRole] ?? m.authorRole}
                  {m.internal ? " · internal note" : ""}
                </span>
                <time>{dateTime(m.createdAt)}</time>
              </div>
              <p className="mt-1 whitespace-pre-line text-stone-800">{m.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-500">No messages yet.</p>
      )}
      {permissions.message ? (
        <ActionForm action={messageAction} resetOnSuccess className="mt-4 space-y-2">
          <input type="hidden" name="orderId" value={order.id} />
          <label htmlFor="body" className="sr-only">
            Message
          </label>
          <textarea id="body" name="body" rows={3} required maxLength={5000} className="fx-input" placeholder="Write a message. Never share passwords here." />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {viewer.isOperator ? (
              <label className="flex items-center gap-2 text-sm text-stone-600">
                <input type="checkbox" name="internal" className="rounded border-stone-300" /> Internal note (ForgeX only)
              </label>
            ) : (
              <span />
            )}
            <SubmitButton variant="secondary" pendingText="Sending…">
              Send
            </SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </Card>
  );
}

export function Timeline({ timeline }: { timeline: OrderView["timeline"] }) {
  return (
    <Card title="Timeline">
      <ol className="space-y-3">
        {timeline.map((e) => (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-stone-300" aria-hidden="true" />
            <div>
              <p className="text-stone-800">{EVENT_LABELS[e.type] ?? e.type.replaceAll("_", " ")}</p>
              <p className="text-xs text-stone-500">
                {e.actorName ?? "ForgeX"} · {dateTime(e.createdAt)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
