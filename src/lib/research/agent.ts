import type { ResearchModel, TokenUsage, ToolResult, Turn } from "../ai/types";
import { BudgetStop, type BudgetGuard } from "./budget";
import { antiAutomationExcerpts, termsLinks, type FetchRecord, type PageResult, type SiteFetcher } from "./fetcher";
import { ReportSchema, reportJsonSchema, type ReportClaim, type ResearchReport } from "./schema";
import { MAX_PAGES, READ_PAGE_TOOL, companyBrief, formatPage, restrictedBrief, systemPrompt, type CompanyInput } from "./spec";

// One company, one model: the research loop. The model may only call read_page, which goes through ForgeX's
// fetcher; every request is cleared with the budget guard first. Quotes are checked only against the pages this
// run was actually served (its text and its technical details) while that text is still in memory, because the
// text itself is never stored. Pages can come from the fetcher's shared cache, so the run keeps its own list.
// A company whose site ForgeX may not or cannot read gets a restricted run: its identity only, and no page tool.

export const MAX_TURNS = 12;
export const MAX_OUTPUT_TOKENS = 32_000;

const CREDENTIAL =
  /AIza[0-9A-Za-z_-]{35}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{36}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/;

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL.test(text);
}

export type CompanyStatus = "completed" | "invalid-report" | "no-site-access" | "stopped" | "failed";

export interface QuoteCheck {
  section: string;
  sourceUrl: string | null;
  quote: string | null;
  /**
   * "found in page details": in the cited page's script, frame, host, link, form, phone or email details, not its
   * text. "found on another page": not on the cited page, but on another page this run was served (foundOn).
   */
  verdict: "found" | "found in page details" | "found on another page" | "not found" | "source not read" | "no quote";
  foundOn?: string;
}

export interface ChannelCheck {
  kind: string;
  value: string;
  sourceUrl: string;
  verdict: "found" | "found on another page" | "not found" | "source not read";
  foundOn?: string;
}

/** A breach of ForgeX's evidence rules that a program can see. Whether a claim says more than its quote is left to the evaluation. */
export interface RuleFlag {
  rule:
    | "link not on a page read"
    | "inference without a source read"
    | "person not presented as owner or manager"
    | "careers address"
    | "outreach without a fit"
    | "value not shown as an illustrative calculation"
    | "category despite no site access";
  where: string;
  detail: string;
}

export interface RuntimeChecks {
  quotes: QuoteCheck[];
  channels: ChannelCheck[];
  flags: RuleFlag[];
  summary: {
    facts: number;
    /** Quotes found on the cited page, in its text or its details; quotesFoundInDetails counts the latter. */
    quotesFound: number;
    quotesFoundInDetails: number;
    quotesOnAnotherPage: number;
    quotesNotFound: number;
    sourcesNotRead: number;
    factsWithoutQuote: number;
    inferences: number;
    hypotheses: number;
    channelsFound: number;
    channelsOnAnotherPage: number;
    channelsNotFound: number;
    flags: number;
  };
}

/** Why a company gets a restricted run, as the runner reads it from access-decisions.json. */
export interface RestrictedAccess {
  /** Why ForgeX doesn't read the site, in the words the model is told. */
  reason: string;
  /** Whether the homepage may be tried once more at run time; never when the site's terms forbid automated collection. */
  recheck: boolean;
}

export interface CompanyRunRecord {
  company: CompanyInput;
  model: string;
  status: CompanyStatus;
  stopReason?: string;
  /** "restricted": ForgeX didn't read the site (accessNote says why), so the model was told the company's identity only. */
  access?: "full" | "restricted";
  accessNote?: string;
  startedAt: string;
  finishedAt: string;
  report: ResearchReport | null;
  reportErrors: string[];
  /** Only kept when the final answer failed validation, to see what went wrong. */
  invalidReportText?: string;
  checks: RuntimeChecks | null;
  /** Every page this run was served, including ones the fetcher already held from an earlier run. */
  sources: SourceRecord[];
  pagesRequested: { url: string; outcome: string }[];
  turns: number;
  usage: TokenUsage;
  costUsd: number;
  /** The model's steps without thought signatures. Page text is never included. */
  modelTrace: unknown[];
}

export interface SourceRecord extends FetchRecord {
  /** True when the page came from the fetcher's cache; retrievedAt is then the time it was first fetched. */
  fromCache: boolean;
}

