import fs from "node:fs";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designateFounder } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { MIGRATIONS_FOLDER } from "@/lib/db";
import { aiUsageLedger, missionSteps, missions, outbox, researchRecords } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { createUserWithRole } from "@/lib/domain/accounts";
import { opportunities, opportunity } from "@/lib/desktop/views";
import { handleDesktopRequest } from "@/lib/desktop/api";
import { geminiMissionProvider } from "@/lib/ai/gemini";
import { redeemTicket } from "@/lib/controls";
import { fixtureTransport } from "@/lib/research/fixtures";
import { MissionExecutor, recoverAtStartup } from "@/lib/missions/runner";
import type { MissionInput } from "@/lib/missions/input";
import { approveMission, cancelMission, createMission, getMission, startMission, submitMission, updateMission } from "@/lib/missions/service";
import { simulatedResearcher, simulatedReviewer } from "@/lib/missions/simulated";
import type { ProviderSet } from "@/lib/missions/providers";
import type { MissionProvider } from "@/lib/missions/contract";
import { actorFor, freshDb, TEST_PASSWORD } from "./helpers";

// Milestone 2B end to end, the implementation agent's integration tests: the mission service and runner over the security reviewer's controls, on an
// in-memory database, with local test pages and scripted providers. No provider is ever reached: the "real" path uses
// the Gemini mission adapter with a fake client.

const SITES = path.join(process.cwd(), "tests", "fixtures", "sites");
const COMPANY = { kind: "company" as const, recordId: null, name: "Boise Fab & Weld", website: "https://www.boise-fab.test/", town: "Boise", state: "ID", industry: "Manufacturing" };
const rid = () => crypto.randomUUID();

let db: DB;
let close: () => Promise<void>;
let founder: Actor;
let operator: Actor;

function input(patch: Partial<MissionInput> = {}): MissionInput {
  return { type: "company_research", simulated: true, purpose: "test", subject: COMPANY, model: "gemini-4-argon", thinkingLevel: "medium", maxCostMicros: 1_000_000, review: null, ...patch };
}

/** The scripted Gemini: reads the about page, then reports from the two pages it was served. */
function scriptedGemini(): MissionProvider {
  let turn = 0;
  const report = {
    identity: { name: "Boise Fab & Weld", location: "Boise, ID", claims: [{ statement: "Fabricates in Boise since 1998.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/", quote: "Custom metal fabrication and welding in Boise, Idaho since 1998.", basis: null }] },
    industry: { industry: "Manufacturing", activities: ["fabrication"], claims: [] },
    operationalProfile: { summary: "A small shop.", claims: [{ statement: "Twelve people.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/about", quote: "Our team of twelve builds structural steel", basis: null }] },
    software: [],
    processes: [{ statement: "Schedules on a whiteboard.", category: "verified_fact", sourceUrl: "https://www.boise-fab.test/about", quote: "We schedule shop work on a whiteboard", basis: null }],
    technicalIssues: [],
    hypotheses: [{ statement: "Quote requests may wait for the estimator.", category: "industry_hypothesis", sourceUrl: null, quote: null, basis: "Common in job shops" }],
    notVisible: ["Revenue"],
    possibleSolutions: [],
    discoveryQuestions: ["How do quote requests reach the estimator?"],
    contacts: { channels: [{ kind: "phone", value: "(208) 555-0142", sourceUrl: "https://www.boise-fab.test/" }], people: [] },
    evidence: { sourcesUsed: [], limitations: [], gaps: [], proposedSources: [] },
  };
  const client = {
    interactions: {
      create: async () => {
        turn++;
        const usage = { total_input_tokens: 4000, total_output_tokens: 800, total_thought_tokens: 200, total_tokens: 5000 };
        if (turn === 1) return { id: `i${turn}`, status: "requires_action", steps: [{ type: "thought", signature: "c2lnLXNjcmlwdGVk" }, { type: "function_call", id: "c1", name: "read_page", arguments: { url: "https://www.boise-fab.test/about" } }], usage };
        return { id: `i${turn}`, status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(report) }] }], usage };
      },
    },
  };
  return geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never, count: signatureCheckingCounter(4000) });
}

/** Google's rule, as M-0003 met it: the first function call of each model turn must carry its thought signature. */
function signatureCheckingCounter(total: number) {
  return async (_model: string, body: { generateContentRequest: Record<string, unknown> }) => {
    const contents = body.generateContentRequest.contents as { role: string; parts: Record<string, unknown>[] }[];
    for (const c of contents.filter((x) => x.role === "model")) {
      const first = c.parts.find((p) => p.functionCall);
      if (first && typeof first.thoughtSignature !== "string") throw Object.assign(new Error("Google's token counter answered HTTP 400: Function call is missing a thought_signature in functionCall parts."), { status: 400 });
    }
    return { totalTokens: total };
  };
}

