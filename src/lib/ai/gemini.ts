import { GoogleGenAI } from "@google/genai";
import { ProviderError, type MissionProvider, type SpendTicket, type ThinkingLevel, type TicketUse } from "../missions/contract";
import type { ModelReply, ModelRequest, ResearchModel, TokenUsage, ToolCall, Turn } from "./types";

// Gemini through the Interactions API, stateless: store=false on every request, so Google keeps no stored
// conversation, and the full history (including the model's thought signatures) is resent each turn.

function readKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set. Put the ForgeX key in .env.local yourself; never in chat.");
  return key;
}

/** Remove the API key from any text before it is printed or stored. */
export function redactKey(text: string): string {
  const key = process.env.GEMINI_API_KEY;
  return key ? text.split(key).join("[redacted key]") : text;
}

export function geminiClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: readKey(), httpOptions: { timeout: 300_000 } });
}

/** Free: lists the models the key's project can call. Makes no generation request. */
export async function listGeminiModels(client: GoogleGenAI = geminiClient()): Promise<string[]> {
  const names: string[] = [];
  for await (const m of await client.models.list()) {
    if (m.name) names.push(m.name.replace(/^models\//, ""));
  }
  return names.sort();
}

function toInput(turns: Turn[]): unknown[] {
  const steps: unknown[] = [];
  for (const t of turns) {
    if (t.kind === "user") steps.push({ type: "user_input", content: [{ type: "text", text: t.text }] });
    else if (t.kind === "model") steps.push(...t.steps);
    else
      for (const r of t.results)
        steps.push({
          type: "function_result",
          call_id: r.callId,
          name: r.name,
          result: [{ type: "text", text: r.output }],
          is_error: r.isError ?? false,
        });
  }
  return steps;
}

interface RawUsage {
  total_input_tokens?: number;
  total_cached_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
}

export function usageOf(u: RawUsage | undefined): TokenUsage {
  return {
    input: u?.total_input_tokens ?? 0,
    cachedInput: u?.total_cached_tokens ?? 0,
    output: u?.total_output_tokens ?? 0,
    thinking: u?.total_thought_tokens ?? 0,
    toolUse: u?.total_tool_use_tokens ?? 0,
    total: u?.total_tokens ?? 0,
  };
}

interface RawStep {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: { type?: string; text?: string }[];
  signature?: string;
  summary?: { type?: string; text?: string }[];
}

/** Turn an Interactions API response into a provider-neutral reply. Exported for tests. */
export function replyFromInteraction(
  interaction: { id?: string; status?: string; steps?: unknown[]; usage?: RawUsage; output_text?: string },
  model: string,
): ModelReply {
  const steps = (interaction.steps ?? []) as RawStep[];
  const toolCalls: ToolCall[] = steps
    .filter((s) => s.type === "function_call")
    .map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? ""), args: s.arguments ?? {} }));
  const outputs = steps.filter((s) => s.type === "model_output");
  const lastText = (outputs.at(-1)?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const text = interaction.output_text ?? lastText;
  const raw = interaction.status ?? "";
  const status: ModelReply["status"] =
    toolCalls.length > 0 && (raw === "requires_action" || raw === "completed" || raw === "")
      ? "tool_calls"
      : raw === "completed"
        ? "completed"
        : raw === "incomplete"
          ? "incomplete"
          : "failed";
  return {
    status,
    text,
    toolCalls,
    modelSteps: steps,
    usage: usageOf(interaction.usage),
    model,
    id: interaction.id,
    detail: status === "failed" ? `Interaction status: ${raw || "unknown"}` : undefined,
  };
}

export function geminiModel(model: string, client: GoogleGenAI = geminiClient()): ResearchModel {
  return {
    provider: "google",
    model,
    async respond(req: ModelRequest): Promise<ModelReply> {
      const tools = req.tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      // A request without tools (a restricted-access run) sends neither tools nor a tool choice.
      const interaction = await client.interactions.create({
        model,
        store: false,
        system_instruction: req.system,
        input: toInput(req.turns) as never,
        tools: tools.length ? tools : undefined,
        response_format: req.outputSchema
          ? { type: "text", mime_type: "application/json", schema: req.outputSchema }
          : undefined,
        generation_config: tools.length
          ? { max_output_tokens: req.maxOutputTokens, tool_choice: req.toolChoice }
          : { max_output_tokens: req.maxOutputTokens },
      });
      return replyFromInteraction(interaction as never, model);
    },
  };
}

// ---- Milestone 2B: the mission adapter --------------------------------------------------------------------------
// Missions reach Gemini only through the controls' metered pathway: every request is counted, reserved in the
// ledger and carries a single-use ticket. The SDK's own retries are switched off, because each automatic retry would
// be a request the ledger never reserved. The benchmark's geminiModel above is unchanged.

const MISSION_TIMEOUT_MS = 300_000;

