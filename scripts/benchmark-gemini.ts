// The Gemini research benchmark.
//   npm run benchmark -- check-key                          free: which models the ForgeX key can call
//   npm run benchmark -- preflight --inputs <file>          free: robots.txt, homepage and site-terms check
//   npm run benchmark -- run --stage <name> --models <a,b>  paid, within the stage's authorized cap
//        [--companies c01,c02] [--repeat 2]                  a subset, or a consistency repeat in its own folder
//   npm run benchmark -- run --stage <name> --simulate      free: the whole pipeline with an offline model
//   npm run benchmark -- recheck --stage <name>             free: re-run the checks on saved records, re-fetching pages
// A paid stage runs only if research/benchmark-2026-gemini/authorizations.json records the owner's approval
// for it. Companies that access-decisions.json includes are researched from their websites; excluded ones with a
// "restricted" entry get a restricted run (identity only, no page tool); any others are skipped.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { geminiModel, listGeminiModels, redactKey } from "../src/lib/ai/gemini";
import { pricedModels } from "../src/lib/ai/pricing";
import type { ResearchModel } from "../src/lib/ai/types";
import { addServed, checkReport, researchCompany, type CompanyRunRecord, type RestrictedAccess, type ServedPages } from "../src/lib/research/agent";
import { BudgetGuard, BudgetStop } from "../src/lib/research/budget";
import { SiteFetcher, antiAutomationExcerpts, termsLinks } from "../src/lib/research/fetcher";
import { reportJsonSchema } from "../src/lib/research/schema";
import { simulatedModel } from "../src/lib/research/simulated";
import { InputsFile, PROMPT_VERSION, READ_PAGE_TOOL, systemPrompt, type CompanyInput } from "../src/lib/research/spec";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local
}

const ROOT = path.resolve("research/benchmark-2026-gemini");
const INPUTS_DIR = path.join(ROOT, "inputs");
const BENCHMARK_MODELS = ["gemini-4-argon", "gemini-3.8-flash"];
const COMPANY_CAP_USD: Record<string, number> = { "gemini-4-argon": 2, "gemini-3.8-flash": 1, simulated: 0 };
const EXPECTED_COMPANY_USD: Record<string, number> = { "gemini-4-argon": 0.6, "gemini-3.8-flash": 0.2, simulated: 0 };

