import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { TokenUsage } from "../ai/types";
import type { ServiceCategory, ServiceConfig } from "../services/catalog";
import type { Deliverable, ProcessingResult } from "../services/processors";
import type { ServiceRequestStatus } from "../services/contract";
import type { ChangeState, EngAgentId, EngDeliverable, EngEventView, EngMissionSummary, EngPermissions, EngStatus } from "../engineering/contract";
import type {
  AssignmentStatus,
  BuilderStatus,
  CarePlanStatus,
  CriterionStatus,
  DataClass,
  DecisionMakerAnswer,
  DeliveryDecision,
  Intake,
  MilestoneStatus,
  OpportunityDecision,
  PaymentMethod,
  PaymentStatus,
  PayoutStatus,
  ProblemStatus,
  RecordVisibility,
  Role,
  Scope,
  ScopeSource,
  SolutionRung,
  WorkOrderStatus,
} from "../domain/types";
import type {
  ApprovalKind,
  LedgerPurpose,
  LedgerStatus,
  MissionStatus,
  MissionStepKind,
  MissionSubject,
  MissionType,
  ProviderId,
  ReviewChoice,
  SourceKind,
  SourceStatus,
  ThinkingLevel,
} from "../missions/contract";

// Money is stored as integer cents. Ids are random UUID strings generated in code.
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  website: text("website"),
  industry: text("industry"),
  sizeBand: text("size_band"),
  isDemo: boolean("is_demo").notNull().default(false),
  // Explicitly real, demo or test: only real companies count as business (src/lib/domain/classification.ts).
  dataClass: text("data_class").$type<DataClass>().notNull().default("real"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<Role>().notNull(),
    orgId: text("org_id").references(() => orgs.id),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    lastLoginAt: ts("last_login_at"),
    // Owner spending authority (Milestone 2B): granted only by `npm run designate-founder`, to one account at most,
    // and never to a demo account or a non-operator. Only that account approves, starts or resumes AI missions.
    spendingAuthorityAt: ts("spending_authority_at"),
    // Password sign-in is off for this account (migration 0004 turns it off for every demo account).
    signInDisabledAt: ts("sign_in_disabled_at"),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    uniqueIndex("users_one_spending_authority_idx").on(sql`(${t.spendingAuthorityAt} is not null)`).where(sql`${t.spendingAuthorityAt} is not null`),
    check(
      "users_spending_authority_check",
      sql`${t.spendingAuthorityAt} is null or (${t.role} = 'operator' and ${t.isDemo} = false and ${t.signInDisabledAt} is null)`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    // sha256 of the random cookie token; the raw token is never stored.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const builderProfiles = pgTable(
  "builder_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    headline: text("headline").notNull().default(""),
    bio: text("bio").notNull().default(""),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    hourlyRateCents: integer("hourly_rate_cents"),
    country: text("country"),
    timezone: text("timezone"),
    links: jsonb("links").$type<string[]>().notNull().default([]),
    sampleWork: text("sample_work").notNull().default(""),
    status: text("status").$type<BuilderStatus>().notNull().default("applied"),
    identityVerified: boolean("identity_verified").notNull().default(false),
    vettingNotes: text("vetting_notes").notNull().default(""),
    createdAt: createdAt(),
    approvedAt: ts("approved_at"),
  },
  (t) => [uniqueIndex("builder_profiles_user_idx").on(t.userId), uniqueIndex("builder_profiles_slug_idx").on(t.slug)],
);

