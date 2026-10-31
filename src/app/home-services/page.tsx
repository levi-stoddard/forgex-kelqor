import type { Metadata } from "next";
import { RoiCalculator } from "@/components/roi-calculator";
import { LinkButton } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { getOutcome, OUTCOMES } from "@/lib/scoping/catalog";
import { priceLabel, typicalWeeks } from "@/lib/scoping/display";

export const metadata: Metadata = {
  title: "For home-service contractors",
  description:
    "Fixed-price lead follow-through and owner reporting for HVAC, plumbing and electrical contractors, set up in the tools you already use.",
};

const STEPS = [
  {
    title: "Revenue Leak Check",
    body: "Send your phone, lead and quote exports. Within 5 business days you get your real answer rate, response time by lead source and open quotes, with a dollar figure. $500, credited to any fix you order within 30 days.",
  },
  { title: "A fixed price and a test for done", body: "Each fix comes with a fixed price and acceptance criteria you approve before any work starts." },
  { title: "Set up in your own accounts", body: "You invite ForgeX as a user. You keep ownership of every number, template and integration. No passwords are shared." },
  { title: "Accept it, then the monthly service starts", body: "We test every criterion together. The monthly fee starts at go-live and can be cancelled any month." },
];

const FAQ = [
  {
    q: "Do we have to change software?",
    a: "No. The work happens in the tools you already use: your field-service software, phone system, QuickBooks and lead services. The Leak Check confirms what your setup can export and connect before you buy anything else.",
  },
  {
    q: "Our software already has missed-call texting. Why pay for this?",
    a: "If one tool already covers your leads, use it. The pipeline is for shops whose leads come from several places (phone, website, Google, Angi, Facebook) and who can't see which ones wait too long or what each source costs per booked job.",
  },
  {
    q: "What if it doesn't do what you promised?",
    a: "The Work Order isn't complete until each acceptance criterion has been checked with you. If something isn't met, it gets fixed and re-tested.",
  },
  {
    q: "What does the monthly fee cover?",
    a: "Monitoring, fixes when a connected tool changes, template changes, and for the pipeline the texting and phone-number fees, up to 1,000 messages a month.",
  },
];

export default async function HomeServicesPage() {
  const user = await getSessionUser();
  const start = (slug: string) =>
    user?.role === "client" ? `/orders/new?template=${slug}` : user ? "/dashboard" : `/signup?next=${encodeURIComponent(`/orders/new?template=${slug}`)}`;
  const offers = OUTCOMES.filter((o) => o.featuredFor?.includes("home-services"));
  const pipeline = getOutcome("lead-response");

  return (
    <>
      <section className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 md:py-20">
          <p className="text-sm font-semibold text-ember-700">For HVAC, plumbing and electrical contractors</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-balance text-stone-900 sm:text-5xl">
            Stop paying for leads nobody calls back.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-stone-600">
            ForgeX connects every lead source, so each lead lands in your field-service software within two minutes, gets an instant reply, and
            raises an alert before it waits too long. Then you see what each source really costs per booked job.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href={start("revenue-leak-check")}>Start with a $500 Revenue Leak Check</LinkButton>
            <LinkButton href="#calculator" variant="secondary">
              Work out what it's worth
            </LinkButton>
          </div>
          <p className="mt-4 text-sm text-stone-500">Fixed prices. Set up in your own accounts. Checked against criteria you approve first.</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-semibold tracking-tight">Three ways to start</h2>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {offers.map((o) => (
            <article key={o.slug} className="fx-card flex flex-col px-5 py-5">
              <h3 className="text-lg font-semibold">{o.title}</h3>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{priceLabel(o)}</p>
              <p className="text-xs text-stone-500">{o.monthlyCents ? "Setup, then monthly from go-live" : `One-time · ${typicalWeeks(o)}`}</p>
              <p className="mt-3 text-sm text-stone-600">{o.tagline}</p>
              <h4 className="mt-4 text-sm font-semibold text-stone-800">Done means</h4>
              <ul className="mt-2 flex-1 space-y-1.5 text-sm text-stone-700">
                {o.scope.acceptanceCriteria.slice(0, 3).map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ember-500" aria-hidden="true" />
                    {c}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                <LinkButton href={start(o.slug)} variant={o.slug === "revenue-leak-check" ? "primary" : "secondary"}>
                  {o.slug === "revenue-leak-check" ? "Book the Leak Check" : "Start with this"}
                </LinkButton>
              </div>
            </article>
          ))}
        </div>
      </section>

      {pipeline?.listPriceCents && pipeline.monthlyCents ? (
        <section id="calculator" className="scroll-mt-20 border-y border-stone-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-2xl font-semibold tracking-tight">What is a faster response worth to you?</h2>
            <p className="mt-1 mb-6 max-w-2xl text-sm text-stone-600">Change any number to match your shop. Nothing you enter is sent anywhere.</p>
            <RoiCalculator setupDollars={pipeline.listPriceCents / 100} monthlyDollars={pipeline.monthlyCents / 100} />
          </div>
        </section>
      ) : null}

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
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

      <section className="border-t border-stone-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-14">
          <h2 className="text-2xl font-semibold tracking-tight">Questions owners ask</h2>
          <div className="mt-6 divide-y divide-stone-200">
            {FAQ.map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="cursor-pointer font-medium text-stone-900">{f.q}</summary>
                <p className="mt-2 text-sm text-stone-600">{f.a}</p>
              </details>
            ))}
          </div>
          <div className="mt-10 rounded-xl bg-stone-900 px-6 py-6 text-stone-100">
            <p className="text-lg font-semibold text-white">Start with the numbers.</p>
            <p className="mt-1 text-sm text-stone-300">The Leak Check tells you whether any of this is worth buying, before you buy it.</p>
            <div className="mt-4">
              <LinkButton href={start("revenue-leak-check")} variant="secondary">
                Book the $500 Leak Check
              </LinkButton>
            </div>
          </div>
          <p className="mt-6 text-xs text-stone-500">Pilot pricing. Work Order terms are drafts pending legal review.</p>
        </div>
      </section>
    </>
  );
}
