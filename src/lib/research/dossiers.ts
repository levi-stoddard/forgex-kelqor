import fs from "node:fs";
import path from "node:path";
import type { CompanyRunRecord, QuoteCheck, RuleFlag } from "./agent";
import type { ReportClaim, ResearchReport } from "./schema";

// Read-only views of saved research for the owner's Opportunity Center. The files under research/ are never
// written here: dataset B is frozen at tag dataset-b-v1, and decisions live in the database instead.

/** The saved research the Opportunity Center shows: the owner's provisional primary model on the full benchmark. */
export const DOSSIER_SOURCE = {
  id: "benchmark-2026-gemini/full-run/gemini-4-argon",
  label: "Gemini 4 Argon, full benchmark",
  dataset: "Dataset B, frozen at tag dataset-b-v1",
  stage: "full-run",
  model: "gemini-4-argon",
} as const;

export type QualificationCategory = ResearchReport["qualification"]["category"];

/** How well a statement is supported: a fact's quote checked at run time, or the label the model gave it. */
export type EvidenceStatus = "verified" | "verified-in-details" | "on-another-page" | "not-confirmed" | "inference" | "hypothesis";

export interface DossierClaim {
  statement: string;
  label: ReportClaim["label"];
  sourceUrl: string | null;
  quote: string | null;
  evidence: EvidenceStatus;
  foundOn: string | null;
  /** The independent review's verdict on a quote the run-time check couldn't confirm (dataset C). */
  reviewNote: string | null;
}

export interface DossierSummary {
  id: string;
  name: string;
  town: string;
  state: string;
  website: string;
  access: "full" | "restricted";
  status: CompanyRunRecord["status"];
  category: QualificationCategory | null;
  rationale: string;
  offerNames: string[];
  /** The industry the report itself describes, e.g. "Custom Metal Fabrication and Manufacturing". */
  researchIndustry: string;
  facts: number;
  quotesVerified: number;
  flags: number;
  costUsd: number;
  researchedAt: string;
}

export interface DossierDetail extends DossierSummary {
  accessNote: string | null;
  identity: { name: string; location: string };
  industry: { industry: string; activities: string[] };
  officialWebsite: string;
  claimSections: { key: string; title: string; claims: DossierClaim[] }[];
  software: { product: string; purpose: string; evidence: DossierClaim }[];
  licensingLimitations: string;
  problems: ResearchReport["problems"];
  existingSolutions: ResearchReport["existingSolutions"];
  offers: ResearchReport["forgexSolutions"];
  feasibility: ResearchReport["feasibility"];
  aiDelivery: ResearchReport["aiDelivery"];
  humanReview: string[];
  risks: ResearchReport["risks"];
  commercial: ResearchReport["commercial"];
  contacts: {
    roles: string[];
    people: { name: string; role: string; sourceUrl: string; quote: string; evidence: EvidenceStatus }[];
    channels: { kind: string; value: string; sourceUrl: string; verdict: string; reviewNote: string | null }[];
  };
  discovery: ResearchReport["discovery"];
  limitations: string[];
  checks: NonNullable<CompanyRunRecord["checks"]>["summary"] | null;
  ruleFlags: (RuleFlag & { reviewNote: string | null })[];
  sources: { url: string; finalUrl: string; outcome: string; status: number | null; retrievedAt: string; sha256: string | null }[];
  run: { model: string; startedAt: string; finishedAt: string; turns: number; costUsd: number };
  review: { assessment: string | null; keyEvidence: string | null } | null;
}

const ID = /^c\d{2}$/;

