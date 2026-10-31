import path from "node:path";
import { describe, expect, it } from "vitest";
import { addServed, type ServedPages } from "@/lib/research/agent";
import { inScope, matchesSource, SiteFetcher, type ReadScope } from "@/lib/research/fetcher";
import { fixtureTransport } from "@/lib/research/fixtures";
import { companyBrief, CompanyReportSchema, companyReportJsonSchema, type CompanyReport } from "@/lib/missions/company";
import { checkCompanyReport, checkIndustryReport, claimsRevenueImpact, latestDate, pageDate } from "@/lib/missions/evidence";
import { industryBrief, IndustryReportSchema, industryReportJsonSchema } from "@/lib/missions/industry";
import { ProviderError, stateForRefusal, type SpendTicket, type TicketUse } from "@/lib/missions/contract";
import { simulatedResearcher, simulatedReviewer } from "@/lib/missions/simulated";
import { GoogleGenAI } from "@google/genai";
import { dossierFromResearch } from "@/lib/missions/opportunity";
import { evidenceItems } from "@/lib/research/dossiers";
import type { Turn } from "@/lib/ai/types";
import { countingContents, countingRequest, geminiFailure, geminiMissionProvider, restCounter } from "@/lib/ai/gemini";
import { claudeFailure, claudeUsage } from "@/lib/ai/claude";
import { sourceMatchProblem, STARTER } from "@/lib/sources/registry";
import { INDUSTRY_LABELS } from "@/lib/playbooks";

// Milestone 2B, the implementation agent's own tests: the reader's scope, local test pages, the two protocols, the evidence checks, the
// simulated providers and the adapters' failure mapping. No provider is ever reached: the adapters get fake clients.

const SITES = path.join(process.cwd(), "tests", "fixtures", "sites");
const COMPANY = "https://www.boise-fab.test/";
const SOURCE = { key: "industry-guide", match: "industry-guide.test" };

function fetcher() {
  return new SiteFetcher({ transport: fixtureTransport(SITES), minIntervalMs: 0 });
}

async function served(scope: ReadScope, urls: string[]): Promise<ServedPages> {
  const f = fetcher();
  const map: ServedPages = new Map();
  for (const u of urls) addServed(map, u, await f.fetchPage(u, scope));
  return map;
}

const fakeTicket = {} as SpendTicket;
const noRedeem = (_t: SpendTicket, _u: TicketUse) => {};

describe("the reader's scope", () => {
  it("matches a domain with its subdomains, and an address prefix", () => {
    expect(matchesSource("https://www.osha.gov/construction", "osha.gov")).toBe(true);
    expect(matchesSource("https://osha.gov/", "osha.gov")).toBe(true);
    expect(matchesSource("https://notosha.gov/", "osha.gov")).toBe(false);
    expect(matchesSource("https://www.bls.gov/ooh/production/welders.htm", "https://www.bls.gov/ooh/")).toBe(true);
    expect(matchesSource("https://www.bls.gov/cps/", "https://www.bls.gov/ooh/")).toBe(false);
  });

  it("reads the company's site and approved sources, and refuses everything else", async () => {
    const scope: ReadScope = { siteRoot: COMPANY, approved: [SOURCE] };
    expect(inScope("https://www.industry-guide.test/fabrication", scope)).toBe(true);
    const f = fetcher();
    expect((await f.fetchPage(COMPANY, scope)).record.outcome).toBe("ok");
    expect((await f.fetchPage("https://www.industry-guide.test/fabrication", scope)).record.outcome).toBe("ok");
    const off = await f.fetchPage("https://www.trade-assoc.test/members", scope);
    expect(off.record.outcome).toBe("off-site");
    expect(off.record.detail).toMatch(/approved sources/);
    expect((await f.fetchPage("https://www.linkedin.com/company/x", { siteRoot: COMPANY, approved: [{ key: "li", match: "linkedin.com" }] })).record.outcome).toBe("blocked-domain");
    // The benchmark's string form still means the company's own site only, with its original wording.
    const old = await f.fetchPage("https://www.industry-guide.test/", COMPANY);
    expect(old.record.detail).toBe("Only pages on the company's own website are read.");
  });

  it("serves local test pages without the network, and records what it served", async () => {
    const t = fixtureTransport(SITES);
    const f = new SiteFetcher({ transport: t, minIntervalMs: 0 });
    const page = await f.fetchPage("https://www.boise-fab.test/about", COMPANY);
    expect(page.record.outcome).toBe("ok");
    expect(page.inventory?.text).toMatch(/Dana Smith, owner/);
    expect((await f.fetchPage("https://www.boise-fab.test/nope", COMPANY)).record.outcome).toBe("not-found");
    expect(t.requests.every((u) => new URL(u).hostname.endsWith(".test"))).toBe(true);
  });

  it("refuses sources that are blocked, private or malformed", () => {
    expect(sourceMatchProblem("osha.gov")).toBeNull();
    expect(sourceMatchProblem("https://www.bls.gov/ooh/")).toBeNull();
    expect(sourceMatchProblem("facebook.com")).toMatch(/blocked/);
    expect(sourceMatchProblem("http://192.168.1.10/")).toMatch(/Private/);
    expect(sourceMatchProblem("not a domain")).toMatch(/Enter a domain/);
  });

  it("proposes a starter list that names only known industries and needs approval", () => {
    expect(STARTER.sources.length).toBeGreaterThan(20);
    for (const s of STARTER.sources) {
      expect(s.industries.every((i) => INDUSTRY_LABELS.includes(i))).toBe(true);
      expect(sourceMatchProblem(s.match)).toBeNull();
    }
  });
});

