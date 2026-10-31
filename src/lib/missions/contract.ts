import type { ModelReply, ModelRequest, TokenUsage } from "../ai/types";

// The Milestone 2B contract between the mission system (the implementation agent: src/lib/missions, providers, sources and the window)
// and its controls (the security reviewer: src/lib/controls, authority, approvals, spending and the ledger). Both sides code
// against these types only; changing one needs both owners (docs/m2b/PLAN.md). Money is integer micro-dollars.

export const MICROS_PER_USD = 1_000_000;
export const MISSION_CAP_MICROS = 2 * MICROS_PER_USD;
export const DAY_CAP_MICROS = 5 * MICROS_PER_USD;
export const MONTH_CAP_MICROS = 20 * MICROS_PER_USD;
/** Output tokens per request, thinking included. Google documents max_output_tokens as a hard cutoff for both. */
export const MISSION_OUTPUT_LIMIT = 20_000;
export const BOISE_TIME_ZONE = "America/Boise";
/**
 * Applied once, by the controls, to a provider's raw input count. Google counts an equivalent standard request, not
 * KELQOR's Interactions request (docs/m2b/AUTHORIZATION.md, Known risks 3).
 */
export const INPUT_MARGIN = { ratio: 1.15, tokens: 512 } as const;

export const MISSION_TYPES = ["company_research", "industry_research"] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export const PROTOCOLS: Record<MissionType, string> = {
  company_research: "company-research-v2.0",
  industry_research: "industry-research-v1.0",
};

export const MISSION_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "running",
  "verification",
  "completed",
  "completed_with_issues",
  "needs_review",
  "interrupted",
  "budget_blocked",
  "rejected",
  "failed",
  "cancelled",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** Nothing runs again from these. */
export const FINAL_MISSION_STATUSES: readonly MissionStatus[] = ["completed", "completed_with_issues", "rejected", "failed", "cancelled"];
/** The states in which a mission's run may write to it. */
export const SENDING_STATUSES: readonly MissionStatus[] = ["running", "verification"];

export const PROVIDERS = ["google", "anthropic", "simulation", "synthetic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type MissionSubject =
  | { kind: "company"; recordId: string | null; name: string; website: string; town: string; state: string; industry: string | null }
  | { kind: "industry"; industry: string; category: string | null; region: string | null };

/** Claude review of a finished report. "simulation" is the $0 reviewer of simulated missions; "synthetic" is test-only. */
export interface ReviewChoice {
  provider: "anthropic" | "simulation" | "synthetic";
  model: string;
  maxCostMicros: number;
}

/** Everything a mission approval binds, apart from the approving account. Any change voids the approval. */
export interface MissionScope {
  type: MissionType;
  subject: MissionSubject;
  protocol: string;
  provider: ProviderId;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  /** The research's own maximum; review, when chosen, adds its own maximum. Together at most MISSION_CAP_MICROS. */
  maxCostMicros: number;
  review: ReviewChoice | null;
  simulated: boolean;
}

export const APPROVAL_KINDS = ["mission", "review"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface ApprovalView {
  id: string;
  missionId: string;
  kind: ApprovalKind;
  scopeFingerprint: string;
  maxCostMicros: number;
  review: ReviewChoice | null;
  approvedBy: { id: string; name: string };
  approvedAt: string;
  expiresAt: string;
  boiseDay: string;
  state: "active" | "expired" | "void";
  voidReason: string | null;
}

export interface FounderAuthority {
  userId: string;
  name: string;
  email: string;
  since: string;
}

// ---- The paid-request pathway -------------------------------------------------------------------------------

declare const ticketBrand: unique symbol;

export type ProviderKind = "real" | "simulated" | "synthetic";

/**
 * Issued by the controls' meteredRequest for exactly one call: a token count ("count", after the pre-check) or the
 * reserved request itself ("send"). A provider redeems it (controls.redeemTicket) before it calls anything; the
 * controls keep each live ticket in a private map, bound to its use, provider, model, kind and request, single use.
 */
export interface SpendTicket {
  readonly [ticketBrand]: true;
  readonly use: "count" | "send";
  readonly reservationId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly kind: ProviderKind;
  readonly maxOutputTokens: number;
}

/** What a provider states when it redeems a ticket; real adapters pass the literal kind "real". */
export interface TicketUse {
  use: "count" | "send";
  provider: ProviderId;
  model: string;
  kind: ProviderKind;
  request: ModelRequest;
}

/** A model behind the mission pathway. "simulated" and "synthetic" never reach a real provider. */
export interface MissionProvider {
  readonly provider: ProviderId;
  readonly model: string;
  readonly kind: ProviderKind;
  /** The approved thinking level it sends; null for providers without one. */
  readonly thinkingLevel: ThinkingLevel | null;
  /**
   * The provider's own raw count of the request's input (counted), plus the adapter's estimate of input its counter
   * can't see (uncounted), such as a response schema. Throws when nothing can be counted.
   */
  countInputTokens(request: ModelRequest, ticket: SpendTicket, signal: AbortSignal): Promise<{ counted: number; uncounted: number }>;
  respond(request: ModelRequest, ticket: SpendTicket, signal: AbortSignal): Promise<ModelReply>;
}

/** Thrown by redeemTicket: a forged, reused, expired or mismatched ticket. Nothing was sent. */
export class TicketRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketRefused";
  }
}

