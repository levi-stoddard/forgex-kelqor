import { z } from "zod";
import { meteredRequest } from "../controls";
import type { DB } from "../db";
import { quoteOnPage, urlKey } from "../research/agent";
import type { PageResult, ReadScope, SiteFetcher } from "../research/fetcher";
import { MISSION_OUTPUT_LIMIT, ProviderFailure, SpendRefused, stateForRefusal, UnsafeReply, type MissionProvider, type MissionScope } from "./contract";
import type { MissionChecks } from "./evidence";
import { logStep } from "./steps";

// Claude review of a finished report, when the owner approved it (docs/m2b/AUTHORIZATION.md). The cited pages are
// read again through KELQOR's page reader, each read keeping its address, time, fingerprint and status; changed pages
// and missing quotes are reported. The reviewer gives each claim a verdict and can only move a claim down. If the
// review can't run or can't fit the budget, the research is kept and the mission goes to Needs review.

const PAGE_CHARS = 12_000;

export const REVIEW_VERDICTS = ["supported", "overstated", "unsupported", "source changed"] as const;

const ReviewReply = z.object({
  verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(REVIEW_VERDICTS), note: z.string() })),
  summary: z.string(),
});

export function reviewJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(ReviewReply) as Record<string, unknown>;
  return schema;
}

export interface ReviewRead {
  url: string;
  retrievedAt: string;
  outcome: string;
  textSha256: string | null;
  /** True when the page's text fingerprint differs from the one the research read. */
  changed: boolean;
}

export interface ReviewOutcome {
  finished: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  reads: ReviewReads;
  quotesStillThere: { where: string; found: boolean }[];
  verdicts: { id: string; where: string; verdict: (typeof REVIEW_VERDICTS)[number]; note: string }[];
  unsupportedFacts: number;
  countedInputTokens: number | null;
  reservedMicros: number | null;
  actualMicros: number | null;
  summary: string | null;
}
type ReviewReads = ReviewRead[];

export const REVIEW_SYSTEM = `You review a research report for KELQOR, claim by claim, against the pages it cites as they read today. For each claim give one verdict:
- supported: the cited page says it.
- overstated: the page says something narrower or weaker.
- unsupported: the page doesn't say it, or the claim has no usable source.
- source changed: the page has changed and no longer shows the quoted words.
Judge only from the page text shown. You can't raise a claim's category, add claims, or confirm any problem; only customers confirm problems. Return only the JSON.`;

export function reviewBrief(checks: MissionChecks, pages: { url: string; text: string; changed: boolean }[]): string {
  const claims = checks.claims
    .map((c, i) => `claim ${i}: [${c.finalCategory}] ${c.statement}\n  source: ${c.sourceUrl ?? "none"}\n  quote: ${c.quote ? JSON.stringify(c.quote) : "none"}`)
    .join("\n");
  const shown = pages.map((p) => `<page url="${p.url}" changed="${p.changed ? "yes" : "no"}">\n${p.text.slice(0, PAGE_CHARS)}\n</page>`).join("\n\n");
  return `Claims to review:\n${claims}\n\nThe cited pages, read again today:\n\n${shown || "(no page could be read again)"}`;
}

/** Characters of page text a review would send, for the estimate shown before approval. */
export function reviewPageChars(served: PageResult[]): number {
  return served.filter((p) => p.inventory).reduce((n, p) => n + Math.min(PAGE_CHARS, p.inventory!.text.length), 0);
}

