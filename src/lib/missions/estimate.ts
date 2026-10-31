import { missionPrice, reservationFor } from "../controls";
import { MICROS_PER_USD, MISSION_OUTPUT_LIMIT, type MissionScope } from "./contract";

// The estimate the mission form shows before anyone approves a mission. "Typical" and "heaviest" come from the frozen
// full benchmark's per-company costs, rescaled to the price in effect on the date; the maximum is the cap the owner
// sets, which the controls enforce request by request. Industry research has no measured history yet.

/** Per-company cost in the frozen full run (25 companies), at the prices then in effect. */
const BENCHMARK: Record<string, { medianUsd: number; maxUsd: number; outputPrice: number }> = {
  "gemini-4-argon": { medianUsd: 0.137, maxUsd: 0.615, outputPrice: 10 },
  "gemini-3.8-flash": { medianUsd: 0.055, maxUsd: 0.2, outputPrice: 3.75 },
};
/** The largest single request in the frozen run used 66,432 input tokens. */
const LARGEST_INPUT = 70_000;

export interface MissionEstimate {
  model: string;
  priceVersion: string | null;
  typicalMicros: number | null;
  heaviestMicros: number | null;
  /**
   * What the controls reserve for one large request before sending it: its input, with the counting margin, at the input
   * price, plus the 20,000-token output limit once. A mission stops when the next reservation wouldn't fit its maximum.
   */
  largestRequestMicros: number | null;
  maxMicros: number;
  reviewMaxMicros: number;
  basis: string;
}

/**
 * What adding Claude review would reserve: the report and the cited pages read again (up to 12,000 characters each),
 * at the reviewer's input price, plus the output limit once. Pages are estimated from the sizes read in the research.
 */
export function estimateReview(model: string, input: { reportChars: number; pageChars: number[] }, at: Date = new Date()): { inputTokens: number; micros: number | null; priceVersion: string | null } {
  const chars = input.reportChars + input.pageChars.reduce((n, c) => n + Math.min(12_000, c), 0) + 2_000;
  const tokens = Math.ceil(chars / 3);
  try {
    const r = reservationFor(model, { counted: tokens, uncounted: 0 }, MISSION_OUTPUT_LIMIT, at);
    return { inputTokens: r.inputTokens, micros: r.micros, priceVersion: r.price.version };
  } catch {
    return { inputTokens: tokens, micros: null, priceVersion: null };
  }
}

export function estimateMission(scope: MissionScope, at: Date = new Date()): MissionEstimate {
  const reviewMaxMicros = scope.review?.maxCostMicros ?? 0;
  if (scope.simulated) {
    return { model: scope.model, priceVersion: null, typicalMicros: 0, heaviestMicros: 0, largestRequestMicros: 0, maxMicros: 0, reviewMaxMicros: 0, basis: "Simulated: no AI provider is called, so it costs $0." };
  }
  const bench = BENCHMARK[scope.model];
  let priceVersion: string | null = null;
  let scale = 1;
  let largest: number | null = null;
  try {
    const price = missionPrice(scope.model, at);
    priceVersion = price.version;
    if (bench) scale = price.output / bench.outputPrice;
    largest = reservationFor(scope.model, { counted: LARGEST_INPUT, uncounted: 0 }, MISSION_OUTPUT_LIMIT, at).micros;
  } catch {
    // An unpriced model can't be approved; the estimate says so.
  }
  const micros = (usd: number) => Math.round(usd * scale * MICROS_PER_USD);
  const company = scope.type === "company_research";
  return {
    model: scope.model,
    priceVersion,
    typicalMicros: bench ? micros(bench.medianUsd) : null,
    heaviestMicros: bench ? micros(bench.maxUsd) : null,
    largestRequestMicros: largest,
    maxMicros: scope.maxCostMicros,
    reviewMaxMicros,
    basis: !priceVersion
      ? "This model has no recorded price, so it can't be chosen."
      : company
        ? "Typical and heaviest are the frozen benchmark's median and largest company costs, at the price in effect on the date."
        : "No industry mission has run yet: the company benchmark's costs are shown as a rough guide only.",
  };
}