export const PROVIDER_FAILURE_KINDS = ["invalid_request", "auth", "not_found", "rate_limit", "server", "timeout", "network", "cancelled", "other"] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

/**
 * What a provider adapter throws. `sent` says whether the request may have reached the provider: "no" only when
 * the adapter knows it never left (refused connection, missing key), "unknown" whenever it can't tell.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
    readonly sent: "no" | "yes" | "unknown",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const REQUEST_PURPOSES = ["research", "repair", "retry", "review"] as const;
export type RequestPurpose = (typeof REQUEST_PURPOSES)[number];

export interface MeteredContext {
  missionId: string;
  /** The run that owns the mission (missions.run_id); a request from any other run is refused. */
  runId: string;
  /** The mission step this request belongs to (mission_steps.id). */
  stepId: string;
  /** 1 for the first try of a step, 2 and 3 for its retries. */
  attempt: number;
  purpose: RequestPurpose;
  /** Honored on test databases only. */
  now?: () => Date;
}

/** The mission state in which each purpose may be sent: research while Running, review while in Verification. */
export const PAID_STATUS: Record<RequestPurpose, MissionStatus> = { research: "running", repair: "running", retry: "running", review: "verification" };

export interface MeteredReply {
  reply: ModelReply;
  ledgerId: string;
  countedInputTokens: number;
  reservedInputTokens: number;
  reservedMicros: number;
  actualMicros: number;
}

export const SPEND_REFUSALS = [
  "no_approval",
  "approval_expired",
  "scope_changed",
  "no_authority",
  "mission_not_running",
  "unpriced_model",
  "count_failed",
  "count_rejected",
  "approval_cap",
  "mission_cap",
  "day_cap",
  "month_cap",
  "provider_blocked",
  "cap_unconfirmed",
  "provider_mismatch",
  "output_limit",
  "attempt_limit",
  "stale_run",
  "input_too_large",
  "test_only",
] as const;
export type SpendRefusalReason = (typeof SPEND_REFUSALS)[number];

/** Thrown before anything is sent; nothing was reserved or the reservation was never used. */
export class SpendRefused extends Error {
  constructor(
    readonly reason: SpendRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "SpendRefused";
  }
}

/** Thrown after a request was attempted. The ledger entry already records what it counts as. */
export class ProviderFailure extends Error {
  constructor(
    readonly ledgerId: string,
    readonly outcome: "not_billed" | "unverified",
    readonly failure: ProviderError,
  ) {
    super(failure.message);
    this.name = "ProviderFailure";
  }
}

/** Thrown after settlement when a reply looks like it carries a credential; the request is recorded, the reply dropped. */
export class UnsafeReply extends Error {
  constructor(readonly ledgerId: string) {
    super("A response contained something that looks like a credential, so it was discarded.");
    this.name = "UnsafeReply";
  }
}

