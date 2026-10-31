// Compares the three runs of c01-c05 on each model: categories, facts, quotes and pages in common, solutions, cost.
// Reads only; run from the repository root.
const fs = require("fs");
const path = require("path");
const ROOT = "research/benchmark-2026-gemini/full-run";
const norm = (s) => (s ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; const u = new Set([...A, ...B]).size; return u ? i / u : 1; };
const facts = (R) => [...R.identity.claims, ...R.industry.claims, ...R.publicInformation.claims, ...R.licensing.claims, ...R.existingSoftware.map((s) => s.evidence), ...R.opportunityEvidence].filter((c) => c.label === "fact");
for (const m of ["gemini-4-argon", "gemini-3.8-flash"]) {
  console.log(`== ${m}`);
  const pairs = { quotes: [], pages: [], software: [] };
  for (const id of ["c01", "c02", "c03", "c04", "c05"]) {
    const runs = ["", "repeat-2", "repeat-3"].map((sub) => JSON.parse(fs.readFileSync(path.join(ROOT, m, sub, `${id}.json`), "utf8")));
    const cats = runs.map((r) => r.report.qualification.category);
    const n = runs.map((r) => facts(r.report).length);
    const sols = runs.map((r) => r.report.forgexSolutions.map((s) => s.name).sort().join(" + ") || "none");
    const outreach = runs.map((r) => (r.report.discovery.outreachBody.trim() ? "draft" : "none"));
    const cost = runs.map((r) => r.costUsd.toFixed(3));
    const q = runs.map((r) => facts(r.report).map((c) => norm(c.quote)));
    const p = runs.map((r) => r.sources.filter((s) => s.outcome === "ok").map((s) => s.finalUrl.replace(/\/$/, "")));
    const sw = runs.map((r) => r.report.existingSoftware.map((s) => norm(s.product).split(" ")[0]));
    const pj = [], qj = [], sj = [];
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) { qj.push(jaccard(q[a], q[b])); pj.push(jaccard(p[a], p[b])); sj.push(jaccard(sw[a], sw[b])); }
    if (runs[0].access !== "restricted") { pairs.quotes.push(...qj); pairs.pages.push(...pj); pairs.software.push(...sj); }
    const avg = (x) => (x.reduce((s, v) => s + v, 0) / x.length).toFixed(2);
    console.log(`${id} ${runs[0].access.padEnd(10)} categories ${JSON.stringify(cats)} | facts ${JSON.stringify(n)} | solutions ${JSON.stringify(sols)} | outreach ${JSON.stringify(outreach)} | cost ${JSON.stringify(cost)} | same quotes ${avg(qj)} pages ${avg(pj)} software ${avg(sj)}`);
  }
  const avg = (x) => (x.reduce((s, v) => s + v, 0) / x.length).toFixed(2);
  console.log(`   mean pairwise overlap over the 4 full-access companies: quotes ${avg(pairs.quotes)}, pages ${avg(pairs.pages)}, software ${avg(pairs.software)}`);
}
