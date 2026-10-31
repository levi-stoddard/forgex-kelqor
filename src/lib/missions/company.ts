import { z } from "zod";
import { INDUSTRY_LABELS, discoveryQuestions } from "../playbooks";
import { SOLUTION_RUNGS } from "../domain/types";
import type { PageResult } from "../research/fetcher";
import { PROTOCOLS } from "./contract";
import { approvedSourcesText, Claim, EVIDENCE_RULES, Evidence, formatPage, MAX_MISSION_PAGES, type ApprovedSourceBrief } from "./protocol";

// Mission A: company research protocol v2.0, a general protocol for any industry. It draws on the industry's
// playbook and on industry intelligence the owner reviewed, prepares discovery, and never drafts outreach.

export const COMPANY_PROTOCOL = PROTOCOLS.company_research;

export const CompanyReportSchema = z.object({
  identity: z.object({ name: z.string(), location: z.string(), claims: z.array(Claim) }).describe("1. Verified identity: who the company is and where it operates"),
  industry: z
    .object({ industry: z.string().describe(`One of: ${INDUSTRY_LABELS.join("; ")}`), activities: z.array(z.string()), claims: z.array(Claim) })
    .describe("2. Industry and principal activities"),
  operationalProfile: z
    .object({ summary: z.string(), claims: z.array(Claim) })
    .describe("3. Operational profile: services, service area, hours, size signals and how customers reach them"),
  software: z
    .array(z.object({ product: z.string(), purpose: z.string(), evidence: Claim }))
    .describe("4. Existing software and online tools that the pages show"),
  processes: z.array(Claim).describe("5. Observable processes: how requests, quotes, scheduling, orders or payments visibly work"),
  technicalIssues: z.array(Claim).describe("6. Observed technical issues and inconsistencies, as observed_defect claims, with no claim of impact"),
  hypotheses: z.array(Claim).describe("7. Industry-informed hypotheses: likely operational problems to ask about, each an industry_hypothesis"),
  notVisible: z.array(z.string()).describe("8. What public information can't show"),
  possibleSolutions: z
    .array(
      z.object({
        addresses: z.string().describe("The hypothesis or observed defect it would address"),
        rung: z.enum(SOLUTION_RUNGS),
        solution: z.string(),
        why: z.string(),
        confirmFirst: z.string().describe("What discovery must confirm before this is worth proposing"),
      }),
    )
    .describe("9. Possible solutions, simplest first: a feature they already own, then configuration, then an integration, managed AI last"),
  discoveryQuestions: z.array(z.string()).describe("10. Discovery questions for this company"),
  contacts: z
    .object({
      channels: z.array(z.object({ kind: z.enum(["phone", "email", "web form", "other"]), value: z.string(), sourceUrl: z.string() })),
      people: z.array(z.object({ name: z.string(), role: z.string(), sourceUrl: z.string(), quote: z.string() })),
    })
    .describe("11. Business contact channels; named people only when the company's own site presents them as owners or managers"),
  evidence: Evidence.describe("12. Sources used, limitations, source gaps and proposed sources"),
});
export type CompanyReport = z.infer<typeof CompanyReportSchema>;

export function companyReportJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(CompanyReportSchema) as Record<string, unknown>;
  return schema;
}

export function companySystemPrompt(): string {
  return `You are KELQOR's company researcher. KELQOR is a managed-AI services company. Your report prepares a discovery conversation with one business: what it does, how it visibly operates, which software it shows, what can be observed on its public pages, and which questions are worth asking. It never qualifies, scores or contacts the business.

Protocol ${COMPANY_PROTOCOL}. Read the company's own website (at most ${MAX_MISSION_PAGES} pages in all) and, where useful, the approved sources listed in the brief, which describe the company's industry in general. Industry sources inform hypotheses; they are never evidence about this particular company.

${EVIDENCE_RULES}

Contact channels: business-level only: the main phone, a contact form, a general email address. Name a person only when the company's own site presents them as an owner or manager, and quote the words that say so. Never use social media, review sites, job boards or careers addresses.

Possible solutions start with the simplest: a feature of software the company already uses, then configuration, then an integration, and managed AI only where nothing simpler would do. Each says what discovery must confirm first.

Return only the JSON report, following the schema.`;
}

export interface CompanyBriefInput {
  name: string;
  website: string;
  town: string;
  state: string;
  industry: string | null;
  sources: ApprovedSourceBrief[];
  /** Summaries of industry intelligence versions the owner reviewed; never unreviewed ones. */
  intelligence: string[];
}

export function companyBrief(input: CompanyBriefInput, homepage: PageResult | null): string {
  const questions = discoveryQuestions(input.industry)
    .map((q) => `- ${q.text}`)
    .join("\n");
  const homepageText = homepage
    ? `KELQOR's page reader has already read the homepage:\n\n${formatPage(homepage)}`
    : "The homepage could not be read, so there is no company page to work from. Report the gaps this leaves.";
  return `Company to research:
- Name: ${input.name}
- Town: ${input.town}, ${input.state}
- Official website: ${input.website}
- Industry: ${input.industry ?? "not set; identify it from the pages"}

Approved sources for this industry:
${approvedSourcesText(input.sources)}

Reviewed industry intelligence (context for hypotheses only):
${input.intelligence.length ? input.intelligence.map((i) => `- ${i}`).join("\n") : "(none reviewed yet)"}

Discovery questions KELQOR asks in this industry (adapt them to this company):
${questions}

${homepageText}

Read the other pages you need with read_page, then return the report.`;
}
