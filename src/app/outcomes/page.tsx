import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { OUTCOMES } from "@/lib/scoping/catalog";
import { priceLabel, typicalWeeks } from "@/lib/scoping/display";

export const metadata: Metadata = { title: "Outcomes" };

export default async function OutcomesPage() {
  const user = await getSessionUser();
  const startHref = (slug: string) =>
    user?.role === "client" ? `/orders/new?template=${slug}` : `/signup?next=${encodeURIComponent(`/orders/new?template=${slug}`)}`;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <PageHeader
        eyebrow="Catalog"
        title="Outcomes, with the acceptance criteria up front"
        description="Each outcome is a starting point. Your Work Order is scoped to your systems and volume, and you approve the criteria before work starts."
      />
      <div className="space-y-5">
        {OUTCOMES.map((o) => (
          <article key={o.slug} id={o.slug} className="fx-card scroll-mt-24 px-5 py-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="max-w-2xl">
                <h2 className="text-lg font-semibold">{o.title}</h2>
                <p className="mt-1 text-sm text-stone-600">{o.tagline}</p>
                <p className="mt-2 text-sm text-stone-500">For example: {o.examples.join(" · ")}</p>
              </div>
              <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm md:text-right">
                <dt className="text-stone-500">{o.listPriceCents ? "Price" : "Typical price"}</dt>
                <dd className="font-semibold tabular-nums">{o.slug === "custom" ? "Quoted" : priceLabel(o)}</dd>
                <dt className="text-stone-500">Typical timeline</dt>
                <dd className="font-semibold">{typicalWeeks(o)}</dd>
              </dl>
            </div>
            <div className="mt-4 grid gap-4 border-t border-stone-100 pt-4 md:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-stone-800">Sample acceptance criteria</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-stone-700">
                  {o.scope.acceptanceCriteria.slice(0, 3).map((c) => (
                    <li key={c} className="flex gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ember-500" aria-hidden="true" />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-stone-800">Not included</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-stone-600">
                  {o.scope.outOfScope.slice(0, 3).map((c) => (
                    <li key={c} className="flex gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-300" aria-hidden="true" />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-4">
              <LinkButton href={startHref(o.slug)} variant={o.slug === "custom" ? "secondary" : "primary"}>
                {o.slug === "custom" ? "Describe something else" : "Start with this outcome"}
              </LinkButton>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
