import { z } from "zod";
import { anthropicKeyConfigured } from "../ai/claude";
import {
  founderAuthority,
  isFounder,
  ledgerEntries,
  reconciliationView,
  recordProviderFigure,
  releaseUnverified,
  spendingSummary,
  testMode,
  unblockProvider,
} from "../controls";
import type { DB } from "../db";
import type { Actor } from "../domain/actor";
import { INDUSTRY_LABELS } from "../playbooks";
import { PROVIDERS, SOURCE_KINDS, THINKING_LEVELS, type MissionScope } from "../missions/contract";
import { estimateMission } from "../missions/estimate";
import { geminiKeyConfigured, RESEARCH_MODELS, REVIEW_MODELS } from "../missions/providers";
import { listIntelligence, markIntelligenceReviewed, researchVersions } from "../missions/results";
import { missionExecutor } from "../missions/runner";
import {
  acceptWithIssues,
  addReview,
  approveMission,
  cancelMission,
  closeAsFailed,
  createMission,
  getMission,
  listMissions,
  MissionInput,
  rejectMission,
  resumeMission,
  reviewEstimate,
  startMission,
  submitMission,
  updateMission,
} from "../missions/service";
import { SIMULATED_MODEL } from "../missions/simulated";
import { addSource, decideSource, listSources } from "../sources/registry";
import { researchStages } from "./research-ops";

// AI Operations routes for the desktop app (Milestone 2B), all under /api/desktop/ai/ and all for operators only (the
// caller checks that). Every action here calls the mission service or the controls, which check the owner's
// authority themselves; nothing in this file decides who may approve or spend.

const RequestId = z.object({ requestId: z.string().regex(/^[0-9a-f-]{36}$/) });
const WithMission = RequestId.extend({ mission: z.unknown() });
const Approve = RequestId.extend({ fingerprint: z.string().regex(/^[0-9a-f]{16,128}$/), purpose: z.string().max(1000) });
const Note = RequestId.extend({ note: z.string().max(2000) });
const Reject = RequestId.extend({ reason: z.string().max(2000) });
const Review = RequestId.extend({ model: z.string().max(60), maxCostMicros: z.number().int().min(1).max(2_000_000) });
const SourceAdd = z.object({
  name: z.string().max(200),
  match: z.string().max(300),
  kind: z.enum(SOURCE_KINDS),
  industries: z.array(z.string().max(100)).max(20),
  purpose: z.string().max(500),
});
const SourceDecide = z.object({ status: z.enum(["approved", "rejected", "retired"]), note: z.string().max(1000) });
const Figure = z.object({
  provider: z.enum(PROVIDERS),
  periodKind: z.enum(["day", "month"]),
  period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  providerMicros: z.number().int().min(0).max(1_000_000_000),
  note: z.string().min(3).max(2000),
});
const Release = z.object({
  figureId: z.string().regex(/^[0-9a-f-]{36}$/),
  entries: z.array(z.object({ ledgerId: z.string().regex(/^[0-9a-f-]{36}$/), micros: z.number().int().min(1) })).min(1).max(200),
  note: z.string().min(3).max(2000),
});
const Unblock = z.object({ provider: z.enum(PROVIDERS), note: z.string().min(3).max(2000) });

/** What can never be approved in M2B, as the Approval Center lists it. */
export const NEVER_APPROVABLE = [
  "Contacting anyone: email, calls, forms, messages or outreach",
  "Sending email",
  "Purchases, subscriptions or new paid services",
  "Deployment, hosting or cloud resources",
  "Claude Work Order scoping",
];

