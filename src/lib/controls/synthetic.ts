import type { ModelReply, ModelRequest, TokenUsage } from "../ai/types";
import { MISSION_OUTPUT_LIMIT, ProviderError, type MissionProvider } from "../missions/contract";
import { issueTicket, redeemTicket, requestDigest, retireTicket, TICKET_TTL_MS } from "./tickets";

// The synthetic-cost provider: test-only. A simulated provider drives the conversation, and this one reports invented
// usage so that caps, unknown charges and reconciliation can be tested with real prices and no AI provider. It wraps
// only a simulated provider, never a real one; the controls accept it only on a test database (testmode.ts), and its
// ledger rows are flagged synthetic.

export interface SyntheticPlan {
  /** The invented input count for the n-th count (default: a quarter of the request's characters). */
  count?: (request: ModelRequest, n: number) => number;
  /** The invented usage of the n-th reply, or "unreported" for a reply without usage (default: the count as input). */
  usage?: (request: ModelRequest, n: number, counted: number) => Partial<TokenUsage> | "unreported";
  /** A failure for the n-th count instead of a number. */
  failCount?: (n: number) => Error | null;
  /** A failure for the n-th reply instead of an answer (after its ticket is redeemed: it "left"). */
  fail?: (n: number) => Error | null;
  /** Holds the n-th reply until the run is cancelled: a request in flight. */
  hang?: (n: number) => boolean;
  /** Waits this long before the n-th reply. */
  delayMs?: (n: number) => number;
  /** Called once a reply's ticket is redeemed, with the request that left. */
  onSend?: (request: ModelRequest, n: number) => void;
}

const DEFAULT_OUTPUT = 1_500;
const DEFAULT_THINKING = 500;

/**
 * The plan the backend uses in test mode, from the environment: KELQOR_SYNTHETIC_USAGE=<input>:<output> tokens per
 * request (default 30000:15000; the count reported equals the input, so it never exceeds its reservation) and
 * KELQOR_SYNTHETIC_DELAY_MS before each reply (default 0), during which the run can be cancelled.
 */
export function syntheticPlanFromEnv(env: Record<string, string | undefined> = process.env): SyntheticPlan {
  const raw = env.KELQOR_SYNTHETIC_USAGE?.trim() || "30000:15000";
  const m = /^(\d{1,7}):(\d{1,6})$/.exec(raw);
  const input = m ? Number(m[1]) : Number.NaN;
  const output = m ? Number(m[2]) : Number.NaN;
  if (!m || input < 1 || input > 150_000 || output > MISSION_OUTPUT_LIMIT) {
    throw new Error(`KELQOR_SYNTHETIC_USAGE must be <input tokens>:<output tokens>, input 1 to 150,000 and output at most ${MISSION_OUTPUT_LIMIT.toLocaleString("en-US")}, such as 30000:15000.`);
  }
  const delayRaw = env.KELQOR_SYNTHETIC_DELAY_MS?.trim() || "0";
  const delay = Number(delayRaw);
  if (!/^\d{1,7}$/.test(delayRaw) || delay > 600_000) throw new Error("KELQOR_SYNTHETIC_DELAY_MS must be a whole number of milliseconds, at most 600000.");
  return { count: () => input, usage: () => ({ input, cachedInput: 0, output, thinking: 0, toolUse: 0 }), delayMs: () => delay };
}

function untilAborted(signal: AbortSignal, ms: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new ProviderError("Cancelled while the request was in flight.", "cancelled", "unknown"));
    if (signal.aborted) return cancelled();
    signal.addEventListener("abort", cancelled, { once: true });
    if (ms !== null) setTimeout(resolve, ms);
  });
}

export function syntheticProvider(opts: { inner: MissionProvider; model: string; plan?: SyntheticPlan }): MissionProvider {
  if (!opts.inner || opts.inner.kind !== "simulated") throw new Error("The synthetic-cost provider wraps only a simulated provider; it never reaches a real one.");
  const plan = opts.plan ?? syntheticPlanFromEnv();
  let counts = 0;
  let replies = 0;
  let lastCount = 1;
  return {
    provider: "synthetic",
    model: opts.model,
    kind: "synthetic",
    thinkingLevel: null,
    async countInputTokens(req, ticket) {
      redeemTicket(ticket, { use: "count", provider: "synthetic", model: opts.model, kind: "synthetic", request: req });
      const n = ++counts;
      const failure = plan.failCount?.(n);
      if (failure) throw failure;
      lastCount = plan.count?.(req, n) ?? Math.max(1, Math.ceil((req.system.length + JSON.stringify(req.turns).length) / 4));
      return { counted: lastCount, uncounted: 0 };
    },
    async respond(req, ticket, signal): Promise<ModelReply> {
      redeemTicket(ticket, { use: "send", provider: "synthetic", model: opts.model, kind: "synthetic", request: req });
      const n = ++replies;
      plan.onSend?.(req, n);
      if (plan.hang?.(n)) await untilAborted(signal, null);
      const wait = plan.delayMs?.(n) ?? 0;
      if (wait > 0) await untilAborted(signal, wait);
      const failure = plan.fail?.(n);
      if (failure) throw failure;
      // The simulated provider answers under a ticket of its own, for the same request.
      const inner = issueTicket({
        use: "send",
        reservationId: ticket.reservationId,
        provider: opts.inner.provider,
        model: opts.inner.model,
        kind: "simulated",
        maxOutputTokens: req.maxOutputTokens,
        digest: requestDigest(req),
        validForMs: TICKET_TTL_MS,
      });
      let reply: ModelReply;
      try {
        reply = await opts.inner.respond(req, inner, signal);
      } finally {
        retireTicket(inner);
      }
      const invented = plan.usage?.(req, n, lastCount);
      if (invented === "unreported") return { ...reply, model: opts.model, usage: { input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 }, usageReported: false };
      const usage: TokenUsage = { input: lastCount, cachedInput: 0, output: DEFAULT_OUTPUT, thinking: DEFAULT_THINKING, toolUse: 0, total: 0, ...invented };
      if (invented?.total === undefined) usage.total = usage.input + usage.output + usage.thinking + usage.toolUse;
      return { ...reply, model: opts.model, usage, usageReported: true };
    },
  };
}