export const workOrders = pgTable(
  "work_orders",
  {
    id: text("id").primaryKey(),
    number: serial("number").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    category: text("category").notNull().default("custom"),
    status: text("status").$type<WorkOrderStatus>().notNull().default("submitted"),
    intake: jsonb("intake").$type<Intake>().notNull(),
    scope: jsonb("scope").$type<Scope>().notNull(),
    scopeSource: text("scope_source").$type<ScopeSource>().notNull(),
    scopeModel: text("scope_model"),
    aiCostMicros: integer("ai_cost_micros").notNull().default(0),
    priceCents: integer("price_cents"),
    // 0 = delivered in-house by ForgeX (no builder payout).
    builderPayoutCents: integer("builder_payout_cents"),
    carePriceCents: integer("care_price_cents"),
    // true = the monthly fee is part of the service (setup + monthly), so Care starts at go-live.
    careIncluded: boolean("care_included").notNull().default(false),
    quoteSentAt: ts("quote_sent_at"),
    quoteExpiresAt: ts("quote_expires_at"),
    acceptedAt: ts("accepted_at"),
    acceptedById: text("accepted_by_id").references(() => users.id),
    termsVersion: text("terms_version"),
    fundedAt: ts("funded_at"),
    startedAt: ts("started_at"),
    deliveredAt: ts("delivered_at"),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    assignedBuilderId: text("assigned_builder_id").references(() => builderProfiles.id),
    revisionCount: integer("revision_count").notNull().default(0),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("work_orders_number_idx").on(t.number),
    index("work_orders_org_idx").on(t.orgId),
    index("work_orders_status_idx").on(t.status),
    index("work_orders_builder_idx").on(t.assignedBuilderId),
  ],
);

export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    status: text("status").$type<CriterionStatus>().notNull().default("pending"),
    evidence: text("evidence").notNull().default(""),
    reviewNote: text("review_note").notNull().default(""),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("criteria_work_order_idx").on(t.workOrderId)],
);

export const milestones = pgTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<MilestoneStatus>().notNull().default("planned"),
    completedAt: ts("completed_at"),
  },
  (t) => [index("milestones_work_order_idx").on(t.workOrderId)],
);

export const assignments = pgTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    builderId: text("builder_id")
      .notNull()
      .references(() => builderProfiles.id),
    status: text("status").$type<AssignmentStatus>().notNull().default("invited"),
    payoutCents: integer("payout_cents").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    respondedAt: ts("responded_at"),
  },
  (t) => [index("assignments_work_order_idx").on(t.workOrderId), index("assignments_builder_idx").on(t.builderId)],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    builderId: text("builder_id")
      .notNull()
      .references(() => builderProfiles.id),
    round: integer("round").notNull(),
    summary: text("summary").notNull(),
    links: jsonb("links").$type<string[]>().notNull().default([]),
    decision: text("decision").$type<DeliveryDecision>().notNull().default("pending"),
    decisionNote: text("decision_note").notNull().default(""),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("deliveries_work_order_idx").on(t.workOrderId)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    // Internal notes are visible to ForgeX operators only.
    internal: boolean("internal").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("messages_work_order_idx").on(t.workOrderId)],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    amountCents: integer("amount_cents").notNull(),
    method: text("method").$type<PaymentMethod>().notNull(),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    // Stripe's own live/test flag for a Stripe payment; null when it wasn't recorded (payments before 0003).
    livemode: boolean("livemode"),
    reference: text("reference").notNull().default(""),
    recordedById: text("recorded_by_id").references(() => users.id),
    createdAt: createdAt(),
    succeededAt: ts("succeeded_at"),
    refundedAt: ts("refunded_at"),
  },
  (t) => [index("payments_work_order_idx").on(t.workOrderId), uniqueIndex("payments_stripe_session_idx").on(t.stripeSessionId)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    builderId: text("builder_id")
      .notNull()
      .references(() => builderProfiles.id),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<PayoutStatus>().notNull().default("pending"),
    method: text("method").notNull().default(""),
    reference: text("reference").notNull().default(""),
    recordedById: text("recorded_by_id").references(() => users.id),
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
  },
  (t) => [index("payouts_builder_idx").on(t.builderId), uniqueIndex("payouts_work_order_idx").on(t.workOrderId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    rating: integer("rating").notNull(),
    comment: text("comment").notNull().default(""),
    visibility: text("visibility").$type<RecordVisibility>().notNull().default("public_anonymous"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reviews_work_order_idx").on(t.workOrderId)],
);

export const carePlans = pgTable(
  "care_plans",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    builderId: text("builder_id").references(() => builderProfiles.id),
    monthlyPriceCents: integer("monthly_price_cents").notNull(),
    builderShareCents: integer("builder_share_cents").notNull(),
    status: text("status").$type<CarePlanStatus>().notNull().default("requested"),
    createdAt: createdAt(),
    activatedAt: ts("activated_at"),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => [uniqueIndex("care_plans_work_order_idx").on(t.workOrderId)],
);

/**
 * One-time links that let a client an operator signed up (owner-led selling) set a password and land on
 * their quote. Only the SHA-256 of the token is stored.
 */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workOrderId: text("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_idx").on(t.tokenHash), index("invites_user_idx").on(t.userId)],
);