function companyReport(patch: Partial<CompanyReport> = {}): CompanyReport {
  return {
    identity: {
      name: "Boise Fab & Weld",
      location: "Boise, ID",
      claims: [{ statement: "Fabricates and welds in Boise since 1998.", category: "verified_fact", sourceUrl: COMPANY, quote: "Custom metal fabrication and welding in Boise, Idaho since 1998.", basis: null }],
    },
    industry: { industry: "Manufacturing", activities: ["fabrication"], claims: [] },
    operationalProfile: {
      summary: "A twelve-person shop.",
      claims: [{ statement: "A team of twelve.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/about", quote: "Our team of twelve builds structural steel", basis: null }],
    },
    software: [],
    processes: [
      { statement: "Schedules on a whiteboard.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/about", quote: "We schedule shop work on a whiteboard", basis: null },
      { statement: "Quotes are called back.", category: "verified_fact", sourceUrl: COMPANY, quote: "our estimator will call you back within two business days", basis: null },
    ],
    technicalIssues: [{ statement: "The services page is unfinished.", category: "observed_defect", sourceUrl: "https://www.boise-fab.test/services", quote: "This page is under construction.", basis: null }],
    hypotheses: [{ statement: "Re-keying quote requests may take estimator time.", category: "industry_hypothesis", sourceUrl: null, quote: null, basis: "Common in job shops" }],
    notVisible: ["Revenue and margins"],
    possibleSolutions: [{ addresses: "Quote follow-up", rung: "configuration", solution: "A form that files requests", why: "Simple", confirmFirst: "That quotes are delayed" }],
    discoveryQuestions: ["How do quote requests reach the estimator?"],
    contacts: {
      channels: [{ kind: "phone", value: "(208) 555-0142", sourceUrl: COMPANY }],
      people: [{ name: "Dana Smith", role: "owner", sourceUrl: "https://www.boise-fab.test/about", quote: "owned and operated by Dana Smith, owner" }],
    },
    evidence: { sourcesUsed: [{ url: COMPANY, usedFor: "identity" }], limitations: [], gaps: [], proposedSources: [] },
    ...patch,
  };
}