/** The Interactions conversation as a standard generateContent request, for Google's token counter. */
/** `displaced` collects any signature no part could carry (a part holds one), so it can be estimated rather than lost. */
export function countingContents(turns: Turn[], displaced: string[] = []): unknown[] {
  const contents: { role: "user" | "model"; parts: unknown[] }[] = [];
  for (const t of turns) {
    if (t.kind === "user") contents.push({ role: "user", parts: [{ text: t.text }] });
    else if (t.kind === "tool_results")
      contents.push({ role: "user", parts: t.results.map((r) => ({ functionResponse: { id: r.callId, name: r.name, response: { result: r.output } } })) });
    else contents.push(...modelContent(t.steps as RawStep[], displaced));
  }
  return contents;
}

const textOf = (items: { type?: string; text?: string }[] | undefined) =>
  (items ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

/**
 * One model turn's Interactions steps as generateContent parts, in order. Gemini returns a thought's signature as its
 * own step, before the function call it belongs to; generateContent carries it on that call's part as
 * thoughtSignature and refuses a function call without one (M-0003). So each signature moves, unchanged, onto the
 * next call or text part of the same turn. Nothing is invented or removed: a call that came without a signature is
 * counted without one, and Google's refusal then fails the mission once at $0.
 */
function modelContent(steps: RawStep[], displaced: string[]): { role: "model"; parts: Record<string, unknown>[] }[] {
  const parts: Record<string, unknown>[] = [];
  let pending: string | undefined;
  // A signature that can't go where it belongs stays with the part before it, or, when that part has one already
  // (or there is none), is set aside to be estimated.
  const keep = (signature: string) => {
    const last = parts.at(-1);
    if (last && last.thoughtSignature === undefined) last.thoughtSignature = signature;
    else if (last?.thoughtSignature !== signature) displaced.push(signature);
  };
  // A step's own signature (undeclared on function_call in SDK 2.28, but kept if Google sends one) wins over a
  // preceding thought's, which is then kept as above.
  const add = (part: Record<string, unknown>, own?: string) => {
    if (own && pending && pending !== own) keep(pending);
    const signature = own || pending;
    if (signature) part.thoughtSignature = signature;
    pending = undefined;
    parts.push(part);
  };
  for (const raw of steps) {
    if (raw.type === "thought") {
      // A new signature before any call: the earlier one is kept as above, never overwritten.
      if (raw.signature && pending) keep(pending);
      const summary = textOf(raw.summary);
      if (summary) parts.push({ text: summary, thought: true });
      if (raw.signature) pending = raw.signature;
    } else if (raw.type === "function_call") add({ functionCall: { id: raw.id, name: raw.name, args: raw.arguments ?? {} } }, raw.signature);
    else {
      const text = textOf(raw.content);
      if (text) add({ text }, raw.signature);
      else if (raw.signature) keep(raw.signature);
    }
  }
  // A signature with nothing after it stays with the turn's last part.
  if (pending) keep(pending);
  return parts.length ? [{ role: "model", parts }] : [];
}

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const COUNT_TIMEOUT_MS = 60_000;

/**
 * The whole input as Google's REST countTokens body. The SDK's countTokens can't be used: in Developer API mode it
 * throws before sending whenever a system instruction or tools are set (@google/genai 2.28, countTokensConfigToMldev),
 * and leaving them out would undercount. A generateContentRequest carries both, so they are counted.
 */
export function countingRequest(model: string, req: ModelRequest): { generateContentRequest: Record<string, unknown> } {
  const declared = req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  return {
    generateContentRequest: {
      model: `models/${model}`,
      contents: countingContents(req.turns),
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(declared.length ? { tools: [{ functionDeclarations: declared }] } : {}),
    },
  };
}

/** Posts a countTokens body and returns Google's JSON answer. Counting is free; it generates nothing. */
export type GeminiCounter = (model: string, body: { generateContentRequest: Record<string, unknown> }, signal: AbortSignal) => Promise<unknown>;

/** Google's REST counter. The key travels in the x-goog-api-key header, never in the URL. */
export function restCounter(fetchImpl: typeof fetch = fetch): GeminiCounter {
  return async (model, body, signal) => {
    let key: string;
    try {
      key = readKey();
    } catch (e) {
      throw new ProviderError(e instanceof Error ? e.message : String(e), "auth", "no");
    }
    const res = await fetchImpl(`${GEMINI_API}/models/${encodeURIComponent(model)}:countTokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(COUNT_TIMEOUT_MS)]),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Google's token counter answered HTTP ${res.status}: ${redactKey(text).slice(0, 300)}`), { status: res.status });
    return JSON.parse(text) as unknown;
  };
}

/** The SDK's own refusal of a parameter while building a request, before anything is sent. */
const SDK_LOCAL_REFUSAL = /parameter is (?:only )?supported in|is not supported in (?:the )?Gemini/i;

