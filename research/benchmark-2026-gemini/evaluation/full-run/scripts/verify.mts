// Re-reads, with ForgeX's own polite fetcher, the pages behind unresolved quotes and key qualification evidence in
// the full run, for the evaluation. Free (no model calls); robots.txt honored; nothing written to disk.
// Usage (from the repository root): npx tsx <this file> <id,id,...> ["needle|needle" per id as id=needles ...]
import fs from "node:fs";
import path from "node:path";
import { SiteFetcher } from "../../../../../src/lib/research/fetcher.ts";

const ROOT = "research/benchmark-2026-gemini/full-run";
const MODELS = ["gemini-4-argon", "gemini-3.8-flash"];
const norm = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

const ids = (process.argv[2] ?? "").split(",").filter(Boolean);
const needles: Record<string, string[]> = {};
for (const a of process.argv.slice(3)) {
  const [id, list] = a.split("=");
  needles[id] = list.split("|");
}

const fetcher = new SiteFetcher();
const pages = new Map<string, Awaited<ReturnType<SiteFetcher["fetchPage"]>>>();
async function read(url: string, site: string) {
  if (!pages.has(url)) pages.set(url, await fetcher.fetchPage(url, site));
  return pages.get(url)!;
}
const fields = (p: Awaited<ReturnType<typeof read>>) => {
  const inv = p.inventory!;
  return {
    text: inv.text,
    title: inv.title,
    description: inv.description,
    details: [...inv.scriptSources, ...inv.frameSources, ...inv.otherHosts, ...inv.links.map((l) => `${l.url} ${l.text}`),
      ...inv.forms.map((f) => `${f.action} (${f.method})`), ...inv.phones, ...inv.emails].join("\n"),
  };
};
const around = (hay: string, at: number, len: number) => hay.slice(Math.max(0, at - 90), at + len + 90).replace(/\s+/g, " ");

for (const id of ids) {
  const recs = MODELS.map((m) => JSON.parse(fs.readFileSync(path.join(ROOT, m, `${id}.json`), "utf8")));
  const site = recs[0].company.website;
  console.log(`\n######## ${id} ${recs[0].company.name} (${site})`);
  // A. Unresolved quotes.
  for (const r of recs) for (const q of r.checks?.quotes ?? []) {
    if (q.verdict === "found" || q.verdict === "found in page details") continue;
    const p = await read(q.sourceUrl, site);
    const was = r.sources.find((s: any) => s.finalUrl === p.record.finalUrl || s.url === q.sourceUrl);
    console.log(`\n[${r.model.replace("gemini-", "")}] ${q.verdict}: "${q.quote}"\n   page ${q.sourceUrl} -> ${p.record.outcome}; text ${was?.textSha256 === p.record.textSha256 ? "unchanged since the run" : "CHANGED since the run"}`);
    if (!p.inventory) continue;
    const f = fields(p);
    const nq = norm(q.quote);
    const where = (Object.keys(f) as (keyof typeof f)[]).filter((k) => norm(f[k]).includes(nq));
    if (where.length) { console.log(`   found now in: ${where.join(", ")}`); continue; }
    const t = norm(f.text);
    let n = nq.length;
    while (n > 12 && !t.includes(nq.slice(0, n))) n = Math.floor(n * 0.8);
    const at = t.indexOf(nq.slice(0, n));
    console.log(at >= 0 ? `   longest matching start (${n} of ${nq.length} chars): ...${around(t, at, n)}...` : "   no matching start in the text");
    console.log(`   title: ${f.title}\n   description: ${f.description.slice(0, 200)}`);
  }
  // B. Evidence needles across every page either model read.
  if (!needles[id]) continue;
  const urls = [...new Set(recs.flatMap((r) => r.sources.filter((s: any) => s.outcome === "ok").map((s: any) => s.finalUrl)))] as string[];
  const read_ = [];
  for (const u of urls) read_.push({ u, p: await read(u, site) });
  console.log(`\n   evidence over ${urls.length} pages:`);
  for (const nd of needles[id]) {
    const hits: string[] = [];
    for (const { u, p } of read_) {
      if (!p.inventory) continue;
      const f = fields(p);
      for (const k of Object.keys(f) as (keyof typeof f)[]) {
        const h = norm(f[k]);
        const at = h.indexOf(norm(nd));
        if (at >= 0) { hits.push(`${u.replace(/^https?:\/\/(www\.)?[^/]+/, "") || "/"} [${k}]: ...${around(h, at, nd.length)}...`); break; }
      }
    }
    console.log(`   * "${nd}": ${hits.length ? `${hits.length} page(s)\n       ${hits.slice(0, 2).join("\n       ")}` : "NOT on any page read"}`);
  }
  const changed = read_.filter(({ u, p }) => !recs.some((r) => r.sources.some((s: any) => s.finalUrl === u && s.textSha256 === p.record.textSha256)));
  console.log(`   pages whose text changed since the run: ${changed.length ? changed.map((c) => c.u).join(", ") : "none"}`);
}
