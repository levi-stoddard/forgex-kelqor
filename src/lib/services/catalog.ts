// Milestone 4: the managed-AI service catalog. Categories and plans are configuration, not code per customer: each
// customer service is one of these categories with its own settings (src/lib/services/service.ts). A category names
// work KELQOR can do; it says nothing about whether a customer has confirmed a need for it.

export const SERVICE_CATEGORIES = ["quote_intake", "document_processing", "business_reporting", "workflow_coordination", "support_assistance", "industry_workflow"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface RateCard {
  /** Labor, per hour, in cents. */
  hourlyCents: number;
  /** Minimum charge for any job, in cents. */
  minimumCents: number;
  /** Named rates the quote can use, per unit, in cents (for example a water-jet hour or a powder-coat square foot). */
  items: { key: string; label: string; unit: string; cents: number }[];
  /** Hours assumed per job type when the inquiry doesn't say. */
  jobHours: Record<string, number>;
}

export interface ServiceConfig {
  /** A result worth more than this (in cents) needs the customer's approval before it is final: 0 = every result, null = none. */
  customerApprovalAboveCents: number | null;
  /** For quote intake: the customer's own rates. */
  rateCard?: RateCard;
  /** What every request must contain before KELQOR can finish it; missing items become questions. */
  requiredFields: string[];
  /** Words the customer's business uses for its work, for routing and the report. */
  jobTypes: string[];
  /** The response time KELQOR commits to for this service, in hours (for the report and operator alerts). */
  turnaroundHours: number;
}

export interface CategoryInfo {
  key: ServiceCategory;
  name: string;
  /** What it does, in the customer's terms. */
  promise: string;
  /** What the customer sees as the result. */
  deliverable: string;
  /** Whether KELQOR has a dedicated processor for it, or a generic simulated assistant until one is built. */
  processor: "quote_intake" | "generic";
  defaults: ServiceConfig;
}

export const CATEGORIES: Record<ServiceCategory, CategoryInfo> = {
  quote_intake: {
    key: "quote_intake",
    name: "Quote and inquiry intake",
    promise: "Every incoming quote request is read, organized and priced from your rates, with the missing details listed, so you can reply the same day.",
    deliverable: "A priced draft quote, the questions to ask the customer, and a reply you can send",
    processor: "quote_intake",
    defaults: {
      customerApprovalAboveCents: 250_000,
      requiredFields: ["contact", "jobType", "quantity", "material", "deadline"],
      jobTypes: ["fabrication", "welding", "machining", "water jet", "powder coating", "repair", "installation"],
      turnaroundHours: 8,
      rateCard: {
        hourlyCents: 9_500,
        minimumCents: 15_000,
        items: [
          { key: "waterjet_hour", label: "Water-jet cutting", unit: "hour", cents: 18_000 },
          { key: "machining_hour", label: "CNC machining", unit: "hour", cents: 12_500 },
          { key: "powder_coat_sqft", label: "Powder coating", unit: "sq ft", cents: 450 },
        ],
        jobHours: { fabrication: 6, welding: 4, machining: 5, "water jet": 2, "powder coating": 3, repair: 3, installation: 5 },
      },
    },
  },
  document_processing: {
    key: "document_processing",
    name: "Document processing and administration",
    promise: "Incoming documents are read, the key facts pulled out and filed, and anything unusual flagged for you.",
    deliverable: "A structured summary of each document and the actions it needs",
    processor: "generic",
    defaults: { customerApprovalAboveCents: null, requiredFields: ["document"], jobTypes: [], turnaroundHours: 24 },
  },
  business_reporting: {
    key: "business_reporting",
    name: "Business intelligence and reporting",
    promise: "A regular report on what your business did and where it's heading, in plain words.",
    deliverable: "A written report with the figures behind it",
    processor: "generic",
    defaults: { customerApprovalAboveCents: null, requiredFields: ["period"], jobTypes: [], turnaroundHours: 48 },
  },
  workflow_coordination: {
    key: "workflow_coordination",
    name: "Operational workflow coordination",
    promise: "Jobs that move between people are tracked, chased and handed off, so nothing stalls.",
    deliverable: "A status summary and the next actions, by owner",
    processor: "generic",
    defaults: { customerApprovalAboveCents: null, requiredFields: ["job"], jobTypes: [], turnaroundHours: 8 },
  },
  support_assistance: {
    key: "support_assistance",
    name: "Customer support assistance",
    promise: "Customer questions get a drafted answer from your own policies, ready for you to send.",
    deliverable: "A draft reply and the policy it relies on",
    processor: "generic",
    defaults: { customerApprovalAboveCents: null, requiredFields: ["question"], jobTypes: [], turnaroundHours: 4 },
  },
  industry_workflow: {
    key: "industry_workflow",
    name: "Industry-specific workflow",
    promise: "A workflow built around how your trade actually works, configured with you.",
    deliverable: "The result the configured workflow defines",
    processor: "generic",
    defaults: { customerApprovalAboveCents: null, requiredFields: [], jobTypes: [], turnaroundHours: 24 },
  },
};

export interface Plan {
  key: string;
  name: string;
  monthlyCents: number;
  /** Requests included each month; more are charged at `overageCents` each. */
  includedRequests: number;
  overageCents: number;
  setupCents: number;
}

/** Plans are starting points: an agreement copies the terms when it starts, so a later price change never alters it. */
export const PLANS: Plan[] = [
  { key: "starter", name: "Starter", monthlyCents: 49_900, includedRequests: 40, overageCents: 1_500, setupCents: 0 },
  { key: "growth", name: "Growth", monthlyCents: 99_900, includedRequests: 120, overageCents: 1_000, setupCents: 50_000 },
  { key: "pilot", name: "Pilot (30 days)", monthlyCents: 0, includedRequests: 25, overageCents: 0, setupCents: 0 },
];

export const planByKey = (key: string) => PLANS.find((p) => p.key === key) ?? null;

/** The labor rate used to cost operator review time, in cents per hour. An assumption until the owner sets it. */
export const REVIEW_LABOR_CENTS_PER_HOUR = 6_000;
