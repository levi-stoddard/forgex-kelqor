import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiMissionProvider } from "@/lib/ai/gemini";
import type { ModelRequest } from "@/lib/ai/types";
import { grantApproval, meteredRequest, missionSpend, redeemTicket, spendingSummary } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { aiUsageLedger, missions } from "@/lib/db/schema";
import { fixtureTransport } from "@/lib/research/fixtures";
import { ProviderError, SpendRefused, type MissionProvider } from "@/lib/missions/contract";
import type { MissionInput } from "@/lib/missions/input";
import type { ProviderSet } from "@/lib/missions/providers";
import { MissionExecutor, recoverAtStartup } from "@/lib/missions/runner";
import { addReview, approveMission, createMission, getMission, resumeMission, startMission, submitMission, updateMission } from "@/lib/missions/service";
import { simulatedResearcher, simulatedReviewer } from "@/lib/missions/simulated";
import { approve, ctxFor, insertMission, request, runningMission, scope, startRun, step, world } from "./fixtures/sentinel/world";

// The security reviewer's independent verification of the mission system over the controls (docs/m2b/PLAN.md, Stages 2 and 3).
// A test named "DEFECT" reproduces an open defect reported to the implementation agent and is marked it.fails while it stands; once
// the fix lands the marker comes off and the test keeps the behavior fixed.

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("A test tried to open a network connection.");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SITES = path.join(process.cwd(), "tests", "fixtures", "sites");
const COMPANY = { kind: "company" as const, recordId: null, name: "Boise Fab & Weld", website: "https://www.boise-fab.test/", town: "Boise", state: "ID", industry: "Manufacturing" };
const rid = () => randomUUID();
const input = (patch: Partial<MissionInput> = {}): MissionInput => ({
  type: "company_research",
  simulated: true,
  purpose: "The security reviewer verification",
  subject: COMPANY,
  model: "gemini-4-argon",
  thinkingLevel: "medium",
  maxCostMicros: 1_000_000,
  review: null,
  ...patch,
});

/** A $0 simulated reviewer whose answer waits until the run is cancelled: a review request in flight. */
function hangingReviewer(sent: number[]): MissionProvider {
  const inner = simulatedReviewer(redeemTicket);
  return {
    ...inner,
    async respond(req, ticket, signal) {
      redeemTicket(ticket, { use: "send", provider: "simulation", model: "simulated", kind: "simulated", request: req });
      sent.push(sent.length + 1);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("Cancelled while the request was in flight.", "cancelled", "unknown")), { once: true }));
    },
  };
}

function executor(db: DB, reviewer: () => MissionProvider): MissionExecutor {
  const providers: ProviderSet = { research: (s) => simulatedResearcher(s.type, redeemTicket), reviewer };
  return new MissionExecutor(async () => ({ db, providers, transport: fixtureTransport(SITES), minIntervalMs: 0 }));
}

describe("review added later, interrupted by a restart, then resumed", () => {
  it("V1 (fixed in 31eb41f): the resumed review runs, instead of the mission sitting in Running with nothing running", async () => {
    const w = await world();
    // A simulated mission researched to the end, then put in Needs review (where review can be added later).
    const quick = executor(w.db, () => simulatedReviewer(redeemTicket));
    const d = await createMission(w.db, w.other, input(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    await startMission(w.db, w.founder, d.id, rid(), quick);
    await quick.idle(d.id);
    await w.db.update(missions).set({ status: "needs_review", finishedAt: null }).where(eq(missions.id, d.id));
    await addReview(w.db, w.founder, d.id, { model: "simulated", maxCostMicros: 100_000, requestId: rid() });
    // The review-only run starts, and the backend stops while its request is in flight.
    const sent: number[] = [];
    const first = executor(w.db, () => hangingReviewer(sent));
    await resumeMission(w.db, w.founder, d.id, rid(), first);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
    const instance = globalThis.__kelqorBackendInstance;
    globalThis.__kelqorBackendInstance = rid();
    try {
      expect(await recoverAtStartup(w.db)).toMatchObject({ interrupted: 1 });
    } finally {
      globalThis.__kelqorBackendInstance = instance;
    }
    first.cancel(d.id);
    await first.idle(d.id);
    expect((await getMission(w.db, w.founder, d.id)).status).toBe("interrupted");
    // The owner resumes it with a working reviewer.
    const second = executor(w.db, () => simulatedReviewer(redeemTicket));
    await resumeMission(w.db, w.founder, d.id, rid(), second);
    await second.idle(d.id);
    const after = await getMission(w.db, w.founder, d.id);
    const reviews = (await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, d.id))).filter((r) => r.purpose === "review");
    // The review was sent again, in Verification, settled at $0, and the mission ended.
    expect(["completed", "needs_review"]).toContain(after.status);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ status: "unverified", errorKind: "interrupted" }); // the one in flight at the restart
    expect(reviews[1]).toMatchObject({ status: "settled", simulated: true, committedMicros: 0 });
    expect(after.steps.some((s) => s.kind === "state" && /verification \(review\)/.test(s.summary))).toBe(true);
    expect((after.result as { review?: { finished?: boolean } } | null)?.review?.finished).toBe(true);
  });
});

