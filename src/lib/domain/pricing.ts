/**
 * Work Order pricing. All amounts are integer cents.
 * The defaults are business hypotheses from my decision notes (kept private); tune them with real delivery data.
 */
export const PRICING = {
  builderRateCents: 9_000, // blended builder rate used for estimates ($90/h)
  riskBuffer: 0.15, // added to the builder's fixed payout to absorb estimate risk
  targetMargin: 0.35, // ForgeX gross margin target (price minus builder payout)
  minMargin: 0.25, // below this the quote form warns the operator
  minPriceCents: 200_000, // $2,000 minimum Work Order; smaller needs fit a Care plan
  carePctOfPrice: 0.06, // Care plan monthly price as a share of the build price
  careMinCents: 14_900,
  careMaxCents: 99_900,
  careBuilderShare: 0.5,
  qaHours: 3, // operator time per order (scoping review, acceptance support)
  qaRateCents: 6_000,
  refundReserve: 0.03, // share of price set aside for redo/refund risk
  quoteValidDays: 14,
} as const;

export type FeeMethod = "card" | "ach" | "offline" | "test";

const roundTo = (cents: number, step: number) => Math.round(cents / step) * step;
const ceilTo = (cents: number, step: number) => Math.ceil(cents / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Stripe US list prices (stripe.com/pricing, checked 2026-10-26): cards 2.9% + 30¢, ACH 0.8% capped at $5. */
export function processingFeeCents(amountCents: number, method: FeeMethod): number {
  if (amountCents <= 0) return 0;
  if (method === "card") return Math.round(amountCents * 0.029) + 30;
  if (method === "ach") return Math.min(Math.round(amountCents * 0.008), 500);
  return 0;
}

export function suggestCarePriceCents(priceCents: number): number {
  // e.g. a $4,000 build -> $240 -> $249/month
  const raw = ceilTo(priceCents * PRICING.carePctOfPrice, 5_000) - 100;
  return clamp(raw, PRICING.careMinCents, PRICING.careMaxCents);
}

export function careBuilderShareCents(monthlyPriceCents: number): number {
  return Math.round(monthlyPriceCents * PRICING.careBuilderShare);
}

export interface PricingSuggestion {
  builderPayoutCents: number;
  priceCents: number;
  carePriceCents: number;
}

export function suggestPricing(input: {
  hoursLow: number;
  hoursHigh: number;
  builderRateCents?: number;
  riskBuffer?: number;
  targetMargin?: number;
}): PricingSuggestion {
  const low = Math.max(0, input.hoursLow);
  const high = Math.max(low, input.hoursHigh);
  const rate = input.builderRateCents ?? PRICING.builderRateCents;
  const buffer = input.riskBuffer ?? PRICING.riskBuffer;
  const margin = input.targetMargin ?? PRICING.targetMargin;
  const mid = (low + high) / 2;
  const builderPayoutCents = roundTo(mid * rate * (1 + buffer), 2_500);
  const priceCents = Math.max(PRICING.minPriceCents, ceilTo(builderPayoutCents / (1 - margin), 5_000));
  return { builderPayoutCents, priceCents, carePriceCents: suggestCarePriceCents(priceCents) };
}

export interface OrderEconomics {
  grossMarginCents: number;
  grossMarginPct: number;
  processingFeeCents: number;
  qaCostCents: number;
  reserveCents: number;
  contributionCents: number;
  contributionPct: number;
  warnings: string[];
}

/** What ForgeX keeps on one order after the builder, payment fees, QA time and the refund reserve. */
/** `listPriced`: a productized offer, deliberately priced below the custom Work Order minimum. */
export function orderEconomics(
  priceCents: number,
  builderPayoutCents: number,
  method: FeeMethod = "ach",
  opts: { listPriced?: boolean } = {},
): OrderEconomics {
  const grossMarginCents = priceCents - builderPayoutCents;
  const processing = processingFeeCents(priceCents, method);
  const qaCostCents = PRICING.qaHours * PRICING.qaRateCents;
  const reserveCents = Math.round(priceCents * PRICING.refundReserve);
  const contributionCents = grossMarginCents - processing - qaCostCents - reserveCents;
  const pct = (v: number) => (priceCents > 0 ? v / priceCents : 0);
  const warnings: string[] = [];
  if (builderPayoutCents < 0) warnings.push("The builder payout can't be negative.");
  if (!opts.listPriced && priceCents < PRICING.minPriceCents) warnings.push("Price is below the $2,000 custom Work Order minimum.");
  if (pct(grossMarginCents) < PRICING.minMargin) warnings.push("Gross margin is below 25%.");
  if (contributionCents < 0) warnings.push("This order loses money after fees, QA and reserve.");
  return {
    grossMarginCents,
    grossMarginPct: pct(grossMarginCents),
    processingFeeCents: processing,
    qaCostCents,
    reserveCents,
    contributionCents,
    contributionPct: pct(contributionCents),
    warnings,
  };
}