export function capabilities(env: NodeJS.ProcessEnv = process.env) {
  const gemini = geminiKeyConfigured(env);
  const claude = anthropicKeyConfigured(env);
  return [
    { area: "Missions", name: "Company research (protocol v2.0)", state: "built", detail: "Runs as simulated missions today; the first real mission needs your Gate 2 authorization." },
    { area: "Missions", name: "Industry research (protocol v1.0)", state: "built", detail: "Reads approved sources only. Simulated today; real use after Gate 2." },
    { area: "Providers", name: "Gemini (research)", state: gemini ? "built" : "unavailable", detail: gemini ? "Built and tested with simulation only; first live use at Gate 2." : "No GEMINI_API_KEY is configured." },
    { area: "Providers", name: "Claude (review)", state: claude ? "built" : "unavailable", detail: claude ? "A key is configured; live review still needs its own authorization." : "Unavailable: no Anthropic key. The simulated reviewer works." },
    { area: "Providers", name: "Simulation", state: "working", detail: "$0 practice missions: labeled simulated, never counted toward budgets, never saved as research." },
    { area: "Controls", name: "Owner approvals, spending caps and the usage ledger", state: "working", detail: "$2 per mission, $5 per day, $20 per month (America/Boise), enforced before every request." },
    { area: "Controls", name: "Manual reconciliation", state: "working", detail: "Compare KELQOR's ledger with the provider's console figure; release or adjust unverified amounts." },
    { area: "Sources", name: "Approved source lists and proposals", state: "working", detail: "Nothing is read until you approve it." },
    { area: "Off", name: "Claude Work Order scoping", state: "off", detail: "Templates draft every scope; controlled scoping is on the roadmap." },
    { area: "Planned", name: "M2C: controlled discovery of new companies and sources", state: "planned", detail: "Each mechanism needs its own approval and a bounded cost." },
    { area: "Planned", name: "M3: Claude Code and Antigravity engineering coordination", state: "planned", detail: "Unchanged; M2B adds no coding or command execution." },
    { area: "Planned", name: "M4: managed customer AI and the Customer Command Center", state: "planned", detail: "Unchanged." },
    { area: "Planned", name: "M5: cloud, on-premises and hybrid operation", state: "planned", detail: "Unchanged; M2B runs on this PC only." },
  ];
}

export function missionOptions(db: DB, env: NodeJS.ProcessEnv = process.env) {
  return {
    testMode: testMode(db, env),
    industries: INDUSTRY_LABELS,
    researchModels: RESEARCH_MODELS.map((m) => ({ ...m, available: geminiKeyConfigured(env) })),
    reviewModels: REVIEW_MODELS.map((m) => ({ ...m, available: anthropicKeyConfigured(env) })),
    simulatedModel: SIMULATED_MODEL,
    thinkingLevels: THINKING_LEVELS,
  };
}

function scopeForEstimate(input: z.infer<typeof MissionInput>): MissionScope {
  return {
    type: input.type,
    subject: input.subject as MissionScope["subject"],
    protocol: "",
    provider: input.simulated ? "simulation" : "google",
    model: input.simulated ? SIMULATED_MODEL : input.model,
    thinkingLevel: input.thinkingLevel,
    maxOutputTokens: 20_000,
    maxCostMicros: input.maxCostMicros,
    review: input.review,
    simulated: input.simulated,
  };
}

export async function spendingView(db: DB) {
  const stages = researchStages();
  return {
    summary: await spendingSummary(db),
    ledger: await ledgerEntries(db, { limit: 300 }),
    historical: {
      totalUsd: stages.reduce((n, s) => n + s.spentUsd, 0),
      stages: stages.map((s) => ({ stage: s.stage, spentUsd: s.spentUsd, requests: s.requests, capUsd: s.capUsd })),
      note: "The benchmark's own spending, read from its frozen ledgers. It never counts toward M2B's caps.",
    },
    keys: { gemini: geminiKeyConfigured(), anthropic: anthropicKeyConfigured() },
  };
}

export type Capability = ReturnType<typeof capabilities>[number];
export type MissionOptions = ReturnType<typeof missionOptions>;
export type SpendingView = Awaited<ReturnType<typeof spendingView>>;
export interface ApprovalCenter {
  founder: Awaited<ReturnType<typeof founderAuthority>>;
  isFounder: boolean;
  waiting: Awaited<ReturnType<typeof listMissions>>;
  spending: Awaited<ReturnType<typeof spendingSummary>>;
  neverApprovable: string[];
}

type Body = <T>(schema: z.ZodType<T>) => Promise<T>;