/** The pages one run was served, keyed so that http/https, "www." and a trailing slash don't matter. */
export type ServedPages = Map<string, PageResult>;

export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

export function addServed(served: ServedPages, requestedUrl: string, page: PageResult) {
  served.set(urlKey(requestedUrl), page);
  served.set(urlKey(page.record.finalUrl), page);
}

/** The technical details a page exposes, as one searchable text. */
export function pageDetails(page: PageResult): string {
  const inv = page.inventory;
  if (!inv) return "";
  return [
    ...inv.scriptSources, ...inv.frameSources, ...inv.otherHosts,
    ...inv.links.map((l) => `${l.url} ${l.text}`), ...inv.forms.map((f) => f.action), ...inv.phones, ...inv.emails,
  ].join("\n");
}

function sourcesOf(served: ServedPages): SourceRecord[] {
  const seen = new Map<string, SourceRecord>();
  for (const page of served.values()) {
    const key = `${page.record.finalUrl}|${page.record.outcome}`;
    if (!seen.has(key)) seen.set(key, { ...page.record, fromCache: page.fromCache ?? false });
  }
  return [...seen.values()];
}

const zeroUsage = (): TokenUsage => ({ input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 });

function addUsage(a: TokenUsage, b: TokenUsage) {
  a.input += b.input;
  a.cachedInput += b.cachedInput;
  a.output += b.output;
  a.thinking += b.thinking;
  a.toolUse += b.toolUse;
  a.total += b.total;
}

function stripSignatures(steps: unknown[]): unknown[] {
  return steps.map((s) => {
    if (s && typeof s === "object" && "signature" in s) {
      const { signature: _omit, ...rest } = s as Record<string, unknown>;
      return { ...rest, signature: "[omitted]" };
    }
    return s;
  });
}

