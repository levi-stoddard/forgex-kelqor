// Checks every specific (money, percentage, number of two or more digits, phone, email) in every fact and inference
// statement of the full run's main records against the pages that run was served, re-read with ForgeX's polite
// fetcher. Free; robots.txt honored; page text kept in memory only. Writes a JSON summary to the path given.
// Usage (from the repository root): npx tsx <this file> <out.json> [ids, default all]
import fs from "node:fs";
import path from "node:path";
import { SiteFetcher } from "../../../../../src/lib/research/fetcher.ts";

const ROOT = "research/benchmark-2026-gemini/full-run";
const MODELS = ["gemini-4-argon", "gemini-3.8-flash"];
const out = process.argv[2];
const only = process.argv[3]?.split(",");
const flat = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/\D/g, "");

function specifics(statement: string): string[] {
  const s = flat(statement);
  const found = new Set<string>();
  for (const m of s.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) found.add(m[0]);
  for (const m of s.matchAll(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g)) found.add(`phone:${digits(m[0])}`);
  const noPhones = s.replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g, " ").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " ").replace(/\b24\/7(\/365)?\b/g, " ");
  for (const m of noPhones.matchAll(/\$\s?\d+(\.\d+)?|\b\d+(\.\d+)?%|\b\d{2,}(\.\d+)?\b/g)) found.add(m[0].replace(/\s/g, ""));
  return [...found];
}

const fetcher = new SiteFetcher();
const pages = new Map<string, Awaited<ReturnType<SiteFetcher["fetchPage"]>>>();
const summary: any = { checkedAt: new Date().toISOString(), method: "Each specific in a fact or inference statement is looked for in the text, title, description and technical details of the pages that run was served, re-read now; pages whose text changed since the run are listed.", models: {} };
for (const m of MODELS) {
  summary.models[m] = { statements: 0, specifics: 0, absent: [] as any[], changedPages: [] as string[] };
  const files = fs.readdirSync(path.join(ROOT, m)).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, m, f), "utf8"));
    if (!r.report || r.access === "restricted" || (only && !only.includes(r.company.id))) continue;
    const corpus: string[] = [];
    for (const s of r.sources.filter((x: any) => x.outcome === "ok")) {
      if (!pages.has(s.finalUrl)) pages.set(s.finalUrl, await fetcher.fetchPage(s.finalUrl, r.company.website));
      const p = pages.get(s.finalUrl)!;
      if (!p.inventory) { summary.models[m].changedPages.push(`${s.finalUrl} (now ${p.record.outcome})`); continue; }
      if (p.record.textSha256 !== s.textSha256) summary.models[m].changedPages.push(s.finalUrl);
      const inv = p.inventory;
      corpus.push(inv.title, inv.description, inv.text, ...inv.scriptSources, ...inv.frameSources, ...inv.otherHosts,
        ...inv.links.map((l) => `${l.url} ${l.text}`), ...inv.forms.map((x) => x.action), ...inv.phones, ...inv.emails);
    }
    const hay = flat(corpus.join("\n"));
    const hayDigits = digits(hay);
    const R = r.report;
    const claims = [...R.identity.claims, ...R.industry.claims, ...R.publicInformation.claims, ...R.licensing.claims,
      ...R.existingSoftware.map((x: any) => x.evidence), ...R.opportunityEvidence].filter((c: any) => c.label !== "hypothesis");
    for (const c of claims) {
      summary.models[m].statements++;
      for (const sp of specifics(c.statement)) {
        summary.models[m].specifics++;
        const ok = sp.startsWith("phone:") ? hayDigits.includes(sp.slice(6)) : hay.includes(sp) || hay.includes(sp.replace(/^\$/, "$ "));
        if (!ok) summary.models[m].absent.push({ id: r.company.id, label: c.label, specific: sp, statement: c.statement, quote: c.quote, sourceUrl: c.sourceUrl });
      }
    }
  }
  console.log(`${m}: ${summary.models[m].statements} statements, ${summary.models[m].specifics} specifics, ${summary.models[m].absent.length} not on any page that run read; changed pages ${summary.models[m].changedPages.length}`);
  for (const a of summary.models[m].absent) console.log(`   ${a.id} [${a.label}] "${a.specific}" in: ${a.statement.slice(0, 160)}`);
}
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
