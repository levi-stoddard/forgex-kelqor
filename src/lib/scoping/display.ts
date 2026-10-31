import { suggestPricing } from "../domain/pricing";
import { money } from "../format";
import type { OutcomeTemplate } from "./catalog";

/** Typical fixed-price range for a catalog outcome, from its hours range and the pricing rules. */
export function priceRange(o: OutcomeTemplate): string {
  const low = suggestPricing({ hoursLow: o.hoursLow, hoursHigh: o.hoursLow }).priceCents;
  const high = suggestPricing({ hoursLow: o.hoursHigh, hoursHigh: o.hoursHigh }).priceCents;
  return `${money(low)}–${money(high)}`;
}

/** The price shown in the catalog: the list price (plus monthly) for productized outcomes, otherwise the typical range. */
export function priceLabel(o: OutcomeTemplate): string {
  if (!o.listPriceCents) return priceRange(o);
  return o.monthlyCents ? `${money(o.listPriceCents)} + ${money(o.monthlyCents)}/mo` : money(o.listPriceCents);
}

/** Rough calendar time for one builder working part-time (~15 h/week) on the Work Order. */
export function typicalWeeks(o: OutcomeTemplate): string {
  if (o.hoursHigh <= 8) return "1 week";
  const low = Math.max(1, Math.round(o.hoursLow / 15));
  const high = Math.max(low + 1, Math.round(o.hoursHigh / 15));
  return `${low}–${high} weeks`;
}
