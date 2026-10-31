"use client";

import { useState } from "react";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Input = { key: string; label: string; suffix?: string; prefix?: string; hint: string };

const INPUTS: Input[] = [
  { key: "leads", label: "Leads a month", hint: "Calls, web forms and lead-service leads together." },
  { key: "missed", label: "Missed or answered late", suffix: "%", hint: "Not answered, or first reply after 30 minutes." },
  { key: "recovered", label: "Of those, won back by an instant reply", suffix: "%", hint: "Text-back and alerts reach them while they're still choosing." },
  { key: "booked", label: "Won-back leads that book", suffix: "%", hint: "Usually lower than your normal booking rate." },
  { key: "job", label: "Average booked job", prefix: "$", hint: "Revenue per booked job, repairs and installs together." },
  { key: "margin", label: "Gross margin per job", suffix: "%", hint: "After parts and labor." },
];

// Deliberately cautious example values; the Revenue Leak Check replaces them with measured ones.
const DEFAULTS: Record<string, string> = { leads: "150", missed: "15", recovered: "20", booked: "30", job: "1200", margin: "50" };

/** What a faster lead response could be worth, and how many extra jobs pay for the pipeline. */
export function RoiCalculator({ setupDollars, monthlyDollars }: { setupDollars: number; monthlyDollars: number }) {
  const [values, setValues] = useState(DEFAULTS);
  const n = (k: string) => {
    const v = Number(values[k]);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const jobs = n("leads") * (n("missed") / 100) * (n("recovered") / 100) * (n("booked") / 100);
  const profitPerJob = n("job") * (n("margin") / 100);
  const monthlyProfit = jobs * profitPerJob;
  const net = monthlyProfit - monthlyDollars;
  const paybackMonths = net > 0 ? setupDollars / net : null;
  const breakEvenJobs = profitPerJob > 0 ? (setupDollars + 6 * monthlyDollars) / profitPerJob : null;

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
      <div className="grid gap-3 sm:grid-cols-2">
        {INPUTS.map((i) => (
          <label key={i.key} className="block">
            <span className="fx-label">{i.label}</span>
            <span className="relative block">
              {i.prefix ? <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-stone-500">{i.prefix}</span> : null}
              <input
                value={values[i.key]}
                onChange={(e) => setValues({ ...values, [i.key]: e.target.value })}
                inputMode="decimal"
                className="fx-input"
                // Inline so it wins over .fx-input's own padding and the prefix or suffix never covers a digit.
                style={{ paddingLeft: i.prefix ? "1.75rem" : undefined, paddingRight: i.suffix ? "2rem" : undefined }}
              />
              {i.suffix ? <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-stone-500">{i.suffix}</span> : null}
            </span>
            <span className="fx-hint block">{i.hint}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-stone-900 px-5 py-5 text-stone-100">
          <p className="text-sm text-stone-300">Extra gross profit a month</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight text-white tabular-nums">{usd(monthlyProfit)}</p>
          <p className="mt-1 text-sm text-stone-300 tabular-nums">
            from about {jobs.toFixed(1)} extra booked jobs a month
          </p>
          <dl className="mt-4 space-y-1.5 border-t border-stone-700 pt-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-300">After the {usd(monthlyDollars)} monthly fee</dt>
              <dd className="font-semibold text-white tabular-nums">{usd(net)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-300">The {usd(setupDollars)} setup pays back in</dt>
              <dd className="font-semibold text-white tabular-nums">
                {paybackMonths === null ? "not at these numbers" : paybackMonths < 1 ? "under a month" : `${paybackMonths.toFixed(1)} months`}
              </dd>
            </div>
          </dl>
        </div>
        <div className="fx-card px-5 py-4 text-sm">
          <p className="font-semibold text-stone-900">The simpler test</p>
          <p className="mt-1 text-stone-600">
            {breakEvenJobs === null ? (
              "Enter your average job and margin."
            ) : (
              <>
                The pipeline covers its setup and six months of fees if it books{" "}
                <span className="font-semibold text-stone-900 tabular-nums">{Math.ceil(breakEvenJobs)} extra jobs</span> in those six months.
              </>
            )}
          </p>
        </div>
        <p className="text-xs text-stone-500">
          An estimate from the numbers you enter, not a promise. The defaults are cautious examples, not industry figures. The Revenue Leak Check
          measures your real answer rate and response times first.
        </p>
      </div>
    </div>
  );
}
