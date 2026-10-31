import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { readHtml, sameSite, type PageInventory } from "./html";
import { policyFromResponse, robotsAllows, type RobotsPolicy } from "./robots";

// ForgeX's own page fetcher: the only way research reaches the web. It reads public pages on the company's own
// site, honors robots.txt, identifies itself, never signs in or submits forms, and records refusals instead of
// working around them. Page text stays in memory for the run; only fingerprints and metadata are recorded.

export const PRODUCT_TOKEN = "ForgeXResearch";
export const USER_AGENT = `${PRODUCT_TOKEN}/0.1 (+robots.txt honored; no logins, forms or workarounds)`;

/** Sites ForgeX research never reads, whatever a page links to. */
export const BLOCKED_DOMAINS = [
  "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com", "youtube.com",
  "yelp.com", "bbb.org", "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com", "nextdoor.com",
  "houzz.com", "google.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "simplyhired.com",
];

export function isBlockedDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return BLOCKED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

const V4_PRIVATE: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4(ip: string): number {
  return ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

/** True only for addresses on the public internet; private, loopback, link-local and reserved ranges are refused. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return !V4_PRIVATE.some(([base, bits]) => Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));
  }
  if (!net.isIPv6(ip)) return false;
  const a = ip.toLowerCase();
  const embedded = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isPublicAddress(embedded[1]);
  if (a === "::" || a === "::1" || a.startsWith("::ffff:") || a.startsWith("64:ff9b:")) return false;
  if (a.startsWith("2001:db8:") || a.startsWith("2001:0db8:")) return false;
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup used at connect time, so a host can't resolve to a private address between check and use. */
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EBLOCKED" }), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

export type Transport = (url: URL, opts: { maxBytes: number; timeoutMs: number }) => Promise<RawResponse>;

export const nodeTransport: Transport = (url, { maxBytes, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.8",
        },
        lookup: guardedLookup as never,
        timeout: timeoutMs,
      },
      (res) => {
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip())
          : enc === "deflate" ? res.pipe(zlib.createInflate())
          : enc === "br" ? res.pipe(zlib.createBrotliDecompress())
          : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
        };
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            finish();
            res.destroy();
          } else chunks.push(chunk);
        });
        stream.on("end", finish);
        stream.on("error", (e) => (truncated ? finish() : reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs / 1000} s`)));
    req.on("error", reject);
    req.end();
  });

export type FetchOutcome =
  | "ok" | "robots-disallowed" | "refused" | "not-found" | "http-error" | "not-html"
  | "off-site" | "blocked-domain" | "bad-url" | "network-error" | "redirect-limit";

export interface FetchRecord {
  url: string;
  finalUrl: string;
  outcome: FetchOutcome;
  status: number | null;
  detail: string;
  retrievedAt: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  /** SHA-256 of the response body and of the extracted text: proof of what was read, without a copy. */
  sha256: string | null;
  textSha256: string | null;
}

export interface PageResult {
  record: FetchRecord;
  inventory: PageInventory | null;
  /** True when this result came from the cache, read earlier in the same run. */
  fromCache?: boolean;
}

const sha = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

function normalize(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.port) return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const CHALLENGE = /<title>\s*(just a moment|attention required|access denied|security check)|cf-browser-verification|enable javascript and cookies to continue|captcha/i;

/**
 * Where a mission may read (Milestone 2B): the company's own site, when there is one, plus approved sources. The
 * benchmark passes a site root string instead, which means its own site only, exactly as before.
 */
export interface ReadScope {
  siteRoot: string | null;
  /** Approved sources: a domain ("osha.gov", subdomains included) or an address prefix ("https://www.bls.gov/ooh/"). */
  approved: { key: string; match: string }[];
}

const bare = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");

/** True when the address falls under an approved source's domain or address prefix. */
export function matchesSource(url: string, match: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const m = match.trim().toLowerCase();
  if (!m) return false;
  if (m.includes("/")) {
    // "https://x.gov/data" covers /data and /data/..., never /database.
    const want = bare(m);
    const have = bare(u.toString());
    return have.startsWith(want) && (want.endsWith("/") || have.length === want.length || "/?#".includes(have[want.length]));
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const domain = m.replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}

/** The approved source an address belongs to, if any. */
export function approvedSourceFor(url: string, scope: ReadScope): { key: string; match: string } | null {
  return scope.approved.find((a) => matchesSource(url, a.match)) ?? null;
}

export function inScope(url: string, scope: ReadScope): boolean {
  return Boolean((scope.siteRoot && sameSite(url, scope.siteRoot)) || approvedSourceFor(url, scope));
}

export interface FetcherOptions {
  transport?: Transport;
  minIntervalMs?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxTextChars?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class SiteFetcher {
  readonly log: FetchRecord[] = [];
  private robotsCache = new Map<string, Promise<RobotsPolicy>>();
  private pages = new Map<string, PageResult>();
  private lastHit = new Map<string, number>();
  private readonly o: Required<FetcherOptions>;

  constructor(opts: FetcherOptions = {}) {
    this.o = {
      transport: opts.transport ?? nodeTransport,
      minIntervalMs: opts.minIntervalMs ?? 3000,
      maxBytes: opts.maxBytes ?? 2_000_000,
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxTextChars: opts.maxTextChars ?? 30_000,
      now: opts.now ?? (() => new Date()),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  private async politely(host: string) {
    const last = this.lastHit.get(host);
    const wait = last === undefined ? 0 : last + this.o.minIntervalMs - this.o.now().getTime();
    if (wait > 0) await this.o.sleep(wait);
    this.lastHit.set(host, this.o.now().getTime());
  }

  private async get(url: URL): Promise<RawResponse> {
    await this.politely(url.hostname);
    return this.o.transport(url, { maxBytes: this.o.maxBytes, timeoutMs: this.o.timeoutMs });
  }

  robotsFor(origin: string): Promise<RobotsPolicy> {
    let cached = this.robotsCache.get(origin);
    if (!cached) {
      cached = (async () => {
        let url = new URL("/robots.txt", origin);
        for (let hop = 0; hop < 5; hop++) {
          let res: RawResponse;
          try {
            res = await this.get(url);
          } catch {
            return policyFromResponse(null, "", PRODUCT_TOKEN);
          }
          const location = res.headers.location;
          if (res.status >= 300 && res.status < 400 && location) {
            const next = normalize(new URL(location, url).toString());
            if (!next || !sameSite(next.toString(), origin)) return policyFromResponse(null, "", PRODUCT_TOKEN);
            url = next;
            continue;
          }
          return policyFromResponse(res.status, decodeBody(res.body, res.headers["content-type"] ?? ""), PRODUCT_TOKEN);
        }
        return policyFromResponse(null, "", PRODUCT_TOKEN);
      })();
      this.robotsCache.set(origin, cached);
    }
    return cached;
  }

  /** The text of a page read earlier in this run, for checking quotes. Never written to disk. */
  textOf(url: string): string | null {
    const u = normalize(url);
    const hit = u ? (this.pages.get(u.toString()) ?? [...this.pages.values()].find((p) => p.record.finalUrl === u.toString())) : undefined;
    return hit?.inventory?.text ?? null;
  }

  async fetchPage(rawUrl: string, within: string | ReadScope): Promise<PageResult> {
    const scope: ReadScope = typeof within === "string" ? { siteRoot: within, approved: [] } : within;
    const company = typeof within === "string";
    // Links are read relative to the site a page belongs to: the company's, or the approved source's own.
    const rootOf = (u: URL) => (scope.siteRoot && sameSite(u.toString(), scope.siteRoot) ? scope.siteRoot : u.origin);
    const startedAt = this.o.now().toISOString();
    const fail = (outcome: FetchOutcome, detail: string, status: number | null = null, finalUrl = rawUrl): PageResult => {
      const record: FetchRecord = {
        url: rawUrl, finalUrl, outcome, status, detail, retrievedAt: startedAt,
        contentType: "", bytes: 0, truncated: false, sha256: null, textSha256: null,
      };
      this.log.push(record);
      return { record, inventory: null };
    };

    let url = normalize(rawUrl);
    if (!url) return fail("bad-url", "Only plain http(s) addresses on default ports are read.");
    if (isBlockedDomain(url.hostname)) return fail("blocked-domain", `${url.hostname} is on ForgeX's blocked list.`);
    if (!inScope(url.toString(), scope)) {
      return fail("off-site", company ? "Only pages on the company's own website are read." : "Only pages on the company's own website and approved sources are read.");
    }
    const cached = this.pages.get(url.toString());
    if (cached) return { ...cached, fromCache: true };

    for (let hop = 0; hop <= 5; hop++) {
      const policy = await this.robotsFor(url.origin);
      if (!robotsAllows(policy, url.pathname + url.search)) {
        const why = policy.kind === "disallow-all" ? policy.reason : "robots.txt disallows this path";
        return fail("robots-disallowed", why, null, url.toString());
      }
      let res: RawResponse;
      try {
        res = await this.get(url);
      } catch (e) {
        return fail("network-error", e instanceof Error ? e.message : String(e), null, url.toString());
      }
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        const next = normalize(new URL(location, url).toString());
        if (!next) return fail("bad-url", `Redirected to an unsupported address: ${location}`, res.status, url.toString());
        if (isBlockedDomain(next.hostname) || !inScope(next.toString(), scope)) {
          const where = company ? "off the company's site" : "outside the company's site and approved sources";
          return fail("off-site", `Redirected ${where} to ${next.toString()}`, res.status, next.toString());
        }
        url = next;
        continue;
      }
      const contentType = res.headers["content-type"] ?? "";
      if ([401, 403, 429, 451].includes(res.status)) return fail("refused", `The site refused automated access (HTTP ${res.status}).`, res.status, url.toString());
      if (res.status === 404 || res.status === 410) return fail("not-found", `HTTP ${res.status}`, res.status, url.toString());
      if (res.status >= 400) {
        const challenge = CHALLENGE.test(decodeBody(res.body.subarray(0, 20_000), contentType));
        return fail(challenge ? "refused" : "http-error", challenge ? `Bot check (HTTP ${res.status}); not worked around.` : `HTTP ${res.status}`, res.status, url.toString());
      }
      if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
        return fail("not-html", `Not a web page (${contentType || "no content type"}).`, res.status, url.toString());
      }
      const html = decodeBody(res.body, contentType);
      if (CHALLENGE.test(html.slice(0, 20_000)) && html.length < 60_000) {
        return fail("refused", "The site answered with a bot check; not worked around.", res.status, url.toString());
      }
      const inventory = /text\/plain/i.test(contentType)
        ? { ...readHtml("", url.toString(), rootOf(url)), text: html.slice(0, this.o.maxTextChars), textTruncated: html.length > this.o.maxTextChars }
        : readHtml(html, url.toString(), rootOf(url), this.o.maxTextChars);
      const record: FetchRecord = {
        url: rawUrl, finalUrl: url.toString(), outcome: "ok", status: res.status, detail: "",
        retrievedAt: this.o.now().toISOString(), contentType, bytes: res.body.length, truncated: res.truncated,
        sha256: sha(res.body), textSha256: sha(inventory.text),
      };
      this.log.push(record);
      const result = { record, inventory };
      this.pages.set(normalize(rawUrl)!.toString(), result);
      this.pages.set(url.toString(), result);
      return result;
    }
    return fail("redirect-limit", "More than 5 redirects.", null, url.toString());
  }
}

