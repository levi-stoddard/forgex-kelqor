import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { geminiModel } from "@/lib/ai/gemini";
import { costUsd, worstCaseUsd } from "@/lib/ai/pricing";
import type { ModelReply, ModelRequest, ResearchModel } from "@/lib/ai/types";
import { addServed, checkReport, looksLikeCredential, parseReport, quoteOnPage, researchCompany, urlKey, type ServedPages } from "@/lib/research/agent";
import { BudgetGuard, BudgetStop } from "@/lib/research/budget";
import { SiteFetcher, antiAutomationExcerpts, isPublicAddress, termsLinks, type Transport } from "@/lib/research/fetcher";
import { readHtml } from "@/lib/research/html";
import { parseRobots, policyFromResponse, robotsAllows } from "@/lib/research/robots";
import { reportJsonSchema } from "@/lib/research/schema";
import { simulatedModel } from "@/lib/research/simulated";
import {
  CompanyInput, FORGEX_SEGMENT, FOUNDER_RULES, FOUNDER_SPEC, InputsFile, QUALIFICATION_CATEGORIES, READ_PAGE_TOOL,
  companyBrief, restrictedBrief, systemPrompt,
} from "@/lib/research/spec";

const SITE = "https://acmeplumbing.example/";
const HOME = `<html><head><title>Acme Plumbing | Boise</title><meta name="description" content="Family plumbing in Boise."></head>
<body><nav><a href="/about">About us</a> <a href="/contact">Contact</a> <a href="https://www.facebook.com/acme">Facebook</a> <a href="/terms">Terms of use</a></nav>
<h1>Acme Plumbing</h1><p>Serving Boise since 2001. Call (208) 555-0142 for same-day service.</p>
<a href="tel:+12085550142">Call</a> <a href="mailto:office@acmeplumbing.example">Email</a>
<script src="https://static.housecallpro.com/widget.js"></script><script>var tracker = "https://analytics.vendor.example/t.js";</script>
<form action="/book" method="post"></form><iframe src="https://booking.vendor.example/acme"></iframe></body></html>`;
const ABOUT = "<html><body><h2>About</h2><p>Owner Jane Rivera founded Acme in 2001. Licensed plumbing contractor PLB-C-99999.</p></body></html>";
const TERMS = "<html><body><p>You may not use any robot, spider or other automated means to access this site.</p></body></html>";

interface FakePage {
  status?: number;
  type?: string;
  body?: string;
  location?: string;
}

function fakeTransport(pages: Record<string, FakePage>, hits: string[] = []): Transport {
  return async (url) => {
    hits.push(url.toString());
    const p = pages[url.toString()];
    if (!p) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("missing"), truncated: false };
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html; charset=utf-8" };
    if (p.location) headers.location = p.location;
    return { status: p.status ?? 200, headers, body: Buffer.from(p.body ?? ""), truncated: false };
  };
}

const acmePages = (robots = "User-agent: *\nDisallow: /private\n"): Record<string, FakePage> => ({
  "https://acmeplumbing.example/robots.txt": { type: "text/plain", body: robots },
  [SITE]: { body: HOME },
  "https://acmeplumbing.example/about": { body: ABOUT },
  "https://acmeplumbing.example/terms": { body: TERMS },
});

const fetcherFor = (pages: Record<string, FakePage>, hits: string[] = []) =>
  new SiteFetcher({ transport: fakeTransport(pages, hits), minIntervalMs: 0, sleep: async () => {} });

const company = CompanyInput.parse({ id: "t01", name: "Acme Plumbing", town: "Boise", state: "Idaho", website: SITE });

const freeGuard = () =>
  new BudgetGuard({ stage: "test", capUsd: 0, companyCapUsd: { simulated: 0 }, expectedCompanyUsd: { simulated: 0 } });

describe("robots.txt", () => {
  it("uses the group that names us, else the * group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: ForgeXResearch\nDisallow: /private\n";
    expect(parseRobots(text, "ForgeXResearch")).toEqual({ allow: [], disallow: ["/private"] });
    expect(parseRobots(text, "OtherBot")).toEqual({ allow: [], disallow: ["/"] });
  });

  it("lets the longest rule win and Allow win ties, with * and $ patterns", () => {
    const policy = { kind: "rules" as const, rules: { allow: ["/shop/public", "/*.html$"], disallow: ["/shop", "/tmp"] } };
    expect(robotsAllows(policy, "/shop/cart")).toBe(false);
    expect(robotsAllows(policy, "/shop/public/item")).toBe(true);
    expect(robotsAllows(policy, "/tmp/page.html")).toBe(true);
    expect(robotsAllows(policy, "/tmp/page.html?x=1")).toBe(false);
    expect(robotsAllows(policy, "/about")).toBe(true);
  });

  it("stays out when robots.txt can't be read, and reads freely when it doesn't exist", () => {
    expect(policyFromResponse(500, "", "ForgeXResearch").kind).toBe("disallow-all");
    expect(policyFromResponse(429, "", "ForgeXResearch").kind).toBe("disallow-all");
    expect(policyFromResponse(null, "", "ForgeXResearch").kind).toBe("disallow-all");
    expect(policyFromResponse(404, "", "ForgeXResearch").kind).toBe("allow-all");
  });
});