/** Append-only audit trail; it powers each Work Order's timeline and dispute evidence. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    workOrderId: text("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("events_work_order_idx").on(t.workOrderId)],
);

/**
 * The owner's qualification of a researched company, keyed by the saved research record it was made on (the
 * records themselves stay read-only files). Internal sales research: no client-facing view reads this table.
 */
export const opportunityDecisions = pgTable(
  "opportunity_decisions",
  {
    id: text("id").primaryKey(),
    // Which saved research the decision was made on, e.g. "benchmark-2026-gemini/full-run/gemini-4-argon".
    source: text("source").notNull(),
    // The record's company id within that source, e.g. "c13".
    recordId: text("record_id").notNull(),
    companyName: text("company_name").notNull(),
    decision: text("decision").$type<OpportunityDecision>().notNull(),
    note: text("note").notNull().default(""),
    decidedById: text("decided_by_id")
      .notNull()
      .references(() => users.id),
    decidedAt: ts("decided_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("opportunity_decisions_record_idx").on(t.source, t.recordId)],
);

// Discovery-first work on a researched company (Milestone 2A). Keyed by the saved research record like
// opportunity_decisions; the research files themselves stay read-only. Internal: no client-facing view reads these.

/** The industry the owner confirmed for a researched company, and the Work Order drafted from its discovery. */
export const opportunityProfiles = pgTable(
  "opportunity_profiles",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    recordId: text("record_id").notNull(),
    companyName: text("company_name").notNull(),
    // One of the industries in playbooks/industries.json; null means research's suggestion stands.
    industry: text("industry"),
    workOrderId: text("work_order_id").references(() => workOrders.id),
    updatedById: text("updated_by_id")
      .notNull()
      .references(() => users.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("opportunity_profiles_record_idx").on(t.source, t.recordId)],
);

/** A fact the owner checked outside the saved research (a registry, a directory, a job posting): what, where, when. */
export const opportunityChecks = pgTable(
  "opportunity_checks",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    recordId: text("record_id").notNull(),
    statement: text("statement").notNull(),
    sourceUrl: text("source_url"),
    checkedOn: text("checked_on").notNull(), // YYYY-MM-DD
    note: text("note").notNull().default(""),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("opportunity_checks_record_idx").on(t.source, t.recordId)],
);

/** A discovery conversation with someone at the company, recorded by the owner in the customer's words. */
export const discoveryCalls = pgTable(
  "discovery_calls",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    recordId: text("record_id").notNull(),
    heldOn: text("held_on").notNull(), // YYYY-MM-DD
    contactName: text("contact_name").notNull().default(""),
    contactRole: text("contact_role").notNull().default(""),
    decisionMaker: text("decision_maker").$type<DecisionMakerAnswer>().notNull().default("unknown"),
    software: text("software").notNull().default(""),
    priorities: text("priorities").notNull().default(""),
    desiredOutcome: text("desired_outcome").notNull().default(""),
    valueToThem: text("value_to_them").notNull().default(""),
    tried: text("tried").notNull().default(""),
    pain: integer("pain"), // 0-3, as the owner judged it
    nextStep: text("next_step").notNull().default(""),
    // Answers keyed by the discovery question's id (playbooks/*.json).
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    notes: text("notes").notNull().default(""),
    recordedById: text("recorded_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("discovery_calls_record_idx").on(t.source, t.recordId)],
);

/**
 * A problem as the customer described it in a discovery call: one they raised, or a research finding they confirmed or
 * dismissed. It can't exist without its call (call_id is required), so nothing is ever customer-confirmed without
 * recorded discovery evidence.
 */
export const opportunityProblems = pgTable(
  "opportunity_problems",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    recordId: text("record_id").notNull(),
    callId: text("call_id")
      .notNull()
      .references(() => discoveryCalls.id),
    // The research finding this confirms or dismisses (e.g. "opportunityEvidence.2"); null when the customer raised it.
    findingKey: text("finding_key"),
    statement: text("statement").notNull(),
    status: text("status").$type<ProblemStatus>().notNull(),
    solutionRung: text("solution_rung").$type<SolutionRung>(),
    solution: text("solution").notNull().default(""),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("opportunity_problems_record_idx").on(t.source, t.recordId)],
);

/** Outgoing notifications. Viewable at /ops/outbox until an email provider is connected. */
export const outbox = pgTable("outbox", {
  id: text("id").primaryKey(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  workOrderId: text("work_order_id").references(() => workOrders.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

// Milestone 2B: AI missions and their controls. Money is integer micro-dollars (1 USD = 1,000,000), and every AI
// request is recorded before it is sent. See docs/m2b/AUTHORIZATION.md and src/lib/missions/contract.ts.

/** An AI mission: company or industry research, run on demand under the owner's approval. */
export const missions = pgTable(
  "missions",
  {
    id: text("id").primaryKey(),
    // Shown as M-0001.
    number: serial("number").notNull(),
    type: text("type").$type<MissionType>().notNull(),
    status: text("status").$type<MissionStatus>().notNull().default("draft"),
    // Simulated missions call no AI provider, cost $0 and never create research or industry records.
    simulated: boolean("simulated").notNull().default(false),
    subject: jsonb("subject").$type<MissionSubject>().notNull(),
    title: text("title").notNull(),
    purpose: text("purpose").notNull().default(""),
    protocol: text("protocol").notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    model: text("model").notNull(),
    thinkingLevel: text("thinking_level").$type<ThinkingLevel>().notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    maxCostMicros: integer("max_cost_micros").notNull(),
    review: jsonb("review").$type<ReviewChoice | null>(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    // Why the mission is in its current state: interrupted, budget blocked, failed or needs review.
    stateReason: text("state_reason"),
    // Set each time the mission moves to Running, by the one request that moved it.
    runId: text("run_id"),
    // An unfinished mission's conversation, including the text of pages it read, so it can resume without paying
    // again for finished steps. Cleared when the mission ends; only fingerprints, quotes and page details remain.
    workingState: jsonb("working_state").$type<Record<string, unknown> | null>(),
    // The final report, its checks and the sources read (no page text).
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    submittedAt: ts("submitted_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("missions_number_idx").on(t.number), index("missions_status_idx").on(t.status), unique("missions_id_simulated_key").on(t.id, t.simulated)],
);

/** A mission's step log: owner actions, state changes, model requests, page reads, checks and errors. */
export const missionSteps = pgTable(
  "mission_steps",
  {
    id: text("id").primaryKey(),
    seq: serial("seq").notNull(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id),
    kind: text("kind").$type<MissionStepKind>().notNull(),
    // A owner action's request id: the same request arriving twice (a double click, a second window) acts once.
    requestId: text("request_id"),
    actorId: text("actor_id").references(() => users.id),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mission_steps_seq_idx").on(t.seq),
    index("mission_steps_mission_idx").on(t.missionId),
    uniqueIndex("mission_steps_request_idx").on(t.missionId, t.requestId),
  ],
);

/** The owner's approval of one mission's exact scope (or of adding review), valid until the end of its Boise day. */
export const missionApprovals = pgTable(
  "mission_approvals",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    maxCostMicros: integer("max_cost_micros").notNull(),
    review: jsonb("review").$type<ReviewChoice | null>(),
    approvedById: text("approved_by_id")
      .notNull()
      .references(() => users.id),
    approvedAt: ts("approved_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    boiseDay: text("boise_day").notNull(),
    // The approver's users.spending_authority_at when it was given: a later re-designation invalidates it.
    authorityGrantedAt: ts("authority_granted_at").notNull(),
    requestId: text("request_id").notNull(),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mission_approvals_mission_idx").on(t.missionId),
    uniqueIndex("mission_approvals_request_idx").on(t.missionId, t.requestId),
    uniqueIndex("mission_approvals_open_idx").on(t.missionId, t.kind).where(sql`${t.voidedAt} is null`),
  ],
);

/** Every AI request: its reservation before sending, then its usage, cost and status. Rows are never deleted. */
export const aiUsageLedger = pgTable(
  "ai_usage_ledger",
  {
    id: text("id").primaryKey(),
    seq: serial("seq").notNull(),
    // Null only for a reconciliation adjustment.
    missionId: text("mission_id").references(() => missions.id),
    approvalId: text("approval_id").references(() => missionApprovals.id),
    stepId: text("step_id").references(() => missionSteps.id),
    attempt: integer("attempt").notNull().default(1),
    purpose: text("purpose").$type<LedgerPurpose>().notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    model: text("model").notNull(),
    priceVersion: text("price_version").notNull(),
    // USD per million tokens, as applied.
    prices: jsonb("prices").$type<{ input: number; cachedInput: number; output: number }>().notNull(),
    sentAt: ts("sent_at").notNull(),
    // The America/Boise day (YYYY-MM-DD) and month (YYYY-MM) the request was sent in; its cost counts there.
    boiseDay: text("boise_day").notNull(),
    boiseMonth: text("boise_month").notNull(),
    countedInputTokens: integer("counted_input_tokens").notNull(),
    // The counted input plus what the counter can't see, with the margin: what the reservation was priced on.
    reservedInputTokens: integer("reserved_input_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    reservedMicros: integer("reserved_micros").notNull(),
    status: text("status").$type<LedgerStatus>().notNull().default("reserved"),
    usage: jsonb("usage").$type<TokenUsage | null>(),
    actualMicros: integer("actual_micros"),
    overReservation: boolean("over_reservation").notNull().default(false),
    providerRequestId: text("provider_request_id"),
    errorKind: text("error_kind"),
    // Provider error text with keys redacted.
    errorDetail: text("error_detail"),
    simulated: boolean("simulated").notNull().default(false),
    synthetic: boolean("synthetic").notNull().default(false),
    // The part of an unverified amount released by reconciliation; each release is a spending_reconciliations row.
    releasedMicros: integer("released_micros").notNull().default(0),
    // What the entry counts against the caps now. Computed by the database, never written.
    committedMicros: integer("committed_micros").generatedAlwaysAs(
      sql`case status when 'reserved' then reserved_micros when 'settled' then actual_micros when 'unverified' then reserved_micros - released_micros else 0 end`,
    ),
    // The backend process that reserved it; recovery at start-up touches only other processes' open reservations.
    backendInstance: text("backend_instance").notNull(),
    settledAt: ts("settled_at"),
    // For an adjustment: the reconciliation that recorded it.
    reconciliationId: text("reconciliation_id").references((): AnyPgColumn => spendingReconciliations.id),
    // For an over-reservation: the owner's review that unblocked the provider; null while it still blocks.
    providerReviewId: text("provider_review_id").references((): AnyPgColumn => spendingReconciliations.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ai_usage_ledger_seq_idx").on(t.seq),
    index("ai_usage_ledger_mission_idx").on(t.missionId),
    index("ai_usage_ledger_day_idx").on(t.boiseDay),
    index("ai_usage_ledger_month_idx").on(t.boiseMonth),
    uniqueIndex("ai_usage_ledger_step_idx").on(t.stepId, t.attempt, t.purpose),
  ],
);

/** Manual reconciliation against a provider's console: the figure entered, releases and unblocks. Append-only. */
export const spendingReconciliations = pgTable(
  "spending_reconciliations",
  {
    id: text("id").primaryKey(),
    // "figure": a provider total the owner entered; "release": unverified amounts released against a figure;
    // "adjustment": the provider showed more than KELQOR recorded; "unblock": a provider reviewed after an overrun.
    kind: text("kind").$type<"figure" | "release" | "adjustment" | "unblock">().notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    // Null only for an unblock.
    periodKind: text("period_kind").$type<"day" | "month">(),
    period: text("period"),
    providerMicros: integer("provider_micros"),
    settledMicros: integer("settled_micros").notNull().default(0),
    unverifiedMicros: integer("unverified_micros").notNull().default(0),
    releasedMicros: integer("released_micros").notNull().default(0),
    adjustmentMicros: integer("adjustment_micros").notNull().default(0),
    // The figure a release or adjustment was made against.
    figureId: text("figure_id").references((): AnyPgColumn => spendingReconciliations.id),
    entries: jsonb("entries").$type<{ ledgerId: string; micros: number }[]>().notNull().default([]),
    note: text("note").notNull(),
    recordedById: text("recorded_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("spending_reconciliations_period_idx").on(t.provider, t.period)],
);

/** Approved and proposed research sources. Each change adds a version; a source's state is its latest version. */
export const researchSources = pgTable(
  "research_sources",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    status: text("status").$type<SourceStatus>().notNull(),
    name: text("name").notNull(),
    // A domain ("osha.gov", subdomains included) or an address prefix ("https://www.bls.gov/ooh/").
    match: text("match").notNull(),
    kind: text("kind").$type<SourceKind>().notNull(),
    // Industry labels from playbooks/industries.json; empty means it serves every industry.
    industries: jsonb("industries").$type<string[]>().notNull().default([]),
    purpose: text("purpose").notNull().default(""),
    // "starter list v1", "proposed by M-0003" or "added by you".
    origin: text("origin").notNull(),
    missionId: text("mission_id").references(() => missions.id),
    note: text("note").notNull().default(""),
    changedById: text("changed_by_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("research_sources_version_idx").on(t.key, t.version)],
);

/** Company research from completed real missions: one series of versions per Opportunity Center company. */
export const researchRecords = pgTable(
  "research_records",
  {
    id: text("id").primaryKey(),
    // A benchmark record id ("c01") for a company already in the Opportunity Center, or "n" + a number for a new one.
    companyKey: text("company_key").notNull(),
    version: integer("version").notNull(),
    companyName: text("company_name").notNull(),
    website: text("website").notNull(),
    town: text("town").notNull().default(""),
    state: text("state").notNull().default(""),
    industry: text("industry"),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id),
    protocol: text("protocol").notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    model: text("model").notNull(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    checks: jsonb("checks").$type<Record<string, unknown>>().notNull(),
    sources: jsonb("sources").$type<Record<string, unknown>[]>().notNull(),
    costMicros: integer("cost_micros").notNull(),
    // Accepted from Needs review with its issues listed.
    withIssues: boolean("with_issues").notNull().default(false),
    // Always false: with the foreign key below, the database refuses research from a simulated mission.
    missionSimulated: boolean("mission_simulated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("research_records_version_idx").on(t.companyKey, t.version),
    foreignKey({ name: "research_records_real_mission_fk", columns: [t.missionId, t.missionSimulated], foreignColumns: [missions.id, missions.simulated] }),
    check("research_records_not_simulated", sql`not ${t.missionSimulated}`),
  ],
);

/** Industry research from completed real missions: one series of versions per industry, category and region. */
export const industryIntelligence = pgTable(
  "industry_intelligence",
  {
    id: text("id").primaryKey(),
    seriesKey: text("series_key").notNull(),
    version: integer("version").notNull(),
    industry: text("industry").notNull(),
    category: text("category"),
    region: text("region"),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id),
    protocol: text("protocol").notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    model: text("model").notNull(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    checks: jsonb("checks").$type<Record<string, unknown>>().notNull(),
    sources: jsonb("sources").$type<Record<string, unknown>[]>().notNull(),
    costMicros: integer("cost_micros").notNull(),
    withIssues: boolean("with_issues").notNull().default(false),
    missionSimulated: boolean("mission_simulated").notNull().default(false),
    // Company research uses a version as context only after the owner marks it reviewed.
    reviewedAt: ts("reviewed_at"),
    reviewedById: text("reviewed_by_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("industry_intelligence_version_idx").on(t.seriesKey, t.version),
    foreignKey({ name: "industry_intelligence_real_mission_fk", columns: [t.missionId, t.missionSimulated], foreignColumns: [missions.id, missions.simulated] }),
    check("industry_intelligence_not_simulated", sql`not ${t.missionSimulated}`),
  ],
);

/**
 * A financial figure the customer gave in a discovery call. It stays an estimate until the owner records the
 * calculation and the evidence that validate it. No AI step writes this table.
 */
export const discoveryFigures = pgTable(
  "discovery_figures",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    recordId: text("record_id").notNull(),
    callId: text("call_id")
      .notNull()
      .references(() => discoveryCalls.id),
    statement: text("statement").notNull(),
    amountCents: integer("amount_cents").notNull(),
    period: text("period").notNull(),
    basis: text("basis").notNull().default(""),
    validatedCents: integer("validated_cents"),
    calculation: text("calculation"),
    evidence: text("evidence"),
    validatedById: text("validated_by_id").references(() => users.id),
    validatedAt: ts("validated_at"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("discovery_figures_record_idx").on(t.source, t.recordId)],
);

// ---- Milestone 3: engineering missions ---------------------------------------------------------------------------

/** A git workspace the owner registered for engineering missions. Agents never work in it directly. */
export const engWorkspaces = pgTable(
  "eng_workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // The repository's root, as the owner registered it.
    path: text("path").notNull(),
    baseBranch: text("base_branch").notNull(),
    // KELQOR's own demo repository for simulated missions.
    demo: boolean("demo").notNull().default(false),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("eng_workspaces_path_idx").on(t.path)],
);

/** An engineering mission: one agent, one task, one isolated worktree, reviewed by the owner before anything applies. */
export const engMissions = pgTable(
  "eng_missions",
  {
    id: text("id").primaryKey(),
    // Shown as E-0001.
    number: serial("number").notNull(),
    title: text("title").notNull(),
    task: text("task").notNull(),
    deliverables: text("deliverables").notNull().default(""),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => engWorkspaces.id),
    agent: text("agent").$type<EngAgentId>().notNull(),
    permissions: jsonb("permissions").$type<EngPermissions>().notNull(),
    status: text("status").$type<EngStatus>().notNull().default("draft"),
    changeState: text("change_state").$type<ChangeState>().notNull().default("none"),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    stateReason: text("state_reason"),
    activity: text("activity"),
    approvedById: text("approved_by_id").references(() => users.id),
    approvedAt: ts("approved_at"),
    approvedFingerprint: text("approved_fingerprint"),
    // Fixed when the mission first starts: the commit its worktree was cut from.
    baseCommit: text("base_commit"),
    worktreePath: text("worktree_path"),
    runId: text("run_id"),
    deliverable: jsonb("deliverable").$type<EngDeliverable | null>(),
    appliedBranch: text("applied_branch"),
    appliedCommit: text("applied_commit"),
    costMicros: integer("cost_micros"),
    costSource: text("cost_source").$type<EngMissionSummary["costSource"]>().notNull().default("none"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eng_missions_number_idx").on(t.number), index("eng_missions_status_idx").on(t.status)],
);

/** An engineering mission's log: owner actions (each acts once per request id), states, agent activity, checks, errors. */
export const engEvents = pgTable(
  "eng_events",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => engMissions.id),
    kind: text("kind").$type<EngEventView["kind"]>().notNull(),
    requestId: text("request_id"),
    actorId: text("actor_id").references(() => users.id),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("eng_events_mission_idx").on(t.missionId, t.createdAt), uniqueIndex("eng_events_request_idx").on(t.missionId, t.requestId)],
);

// ---- Milestone 4: customer AI operations ---------------------------------------------------------------------------

/**
 * A managed service a customer organization has: one catalog category, configured for that customer, under an
 * agreement whose terms are copied in when it starts, so a later plan change never alters it.
 */
export const customerServices = pgTable(
  "customer_services",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    category: text("category").$type<ServiceCategory>().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<"draft" | "active" | "paused" | "ended">().notNull().default("draft"),
    config: jsonb("config").$type<ServiceConfig>().notNull(),
    planKey: text("plan_key").notNull(),
    monthlyCents: integer("monthly_cents").notNull(),
    includedRequests: integer("included_requests").notNull(),
    overageCents: integer("overage_cents").notNull(),
    setupCents: integer("setup_cents").notNull().default(0),
    agreementStartedAt: ts("agreement_started_at"),
    endedAt: ts("ended_at"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  // (org_id, id) is what every child row refers to, so a record can't point at another organization's service.
  (t) => [index("customer_services_org_idx").on(t.orgId), unique("customer_services_org_id_key").on(t.orgId, t.id)],
);

/** One piece of work a customer service handles: a request, its processing, KELQOR's review and the result. */
export const serviceRequests = pgTable(
  "service_requests",
  {
    id: text("id").primaryKey(),
    number: serial("number").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => customerServices.id),
    title: text("title").notNull(),
    input: jsonb("input").$type<{ text: string; from: string | null; channel: "portal" | "operator" }>().notNull(),
    status: text("status").$type<ServiceRequestStatus>().notNull().default("received"),
    // No AI model is called yet: processing is simulated until live execution is authorized.
    simulated: boolean("simulated").notNull().default(true),
    processing: jsonb("processing").$type<ProcessingResult | null>(),
    // The draft KELQOR reviews (possibly edited by the reviewer), and its hash, which every decision is bound to.
    draft: jsonb("draft").$type<Deliverable | null>(),
    draftHash: text("draft_hash"),
    deliverable: jsonb("deliverable").$type<Deliverable | null>(),
    reviewNote: text("review_note"),
    reviewMinutes: integer("review_minutes"),
    reviewedById: text("reviewed_by_id").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    needsCustomerApproval: boolean("needs_customer_approval").notNull().default(false),
    customerNote: text("customer_note"),
    customerDecidedById: text("customer_decided_by_id").references(() => users.id),
    customerDecidedAt: ts("customer_decided_at"),
    aiCostMicros: integer("ai_cost_micros").notNull().default(0),
    costSource: text("cost_source").$type<"simulated" | "ledger" | "unknown">().notNull().default("simulated"),
    stateReason: text("state_reason"),
    submittedById: text("submitted_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("service_requests_number_idx").on(t.number),
    index("service_requests_org_idx").on(t.orgId, t.status),
    index("service_requests_service_idx").on(t.serviceId),
    unique("service_requests_org_id_key").on(t.orgId, t.id),
    foreignKey({ name: "service_requests_same_org_service_fk", columns: [t.orgId, t.serviceId], foreignColumns: [customerServices.orgId, customerServices.id] }),
  ],
);

/** What happened to a customer's services and requests, each action once per request id. Scoped by organization. */
export const serviceEvents = pgTable(
  "service_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    serviceId: text("service_id").references(() => customerServices.id),
    requestId: text("request_id").references(() => serviceRequests.id),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    // Whether the customer may see it: KELQOR's internal review notes stay internal.
    customerVisible: boolean("customer_visible").notNull().default(true),
    actorId: text("actor_id").references(() => users.id),
    requestKey: text("request_key"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("service_events_org_idx").on(t.orgId, t.createdAt),
    uniqueIndex("service_events_key_idx").on(t.orgId, t.requestKey),
    foreignKey({ name: "service_events_same_org_service_fk", columns: [t.orgId, t.serviceId], foreignColumns: [customerServices.orgId, customerServices.id] }),
    foreignKey({ name: "service_events_same_org_request_fk", columns: [t.orgId, t.requestId], foreignColumns: [serviceRequests.orgId, serviceRequests.id] }),
  ],
);

/** A customer invoice. Simulated only: no real charge can be recorded until live billing is authorized. */
export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    number: serial("number").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    period: text("period").notNull(),
    status: text("status").$type<"draft" | "issued" | "paid" | "void">().notNull().default("draft"),
    simulated: boolean("simulated").notNull().default(true),
    totalCents: integer("total_cents").notNull().default(0),
    issuedAt: ts("issued_at"),
    paidAt: ts("paid_at"),
    // A voided invoice can be replaced; the replacement names the one it replaces.
    replacesInvoiceId: text("replaces_invoice_id"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_number_idx").on(t.number),
    // One live invoice per customer and month; a voided one doesn't block its replacement.
    uniqueIndex("invoices_org_period_idx").on(t.orgId, t.period).where(sql`${t.status} <> 'void'`),
    index("invoices_org_idx").on(t.orgId),
    unique("invoices_org_id_key").on(t.orgId, t.id),
    // A replacement names a voided invoice of the same customer, never another's.
    foreignKey({ name: "invoices_replaces_same_org_fk", columns: [t.orgId, t.replacesInvoiceId], foreignColumns: [t.orgId, t.id] }),
    check("invoices_simulated_only", sql`${t.simulated} = true`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    serviceId: text("service_id").references(() => customerServices.id),
    kind: text("kind").$type<"subscription" | "overage" | "setup">().notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitCents: integer("unit_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [
    index("invoice_lines_invoice_idx").on(t.invoiceId),
    foreignKey({ name: "invoice_lines_same_org_invoice_fk", columns: [t.orgId, t.invoiceId], foreignColumns: [invoices.orgId, invoices.id] }),
    foreignKey({ name: "invoice_lines_same_org_service_fk", columns: [t.orgId, t.serviceId], foreignColumns: [customerServices.orgId, customerServices.id] }),
  ],
);
