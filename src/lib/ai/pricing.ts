import { INPUT_MARGIN, MISSION_OUTPUT_LIMIT, SpendRefused, type ProviderId } from "../missions/contract";
import type { TokenUsage } from "./types";

// Gemini list prices in USD per million tokens, from ai.google.dev/gemini-api/docs/pricing (checked 2026-10-27).
// Each entry applies from its date; Argon's promotional price ends Nov 30, 2026 and Flash's on Dec 31, 2026.
interface Price {
  from: string;
  input: number;
  cachedInput: number;
  output: number;
}

const PRICES: Record<string, Price[]> = {
  "gemini-4-argon": [
    { from: "2026-01-01", input: 2, cachedInput: 0.1, output: 10 },
    { from: "2026-12-01", input: 4, cachedInput: 0.2, output: 20 },
  ],
  "gemini-3.8-flash": [
    { from: "2026-01-01", input: 0.75, cachedInput: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
  ],
  // The offline stand-in used for cost-free runs and tests; it never calls a provider.
  simulated: [{ from: "2026-01-01", input: 0, cachedInput: 0, output: 0 }],
};

export function pricedModels(): string[] {
  return Object.keys(PRICES);
}

export function priceFor(model: string, at: Date = new Date()): Price {
  const list = PRICES[model];
  if (!list) throw new Error(`No price is recorded for ${model}, so its spending can't be capped.`);
  const day = at.toISOString().slice(0, 10);
  return [...list].reverse().find((p) => p.from <= day) ?? list[0];
}

/** Cost of one response in USD. Thinking is billed as output; tool-use prompt tokens as input. */
export function costUsd(model: string, usage: TokenUsage, at?: Date): number {
  const p = priceFor(model, at);
  const cached = Math.min(usage.cachedInput, usage.input);
  return (
    ((usage.input - cached) * p.input +
      cached * p.cachedInput +
      usage.toolUse * p.input +
      (usage.output + usage.thinking) * p.output) /
    1e6
  );
}

/**
 * The most one request can cost: every input token uncached, and output plus thinking both at the output limit.
 * Used to refuse a request before it is sent, never to report spending.
 */
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number, at?: Date): number {
  const p = priceFor(model, at);
  return (inputTokens * p.input + 2 * maxOutputTokens * p.output) / 1e6;
}

// ---- Milestone 2B: mission prices (OWNER: the security reviewer agent) ---------------------------------------------------------
// The benchmark above keeps its own table and rules. Missions use this dated table: each entry applies from 00:00 UTC
// on its date, and within 24 hours either side of a listed change the higher price applies, part by part, because the
// providers give dates without a time zone. A request whose input is larger than an entry covers is refused, since a
// larger-input price tier would be unknown. Prices are USD per million tokens, which is micro-dollars per token.

export interface MissionPrice {
  version: string;
  input: number;
  cachedInput: number;
  output: number;
  rule: "listed" | "higher near a change";
  /** The largest input, in tokens, the price is known to cover. */
  maxInputTokens: number;
}