function executor(research: (scope: Parameters<ProviderSet["research"]>[0]) => MissionProvider): MissionExecutor {
  const providers: ProviderSet = { research, reviewer: () => simulatedReviewer(redeemTicket) };
  return new MissionExecutor(async () => ({ db, providers, transport: fixtureTransport(SITES), minIntervalMs: 0 }));
}
const simulated = () => executor((scope) => simulatedResearcher(scope.type, redeemTicket));

async function approved(m: MissionInput) {
  const draft = await createMission(db, operator, m, rid());
  await submitMission(db, operator, draft.id, rid());
  const d = await getMission(db, founder, draft.id);
  return approveMission(db, founder, draft.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
}

beforeAll(async () => {
  const h = await freshDb();
  db = h.db;
  close = h.close;
  const fid = await createUserWithRole(db, { name: "Fran Owner", email: "fran@test.local", password: TEST_PASSWORD, role: "operator" });
  await designateFounder(db, { email: "fran@test.local", password: TEST_PASSWORD });
  founder = await actorFor(db, fid);
  operator = await actorFor(db, await createUserWithRole(db, { name: "Oscar Operator", email: "oscar@test.local", password: TEST_PASSWORD, role: "operator" }));
});

afterAll(async () => {
  await close();
});

describe("a simulated company mission, end to end", () => {
  it("runs once through the runner, checks its quotes, costs $0 and leaves no research record", async () => {
    const ex = simulated();
    const m = await approved(input());
    expect(m.status).toBe("approved");
    await startMission(db, founder, m.id, rid(), ex);
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.status).toBe("completed");
    expect(done.holdsPageText).toBe(false);
    const checks = done.result!.checks as { claims: { finalCategory: string; verdict: string }[] };
    expect(checks.claims.some((c) => c.finalCategory === "verified_fact" && c.verdict === "found")).toBe(true);
    expect(done.ledger.length).toBeGreaterThan(0);
    expect(done.ledger.every((l) => l.simulated && l.reservedMicros === 0)).toBe(true);
    expect((await db.select({ n: count() }).from(researchRecords))[0].n).toBe(0);
  });

  it("can't be started by another operator, and starts once whatever the clicks", async () => {
    const ex = simulated();
    const m = await approved(input());
    await expect(startMission(db, operator, m.id, rid(), ex)).rejects.toThrow();
    const same = rid();
    await startMission(db, founder, m.id, same, ex);
    await startMission(db, founder, m.id, same, ex); // the same request again: acts once
    await expect(startMission(db, founder, m.id, rid(), ex)).rejects.toThrow(/already started|Only an approved/);
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.steps.filter((s) => s.kind === "state" && s.summary === "running")).toHaveLength(1);
  });
});

describe("the real path, with a scripted Gemini client", () => {
  it("settles each request at Google's reported usage and saves a research version a new company gets an entry for", async () => {
    process.env.GEMINI_API_KEY ??= "not-a-key-test-only";
    const ex = executor(() => scriptedGemini());
    const m = await approved(input({ simulated: false }));
    await startMission(db, founder, m.id, rid(), ex);
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.status).toBe("completed");
    const sends = done.ledger.filter((l) => l.purpose !== "count");
    expect(sends.length).toBe(2);
    expect(sends.every((l) => l.status === "settled" && !l.simulated && (l.actualMicros ?? 0) > 0)).toBe(true);
    const rows = await db.select().from(researchRecords).where(eq(researchRecords.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].companyKey).toMatch(/^n\d{4}$/);
    const listed = await opportunities(db, founder);
    expect(listed.some((o) => o.id === rows[0].companyKey)).toBe(true);
    const page = await opportunity(db, founder, rows[0].companyKey);
    expect(page?.historical).toBe(false);
    expect(page?.researchVersions).toHaveLength(1);
    // Decisions, checks and discovery records work for it as for a benchmark company.
    const key = rows[0].companyKey;
    const headers = new Headers({ host: "127.0.0.1:3000" });
    const token = ((await handleDesktopRequest(async () => db, { method: "POST", path: ["session"], headers, json: async () => ({ email: "fran@test.local", password: TEST_PASSWORD }) }, { NODE_ENV: "test" })).body as { data: { token: string } }).data.token;
    headers.set("authorization", `Bearer ${token}`);
    const call = (method: string, route: string, body?: unknown) => handleDesktopRequest(async () => db, { method, path: route.split("/"), headers, json: async () => body }, { NODE_ENV: "test" });
    expect((await call("PUT", `opportunities/${key}/decision`, { decision: "hold", note: "Mission research, not yet discussed" })).status).toBe(200);
    expect((await call("POST", `opportunities/${key}/checks`, { statement: "Registry lists it as active", sourceUrl: "", checkedOn: "2026-10-28", note: "Checked by hand" })).status).toBe(200);
    const after = (await call("GET", `opportunities/${key}`)).body as { data: { decision: { decision: string } | null; workflow: { checks: unknown[] } } };
    expect(after.data.decision?.decision).toBe("hold");
    expect(after.data.workflow.checks).toHaveLength(1);
  });
});