describe("evidence checks for company research v2.0", () => {
  const scope: ReadScope = { siteRoot: COMPANY, approved: [SOURCE] };
  const pages = [COMPANY, "https://www.boise-fab.test/about", "https://www.boise-fab.test/services", "https://www.industry-guide.test/fabrication"];
  const ctx = { scope, companySite: COMPANY, now: new Date("2026-10-28T12:00:00Z") };

  it("verifies quotes on the pages read and lets a sound report complete", async () => {
    const checks = checkCompanyReport(companyReport(), await served(scope, pages), ctx);
    expect(checks.summary.quoted).toBe(6);
    expect(checks.summary.quotedFailed).toBe(0);
    expect(checks.needsReview).toEqual([]);
    expect(checks.channels[0].verdict).toBe("found");
    expect(checks.claims.every((c) => c.finalCategory === c.category)).toBe(true);
  });

  it("only moves claims down: a missing quote, an unread page or an unapproved source becomes unsupported", async () => {
    const r = companyReport({
      processes: [
        { statement: "Invented.", category: "verified_fact", sourceUrl: COMPANY, quote: "We guarantee same-day quotes", basis: null },
        { statement: "Unread.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/team", quote: "anything", basis: null },
        { statement: "Off list.", category: "supported_inference", sourceUrl: "https://www.trade-assoc.test/members", quote: null, basis: "x" },
      ],
    });
    const checks = checkCompanyReport(r, await served(scope, pages), ctx);
    const byWhere = Object.fromEntries(checks.claims.map((c) => [c.where, c]));
    expect(byWhere["processes.0"].finalCategory).toBe("unsupported");
    expect(byWhere["processes.0"].verdict).toBe("not found");
    expect(byWhere["processes.1"].verdict).toBe("source not read");
    expect(byWhere["processes.2"].verdict).toBe("source not approved");
    expect(checks.flags.some((f) => f.rule === "source outside the approved list")).toBe(true);
    // 2 of 6 quoted claims failed: more than one in five.
    expect(checks.needsReview.join(" ")).toMatch(/more than one in five/);
  });

  it("sends a failed identity claim to Needs review, and an industry source is never evidence about the company", async () => {
    const r = companyReport({
      identity: {
        name: "Boise Fab & Weld",
        location: "Boise",
        claims: [{ statement: "Follows safety standards.", category: "verified_fact", sourceUrl: "https://www.industry-guide.test/fabrication", quote: "Welding work must follow the applicable safety standards", basis: null }],
      },
    });
    const checks = checkCompanyReport(r, await served(scope, pages), ctx);
    expect(checks.claims[0].verdict).toBe("not company evidence");
    expect(checks.summary.identityFailed).toBe(true);
    expect(checks.needsReview[0]).toMatch(/identity/);
  });

  it("flags revenue-impact claims, careers addresses, people not shown as owners, and stale content", async () => {
    const r = companyReport({
      possibleSolutions: [{ addresses: "x", rung: "managed_ai", solution: "Stop losing jobs to slow quotes", why: "They lose revenue every week", confirmFirst: "x" }],
      contacts: {
        channels: [{ kind: "email", value: "jobs@boise-fab.test", sourceUrl: COMPANY }],
        people: [{ name: "Pat Lee", role: "customer", sourceUrl: "https://www.boise-fab.test/about", quote: "Dana Smith" }],
      },
    });
    const checks = checkCompanyReport(r, await served(scope, pages), ctx);
    const rules = checks.flags.map((f) => f.rule);
    expect(rules).toContain("revenue impact claimed");
    expect(rules).toContain("careers address");
    expect(rules).toContain("person not presented as owner or manager");
    expect(rules).toContain("possibly stale"); // the homepage says "(c) 2019"
    expect(checks.needsReview.some((n) => /rule breach/.test(n))).toBe(true);
    expect(claimsRevenueImpact("Ask how quote requests are handled")).toBe(false);
  });

  it("keeps only proposed sources that a page read links to", async () => {
    const r = companyReport({
      evidence: {
        sourcesUsed: [],
        limitations: [],
        gaps: [{ missing: "Licensing", wouldSettle: "A state registry look-up" }],
        proposedSources: [
          { url: "https://www.trade-assoc.test/members", name: "Trade association", kind: "trade association", why: "Member resources", foundOn: "https://www.industry-guide.test/fabrication" },
          { url: "https://www.made-up.test/", name: "Made up", kind: "industry publication", why: "x", foundOn: COMPANY },
        ],
      },
    });
    const checks = checkCompanyReport(r, await served(scope, pages), ctx);
    expect(checks.proposedSources.map((p) => p.url)).toEqual(["https://www.trade-assoc.test/members"]);
    expect(checks.flags.some((f) => f.rule === "proposed source not linked from a page read")).toBe(true);
    expect(checks.summary.gaps).toBe(1);
  });

  it("reads dates the way the staleness flag needs them", () => {
    expect(latestDate("Posted March 3, 2021 and updated 2024-05-01")?.toISOString().slice(0, 10)).toBe("2024-05-01");
    expect(pageDate("Welcome. Last updated: January 2020. Call us.")?.getUTCFullYear()).toBe(2020);
    expect(pageDate("No dates here")).toBeNull();
  });
});

