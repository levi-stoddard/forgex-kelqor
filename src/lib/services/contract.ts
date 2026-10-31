import type { ServiceCategory, ServiceConfig } from "./catalog";
import type { Deliverable, ProcessingResult } from "./processors";

// Milestone 4: what the customer portal, the operator Command Center and the tests share about managed services.

/**
 * A request's life: received → processing → in_review (KELQOR) → awaiting_customer (when the service's rule asks for
 * the customer's approval) → completed. KELQOR can send it back to the customer with questions (needs_info) or fail
 * it; the customer can approve it or ask for changes (back to in_review), or decline it.
 */
export const SERVICE_REQUEST_STATUSES = ["received", "processing", "in_review", "needs_info", "awaiting_customer", "completed", "declined", "failed"] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export interface CustomerServiceView {
  id: string;
  orgId: string;
  category: ServiceCategory;
  categoryName: string;
  name: string;
  status: "draft" | "active" | "paused" | "ended";
  planKey: string;
  monthlyCents: number;
  includedRequests: number;
  overageCents: number;
  setupCents: number;
  agreementStartedAt: string | null;
  config: ServiceConfig;
  promise: string;
  deliverable: string;
}

/** What a customer sees of a request: never KELQOR's internal draft, notes or costs until the result is released. */
export interface CustomerRequestView {
  id: string;
  number: number;
  label: string;
  serviceId: string;
  serviceName: string;
  title: string;
  status: ServiceRequestStatus;
  statusLabel: string;
  submittedAt: string;
  completedAt: string | null;
  input: { text: string; from: string | null };
  /** Shown to the customer when it is theirs to approve, and once complete. */
  result: Deliverable | null;
  questions: string[];
  needsCustomerApproval: boolean;
  simulated: boolean;
  history: { at: string; summary: string }[];
  allowed: { approve: boolean; requestChanges: boolean; decline: boolean; answer: boolean };
}

/** What KELQOR's operators see, on top of the customer's view. */
export interface OperatorRequestView extends Omit<CustomerRequestView, "allowed"> {
  orgId: string;
  orgName: string;
  processing: ProcessingResult | null;
  draft: Deliverable | null;
  draftHash: string | null;
  reviewNote: string | null;
  reviewMinutes: number | null;
  reviewedBy: string | null;
  customerNote: string | null;
  aiCostMicros: number;
  costSource: "simulated" | "ledger" | "unknown";
  stateReason: string | null;
  overdue: boolean;
  events: { at: string; kind: string; summary: string; actor: string | null; customerVisible: boolean }[];
  allowed: { process: boolean; review: boolean; askCustomer: boolean; fail: boolean };
}

export const REQUEST_LABEL = (n: number) => `R-${String(n).padStart(4, "0")}`;
export const INVOICE_LABEL = (n: number) => `INV-${String(n).padStart(4, "0")}`;

export const STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  received: "Received",
  processing: "Being processed",
  in_review: "KELQOR is reviewing",
  needs_info: "Needs your information",
  awaiting_customer: "Waiting for your approval",
  completed: "Completed",
  declined: "Declined",
  failed: "Couldn't be completed",
};

export interface InvoiceView {
  id: string;
  number: number;
  label: string;
  orgId: string;
  period: string;
  status: "draft" | "issued" | "paid" | "void";
  simulated: true;
  totalCents: number;
  issuedAt: string | null;
  paidAt: string | null;
  lines: { description: string; kind: string; quantity: number; unitCents: number; amountCents: number }[];
}

export interface CustomerReport {
  orgId: string;
  orgName: string;
  period: string;
  services: { id: string; name: string; status: string; requests: number; completed: number; included: number; overage: number }[];
  requestsReceived: number;
  requestsCompleted: number;
  /** Median hours from request to result, among those completed in the period. */
  medianTurnaroundHours: number | null;
  withinCommitment: { met: number; total: number };
  /** Total value of the quotes delivered, where the service produces quotes. */
  quotedValueCents: number;
  questionsRaised: number;
  approvalsGiven: number;
  invoiceTotalCents: number | null;
  simulated: boolean;
}

export interface CustomerCosts {
  orgId: string;
  orgName: string;
  period: string;
  revenueCents: number;
  aiCostMicros: number;
  aiCostSource: "simulated" | "ledger" | "mixed" | "none";
  reviewMinutes: number;
  reviewCostCents: number;
  marginCents: number;
  /** True while any figure is simulated or assumed (the labor rate is an assumption until the owner sets it). */
  estimated: boolean;
}