export function parseReport(text: string): { ok: true; report: ResearchReport } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The answer was not valid JSON."] };
  }
  const parsed = ReportSchema.safeParse(json);
  if (parsed.success) return { ok: true, report: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** A quote counts as found when each part (split at ellipses) appears on the page, in order. */
export function quoteOnPage(quote: string, pageText: string): boolean {
  const page = norm(pageText);
  let from = 0;
  for (const part of quote.split(/\.\.\.|…/).map(norm).filter(Boolean)) {
    const at = page.indexOf(part.replace(/^"|"$/g, ""), from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

export const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** North American phone numbers written in a page's text. */
export function phonesIn(text: string): string[] {
  return [...text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)].map((m) => m[0]);
}

export const DECISION_MAKER = /\b(owner|co-?owner|founder|co-?founder|president|ceo|coo|cfo|cto|chief|executive|vice president|vp|director|manager|partner|principal|proprietor|head of)\b/i;
export const NAMED_BY_OTHERS = /testimonial|review|byline|customer/i;
export const CAREERS_EMAIL = /^(mailto:)?(jobs?|careers?|hiring|hr|recruit\w*|resumes?|employment|apply)@/i;
export const CAREERS_PATH = /\/(jobs?|careers?|hiring|employment|apply)(\/|\?|#|$)/i;

/** Web addresses and host names in a text: full URLs, and bare lowercase host names with an optional path. */
export const LINKISH = /\bhttps?:\/\/[^\s"'<>)\]]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s"'<>)\]]*)?/g;
/** Bare names like jquery.min.js look like hosts but are files. */
export const FILE_NAME = /\.(js|css|php|html?|png|jpe?g|gif|svg|webp|json|xml|txt|pdf|aspx?|zip)$/;

/** A URL or host reduced to what it takes to find it on a page: no scheme, "www.", fragment or trailing slash. */
export const bareLink = (s: string) =>
  s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/#.*$/, "").replace(/[/.,;:!?'"]+$/, "");

/** Every web address and host the run's readable pages show, plus the company's own website, as one text. */
export function knownLinks(served: ServedPages, website: string): string {
  const parts = [website];
  for (const page of served.values()) {
    if (page.record.outcome !== "ok" || !page.inventory) continue;
    parts.push(page.record.url, page.record.finalUrl, page.inventory.text, pageDetails(page));
  }
  return parts.join("\n").toLowerCase().replace(/https?:\/\/(www\.)?/g, "");
}

/**
 * Checks the report against the pages this run was served, and nothing else: each fact's quote, each contact
 * channel, and the evidence rules a program can check. A restricted run was served no readable page, so all of its
 * facts fail and any category but "insufficient evidence" is flagged.
 */
export function checkReport(
  report: ResearchReport,
  served: ServedPages,
  opts: { website: string; restricted?: boolean },
): RuntimeChecks {
  const quotes: QuoteCheck[] = [];
  const flags: RuleFlag[] = [];
  const summary: RuntimeChecks["summary"] = {
    facts: 0, quotesFound: 0, quotesFoundInDetails: 0, quotesOnAnotherPage: 0, quotesNotFound: 0, sourcesNotRead: 0,
    factsWithoutQuote: 0, inferences: 0, hypotheses: 0, channelsFound: 0, channelsOnAnotherPage: 0, channelsNotFound: 0, flags: 0,
  };
  const pageAt = (url: string | null) => {
    const page = url ? served.get(urlKey(url)) : undefined;
    return page?.record.outcome === "ok" && page.inventory ? page : null;
  };
  const readable = [...new Map([...served.values()].filter((p) => p.record.outcome === "ok" && p.inventory).map((p) => [p.record.finalUrl, p])).values()];
  /** The first other page this run was served on which `has` holds. */
  const elsewhere = (cited: PageResult, has: (page: PageResult) => boolean) =>
    readable.find((p) => p.record.finalUrl !== cited.record.finalUrl && has(p))?.record.finalUrl;
  const quoteOn = (quote: string, page: PageResult) => quoteOnPage(quote, page.inventory!.text) || quoteOnPage(quote, pageDetails(page));
  const claims: [string, ReportClaim][] = [
    ...report.identity.claims.map((c) => ["identity", c] as [string, ReportClaim]),
    ...report.industry.claims.map((c) => ["industry", c] as [string, ReportClaim]),
    ...report.publicInformation.claims.map((c) => ["publicInformation", c] as [string, ReportClaim]),
    ...report.licensing.claims.map((c) => ["licensing", c] as [string, ReportClaim]),
    ...report.existingSoftware.map((s) => ["existingSoftware", s.evidence] as [string, ReportClaim]),
    ...report.opportunityEvidence.map((c) => ["opportunityEvidence", c] as [string, ReportClaim]),
    ...report.contacts.people.map(
      (p) => ["contacts.people", { statement: `${p.name}, ${p.role}`, label: "fact", sourceUrl: p.sourceUrl, quote: p.quote }] as [string, ReportClaim],
    ),
  ];
  for (const [section, c] of claims) {
    if (c.label === "inference") {
      summary.inferences++;
      if (!pageAt(c.sourceUrl)) flags.push({ rule: "inference without a source read", where: section, detail: c.statement.slice(0, 160) });
    }
    if (c.label === "hypothesis") summary.hypotheses++;
    if (c.label !== "fact") continue;
    summary.facts++;
    const page = pageAt(c.sourceUrl);
    let verdict: QuoteCheck["verdict"];
    let foundOn: string | undefined;
    if (!c.quote?.trim()) verdict = "no quote";
    else if (!page) verdict = "source not read";
    else if (quoteOnPage(c.quote, page.inventory!.text)) verdict = "found";
    else if (quoteOnPage(c.quote, pageDetails(page))) verdict = "found in page details";
    else {
      foundOn = elsewhere(page, (p) => quoteOn(c.quote!, p));
      verdict = foundOn ? "found on another page" : "not found";
    }
    if (verdict === "found" || verdict === "found in page details") summary.quotesFound++;
    if (verdict === "found in page details") summary.quotesFoundInDetails++;
    else if (verdict === "found on another page") summary.quotesOnAnotherPage++;
    else if (verdict === "not found") summary.quotesNotFound++;
    else if (verdict === "source not read") summary.sourcesNotRead++;
    else if (verdict === "no quote") summary.factsWithoutQuote++;
    quotes.push({ section, sourceUrl: c.sourceUrl, quote: c.quote, verdict, ...(foundOn ? { foundOn } : {}) });
  }

  // Channels are looked for in the same places as quotes: the page's text, then its details (a mailto or a
  // malformed link that only the details show).
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
  const channels: ChannelCheck[] = report.contacts.channels.map((ch) => {
    const page = pageAt(ch.sourceUrl);
    if (!page) return { ...ch, verdict: "source not read" as const };
    if (channelOn(ch, page)) return { ...ch, verdict: "found" as const };
    const foundOn = elsewhere(page, (p) => channelOn(ch, p));
    return foundOn ? { ...ch, verdict: "found on another page" as const, foundOn } : { ...ch, verdict: "not found" as const };
  });
  summary.channelsFound = channels.filter((c) => c.verdict === "found").length;
  summary.channelsOnAnotherPage = channels.filter((c) => c.verdict === "found on another page").length;
  summary.channelsNotFound = channels.filter((c) => c.verdict === "not found" || c.verdict === "source not read").length;

  report.contacts.people.forEach((p, i) => {
    if (!DECISION_MAKER.test(p.role) || NAMED_BY_OTHERS.test(p.role)) {
      flags.push({ rule: "person not presented as owner or manager", where: `contacts.people.${i}`, detail: `${p.name}, ${p.role}` });
    }
  });
  report.contacts.channels.forEach((ch, i) => {
    if (CAREERS_EMAIL.test(ch.value.trim()) || CAREERS_PATH.test(ch.value)) {
      flags.push({ rule: "careers address", where: `contacts.channels.${i}`, detail: ch.value });
    }
  });

  const known = knownLinks(served, opts.website);
  const findLinks = (value: unknown, where: string) => {
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

  const { category } = report.qualification;
  if ((category === "not a fit" || category === "insufficient evidence") && (report.discovery.outreachSubject.trim() || report.discovery.outreachBody.trim())) {
    flags.push({ rule: "outreach without a fit", where: "discovery", detail: `An outreach draft for a company rated "${category}".` });
  }
  const { value, assumptions } = report.commercial;
  if (value?.trim() && (!assumptions.length || !/illustrative/i.test(value))) {
    flags.push({ rule: "value not shown as an illustrative calculation", where: "commercial.value", detail: value.slice(0, 160) });
  }
  if (opts.restricted && category !== "insufficient evidence") {
    flags.push({ rule: "category despite no site access", where: "qualification.category", detail: category });
  }
  summary.flags = flags.length;
  return { quotes, channels, flags, summary };
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

export interface ResearchResult {
  record: CompanyRunRecord;
  /** Set when the whole run must stop, after this company's record is saved. */
  runStop?: BudgetStop;
}

/**
 * Tries a refused site once more, the way the preflight did: its homepage, then the terms pages it links. Access
 * counts as restored only if the homepage loads and no terms page restricts automated access.
 */
async function recheckAccess(fetcher: SiteFetcher, website: string): Promise<{ homepage: PageResult; restored: boolean; note: string }> {
  const homepage = await fetcher.fetchPage(website, website);
  if (homepage.record.outcome !== "ok" || !homepage.inventory) {
    return { homepage, restored: false, note: `Homepage tried again at run time: ${homepage.record.outcome} (${homepage.record.detail}).` };
  }
  for (const url of termsLinks(homepage.inventory)) {
    const page = await fetcher.fetchPage(url, website);
    const text = page.record.finalUrl === homepage.record.finalUrl ? null : fetcher.textOf(url);
    if (text && antiAutomationExcerpts(text).length) {
      return { homepage, restored: false, note: `The homepage loads again, but ${url} may restrict automated access; the site needs a new access decision.` };
    }
  }
  return { homepage, restored: true, note: "The homepage loads again at run time and no terms page restricts automated access, so the site was researched in full." };
}

export async function researchCompany(opts: {
  company: CompanyInput;
  model: ResearchModel;
  fetcher: SiteFetcher;
  guard: BudgetGuard;
  /** Set for a company whose site ForgeX may not or cannot read; the run then gets its identity only. */
  restricted?: RestrictedAccess;
  redact?: (text: string) => string;
  now?: () => Date;
}): Promise<ResearchResult> {
  const { company, model, fetcher, guard } = opts;
  const now = opts.now ?? (() => new Date());
  const redact = opts.redact ?? ((t: string) => t);
  const served: ServedPages = new Map();
  const usage = zeroUsage();
  const trace: unknown[] = [];
  const pagesRequested: { url: string; outcome: string }[] = [];
  const record: CompanyRunRecord = {
    company, model: model.model, status: "failed", access: opts.restricted ? "restricted" : "full", startedAt: now().toISOString(), finishedAt: "",
    report: null, reportErrors: [], checks: null, sources: [], pagesRequested, turns: 0, usage, costUsd: 0, modelTrace: trace,
  };
  const done = (patch: Partial<CompanyRunRecord>, runStop?: BudgetStop): ResearchResult => {
    Object.assign(record, patch);
    record.finishedAt = now().toISOString();
    record.sources = sourcesOf(served);
    record.costUsd = guard.companySpentUsd;
    if (record.report) record.checks = checkReport(record.report, served, { website: company.website, restricted: record.access === "restricted" });
    return { record, runStop };
  };

  guard.startCompany(company.id, model.model);
  let homepage: PageResult | null = null;
  if (opts.restricted) {
    record.accessNote = `Not fetched: ${opts.restricted.reason}.`;
    if (opts.restricted.recheck) {
      const access = await recheckAccess(fetcher, company.website);
      addServed(served, company.website, access.homepage);
      record.accessNote = access.note;
      if (access.restored) {
        record.access = "full";
        homepage = access.homepage;
      }
    }
  } else {
    homepage = await fetcher.fetchPage(company.website, company.website);
    addServed(served, company.website, homepage);
    if (homepage.record.outcome !== "ok") {
      return done({ status: "no-site-access", stopReason: `${homepage.record.outcome}: ${homepage.record.detail}` });
    }
  }

  const restricted = !homepage;
  const tools = restricted ? [] : [READ_PAGE_TOOL];
  const system = systemPrompt();
  const schema = reportJsonSchema();
  const brief = homepage ? companyBrief(company, homepage) : restrictedBrief(company, opts.restricted!.reason);
  const turns: Turn[] = [{ kind: "user", text: brief }];
  let pages = 1;
  let repairs = 1;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      record.turns = turn + 1;
      const forceAnswer = restricted || pages >= MAX_PAGES || turn >= MAX_TURNS - 2;
      const estimatedInput = Math.ceil((system.length + JSON.stringify(schema).length + JSON.stringify(turns).length) / 3);
      guard.reserve(model.model, estimatedInput, MAX_OUTPUT_TOKENS);
      let reply;
      try {
        reply = await model.respond({
          system, turns, tools, toolChoice: forceAnswer ? "none" : "auto",
          outputSchema: schema, maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
      } catch (e) {
        const status = statusOf(e);
        const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
        guard.noteError(status);
        if (status === 400 || status === 401 || status === 403 || status === 404) {
          return done({ status: "failed", stopReason: `API error ${status}: ${message}` });
        }
        continue;
      }
      guard.record(model.model, reply.usage, reply.id);
      addUsage(usage, reply.usage);
      trace.push(...stripSignatures(reply.modelSteps));
      if (looksLikeCredential(reply.text) || reply.toolCalls.some((c) => looksLikeCredential(JSON.stringify(c.args)))) {
        throw new BudgetStop("A response contained something that looks like a credential.", "run");
      }
      turns.push({ kind: "model", steps: reply.modelSteps });

      if (reply.status === "tool_calls") {
        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) {
          if (call.name !== READ_PAGE_TOOL.name || restricted) throw new BudgetStop(`The model asked for a tool that isn't allowed: ${call.name}.`, "run");
          const url = typeof call.args.url === "string" ? call.args.url : "";
          if (pages >= MAX_PAGES) {
            results.push({ callId: call.id, name: call.name, output: `The ${MAX_PAGES}-page limit is reached. Write the report now.`, isError: true });
            continue;
          }
          const page = await fetcher.fetchPage(url, company.website);
          addServed(served, url, page);
          pages++;
          pagesRequested.push({ url, outcome: page.record.outcome });
          results.push({ callId: call.id, name: call.name, output: formatPage(page), isError: page.record.outcome !== "ok" });
        }
        turns.push({ kind: "tool_results", results });
        continue;
      }
      if (reply.status !== "completed") return done({ status: "failed", stopReason: reply.detail ?? reply.status });

      const parsed = parseReport(reply.text);
      if (parsed.ok) return done({ status: "completed", report: parsed.report });
      if (repairs-- > 0) {
        turns.push({ kind: "user", text: `The report didn't match the required format: ${parsed.errors.slice(0, 8).join("; ")}. Return the corrected JSON only.` });
        continue;
      }
      return done({ status: "invalid-report", reportErrors: parsed.errors, invalidReportText: reply.text });
    }
    return done({ status: "stopped", stopReason: `Turn limit of ${MAX_TURNS} reached.` });
  } catch (e) {
    if (e instanceof BudgetStop) {
      return done({ status: "stopped", stopReason: e.message }, e.scope === "run" ? e : undefined);
    }
    throw e;
  }
}