describe("evidence checks for industry research v1.0", () => {
  it("accepts only approved sources, and a claim without a source can only be a hypothesis", async () => {
    const scope: ReadScope = { siteRoot: null, approved: [SOURCE] };
    const map = await served(scope, ["https://www.industry-guide.test/fabrication"]);
    const report = IndustryReportSchema.parse({
      scope: { industry: "Manufacturing", category: "job shops", region: null },
      operations: {
        summary: "Shops quote by hand.",
        roles: ["estimator"],
        claims: [
          { statement: "Estimators re-enter quotes.", category: "verified_fact", sourceUrl: "https://www.industry-guide.test/fabrication", quote: "re-entering quote details into scheduling spreadsheets", basis: null },
          { statement: "No source.", category: "verified_fact", sourceUrl: null, quote: "x", basis: null },
        ],
      },
      workflows: [],
      bottlenecks: [],
      software: [],
      regulatory: [],
      improvements: [],
      services: [],
      discoveryQuestions: [],
      evidence: { sourcesUsed: [], limitations: [], gaps: [], proposedSources: [] },
    });
    const checks = checkIndustryReport(report, map, { scope, companySite: null, now: new Date("2026-10-28") });
    expect(checks.claims[0].finalCategory).toBe("verified_fact");
    expect(checks.claims[1].finalCategory).toBe("unsupported");
  });
});

describe("the protocols and the simulated providers", () => {
  it("send a JSON Schema for each report", () => {
    expect(JSON.stringify(companyReportJsonSchema())).toMatch(/possibleSolutions/);
    expect(JSON.stringify(industryReportJsonSchema())).toMatch(/bottlenecks/);
    expect(JSON.stringify(companyReportJsonSchema())).not.toMatch(/outreach/i);
  });

  it("simulate a company mission: one more page, then a schema-valid report labeled simulated", async () => {
    const f = fetcher();
    const home = await f.fetchPage(COMPANY, { siteRoot: COMPANY, approved: [] });
    const brief = companyBrief({ name: "Boise Fab & Weld", website: COMPANY, town: "Boise", state: "ID", industry: "Manufacturing", sources: [], intelligence: [] }, home);
    const sim = simulatedResearcher("company_research", noRedeem);
    const req = { system: "s", turns: [{ kind: "user" as const, text: brief }], tools: [], toolChoice: "auto" as const, maxOutputTokens: 20_000 };
    const first = await sim.respond(req, fakeTicket, new AbortController().signal);
    expect(first.status).toBe("tool_calls");
    const page = await f.fetchPage(String(first.toolCalls[0].args.url), { siteRoot: COMPANY, approved: [] });
    const { formatPage } = await import("@/lib/missions/protocol");
    const second = await sim.respond(
      { ...req, turns: [...req.turns, { kind: "model", steps: first.modelSteps }, { kind: "tool_results", results: [{ callId: "sim-1", name: "read_page", output: formatPage(page) }] }] },
      fakeTicket,
      new AbortController().signal,
    );
    const report = CompanyReportSchema.parse(JSON.parse(second.text));
    expect(report.evidence.limitations.join(" ")).toMatch(/Simulated/);
    expect(second.usage.total).toBe(0);
    expect(sim.kind).toBe("simulated");
  });

  it("simulate an industry mission from the brief's first start page", async () => {
    const brief = industryBrief({ industry: "Manufacturing", category: null, region: null, sources: [{ key: "g", name: "Guide", match: "https://www.industry-guide.test/fabrication", kind: "technical resource", purpose: "x" }] });
    const sim = simulatedResearcher("industry_research", noRedeem);
    const r = await sim.respond({ system: "s", turns: [{ kind: "user", text: brief }], tools: [], toolChoice: "auto", maxOutputTokens: 20_000 }, fakeTicket, new AbortController().signal);
    expect(r.toolCalls[0].args.url).toBe("https://www.industry-guide.test/fabrication");
    const reviewer = simulatedReviewer(noRedeem);
    const v = await reviewer.respond({ system: "s", turns: [{ kind: "user", text: "claim 0: [verified_fact] x\nclaim 1: [industry_hypothesis] y" }], tools: [], toolChoice: "none", maxOutputTokens: 20_000 }, fakeTicket, new AbortController().signal);
    expect(JSON.parse(v.text).verdicts).toHaveLength(2);
  });

  it("map refusals to states, and never let a stale run write", () => {
    expect(stateForRefusal("day_cap", "research")).toBe("budget_blocked");
    expect(stateForRefusal("day_cap", "review")).toBe("needs_review");
    expect(stateForRefusal("approval_expired", "research")).toBe("interrupted");
    expect(stateForRefusal("stale_run", "research")).toBe("none");
    expect(stateForRefusal("count_failed", "retry")).toBe("retry");
    expect(stateForRefusal("count_rejected", "research")).toBe("failed");
    expect(stateForRefusal("provider_mismatch", "research")).toBe("failed");
  });
});

