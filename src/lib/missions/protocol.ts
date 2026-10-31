import { z } from "zod";
import type { ToolSpec } from "../ai/types";
import type { PageResult } from "../research/fetcher";
import { formatPage } from "../research/spec";
import { AI_CATEGORIES, SOURCE_KINDS } from "./contract";

// What both mission protocols share: the claim format with its evidence categories, gaps, proposed sources and the
// page tool. The benchmark's prompt v1.3 (src/lib/research/spec.ts) stays frozen; only its page format is reused.

export const MAX_MISSION_PAGES = 20;
export const MAX_MISSION_TURNS = 14;
export const QUOTE_WORDS = 25;

export const Claim = z.object({
  statement: z.string(),
  category: z.enum(AI_CATEGORIES),
  sourceUrl: z
    .string()
    .nullable()
    .describe("A page you read in this mission: the company's own site or an approved source. Null only for an industry_hypothesis."),
  quote: z
    .string()
    .nullable()
    .describe(
      `For a verified_fact or an observed_defect: the exact words from that page (at most ${QUOTE_WORDS} words), or the page detail itself (a link, script source or form target). Otherwise null.`,
    ),
  basis: z
    .string()
    .nullable()
    .describe("For a supported_inference: the facts or defects it reasons from. For an industry_hypothesis: the industry knowledge it rests on. Otherwise null."),
});
export type Claim = z.infer<typeof Claim>;

export const Gap = z.object({
  missing: z.string().describe("What the sources couldn't establish"),
  wouldSettle: z.string().describe("What kind of source would settle it"),
});

export const ProposedSource = z.object({
  url: z.string(),
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  why: z.string(),
  foundOn: z.string().describe("The page you read that links to it"),
});
export type ProposedSource = z.infer<typeof ProposedSource>;

export const Evidence = z.object({
  sourcesUsed: z.array(z.object({ url: z.string(), usedFor: z.string() })),
  limitations: z.array(z.string()),
  gaps: z.array(Gap),
  proposedSources: z.array(ProposedSource),
});

export const MISSION_READ_PAGE_TOOL: ToolSpec = {
  name: "read_page",
  description:
    "Read one public page through KELQOR's page reader: a page on the company's own website, or on an approved source listed in the brief. Returns the page's text, its links on the same site, and technical details (script and frame sources, form targets, other hosts it references, phone and email links). Anything else, and pages that don't permit automated access, come back as unavailable; do not try to get around that. To read several pages, call it once for each page in the same turn.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Full address of a page on the company's website or an approved source." } },
    required: ["url"],
  },
};

export interface ApprovedSourceBrief {
  key: string;
  name: string;
  match: string;
  kind: string;
  purpose: string;
}

/** The address a source's pages start from: its prefix, or its domain's home page. */
export function sourceStart(match: string): string {
  return match.includes("/") ? match : `https://${match.replace(/^www\./, "")}/`;
}

export function approvedSourcesText(sources: ApprovedSourceBrief[]): string {
  if (!sources.length) return "(none approved for this industry yet)";
  return sources.map((s) => `- ${s.name} (${s.kind}): ${s.match}, starting at ${sourceStart(s.match)}. Purpose: ${s.purpose}`).join("\n");
}

export { formatPage };
export type { PageResult };

/** The rules both protocols state, in the owner's terms (docs/m2b/AUTHORIZATION.md, Evidence and verification). */
export const EVIDENCE_RULES = `Evidence categories. Give every claim exactly one:
- verified_fact: stated on a page you read in this mission. Cite that page and quote its exact words (at most ${QUOTE_WORDS}).
- observed_defect: a technical issue or inconsistency you saw on a page you read (a broken link, an error message, conflicting details). Cite the page and quote the words or the page detail. Describe what you saw, never its effect on the business.
- supported_inference: reasoned from facts or defects you cite. Name them in basis and cite the page they come from.
- industry_hypothesis: from reviewed industry intelligence or general industry knowledge, to test in a discovery conversation. It needs no source; say what it rests on in basis.
Rules:
- A claim without a page you read can only be an industry_hypothesis. Never present a hypothesis as a fact.
- Never claim that an issue caused lost revenue, lost jobs or any financial impact, and never estimate money. Only the customer can tell KELQOR that, in a discovery conversation.
- Nothing you write confirms a problem. Problems are confirmed only by the customer.
- When the sources can't establish something, add a gap saying what is missing and what kind of source would settle it. Don't fill it with a guess.
- When a page you read links to a promising public source outside the approved list (a government agency, trade association, regulator, technical resource or reputable industry publication), list it under proposedSources with the page it appeared on. Don't try to read it: it isn't approved yet.
- Read only with read_page. Never sign in, submit a form, contact anyone or draft a message to anyone.`;
