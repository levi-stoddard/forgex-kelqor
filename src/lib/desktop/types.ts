import type { ResearchVersionView } from "../missions/results";
// The contract between the KELQOR desktop app and the local backend's /api/desktop routes. The desktop imports
// these as types only; every value comes from the backend's domain services.

import type { CallInput, ReadinessStage } from "../domain/discovery";
import type { OrderEconomics } from "../domain/pricing";
import type {
  CriterionStatus,
  DataClass,
  DecisionMakerAnswer,
  DeliveryDecision,
  OpportunityDecision,
  PaymentMethod,
  PaymentStatus,
  ProblemStatus,
  SolutionRung,
  WorkOrderStatus,
} from "../domain/types";
import type { DiscoveryQuestion } from "../playbooks";
import type { DossierDetail, DossierSummary, EvidenceItem, QualificationCategory } from "../research/dossiers";

export type { DossierClaim, DossierDetail, DossierSummary, EvidenceItem, EvidenceLevel, EvidenceStatus, QualificationCategory } from "../research/dossiers";
export type { DiscoveryQuestion } from "../playbooks";
export type { ReadinessStage } from "../domain/discovery";

/**
 * Records that aren't real business, from each company's explicit class (orgs.data_class): "demo" is seeded
 * demonstration data; "test" is a record made to try the product. The desktop app labels both and leaves them out of
 * every real total.
 */
export type Fixture = "demo" | "test" | null;

export interface DesktopUser {
  id: string;
  name: string;
  email: string;
  role: "operator";
}

export interface SessionGrant {
  token: string;
  expiresAt: string;
  user: DesktopUser;
}

export interface DecisionRecord {
  decision: OpportunityDecision;
  note: string;
  decidedAt: string;
  decidedBy: string;
}

export interface Readiness {
  stage: ReadinessStage;
  label: string;
  next: string;
}

export type { ResearchVersionView };

export interface OpportunitySummary extends DossierSummary {
  decision: DecisionRecord | null;
  /** The confirmed industry, or research's suggestion when none is confirmed. */
  industry: string | null;
  readiness: Readiness;
}

