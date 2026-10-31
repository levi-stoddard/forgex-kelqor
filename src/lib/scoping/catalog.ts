import type { Complexity, Scope } from "../domain/types";

/**
 * The starter catalog of repeatable outcomes. Each one doubles as the template the
 * built-in scoper uses when no AI key is configured, and as calibration for the AI scoper.
 * Hours are delivery estimates for one builder; prices are derived in pricing.ts.
 */
export interface OutcomeTemplate {
  slug: string;
  title: string;
  tagline: string;
  examples: string[];
  keywords: string[];
  hoursLow: number;
  hoursHigh: number;
  complexity: Complexity;
  skills: string[];
  /** Productized price (setup), when the outcome is sold at a list price rather than priced from hours. */
  listPriceCents?: number;
  /** Monthly fee that is part of the service (setup + monthly). */
  monthlyCents?: number;
  /** Verticals whose launch offer features this outcome, e.g. "home-services". */
  featuredFor?: string[];
  scope: Pick<
    Scope,
    | "objectives"
    | "inScope"
    | "outOfScope"
    | "deliverables"
    | "acceptanceCriteria"
    | "milestones"
    | "assumptions"
    | "clientResponsibilities"
    | "risks"
  >;
}

const STANDARD_RESPONSIBILITIES = [
  "Grant access by inviting the builder to your own accounts. Never share passwords in ForgeX.",
  "Name one decision-maker who approves templates, rules and test results.",
  "Join a 30-minute acceptance session at the end.",
];