// Site terms that forbid automated access are flagged for a person to decide; the pre-check never guesses.
const TERMS_LINK = /\b(terms|conditions|legal|tos)\b/i;
const ANTI_AUTOMATION =
  /\b(robots?|spiders?|crawl(?:er|ers|ing)?|scrap(?:e|er|ers|ing)|data[- ]mining|harvest(?:ing)?|automated (?:means|systems?|tools?|access|devices?|quer(?:y|ies)|programs?|scripts?|software))\b/gi;

export function termsLinks(inventory: PageInventory): string[] {
  return inventory.links
    .filter((l) => TERMS_LINK.test(l.text) || TERMS_LINK.test(new URL(l.url).pathname.replace(/[-_/]/g, " ")))
    .map((l) => l.url)
    .slice(0, 2);
}

/** Short excerpts around wording that may forbid automated access; nearby matches share one excerpt. */
export function antiAutomationExcerpts(text: string): string[] {
  const out: string[] = [];
  let coveredUntil = -1;
  for (const m of text.matchAll(ANTI_AUTOMATION)) {
    const at = m.index ?? 0;
    if (at < coveredUntil) continue;
    out.push(text.slice(Math.max(0, at - 120), at + 120).replace(/\s+/g, " ").trim());
    coveredUntil = at + 120;
    if (out.length >= 5) break;
  }
  return out;
}
