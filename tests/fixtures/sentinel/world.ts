import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { ModelReply, ModelRequest, TokenUsage } from "@/lib/ai/types";
import { boiseDay, boiseMonth, designateFounder, grantApproval, redeemTicket, scopeFingerprint } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { aiUsageLedger, missionApprovals, missions, missionSteps } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { createUserWithRole } from "@/lib/domain/accounts";
import {
  MISSION_OUTPUT_LIMIT,
  PROTOCOLS,
  type MissionProvider,
  type MissionScope,
  type MissionStatus,
  type ProviderId,
  type ProviderKind,
  type ReviewChoice,
  type ThinkingLevel,
} from "@/lib/missions/contract";
import { actorFor, freshDb, seedParties, TEST_PASSWORD } from "../../helpers";

// The security reviewer's test world: an in-memory database with a designated owner, a second operator, a demo operator, a
// client and a builder; missions inserted with their real fingerprints; and providers that never open a connection
// but redeem their tickets exactly as the real adapters do. Costs and clocks are synthetic.

export async function world() {
  const handle = await freshDb();
  const db = handle.db;
  const { operator, client, builder } = await seedParties(db);
  await designateFounder(db, { email: operator.email!, password: TEST_PASSWORD });
  const other = await actorFor(db, await createUserWithRole(db, { name: "Otto Operator", email: "otto@test.local", password: TEST_PASSWORD, role: "operator" }));
  const demo = await actorFor(db, await createUserWithRole(db, { name: "Morgan (demo)", email: "morgan@demo.local", password: TEST_PASSWORD, role: "operator" }, { isDemo: true }));
  return { handle, db, founder: operator, other, demo, client, builder };
}

export type World = Awaited<ReturnType<typeof world>>;

export function scope(over: Partial<MissionScope> = {}): MissionScope {
  return {
    type: "company_research",
    subject: { kind: "company", recordId: null, name: "Boise Fab Works", website: "https://www.boise-fab.test", town: "Boise", state: "ID", industry: null },
    protocol: PROTOCOLS.company_research,
    provider: "google",
    model: "gemini-4-argon",
    thinkingLevel: "medium",
    maxOutputTokens: MISSION_OUTPUT_LIMIT,
    maxCostMicros: 1_000_000,
    review: null,
    simulated: false,
    ...over,
  };
}

export const simulatedScope = (over: Partial<MissionScope> = {}) =>
  scope({ provider: "simulation", model: "simulated", simulated: true, maxCostMicros: 1, ...over });

export async function insertMission(db: DB, createdBy: Actor, s: MissionScope, status: MissionStatus = "awaiting_approval"): Promise<string> {
  const id = randomUUID();
  await db.insert(missions).values({
    id,
    type: s.type,
    status,
    simulated: s.simulated,
    subject: s.subject,
    title: "Test mission",
    protocol: s.protocol,
    provider: s.provider,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    maxOutputTokens: s.maxOutputTokens,
    maxCostMicros: s.maxCostMicros,
    review: s.review,
    scopeFingerprint: scopeFingerprint(s),
    createdById: createdBy.id!,
  });
  return id;
}

export async function fingerprintOf(db: DB, missionId: string): Promise<string> {
  const [m] = await db.select({ f: missions.scopeFingerprint }).from(missions).where(eq(missions.id, missionId));
  return m.f;
}

export async function approve(db: DB, founder: Actor, missionId: string, now?: Date) {
  return grantApproval(db, founder, { missionId, kind: "mission", seenFingerprint: await fingerprintOf(db, missionId), requestId: randomUUID(), now });
}

export async function approveReview(db: DB, founder: Actor, missionId: string, review: ReviewChoice, now?: Date) {
  return grantApproval(db, founder, { missionId, kind: "review", seenFingerprint: await fingerprintOf(db, missionId), review, requestId: randomUUID(), now });
}

/** Moves a mission into a sending state under a new run, as the mission service does. */
export async function startRun(db: DB, missionId: string, status: "running" | "verification" = "running"): Promise<string> {
  const runId = randomUUID();
  await db.update(missions).set({ status, runId }).where(eq(missions.id, missionId));
  return runId;
}

export async function step(db: DB, missionId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(missionSteps).values({ id, missionId, kind: "model_request", summary: "test request" });
  return id;
}

/** A complete mission, approved at `at` and running: what a paid request needs. */
export async function runningMission(w: World, s: MissionScope = scope(), at?: Date) {
  const missionId = await insertMission(w.db, w.founder, s);
  const approval = await approve(w.db, w.founder, missionId, at);
  const runId = await startRun(w.db, missionId);
  return { missionId, runId, approval };
}

