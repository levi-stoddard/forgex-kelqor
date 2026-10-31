import fs from "node:fs";
import path from "node:path";
import { benchmarkRoot } from "../research/dossiers";
import type { ResearchStage } from "./types";

// Real research activity, read from the benchmark's own records: the owner's spending authorizations, the
// append-only cost ledgers and the run summaries. Nothing here calls a model or writes a file.

interface Authorization {
  stage: string;
  capUsd: number;
  approvedOn: string;
  models: string[];
}

interface LedgerLine {
  model: string;
  costUsd: number;
}

interface RunSummary {
  startedAt: string;
  finishedAt: string;
  promptVersion: string;
  repeat: number | null;
  results: unknown[];
  stopReason: string | null;
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

export function researchStages(root = benchmarkRoot()): ResearchStage[] {
  const file = path.join(root, "authorizations.json");
  if (!fs.existsSync(file)) return [];
  const { stages } = readJson<{ stages: Authorization[] }>(file);
  return stages.map((a) => {
    const ledgerFile = path.join(root, a.stage, "ledger.jsonl");
    const lines: LedgerLine[] = fs.existsSync(ledgerFile)
      ? fs
          .readFileSync(ledgerFile, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as LedgerLine)
      : [];
    const byModel = new Map<string, { model: string; requests: number; costUsd: number }>();
    for (const l of lines) {
      const m = byModel.get(l.model) ?? { model: l.model, requests: 0, costUsd: 0 };
      m.requests += 1;
      m.costUsd += l.costUsd;
      byModel.set(l.model, m);
    }
    const runsDir = path.join(root, a.stage, "runs");
    const runs = fs.existsSync(runsDir)
      ? fs
          .readdirSync(runsDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => readJson<RunSummary>(path.join(runsDir, f)))
          .map((r) => ({
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            promptVersion: r.promptVersion,
            repeat: r.repeat ?? 1,
            companies: r.results.length,
            stopReason: r.stopReason ?? null,
          }))
      : [];
    return {
      stage: a.stage,
      capUsd: a.capUsd,
      approvedOn: a.approvedOn,
      models: a.models,
      spentUsd: lines.reduce((sum, l) => sum + l.costUsd, 0),
      requests: lines.length,
      byModel: [...byModel.values()],
      runs,
    };
  });
}
