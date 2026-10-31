import {
  bareLink,
  CAREERS_EMAIL,
  CAREERS_PATH,
  DECISION_MAKER,
  digits,
  FILE_NAME,
  knownLinks,
  LINKISH,
  NAMED_BY_OTHERS,
  norm,
  pageDetails,
  phonesIn,
  quoteOnPage,
  urlKey,
  type ServedPages,
} from "../research/agent";
import { approvedSourceFor, isBlockedDomain, type PageResult, type ReadScope } from "../research/fetcher";
import { sameSite } from "../research/html";
import type { CompanyReport } from "./company";
import type { AiCategory, EvidenceCategory } from "./contract";
import type { IndustryReport } from "./industry";
import type { Claim, ProposedSource } from "./protocol";

// The automated checks for mission reports (docs/m2b/AUTHORIZATION.md, Evidence and verification). They run against
// the pages this mission was served, while their text is still in memory, and they can only move a claim down: a
// claim that fails becomes "unsupported", and its original category stays on record. Nothing here can create a
// customer-confirmed problem, a customer-reported figure or a validated impact.

export type ClaimVerdict =
  | "found"
  | "found in page details"
  | "found on another page"
  | "not found"
  | "source not read"
  | "no quote"
  | "source not approved"
  | "not company evidence"
  | "not checked";

export interface ClaimCheck {
  where: string;
  statement: string;
  category: AiCategory;
  finalCategory: EvidenceCategory;
  sourceUrl: string | null;
  quote: string | null;
  verdict: ClaimVerdict;
  foundOn?: string;
  /** The approved source a cited page belongs to; null for the company's own site. */
  sourceKey: string | null;
  /** Why the claim was moved down, in plain words. */
  reasons: string[];
  /** A dated passage more than 12 months old that the claim rests on. */
  staleSince?: string;
  /** Set by Claude review, when it ran. */
  review?: { verdict: "supported" | "overstated" | "unsupported" | "source changed"; note: string };
}

export interface ChannelCheck {
  kind: string;
  value: string;
  sourceUrl: string;
  verdict: "found" | "found on another page" | "not found" | "source not read";
  foundOn?: string;
}

export type MissionFlagRule =
  | "link not on a page read"
  | "inference without a source read"
  | "person not presented as owner or manager"
  | "careers address"
  | "channel on a blocked site"
  | "source outside the approved list"
  | "revenue impact claimed"
  | "possibly stale"
  | "proposed source not linked from a page read";

export interface MissionFlag {
  rule: MissionFlagRule;
  where: string;
  detail: string;
}

/** Flags that breach a rule and so stop a mission from completing; the others are information. */
const BREACHES: MissionFlagRule[] = [
  "link not on a page read",
  "inference without a source read",
  "person not presented as owner or manager",
  "careers address",
  "channel on a blocked site",
  "revenue impact claimed",
];

export interface MissionChecks {
  claims: ClaimCheck[];
  channels: ChannelCheck[];
  flags: MissionFlag[];
  /** Proposed sources that a page read actually links to; the others are dropped and flagged. */
  proposedSources: ProposedSource[];
  summary: {
    claims: number;
    quoted: number;
    quotedFailed: number;
    downgraded: number;
    hypotheses: number;
    inferences: number;
    identityFailed: boolean;
    stale: number;
    gaps: number;
  };
  /** Why the mission can't complete as it stands; empty when the checks pass. */
  needsReview: string[];
}

export interface CheckContext {
  scope: ReadScope;
  /** Mission A: company-specific sections must cite the company's own site. */
  companySite: string | null;
  now: Date;
}