describe("address and page safety", () => {
  it("refuses private, loopback, link-local and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("reads text, same-site links and technical details, but not head or script text", () => {
    const inv = readHtml(HOME, SITE, SITE);
    expect(inv.title).toBe("Acme Plumbing | Boise");
    expect(inv.description).toBe("Family plumbing in Boise.");
    expect(inv.links.map((l) => l.url)).toEqual([
      "https://acmeplumbing.example/about",
      "https://acmeplumbing.example/contact",
      "https://acmeplumbing.example/terms",
    ]);
    expect(inv.phones).toEqual(["+12085550142"]);
    expect(inv.emails).toEqual(["office@acmeplumbing.example"]);
    expect(inv.scriptSources).toEqual(["https://static.housecallpro.com/widget.js"]);
    expect(inv.frameSources).toEqual(["https://booking.vendor.example/acme"]);
    expect(inv.forms).toEqual([{ action: "https://acmeplumbing.example/book", method: "post" }]);
    expect(inv.otherHosts).toEqual(expect.arrayContaining(["static.housecallpro.com", "analytics.vendor.example", "booking.vendor.example", "facebook.com"]));
    expect(inv.text).toContain("Serving Boise since 2001.");
    expect(inv.text).not.toContain("tracker");
    expect(inv.text).not.toContain("Acme Plumbing | Boise");
  });

  it("flags site terms that forbid automated access", () => {
    expect(termsLinks(readHtml(HOME, SITE, SITE))).toEqual(["https://acmeplumbing.example/terms"]);
    expect(antiAutomationExcerpts(readHtml(TERMS, SITE, SITE).text)).toHaveLength(1);
  });
});