describe("a quoted claim the check couldn't confirm (M-0004)", () => {
  it("is never counted, levelled or labeled as verified in the Opportunity Center", () => {
    const claim = (where: string, verdict: string, finalCategory: string, category: string) => ({ where, verdict, category, finalCategory, statement: where, quote: "q", sourceUrl: "https://www.boisemetalworks.com/", sourceKey: null, reasons: verdict === "found" ? [] : ["The quote isn't on the page cited."] });
    const view = {
      id: "v1", companyKey: "c01", version: 1, companyName: "Boise Metal Works", website: "https://www.boisemetalworks.com/", town: "Boise", state: "ID", industry: "Manufacturing",
      missionId: "m4", missionNumber: 4, protocol: "company-research-v2.0", model: "gemini-4-argon", costMicros: 258_469, withIssues: false, createdAt: "2026-10-28T16:45:00.000Z",
      report: {},
      checks: { claims: [claim("identity.claims.0", "found", "verified_fact", "verified_fact"), claim("technicalIssues.1", "not found", "unsupported", "observed_defect")], channels: [], flags: [], needsReview: [] },
      sources: [],
    };
    const d = dossierFromResearch(view as never, "M-0004");
    expect(d.facts).toBe(2);
    expect(d.quotesVerified).toBe(1);
    const defect = d.claimSections.find((x) => x.key === "opportunityEvidence")!.claims[0];
    expect(defect.evidence).toBe("not-confirmed");
    const items = evidenceItems(d);
    expect(items.find((i) => i.key === "opportunityEvidence.0")?.level).toBe(3);
    expect(items.find((i) => i.key === "identity.0")?.level).toBe(1);
  });
});

