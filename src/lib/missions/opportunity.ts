import type { DossierClaim, DossierDetail, EvidenceStatus } from "../research/dossiers";
import type { CompanyReport } from "./company";
import type { ClaimCheck, ChannelCheck, MissionChecks } from "./evidence";
import type { ResearchVersionView } from "./results";

// A company research version from a mission (protocol v2.0), in the shape the Opportunity Center already shows, so a
// company researched for the first time gets its own entry and the owner's decisions, checks and discovery records
// work for it exactly as in M2A. Its evidence keeps the checks' verdicts; nothing here raises a claim.

export const NEW_COMPANY_ID = /^n\d{4}$/;

function evidenceOf(c: ClaimCheck): EvidenceStatus {
  if (c.finalCategory === "unsupported") return c.category === "industry_hypothesis" ? "hypothesis" : "not-confirmed";
  if (c.category === "supported_inference") return "inference";
  if (c.category === "industry_hypothesis") return "hypothesis";
  if (c.verdict === "found in page details") return "verified-in-details";
  if (c.verdict === "found on another page") return "on-another-page";
  return "verified";
}

function claimOf(c: ClaimCheck): DossierClaim {
  const label: DossierClaim["label"] = c.category === "supported_inference" ? "inference" : c.category === "industry_hypothesis" ? "hypothesis" : "fact";
  return { statement: c.statement, label, sourceUrl: c.sourceUrl, quote: c.quote, evidence: evidenceOf(c), foundOn: c.foundOn ?? null, reviewNote: c.reasons.join(" ") || null };
}

const SECTIONS: [string, string, string][] = [
  // [section in the v2.0 checks, key in the Opportunity Center, title]
  ["identity", "identity", "Identity"],
  ["industry", "industry", "Industry"],
  ["operationalProfile", "operationalProfile", "Operational profile"],
  ["processes", "processes", "Observable processes"],
  // Observed defects are the possible problems a customer can confirm, as opportunity evidence was in M2A.
  ["technicalIssues", "opportunityEvidence", "Observed technical issues"],
];

export function dossierFromResearch(v: ResearchVersionView, missionLabel: string): DossierDetail {
  const report = v.report as unknown as CompanyReport;
  const checks = v.checks as unknown as MissionChecks;
  const bySection = (name: string) => checks.claims.filter((c) => c.where.split(".")[0] === name);
  const software = (report.software ?? []).map((s, i) => {
    const check = checks.claims.find((c) => c.where === `software.${i}.evidence`);
    return { product: s.product, purpose: s.purpose, evidence: check ? claimOf(check) : { statement: s.evidence.statement, label: "hypothesis" as const, sourceUrl: null, quote: null, evidence: "hypothesis" as const, foundOn: null, reviewNote: null } };
  });
  const people = (report.contacts?.people ?? []).map((p, i) => {
    const check = checks.claims.find((c) => c.where === `contacts.people.${i}`);
    return { name: p.name, role: p.role, sourceUrl: p.sourceUrl, quote: p.quote, evidence: check ? evidenceOf(check) : ("not-confirmed" as const) };
  });
  const channels = (checks.channels ?? []).map((ch: ChannelCheck) => ({ kind: ch.kind, value: ch.value, sourceUrl: ch.sourceUrl, verdict: ch.verdict, reviewNote: null }));
  const quoted = checks.claims.filter((c) => c.category === "verified_fact" || c.category === "observed_defect");
  return {
    id: v.companyKey,
    name: v.companyName,
    town: v.town,
    state: v.state,
    website: v.website,
    access: "full",
    status: "completed",
    category: null,
    rationale: "Company research v2.0 prepares discovery. It doesn't qualify, score or rank a company.",
    offerNames: (report.possibleSolutions ?? []).map((s) => s.solution).slice(0, 5),
    researchIndustry: report.industry?.industry ?? v.industry ?? "",
    facts: quoted.length,
    quotesVerified: quoted.filter((c) => c.finalCategory !== "unsupported").length,
    flags: checks.flags?.length ?? 0,
    costUsd: v.costMicros / 1e6,
    researchedAt: v.createdAt,
    accessNote: null,
    identity: { name: report.identity?.name ?? v.companyName, location: report.identity?.location ?? `${v.town}, ${v.state}` },
    industry: { industry: report.industry?.industry ?? "", activities: report.industry?.activities ?? [] },
    officialWebsite: v.website,
    claimSections: SECTIONS.map(([section, key, title]) => ({ key, title, claims: bySection(section).map(claimOf) })).filter((s) => s.claims.length > 0),
    software,
    licensingLimitations: "",
    // Industry-informed hypotheses are the problems research predicts; no check can confirm them.
    problems: (report.hypotheses ?? []).map((h) => ({ problem: h.statement, label: "hypothesis" as const, basis: h.basis ?? "" })),
    existingSolutions: [],
    offers: [],
    feasibility: { rating: "not applicable", explanation: "Not part of company research v2.0." },
    aiDelivery: { rating: "not applicable", explanation: "Not part of company research v2.0." },
    humanReview: [],
    risks: [],
    commercial: { supportable: false, value: null, implementationCost: null, assumptions: [] },
    contacts: { roles: [], people, channels },
    discovery: { questions: report.discoveryQuestions ?? [], outreachSubject: "", outreachBody: "" },
    limitations: [
      ...(report.notVisible ?? []).map((n) => `Not visible publicly: ${n}`),
      ...(report.evidence?.limitations ?? []),
      ...(report.evidence?.gaps ?? []).map((g) => `Gap: ${g.missing} (would settle it: ${g.wouldSettle})`),
    ],
    checks: null,
    ruleFlags: (checks.flags ?? []).map((f) => ({ ...f, reviewNote: null })) as unknown as DossierDetail["ruleFlags"],
    sources: (v.sources as { url: string; finalUrl: string; outcome: string; status: number | null; retrievedAt: string; sha256: string | null }[]).map((s) => ({
      url: s.url,
      finalUrl: s.finalUrl,
      outcome: s.outcome,
      status: s.status,
      retrievedAt: s.retrievedAt,
      sha256: s.sha256,
    })),
    run: { model: `${v.model} (${missionLabel})`, startedAt: v.createdAt, finishedAt: v.createdAt, turns: 0, costUsd: v.costMicros / 1e6 },
    review: null,
  };
}