/** A fact the owner checked outside the saved research. */
export interface FounderCheck {
  id: string;
  statement: string;
  sourceUrl: string | null;
  checkedOn: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface DiscoveryCallRecord {
  id: string;
  heldOn: string;
  contactName: string;
  contactRole: string;
  decisionMaker: DecisionMakerAnswer;
  software: string;
  priorities: string;
  desiredOutcome: string;
  valueToThem: string;
  tried: string;
  pain: number | null;
  nextStep: string;
  notes: string;
  answers: { questionId: string; question: string; answer: string }[];
  recordedBy: string;
  createdAt: string;
}

/** A problem as the customer described it in a recorded call: raised by them, or a research finding they confirmed or dismissed. */
export interface CustomerFigure {
  id: string;
  callId: string;
  heldOn: string;
  statement: string;
  amountCents: number;
  period: string;
  basis: string;
  status: "customer_reported" | "validated";
  validatedCents: number | null;
  calculation: string | null;
  evidence: string | null;
  validatedAt: string | null;
  createdAt: string;
}

export interface FigureInput {
  callId: string;
  statement: string;
  amountCents: number;
  period: string;
  basis: string;
}

export interface FigureValidation {
  validatedCents: number;
  calculation: string;
  evidence: string;
}

export interface ProblemRecord {
  id: string;
  callId: string;
  heldOn: string;
  origin: "customer" | "research";
  findingKey: string | null;
  statement: string;
  status: ProblemStatus;
  solutionRung: SolutionRung | null;
  solution: string;
  /** The New Work Order page prefilled from this problem: only for a confirmed problem with a solution chosen. */
  workOrderPath: string | null;
}

/** The discovery-first workflow for one researched company (Milestone 2A). */
export interface OpportunityWorkflow {
  industry: { value: string | null; suggested: string | null; options: string[] };
  /** What Gemini's category was judged against; it says nothing about other industries. */
  researchFrame: string;
  evidence: EvidenceItem[];
  counts: { verified: number; defects: number; hypotheses: number; founderChecks: number; customerConfirmed: number; dismissed: number };
  checks: FounderCheck[];
  calls: DiscoveryCallRecord[];
  problems: ProblemRecord[];
  /** Financial figures the customer gave: estimates until you validate one with its calculation and evidence. */
  figures: CustomerFigure[];
  questions: DiscoveryQuestion[];
  readiness: Readiness;
  workOrder: { id: string; ref: string; status: WorkOrderStatus; webPath: string } | null;
}

export interface OpportunityDetail extends DossierDetail {
  decision: DecisionRecord | null;
  source: { id: string; label: string; dataset: string };
  /** True for the frozen benchmark dossier; false for a company first researched by a mission. */
  historical: boolean;
  /** Company research versions from completed real missions, newest first (Milestone 2B). */
  researchVersions: ResearchVersionView[];
  /** The New Work Order page with only the company's name and industry filled in. */
  salePath: string;
  workflow: OpportunityWorkflow;
}

export interface CheckInput {
  statement: string;
  sourceUrl: string;
  checkedOn: string;
  note: string;
}

/** A discovery call as the window sends it: findings by key only; their statements come from the saved research. */
export type CallInputDto = Omit<CallInput, "findings"> & { findings: { key: string; status: ProblemStatus }[] };

export interface OrderSummary {
  id: string;
  ref: string;
  title: string;
  status: WorkOrderStatus;
  orgName: string;
  priceCents: number | null;
  builderPayoutCents: number | null;
  createdAt: string;
  updatedAt: string;
  fixture: Fixture;
}

export interface OrderDetail {
  order: {
    id: string;
    ref: string;
    title: string;
    status: WorkOrderStatus;
    category: string;
    scopeSource: string;
    summary: string;
    deliverables: string[];
    priceCents: number | null;
    builderPayoutCents: number | null;
    carePriceCents: number | null;
    careIncluded: boolean;
    revisionCount: number;
    createdAt: string;
    quoteSentAt: string | null;
    acceptedAt: string | null;
    fundedAt: string | null;
    deliveredAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    fixture: Fixture;
  };
  org: { name: string; industry: string | null; sizeBand: string | null };
  nextStep: string;
  criteria: { text: string; status: CriterionStatus; evidence: string; reviewNote: string }[];
  milestones: { title: string; status: string; completedAt: string | null }[];
  deliveries: { round: number; summary: string; decision: DeliveryDecision; decisionNote: string; decidedAt: string | null; createdAt: string }[];
  payments: { amountCents: number; method: PaymentMethod; status: PaymentStatus; createdAt: string; succeededAt: string | null; refundedAt: string | null }[];
  payout: { amountCents: number; status: string; paidAt: string | null } | null;
  carePlan: { status: string; monthlyPriceCents: number; activatedAt: string | null } | null;
  economics: OrderEconomics | null;
  assignedBuilder: string | null;
  contacts: { name: string; email: string; activated: boolean }[];
  timeline: { type: string; createdAt: string; actorName: string | null }[];
  messageCount: number;
  webPath: string;
}

export interface CompanySummary {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  sizeBand: string | null;
  /** The company's explicit class; an operator can correct it from the Business Workspace. */
  dataClass: DataClass;
  fixture: Fixture;
  createdAt: string;
  contacts: { name: string; email: string; activated: boolean }[];
  orders: number;
  openOrders: number;
}

export interface FounderItem {
  kind: "opportunity" | "quote" | "dispute" | "payment" | "payout" | "builder" | "care";
  title: string;
  detail: string;
  /** In-app view for opportunities; a web app path for established workflows. */
  opportunityId?: string;
  webPath?: string;
  fixture: Fixture;
}

export interface FounderQueue {
  items: FounderItem[];
  spendingApprovals: { stage: string; capUsd: number; approvedOn: string; models: string[]; spentUsd: number }[];
}

export interface Overview {
  opportunities: {
    total: number;
    byCategory: Record<QualificationCategory | "none", number>;
    byDecision: Record<OpportunityDecision | "undecided", number>;
  };
  /** Real counts leave out fixtures (demo and test records); byStatus counts real orders only. */
  orders: { real: number; fixtures: number; openReal: number; openFixtures: number; byStatus: Record<WorkOrderStatus, number> };
  companies: { real: number; fixtures: number };
  /** Real money only, with test money (TEST payments, Stripe test mode, demo and test companies) and unverified money apart. */
  money: { collectedCents: number; mrrCents: number; testCollectedCents: number; testMrrCents: number; unverifiedCents: number };
  ai: { researchSpendUsd: number; scopingCostUsd: number };
  founderItems: number;
}

export interface ResearchStage {
  stage: string;
  capUsd: number;
  approvedOn: string;
  models: string[];
  spentUsd: number;
  requests: number;
  byModel: { model: string; requests: number; costUsd: number }[];
  runs: { startedAt: string; finishedAt: string; promptVersion: string; repeat: number; companies: number; stopReason: string | null }[];
}

export interface AiOperations {
  research: { stages: ResearchStage[]; primaryModel: string; recordsShown: number };
  providers: { gemini: boolean; anthropic: boolean };
  scoping: { authorized: boolean; ai: number; template: number; operator: number; aiCostUsd: number; demoIncluded: boolean };
  /** Committed capabilities that aren't built yet, each with its roadmap milestone (docs/ROADMAP.md). */
  notAvailable: { name: string; note: string; milestone: string }[];
}