describe("thought signatures in the counted history (M-0003)", () => {
  const SIG_A = "c2lnbmF0dXJlLUEtb3BhcXVl";
  const SIG_B = "c2lnbmF0dXJlLUItb3BhcXVl";
  const call = (id: string, url: string) => ({ type: "function_call", id, name: "read_page", arguments: { url } });
  const results = (...ids: string[]): Turn => ({ kind: "tool_results", results: ids.map((id) => ({ callId: id, name: "read_page", output: `page ${id}` })) });
  type Part = Record<string, unknown> & { functionCall?: { id?: string; name?: string } };
  const modelParts = (contents: unknown[]) => (contents as { role: string; parts: Part[] }[]).filter((c) => c.role === "model").map((c) => c.parts);

  it("put each signature, unchanged, on the first call of its turn, keeping ids and order (M-0003's nine parallel calls)", () => {
    const calls = Array.from({ length: 9 }, (_, i) => call(`c${i + 1}`, `https://www.boisemetalworks.com/p${i + 1}/`));
    const turns: Turn[] = [
      { kind: "user", text: "research Boise Metal Works" },
      { kind: "model", steps: [{ type: "thought", signature: SIG_A, summary: [{ type: "text", text: "Read the site's pages." }] }, ...calls] },
      results(...calls.map((c) => c.id)),
    ];
    const contents = countingContents(turns) as { role: string; parts: Part[] }[];
    const [parts] = modelParts(contents);
    expect(parts[0]).toEqual({ text: "Read the site's pages.", thought: true });
    expect(parts.slice(1).map((p) => p.functionCall?.id)).toEqual(calls.map((c) => c.id));
    expect(parts[1]).toEqual({ functionCall: { id: "c1", name: "read_page", args: { url: "https://www.boisemetalworks.com/p1/" } }, thoughtSignature: SIG_A });
    expect(parts.slice(2).every((p) => !("thoughtSignature" in p))).toBe(true);
    expect((contents[2].parts as { functionResponse: { id: string } }[]).map((p) => p.functionResponse.id)).toEqual(calls.map((c) => c.id));
  });

  it("keep each turn's own signature across sequential tool calls", () => {
    const turns: Turn[] = [
      { kind: "user", text: "go" },
      { kind: "model", steps: [{ type: "thought", signature: SIG_A }, call("c1", "https://a.test/")] },
      results("c1"),
      { kind: "model", steps: [{ type: "thought", signature: SIG_B }, call("c2", "https://a.test/b")] },
      results("c2"),
    ];
    const [first, second] = modelParts(countingContents(turns));
    expect(first).toEqual([{ functionCall: { id: "c1", name: "read_page", args: { url: "https://a.test/" } }, thoughtSignature: SIG_A }]);
    expect(second).toEqual([{ functionCall: { id: "c2", name: "read_page", args: { url: "https://a.test/b" } }, thoughtSignature: SIG_B }]);
  });

  it("never invent a signature: a call that came without one is counted without one", () => {
    const [parts] = modelParts(countingContents([{ kind: "user", text: "go" }, { kind: "model", steps: [call("c1", "https://a.test/")] }, results("c1")]));
    expect(parts).toEqual([{ functionCall: { id: "c1", name: "read_page", args: { url: "https://a.test/" } } }]);
  });

  it("keep a signature Google puts on a call step itself, and never lose a thought's signature to it", () => {
    const own = (id: string, signature: string) => ({ ...call(id, `https://a.test/${id}`), signature });
    const [onlyOwn] = modelParts(countingContents([{ kind: "user", text: "go" }, { kind: "model", steps: [own("c1", SIG_A), own("c2", SIG_B)] }, results("c1", "c2")]));
    expect(onlyOwn.map((p) => p.thoughtSignature)).toEqual([SIG_A, SIG_B]);
    const [both] = modelParts(countingContents([{ kind: "user", text: "go" }, { kind: "model", steps: [{ type: "thought", signature: SIG_A, summary: [{ type: "text", text: "plan" }] }, own("c1", SIG_B)] }, results("c1")]));
    expect(both).toEqual([
      { text: "plan", thought: true, thoughtSignature: SIG_A },
      { functionCall: { id: "c1", name: "read_page", args: { url: "https://a.test/c1" } }, thoughtSignature: SIG_B },
    ]);
  });

  it("estimate a signature no part can carry, rather than drop it (two signed thoughts before one call)", async () => {
    const turns: Turn[] = [{ kind: "user", text: "go" }, { kind: "model", steps: [{ type: "thought", signature: SIG_A }, { type: "thought", signature: SIG_B }, call("c1", "https://a.test/")] }, results("c1")];
    const displaced: string[] = [];
    const [parts] = modelParts(countingContents(turns, displaced));
    expect(parts).toEqual([{ functionCall: { id: "c1", name: "read_page", args: { url: "https://a.test/" } }, thoughtSignature: SIG_B }]);
    expect(displaced).toEqual([SIG_A]);
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: noRedeem, client: () => ({}) as never, count: async () => ({ totalTokens: 10 }) });
    const n = await g.countInputTokens({ system: "s", turns, tools: [], toolChoice: "auto", maxOutputTokens: 20_000 }, fakeTicket, new AbortController().signal);
    expect(n.uncounted).toBe(Math.ceil(JSON.stringify([SIG_A]).length / 3));
  });

  it("send generation the same history, signatures included, that the count saw", async () => {
    const turns: Turn[] = [
      { kind: "user", text: "go" },
      { kind: "model", steps: [{ type: "thought", signature: SIG_A }, call("c1", "https://a.test/"), call("c2", "https://a.test/b")] },
      results("c1", "c2"),
    ];
    let sent: { input?: unknown[] } = {};
    let counted: { generateContentRequest: Record<string, unknown> } | null = null;
    const client = { interactions: { create: async (body: { input?: unknown[] }) => ((sent = body), { status: "completed", steps: [], usage: { total_input_tokens: 5 } }) } };
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: noRedeem, client: () => client as never, count: async (_m, body) => ((counted = body), { totalTokens: 5 }) });
    const req = { system: "s", turns, tools: [], toolChoice: "auto" as const, maxOutputTokens: 20_000 };
    await g.countInputTokens(req, fakeTicket, new AbortController().signal);
    await g.respond(req, fakeTicket, new AbortController().signal);
    const signatures = (v: unknown) => JSON.stringify(v).match(/c2lnbmF0dXJl[\w-]+/g) ?? [];
    expect(signatures(sent.input)).toEqual([SIG_A]);
    expect(signatures(counted!.generateContentRequest.contents)).toEqual([SIG_A]);
    // Generation resends the model's steps exactly as they came: the thought step, then both calls, in order.
    expect(sent.input!.slice(1, 4)).toEqual(turns[1].kind === "model" ? turns[1].steps : []);
  });
});