/**
 * How the runner turns a refusal into a mission state (docs/m2b/AUTHORIZATION.md, Spending controls). "none" means
 * the run no longer owns the mission and must stop without writing. A review that can't be sent leaves the research
 * in Needs review.
 */
export function stateForRefusal(
  reason: SpendRefusalReason,
  purpose: RequestPurpose,
): "budget_blocked" | "interrupted" | "failed" | "retry" | "needs_review" | "none" {
  if (reason === "mission_not_running" || reason === "stale_run") return "none";
  if (purpose === "review") return "needs_review";
  if (reason === "approval_cap" || reason === "mission_cap" || reason === "day_cap" || reason === "month_cap") return "budget_blocked";
  if (reason === "count_failed") return "retry";
  // A count the provider or its SDK refused outright fails the same way every time: no retries.
  if (["count_rejected", "unpriced_model", "provider_mismatch", "output_limit", "attempt_limit", "input_too_large", "test_only"].includes(reason)) return "failed";
  return "interrupted";
}

// ---- The ledger and spending, as the window sees them ---------------------------------------------------------

export const LEDGER_STATUSES = ["reserved", "settled", "not_billed", "unverified"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
export const LEDGER_PURPOSES = [...REQUEST_PURPOSES, "count", "adjustment"] as const;
export type LedgerPurpose = (typeof LEDGER_PURPOSES)[number];

export interface LedgerEntryView {
  id: string;
  seq: number;
  missionId: string | null;
  missionNumber: number | null;
  approvalId: string | null;
  attempt: number;
  purpose: LedgerPurpose;
  provider: ProviderId;
  model: string;
  priceVersion: string;
  sentAt: string;
  boiseDay: string;
  boiseMonth: string;
  countedInputTokens: number;
  reservedInputTokens: number;
  maxOutputTokens: number;
  reservedMicros: number;
  status: LedgerStatus;
  settledAt: string | null;
  usage: TokenUsage | null;
  actualMicros: number | null;
  /** What it counts against the caps now: settled cost, or the unverified amount left after releases. */
  committedMicros: number;
  releasedMicros: number;
  overReservation: boolean;
  providerRequestId: string | null;
  errorKind: string | null;
  errorDetail: string | null;
  simulated: boolean;
  synthetic: boolean;
}

export interface PeriodSpend {
  period: string;
  capMicros: number;
  settledMicros: number;
  unverifiedMicros: number;
  reservedMicros: number;
  committedMicros: number;
  remainingMicros: number;
}

export interface SpendingSummary {
  at: string;
  day: PeriodSpend;
  month: PeriodSpend;
  /** Providers stopped after a reported cost above its reservation, until the owner reviews it. */
  blockedProviders: ProviderId[];
}

export interface MissionSpend {
  missionId: string;
  capMicros: number;
  /** The sum of the mission's approved maximums (research, plus review when approved). */
  approvedMicros: number;
  settledMicros: number;
  unverifiedMicros: number;
  reservedMicros: number;
  committedMicros: number;
  remainingMicros: number;
}

// ---- Mission steps, sources and evidence (owned by the mission system, tested by both) --------------------------

export const MISSION_STEP_KINDS = ["action", "state", "model_request", "page_read", "count", "check", "review", "error", "note"] as const;
export type MissionStepKind = (typeof MISSION_STEP_KINDS)[number];

export const SOURCE_KINDS = ["government agency", "trade association", "regulator", "technical resource", "industry publication"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_STATUSES = ["proposed", "approved", "rejected", "retired"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * Evidence categories for new research. AI may assign only the first four; checks and review only move a claim
 * down to "unsupported". The last three exist only in discovery records the owner makes.
 */
export const EVIDENCE_CATEGORIES = [
  "verified_fact",
  "observed_defect",
  "supported_inference",
  "industry_hypothesis",
  "unsupported",
  "customer_confirmed",
  "customer_reported_estimate",
  "validated_impact",
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];
export const AI_CATEGORIES = ["verified_fact", "observed_defect", "supported_inference", "industry_hypothesis"] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];
