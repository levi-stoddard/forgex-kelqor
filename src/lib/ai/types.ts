// Provider-neutral types for ForgeX's model calls. Research code depends on these, never on a vendor SDK,
// so changing providers means adding one adapter in this folder.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
}

/** One entry of the conversation, resent in full on every stateless request. */
export type Turn =
  | { kind: "user"; text: string }
  /** The model's own steps exactly as returned: Gemini needs its thought signatures back. */
  | { kind: "model"; steps: unknown[] }
  | { kind: "tool_results"; results: ToolResult[] };

export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  thinking: number;
  toolUse: number;
  total: number;
  /** Input written to a prompt cache, which some providers bill above the input price (missions only). */
  cacheWriteInput?: number;
}

export interface ModelRequest {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  /** "none" forces a final answer, for example once the page limit is reached. */
  toolChoice: "auto" | "none";
  /** JSON Schema the final answer must follow. */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface ModelReply {
  /** "tool_calls" means the model wants tool results before it answers. */
  status: "completed" | "tool_calls" | "incomplete" | "failed";
  text: string;
  toolCalls: ToolCall[];
  /** The model's new steps, to append to the conversation unchanged. */
  modelSteps: unknown[];
  usage: TokenUsage;
  model: string;
  id?: string;
  detail?: string;
  /** False when the response carried no usage, so its cost can't be settled (mission adapters set it). */
  usageReported?: boolean;
}

export interface ResearchModel {
  readonly provider: string;
  readonly model: string;
  respond(request: ModelRequest): Promise<ModelReply>;
}