describe("the provider adapters", () => {
  it("count the whole input, system instruction and tools included, with Google's counter, and report the schema it can't see", async () => {
    let counted: { model: string; body: { generateContentRequest: Record<string, unknown> } } | null = null;
    const client = { interactions: { create: async () => ({}) } };
    const tool = { name: "read_page", description: "Read a page", parameters: { type: "object", properties: { url: { type: "string" } } } };
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: noRedeem, client: () => client as never, count: async (model, body) => ((counted = { model, body }), { totalTokens: 1234 }) });
    const n = await g.countInputTokens({ system: "sys", turns: [{ kind: "user", text: "hi" }], tools: [tool], toolChoice: "auto", outputSchema: { type: "object" }, maxOutputTokens: 20_000 }, fakeTicket, new AbortController().signal);
    expect(n.counted).toBe(1234);
    expect(n.uncounted).toBeGreaterThan(0);
    expect(counted!.model).toBe("gemini-4-argon");
    expect(counted!.body).toEqual({
      generateContentRequest: {
        model: "models/gemini-4-argon",
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "sys" }] },
        tools: [{ functionDeclarations: [{ name: "read_page", description: "Read a page", parametersJsonSchema: tool.parameters }] }],
      },
    });
    expect(g.thinkingLevel).toBe("medium");
  });

  it("count thoughts directly, and estimate only earlier model steps the counter has no form for", async () => {
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: noRedeem, client: () => ({}) as never, count: async () => ({ totalTokens: 100 }) });
    const base = { system: "sys", tools: [], toolChoice: "auto" as const, maxOutputTokens: 20_000 };
    const output = { type: "model_output", content: [{ type: "text", text: "ok" }] };
    const thought = { type: "thought", signature: "s".repeat(3_000), summary: [{ type: "text", text: "thinking" }] };
    const withThought = await g.countInputTokens({ ...base, turns: [{ kind: "model", steps: [thought, output] }] }, fakeTicket, new AbortController().signal);
    const other = { type: "url_context_call", id: "u1", arguments: { urls: ["x".repeat(3_000)] } };
    const withOther = await g.countInputTokens({ ...base, turns: [{ kind: "model", steps: [other, output] }] }, fakeTicket, new AbortController().signal);
    expect(withThought.uncounted).toBe(0);
    expect(withOther.uncounted).toBeGreaterThanOrEqual(1_000);
  });

  it("post the count to Google's REST countTokens with the key in a header, never the URL (M-0002)", async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test-only-not-a-key";
    try {
      const seen: { url: string; init: RequestInit }[] = [];
      const ok = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify({ totalTokens: 77 }), { status: 200 }))) as unknown as typeof fetch;
      const body = countingRequest("gemini-4-argon", { system: "sys", turns: [{ kind: "user", text: "hi" }], tools: [], toolChoice: "none", maxOutputTokens: 20_000 });
      expect(await restCounter(ok)("gemini-4-argon", body, new AbortController().signal)).toEqual({ totalTokens: 77 });
      expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:countTokens");
      expect(seen[0].url).not.toMatch(/key=|AIza/);
      expect((seen[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test-only-not-a-key");
      expect(JSON.parse(String(seen[0].init.body))).toEqual(body);
      // Google refusing the count is an invalid request, never generation, and the key never reaches the message.
      const bad = (async () => new Response('{"error":{"message":"bad AIza-test-only-not-a-key"}}', { status: 400 })) as unknown as typeof fetch;
      const e = (await restCounter(bad)("gemini-4-argon", body, new AbortController().signal).catch((x: unknown) => x)) as Error;
      expect(geminiFailure(e, false)).toMatchObject({ kind: "invalid_request", sent: "yes", status: 400 });
      expect(String(e.message)).not.toMatch(/AIza/);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });

  it("classify the SDK's own refusal of a parameter as an invalid request that was never sent (M-0002)", async () => {
    // The root cause, kept as a check on the SDK: its Developer API counter refuses a system instruction locally.
    const sdk = new GoogleGenAI({ apiKey: "not-a-key-test-only" });
    const e = await sdk.models.countTokens({ model: "gemini-4-argon", contents: "hi", config: { systemInstruction: "sys" } }).catch((x) => x);
    expect(String(e?.message)).toMatch(/systemInstruction parameter is only supported in Gemini Enterprise Agent Platform mode/);
    expect(geminiFailure(e, false)).toMatchObject({ kind: "invalid_request", sent: "no" });
  });

  it("send with the approved thinking level, no SDK retries, and say when usage was reported", async () => {
    let sent: unknown[] = [];
    const client = {
      interactions: {
        create: async (...args: unknown[]) => ((sent = args), { id: "i1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }], usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 } }),
      },
    };
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "high", redeem: noRedeem, client: () => client as never });
    const reply = await g.respond({ system: "s", turns: [{ kind: "user", text: "x" }], tools: [], toolChoice: "none", maxOutputTokens: 20_000 }, fakeTicket, new AbortController().signal);
    expect(reply.usageReported).toBe(true);
    expect(JSON.stringify(sent[0])).toMatch(/"thinking_level":"high"/);
    expect(JSON.stringify(sent[0])).toMatch(/"max_output_tokens":20000/);
    expect(sent[1]).toMatchObject({ retries: { strategy: "none" } });
  });

  it("redeem the ticket before anything leaves, so a refused ticket sends nothing", async () => {
    let calls = 0;
    const client = { interactions: { create: async () => (calls++, {}) } };
    const refuse = () => {
      throw new Error("ticket refused");
    };
    const g = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "low", redeem: refuse, client: () => client as never, count: async () => (calls++, { totalTokens: 1 }) });
    const req = { system: "s", turns: [], tools: [], toolChoice: "none" as const, maxOutputTokens: 20_000 };
    await expect(g.countInputTokens(req, fakeTicket, new AbortController().signal)).rejects.toThrow("ticket refused");
    await expect(g.respond(req, fakeTicket, new AbortController().signal)).rejects.toThrow("ticket refused");
    expect(calls).toBe(0);
  });

  it("say whether a failed request may have reached the provider", () => {
    expect(geminiFailure({ statusCode: 429, message: "slow down" }, false)).toMatchObject({ kind: "rate_limit", sent: "yes", status: 429 });
    expect(geminiFailure({ statusCode: 413, message: "too large" }, false)).toMatchObject({ kind: "invalid_request", sent: "yes", status: 413 });
    expect(geminiFailure({ statusCode: 503, message: "x" }, false)).toMatchObject({ kind: "server", sent: "yes" });
    expect(geminiFailure({ name: "RequestTimeoutError", message: "x" }, false)).toMatchObject({ kind: "timeout", sent: "unknown" });
    expect(geminiFailure({ name: "ConnectionError", message: "x", cause: { code: "ECONNREFUSED" } }, false)).toMatchObject({ kind: "network", sent: "no" });
    expect(geminiFailure({ name: "ConnectionError", message: "x", cause: { code: "ECONNRESET" } }, false)).toMatchObject({ kind: "network", sent: "unknown" });
    expect(geminiFailure(new Error("x"), true)).toMatchObject({ kind: "cancelled", sent: "unknown" });
    expect(claudeFailure(new Error("odd"), false)).toBeInstanceOf(ProviderError);
    expect(claudeUsage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 7 } as never)).toMatchObject({ input: 107, output: 50, thinking: 0, cacheWriteInput: 7 });
  });

  it("count the conversation in the standard format, tool results included", () => {
    const contents = countingContents([
      { kind: "user", text: "brief" },
      { kind: "model", steps: [{ type: "function_call", name: "read_page", arguments: { url: "u" } }] },
      { kind: "tool_results", results: [{ callId: "1", name: "read_page", output: "page" }] },
    ]) as { role: string }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });
});
