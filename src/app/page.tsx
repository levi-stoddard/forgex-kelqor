import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { OUTCOMES } from "@/lib/scoping/catalog";
import { priceLabel } from "@/lib/scoping/display";

const STEPS = [
  { title: "Describe the problem", body: "Plain words are fine. Start from a catalog outcome if one fits." },
  {
    title: "Get a scope and a fixed price",
    body: "AI drafts the scope with testable acceptance criteria. A ForgeX operator reviews it and quotes a fixed price, usually within one business day.",
  },
  { title: "A vetted builder delivers", body: "Identity-verified builders work in your own accounts. Progress and conversation live in one place." },
  { title: "Accept, then they're paid", body: "Check each criterion against the builder's evidence. Payment is released only when you accept." },
];

const PROMISES = [
  { title: "A price, not an hourly meter", body: "You approve a fixed price before work starts. Changes are re-quoted, never billed as a surprise." },
  { title: "Criteria you can test", body: "Every Work Order says what done means in measurable terms, agreed before anyone starts." },
  { title: "Paid on acceptance", body: "The builder is paid only after you check the delivery against the criteria and accept it." },
];

export default async function HomePage() {
  const user = await getSessionUser();
  const startHref = user?.role === "client" ? "/orders/new" : user ? "/dashboard" : "/signup";
  const outcomes = OUTCOMES.filter((o) => o.slug !== "custom");
  return (
    <>
      <section className="border-b border-stone-200 bg-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.15fr_1fr] md:items-center md:py-20">
          <div>
            <p className="text-sm font-semibold text-ember-700">Fixed-price AI and automation for growing service businesses</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance text-stone-900 sm:text-5xl">
              Automation that's scoped, priced and accepted before anyone gets paid.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-stone-600">
              Tell us what's slowing your team down. ForgeX writes the scope and the acceptance criteria, quotes a fixed price, and assigns a
              vetted builder. The builder is paid when you accept the work.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href={startHref}>Start a request</LinkButton>
              <LinkButton href="/outcomes" variant="secondary">
                See typical outcomes
              </LinkButton>
            </div>
            <p className="mt-4 text-sm text-stone-500">No charge until you accept a quote. Built for teams of about 20–250 people.</p>
          </div>

          <figure className="fx-card overflow-hidden" aria-label="Example Work Order">
            <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50 px-5 py-3 text-xs text-stone-500">
              <span className="font-semibold text-stone-700">Example Work Order</span>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-800 ring-1 ring-indigo-200 ring-inset">In review</span>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div>
                <div className="text-xs text-stone-500">FX-1042</div>
                <div className="text-lg font-semibold">Instant lead response and CRM capture</div>
              </div>
              <div className="flex items-baseline justify-between rounded-lg bg-stone-50 px-3 py-2 text-sm">
                <span className="text-stone-500">Fixed price</span>
                <span className="font-semibold tabular-nums">$3,900</span>
              </div>
              <ul className="space-y-2 text-sm">
                {[
                  ["met", "A test lead from each source appears in the CRM within 2 minutes"],
                  ["met", "The first reply reaches the lead within 5 minutes"],
                  ["pending", "Leads route to the right estimator in 3 test scenarios"],
                ].map(([state, text]) => (
                  <li key={text} className="flex gap-2">
                    <span
                      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${state === "met" ? "bg-emerald-100 text-emerald-700" : "bg-stone-200 text-stone-600"}`}
                      aria-hidden="true"
                    >
                      {state === "met" ? "✓" : "·"}
                    </span>
                    <span className="text-stone-700">{text}</span>
                  </li>
                ))}
              </ul>
              <p className="rounded-lg border border-ember-200 bg-ember-50 px-3 py-2 text-xs text-ember-800">
                The builder is paid only after every criterion is accepted.
              </p>
            </div>
          </figure>
        </div>
      </section>

      <section className="border-b border-ember-200 bg-ember-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-ember-900">
            <span className="font-semibold">HVAC, plumbing or electrical contractor?</span> Three fixed-price ways to stop losing paid leads, starting
            at $500.
          </p>
          <Link href="/home-services" className="fx-link shrink-0 font-medium">
            See the home-services offers →
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-semibold tracking-tight">How a Work Order works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="fx-card px-5 py-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-white">{i + 1}</span>
              <h3 className="mt-3 font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm text-stone-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Outcomes we deliver</h2>
              <p className="mt-1 text-sm text-stone-600">Typical fixed prices for one Work Order. Your quote depends on your systems and volume.</p>
            </div>
            <Link href="/outcomes" className="fx-link text-sm">
              All outcomes and acceptance criteria →
            </Link>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {outcomes.map((o) => (
              <Link
                key={o.slug}
                href={user?.role === "client" ? `/orders/new?template=${o.slug}` : `/outcomes#${o.slug}`}
                className="fx-card group flex flex-col px-5 py-5 transition-shadow hover:shadow-md"
              >
                <h3 className="font-semibold group-hover:text-ember-700">{o.title}</h3>
                <p className="mt-1 flex-1 text-sm text-stone-600">{o.tagline}</p>
                <p className="mt-4 text-sm">
                  <span className="text-stone-500">{o.listPriceCents ? "Price: " : "Typical: "}</span>
                  <span className="font-semibold tabular-nums">{priceLabel(o)}</span>
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="grid gap-4 md:grid-cols-3">
          {PROMISES.map((p) => (
            <div key={p.title} className="px-1">
              <h3 className="font-semibold">{p.title}</h3>
              <p className="mt-1 text-sm text-stone-600">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-stone-900 text-stone-100">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight text-white">Build, don't bid.</h2>
            <p className="mt-2 text-stone-300">
              Approved builders get scoped, already-funded Work Orders with a fixed payout, and a public record of accepted work that clients
              can trust.
            </p>
          </div>
          <LinkButton href="/builders" variant="secondary">
            For builders
          </LinkButton>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-12 text-center text-sm text-stone-600">
        ForgeX is preparing its first pilot Work Orders. If you'd like to be one of them, create an account and submit a request.
      </section>
    </>
  );
}