describe("fetcher", () => {
  it("honors robots.txt without requesting the page", async () => {
    const hits: string[] = [];
    const f = fetcherFor({ ...acmePages("User-agent: *\nDisallow: /about\n") }, hits);
    const page = await f.fetchPage("https://acmeplumbing.example/about", SITE);
    expect(page.record.outcome).toBe("robots-disallowed");
    expect(hits).toEqual(["https://acmeplumbing.example/robots.txt"]);
  });

  it("reads only the company's own site and never a blocked domain", async () => {
    const f = fetcherFor(acmePages());
    expect((await f.fetchPage("https://other.example/page", SITE)).record.outcome).toBe("off-site");
    expect((await f.fetchPage("https://www.linkedin.com/company/acme", "https://www.linkedin.com/")).record.outcome).toBe("blocked-domain");
    expect((await f.fetchPage("http://acmeplumbing.example:8080/", SITE)).record.outcome).toBe("bad-url");
  });

  it("records refusals and bot checks instead of working around them", async () => {
    const pages = {
      ...acmePages(),
      "https://acmeplumbing.example/contact": { status: 403, body: "Forbidden" },
      "https://acmeplumbing.example/check": { status: 200, body: "<html><head><title>Just a moment...</title></head></html>" },
    };
    const f = fetcherFor(pages);
    expect((await f.fetchPage("https://acmeplumbing.example/contact", SITE)).record.outcome).toBe("refused");
    expect((await f.fetchPage("https://acmeplumbing.example/check", SITE)).record.outcome).toBe("refused");
  });

  it("follows same-site redirects but not off-site ones", async () => {
    const pages = {
      ...acmePages(),
      "https://acmeplumbing.example/old": { status: 301, location: "/about" },
      "https://acmeplumbing.example/book-now": { status: 302, location: "https://booking.vendor.example/acme" },
    };
    const f = fetcherFor(pages);
    const moved = await f.fetchPage("https://acmeplumbing.example/old", SITE);
    expect(moved.record.outcome).toBe("ok");
    expect(moved.record.finalUrl).toBe("https://acmeplumbing.example/about");
    expect((await f.fetchPage("https://acmeplumbing.example/book-now", SITE)).record.outcome).toBe("off-site");
  });

  it("keeps fingerprints and metadata, holds text only in memory, and waits between requests", async () => {
    const waits: number[] = [];
    let clock = 0;
    const f = new SiteFetcher({ transport: fakeTransport(acmePages()), minIntervalMs: 3000, now: () => new Date(clock), sleep: async (ms) => { waits.push(ms); clock += ms; } });
    const page = await f.fetchPage(SITE, SITE);
    expect(page.record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(page.record.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.textOf(SITE)).toContain("Serving Boise since 2001.");
    expect(JSON.stringify(f.log)).not.toContain("Serving Boise");
    expect(waits).toEqual([3000]);
  });
});

describe("pricing and budget", () => {
  const usage = (input: number, output: number, cachedInput = 0, thinking = 0) => ({ input, cachedInput, output, thinking, toolUse: 0, total: input + output + thinking });

  it("prices Argon at the promotion through November and the list price from December", () => {
    expect(costUsd("gemini-4-argon", usage(1e6, 1e6), new Date("2026-11-15T12:00:00Z"))).toBeCloseTo(12);
    expect(costUsd("gemini-4-argon", usage(1e6, 1e6), new Date("2026-12-02T12:00:00Z"))).toBeCloseTo(24);
    expect(costUsd("gemini-3.8-flash", usage(1e6, 0, 5e5, 1e6), new Date("2026-11-15T12:00:00Z"))).toBeCloseTo(0.375 + 0.0375 + 3.75);
    expect(() => costUsd("unknown-model", usage(1, 1))).toThrow();
  });

  it("refuses a request whose worst case would cross the stage or company cap", () => {
    const guard = new BudgetGuard({ stage: "t", capUsd: 0.01, companyCapUsd: { "gemini-3.8-flash": 0.5 }, expectedCompanyUsd: { "gemini-3.8-flash": 0.2 } });
    guard.startCompany("c1", "gemini-3.8-flash");
    expect(worstCaseUsd("gemini-3.8-flash", 100_000, 32_000, new Date("2026-11-01"))).toBeCloseTo(0.315);
    expect(() => guard.reserve("gemini-3.8-flash", 100_000, 32_000)).toThrow(BudgetStop);

    const roomy = new BudgetGuard({ stage: "t", capUsd: 10, companyCapUsd: { "gemini-3.8-flash": 0.5 }, expectedCompanyUsd: { "gemini-3.8-flash": 0.2 }, now: () => new Date("2026-11-01") });
    roomy.startCompany("c1", "gemini-3.8-flash");
    roomy.reserve("gemini-3.8-flash", 100_000, 32_000);
    roomy.record("gemini-3.8-flash", usage(200_000, 40_000));
    let stop: unknown;
    try {
      roomy.reserve("gemini-3.8-flash", 100_000, 32_000);
    } catch (e) {
      stop = e;
    }
    expect(stop).toBeInstanceOf(BudgetStop);
    expect((stop as BudgetStop).scope).toBe("company");
  });

  it("keeps an append-only ledger and resumes the stage total from it", () => {
    const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forgex-ledger-")), "ledger.jsonl");
    const opts = { stage: "dry", capUsd: 5, companyCapUsd: { "gemini-4-argon": 1.5 }, expectedCompanyUsd: { "gemini-4-argon": 0.6 }, ledgerPath: ledger, now: () => new Date("2026-11-01") };
    const a = new BudgetGuard(opts);
    a.startCompany("c1", "gemini-4-argon");
    a.record("gemini-4-argon", usage(100_000, 10_000), "i-1");
    expect(fs.readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(1);
    expect(new BudgetGuard(opts).stageSpentUsd).toBeCloseTo(0.3);
  });

  it("stops the run after three API errors in a row", () => {
    const guard = freeGuard();
    guard.noteError(500);
    guard.noteError(503);
    expect(() => guard.noteError(500)).toThrow(BudgetStop);
  });
});

describe("report checks", () => {
  it("finds quotes despite case, spacing, curly quotes and ellipses, and rejects invented ones", () => {
    const page = "Serving   Boise since 2001.\nCall (208) 555-0142 for same-day service — 24/7.";
    expect(quoteOnPage("serving boise since 2001", page)).toBe(true);
    expect(quoteOnPage("Serving Boise … same-day service", page)).toBe(true);
    expect(quoteOnPage("Serving Boise since 1999", page)).toBe(false);
  });

  it("detects credential-like strings", () => {
    expect(looksLikeCredential(`key ${"AIza"}${"x".repeat(35)}`)).toBe(true);
    expect(looksLikeCredential("Call (208) 555-0142")).toBe(false);
  });

  it("sends a JSON Schema without the draft marker", () => {
    const schema = reportJsonSchema();
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toHaveLength(18);
  });
});

describe("research loop", () => {
  it("researches end to end offline and stores no page text", async () => {
    const f = fetcherFor(acmePages());
    const { record, runStop } = await researchCompany({ company, model: simulatedModel(), fetcher: f, guard: freeGuard() });
    expect(runStop).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.pagesRequested).toEqual([{ url: "https://acmeplumbing.example/about", outcome: "ok" }]);
    expect(record.checks?.summary).toMatchObject({ facts: 1, quotesFound: 1 });
    expect(record.sources.map((s) => s.outcome)).toEqual(["ok", "ok"]);
    expect(JSON.stringify(record)).not.toContain("Licensed plumbing contractor PLB-C-99999");
  });

  it("makes no model call when the site doesn't permit access", async () => {
    let calls = 0;
    const model: ResearchModel = { provider: "test", model: "simulated", respond: async () => { calls++; throw new Error("not expected"); } };
    const f = fetcherFor(acmePages("User-agent: *\nDisallow: /\n"));
    const { record } = await researchCompany({ company, model, fetcher: f, guard: freeGuard() });
    expect(record.status).toBe("no-site-access");
    expect(calls).toBe(0);
  });

  const scripted = (reply: Partial<ModelReply>): ResearchModel => ({
    provider: "test",
    model: "simulated",
    respond: async () => ({ status: "completed", text: "", toolCalls: [], modelSteps: [], usage: { input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 }, model: "simulated", ...reply }),
  });

  it("stops the run when the model asks for a tool that isn't allowed", async () => {
    const model = scripted({ status: "tool_calls", toolCalls: [{ id: "x", name: "send_email", args: { to: "owner@acmeplumbing.example" } }] });
    const { record, runStop } = await researchCompany({ company, model, fetcher: fetcherFor(acmePages()), guard: freeGuard() });
    expect(record.status).toBe("stopped");
    expect(runStop?.message).toContain("send_email");
  });

  it("stops the run when a response contains something that looks like a credential", async () => {
    const model = scripted({ text: `{"note":"${"AIza"}${"k".repeat(35)}"}` });
    const { runStop } = await researchCompany({ company, model, fetcher: fetcherFor(acmePages()), guard: freeGuard() });
    expect(runStop?.message).toContain("credential");
  });

  it("asks once for a corrected report, then records an invalid one", async () => {
    let calls = 0;
    const model: ResearchModel = {
      provider: "test",
      model: "simulated",
      respond: async (_req: ModelRequest) => {
        calls++;
        return { status: "completed", text: '{"identity":{}}', toolCalls: [], modelSteps: [], usage: { input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 }, model: "simulated" };
      },
    };
    const { record } = await researchCompany({ company, model, fetcher: fetcherFor(acmePages()), guard: freeGuard() });
    expect(calls).toBe(2);
    expect(record.status).toBe("invalid-report");
    expect(parseReport('{"identity":{}}').ok).toBe(false);
  });
});

describe("run-time checks", () => {
  const ABOUT_URL = "https://acmeplumbing.example/about";
  const simulatedReport = async (f: SiteFetcher) =>
    (await researchCompany({ company, model: simulatedModel(), fetcher: f, guard: freeGuard() })).record.report!;

  it("treats http/https, www. and a trailing slash as the same page", () => {
    expect(urlKey("http://www.Acmeplumbing.example/about/")).toBe(urlKey("https://acmeplumbing.example/about"));
    expect(urlKey("https://acmeplumbing.example/about?x=1")).not.toBe(urlKey("https://acmeplumbing.example/about"));
  });

  it("credits a quote found in a page's technical details, not only its text", async () => {
    const f = fetcherFor(acmePages());
    const base = await simulatedReport(f);
    const report = {
      ...base,
      existingSoftware: [{ product: "Housecall Pro", purpose: "booking", evidence: { statement: "The homepage loads a Housecall Pro script.", label: "fact" as const, sourceUrl: SITE, quote: "https://static.housecallpro.com/widget.js" } }],
    };
    const served: ServedPages = new Map();
    addServed(served, SITE, await f.fetchPage(SITE, SITE));
    const checks = checkReport(report, served, { website: SITE });
    expect(checks.quotes.find((q) => q.section === "existingSoftware")?.verdict).toBe("found in page details");
    expect(checks.summary).toMatchObject({ quotesFound: 2, quotesFoundInDetails: 1, quotesNotFound: 0 });
  });

  it("checks quotes only against pages this run was served, even when the cache holds others", async () => {
    const f = fetcherFor(acmePages());
    const base = await simulatedReport(f);
    const report = {
      ...base,
      licensing: { claims: [{ statement: "Acme is licensed.", label: "fact" as const, sourceUrl: ABOUT_URL, quote: "Licensed plumbing contractor PLB-C-99999." }], limitations: "" },
    };
    const served: ServedPages = new Map();
    addServed(served, SITE, await f.fetchPage(SITE, SITE));
    expect(checkReport(report, served, { website: SITE }).quotes.find((q) => q.section === "licensing")?.verdict).toBe("source not read");
    addServed(served, `${ABOUT_URL}/`, await f.fetchPage(ABOUT_URL, SITE));
    expect(checkReport(report, served, { website: SITE }).quotes.find((q) => q.section === "licensing")?.verdict).toBe("found");
  });

  it("lists pages served from the cache among the run's sources", async () => {
    const f = fetcherFor(acmePages());
    await f.fetchPage(SITE, SITE);
    await f.fetchPage(ABOUT_URL, SITE);
    const { record } = await researchCompany({ company, model: simulatedModel(), fetcher: f, guard: freeGuard() });
    expect(record.sources.map((s) => [s.finalUrl, s.fromCache])).toEqual([[SITE, true], [ABOUT_URL, true]]);
    expect(record.checks?.summary).toMatchObject({ facts: 1, quotesFound: 1 });
  });
});

describe("protocol v1.3 checks", () => {
  const ABOUT_URL = "https://acmeplumbing.example/about";
  const CAREERS_URL = "https://acmeplumbing.example/careers";
  const CAREERS = '<html><body><p>Join our team.</p><a href="https://jobs@acmeplumbing.example/">Send resume</a></body></html>';
  const pages = () => ({ ...acmePages(), [CAREERS_URL]: { body: CAREERS } });
  const baseReport = async () =>
    (await researchCompany({ company, model: simulatedModel(), fetcher: fetcherFor(acmePages()), guard: freeGuard() })).record.report!;
  const servedPages = async (f: SiteFetcher, urls: string[]) => {
    const served: ServedPages = new Map();
    for (const url of urls) addServed(served, url, await f.fetchPage(url, SITE));
    return served;
  };
  const fact = (statement: string, sourceUrl: string, quote: string) => ({ statement, label: "fact" as const, sourceUrl, quote });

  it("tells a real quote cited to the wrong page from an invented one", async () => {
    const report = {
      ...(await baseReport()),
      licensing: {
        claims: [fact("Acme is licensed.", SITE, "Licensed plumbing contractor PLB-C-99999."), fact("Acme is bonded.", SITE, "Fully bonded and insured.")],
        limitations: "",
      },
    };
    const checks = checkReport(report, await servedPages(fetcherFor(pages()), [SITE, ABOUT_URL]), { website: SITE });
    expect(checks.quotes.filter((q) => q.section === "licensing").map((q) => [q.verdict, q.foundOn])).toEqual([
      ["found on another page", ABOUT_URL],
      ["not found", undefined],
    ]);
    expect(checks.summary).toMatchObject({ quotesFound: 1, quotesOnAnotherPage: 1, quotesNotFound: 1 });
  });

  it("flags web addresses and host names that no page read shows", async () => {
    const report = {
      ...(await baseReport()),
      existingSoftware: [
        { product: "Housecall Pro", purpose: "booking", evidence: { statement: "The homepage loads static.housecallpro.com.", label: "inference" as const, sourceUrl: SITE, quote: null } },
        { product: "Optimizer", purpose: "SEO", evidence: fact("The homepage loads an optimization script.", SITE, "https://dashboard.optimizer.example/scripts/dynamic_optimization.js") },
      ],
      licensing: { claims: [], limitations: "Not checked against dopl.idaho.gov or the jquery.min.js file." },
      discovery: { questions: [], outreachSubject: "Acme", outreachBody: "I read https://acmeplumbing.example/about#team and www.acmeplumbing.example." },
    };
    const checks = checkReport(report, await servedPages(fetcherFor(pages()), [SITE, ABOUT_URL]), { website: SITE });
    expect(checks.flags.filter((x) => x.rule === "link not on a page read").map((x) => x.detail).sort()).toEqual([
      "dopl.idaho.gov",
      "https://dashboard.optimizer.example/scripts/dynamic_optimization.js",
    ]);
  });

  it("checks contact channels in page details too, and flags contacts that break the rules", async () => {
    const report = {
      ...(await baseReport()),
      contacts: {
        decisionMakerRoles: ["Owner"],
        people: [
          { name: "Jane Rivera", role: "Owner", sourceUrl: ABOUT_URL, quote: "Owner Jane Rivera founded Acme in 2001." },
          { name: "Jeff", role: "Service technician named in a customer testimonial", sourceUrl: SITE, quote: "Serving Boise since 2001." },
        ],
        channels: [
          { kind: "email" as const, value: "jobs@acmeplumbing.example", sourceUrl: CAREERS_URL },
          { kind: "phone" as const, value: "(208) 555-0142", sourceUrl: ABOUT_URL },
          { kind: "email" as const, value: "owner@acmeplumbing.example", sourceUrl: SITE },
        ],
      },
    };
    const checks = checkReport(report, await servedPages(fetcherFor(pages()), [SITE, ABOUT_URL, CAREERS_URL]), { website: SITE });
    expect(checks.channels.map((c) => [c.verdict, c.foundOn])).toEqual([
      ["found", undefined],
      ["found on another page", SITE],
      ["not found", undefined],
    ]);
    expect(checks.flags.map((x) => [x.rule, x.detail])).toEqual([
      ["person not presented as owner or manager", "Jeff, Service technician named in a customer testimonial"],
      ["careers address", "jobs@acmeplumbing.example"],
    ]);
  });

  it("flags outreach without a fit, a value that isn't an illustrative calculation, and an inference on a page not read", async () => {
    const report = {
      ...(await baseReport()),
      opportunityEvidence: [{ statement: "Bookings seem to be taken by hand.", label: "inference" as const, sourceUrl: ABOUT_URL, quote: null }],
      commercial: { supportable: true, value: "$1,500 to $4,500 a month", implementationCost: null, assumptions: [] },
      discovery: { questions: [], outreachSubject: "Partnership", outreachBody: "Hello" },
      qualification: { category: "not a fit" as const, rationale: "Sells the same services." },
    };
    const f = fetcherFor(pages());
    expect(checkReport(report, await servedPages(f, [SITE]), { website: SITE }).flags.map((x) => x.rule)).toEqual([
      "inference without a source read",
      "outreach without a fit",
      "value not shown as an illustrative calculation",
    ]);
    const fixed = {
      ...report,
      commercial: { ...report.commercial, value: "Illustrative: two drain cleanings a month at the site's $150 price is $300.", assumptions: ["Two cleanings a month are lost today."] },
      discovery: { questions: [], outreachSubject: "", outreachBody: "" },
    };
    expect(checkReport(fixed, await servedPages(f, [SITE]), { website: SITE }).flags.map((x) => x.rule)).toEqual(["inference without a source read"]);
  });

  it("tells the models ForgeX's segment, the categories and the v1.3 evidence rules, in the owner's own words where given", () => {
    const prompt = systemPrompt();
    for (const text of [...FOUNDER_RULES, ...FOUNDER_SPEC, FORGEX_SEGMENT, ...Object.values(QUALIFICATION_CATEGORIES)]) expect(prompt).toContain(text);
    for (const rule of [
      "is a hypothesis, never a fact or an inference",
      "Never write a web address or host name",
      "Never name people from reviews, testimonials or blog bylines",
      "never a careers, jobs or résumé address",
      "call it illustrative",
      "otherwise leave the subject and body empty",
      "promise no results",
      "several at a time",
    ]) {
      expect(prompt).toContain(rule);
    }
    expect(READ_PAGE_TOOL.description).toContain("several pages at once");
  });
});

describe("restricted-access runs", () => {
  const termsReason = "its terms forbid systematic or automated data collection without the company's written consent";
  const recording = (inner: ResearchModel) => {
    const requests: ModelRequest[] = [];
    const model: ResearchModel = { ...inner, respond: async (req) => { requests.push(req); return inner.respond(req); } };
    return { model, requests };
  };

  it("never fetches a site whose terms forbid automated collection, and tells the model its identity only", async () => {
    const hits: string[] = [];
    const { model, requests } = recording(simulatedModel());
    const { record } = await researchCompany({ company, model, fetcher: fetcherFor(acmePages(), hits), guard: freeGuard(), restricted: { reason: termsReason, recheck: false } });
    expect(hits).toEqual([]);
    expect(record).toMatchObject({ status: "completed", access: "restricted", sources: [], pagesRequested: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tools: [], toolChoice: "none" });
    expect(requests[0].turns[0]).toEqual({ kind: "user", text: restrictedBrief(company, termsReason) });
    expect(record.report?.qualification.category).toBe("insufficient evidence");
    expect(record.checks?.flags).toEqual([]);
  });

  it("flags a restricted report that guesses", async () => {
    const full = (await researchCompany({ company, model: simulatedModel(), fetcher: fetcherFor(acmePages()), guard: freeGuard() })).record.report!;
    const guessed = { ...full, qualification: { category: "pursue now" as const, rationale: "Looks busy." } };
    const model: ResearchModel = {
      provider: "test",
      model: "simulated",
      respond: async () => ({ status: "completed", text: JSON.stringify(guessed), toolCalls: [], modelSteps: [], usage: { input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 }, model: "simulated" }),
    };
    const { record } = await researchCompany({ company, model, fetcher: fetcherFor(acmePages()), guard: freeGuard(), restricted: { reason: termsReason, recheck: false } });
    expect(record.checks?.quotes.map((q) => q.verdict)).toEqual(["source not read"]);
    expect(record.checks?.flags.map((x) => x.rule)).toEqual(["category despite no site access"]);
  });

  it("tries a refused site once more and keeps it restricted while it still refuses", async () => {
    const hits: string[] = [];
    const { model, requests } = recording(simulatedModel());
    const pages = { ...acmePages(), [SITE]: { status: 403, body: "Forbidden" } };
    const { record } = await researchCompany({ company, model, fetcher: fetcherFor(pages, hits), guard: freeGuard(), restricted: { reason: "its homepage refuses automated requests (HTTP 403)", recheck: true } });
    expect(hits).toEqual(["https://acmeplumbing.example/robots.txt", SITE]);
    expect(record.access).toBe("restricted");
    expect(record.accessNote).toContain("refused");
    expect(record.sources.map((s) => s.outcome)).toEqual(["refused"]);
    expect(requests[0].tools).toEqual([]);
  });

  it("researches a re-checked site in full once it loads and no terms page restricts automated access", async () => {
    const openHome = HOME.replace('<a href="/terms">Terms of use</a>', "");
    const f = fetcherFor({ ...acmePages(), [SITE]: { body: openHome } });
    const { record } = await researchCompany({ company, model: simulatedModel(), fetcher: f, guard: freeGuard(), restricted: { reason: "its homepage answers automated requests with a bot check", recheck: true } });
    expect(record.access).toBe("full");
    expect(record.accessNote).toContain("researched in full");
    expect(record.pagesRequested).toEqual([{ url: "https://acmeplumbing.example/about", outcome: "ok" }]);
  });

  it("keeps a re-checked site restricted when its terms restrict automated access", async () => {
    const { record } = await researchCompany({ company, model: simulatedModel(), fetcher: fetcherFor(acmePages()), guard: freeGuard(), restricted: { reason: "its homepage answers automated requests with a bot check", recheck: true } });
    expect(record.access).toBe("restricted");
    expect(record.accessNote).toContain("https://acmeplumbing.example/terms");
    expect(record.pagesRequested).toEqual([]);
  });
});

describe("Gemini adapter", () => {
  it("sends stateless requests with storage off and maps the reply", async () => {
    const sent: Record<string, unknown>[] = [];
    const fake = {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return {
            id: "int-1",
            status: "requires_action",
            steps: [
              { type: "thought", signature: "opaque" },
              { type: "function_call", id: "fc-1", name: "read_page", arguments: { url: "https://acmeplumbing.example/about" } },
            ],
            usage: { total_input_tokens: 1200, total_cached_tokens: 200, total_output_tokens: 50, total_thought_tokens: 300, total_tokens: 1550 },
          };
        },
      },
    };
    const model = geminiModel("gemini-3.8-flash", fake as never);
    const reply = await model.respond({
      system: "sys",
      turns: [
        { kind: "user", text: "hello" },
        { kind: "model", steps: [{ type: "function_call", id: "a", name: "read_page", arguments: { url: SITE } }] },
        { kind: "tool_results", results: [{ callId: "a", name: "read_page", output: "page text" }] },
      ],
      tools: [READ_PAGE_TOOL],
      toolChoice: "auto",
      outputSchema: { type: "object" },
      maxOutputTokens: 1000,
    });
    expect(sent[0]).toMatchObject({ model: "gemini-3.8-flash", store: false, system_instruction: "sys" });
    expect(sent[0].input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "hello" }] },
      { type: "function_call", id: "a", name: "read_page", arguments: { url: SITE } },
      { type: "function_result", call_id: "a", name: "read_page", result: [{ type: "text", text: "page text" }], is_error: false },
    ]);
    expect(sent[0].response_format).toEqual({ type: "text", mime_type: "application/json", schema: { type: "object" } });
    expect(sent[0].generation_config).toEqual({ max_output_tokens: 1000, tool_choice: "auto" });
    expect(reply.status).toBe("tool_calls");
    expect(reply.toolCalls).toEqual([{ id: "fc-1", name: "read_page", args: { url: "https://acmeplumbing.example/about" } }]);
    expect(reply.usage).toEqual({ input: 1200, cachedInput: 200, output: 50, thinking: 300, toolUse: 0, total: 1550 });
  });

  it("sends no tools and no tool choice for a run without tools", async () => {
    const sent: Record<string, unknown>[] = [];
    const fake = {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return { id: "int-2", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }], usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 } };
        },
      },
    };
    const reply = await geminiModel("gemini-4-argon", fake as never).respond({
      system: "sys", turns: [{ kind: "user", text: "hello" }], tools: [], toolChoice: "none", outputSchema: { type: "object" }, maxOutputTokens: 1000,
    });
    expect(sent[0].tools).toBeUndefined();
    expect(sent[0].generation_config).toEqual({ max_output_tokens: 1000 });
    expect(reply).toMatchObject({ status: "completed", text: "{}" });
  });
});