describe("a count the provider's SDK refuses (M-0002)", () => {
  it("fails the mission after one attempt, records the count as not billed and sends nothing", async () => {
    process.env.GEMINI_API_KEY ??= "not-a-key-test-only";
    let sends = 0;
    let counts = 0;
    // The exact refusal @google/genai 2.28 raised for M-0002, before anything left the computer.
    const sdkRefusal = () => {
      counts++;
      throw new Error("systemInstruction parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.");
    };
    const client = { interactions: { create: async () => (sends++, {}) } };
    const ex = executor(() => geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never, count: async () => sdkRefusal() }));
    const m = await approved(input({ simulated: false }));
    await startMission(db, founder, m.id, rid(), ex);
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.status).toBe("failed");
    expect(counts).toBe(1);
    expect(sends).toBe(0);
    expect(done.ledger).toHaveLength(1);
    expect(done.ledger[0]).toMatchObject({ purpose: "count", status: "not_billed", reservedMicros: 0 });
    const requests = (await db.select().from(missionSteps).where(eq(missionSteps.missionId, m.id))).filter((s) => s.kind === "model_request");
    expect(requests).toHaveLength(1);
  });
});

describe("the scope fingerprint and the approval binding (M-0002 and M-0003)", () => {
  it("is shared by missions with the same scope, yet each approval binds its own mission, and a purpose edit can't be approved unseen", async () => {
    const a = await approved(input({ purpose: "Find genuine opportunities" }));
    const b = await approved(input({ purpose: "Find realistic opportunities" }));
    expect(a.scopeFingerprint).toBe(b.scopeFingerprint);
    const [aApproval] = a.approvals.filter((x) => x.state === "active");
    expect(aApproval).toBeDefined();
    expect(b.approvals.map((x) => x.id)).not.toContain(aApproval.id);
    // Editing only the purpose voids b's approval; a's is untouched.
    const shown = await getMission(db, founder, b.id);
    const edited = await updateMission(db, operator, b.id, input({ purpose: "Changed while the owner looked" }), rid());
    expect(edited.status).toBe("awaiting_approval");
    expect(edited.approvals.every((x) => x.state !== "active")).toBe(true);
    expect((await getMission(db, founder, a.id)).approvals.some((x) => x.id === aApproval.id && x.state === "active")).toBe(true);
    await expect(approveMission(db, founder, b.id, { fingerprint: shown.scopeFingerprint, purpose: shown.purpose, requestId: rid() })).rejects.toMatchObject({ code: "conflict" });
    await expect(startMission(db, founder, b.id, rid(), simulated())).rejects.toBeTruthy();
    const current = await getMission(db, founder, b.id);
    expect((await approveMission(db, founder, b.id, { fingerprint: current.scopeFingerprint, purpose: current.purpose, requestId: rid() })).status).toBe("approved");
  });
});

describe("a tool call that came without its signature", () => {
  it("fails at the next count, once and at $0, after settling the request that was sent", async () => {
    process.env.GEMINI_API_KEY ??= "not-a-key-test-only";
    let sends = 0;
    const usage = { total_input_tokens: 4000, total_output_tokens: 300, total_tokens: 4300 };
    const client = {
      interactions: {
        create: async () => (sends++, { id: "i1", status: "requires_action", steps: [{ type: "function_call", id: "c1", name: "read_page", arguments: { url: "https://www.boise-fab.test/about" } }], usage }),
      },
    };
    const ex = executor(() => geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never, count: signatureCheckingCounter(4000) }));
    const m = await approved(input({ simulated: false }));
    await startMission(db, founder, m.id, rid(), ex);
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.status).toBe("failed");
    expect(sends).toBe(1);
    expect(done.ledger.map((l) => [l.purpose, l.status])).toEqual(expect.arrayContaining([["research", "settled"], ["count", "not_billed"]]));
    expect(done.ledger.filter((l) => l.purpose === "count")).toHaveLength(2);
    expect(done.ledger.filter((l) => l.purpose !== "count")).toHaveLength(1);
  });
});

