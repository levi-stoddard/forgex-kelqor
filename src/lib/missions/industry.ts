import { z } from "zod";
import { discoveryQuestions } from "../playbooks";
import { PROTOCOLS } from "./contract";
import { approvedSourcesText, Claim, EVIDENCE_RULES, Evidence, MAX_MISSION_PAGES, sourceStart, type ApprovedSourceBrief } from "./protocol";

// Mission B: industry research protocol v1.0. It reads approved sources only and describes how businesses in an
// industry work, where they lose time and what could help. Each version serves many companies as hypotheses to test,
// never as facts about any one business. No industry is the default.

export const INDUSTRY_PROTOCOL = PROTOCOLS.industry_research;

export const WORKFLOW_AREAS = ["scheduling", "estimating", "purchasing", "operations", "finance", "customer service", "compliance", "other"] as const;

export const IndustryReportSchema = z.object({
  scope: z.object({ industry: z.string(), category: z.string().nullable(), region: z.string().nullable() }),
  operations: z
    .object({ summary: z.string(), roles: z.array(z.string()), claims: z.array(Claim) })
    .describe("1. How these businesses operate: their usual processes and roles"),
  workflows: z
    .array(z.object({ area: z.enum(WORKFLOW_AREAS), description: z.string(), claims: z.array(Claim) }))
    .describe("2. Workflows: scheduling, estimating, purchasing, operations, finance and others"),
  bottlenecks: z.array(Claim).describe("3. Common bottlenecks and administrative burdens"),
  software: z.array(z.object({ product: z.string(), purpose: z.string(), evidence: Claim })).describe("4. Common software"),
  regulatory: z
    .array(z.object({ topic: z.string(), claim: Claim }))
    .describe("5. Regulatory and operational considerations. Research, not legal or compliance advice: each needs professional verification"),
  improvements: z
    .array(z.object({ area: z.string(), conventional: z.string(), ai: z.string(), humanReview: z.string(), basis: Claim }))
    .describe("6. What conventional automation or AI could improve, and what needs human or specialist review"),
  services: z
    .array(z.object({ name: z.string(), description: z.string(), problem: z.string(), confirmFirst: z.string() }))
    .describe("7. Managed-AI services KELQOR could realistically deliver, and what discovery must confirm first"),
  discoveryQuestions: z.array(z.string()).describe("8. Discovery questions for businesses in this industry"),
  evidence: Evidence.describe("9. Sources used, limitations, source gaps and proposed sources"),
});
export type IndustryReport = z.infer<typeof IndustryReportSchema>;

export function industryReportJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(IndustryReportSchema) as Record<string, unknown>;
  return schema;
}

export function industrySystemPrompt(): string {
  return `You are KELQOR's industry researcher. KELQOR is a managed-AI services company. Your report describes how businesses in one industry operate, which workflows burden them, which software they use and what could realistically help, so that KELQOR asks better questions in discovery. It is reused across many companies as hypotheses to test, never as facts about any one business.

Protocol ${INDUSTRY_PROTOCOL}. Read only the approved sources listed in the brief (at most ${MAX_MISSION_PAGES} pages in all), starting from the addresses given, and following their links on the same source.

${EVIDENCE_RULES}

Regulatory and compliance points are research, not legal or compliance advice: state the source and say what needs professional verification. Prefer what the sources say over general knowledge, and keep general knowledge to industry_hypothesis claims.

Return only the JSON report, following the schema.`;
}

export interface IndustryBriefInput {
  industry: string;
  category: string | null;
  region: string | null;
  sources: ApprovedSourceBrief[];
}

export function industryBrief(input: IndustryBriefInput): string {
  const questions = discoveryQuestions(input.industry)
    .map((q) => `- ${q.text}`)
    .join("\n");
  const starts = input.sources.map((s) => `- ${sourceStart(s.match)}`).join("\n");
  return `Industry to research:
- Industry: ${input.industry}
- Category or operating model: ${input.category ?? "the industry as a whole"}
- Region: ${input.region ?? "not limited"}

Approved sources:
${approvedSourcesText(input.sources)}

Start pages:
${starts || "(none: no source is approved for this industry, so report the gaps instead of researching)"}

Discovery questions KELQOR already asks in this industry:
${questions}

Read what you need with read_page, then return the report.`;
}
