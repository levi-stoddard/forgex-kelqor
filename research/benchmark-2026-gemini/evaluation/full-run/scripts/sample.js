// Draws a seeded random sample of quoted facts per model from the full run, for a manual check of whether each
// statement says more than its quote. Reads only; run from the repository root. Usage: node sample.js [perModel] [seed]
const fs = require("fs");
const path = require("path");
const ROOT = "research/benchmark-2026-gemini/full-run";
const per = Number(process.argv[2] ?? 25);
let seed = Number(process.argv[3] ?? 20261027);
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (const m of ["gemini-4-argon", "gemini-3.8-flash"]) {
  const facts = [];
  for (const f of fs.readdirSync(path.join(ROOT, m)).filter((x) => x.endsWith(".json"))) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, m, f), "utf8"));
    if (!r.report) continue;
    const R = r.report;
    const claims = [
      ...R.identity.claims, ...R.industry.claims, ...R.publicInformation.claims, ...R.licensing.claims,
      ...R.existingSoftware.map((s) => s.evidence), ...R.opportunityEvidence,
    ];
    for (const c of claims) if (c.label === "fact") facts.push({ id: r.company.id, ...c });
  }
  const picked = [];
  const pool = [...facts];
  while (picked.length < per && pool.length) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  console.log(`== ${m}: ${picked.length} of ${facts.length} facts`);
  picked.forEach((c, i) => console.log(`${i + 1}. ${c.id} | ${c.statement}\n     QUOTE: "${c.quote}" (${(c.sourceUrl ?? "").replace(/^https?:\/\/(www\.)?/, "")})`));
}