describe("cancelling and recovery", () => {
  it("cancels a mission mid-request, recording the request in flight as unverified", async () => {
    let release: () => void = () => {};
    const slow: MissionProvider = {
      ...simulatedResearcher("company_research", redeemTicket),
      async respond(req, ticket, signal) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
        return simulatedResearcher("company_research", redeemTicket).respond(req, ticket, signal);
      },
    };
    const ex = executor(() => slow);
    const m = await approved(input());
    await startMission(db, founder, m.id, rid(), ex);
    for (let i = 0; i < 100 && !(await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.id))).some((l) => l.status === "reserved"); i++) await new Promise((r) => setTimeout(r, 20));
    await cancelMission(db, founder, m.id, rid(), ex);
    release();
    await ex.idle(m.id);
    const done = await getMission(db, founder, m.id, ex);
    expect(done.status).toBe("cancelled");
    expect(done.ledger.filter((l) => l.purpose !== "count").at(-1)?.status).toBe("unverified");
  });

  it("makes a mission left running Interrupted at start-up, and resends nothing", async () => {
    const m = await approved(input());
    await db.update(missions).set({ status: "running", runId: rid(), workingState: null }).where(eq(missions.id, m.id));
    const { interrupted } = await recoverAtStartup(db);
    expect(interrupted).toBeGreaterThanOrEqual(1);
    const after = await getMission(db, founder, m.id);
    expect(after.status).toBe("interrupted");
    expect(after.ledger).toHaveLength(0);
  });
});

describe("nothing reaches anyone", () => {
  it("no mission writes to the outbox", async () => {
    expect((await db.select({ n: count() }).from(outbox))[0].n).toBe(0);
  });
});

describe("rollback", () => {
  it("undoes migrations 0004 and 0005 and lets them apply again", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    const d = drizzle(client);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const since = journal.entries.find((e) => e.tag.startsWith("0004_"))!.when;
    const sql = fs.readFileSync(path.join(process.cwd(), "docs", "m2b", "rollback.sql"), "utf8").replaceAll(":m2b_since", String(since));
    await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    const tables = await client.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name in ('missions','ai_usage_ledger','research_sources')");
    expect(tables.rows[0].n).toBe(0);
    const cols = await client.query<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'users' and column_name in ('spending_authority_at','sign_in_disabled_at')");
    expect(cols.rows[0].n).toBe(0);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    const back = await client.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name = 'missions'");
    expect(back.rows[0].n).toBe(1);
    await client.close();
  });
});

describe("the AI Operations routes of the desktop API", () => {
  const req = (method: string, route: string, token: string | null, body?: unknown) => {
    const headers = new Headers({ host: "127.0.0.1:3000" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    return handleDesktopRequest(async () => db, { method, path: route.split("/"), headers, json: async () => body }, { NODE_ENV: "test" });
  };
  const signIn = async (email: string) => ((await req("POST", "session", null, { email, password: TEST_PASSWORD })).body as { data: { token: string } }).data.token;

  it("draft and submit as any operator; approve only as the owner; the window gets 403 and 409, never a 500", async () => {
    const op = await signIn("oscar@test.local");
    const fr = await signIn("fran@test.local");
    const created = await req("POST", "ai/missions", op, { requestId: rid(), mission: input() });
    expect(created.status).toBe(200);
    const id = (created.body as { data: { id: string } }).data.id;
    expect((await req("POST", `ai/missions/${id}/submit`, op, { requestId: rid() })).status).toBe(200);
    const fp = ((await req("GET", `ai/missions/${id}`, op)).body as { data: { scopeFingerprint: string } }).data.scopeFingerprint;
    const byOperator = await req("POST", `ai/missions/${id}/approve`, op, { requestId: rid(), fingerprint: fp, purpose: "test" });
    expect(byOperator.status).toBe(403);
    const stale = await req("POST", `ai/missions/${id}/approve`, fr, { requestId: rid(), fingerprint: "0".repeat(64), purpose: "test" });
    expect(stale.status).toBe(409);
    const ok = await req("POST", `ai/missions/${id}/approve`, fr, { requestId: rid(), fingerprint: fp, purpose: "test" });
    expect(ok.status).toBe(200);
    expect((await req("POST", `ai/missions/${id}/start`, op, { requestId: rid() })).status).toBe(403);
    expect((await req("POST", "ai/missions", op, { requestId: rid(), mission: { ...input(), maxCostMicros: 5_000_000 } })).status).toBe(400);
    expect((await req("GET", "ai/approvals", fr)).status).toBe(200);
    expect((await req("GET", "ai/spending", fr)).status).toBe(200);
    expect((await req("GET", "ai/sources", op)).status).toBe(200);
    expect((await req("GET", "ai/capabilities", op)).status).toBe(200);
    expect((await req("GET", `ai/missions/${id}/review-estimate/claude-sonnet-5-5`, op)).status).toBe(200);
  });

  it("refuses every mission route without an operator session", async () => {
    for (const [m, r] of [["GET", "ai/missions"], ["POST", "ai/missions"], ["GET", "ai/spending"], ["GET", "ai/approvals"]] as const) {
      expect((await req(m, r, null, { requestId: rid() })).status).toBe(401);
    }
  });
});