const QUOTED: AiCategory[] = ["verified_fact", "observed_defect"];

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2},\\s+)?((?:19|20)\\d{2})\\b`, "gi"),
  /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g,
  /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/g,
];
const DATED_LINE = /\b(last updated|updated|posted|published|revised|effective|as of|copyright)\b|©|\(c\)/i;

/** The latest date written in a text, as a day, or null when it names none. */
export function latestDate(text: string): Date | null {
  let best: Date | null = null;
  const consider = (d: Date) => {
    if (!Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  };
  for (const re of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (re === DATE_PATTERNS[0]) consider(new Date(`${m[1]} ${m[2] ? m[2].replace(",", "").trim() : "1"}, ${m[3]}`));
      else if (re === DATE_PATTERNS[1]) consider(new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`));
      else consider(new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T00:00:00Z`));
    }
  }
  return best;
}

const COPYRIGHT_YEAR = /(?:©|\(c\)|copyright)\s*(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})\b/gi;

/**
 * When a page says it was last updated, posted or published, the latest such date; a copyright year counts as the
 * end of that year. Null when the page doesn't say.
 */
export function pageDate(text: string): Date | null {
  let best: Date | null = null;
  const consider = (d: Date | null) => {
    if (d && !Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  };
  for (const line of text.split(/(?<=[.!?])\s+|\n/)) {
    if (!DATED_LINE.test(line)) continue;
    consider(latestDate(line));
    for (const m of line.matchAll(COPYRIGHT_YEAR)) consider(new Date(`${m[1]}-12-31T00:00:00Z`));
  }
  return best;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const REVENUE_IMPACT =
  /\b(los(?:e|es|ing|t)|miss(?:es|ed|ing)?|leak(?:s|ed|ing)?|costs?|costing|forfeit\w*)\b[^.;]{0,60}\b(revenue|sales|income|jobs|customers|deals|money|business)\b|\b(revenue|sales|income)\s+(loss|leak\w*)\b|\bleft on the table\b|\b\d+%\s+(more|increase in|growth in)\s+(revenue|sales)\b/i;

/** True when the text claims a financial impact; only a customer can say that, in discovery. */
export function claimsRevenueImpact(text: string): boolean {
  return REVENUE_IMPACT.test(text);
}

function readablePage(served: ServedPages, url: string | null): PageResult | null {
  const page = url ? served.get(urlKey(url)) : undefined;
  return page?.record.outcome === "ok" && page.inventory ? page : null;
}

function readablePages(served: ServedPages): PageResult[] {
  return [...new Map([...served.values()].filter((p) => p.record.outcome === "ok" && p.inventory).map((p) => [p.record.finalUrl, p])).values()];
}

const quoteOn = (quote: string, page: PageResult) => quoteOnPage(quote, page.inventory!.text) || quoteOnPage(quote, pageDetails(page));

/** Checks one claim; `companyOnly` sections must cite the company's own site for facts and defects. */
function checkClaim(where: string, c: Claim, served: ServedPages, ctx: CheckContext, companyOnly: boolean): ClaimCheck {
  const reasons: string[] = [];
  const sourceKey = c.sourceUrl ? (approvedSourceFor(c.sourceUrl, ctx.scope)?.key ?? null) : null;
  const onCompanySite = Boolean(c.sourceUrl && ctx.scope.siteRoot && sameSite(c.sourceUrl, ctx.scope.siteRoot));
  const inScope = onCompanySite || Boolean(sourceKey);
  const page = readablePage(served, c.sourceUrl);
  let verdict: ClaimVerdict = "not checked";
  let foundOn: string | undefined;
  let staleSince: string | undefined;

  if (c.sourceUrl && !inScope) {
    verdict = "source not approved";
    reasons.push("It cites a page outside the company's site and the approved sources.");
  } else if (QUOTED.includes(c.category)) {
    if (!c.sourceUrl) {
      verdict = "source not read";
      reasons.push("A fact or defect needs a page read in this mission.");
    } else if (companyOnly && ctx.companySite && !onCompanySite) {
      verdict = "not company evidence";
      reasons.push("An industry source describes the industry, not this company.");
    } else if (!c.quote?.trim()) {
      verdict = "no quote";
      reasons.push("It has no quote to check.");
    } else if (!page) {
      verdict = "source not read";
      reasons.push("The page it cites wasn't read in this mission.");
    } else if (quoteOnPage(c.quote, page.inventory!.text)) verdict = "found";
    else if (quoteOnPage(c.quote, pageDetails(page))) verdict = "found in page details";
    else {
      foundOn = readablePages(served).find((p) => p.record.finalUrl !== page.record.finalUrl && quoteOn(c.quote!, p))?.record.finalUrl;
      verdict = foundOn ? "found on another page" : "not found";
      reasons.push(foundOn ? `The quote is on ${foundOn}, not the page cited.` : "The quote isn't on the page cited.");
    }
    if (page && (verdict === "found" || verdict === "found in page details")) {
      const dated = (c.quote ? latestDate(c.quote) : null) ?? pageDate(page.inventory!.text);
      if (dated && ctx.now.getTime() - dated.getTime() > YEAR_MS) staleSince = dated.toISOString().slice(0, 10);
    }
  } else if (c.category === "supported_inference") {
    if (!page) {
      verdict = "source not read";
      reasons.push("An inference must cite a page read in this mission.");
    } else verdict = "found";
  } else {
    // An industry hypothesis needs no source; one it does cite must at least have been read.
    if (c.sourceUrl && !page) {
      verdict = "source not read";
      reasons.push("The page it cites wasn't read in this mission.");
    }
  }
  const failed = reasons.length > 0;
  return {
    where,
    statement: c.statement,
    category: c.category,
    finalCategory: failed ? "unsupported" : c.category,
    sourceUrl: c.sourceUrl,
    quote: c.quote,
    verdict,
    ...(foundOn ? { foundOn } : {}),
    sourceKey,
    reasons,
    ...(staleSince ? { staleSince } : {}),
  };
}

function channelChecks(channels: CompanyReport["contacts"]["channels"], served: ServedPages): ChannelCheck[] {
  const channelOn = (ch: { kind: string; value: string }, page: PageResult): boolean => {
    const inv = page.inventory!;
    const details = pageDetails(page);
    if (ch.kind === "phone") {
      const want = digits(ch.value);
      return want.length === 10 && [...phonesIn(inv.text), ...phonesIn(details)].some((p) => digits(p) === want);
    }
    if (ch.kind === "web form") return inv.forms.length > 0 || inv.frameSources.length > 0;
    return norm(inv.text).includes(norm(ch.value)) || norm(details).includes(norm(ch.value));
  };
  return channels.map((ch) => {
    const page = readablePage(served, ch.sourceUrl);
    if (!page) return { ...ch, verdict: "source not read" as const };
    if (channelOn(ch, page)) return { ...ch, verdict: "found" as const };
    const foundOn = readablePages(served).find((p) => p.record.finalUrl !== page.record.finalUrl && channelOn(ch, p))?.record.finalUrl;
    return foundOn ? { ...ch, verdict: "found on another page" as const, foundOn } : { ...ch, verdict: "not found" as const };
  });
}

/** Proposed sources must be linked from a page read; the page details list the other hosts each page references. */
function checkProposed(proposed: ProposedSource[], served: ServedPages, flags: MissionFlag[]): ProposedSource[] {
  const pages = readablePages(served);
  const kept: ProposedSource[] = [];
  proposed.forEach((p, i) => {
    let host = "";
    try {
      host = new URL(p.url).hostname.toLowerCase();
    } catch {
      // not a URL
    }
    const linked = host && !isBlockedDomain(host) && pages.some((page) => pageDetails(page).toLowerCase().includes(host.replace(/^www\./, "")));
    if (linked) kept.push(p);
    else flags.push({ rule: "proposed source not linked from a page read", where: `evidence.proposedSources.${i}`, detail: p.url });
  });
  return kept;
}

function linkFlags(report: unknown, served: ServedPages, website: string, flags: MissionFlag[]) {
  const known = knownLinks(served, website);
  const findLinks = (value: unknown, where: string) => {
    if (where === "evidence.proposedSources") return; // checked on its own
    if (typeof value === "string") {
      for (const [raw] of value.matchAll(LINKISH)) {
        if (!/^https?:/i.test(raw) && !raw.includes("/") && FILE_NAME.test(raw)) continue;
        const link = bareLink(raw);
        if (link && !known.includes(link)) flags.push({ rule: "link not on a page read", where, detail: raw });
      }
    } else if (Array.isArray(value)) value.forEach((v, i) => findLinks(v, `${where}.${i}`));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) findLinks(v, where ? `${where}.${k}` : k);
  };
  findLinks(report, "");
}

function revenueFlags(texts: [string, string][], flags: MissionFlag[]) {
  for (const [where, text] of texts) if (claimsRevenueImpact(text)) flags.push({ rule: "revenue impact claimed", where, detail: text.slice(0, 160) });
}

function finish(claims: ClaimCheck[], channels: ChannelCheck[], flags: MissionFlag[], proposedSources: ProposedSource[], gaps: number): MissionChecks {
  for (const c of claims) {
    if (c.category === "supported_inference" && c.verdict === "source not read") flags.push({ rule: "inference without a source read", where: c.where, detail: c.statement.slice(0, 160) });
    if (c.verdict === "source not approved") flags.push({ rule: "source outside the approved list", where: c.where, detail: c.sourceUrl ?? "" });
    if (c.staleSince) flags.push({ rule: "possibly stale", where: c.where, detail: `Rests on content dated ${c.staleSince}.` });
  }
  const quoted = claims.filter((c) => QUOTED.includes(c.category));
  const quotedFailed = quoted.filter((c) => c.finalCategory === "unsupported").length;
  const identityFailed = claims.some((c) => c.where.startsWith("identity.") && QUOTED.includes(c.category) && c.finalCategory === "unsupported");
  const needsReview: string[] = [];
  if (identityFailed) needsReview.push("An identity claim failed its check.");
  if (quoted.length && quotedFailed / quoted.length > 0.2) needsReview.push(`${quotedFailed} of ${quoted.length} quoted claims failed their checks (more than one in five).`);
  const breaches = flags.filter((f) => BREACHES.includes(f.rule));
  if (breaches.length) needsReview.push(`${breaches.length} rule ${breaches.length === 1 ? "breach" : "breaches"}: ${[...new Set(breaches.map((b) => b.rule))].join(", ")}.`);
  return {
    claims,
    channels,
    flags,
    proposedSources,
    summary: {
      claims: claims.length,
      quoted: quoted.length,
      quotedFailed,
      downgraded: claims.filter((c) => c.finalCategory === "unsupported").length,
      hypotheses: claims.filter((c) => c.category === "industry_hypothesis").length,
      inferences: claims.filter((c) => c.category === "supported_inference").length,
      identityFailed,
      stale: claims.filter((c) => c.staleSince).length,
      gaps,
    },
    needsReview,
  };
}

export function checkCompanyReport(report: CompanyReport, served: ServedPages, ctx: CheckContext): MissionChecks {
  const claims: ClaimCheck[] = [];
  const add = (where: string, c: Claim, companyOnly: boolean) => claims.push(checkClaim(where, c, served, ctx, companyOnly));
  report.identity.claims.forEach((c, i) => add(`identity.claims.${i}`, c, true));
  report.industry.claims.forEach((c, i) => add(`industry.claims.${i}`, c, true));
  report.operationalProfile.claims.forEach((c, i) => add(`operationalProfile.claims.${i}`, c, true));
  report.software.forEach((s, i) => add(`software.${i}.evidence`, s.evidence, true));
  report.processes.forEach((c, i) => add(`processes.${i}`, c, true));
  report.technicalIssues.forEach((c, i) => add(`technicalIssues.${i}`, c, true));
  report.hypotheses.forEach((c, i) => add(`hypotheses.${i}`, c, false));
  // People are claims about the company too: their words must be on the company's own pages.
  report.contacts.people.forEach((p, i) =>
    add(`contacts.people.${i}`, { statement: `${p.name}, ${p.role}`, category: "verified_fact", sourceUrl: p.sourceUrl, quote: p.quote, basis: null }, true),
  );

  const flags: MissionFlag[] = [];
  report.contacts.people.forEach((p, i) => {
    if (!DECISION_MAKER.test(p.role) || NAMED_BY_OTHERS.test(p.role)) {
      flags.push({ rule: "person not presented as owner or manager", where: `contacts.people.${i}`, detail: `${p.name}, ${p.role}` });
    }
  });
  report.contacts.channels.forEach((ch, i) => {
    if (CAREERS_EMAIL.test(ch.value.trim()) || CAREERS_PATH.test(ch.value)) flags.push({ rule: "careers address", where: `contacts.channels.${i}`, detail: ch.value });
    const host = /^https?:\/\//i.test(ch.value) ? new URL(ch.value).hostname : ch.value.includes("@") ? (ch.value.split("@")[1] ?? "") : "";
    if (host && isBlockedDomain(host)) flags.push({ rule: "channel on a blocked site", where: `contacts.channels.${i}`, detail: ch.value });
  });
  linkFlags(report, served, ctx.companySite ?? "", flags);
  revenueFlags(
    [
      ...claims.map((c) => [c.where, c.statement] as [string, string]),
      ...report.possibleSolutions.map((s, i) => [`possibleSolutions.${i}`, `${s.solution} ${s.why}`] as [string, string]),
      ["operationalProfile.summary", report.operationalProfile.summary],
    ],
    flags,
  );
  const proposed = checkProposed(report.evidence.proposedSources, served, flags);
  return finish(claims, channelChecks(report.contacts.channels, served), flags, proposed, report.evidence.gaps.length);
}

export function checkIndustryReport(report: IndustryReport, served: ServedPages, ctx: CheckContext): MissionChecks {
  const claims: ClaimCheck[] = [];
  const add = (where: string, c: Claim) => claims.push(checkClaim(where, c, served, ctx, false));
  report.operations.claims.forEach((c, i) => add(`operations.claims.${i}`, c));
  report.workflows.forEach((w, i) => w.claims.forEach((c, j) => add(`workflows.${i}.claims.${j}`, c)));
  report.bottlenecks.forEach((c, i) => add(`bottlenecks.${i}`, c));
  report.software.forEach((s, i) => add(`software.${i}.evidence`, s.evidence));
  report.regulatory.forEach((r, i) => add(`regulatory.${i}.claim`, r.claim));
  report.improvements.forEach((m, i) => add(`improvements.${i}.basis`, m.basis));
  const flags: MissionFlag[] = [];
  linkFlags(report, served, "", flags);
  revenueFlags(
    [
      ...claims.map((c) => [c.where, c.statement] as [string, string]),
      ...report.improvements.map((m, i) => [`improvements.${i}`, `${m.conventional} ${m.ai}`] as [string, string]),
      ...report.services.map((s, i) => [`services.${i}`, `${s.description} ${s.problem}`] as [string, string]),
      ["operations.summary", report.operations.summary],
    ],
    flags,
  );
  const proposed = checkProposed(report.evidence.proposedSources, served, flags);
  return finish(claims, [], flags, proposed, report.evidence.gaps.length);
}
