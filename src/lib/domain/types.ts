export const ROLES = ["client", "builder", "operator"] as const;
export type Role = (typeof ROLES)[number];

export const BUILDER_STATUSES = ["applied", "approved", "rejected", "paused"] as const;
export type BuilderStatus = (typeof BUILDER_STATUSES)[number];

export const WORK_ORDER_STATUSES = [
  "submitted",
  "quoted",
  "accepted",
  "funded",
  "in_progress",
  "delivered",
  "completed",
  "cancelled",
  "disputed",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly WorkOrderStatus[] = ["completed", "cancelled"];

export type ScopeSource = "ai" | "template" | "operator";
export type CriterionStatus = "pending" | "met" | "not_met";
export type MilestoneStatus = "planned" | "done";
export type AssignmentStatus = "invited" | "accepted" | "declined" | "withdrawn";
export type DeliveryDecision = "pending" | "accepted" | "revision_requested";
export type PaymentMethod = "stripe" | "offline" | "test";
export type PaymentStatus = "pending" | "succeeded" | "refunded" | "failed";
export type PayoutStatus = "pending" | "paid";
export type RecordVisibility = "public_named" | "public_anonymous" | "private";
export type CarePlanStatus = "requested" | "active" | "cancelled";
export type Complexity = "small" | "medium" | "large";

/** What the client told us, in their words. */
export interface Intake {
  problem: string;
  currentTools: string;
  desiredOutcome: string;
  volume: string;
  deadline: string;
  budgetBand: string;
  templateSlug: string | null;
}

/** The structured scope a Work Order is priced and accepted against. */
export interface Scope {
  summary: string;
  objectives: string[];
  inScope: string[];
  outOfScope: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  milestones: { title: string; description: string }[];
  assumptions: string[];
  clientResponsibilities: string[];
  risks: string[];
  estimateHoursLow: number;
  estimateHoursHigh: number;
  complexity: Complexity;
  recommendedSkills: string[];
  clarifyingQuestions: string[];
}

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  submitted: "Scoping",
  quoted: "Quote ready",
  accepted: "Awaiting payment",
  funded: "Funded",
  in_progress: "In progress",
  delivered: "In review",
  completed: "Completed",
  cancelled: "Cancelled",
  disputed: "Disputed",
};

export const BUILDER_STATUS_LABELS: Record<BuilderStatus, string> = {
  applied: "Application in review",
  approved: "Approved",
  rejected: "Not approved",
  paused: "Paused",
};

export const BUDGET_BANDS = [
  "Under $2,500",
  "$2,500 – $5,000",
  "$5,000 – $10,000",
  "$10,000 – $25,000",
  "Not sure yet",
] as const;

/** Version of the Work Order terms a client accepts. Bump when the terms text changes. */
export const TERMS_VERSION = "draft-2026-10-26";

/** The owner's call on a researched company. Internal sales research: never shown to clients, and never permission to contact. */
export const OPPORTUNITY_DECISIONS = ["qualified", "hold", "rejected"] as const;
export type OpportunityDecision = (typeof OPPORTUNITY_DECISIONS)[number];

export const OPPORTUNITY_DECISION_LABELS: Record<OpportunityDecision, string> = {
  qualified: "Qualified",
  hold: "Hold",
  rejected: "Rejected",
};

/**
 * Every company is explicitly real, demo or test (orgs.data_class). "demo" is the seeded demonstration data; "test" is
 * a record an operator made to try the product. Only real companies count as business, and only their real money as
 * revenue (src/lib/domain/classification.ts).
 */
export const DATA_CLASSES = ["real", "demo", "test"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_LABELS: Record<DataClass, string> = {
  real: "Real customer",
  demo: "Demo data",
  test: "Test record",
};

/** Whether the person in a discovery call can decide on a purchase. */
export const DECISION_MAKER_ANSWERS = ["yes", "no", "unknown"] as const;
export type DecisionMakerAnswer = (typeof DECISION_MAKER_ANSWERS)[number];

/** A predicted or reported problem, as the customer described it in a discovery call. */
export const PROBLEM_STATUSES = ["confirmed", "not_a_problem"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/** The simplest kind of solution that solves a confirmed problem, from cheapest to most involved. */
export const SOLUTION_RUNGS = ["existing_feature", "configuration", "integration", "managed_ai"] as const;
export type SolutionRung = (typeof SOLUTION_RUNGS)[number];

export const SOLUTION_RUNG_LABELS: Record<SolutionRung, string> = {
  existing_feature: "A feature they already own",
  configuration: "A configuration change or simple fix",
  integration: "An integration between their tools",
  managed_ai: "A managed AI agent we operate",
};