export const OUTCOMES: OutcomeTemplate[] = [
  {
    slug: "revenue-leak-check",
    title: "Revenue Leak Check",
    tagline: "In one week, see how many calls, leads and quotes slip through, and what they are worth to you.",
    examples: ["Missed and late-answered calls", "Response time by lead source", "Quotes that were never won or lost"],
    keywords: ["audit", "assessment", "leak", "leaks", "how much are we losing", "missed revenue", "where to start"],
    hoursLow: 4,
    hoursHigh: 6,
    complexity: "small",
    skills: ["Call and lead analytics", "Field-service software", "Spreadsheet analysis"],
    listPriceCents: 50_000,
    featuredFor: ["home-services"],
    scope: {
      objectives: [
        "Measure how many calls go unanswered and how fast each lead source gets a response.",
        "Put a dollar figure on leads and quotes that slip through, with every assumption stated.",
        "Recommend the fixes worth paying for, each with a fixed price.",
      ],
      inScope: [
        "Review 30–60 days of phone logs, lead-source data and field-service job and quote exports.",
        "A 45-minute call to walk through how leads are handled today.",
        "A written report with the findings, the dollar estimate and a fixed-price fix plan.",
      ],
      outOfScope: ["Building or changing anything in your systems.", "Access to customer payment or card data."],
      deliverables: ["A two-page report.", "A recorded walkthrough of the findings.", "A fixed-price plan for the recommended fixes."],
      acceptanceCriteria: [
        "The report shows the answer rate and missed-call count for the period, taken from your own phone logs.",
        "The report shows the median time to first response for each lead source you use.",
        "The report shows the number and total value of open quotes older than 7 days.",
        "The dollar estimate states each assumption (close rate, average job value) so you can change it.",
        "The fix plan lists at least two fixes, each with a fixed price and acceptance criteria.",
        "The report is delivered within 5 business days of receiving your exports.",
      ],
      milestones: [
        { title: "Exports and call", description: "Phone, lead and quote exports received; 45-minute walkthrough held." },
        { title: "Report and plan", description: "Report, dollar estimate and fixed-price fix plan delivered and walked through." },
      ],
      assumptions: [
        "Your phone system and field-service software can export call and quote history (most can).",
        "The $500 fee is credited in full to any fix you order within 30 days.",
      ],
      clientResponsibilities: [
        "Send the exports (we'll show you how), with customer names removed if you prefer.",
        "Join the 45-minute call.",
      ],
      risks: ["Phone systems without call logs limit the answer-rate measurement to a one-week sample."],
    },
  },
  {
    slug: "lead-response",
    title: "Lead-to-job pipeline",
    tagline:
      "Every lead from every source lands in your field-service software within two minutes, gets an instant reply, and nobody forgets to call back.",
    examples: ["Phone, website, Google LSA, Angi and Facebook leads in one place", "Text-back on missed calls", "Alerts when a lead waits too long"],
    keywords: [
      "lead", "leads", "crm", "hubspot", "salesforce", "pipedrive", "follow up", "follow-up", "inquiry",
      "inquiries", "web form", "contact form", "quote request", "missed call", "missed calls", "call back",
      "voicemail", "prospect", "local services", "lsa", "angi", "thumbtack", "google ads", "booking",
    ],
    hoursLow: 12,
    hoursHigh: 20,
    complexity: "medium",
    skills: ["Field-service software integration", "Workflow automation", "Telephony and SMS", "Webhooks"],
    listPriceCents: 180_000,
    monthlyCents: 14_900,
    featuredFor: ["home-services"],
    scope: {
      objectives: [
        "Get every lead from every source into one place, tagged with where it came from.",
        "Acknowledge every lead within a minute, day or night.",
        "Make sure a person responds to every lead, and show how fast it happened.",
      ],
      inScope: [
        "Connect up to 5 lead sources (phone and missed calls, website forms, Google Local Services Ads, Angi or Thumbtack, Facebook) to your field-service software or CRM.",
        "Text-back on missed calls and instant replies on web and app leads, using templates you approve.",
        "A response timer: if nobody responds within the time you set, the named person is alerted.",
        "A weekly report of leads by source, response times and booked rate.",
        "Monthly: monitoring, fixes, template changes and the SMS and phone-number fees, up to 1,000 messages.",
      ],
      outOfScope: [
        "Replacing your phone system or field-service software.",
        "AI voice answering (this works alongside one if you use it).",
        "Buying leads or running ads.",
      ],
      deliverables: [
        "The working pipeline in your own accounts.",
        "Templates, routing rules and response targets, documented.",
        "A recorded walkthrough and a one-page runbook.",
      ],
      acceptanceCriteria: [
        "A test lead from each connected source appears in your field-service software within 2 minutes, tagged with its source.",
        "Each test lead receives the approved acknowledgement within 60 seconds.",
        "A missed test call receives a text-back within 60 seconds.",
        "A test lead left unanswered triggers an alert to the named person at the agreed time.",
        "The weekly report shows leads by source, median response time and booked rate for the test week.",
        "Your named owner can pause the automations and edit a template using the runbook alone.",
      ],
      milestones: [
        { title: "Kickoff and access", description: "Sources, templates, response targets and access agreed; SMS registration filed." },
        { title: "Build and internal test", description: "Sources connected, replies and alerts tested with sample leads." },
        { title: "Acceptance and go-live", description: "Acceptance tests run together; monthly monitoring starts." },
      ],
      assumptions: [
        "You use Jobber, Housecall Pro, ServiceTitan or a CRM with an API or email intake.",
        "You approve every message template before go-live.",
        "The monthly fee starts at go-live and can be cancelled any month.",
      ],
      clientResponsibilities: STANDARD_RESPONSIBILITIES,
      risks: [
        "Business texting needs carrier registration (A2P 10DLC), which can take 1–3 weeks.",
        "Lead sources without an integration may need an email-parsing step.",
      ],
    },
  },
  {
    slug: "document-intake",
    title: "Document and invoice intake",
    tagline: "Emailed invoices, receipts and forms are read, checked and entered for you, with a human review queue.",
    examples: ["Vendor invoices into accounting", "Customer forms into a spreadsheet", "Receipts matched to jobs"],
    keywords: [
      "invoice", "invoices", "receipt", "receipts", "bill", "bills", "accounts payable", "data entry", "re-key",
      "rekey", "re-keying", "pdf", "pdfs", "forms", "document", "documents", "paperwork", "scan", "extract",
      "quickbooks", "xero", "purchase order",
    ],
    hoursLow: 22,
    hoursHigh: 36,
    complexity: "medium",
    skills: ["Document AI", "Accounting integrations", "Workflow automation", "Data validation"],
    scope: {
      objectives: [
        "Remove manual re-keying for the agreed document types.",
        "Keep a human approval step for anything uncertain.",
        "Give the team an audit trail of what was entered and from where.",
      ],
      inScope: [
        "Intake from a dedicated inbox or upload folder.",
        "Extraction of the agreed fields from up to 3 document types.",
        "Validation rules (totals, duplicates, vendor match) with a review queue for exceptions.",
        "Posting approved records to the accounting system or spreadsheet.",
        "A weekly exceptions report.",
      ],
      outOfScope: [
        "Paying bills or moving money.",
        "Converting a historical backlog beyond 50 sample documents.",
        "Handwritten documents.",
      ],
      deliverables: [
        "Working pipeline in your own accounts.",
        "Field-mapping document.",
        "Review-queue instructions for staff.",
        "Recorded walkthrough and runbook.",
      ],
      acceptanceCriteria: [
        "On 30 real test documents agreed at kickoff, at least 95% of required fields are extracted correctly and every uncertain value goes to the review queue.",
        "No record reaches the accounting system without passing validation or human approval.",
        "Duplicate documents are detected and flagged during testing.",
        "Every posted record links back to its source document.",
        "The weekly exceptions report arrives with counts by document type.",
        "Staff can approve or correct a queued item using the instructions alone.",
      ],
      milestones: [
        { title: "Kickoff and samples", description: "Document types, fields and 30 test documents agreed; access granted." },
        { title: "Extraction and validation", description: "Pipeline, rules and review queue built and tested internally." },
        { title: "Pilot and handover", description: "Acceptance run on the test set; walkthrough and runbook delivered." },
      ],
      assumptions: [
        "Documents arrive digitally (PDF or image).",
        "The accounting system has an API or an import format.",
        "Up to 3 document types.",
      ],
      clientResponsibilities: [
        ...STANDARD_RESPONSIBILITIES,
        "Provide 30 representative documents for testing.",
      ],
      risks: [
        "Poor scans reduce extraction accuracy.",
        "Documents with taxpayer or personal financial data must follow your security policy (for example a written information security plan).",
      ],
    },
  },
  {
    slug: "support-assistant",
    title: "AI support assistant with human handoff",
    tagline: "Answers routine customer questions from your own content and hands everything else to your team.",
    examples: ["Website chat for FAQs", "Support-inbox first replies", "Order-status questions"],
    keywords: [
      "support", "customer service", "tickets", "ticket", "helpdesk", "help desk", "zendesk", "freshdesk",
      "intercom", "chat", "chatbot", "faq", "faqs", "customer questions", "website chat", "answer questions",
    ],
    hoursLow: 24,
    hoursHigh: 40,
    complexity: "medium",
    skills: ["LLM applications", "Retrieval (RAG)", "Helpdesk integrations", "Evaluation"],
    scope: {
      objectives: [
        "Resolve routine questions without staff time.",
        "Hand off everything else with full context.",
        "Keep every answer grounded in approved content.",
      ],
      inScope: [
        "An assistant on website chat or the support inbox, using approved knowledge sources.",
        "Retrieval over up to 50 documents or pages.",
        "Handoff to a person with the conversation transcript.",
        "Guardrails: no answers outside approved content; sensitive requests always go to a person.",
        "A weekly report of questions, handoffs and content gaps.",
      ],
      outOfScope: [
        "Taking payments or changing customer accounts.",
        "Phone or voice support.",
        "Writing new help content beyond fixing gaps found in testing.",
      ],
      deliverables: [
        "Working assistant.",
        "An evaluation set of 40 questions with expected answers.",
        "Admin guide for updating content.",
        "Recorded walkthrough.",
      ],
      acceptanceCriteria: [
        "On the agreed 40-question evaluation set, at least 85% of answers are rated correct and grounded by your reviewer.",
        "Questions outside approved content are handed off, not answered.",
        "Handoffs reach your team's queue with the full transcript within 1 minute.",
        "In a 10-attempt red-team test, the assistant never reveals internal-only content.",
        "The weekly report lists top questions, handoff rate and content gaps.",
        "Staff can add or update a knowledge source using the admin guide alone.",
      ],
      milestones: [
        { title: "Content and evaluation set", description: "Knowledge sources and 40 test questions agreed." },
        { title: "Build and tuning", description: "Assistant, guardrails and handoff built and tuned against the evaluation set." },
        { title: "Acceptance and launch", description: "Evaluation run with your reviewer; launch and admin training." },
      ],
      assumptions: ["Your help content exists in some form (site pages, documents, macros).", "One channel at launch."],
      clientResponsibilities: [...STANDARD_RESPONSIBILITIES, "Provide a reviewer to grade the evaluation set."],
      risks: [
        "Answer quality is capped by the quality of your help content.",
        "AI vendor pricing changes affect running cost; the Care plan covers monitoring it.",
      ],
    },
  },
  {
    slug: "reporting",
    title: "Owner's Monday numbers",
    tagline:
      "One page every Monday: booked revenue, close rate, average ticket, cost per booked job by lead source and money owed, from your field-service software, QuickBooks and ad accounts.",
    examples: ["Cost per booked job by lead source", "Close rate and average ticket by tech", "Money owed and aging"],
    keywords: [
      "report", "reports", "reporting", "dashboard", "dashboards", "kpi", "kpis", "metrics", "spreadsheet",
      "spreadsheets", "excel", "google sheets", "weekly numbers", "analytics", "summary", "power bi", "looker",
      "quickbooks", "numbers", "profit",
    ],
    hoursLow: 10,
    hoursHigh: 16,
    complexity: "small",
    skills: ["Data integration", "Field-service software", "QuickBooks", "Dashboards"],
    listPriceCents: 120_000,
    monthlyCents: 9_900,
    featuredFor: ["home-services"],
    scope: {
      objectives: [
        "Replace hand-built weekly reports with one page that arrives on its own.",
        "Show what each lead source really costs per booked job, which no single tool shows today.",
        "Use one written definition for every number.",
      ],
      inScope: [
        "Connect your field-service software, QuickBooks Online and up to two ad accounts (for example Google Ads and Local Services Ads).",
        "Up to 10 agreed metrics, each with a written definition.",
        "A dashboard in the tool you prefer (Looker Studio, Google Sheets or Power BI).",
        "A Monday email with week-over-week changes, and an alert if a refresh fails.",
        "Monthly: monitoring, fixes when a connected tool changes, and one metric change a month.",
      ],
      outOfScope: ["Bookkeeping or cleaning up historical data.", "Forecasting models.", "More than 12 months of history."],
      deliverables: ["The dashboard and the Monday email.", "Metric definitions.", "A recorded walkthrough and runbook."],
      acceptanceCriteria: [
        "Each agreed metric matches a manual calculation for 2 sample weeks within ±1%.",
        "Cost per booked job is shown for each connected lead source.",
        "The Monday email arrives by 7 a.m. with week-over-week changes.",
        "Every metric shows its written definition in the dashboard.",
        "A failed refresh sends an alert to the named owner within an hour.",
      ],
      milestones: [
        { title: "Metrics and access", description: "Metrics, definitions and read-only access agreed." },
        { title: "Build", description: "Connections, dashboard and Monday email built." },
        { title: "Reconciliation and go-live", description: "Numbers reconciled against two manual weeks; monthly monitoring starts." },
      ],
      assumptions: [
        "Read-only access to your field-service software, QuickBooks and ad accounts.",
        "The monthly fee starts at go-live and can be cancelled any month.",
      ],
      clientResponsibilities: [...STANDARD_RESPONSIBILITIES, "Provide two recent weeks of numbers you calculated by hand."],
      risks: ["Inconsistent job or lead-source tagging in your software limits how accurate cost per job can be."],
    },
  },
  {
    slug: "inbox-triage",
    title: "Shared-inbox triage with drafted replies",
    tagline: "Incoming email is sorted, routed and drafted, so nothing urgent sits unread.",
    examples: ["Office or service inbox sorting", "Urgent-request alerts", "Drafted replies for common requests"],
    keywords: [
      "email", "emails", "inbox", "inboxes", "shared inbox", "triage", "sort", "categorize", "label", "labels",
      "drafts", "replies", "outlook", "gmail", "unread",
    ],
    hoursLow: 12,
    hoursHigh: 22,
    complexity: "small",
    skills: ["Email APIs", "LLM classification", "Workflow automation"],
    scope: {
      objectives: [
        "Sort every incoming email into agreed categories.",
        "Alert the right person to urgent requests within minutes.",
        "Draft replies for common requests, always approved by a person.",
      ],
      inScope: [
        "One shared inbox (Microsoft 365 or Google Workspace).",
        "Up to 8 categories with routing rules.",
        "Drafted replies for up to 5 common request types.",
        "Urgent alerts by email or chat.",
      ],
      outOfScope: ["Sending replies without a person approving.", "Deleting or archiving email automatically.", "Migrating mailboxes."],
      deliverables: ["Working triage in your mailbox.", "Category and routing guide.", "Runbook and recorded walkthrough."],
      acceptanceCriteria: [
        "On 100 recent emails, at least 90% are classified into the agreed categories correctly.",
        "Urgent categories notify the right person within 5 minutes.",
        "Drafts are created for the agreed request types and none is sent without a person approving it.",
        "No email is deleted or archived automatically.",
        "Staff can adjust a category or routing rule using the runbook alone.",
      ],
      milestones: [
        { title: "Categories and rules", description: "Categories, routing and reply templates agreed." },
        { title: "Build and test", description: "Classifier, routing and drafts built and tested on past email." },
        { title: "Acceptance and handover", description: "Accuracy check on 100 emails; walkthrough." },
      ],
      assumptions: ["One shared inbox.", "Up to 8 categories."],
      clientResponsibilities: STANDARD_RESPONSIBILITIES,
      risks: ["Mailbox access may need approval from your IT administrator."],
    },
  },
  {
    slug: "knowledge-assistant",
    title: "Internal knowledge assistant",
    tagline: "Staff ask questions in plain words and get answers cited from your own procedures and policies.",
    examples: ["SOP and policy questions", "New-hire onboarding", "Field-tech troubleshooting guides"],
    keywords: [
      "sop", "sops", "procedure", "procedures", "policies", "policy", "handbook", "onboarding", "training",
      "internal docs", "knowledge", "wiki", "sharepoint", "confluence", "google drive", "notion", "manual", "manuals",
    ],
    hoursLow: 20,
    hoursHigh: 32,
    complexity: "medium",
    skills: ["Retrieval (RAG)", "Access control", "LLM applications", "Evaluation"],
    scope: {
      objectives: [
        "Answer staff questions from approved internal documents, with citations.",
        "Respect existing document permissions.",
        "Show which topics have no documented answer.",
      ],
      inScope: [
        "Connect one document source (for example SharePoint, Google Drive or Notion).",
        "Up to 500 documents.",
        "A chat interface in the tool staff already use (Teams, Slack or web).",
        "A usage report with unanswered topics.",
      ],
      outOfScope: ["Writing missing procedures.", "Connecting more than one document source.", "Customer-facing use."],
      deliverables: ["Working assistant.", "A 30-question evaluation set.", "Admin guide and recorded walkthrough."],
      acceptanceCriteria: [
        "On the 30-question evaluation set, at least 85% of answers are correct and cite the source document.",
        "People only receive answers from documents they are allowed to open.",
        "When no document supports an answer, the assistant says it doesn't know.",
        "Documents added to the agreed folder become searchable within 24 hours.",
        "The usage report shows questions asked and unanswered topics.",
      ],
      milestones: [
        { title: "Sources and evaluation set", description: "Document source, permissions and 30 test questions agreed." },
        { title: "Build and tuning", description: "Indexing, permissions and chat interface built and tuned." },
        { title: "Acceptance and rollout", description: "Evaluation run; rollout to a pilot group." },
      ],
      assumptions: ["Documents are digital and reasonably current.", "One document source."],
      clientResponsibilities: [...STANDARD_RESPONSIBILITIES, "Provide a reviewer to grade the evaluation set."],
      risks: ["Outdated documents produce outdated answers; the usage report surfaces them."],
    },
  },
  {
    slug: "custom",
    title: "Custom automation",
    tagline: "Something else that eats your team's time. We scope it with you.",
    examples: ["Syncing two systems", "Automating a multi-step approval", "Scheduling or dispatch workflows"],
    keywords: [],
    hoursLow: 20,
    hoursHigh: 40,
    complexity: "medium",
    skills: ["Workflow automation", "API integration"],
    scope: {
      objectives: ["Automate the workflow described in the request, end to end, in your own systems."],
      inScope: [
        "Discovery session to confirm steps, systems and edge cases.",
        "Build of the agreed automation in your own accounts.",
        "Error alerts to a named owner.",
      ],
      outOfScope: ["Replacing core business systems.", "Work not listed in scope."],
      deliverables: ["Working automation.", "Runbook and recorded walkthrough."],
      acceptanceCriteria: [
        "The automation completes the agreed workflow for 5 test cases agreed at kickoff without manual steps.",
        "Every failure sends an alert to the named owner within 5 minutes.",
        "Your named owner can pause and restart the automation using the runbook alone.",
      ],
      milestones: [
        { title: "Discovery and access", description: "Steps, systems, edge cases and test cases agreed." },
        { title: "Build and test", description: "Automation built and tested against the test cases." },
        { title: "Acceptance and handover", description: "Acceptance run together; runbook and walkthrough delivered." },
      ],
      assumptions: ["The systems involved offer API, email or file-based access."],
      clientResponsibilities: STANDARD_RESPONSIBILITIES,
      risks: ["Systems without an API may need a different approach or a higher estimate."],
    },
  },
];

export function getOutcome(slug: string | null | undefined): OutcomeTemplate | undefined {
  return OUTCOMES.find((o) => o.slug === slug);
}

export const CUSTOM_OUTCOME = OUTCOMES.find((o) => o.slug === "custom")!;
