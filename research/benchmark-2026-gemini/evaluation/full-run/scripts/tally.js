// Tallies the full-run records and ledger for the benchmark report. Reads only; run from the repository root.
const fs = require("fs");
const path = require("path");
const ROOT = "research/benchmark-2026-gemini/full-run";
const MODELS = ["gemini-4-argon", "gemini-3.8-flash"];
const short = { "gemini-4-argon": "Argon", "gemini-3.8-flash": "Flash" };
const inputs = JSON.parse(fs.readFileSync("research/benchmark-2026-gemini/inputs/benchmark-25.json", "utf8")).companies;
const name = Object.fromEntries(inputs.map((c) => [c.id, c.name]));
const load = (m, sub, id) => {
  const f = path.join(ROOT, m, sub, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const recs = {}; // recs[model][run][id]
for (const m of MODELS) {
  recs[m] = {};
  for (const sub of ["", "repeat-2", "repeat-3"]) {
    recs[m][sub || "main"] = {};
    for (const c of inputs) {
      const r = load(m, sub, c.id);
      if (r) recs[m][sub || "main"][c.id] = r;
    }
  }
}

// A. Per-model totals over the main run.
const sumKeys = ["facts", "quotesFound", "quotesFoundInDetails", "quotesOnAnotherPage", "quotesNotFound", "sourcesNotRead", "factsWithoutQuote", "inferences", "hypotheses", "channelsFound", "channelsOnAnotherPage", "channelsNotFound", "flags"];
console.log("== A. Main run totals per model");
for (const m of MODELS) {
  const rs = Object.values(recs[m].main);
  const t = Object.fromEntries(sumKeys.map((k) => [k, 0]));
  const status = {};
  let cost = 0, turns = 0, pages = 0;
  for (const r of rs) {
    status[r.status] = (status[r.status] ?? 0) + 1;
    cost += r.costUsd; turns += r.turns; pages += r.sources.filter((s) => s.outcome === "ok").length;
    if (r.checks) for (const k of sumKeys) t[k] += r.checks.summary[k] ?? 0;
  }
  console.log(short[m], `records ${rs.length}`, JSON.stringify(status), `cost $${cost.toFixed(4)} turns ${turns} pagesRead ${pages}`);
  console.log("   ", JSON.stringify(t));
}

// B. Per-company comparison.
console.log("\n== B. Per company (main run)");
console.log("id   access     | Argon category        $      q/f   flags | Flash category        $      q/f   flags | name");
for (const c of inputs) {
  const a = recs[MODELS[0]].main[c.id], f = recs[MODELS[1]].main[c.id];
  const cell = (r) => r ? `${(r.report?.qualification.category ?? r.status).padEnd(21)} ${r.costUsd.toFixed(4)} ${String(r.checks?.summary.quotesFound ?? "-").padStart(2)}/${String(r.checks?.summary.facts ?? "-").padEnd(2)} ${String(r.checks?.summary.flags ?? "-").padStart(3)}` : "(none)".padEnd(44);
  console.log(`${c.id}  ${(a?.access ?? f?.access ?? "?").padEnd(10)} | ${cell(a)}   | ${cell(f)}   | ${c.name}`);
}

// C. Flags by rule.
console.log("\n== C. Rule flags (main run)");
for (const m of MODELS) {
  const byRule = {};
  for (const r of Object.values(recs[m].main)) for (const fl of r.checks?.flags ?? []) (byRule[fl.rule] ??= []).push(`${r.company.id}: ${fl.detail.slice(0, 90)}`);
  console.log(short[m], Object.keys(byRule).length ? "" : "none");
  for (const [rule, items] of Object.entries(byRule)) { console.log(`  ${rule} (${items.length})`); for (const i of items) console.log(`     ${i}`); }
}

// D. Unresolved quotes (main run).
console.log("\n== D. Quotes not found on the cited page (main run)");
for (const m of MODELS) for (const r of Object.values(recs[m].main)) for (const q of r.checks?.quotes ?? []) {
  if (q.verdict !== "found" && q.verdict !== "found in page details") console.log(`${short[m]} ${r.company.id} ${q.verdict}${q.foundOn ? " -> " + q.foundOn : ""} | ${q.sourceUrl} | ${(q.quote ?? "").slice(0, 100)}`);
}

// E. Categories, solutions, outreach and values.
console.log("\n== E. Categories and recommendations (main run)");
for (const m of MODELS) {
  const cats = {}, offers = {};
  let custom = 0, outreach = 0, values = 0;
  for (const r of Object.values(recs[m].main)) {
    if (!r.report) continue;
    cats[r.report.qualification.category] = (cats[r.report.qualification.category] ?? 0) + 1;
    for (const s of r.report.forgexSolutions) { if (s.kind === "custom") custom++; offers[s.name] = (offers[s.name] ?? 0) + 1; }
    if (r.report.discovery.outreachBody.trim()) outreach++;
    if (r.report.commercial.value?.trim()) values++;
  }
  console.log(short[m], JSON.stringify(cats), `outreach drafts ${outreach}, values ${values}, custom solutions ${custom}`);
  console.log("   offers:", JSON.stringify(offers));
}
console.log("\nAgreement on category:");
let agree = 0, both = 0;
for (const c of inputs) {
  const a = recs[MODELS[0]].main[c.id]?.report?.qualification.category, f = recs[MODELS[1]].main[c.id]?.report?.qualification.category;
  if (a && f) { both++; if (a === f) agree++; else console.log(`  ${c.id} ${name[c.id]}: Argon "${a}", Flash "${f}"`); }
}
console.log(`  ${agree} of ${both} agree`);

// F. Ledger costs.
console.log("\n== F. Ledger (all runs)");
const ledger = fs.readFileSync(path.join(ROOT, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const P = { "gemini-4-argon": { in: 4, c: 0.2, out: 20 }, "gemini-3.8-flash": { in: 1.5, c: 0.15, out: 7.5 } };
const agg = {};
for (const l of ledger) {
  const p = P[l.model], u = l.usage;
  const post = ((u.input - u.cachedInput) * p.in + u.cachedInput * p.c + u.toolUse * p.in + (u.output + u.thinking) * p.out) / 1e6;
  for (const k of [l.model, "ALL"]) {
    const a = (agg[k] ??= { req: 0, usd: 0, post: 0, input: 0, cached: 0, output: 0, thinking: 0 });
    a.req++; a.usd += l.costUsd; a.post += post; a.input += u.input; a.cached += u.cachedInput; a.output += u.output; a.thinking += u.thinking;
  }
}
for (const [k, a] of Object.entries(agg)) console.log(`${(short[k] ?? k).padEnd(6)} requests ${a.req}  $${a.usd.toFixed(4)}  after promotions $${a.post.toFixed(4)}  input ${a.input} (cached ${a.cached})  output ${a.output}  thinking ${a.thinking}`);
console.log(`stage total from ledger: $${ledger.at(-1)?.stageTotalUsd.toFixed(4)}`);

// G. Consistency over the repeats.
console.log("\n== G. Consistency, c01-c05");
for (const m of MODELS) for (const c of inputs.slice(0, 5)) {
  const runs = ["main", "repeat-2", "repeat-3"].map((k) => recs[m][k][c.id]).filter(Boolean);
  if (runs.length < 2) continue;
  const cats = runs.map((r) => r.report?.qualification.category ?? r.status);
  const facts = runs.map((r) => r.checks?.summary.facts ?? 0);
  const sols = runs.map((r) => (r.report?.forgexSolutions ?? []).map((s) => s.name).sort().join("+") || "none");
  const cost = runs.map((r) => r.costUsd.toFixed(3));
  console.log(`${short[m]} ${c.id} categories ${JSON.stringify(cats)} facts ${JSON.stringify(facts)} solutions ${JSON.stringify(sols)} cost ${JSON.stringify(cost)}`);
}
