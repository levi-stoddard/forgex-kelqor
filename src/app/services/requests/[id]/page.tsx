import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { answerServiceRequestAction, decideServiceRequestAction } from "@/app/actions/services";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Badge, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain/errors";
import { dateTime, money } from "@/lib/format";
import type { CustomerRequestView } from "@/lib/services/contract";
import { deliverableHash, getRequest } from "@/lib/services/service";
import { STATUS_TONE } from "../../status";

export const metadata: Metadata = { title: "Request" };

export default async function ServiceRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["client"]);
  const actor = toActor(user);
  const db = await getDb();
  const { id } = await params;
  let r: CustomerRequestView;
  try {
    r = (await getRequest(db, actor, id)) as CustomerRequestView;
  } catch (e) {
    if (e instanceof DomainError && e.code === "not_found") notFound();
    throw e;
  }
  const d = r.result;
  return (
    <div className="space-y-6" data-testid="customer-request" data-status={r.status}>
      <Link href="/services" className="inline-block py-2 text-sm text-stone-600 hover:underline">
        ← Your services
      </Link>
      <PageHeader eyebrow={`${r.label} · ${r.serviceName}`} title={r.title || "Request"} description={`Sent ${dateTime(r.submittedAt)}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[r.status]}>{r.statusLabel}</Badge>
        {r.simulated ? <Badge tone="violet">Simulated processing</Badge> : null}
      </div>
      {r.allowed.answer ? (
        <Card title="KELQOR needs a few details" description="Answer what you can; KELQOR works on it again as soon as you send this.">
          <ul className="mb-3 list-disc pl-5 text-sm text-stone-800">
            {r.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <ActionForm action={answerServiceRequestAction} className="grid gap-3" resetOnSuccess>
            <input type="hidden" name="requestId" value={r.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <textarea name="text" className="fx-input h-28" required minLength={2} maxLength={10_000} aria-label="Your answer" />
            <SubmitButton>Send the details</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}
      {d ? (
        <Card title={d.title} description={r.allowed.approve ? "KELQOR has reviewed this. It becomes final when you approve it." : r.status === "completed" ? "Final." : undefined}>
          <p className="text-sm text-stone-800">{d.summary}</p>
          {d.lines.length ? (
            <table className="mt-3 w-full text-sm" data-testid="quote-lines">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th className="py-1">Item</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i} className="border-t border-stone-100">
                    <td className="py-1">
                      {l.description}
                      {l.estimated ? <span className="ml-1 text-xs text-amber-700">(estimate)</span> : null}
                    </td>
                    <td>
                      {l.quantity} {l.unit}
                    </td>
                    <td>{money(l.unitCents)}</td>
                    <td className="text-right">{money(l.amountCents)}</td>
                  </tr>
                ))}
                <tr className="border-t border-stone-200 font-medium">
                  <td className="py-1" colSpan={3}>
                    Total, before materials
                  </td>
                  <td className="text-right" data-testid="quote-total">
                    {money(d.totalCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : null}
          {d.reply ? (
            <>
              <h3 className="mt-4 text-sm font-medium">A reply you can send</h3>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-stone-50 p-3 text-sm text-stone-800" data-testid="draft-reply">
                {d.reply}
              </pre>
              <p className="mt-1 text-xs text-stone-500">KELQOR never sends anything for you. Copy it into your own email when you're ready.</p>
            </>
          ) : null}
          {d.actions.length ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-stone-700">
              {d.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : null}
          {r.allowed.approve ? (
            <div className="mt-4 space-y-3 border-t border-stone-100 pt-4">
              <ActionForm action={decideServiceRequestAction}>
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <input type="hidden" name="resultHash" value={deliverableHash(d) ?? ""} />
                <input type="hidden" name="decision" value="approve" />
                <SubmitButton>Approve</SubmitButton>
              </ActionForm>
              <ActionForm action={decideServiceRequestAction} className="grid gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <input type="hidden" name="resultHash" value={deliverableHash(d) ?? ""} />
                <Field label="Or tell KELQOR what to change" htmlFor="note">
                  <textarea id="note" name="note" className="fx-input h-20" maxLength={2000} />
                </Field>
                <div className="flex gap-2">
                  <SubmitButton variant="secondary" name="decision" value="request_changes">
                    Ask for changes
                  </SubmitButton>
                  <SubmitButton variant="ghost" name="decision" value="decline">
                    Decline
                  </SubmitButton>
                </div>
              </ActionForm>
            </div>
          ) : null}
        </Card>
      ) : r.status === "failed" ? (
        <Alert tone="rose" title="This request couldn't be completed">
          KELQOR will contact you about it.
        </Alert>
      ) : !r.allowed.answer ? (
        <Alert tone="sky" title="KELQOR is working on it">
          You'll see the result here once KELQOR has reviewed it.
        </Alert>
      ) : null}
      <Card title="Your request">
        {r.input.from ? <p className="mb-1 text-xs text-stone-500">From {r.input.from}</p> : null}
        <pre className="whitespace-pre-wrap text-sm text-stone-800">{r.input.text}</pre>
      </Card>
      <Card title="History">
        <ul className="space-y-1 text-sm">
          {r.history.map((h, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-40 shrink-0 text-xs text-stone-500">{dateTime(h.at)}</span>
              <span>{h.summary}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