interface MissionPriceEntry {
  from: string;
  input: number;
  cachedInput: number;
  output: number;
  maxInputTokens: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MISSION_PRICES: Record<string, { provider: ProviderId; entries: MissionPriceEntry[] }> = {
  // Google lists no larger-input tier for these models; 200,000 tokens is three times the benchmark's largest request.
  "gemini-4-argon": {
    provider: "google",
    entries: [
      { from: "2026-01-01", input: 2, cachedInput: 0.1, output: 10, maxInputTokens: 200_000 },
      { from: "2026-12-01", input: 4, cachedInput: 0.2, output: 20, maxInputTokens: 200_000 },
    ],
  },
  "gemini-3.8-flash": {
    provider: "google",
    entries: [
      { from: "2026-01-01", input: 0.75, cachedInput: 0.075, output: 3.75, maxInputTokens: 200_000 },
      { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5, maxInputTokens: 200_000 },
    ],
  },
  // Claude reviewers, recorded 2026-10-28 (docs/m2b/AUTHORIZATION.md). A higher price applies above 100,000 input
  // tokens that isn't recorded, so larger requests are refused. Cache reads are priced as plain input (the reviewer
  // asks for no caching), and cache writes are priced again on settlement and stop the provider.
  "claude-opus-5-5": { provider: "anthropic", entries: [{ from: "2026-10-28", input: 4, cachedInput: 4, output: 20, maxInputTokens: 100_000 }] },
  "claude-sonnet-5-5": { provider: "anthropic", entries: [{ from: "2026-10-28", input: 2, cachedInput: 2, output: 10, maxInputTokens: 100_000 }] },
  "claude-haiku-5-5": { provider: "anthropic", entries: [{ from: "2026-10-28", input: 0.1, cachedInput: 0.1, output: 0.5, maxInputTokens: 100_000 }] },
  // The $0 stand-in of simulated missions.
  simulated: { provider: "simulation", entries: [{ from: "2026-01-01", input: 0, cachedInput: 0, output: 0, maxInputTokens: 10_000_000 }] },
};

const startOf = (e: MissionPriceEntry) => Date.parse(`${e.from}T00:00:00Z`);

/** True when the model has a recorded mission price for that provider; "synthetic" (tests) uses a real model's price. */
export function isMissionModel(provider: ProviderId, model: string): boolean {
  const table = Object.hasOwn(MISSION_PRICES, model) ? MISSION_PRICES[model] : undefined;
  if (!table) return false;
  if (provider === "synthetic") return table.provider === "google" || table.provider === "anthropic";
  return table.provider === provider;
}

/** The price a request sent at `at` is reserved and settled at. Throws SpendRefused("unpriced_model") when there is none. */
export function missionPrice(model: string, at: Date): MissionPrice {
  const table = Object.hasOwn(MISSION_PRICES, model) ? MISSION_PRICES[model] : undefined;
  if (!table) throw new SpendRefused("unpriced_model", `No price is recorded for ${model}, so its spending can't be capped.`);
  const t = at instanceof Date ? at.getTime() : Number.NaN;
  if (!Number.isFinite(t)) throw new SpendRefused("unpriced_model", "The request has no valid date, so its price can't be established.");
  const entries = table.entries;
  for (let j = 1; j < entries.length; j++) {
    const change = startOf(entries[j]);
    if (t >= change - DAY_MS && t < change + DAY_MS) {
      const a = entries[j - 1];
      const b = entries[j];
      return {
        version: `${model}@${a.from}..${b.from}:higher`,
        input: Math.max(a.input, b.input),
        cachedInput: Math.max(a.cachedInput, b.cachedInput),
        output: Math.max(a.output, b.output),
        rule: "higher near a change",
        maxInputTokens: Math.min(a.maxInputTokens, b.maxInputTokens),
      };
    }
  }
  let current: MissionPriceEntry | null = null;
  for (const e of entries) if (startOf(e) <= t) current = e;
  if (!current) throw new SpendRefused("unpriced_model", `No price is recorded for ${model} on ${at.toISOString().slice(0, 10)}, so its spending can't be capped.`);
  return { version: `${model}@${current.from}`, input: current.input, cachedInput: current.cachedInput, output: current.output, rule: "listed", maxInputTokens: current.maxInputTokens };
}

/** A price in nano-dollars per token, exactly: every recorded price has at most three decimals. */
function nanoPerToken(usdPerMillion: number): number {
  const n = Math.round(usdPerMillion * 1000);
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0 || Math.abs(n - usdPerMillion * 1000) > 1e-6) {
    throw new SpendRefused("unpriced_model", `The price ${usdPerMillion} can't be applied exactly.`);
  }
  return n;
}

const ceilMicros = (nano: number) => Math.floor(nano / 1000) + (nano % 1000 > 0 ? 1 : 0);

const tokenCount = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000_000;

/**
 * The reservation for one mission request: the raw count plus the input the counter can't see, with the margin, at
 * the input price, and the output limit once at the output price, rounded up to the micro-dollar.
 */
export function reservationFor(model: string, input: { counted: number; uncounted: number }, maxOutputTokens: number, at: Date): { inputTokens: number; micros: number; price: MissionPrice } {
  if (!tokenCount(input.counted) || !tokenCount(input.uncounted)) throw new SpendRefused("count_failed", "The input count isn't a whole number of tokens, so nothing can be reserved.");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MISSION_OUTPUT_LIMIT) {
    throw new SpendRefused("output_limit", `The output limit must be between 1 and ${MISSION_OUTPUT_LIMIT.toLocaleString("en-US")} tokens.`);
  }
  const price = missionPrice(model, at);
  const percent = Math.round(INPUT_MARGIN.ratio * 100);
  const seen = input.counted + input.uncounted;
  const inputTokens = Math.floor((seen * percent + 99) / 100) + INPUT_MARGIN.tokens;
  if (inputTokens > price.maxInputTokens) {
    throw new SpendRefused("input_too_large", `This request's input (${inputTokens.toLocaleString("en-US")} tokens with the margin) is beyond the ${price.maxInputTokens.toLocaleString("en-US")} tokens ${model}'s recorded price covers.`);
  }
  const nano = inputTokens * nanoPerToken(price.input) + maxOutputTokens * nanoPerToken(price.output);
  return { inputTokens, micros: ceilMicros(nano), price };
}

/** The most a request may cost before any of its input is counted: the output limit alone. */
export function outputOnlyMicros(model: string, maxOutputTokens: number, at: Date): number {
  const price = missionPrice(model, at);
  return ceilMicros(maxOutputTokens * nanoPerToken(price.output));
}

/**
 * The cost of a mission response at the prices its ledger entry recorded. Cached input at the cached price, tool use
 * as input, thinking as output, and cache writes once more at the input price (they bill above it).
 */
export function missionCostMicros(prices: { input: number; cachedInput: number; output: number }, usage: TokenUsage): number {
  const cached = Math.min(usage.cachedInput, usage.input);
  const nano =
    (usage.input - cached) * nanoPerToken(prices.input) +
    cached * nanoPerToken(prices.cachedInput) +
    usage.toolUse * nanoPerToken(prices.input) +
    (usage.output + usage.thinking) * nanoPerToken(prices.output) +
    (usage.cacheWriteInput ?? 0) * nanoPerToken(prices.input);
  return ceilMicros(nano);
}