/** Answers an AI Operations route, or returns undefined when the path isn't one. */
export async function aiRoute(db: DB, actor: Actor, method: string, p: string[], body: Body): Promise<unknown | undefined> {
  const at = (m: string, ...parts: (string | RegExp)[]) =>
    method === m && p.length === parts.length && parts.every((part, i) => (typeof part === "string" ? part === p[i] : part.test(p[i])));
  const ID = /^[0-9a-f-]{36}$/;
  const executor = missionExecutor();

  if (at("GET", "ai", "missions")) return listMissions(db, actor, executor);
  if (at("POST", "ai", "missions")) {
    const b = await body(WithMission);
    return createMission(db, actor, b.mission, b.requestId);
  }
  if (at("GET", "ai", "missions", ID)) return getMission(db, actor, p[2], executor);
  if (at("PUT", "ai", "missions", ID)) {
    const b = await body(WithMission);
    return updateMission(db, actor, p[2], b.mission, b.requestId);
  }
  if (p[0] === "ai" && p[1] === "missions" && ID.test(p[2] ?? "") && p.length === 4 && method === "POST") {
    const id = p[2];
    switch (p[3]) {
      case "submit":
        return submitMission(db, actor, id, (await body(RequestId)).requestId);
      case "approve":
        return approveMission(db, actor, id, await body(Approve));
      case "reject":
        return rejectMission(db, actor, id, await body(Reject));
      case "start":
        return startMission(db, actor, id, (await body(RequestId)).requestId, executor);
      case "resume":
        return resumeMission(db, actor, id, (await body(RequestId)).requestId, executor);
      case "cancel":
        return cancelMission(db, actor, id, (await body(RequestId)).requestId, executor);
      case "review":
        return addReview(db, actor, id, await body(Review));
      case "accept":
        return acceptWithIssues(db, actor, id, await body(Note));
      case "close":
        return closeAsFailed(db, actor, id, await body(Note));
      default:
        return undefined;
    }
  }
  if (at("GET", "ai", "options")) return missionOptions(db);
  if (at("GET", "ai", "missions", ID, "review-estimate", /^[a-z0-9.-]{3,60}$/)) return reviewEstimate(db, actor, p[2], p[4]);
  if (at("POST", "ai", "estimate")) return estimateMission(scopeForEstimate(MissionInput.parse((await body(z.object({ mission: z.unknown() }))).mission)));
  if (at("GET", "ai", "approvals")) {
    const missions = await listMissions(db, actor, executor);
    const center: ApprovalCenter = {
      founder: await founderAuthority(db),
      isFounder: await isFounder(db, actor.id),
      waiting: missions.filter((m) => m.status === "awaiting_approval" || ((m.status === "interrupted" || m.status === "budget_blocked") && m.allowed.approve)),
      spending: await spendingSummary(db),
      neverApprovable: NEVER_APPROVABLE,
    };
    return center;
  }
  if (at("GET", "ai", "spending")) return spendingView(db);
  if (at("GET", "ai", "reconciliation", /^[a-z]+$/, /^(day|month)$/, /^\d{4}-\d{2}(-\d{2})?$/)) {
    const provider = z.enum(PROVIDERS).parse(p[2]);
    return reconciliationView(db, { provider, periodKind: p[3] as "day" | "month", period: p[4] });
  }
  if (at("POST", "ai", "reconciliation", "figure")) return recordProviderFigure(db, actor, await body(Figure));
  if (at("POST", "ai", "reconciliation", "release")) return releaseUnverified(db, actor, await body(Release));
  if (at("POST", "ai", "reconciliation", "unblock")) return unblockProvider(db, actor, await body(Unblock));
  if (at("GET", "ai", "sources")) return listSources(db);
  if (at("POST", "ai", "sources")) return addSource(db, actor, await body(SourceAdd));
  if (at("PUT", "ai", "sources", /^[a-z0-9-]{2,60}$/)) return decideSource(db, actor, { key: p[2], ...(await body(SourceDecide)) });
  if (at("GET", "ai", "intelligence")) return listIntelligence(db);
  if (at("POST", "ai", "intelligence", ID, "review")) return markIntelligenceReviewed(db, actor, p[2]);
  if (at("GET", "ai", "research")) return researchVersions(db);
  if (at("GET", "ai", "capabilities")) return capabilities();
  if (at("GET", "ai", "running")) return { running: executor.runningCount() };
  return undefined;
}
