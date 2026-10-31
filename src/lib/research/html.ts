// Reads what a research page shows: visible text, links, and the technical details it exposes (script and
// frame sources, form targets, other hosts it references, phone and email links). Nothing here keeps a copy.

export interface PageInventory {
  title: string;
  description: string;
  text: string;
  textTruncated: boolean;
  links: { url: string; text: string }[];
  scriptSources: string[];
  frameSources: string[];
  forms: { action: string; method: string }[];
  otherHosts: string[];
  phones: string[];
  emails: string[];
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim() : null;
}

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function sameSite(url: string, siteRoot: string): boolean {
  try {
    const a = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const b = new URL(siteRoot).hostname.toLowerCase().replace(/^www\./, "");
    return a === b || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

export function readHtml(html: string, pageUrl: string, siteRoot: string, maxTextChars = 30_000): PageInventory {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = stripTags(noComments.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metaTag = noComments.match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i)?.[0] ?? "";
  const description = metaTag ? (attr(metaTag, "content") ?? "") : "";

  const scriptSources = new Set<string>();
  for (const m of noComments.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    const abs = src ? resolve(src, pageUrl) : null;
    if (abs) scriptSources.add(abs);
  }
  const frameSources = new Set<string>();
  for (const m of noComments.matchAll(/<iframe\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    const abs = src ? resolve(src, pageUrl) : null;
    if (abs) frameSources.add(abs);
  }
  const forms: { action: string; method: string }[] = [];
  for (const m of noComments.matchAll(/<form\b[^>]*>/gi)) {
    const action = attr(m[0], "action");
    forms.push({ action: action ? (resolve(action, pageUrl) ?? action) : pageUrl, method: (attr(m[0], "method") ?? "get").toLowerCase() });
  }

  const links = new Map<string, string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const m of noComments.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href) continue;
    if (/^tel:/i.test(href)) phones.add(decodeURIComponent(href.slice(4)).trim());
    else if (/^mailto:/i.test(href)) emails.add(decodeURIComponent(href.slice(7).split("?")[0]).trim());
    else {
      const abs = resolve(href, pageUrl);
      if (abs && /^https?:/i.test(abs) && sameSite(abs, siteRoot)) {
        const clean = abs.split("#")[0];
        if (!links.has(clean)) links.set(clean, stripTags(m[2]).slice(0, 80));
      }
    }
  }

  const ownHost = new URL(siteRoot).hostname.toLowerCase().replace(/^www\./, "");
  const otherHosts = new Set<string>();
  for (const m of noComments.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const host = m[1].toLowerCase().replace(/^www\./, "");
    if (host !== ownHost && !host.endsWith(`.${ownHost}`)) otherHosts.add(host);
  }

  // Navigation menus are listed as links above, so their text is dropped, and short lines repeated by a second
  // copy of a menu are kept once; both only waste the model's reading budget.
  const visible = noComments
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|svg|template|nav)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/ul|\/ol|\/table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const seen = new Set<string>();
  const text = decodeEntities(visible)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      if (line.length >= 80) return true;
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");

  return {
    title,
    description,
    text: text.slice(0, maxTextChars),
    textTruncated: text.length > maxTextChars,
    links: [...links].slice(0, 80).map(([url, t]) => ({ url, text: t })),
    scriptSources: [...scriptSources].slice(0, 60),
    frameSources: [...frameSources].slice(0, 20),
    forms: forms.slice(0, 20),
    otherHosts: [...otherHosts].sort().slice(0, 80),
    phones: [...phones].slice(0, 10),
    emails: [...emails].slice(0, 10),
  };
}
