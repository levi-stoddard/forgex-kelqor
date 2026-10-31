import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, EmptyState } from "@/components/ui";
import { getDb } from "@/lib/db";
import { getPublicRecord } from "@/lib/domain/builders";
import { date, pct, safeUrl } from "@/lib/format";
import { getOutcome } from "@/lib/scoping/catalog";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const record = await getPublicRecord(await getDb(), (await params).slug);
  return { title: record ? `${record.name}: verified record` : "Builder not found" };
}

export default async function PublicRecordPage({ params }: { params: Promise<{ slug: string }> }) {
  const record = await getPublicRecord(await getDb(), (await params).slug);
  if (!record) notFound();
  const { profile, stats } = record;
  const links = profile.links.map(safeUrl).filter((l): l is string => Boolean(l));
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold tracking-wide text-ember-700 uppercase">ForgeX verified record</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{record.name}</h1>
          <p className="mt-1 text-stone-600">{profile.headline}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {profile.identityVerified ? <Badge tone="emerald">Identity verified</Badge> : null}
            {profile.country ? <Badge>{profile.country}</Badge> : null}
            {profile.skills.map((s) => (
              <Badge key={s} tone="neutral">
                {s}
              </Badge>
            ))}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-center sm:min-w-80">
          <div className="fx-card px-3 py-3">
            <dt className="text-xs text-stone-500">Accepted Work Orders</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{stats.completed}</dd>
          </div>
          <div className="fx-card px-3 py-3">
            <dt className="text-xs text-stone-500">Accepted first time</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{stats.firstPassRate === null ? "—" : pct(stats.firstPassRate)}</dd>
          </div>
          <div className="fx-card px-3 py-3">
            <dt className="text-xs text-stone-500">Client rating</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{stats.avgRating === null ? "—" : `${stats.avgRating.toFixed(1)}/5`}</dd>
          </div>
        </dl>
      </div>

      {profile.bio ? <p className="mt-6 max-w-2xl text-sm leading-relaxed whitespace-pre-line text-stone-700">{profile.bio}</p> : null}
      {links.length ? (
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map((l) => (
            <li key={l}>
              <a href={l} className="fx-link" rel="nofollow noopener noreferrer" target="_blank">
                {new URL(l).hostname}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <h2 className="mt-10 text-lg font-semibold">Accepted work</h2>
      <p className="mt-1 text-sm text-stone-500">
        Every entry is a ForgeX Work Order the client accepted against written criteria and paid for. Clients decide whether an entry is shown and
        whether their name appears.
      </p>
      <div className="mt-4 space-y-3">
        {record.records.length === 0 ? (
          <EmptyState title="No public entries yet">Accepted Work Orders appear here when clients choose to share them.</EmptyState>
        ) : (
          record.records.map((r) => (
            <article key={r.ref} className="fx-card px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{r.title}</h3>
                  <p className="text-sm text-stone-500">
                    {r.client} · {getOutcome(r.category)?.title ?? "Custom automation"} · accepted {date(r.completedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.testData ? <Badge tone="amber">Test data</Badge> : null}
                  {r.firstPass ? <Badge tone="emerald">Accepted first time</Badge> : <Badge>Accepted after revision</Badge>}
                  {r.rating ? <Badge tone="ember">{r.rating}/5</Badge> : null}
                </div>
              </div>
              {r.comment ? <p className="mt-2 text-sm text-stone-700">“{r.comment}”</p> : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