export async function runReview(o: {
  db: DB;
  missionId: string;
  runId: string;
  scope: MissionScope;
  report: Record<string, unknown>;
  checks: MissionChecks;
  served: PageResult[];
  readScope: ReadScope;
  fetcher: SiteFetcher;
  reviewer: MissionProvider | null;
  signal: AbortSignal;
  now?: () => Date;
}): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = {
    finished: false,
    reason: null,
    provider: o.reviewer?.provider ?? null,
    model: o.reviewer?.model ?? null,
    reads: [],
    quotesStillThere: [],
    verdicts: [],
    unsupportedFacts: 0,
    countedInputTokens: null,
    reservedMicros: null,
    actualMicros: null,
    summary: null,
  };
  if (!o.reviewer) {
    outcome.reason = "Claude review is unavailable: no Anthropic key is configured.";
    await logStep(o.db, o.missionId, "review", outcome.reason);
    return outcome;
  }
  // Read each cited page again, at review time, through the page reader.
  const before = new Map(o.served.map((p) => [urlKey(p.record.finalUrl), p]));
  const cited = [...new Set(o.checks.claims.map((c) => c.sourceUrl).filter((u): u is string => Boolean(u)))];
  const fresh = new Map<string, PageResult>();
  for (const url of cited) {
    const page = await o.fetcher.fetchPage(url, o.readScope);
    const earlier = before.get(urlKey(url));
    const changed = Boolean(page.record.textSha256 && earlier?.record.textSha256 && page.record.textSha256 !== earlier.record.textSha256);
    outcome.reads.push({ url, retrievedAt: page.record.retrievedAt, outcome: page.record.outcome, textSha256: page.record.textSha256, changed });
    fresh.set(urlKey(url), page);
  }
  for (const c of o.checks.claims) {
    if (!c.quote || !c.sourceUrl) continue;
    const page = fresh.get(urlKey(c.sourceUrl));
    outcome.quotesStillThere.push({ where: c.where, found: Boolean(page?.inventory && quoteOnPage(c.quote, page.inventory.text)) });
  }
  const pages = outcome.reads
    .map((r) => ({ url: r.url, text: fresh.get(urlKey(r.url))?.inventory?.text ?? "", changed: r.changed }))
    .filter((p) => p.text);
  const stepId = await logStep(o.db, o.missionId, "review", `Claude review: ${outcome.reads.length} cited pages read again, ${outcome.reads.filter((r) => r.changed).length} changed`, {
    reads: outcome.reads,
  });
  let metered;
  try {
    metered = await meteredRequest(
      o.db,
      { missionId: o.missionId, runId: o.runId, stepId, attempt: 1, purpose: "review", now: o.now },
      o.reviewer,
      {
        system: REVIEW_SYSTEM,
        turns: [{ kind: "user", text: reviewBrief(o.checks, pages) }],
        tools: [],
        toolChoice: "none",
        outputSchema: reviewJsonSchema(),
        maxOutputTokens: MISSION_OUTPUT_LIMIT,
      },
      o.signal,
    );
  } catch (e) {
    // A run that no longer owns the mission stops without writing; the runner sees the refusal.
    if (e instanceof SpendRefused && stateForRefusal(e.reason, "review") === "none") throw e;
    if (e instanceof SpendRefused) outcome.reason = `It wasn't sent: ${e.message}`;
    else if (e instanceof ProviderFailure) outcome.reason = `The review request failed (${e.failure.kind}): ${e.failure.message}`;
    else if (e instanceof UnsafeReply) outcome.reason = e.message;
    else throw e;
    await logStep(o.db, o.missionId, "error", `Claude review didn't finish: ${outcome.reason}`);
    return outcome;
  }
  outcome.countedInputTokens = metered.countedInputTokens;
  outcome.reservedMicros = metered.reservedMicros;
  outcome.actualMicros = metered.actualMicros;
  let parsed: z.infer<typeof ReviewReply> | null = null;
  try {
    const r = ReviewReply.safeParse(JSON.parse(metered.reply.text));
    parsed = r.success ? r.data : null;
  } catch {
    parsed = null;
  }
  if (metered.reply.status !== "completed" || !parsed) {
    outcome.reason = metered.reply.status !== "completed" ? `The reviewer stopped early (${metered.reply.status}).` : "The review didn't match its format.";
    await logStep(o.db, o.missionId, "error", `Claude review didn't finish: ${outcome.reason}`);
    return outcome;
  }
  // Verdicts only ever move a claim down.
  for (const v of parsed.verdicts) {
    const claim = o.checks.claims[Number(v.id)];
    if (!claim) continue;
    claim.review = { verdict: v.verdict, note: v.note.slice(0, 500) };
    if (v.verdict === "unsupported") {
      if (claim.category === "verified_fact" && claim.finalCategory === "verified_fact") outcome.unsupportedFacts++;
      if (claim.finalCategory !== "unsupported") {
        claim.finalCategory = "unsupported";
        claim.reasons.push("Claude review found it unsupported.");
      }
    }
    outcome.verdicts.push({ id: v.id, where: claim.where, verdict: v.verdict, note: v.note.slice(0, 500) });
  }
  outcome.finished = true;
  outcome.summary = parsed.summary.slice(0, 2000);
  await logStep(o.db, o.missionId, "review", `Claude review finished: ${outcome.verdicts.filter((v) => v.verdict === "supported").length} of ${outcome.verdicts.length} supported`, {
    unsupportedFacts: outcome.unsupportedFacts,
  });
  return outcome;
}