describe("approvals and scope changes", () => {
  it("V4 (fixed in ead461b): editing an approved mission voids its approval and returns it to Awaiting approval (criterion 5)", async () => {
    // docs/m2b/AUTHORIZATION.md: "Any change to those after approval voids it, and the mission returns to Awaiting
    // approval." An edit to a draft or a submitted mission still returns it to Draft (the lifecycle table).
    const w = await world();
    const d = await createMission(w.db, w.other, input(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    const edited = await updateMission(w.db, w.other, d.id, input({ purpose: "Edited after approval", maxCostMicros: 900_000 }), rid());
    expect(edited.status).toBe("awaiting_approval");
    expect(edited.approvals.length).toBeGreaterThan(0);
    expect(edited.approvals.every((a) => a.state !== "active")).toBe(true);
    expect(edited.scopeFingerprint).not.toBe(d.scopeFingerprint);
    // The old fingerprint can't be approved; the new one can.
    await expect(approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() })).rejects.toMatchObject({ code: "conflict" });
    expect((await approveMission(w.db, w.founder, d.id, { fingerprint: edited.scopeFingerprint, requestId: rid() })).status).toBe("approved");
    // A submitted mission that is edited goes back to Draft.
    const other = await createMission(w.db, w.other, input(), rid());
    await submitMission(w.db, w.other, other.id, rid());
    expect((await updateMission(w.db, w.other, other.id, input({ purpose: "Edited while waiting" }), rid())).status).toBe("draft");
  });
});