export function ctxFor(m: { missionId: string; runId: string }, stepId: string, at?: Date | (() => Date), over: { attempt?: number; purpose?: "research" | "repair" | "retry" | "review" } = {}) {
  const now = at === undefined ? undefined : typeof at === "function" ? at : () => at;
  return { missionId: m.missionId, runId: m.runId, stepId, attempt: over.attempt ?? 1, purpose: over.purpose ?? "research", now } as const;
}

export function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return { system: "You are a test.", turns: [{ kind: "user", text: "Research the test company." }], tools: [], toolChoice: "none", maxOutputTokens: MISSION_OUTPUT_LIMIT, ...over };
}

export function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  const u: TokenUsage = { input: 10_000, cachedInput: 0, output: 1_000, thinking: 500, toolUse: 0, total: 0, ...over };
  if (over.total === undefined) u.total = u.input + u.output + u.thinking + u.toolUse;
  return u;
}

export function reply(over: Partial<ModelReply> = {}): ModelReply {
  return { status: "completed", text: "{}", toolCalls: [], modelSteps: [], usage: usage(), model: "gemini-4-argon", id: "resp-1", usageReported: true, ...over };
}

export interface FakeProvider extends MissionProvider {
  counts: number;
  sends: number;
  sent: ModelRequest[];
}

/**
 * A provider that never opens a connection. It redeems its tickets like the real adapters (unless told not to) and
 * answers from `answer`. Its identity fields can be changed to make it lie.
 */
export function fakeProvider(o: {
  provider?: ProviderId;
  model?: string;
  kind?: ProviderKind;
  thinkingLevel?: ThinkingLevel | null;
  counted?: number | ((n: number) => number);
  uncounted?: number;
  countError?: (n: number) => Error | null;
  answer?: (req: ModelRequest, n: number, signal: AbortSignal) => Promise<ModelReply> | ModelReply;
  redeem?: boolean;
} = {}): FakeProvider {
  const p: FakeProvider = {
    provider: o.provider ?? "google",
    model: o.model ?? "gemini-4-argon",
    kind: o.kind ?? "real",
    thinkingLevel: o.thinkingLevel === undefined ? "medium" : o.thinkingLevel,
    counts: 0,
    sends: 0,
    sent: [],
    async countInputTokens(req, ticket) {
      if (o.redeem !== false) redeemTicket(ticket, { use: "count", provider: p.provider, model: p.model, kind: p.kind, request: req });
      p.counts++;
      const err = o.countError?.(p.counts);
      if (err) throw err;
      return { counted: typeof o.counted === "function" ? o.counted(p.counts) : (o.counted ?? 10_000), uncounted: o.uncounted ?? 0 };
    },
    async respond(req, ticket, signal) {
      if (o.redeem !== false) redeemTicket(ticket, { use: "send", provider: p.provider, model: p.model, kind: p.kind, request: req });
      p.sends++;
      p.sent.push(req);
      return o.answer ? o.answer(req, p.sends, signal) : reply();
    },
  };
  return p;
}

/** Past spending on a mission, settled at `micros` on `at`: synthetic history for cap tests. */
export async function spend(db: DB, o: { missionId: string; micros: number; at: Date; purpose?: "research" | "review"; status?: "settled" | "unverified" | "reserved"; provider?: ProviderId }) {
  const [a] = await db.select().from(missionApprovals).where(eq(missionApprovals.missionId, o.missionId)).orderBy(desc(missionApprovals.approvedAt)).limit(1);
  const stepId = await step(db, o.missionId);
  const status = o.status ?? "settled";
  const id = randomUUID();
  await db.insert(aiUsageLedger).values({
    id,
    missionId: o.missionId,
    approvalId: a.id,
    stepId,
    attempt: 1,
    purpose: o.purpose ?? "research",
    provider: o.provider ?? "google",
    model: "gemini-4-argon",
    priceVersion: "test-history",
    prices: { input: 2, cachedInput: 0.1, output: 10 },
    sentAt: o.at,
    boiseDay: boiseDay(o.at),
    boiseMonth: boiseMonth(o.at),
    countedInputTokens: 0,
    reservedInputTokens: 0,
    maxOutputTokens: MISSION_OUTPUT_LIMIT,
    reservedMicros: o.micros,
    status,
    actualMicros: status === "settled" ? o.micros : null,
    usage: status === "settled" ? usage() : null,
    errorKind: status === "unverified" ? "interrupted" : null,
    settledAt: status === "reserved" ? null : o.at,
    backendInstance: "test-history",
  });
  return id;
}

export const signal = () => new AbortController().signal;

/** Boise wall-clock time to an instant, in standard time (UTC-7) or daylight time (UTC-6). */
export const mst = (local: string) => new Date(`${local}-07:00`);
export const mdt = (local: string) => new Date(`${local}-06:00`);