/** A provider-neutral failure for an SDK error, saying whether the request may have reached Google. */
export function geminiFailure(e: unknown, cancelled: boolean): ProviderError {
  const err = e as { statusCode?: unknown; status?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } };
  const status = typeof err?.statusCode === "number" ? err.statusCode : typeof err?.status === "number" ? err.status : undefined;
  const message = redactKey(typeof err?.message === "string" ? err.message : String(e)).slice(0, 500);
  if (cancelled) return new ProviderError(`Cancelled while the request was in flight: ${message}`, "cancelled", "unknown");
  if (status === 400 || status === 413 || status === 422) return new ProviderError(message, "invalid_request", "yes", status);
  if (status === 401 || status === 403) return new ProviderError(message, "auth", "yes", status);
  if (status === 404) return new ProviderError(message, "not_found", "yes", status);
  if (status === 429) return new ProviderError(message, "rate_limit", "yes", status);
  if (status !== undefined && status >= 500) return new ProviderError(message, "server", "yes", status);
  const name = typeof err?.name === "string" ? err.name : "";
  // Deterministic: the same request would be refused again, and it never left this computer.
  if (status === undefined && name === "Error" && SDK_LOCAL_REFUSAL.test(message)) return new ProviderError(message, "invalid_request", "no");
  if (/Timeout/i.test(name)) return new ProviderError(message, "timeout", "unknown");
  if (name === "InvalidRequestError") return new ProviderError(message, "invalid_request", "no");
  const code = typeof err?.cause?.code === "string" ? err.cause.code : "";
  if (/Connection/i.test(name)) {
    // Refused or unresolvable before anything was written; any other connection failure may have been mid-request.
    const before = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
    return new ProviderError(message, "network", before ? "no" : "unknown");
  }
  return new ProviderError(message, "other", "unknown", status);
}

export interface GeminiMissionOptions {
  thinkingLevel: ThinkingLevel;
  /** controls.redeemTicket: throws unless the ticket is live, unused and matches this use, provider, model and request. */
  redeem: (ticket: SpendTicket, use: TicketUse) => void;
  client?: () => GoogleGenAI;
  /** The token counter; Google's REST countTokens unless a test supplies one. */
  count?: GeminiCounter;
}

export function geminiMissionProvider(model: string, opts: GeminiMissionOptions): MissionProvider {
  const client = () => {
    try {
      return (opts.client ?? geminiClient)();
    } catch (e) {
      throw new ProviderError(redactKey(e instanceof Error ? e.message : String(e)), "auth", "no");
    }
  };
  const tools = (req: ModelRequest) => req.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));
  return {
    provider: "google",
    model,
    kind: "real",
    thinkingLevel: opts.thinkingLevel,
    async countInputTokens(req, ticket, signal) {
      opts.redeem(ticket, { use: "count", provider: "google", model, kind: "real", request: req });
      let total: unknown;
      try {
        const res = await (opts.count ?? restCounter())(model, countingRequest(model, req), signal);
        total = (res as { totalTokens?: unknown } | null)?.totalTokens;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw geminiFailure(e, signal.aborted);
      }
      if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) throw new ProviderError("Google's token counter returned no count.", "other", "unknown");
      // The output schema travels as response_format, which the standard counter doesn't see.
      // Thoughts, their signatures, calls and output are counted (modelContent). Any other earlier model step is resent
      // by toInput but has no generateContent equivalent, so it is estimated at chars÷3 like the schema.
      const COUNTED_STEPS = new Set(["function_call", "model_output", "thought"]);
      const unseen: unknown[] = req.turns.flatMap((t) => (t.kind === "model" ? (t.steps as RawStep[]).filter((s) => !COUNTED_STEPS.has(s.type ?? "")) : []));
      // A signature no counted part could carry is resent all the same, so it is estimated too.
      const displaced: string[] = [];
      countingContents(req.turns, displaced);
      unseen.push(...displaced);
      const estimate = (v: unknown) => Math.ceil(JSON.stringify(v).length / 3);
      return { counted: total, uncounted: (req.outputSchema ? estimate(req.outputSchema) : 0) + (unseen.length ? estimate(unseen) : 0) };
    },
    async respond(req, ticket, signal) {
      opts.redeem(ticket, { use: "send", provider: "google", model, kind: "real", request: req });
      const deadline = AbortSignal.timeout(MISSION_TIMEOUT_MS);
      const t = tools(req);
      try {
        const interaction = await client().interactions.create(
          {
            model,
            store: false,
            system_instruction: req.system,
            input: toInput(req.turns) as never,
            tools: t.length ? t : undefined,
            response_format: req.outputSchema ? { type: "text", mime_type: "application/json", schema: req.outputSchema } : undefined,
            generation_config: t.length
              ? { max_output_tokens: req.maxOutputTokens, thinking_level: opts.thinkingLevel, tool_choice: req.toolChoice }
              : { max_output_tokens: req.maxOutputTokens, thinking_level: opts.thinkingLevel },
          },
          { retries: { strategy: "none" }, fetchOptions: { signal: AbortSignal.any([signal, deadline]) } },
        );
        const u = (interaction as { usage?: RawUsage }).usage;
        // An empty or all-zero usage block isn't a report: the controls then hold the request as unverified.
        const reported = Boolean(u && ((u.total_tokens ?? 0) > 0 || (u.total_input_tokens ?? 0) > 0));
        return { ...replyFromInteraction(interaction as never, model), usageReported: reported };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw geminiFailure(e, signal.aborted);
      }
    },
  };
}