describe("independence from dataset A", () => {
  const datasetA = JSON.parse(fs.readFileSync("research/pilot-2026-10-treasure-valley/prospects.json", "utf8")) as { prospects: Record<string, unknown>[] };
  const inputs = InputsFile.parse(JSON.parse(fs.readFileSync("research/benchmark-2026-gemini/inputs/benchmark-25.json", "utf8")));

  it("gives Gemini identity fields only, for exactly the 25 pilot companies", () => {
    expect(inputs.companies).toHaveLength(25);
    for (const c of inputs.companies) expect(Object.keys(c).sort()).toEqual(["id", "name", "state", "town", "website"]);
    const pilot = new Set(datasetA.prospects.map((p) => `${p.name}|${p.town}|${p.website}`));
    for (const c of inputs.companies) expect(pilot.has(`${c.name}|${c.town}|${c.website}`)).toBe(true);
    expect(() => InputsFile.parse({ purpose: "x", companies: [{ ...inputs.companies[0], score: 18 }] })).toThrow();
  });

  it("runs all 25: 22 from their websites and 3 restricted, never re-checking the site whose terms forbid automated collection", () => {
    const decisions = JSON.parse(fs.readFileSync("research/benchmark-2026-gemini/access-decisions.json", "utf8")).companies as Record<string, { include: boolean; restricted?: { recheck: boolean } }>;
    const ids = inputs.companies.map((c) => c.id);
    expect(ids.filter((id) => decisions[id]?.include === true)).toHaveLength(22);
    expect(Object.fromEntries(ids.filter((id) => decisions[id]?.include !== true).map((id) => [id, decisions[id]?.restricted?.recheck]))).toEqual({ c03: true, c10: false, c20: true });
  });

  it("puts none of Claude's findings into what Gemini is told", () => {
    const identity = new Set(["id", "name", "legalName", "website", "town", "group", "industry"]);
    const findings: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === "string") {
        if (v.length >= 25 && !/^https?:\/\//.test(v)) findings.push(v);
      } else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    for (const p of datasetA.prospects) for (const [k, v] of Object.entries(p)) if (!identity.has(k)) collect(v);
    expect(findings.length).toBeGreaterThan(100);

    const homepage = { record: { url: SITE, finalUrl: SITE, outcome: "ok" as const, status: 200, detail: "", retrievedAt: "2026-11-01T00:00:00Z", contentType: "text/html", bytes: 1, truncated: false, sha256: null, textSha256: null }, inventory: readHtml(HOME, SITE, SITE) };
    const told = [
      systemPrompt(), JSON.stringify(READ_PAGE_TOOL), JSON.stringify(reportJsonSchema()),
      ...inputs.companies.map((c) => companyBrief(c, homepage)),
      ...inputs.companies.map((c) => restrictedBrief(c, "its homepage refuses automated requests (HTTP 403)")),
    ].join("\n");
    const leaked = findings.filter((s) => told.includes(s));
    expect(leaked).toEqual([]);
  });

  it("keeps the research runtime from reading dataset A or the id map", () => {
    const files = [
      ...fs.readdirSync("src/lib/research").map((f) => path.join("src/lib/research", f)),
      ...fs.readdirSync("src/lib/ai").map((f) => path.join("src/lib/ai", f)),
      "scripts/benchmark-gemini.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/pilot-2026|id-map|prospects\.json|\.claude/);
    }
  });
});
