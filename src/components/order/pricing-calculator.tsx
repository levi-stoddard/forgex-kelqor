"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/actions";
import { orderEconomics, PRICING } from "@/lib/domain/pricing";

const toCents = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;

/** Quote form with live margin math, so the operator sees what ForgeX keeps before sending. */
export function PricingCalculator({
  action,
  orderId,
  initial,
  hours,
  listPriced,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  orderId: string;
  initial: { priceCents: number; builderPayoutCents: number; carePriceCents: number | null; careIncluded: boolean };
  hours: { low: number; high: number };
  listPriced: boolean;
}) {
  const [price, setPrice] = useState(String(initial.priceCents / 100));
  const [payout, setPayout] = useState(String(initial.builderPayoutCents / 100));
  const [care, setCare] = useState(initial.carePriceCents ? String(initial.carePriceCents / 100) : "");
  const [included, setIncluded] = useState(initial.careIncluded);
  const p = toCents(price);
  const b = toCents(payout);
  const ach = p && b !== null ? orderEconomics(p, b, "ach", { listPriced }) : null;
  const card = p && b !== null ? orderEconomics(p, b, "card", { listPriced }) : null;

  return (
    <ActionForm action={action} className="space-y-3">
      <input type="hidden" name="orderId" value={orderId} />
      <p className="text-xs text-stone-500">
        {listPriced
          ? "Prefilled with this outcome's list price, delivered in-house."
          : `Suggested from ${hours.low}–${hours.high} h at $${PRICING.builderRateCents / 100}/h plus a ${PRICING.riskBuffer * 100}% buffer, at a ${PRICING.targetMargin * 100}% target margin.`}
      </p>
      <label className="block">
        <span className="fx-label">Client price (fixed)</span>
        <input name="price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="fx-input" required />
      </label>
      <label className="block">
        <span className="fx-label">Builder payout (fixed)</span>
        <input name="payout" value={payout} onChange={(e) => setPayout(e.target.value)} inputMode="decimal" className="fx-input" required />
        <span className="fx-hint block">0 when ForgeX delivers the work in-house.</span>
      </label>
      <label className="block">
        <span className="fx-label">Monthly price</span>
        <input name="care" value={care} onChange={(e) => setCare(e.target.value)} inputMode="decimal" className="fx-input" placeholder="Blank for none" />
      </label>
      <label className="flex items-start gap-2 text-sm text-stone-700">
        <input type="checkbox" name="careIncluded" checked={included} onChange={(e) => setIncluded(e.target.checked)} className="mt-0.5 rounded border-stone-300" />
        <span>The monthly fee is part of the service (setup + monthly). Otherwise it's an optional Care plan offered at delivery.</span>
      </label>
      {ach && card ? (
        <dl className="space-y-1 rounded-lg bg-stone-50 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-stone-500">Gross margin</dt>
            <dd className="font-semibold tabular-nums">
              {usd(ach.grossMarginCents)} ({pct(ach.grossMarginPct)})
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">Contribution, paid by ACH</dt>
            <dd className="font-semibold tabular-nums">
              {usd(ach.contributionCents)} ({pct(ach.contributionPct)})
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">Contribution, paid by card</dt>
            <dd className="tabular-nums">{usd(card.contributionCents)}</dd>
          </div>
          <p className="pt-1 text-xs text-stone-500">
            After payment fees, {PRICING.qaHours} h of QA at ${PRICING.qaRateCents / 100}/h and a {PRICING.refundReserve * 100}% refund reserve.
            {b === 0 ? " In-house: your own delivery time is not counted here." : ""}
          </p>
        </dl>
      ) : null}
      {ach?.warnings.map((w) => (
        <p key={w} className="text-sm font-medium text-amber-700">
          {w}
        </p>
      ))}
      <SubmitButton pendingText="Sending…" className="w-full">
        Send quote to client
      </SubmitButton>
    </ActionForm>
  );
}
