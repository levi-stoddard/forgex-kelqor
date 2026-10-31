import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type MissionProvider, type SpendTicket, type TicketUse } from "../missions/contract";
import type { ModelReply, ModelRequest, TokenUsage } from "./types";

// Claude as the optional reviewer of a mission's report (Milestone 2B). Like the Gemini mission adapter it is reached
// only through the controls' metered pathway: each request is counted with Anthropic's counter, reserved, and carries
// a single-use ticket; the SDK's automatic retries are off. No key is configured today, so review is "Unavailable"
// for real missions and only the simulated reviewer runs.

const REVIEW_TIMEOUT_MS = 300_000;

export function anthropicKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/** Remove the API key from any text before it is printed or stored. */
export function redactAnthropicKey(text: string): string {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? text.split(key).join("[redacted key]") : text;
}

function messagesOf(req: ModelRequest): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of req.turns) {
    if (t.kind === "user") out.push({ role: "user", content: t.text });
    else if (t.kind === "model") {
      const text = (t.steps as { type?: string; text?: string }[]).filter((s) => s.type === "text").map((s) => s.text ?? "").join("");
      if (text) out.push({ role: "assistant", content: text });
    } else throw new ProviderError("The Claude reviewer takes no tool results.", "invalid_request", "no");
  }
  return out;
}

export function claudeUsage(u: Anthropic.Usage | undefined): TokenUsage {
  const cached = u?.cache_read_input_tokens ?? 0;
  const created = u?.cache_creation_input_tokens ?? 0;
  // Claude reports thinking inside output_tokens, so thinking stays 0 here and is never billed twice.
  const input = (u?.input_tokens ?? 0) + cached + created;
  const output = u?.output_tokens ?? 0;
  // KELQOR never asks for caching; any cache write is reported so the controls can treat it as an overrun.
  return { input, cachedInput: cached, output, thinking: 0, toolUse: 0, total: input + output, cacheWriteInput: created };
}

export function claudeFailure(e: unknown, cancelled: boolean): ProviderError {
  const message = redactAnthropicKey(e instanceof Error ? e.message : String(e)).slice(0, 500);
  if (cancelled || e instanceof Anthropic.APIUserAbortError) return new ProviderError(`Cancelled while the request was in flight: ${message}`, "cancelled", "unknown");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError(message, "timeout", "unknown");
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(message, "network", "unknown");
  if (e instanceof Anthropic.APIError && typeof e.status === "number") {
    const s = e.status;
    if (s === 400 || s === 413 || s === 422) return new ProviderError(message, "invalid_request", "yes", s);
    if (s === 401 || s === 403) return new ProviderError(message, "auth", "yes", s);
    if (s === 404) return new ProviderError(message, "not_found", "yes", s);
    if (s === 429) return new ProviderError(message, "rate_limit", "yes", s);
    if (s >= 500) return new ProviderError(message, "server", "yes", s);
  }
  return new ProviderError(message, "other", "unknown");
}

export interface ClaudeReviewOptions {
  redeem: (ticket: SpendTicket, use: TicketUse) => void;
  client?: () => Anthropic;
}

export function claudeReviewProvider(model: string, opts: ClaudeReviewOptions): MissionProvider {
  const client = () => {
    if (opts.client) return opts.client();
    if (!anthropicKeyConfigured()) throw new ProviderError("No Anthropic key is configured, so Claude review is unavailable.", "auth", "no");
    return new Anthropic({ maxRetries: 0, timeout: REVIEW_TIMEOUT_MS });
  };
  const format = (req: ModelRequest) => (req.outputSchema ? { format: { type: "json_schema" as const, schema: req.outputSchema } } : undefined);
  return {
    provider: "anthropic",
    model,
    kind: "real",
    thinkingLevel: null,
    async countInputTokens(req, ticket, signal) {
      opts.redeem(ticket, { use: "count", provider: "anthropic", model, kind: "real", request: req });
      try {
        const res = await client().messages.countTokens(
          { model, system: req.system, messages: messagesOf(req), thinking: { type: "adaptive" }, output_config: format(req) },
          { signal, maxRetries: 0 },
        );
        if (!Number.isFinite(res.input_tokens) || res.input_tokens <= 0) throw new ProviderError("Anthropic's token counter returned no count.", "other", "unknown");
        return { counted: res.input_tokens, uncounted: 0 };
      } catch (e) {
        throw e instanceof ProviderError ? e : claudeFailure(e, signal.aborted);
      }
    },
    async respond(req, ticket, signal): Promise<ModelReply> {
      opts.redeem(ticket, { use: "send", provider: "anthropic", model, kind: "real", request: req });
      try {
        const res = await client().messages.create(
          {
            model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: messagesOf(req),
            thinking: { type: "adaptive" },
            output_config: format(req),
          },
          { signal, maxRetries: 0, timeout: REVIEW_TIMEOUT_MS },
        );
        const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        const status: ModelReply["status"] = res.stop_reason === "end_turn" ? "completed" : res.stop_reason === "max_tokens" ? "incomplete" : "failed";
        return {
          status,
          text,
          toolCalls: [],
          modelSteps: [{ type: "text", text }],
          usage: claudeUsage(res.usage),
          model,
          id: res.id,
          detail: status === "completed" ? undefined : `Stop reason: ${res.stop_reason ?? "unknown"}`,
          usageReported: Boolean(res.usage && (res.usage.input_tokens > 0 || res.usage.output_tokens > 0)),
        };
      } catch (e) {
        throw e instanceof ProviderError ? e : claudeFailure(e, signal.aborted);
      }
    },
  };
}