export function benchmarkRoot(): string {
  return path.join(process.cwd(), "research", "benchmark-2026-gemini");
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

interface ReviewFile {
  unresolvedQuotes?: { model: string; id: string; page: string; verdict: string; note: string; run?: string }[];
  channelsNotConfirmed?: { model: string; id: string; value: string; verdict: string; note: string; run?: string }[];
  ruleFlags?: { model: string; id: string; rule: string; verdict: string; note: string }[];
  keyEvidence?: { id: string; finding: string; reportedBy?: string }[];
  qualification?: { outOfSegment?: string; restricted?: string; inSegment?: { id: string; assessment: string }[] };
}

interface Loaded {
  companies: { id: string; name: string; town: string; state: string; website: string }[];
  records: Map<string, CompanyRunRecord>;
  review: ReviewFile | null;
}

const cache = new Map<string, Loaded>();

function load(root: string): Loaded {
  const hit = cache.get(root);
  if (hit) return hit;
  const inputs = readJson(path.join(root, "inputs", "benchmark-25.json")) as { companies: Loaded["companies"] };
  const records = new Map<string, CompanyRunRecord>();
  for (const c of inputs.companies) {
    if (!ID.test(c.id)) continue;
    const file = path.join(root, DOSSIER_SOURCE.stage, DOSSIER_SOURCE.model, `${c.id}.json`);
    if (fs.existsSync(file)) records.set(c.id, readJson(file) as CompanyRunRecord);
  }
  const reviewFile = path.join(root, "evaluation", "full-run", "review.json");
  const review = fs.existsSync(reviewFile) ? (readJson(reviewFile) as ReviewFile) : null;
  const loaded = { companies: inputs.companies.filter((c) => records.has(c.id)), records, review };
  cache.set(root, loaded);
  return loaded;
}

function summarize(c: Loaded["companies"][number], r: CompanyRunRecord): DossierSummary {
  return {
    id: c.id,
    name: c.name,
    town: c.town,
    state: c.state,
    website: c.website,
    access: r.access ?? "full",
    status: r.status,
    category: r.report?.qualification.category ?? null,
    rationale: r.report?.qualification.rationale ?? r.stopReason ?? "",
    offerNames: r.report?.forgexSolutions.map((s) => s.name) ?? [],
    researchIndustry: r.report?.industry.industry ?? "",
    facts: r.checks?.summary.facts ?? 0,
    quotesVerified: r.checks?.summary.quotesFound ?? 0,
    flags: r.checks?.summary.flags ?? 0,
    costUsd: r.costUsd,
    researchedAt: r.finishedAt,
  };
}

export function listDossiers(root = benchmarkRoot()): DossierSummary[] {
  const { companies, records } = load(root);
  return companies.map((c) => summarize(c, records.get(c.id)!));
}

const sameUrl = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && a!.replace(/\/+$/, "").toLowerCase() === b!.replace(/\/+$/, "").toLowerCase();

function evidenceOf(check: QuoteCheck | undefined): Pick<DossierClaim, "evidence" | "foundOn"> {
  switch (check?.verdict) {
    case "found":
      return { evidence: "verified", foundOn: null };
    case "found in page details":
      return { evidence: "verified-in-details", foundOn: null };
    case "found on another page":
      return { evidence: "on-another-page", foundOn: check.foundOn ?? null };
    default:
      return { evidence: "not-confirmed", foundOn: null };
  }
}

export function getDossier(id: string, root = benchmarkRoot()): DossierDetail | null {
  if (!ID.test(id)) return null;
  const { companies, records, review } = load(root);
  const company = companies.find((c) => c.id === id);
  const r = records.get(id);
  if (!company || !r) return null;
  const report = r.report;
  const checks = r.checks;
  const mine = <T extends { model: string; id: string; run?: string }>(xs: T[] | undefined) =>
    (xs ?? []).filter((x) => x.model === DOSSIER_SOURCE.model && x.id === id && !x.run);

  const reviewQuotes = mine(review?.unresolvedQuotes);
  const findCheck = (quote: string | null, sourceUrl: string | null) =>
    quote ? checks?.quotes.find((q) => q.quote === quote && sameUrl(q.sourceUrl, sourceUrl)) : undefined;
  const claim = (c: ReportClaim): DossierClaim => {
    const base = { statement: c.statement, label: c.label, sourceUrl: c.sourceUrl, quote: c.quote };
    if (c.label === "hypothesis") return { ...base, evidence: "hypothesis", foundOn: null, reviewNote: null };
    if (c.label === "inference") return { ...base, evidence: "inference", foundOn: null, reviewNote: null };
    const ev = evidenceOf(findCheck(c.quote, c.sourceUrl));
    const note = ev.evidence === "not-confirmed" ? reviewQuotes.find((q) => sameUrl(q.page, c.sourceUrl)) : undefined;
    return { ...base, ...ev, reviewNote: note ? `${note.verdict}: ${note.note}` : null };
  };

  const inSegment = review?.qualification?.inSegment?.find((q) => q.id === id);
  const listed = (text: string | undefined) => (text ? new RegExp(`\\b${id}\\b`).test(text) : false);
  const assessment = inSegment?.assessment ?? (listed(review?.qualification?.outOfSegment) ? "Outside the segment: 'not a fit' is correct under the segment definition." : listed(review?.qualification?.restricted) ? "Restricted run: no facts stated and no flags, as the protocol requires." : null);
  const keyEvidence = review?.keyEvidence?.find((k) => k.id === id)?.finding ?? null;

  return {
    ...summarize(company, r),
    accessNote: r.accessNote ?? null,
    identity: { name: report?.identity.name ?? company.name, location: report?.identity.location ?? `${company.town}, ${company.state}` },
    industry: { industry: report?.industry.industry ?? "", activities: report?.industry.activities ?? [] },
    officialWebsite: report?.publicInformation.officialWebsite ?? company.website,
    claimSections: report
      ? [
          { key: "identity", title: "Identity", claims: report.identity.claims.map(claim) },
          { key: "industry", title: "Industry and activities", claims: report.industry.claims.map(claim) },
          { key: "publicInformation", title: "Public information", claims: report.publicInformation.claims.map(claim) },
          { key: "licensing", title: "Licensing and registration", claims: report.licensing.claims.map(claim) },
          { key: "opportunityEvidence", title: "Opportunity evidence", claims: report.opportunityEvidence.map(claim) },
        ]
      : [],
    software: report?.existingSoftware.map((s) => ({ product: s.product, purpose: s.purpose, evidence: claim(s.evidence) })) ?? [],
    licensingLimitations: report?.licensing.limitations ?? "",
    problems: report?.problems ?? [],
    existingSolutions: report?.existingSolutions ?? [],
    offers: report?.forgexSolutions ?? [],
    feasibility: report?.feasibility ?? { rating: "not applicable", explanation: "" },
    aiDelivery: report?.aiDelivery ?? { rating: "not applicable", explanation: "" },
    humanReview: report?.humanReview ?? [],
    risks: report?.risks ?? [],
    commercial: report?.commercial ?? { supportable: false, value: null, implementationCost: null, assumptions: [] },
    contacts: {
      roles: report?.contacts.decisionMakerRoles ?? [],
      people: (report?.contacts.people ?? []).map((p) => ({ ...p, evidence: evidenceOf(findCheck(p.quote, p.sourceUrl)).evidence })),
      channels: (report?.contacts.channels ?? []).map((ch) => {
        const check = checks?.channels.find((c) => c.value === ch.value && c.kind === ch.kind);
        const note = mine(review?.channelsNotConfirmed).find((c) => c.value === ch.value);
        return { ...ch, verdict: check?.verdict ?? "not checked", reviewNote: note ? `${note.verdict}: ${note.note}` : null };
      }),
    },
    discovery: report?.discovery ?? { questions: [], outreachSubject: "", outreachBody: "" },
    limitations: report?.evidence.limitations ?? [],
    checks: checks?.summary ?? null,
    ruleFlags: (checks?.flags ?? []).map((f) => {
      const note = mine(review?.ruleFlags).find((x) => x.rule === f.rule);
      return { ...f, reviewNote: note ? `${note.verdict}: ${note.note}` : null };
    }),
    sources: r.sources.map((s) => ({ url: s.url, finalUrl: s.finalUrl, outcome: s.outcome, status: s.status, retrievedAt: s.retrievedAt, sha256: s.sha256 })),
    run: { model: r.model, startedAt: r.startedAt, finishedAt: r.finishedAt, turns: r.turns, costUsd: r.costUsd },
    review: review ? { assessment, keyEvidence } : null,
  };
}

/** How far a research statement gets on the evidence ladder. Research alone never reaches the customer levels (4-6). */
export type EvidenceLevel = 1 | 2 | 3;

export const EVIDENCE_LEVEL_LABELS: Record<EvidenceLevel, string> = {
  1: "Verified company information",
  2: "Observed defect",
  3: "Hypothesis or unverified",
};

export interface EvidenceItem {
  /** Stable within the frozen record, e.g. "opportunityEvidence.2" or "problems.0". */
  key: string;
  level: EvidenceLevel;
  section: string;
  statement: string;
  evidence: EvidenceStatus;
  sourceUrl: string | null;
  /** A possible problem the customer can confirm or dismiss in a discovery call. */
  predictedPain: boolean;
}

const VERIFIED = new Set<EvidenceStatus>(["verified", "verified-in-details", "on-another-page"]);

/**
 * Every research statement with its level: 1 = a fact about the company whose quote was found, 2 = a defect the site
 * itself shows (an opportunity-evidence fact with its quote found), 3 = everything else: inferences, hypotheses,
 * quotes the check couldn't confirm, and the model's own list of problems, which no check ever looked at.
 */
export function evidenceItems(d: DossierDetail): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const s of d.claimSections) {
    const defects = s.key === "opportunityEvidence";
    s.claims.forEach((c, i) => {
      const verified = c.label === "fact" && VERIFIED.has(c.evidence);
      items.push({ key: `${s.key}.${i}`, level: verified ? (defects ? 2 : 1) : 3, section: s.title, statement: c.statement, evidence: c.evidence, sourceUrl: c.sourceUrl, predictedPain: defects });
    });
  }
  d.software.forEach((s, i) =>
    items.push({
      key: `software.${i}`,
      level: s.evidence.label === "fact" && VERIFIED.has(s.evidence.evidence) ? 1 : 3,
      section: "Software in use",
      statement: `${s.product}: ${s.purpose}`,
      evidence: s.evidence.evidence,
      sourceUrl: s.evidence.sourceUrl,
      predictedPain: false,
    }),
  );
  d.problems.forEach((p, i) =>
    items.push({
      key: `problems.${i}`,
      level: 3,
      section: "Problems the model predicted (never checked)",
      statement: p.problem,
      evidence: p.label === "fact" ? "not-confirmed" : p.label,
      sourceUrl: null,
      predictedPain: true,
    }),
  );
  return items;
}