describe("a review added later whose approval has lapsed", () => {
  it("V5 (fixed in ead461b): is never skipped silently: the mission doesn't complete without the review it was approved for", async () => {
    const w = await world();
    const ex = executor(w.db, () => simulatedReviewer(redeemTicket));
    const d = await createMission(w.db, w.other, input(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    // Review was added and approved on an earlier Boise day (say before an interruption); the mission's own approval
    // is today's. The runner looks only for an active review approval, finds none, and skips the review.
    const earlier = new Date(Date.now() - 26 * 3_600_000);
    await grantApproval(w.db, w.founder, { missionId: d.id, kind: "review", seenFingerprint: d.scopeFingerprint, review: { provider: "simulation", model: "simulated", maxCostMicros: 100_000 }, requestId: rid(), now: earlier });
    await startMission(w.db, w.founder, d.id, rid(), ex);
    await ex.idle(d.id);
    const after = await getMission(w.db, w.founder, d.id);
    const result = after.result as { review?: { finished?: boolean } | null; reviewReasons?: string[] } | null;
    expect(after.status).toBe("needs_review");
    expect((result?.reviewReasons ?? []).some((r) => /review approved for this mission lapsed/i.test(r))).toBe(true);
    expect(after.ledger.some((l) => l.purpose === "review")).toBe(false); // nothing was sent under the lapsed approval
  });
});

describe("customer records (criterion 27)", () => {
  it("are written only by the owner's own discovery actions, never by missions, controls, sources or providers", () => {
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const ai = ["missions", "controls", "sources", "ai", "research"].flatMap((d) => files(path.join(process.cwd(), "src", "lib", d)));
    const writes = /\.(insert|update|delete)\(\s*(discoveryFigures|opportunityProblems|discoveryCalls|opportunityDecisions|opportunityChecks|opportunityProfiles)\b/;
    const imports = /from "\.\.\/domain\/(discovery|opportunities)"/;
    const offenders = ai.filter((f) => writes.test(fs.readFileSync(f, "utf8")) || imports.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});

describe("a provider error during research", () => {
  it("never leaves a mission in a sending state once its run has ended", async () => {
    const w = await world();
    const failing: ProviderSet = {
      research: (s) => {
        const p = simulatedResearcher(s.type, redeemTicket);
        return {
          ...p,
          async respond(req, ticket) {
            redeemTicket(ticket, { use: "send", provider: "simulation", model: "simulated", kind: "simulated", request: req });
            throw new ProviderError("upstream 500", "server", "yes", 500);
          },
        };
      },
      reviewer: () => simulatedReviewer(redeemTicket),
    };
    const ex = new MissionExecutor(async () => ({ db: w.db, providers: failing, transport: fixtureTransport(SITES), minIntervalMs: 0 }));
    const d = await createMission(w.db, w.other, input(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    await startMission(w.db, w.founder, d.id, rid(), ex);
    await ex.idle(d.id);
    const after = await getMission(w.db, w.founder, d.id);
    expect(after.status).toBe("failed"); // three errors in a row
    const requests = after.ledger.filter((e) => e.purpose !== "count");
    expect(requests).toHaveLength(3);
    expect(requests.every((e) => e.status === "unverified" && e.simulated)).toBe(true);
  });
});

// M-0002, the first live Gemini mission, failed at the token count: @google/genai 2.28.0 refuses systemInstruction
// (and tools) in countTokens in Gemini Developer API mode. These tests use the real SDK with a dummy key, a closed
// local port and a stubbed fetch, so nothing can leave the machine.
describe("M-0002: Gemini's token count in Developer API mode", () => {
  const offlineClient = () => new GoogleGenAI({ apiKey: "sentinel-test-not-a-key", httpOptions: { baseUrl: "http://127.0.0.1:9" } });
  const readPage = { name: "read_page", description: "Reads one page.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };
  const m0002Request = (): ModelRequest => request({ system: "SENTINEL-SYSTEM-MARKER: the research protocol.", tools: [readPage], toolChoice: "auto" });

  /** Records every network call; a token count is refused by "Google" with a 400, anything else would be a send. */
  function stubNetwork() {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String((url as { url?: string })?.url ?? url);
      calls.push(u);
      if (u.includes(":countTokens")) {
        return new Response(JSON.stringify({ error: { code: 400, message: "Invalid argument (test).", status: "INVALID_ARGUMENT" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      throw new Error("A test tried to send a generation request.");
    });
    return calls;
  }

  it("the SDK refuses M-0002's count locally, before any network call: those count attempts never reached Google", async () => {
    const calls = stubNetwork();
    const ai = offlineClient();
    const contents = [{ role: "user", parts: [{ text: "Research the test company." }] }];
    const tools = [{ functionDeclarations: [{ name: "read_page", description: "Reads one page.", parametersJsonSchema: readPage.parameters }] }];
    await expect(ai.models.countTokens({ model: "gemini-4-argon", contents, config: { systemInstruction: "x", tools } })).rejects.toThrow(/systemInstruction parameter is only supported/);
    await expect(ai.models.countTokens({ model: "gemini-4-argon", contents, config: { tools } })).rejects.toThrow(/tools parameter is only supported/);
    expect(calls).toEqual([]);
    // The control: without them the SDK does send, so the stub would have seen the calls above.
    await expect(ai.models.countTokens({ model: "gemini-4-argon", contents })).rejects.toThrow();
    expect(calls).toEqual(["http://127.0.0.1:9/v1beta/models/gemini-4-argon:countTokens"]);
  });

  it("a failed count sends no generation request, reserves nothing and commits $0", async () => {
    const calls = stubNetwork();
    const w = await world();
    const m = await runningMission(w, scope());
    const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: offlineClient });
    const e = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), gemini, m0002Request(), new AbortController().signal).catch((x) => x);
    expect(e).toBeInstanceOf(SpendRefused);
    // A 400 from the counter is deterministic: refused, not retried (9bff555).
    expect((e as SpendRefused).reason).toBe("count_rejected");
    expect(calls.filter((u) => !u.includes(":countTokens"))).toEqual([]);
    const rows = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.missionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "count", reservedMicros: 0, committedMicros: 0, actualMicros: null });
    expect(rows[0].status).not.toBe("reserved");
    expect((await missionSpend(w.db, m.missionId)).committedMicros).toBe(0);
    expect((await spendingSummary(w.db)).day.committedMicros).toBe(0);
  });

  /** A fake key for these tests only, shaped unlike any real credential. */
  const FAKE_KEY = "sentinel-fake-gemini-key-0123456789";
  async function withFakeKey<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = FAKE_KEY;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  }
  /** Google's counter as a stub: records each call and answers with `answer`; any other request is refused. */
  function stubCounter(answer: () => Response | Promise<Response>) {
    const seen: { url: string; headers: Record<string, string>; body: { generateContentRequest: Record<string, unknown> } }[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (!u.endsWith(":countTokens")) throw new Error("A test tried to send a generation request.");
      seen.push({ url: u, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
      return answer();
    });
    return seen;
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const noSends = () => ({ interactions: { create: async () => Promise.reject(new Error("must not send")) } }) as never;

  it("Google's counter gets the whole input, the key travels only in a header, and the reservation keeps its margin and output limit", async () => {
    await withFakeKey(async () => {
      const seen = stubCounter(() => json(200, { totalTokens: 12_345 }));
      const w = await world();
      const at = new Date("2026-11-10T18:00:00Z");
      const m = await runningMission(w, scope(), at);
      const sends: unknown[] = [];
      const client = {
        interactions: {
          create: async (body: unknown) => (
            sends.push(body),
            { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }], usage: { total_input_tokens: 12_000, total_output_tokens: 900, total_thought_tokens: 100, total_tokens: 13_000 } }
          ),
        },
      };
      const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never });
      const outputSchema = { type: "object", properties: { summary: { type: "string" } } };
      // An earlier thought step: resent to Google, and counted with its signature on the call it precedes (M-0003).
      const thought = { type: "thought", signature: "S".repeat(6_000), summary: [{ type: "text", text: "SENTINEL-THOUGHT" }] };
      const req = request({
        system: "SENTINEL-SYSTEM-MARKER: the research protocol.",
        tools: [readPage],
        toolChoice: "auto",
        outputSchema,
        turns: [
          { kind: "user", text: "SENTINEL-USER-MARKER" },
          { kind: "model", steps: [thought, { type: "function_call", id: "c1", name: "read_page", arguments: { url: "https://www.boise-fab.test/" } }] },
          { kind: "tool_results", results: [{ callId: "c1", name: "read_page", output: "SENTINEL-PAGE-MARKER" }] },
        ],
      } as Partial<ModelRequest>);
      const out = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), at), gemini, req, new AbortController().signal);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:countTokens");
      expect(seen[0].url).not.toContain(FAKE_KEY);
      expect(seen[0].headers["x-goog-api-key"]).toBe(FAKE_KEY);
      const g = seen[0].body.generateContentRequest;
      const text = JSON.stringify(g);
      expect(g.model).toBe("models/gemini-4-argon");
      expect(g.systemInstruction).toEqual({ parts: [{ text: "SENTINEL-SYSTEM-MARKER: the research protocol." }] });
      expect((g.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name)).toEqual(["read_page"]);
      for (const marker of ["SENTINEL-USER-MARKER", "SENTINEL-PAGE-MARKER", "SENTINEL-THOUGHT", '"functionCall"', '"functionResponse"']) expect(text).toContain(marker);
      const call = (g.contents as { parts: Record<string, unknown>[] }[]).flatMap((c) => c.parts).find((p) => p.functionCall);
      expect(call?.thoughtSignature).toBe(thought.signature);
      // Generation still sends the real system instruction.
      expect(JSON.stringify(sends[0])).toContain("SENTINEL-SYSTEM-MARKER");
      // The reservation: (counted + the output schema's estimate) * 1.15 rounded up, + 512; then the 20,000-token limit
      // once. The thought is in the count itself now, so it isn't estimated as well.
      const uncounted = Math.ceil(JSON.stringify(outputSchema).length / 3);
      expect(uncounted).toBeGreaterThan(0);
      const inputTokens = Math.ceil(((12_345 + uncounted) * 115) / 100) + 512;
      expect(out).toMatchObject({ countedInputTokens: 12_345, reservedInputTokens: inputTokens, reservedMicros: inputTokens * 2 + 20_000 * 10 });
      const rows = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.missionId));
      expect(rows.map((r) => [r.purpose, r.status, r.reservedMicros, r.maxOutputTokens])).toEqual(
        expect.arrayContaining([
          ["count", "settled", 0, 20_000],
          ["research", "settled", inputTokens * 2 + 20_000 * 10, 20_000],
        ]),
      );
      expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
    });
  });

  it("a refused count is not billed, keeps the key out of the ledger and fails at once; transient ones are still retried", async () => {
    await withFakeKey(async () => {
      const w = await world();
      const attempt = async (answer: () => Response | Promise<Response>) => {
        stubCounter(answer);
        const m = await runningMission(w, scope());
        const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: noSends });
        const e = (await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), gemini, m0002Request(), new AbortController().signal).catch((x) => x)) as SpendRefused;
        const [row] = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.missionId));
        return { reason: e.reason, status: row.status, kind: row.errorKind, detail: row.errorDetail ?? "", committed: row.committedMicros };
      };
      const r400 = await attempt(() => json(400, { error: { code: 400, message: `API key ${FAKE_KEY} echoed back`, status: "INVALID_ARGUMENT" } }));
      expect(r400).toMatchObject({ reason: "count_rejected", status: "not_billed", kind: "invalid_request", committed: 0 });
      expect(r400.detail).not.toContain(FAKE_KEY);
      expect(r400.detail).toMatch(/HTTP 400/);
      expect(await attempt(() => json(403, { error: { code: 403 } }))).toMatchObject({ reason: "count_rejected", status: "not_billed", kind: "auth", committed: 0 });
      expect(await attempt(() => json(404, { error: { code: 404 } }))).toMatchObject({ reason: "count_rejected", committed: 0 });
      expect(await attempt(() => json(413, { error: { code: 413 } }))).toMatchObject({ reason: "count_rejected", status: "not_billed", kind: "invalid_request", committed: 0 });
      // Transient: still retried, and still $0.
      expect(await attempt(() => json(429, { error: { code: 429 } }))).toMatchObject({ reason: "count_failed", committed: 0 });
      expect(await attempt(() => json(503, { error: { code: 503 } }))).toMatchObject({ reason: "count_failed", committed: 0 });
      expect(await attempt(() => Promise.reject(new TypeError("fetch failed")))).toMatchObject({ reason: "count_failed", committed: 0 });
      expect(await attempt(() => new Response("not json", { status: 200 }))).toMatchObject({ reason: "count_failed", committed: 0 });
      expect(await attempt(() => json(200, { totalTokens: 0 }))).toMatchObject({ reason: "count_failed", committed: 0 });
    });
    // No key: refused before any network call.
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const seen = stubCounter(() => json(200, { totalTokens: 1 }));
      const w = await world();
      const m = await runningMission(w, scope());
      const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: noSends });
      const e = (await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), gemini, m0002Request(), new AbortController().signal).catch((x) => x)) as SpendRefused;
      expect(e.reason).toBe("count_rejected");
      expect(seen).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it("a count still needs a live approval, room under the caps and a valid attempt before anything is sent", async () => {
    await withFakeKey(async () => {
      const seen = stubCounter(() => json(200, { totalTokens: 1_000 }));
      const w = await world();
      const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: noSends });
      const refusal = async (m: { missionId: string; runId: string }, attempt = 1) =>
        ((await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId), undefined, { attempt }), gemini, m0002Request(), new AbortController().signal).catch((x) => x)) as SpendRefused).reason;
      // Unapproved: not even a count.
      const unapproved = await insertMission(w.db, w.founder, scope());
      expect(await refusal({ missionId: unapproved, runId: await startRun(w.db, unapproved) })).toBe("no_approval");
      // Approved at $0.10: the 20,000-token output limit alone ($0.20 at Argon's price) doesn't fit, so nothing is counted.
      expect(await refusal(await runningMission(w, scope({ maxCostMicros: 100_000 })))).toBe("approval_cap");
      // A fourth attempt is refused outright.
      expect(await refusal(await runningMission(w, scope()), 4)).toBe("attempt_limit");
      expect(seen).toEqual([]);
    });
  });

  // Was a DEFECT (M-0002's three identical attempts), fixed in 9bff555.
  it("a count refused deterministically is not tried three times, and the mission fails without a paid request", async () => {
    const calls = stubNetwork();
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    await approve(w.db, w.founder, missionId);
    await w.db.update(missions).set({ status: "approved" }).where(eq(missions.id, missionId));
    const providers: ProviderSet = {
      research: () => geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: offlineClient }),
      reviewer: () => simulatedReviewer(redeemTicket),
    };
    const ex = new MissionExecutor(async () => ({ db: w.db, providers, transport: fixtureTransport(SITES), minIntervalMs: 0 }));
    ex.start(missionId, await startRun(w.db, missionId));
    await ex.idle(missionId);
    const [m] = await w.db.select().from(missions).where(eq(missions.id, missionId));
    expect(m.status).toBe("failed");
    expect(calls.filter((u) => !u.includes(":countTokens"))).toEqual([]);
    const rows = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, missionId));
    expect(rows.every((r) => r.purpose === "count" && r.committedMicros === 0)).toBe(true);
    expect(rows).toHaveLength(1);
  });
});