interface Authorization {
  stage: string;
  capUsd: number;
  inputs: string;
  models: string[];
  approvedBy: string;
  approvedOn: string;
  terms: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Inputs come only from the benchmark's inputs folder and may hold identity fields only. */
function readInputs(file: string): CompanyInput[] {
  const full = path.resolve(file);
  if (path.dirname(full) !== INPUTS_DIR) throw new Error(`Inputs must be a file in ${path.relative(process.cwd(), INPUTS_DIR)}.`);
  return InputsFile.parse(readJson(full)).companies;
}

function promptFingerprint() {
  return {
    promptVersion: PROMPT_VERSION,
    systemPromptSha256: sha256(systemPrompt()),
    toolSha256: sha256(JSON.stringify(READ_PAGE_TOOL)),
    schemaSha256: sha256(JSON.stringify(reportJsonSchema())),
  };
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function checkKey() {
  const models = await listGeminiModels();
  console.log(`The key works: ${models.length} models are available to its project (no generation was requested).`);
  for (const m of BENCHMARK_MODELS) console.log(`  ${m}: ${models.includes(m) ? "available" : "NOT available"}`);
}

async function preflight() {
  const inputs = arg("--inputs");
  if (!inputs) throw new Error("Usage: npm run benchmark -- preflight --inputs research/benchmark-2026-gemini/inputs/<file>.json");
  const companies = readInputs(inputs);
  const fetcher = new SiteFetcher();
  const rows = [];
  for (const c of companies) {
    const home = await fetcher.fetchPage(c.website, c.website);
    const robots = await fetcher.robotsFor(new URL(c.website).origin);
    const terms = [];
    if (home.inventory) {
      for (const url of termsLinks(home.inventory)) {
        const page = await fetcher.fetchPage(url, c.website);
        const text = fetcher.textOf(url);
        const landsOnHomepage = page.record.finalUrl === home.record.finalUrl;
        terms.push({
          url,
          finalUrl: page.record.finalUrl,
          outcome: landsOnHomepage ? "redirects to the homepage" : page.record.outcome,
          excerpts: text && !landsOnHomepage ? antiAutomationExcerpts(text) : [],
        });
      }
    }
    const row = {
      id: c.id,
      name: c.name,
      website: c.website,
      homepage: { outcome: home.record.outcome, status: home.record.status, detail: home.record.detail, finalUrl: home.record.finalUrl, retrievedAt: home.record.retrievedAt },
      robots: robots.kind,
      linksOnHomepage: home.inventory?.links.length ?? 0,
      termsPages: terms,
      needsReview: home.record.outcome !== "ok" || terms.some((t) => t.excerpts.length > 0),
    };
    rows.push(row);
    console.log(`${c.id}  ${home.record.outcome.padEnd(17)} robots:${robots.kind.padEnd(12)} terms:${terms.length} flagged:${terms.reduce((n, t) => n + t.excerpts.length, 0)}  ${c.name}`);
  }
  const out = path.join(ROOT, "preflight", path.basename(inputs));
  writeJson(out, { checkedAt: new Date().toISOString(), userAgent: "ForgeXResearch/0.1", companies: rows });
  console.log(`Saved ${path.relative(process.cwd(), out)}`);
}

async function run() {
  const stage = arg("--stage");
  const simulate = process.argv.includes("--simulate");
  if (!stage) throw new Error("Usage: npm run benchmark -- run --stage <name> --models gemini-4-argon,gemini-3.8-flash");

  const auths = readJson<{ stages: Authorization[] }>(path.join(ROOT, "authorizations.json")).stages;
  const auth = auths.find((a) => a.stage === stage);
  if (!auth) throw new Error(`Stage "${stage}" has no owner authorization in authorizations.json.`);
  const models = simulate ? ["simulated"] : (arg("--models") ?? auth.models.join(",")).split(",").map((m) => m.trim());
  for (const m of models) {
    if (!simulate && !auth.models.includes(m)) throw new Error(`${m} isn't authorized for stage "${stage}".`);
    if (!pricedModels().includes(m)) throw new Error(`${m} has no recorded price.`);
  }
  if (!simulate && !process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env.local.");

  const repeat = arg("--repeat");
  if (repeat !== undefined && !/^[2-9]$/.test(repeat)) throw new Error("--repeat takes a run number from 2 to 9.");
  const only = arg("--companies")?.split(",").map((s) => s.trim());
  const companies = readInputs(path.join(INPUTS_DIR, auth.inputs)).filter((c) => !only || only.includes(c.id));
  const decisions = readJson<{ companies: Record<string, { include: boolean; reason: string; restricted?: RestrictedAccess }> }>(path.join(ROOT, "access-decisions.json")).companies;
  const planned = companies.flatMap((c): { company: CompanyInput; restricted?: RestrictedAccess }[] => {
    const d = decisions[c.id];
    if (d?.include === true) return [{ company: c }];
    return d?.restricted ? [{ company: c, restricted: d.restricted }] : [];
  });
  const restrictedIds = planned.filter((p) => p.restricted).map((p) => p.company.id);
  const excluded = companies.filter((c) => !planned.some((p) => p.company.id === c.id)).map((c) => ({ id: c.id, reason: decisions[c.id]?.reason ?? "no access decision" }));

  const out = simulate ? path.resolve(".data/benchmark-simulation", stage) : path.join(ROOT, stage);
  const guard = new BudgetGuard({
    stage, capUsd: simulate ? 0 : auth.capUsd, companyCapUsd: COMPANY_CAP_USD,
    expectedCompanyUsd: EXPECTED_COMPANY_USD, ledgerPath: path.join(out, "ledger.jsonl"),
  });
  const fetcher = new SiteFetcher();
  const startedAt = new Date().toISOString();
  const results: { company: string; model: string; access: string; status: string; costUsd: number; turns: number; pages: number; facts: number; quotesFound: number; flags: number }[] = [];
  let stopReason: string | undefined;
  console.log(`Stage "${stage}"${simulate ? " (simulated, $0)" : ""}: ${planned.length} companies (${restrictedIds.length} restricted) x ${models.length} models; spent so far $${guard.stageSpentUsd.toFixed(4)} of $${auth.capUsd}.`);

  outer: for (const modelName of models) {
    const model: ResearchModel = simulate ? simulatedModel() : geminiModel(modelName);
    for (const { company, restricted } of planned) {
      const file = path.join(out, modelName, repeat ? `repeat-${repeat}` : "", `${company.id}.json`);
      if (fs.existsSync(file)) {
        console.log(`  ${modelName} ${company.id}: already done, skipped`);
        continue;
      }
      const { record, runStop } = await researchCompany({ company, model, fetcher, guard, restricted, redact: redactKey });
      writeJson(file, record);
      const s = record.checks?.summary;
      const pages = record.sources.filter((src) => src.outcome === "ok").length;
      results.push({ company: company.id, model: modelName, access: record.access ?? "full", status: record.status, costUsd: record.costUsd, turns: record.turns, pages, facts: s?.facts ?? 0, quotesFound: s?.quotesFound ?? 0, flags: s?.flags ?? 0 });
      console.log(`  ${modelName} ${company.id}${record.access === "restricted" ? " (restricted)" : ""}: ${record.status}  $${record.costUsd.toFixed(4)}  ${record.turns} turns  ${pages} pages  quotes ${s?.quotesFound ?? 0}/${s?.facts ?? 0}  flags ${s?.flags ?? 0}${record.stopReason ? `  (${record.stopReason})` : ""}`);
      try {
        guard.finishCompany();
      } catch (e) {
        if (e instanceof BudgetStop) stopReason = e.message;
        else throw e;
      }
      if (runStop) stopReason = runStop.message;
      if (stopReason) break outer;
    }
  }

  const summary = {
    stage, simulate, startedAt, finishedAt: new Date().toISOString(), gitCommit: gitCommit(),
    sdk: `@google/genai ${readJson<{ version: string }>(path.resolve("node_modules/@google/genai/package.json")).version}`,
    ...promptFingerprint(),
    inputsFile: auth.inputs, inputsSha256: sha256(fs.readFileSync(path.join(INPUTS_DIR, auth.inputs), "utf8")),
    authorization: simulate ? null : auth, models, repeat: repeat ?? null, companiesFilter: only ?? null, restricted: restrictedIds, excluded,
    stageSpentUsd: guard.stageSpentUsd, capUsd: auth.capUsd, stopReason: stopReason ?? null, results,
  };
  writeJson(path.join(out, "runs", `${startedAt.replace(/[:.]/g, "-")}.json`), summary);
  console.log(`Done. Stage spend $${guard.stageSpentUsd.toFixed(4)} of $${auth.capUsd}.${stopReason ? ` Stopped: ${stopReason}` : ""}`);
}

/**
 * Re-applies the current checks to a stage's saved records without calling any model. Each record's pages are
 * fetched again, and their fingerprints are compared with the ones recorded during the run, so a changed page
 * shows up. A restricted run's site is never fetched here. Results go to <stage>/rechecks/; the records
 * themselves are never changed.
 */
async function recheck() {
  const stage = arg("--stage");
  if (!stage) throw new Error("Usage: npm run benchmark -- recheck --stage <name>");
  const dir = path.join(ROOT, stage);
  const files = fs
    .readdirSync(dir)
    .filter((d) => pricedModels().includes(d))
    .flatMap((model) =>
      (fs.readdirSync(path.join(dir, model), { recursive: true }) as string[])
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(dir, model, f)),
    );
  const records = files.map((file) => ({ file, record: readJson<CompanyRunRecord>(file) }));
  const fingerprints = new Map<string, string>();
  for (const { record } of records) for (const s of record.sources) if (s.textSha256) fingerprints.set(s.finalUrl, s.textSha256);

  const fetcher = new SiteFetcher();
  const results = [];
  for (const { file, record } of records) {
    const name = `${record.model} ${record.company.id}`;
    if (!record.report) {
      results.push({ file: path.relative(ROOT, file), company: record.company.id, model: record.model, status: record.status });
      console.log(`${name}: ${record.status}, no report to check`);
      continue;
    }
    const restricted = record.access === "restricted";
    const served: ServedPages = new Map();
    if (!restricted) {
      for (const url of [record.company.website, ...record.pagesRequested.map((p) => p.url)]) {
        addServed(served, url, await fetcher.fetchPage(url, record.company.website));
      }
    }
    const checks = checkReport(record.report, served, { website: record.company.website, restricted });
    const pages = [...new Map([...served.values()].map((p) => [p.record.finalUrl, p])).values()].map((p) => ({
      url: p.record.finalUrl,
      outcome: p.record.outcome,
      sameAsDuringRun: fingerprints.has(p.record.finalUrl) ? fingerprints.get(p.record.finalUrl) === p.record.textSha256 : null,
    }));
    results.push({
      file: path.relative(ROOT, file),
      company: record.company.id,
      model: record.model,
      runTimeSummary: record.checks?.summary ?? null,
      summary: checks.summary,
      unresolvedQuotes: checks.quotes.filter((q) => q.verdict !== "found" && q.verdict !== "found in page details"),
      channels: checks.channels,
      flags: checks.flags,
      pages,
    });
    const s = checks.summary;
    const changed = pages.filter((p) => p.sameAsDuringRun === false).length;
    const unknown = pages.filter((p) => p.sameAsDuringRun === null).length;
    console.log(`${name}: quotes ${s.quotesFound}/${s.facts} (${s.quotesFoundInDetails} in page details), on another page ${s.quotesOnAnotherPage}, not found ${s.quotesNotFound}, source not read ${s.sourcesNotRead}; channels ${s.channelsFound}/${checks.channels.length}; flags ${s.flags}; pages ${pages.length}, changed ${changed}, no run fingerprint ${unknown}`);
    for (const f of checks.flags) console.log(`    flag: ${f.rule} (${f.where}): ${f.detail}`);
  }
  const out = path.join(dir, "rechecks", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeJson(out, {
    recheckedAt: new Date().toISOString(),
    stage,
    checker:
      "Protocol v1.3: quotes and contact channels are checked against each cited page's text and its technical details, then against the other pages that run was served; rule flags cover links no page shows, inferences without a source read, contacts who aren't owners or managers, careers addresses, outreach without a fit, values not shown as an illustrative calculation, and a category other than insufficient evidence after no site access.",
    records: results,
  });
  console.log(`Saved ${path.relative(process.cwd(), out)}`);
}

async function main() {
  const command = process.argv[2];
  if (command === "check-key") return checkKey();
  if (command === "preflight") return preflight();
  if (command === "run") return run();
  if (command === "recheck") return recheck();
  console.error("Commands: check-key | preflight --inputs <file> | run --stage <name> [--models a,b] [--simulate] | recheck --stage <name>");
  process.exit(1);
}

main().catch((err) => {
  console.error(redactKey(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
