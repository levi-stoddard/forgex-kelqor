import { Badge, type Tone } from "@/components/ui";
import type { EvidenceCategory, MissionStatus, MissionType } from "@/lib/missions/contract";
import { usd } from "../../lib";

// What the AI Operations screens share: money in micro-dollars, mission states, labels and request ids.

export const money = (micros: number | null | undefined, digits = 2) => (micros === null || micros === undefined ? "—" : usd(micros / 1e6, digits));
export const exact = (micros: number | null | undefined) => money(micros, 4);
export const toMicros = (dollars: string) => Math.round(Number(dollars) * 1e6);

/** A new id for one owner action; the backend acts on each id at most once. */
export const requestId = () => crypto.randomUUID();

export const TYPE_LABEL: Record<MissionType, string> = { company_research: "Company research", industry_research: "Industry research" };

const STATUS: Record<MissionStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "sky" },
  approved: { label: "Approved", tone: "sky" },
  running: { label: "Running", tone: "amber" },
  verification: { label: "Verification", tone: "amber" },
  completed: { label: "Completed", tone: "emerald" },
  completed_with_issues: { label: "Completed with issues", tone: "emerald" },
  needs_review: { label: "Needs review", tone: "amber" },
  interrupted: { label: "Interrupted", tone: "rose" },
  budget_blocked: { label: "Budget blocked", tone: "rose" },
  rejected: { label: "Rejected", tone: "neutral" },
  failed: { label: "Failed", tone: "rose" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function MissionStatusBadge({ status }: { status: MissionStatus }) {
  const s = STATUS[status];
  return (
    <span data-mission-status={status}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

/** Every mission says whether it was real or simulated, everywhere it appears. */
export function KindBadge({ simulated, provider }: { simulated: boolean; provider: string }) {
  if (simulated)
    return (
      <span data-kind="simulated" title="No AI provider is called. It costs $0, never counts toward budgets and never becomes research.">
        <Badge tone="amber">Simulated, no AI, $0</Badge>
      </span>
    );
  if (provider === "synthetic")
    return (
      <span data-kind="synthetic" title="Test only: invented costs on an isolated copy of the database.">
        <Badge tone="amber">Synthetic test costs</Badge>
      </span>
    );
  return (
    <span data-kind="real">
      <Badge tone="emerald">Real</Badge>
    </span>
  );
}

const CATEGORY: Record<EvidenceCategory, { label: string; tone: Tone; hint: string }> = {
  verified_fact: { label: "Verified fact", tone: "emerald", hint: "Its quote was found on a page read in this mission." },
  observed_defect: { label: "Observed defect", tone: "emerald", hint: "Seen on a page read; no claim of impact." },
  supported_inference: { label: "Supported inference", tone: "sky", hint: "Reasoned from cited facts or defects." },
  industry_hypothesis: { label: "Industry hypothesis", tone: "neutral", hint: "From industry knowledge: something to ask in discovery." },
  unsupported: { label: "Unsupported", tone: "rose", hint: "It failed a check: an unread source, a quote not found, or no source." },
  customer_confirmed: { label: "Customer-confirmed", tone: "emerald", hint: "Confirmed by the customer in a recorded discovery conversation." },
  customer_reported_estimate: { label: "Customer-reported estimate", tone: "amber", hint: "The customer's own figure; not validated." },
  validated_impact: { label: "Validated impact", tone: "emerald", hint: "Your calculation and its evidence." },
};

export function CategoryBadge({ category }: { category: EvidenceCategory }) {
  const c = CATEGORY[category];
  return (
    <span data-category={category} title={c.hint}>
      <Badge tone={c.tone}>{c.label}</Badge>
    </span>
  );
}

export const SECTION_LABEL: Record<string, string> = {
  identity: "Identity",
  industry: "Industry",
  operationalProfile: "Operational profile",
  software: "Software",
  processes: "Observable processes",
  technicalIssues: "Observed technical issues",
  hypotheses: "Industry-informed hypotheses",
  contacts: "Contact people",
  operations: "How these businesses operate",
  workflows: "Workflows",
  bottlenecks: "Bottlenecks and administrative burdens",
  regulatory: "Regulatory and operational considerations",
  improvements: "What automation or AI could improve",
};

export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 10) : "—");
