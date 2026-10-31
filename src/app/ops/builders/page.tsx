import type { Metadata } from "next";
import Link from "next/link";
import { reviewBuilderAction } from "@/app/actions/builders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { listBuilders } from "@/lib/domain/builders";
import { BUILDER_STATUS_LABELS, BUILDER_STATUSES } from "@/lib/domain/types";
import { date, money, safeUrl } from "@/lib/format";

export const metadata: Metadata = { title: "Builders" };

const TONE = { applied: "sky", approved: "emerald", rejected: "rose", paused: "neutral" } as const;

export default async function BuildersAdminPage() {
  await requireUser(["operator"]);
  const builders = await listBuilders(await getDb());
  const order = { applied: 0, approved: 1, paused: 2, rejected: 3 } as const;
  builders.sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        eyebrow="ForgeX operations"
        title="Builders"
        description="Approve only after reviewing real shipped work and a live video call with a government ID. Approval requires the identity check."
      />
      {builders.length === 0 ? <EmptyState title="No builder applications yet" /> : null}
      <div className="space-y-4">
        {builders.map((b) => (
          <article key={b.id} className="fx-card px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  {b.name} {b.isDemo ? <span className="text-xs font-normal text-stone-400">(demo)</span> : null}
                </h2>
                <p className="text-sm text-stone-600">{b.headline}</p>
                <p className="text-xs text-stone-500">
                  {b.email} · applied {date(b.createdAt)}
                  {b.country ? ` · ${b.country}` : ""}
                  {b.hourlyRateCents ? ` · ${money(b.hourlyRateCents)}/h` : ""} · {b.completedCount} accepted Work Orders
                </p>
              </div>
              <div className="flex gap-2">
                <Badge tone={TONE[b.status]}>{BUILDER_STATUS_LABELS[b.status]}</Badge>
                {b.identityVerified ? <Badge tone="emerald">ID verified</Badge> : <Badge>ID not verified</Badge>}
              </div>
            </div>
            {b.skills.length ? <p className="mt-2 text-sm text-stone-700">Skills: {b.skills.join(", ")}</p> : null}
            {b.links.length ? (
              <ul className="mt-1 flex flex-wrap gap-x-4 text-sm">
                {b.links
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
            {b.sampleWork ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-stone-600">Sample work</summary>
                <p className="mt-1 whitespace-pre-line text-stone-700">{b.sampleWork}</p>
              </details>
            ) : null}
            <ActionForm action={reviewBuilderAction} className="mt-3 grid gap-2 border-t border-stone-100 pt-3 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
              <input type="hidden" name="builderId" value={b.id} />
              <select name="status" defaultValue={b.status} className="fx-input" aria-label="Status">
                {BUILDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {BUILDER_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <div className="space-y-2">
                <textarea name="notes" rows={2} defaultValue={b.vettingNotes} placeholder="Vetting notes (internal)" className="fx-input" aria-label="Vetting notes" />
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" name="identityVerified" defaultChecked={b.identityVerified} className="rounded border-stone-300" />
                  Identity verified on a live video call with a government ID
                </label>
              </div>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save
              </SubmitButton>
            </ActionForm>
            {b.status === "approved" ? (
              <Link href={`/b/${b.slug}`} className="fx-link mt-2 inline-block text-sm">
                Public record
              </Link>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
