import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeReviewProvider } from "@/lib/ai/claude";
import { geminiMissionProvider } from "@/lib/ai/gemini";
import { hashPassword } from "@/lib/auth/password";
import { issueSessionToken, userForSessionToken } from "@/lib/auth/session";
import {
  assertFounder,
  assertTestDatabase,
  designateFounder,
  founderAuthority,
  isFounder,
  meteredRequest,
  precommitSpending,
  prepareTestCopy,
  redeemTicket,
  revokeFounder,
  spendingSummary,
  syntheticPlanFromEnv,
  syntheticProvider,
  testCopyProblem,
  testMode,
} from "@/lib/controls";
import { MIGRATIONS_FOLDER, openDb, schema, type DB } from "@/lib/db";
import { aiUsageLedger, events, missionApprovals, missions, missionSteps, outbox, sessions, users } from "@/lib/db/schema";
import { handleDesktopRequest, type DesktopRequest } from "@/lib/desktop/api";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actor";
import { authenticate, createUserWithRole } from "@/lib/domain/accounts";
import { fixtureTransport } from "@/lib/research/fixtures";
import { draftScope } from "@/lib/scoping";
import { aiScopingConfigured } from "@/lib/scoping/ai";
import { ProviderError, ProviderFailure, SpendRefused, TicketRefused, type MissionProvider, type SpendTicket } from "@/lib/missions/contract";
import type { MissionInput } from "@/lib/missions/input";
import type { ProviderSet } from "@/lib/missions/providers";
import { MissionExecutor, recoverAtStartup } from "@/lib/missions/runner";
import { addReview, approveMission, cancelMission, createMission, getMission, rejectMission, resumeMission, startMission, submitMission } from "@/lib/missions/service";
import { simulatedResearcher, simulatedReviewer } from "@/lib/missions/simulated";
import { actorFor, freshDb, SAMPLE_INTAKE, seedParties, TEST_PASSWORD } from "./helpers";
import { approve, ctxFor, fakeProvider, insertMission, reply, request, runningMission, scope, signal, startRun, step, usage, world } from "./fixtures/sentinel/world";

// The security reviewer's security and verification tests (docs/m2b/PLAN.md, criteria 4, 7, 13, 18, 21, 30, 32-34, and the CLIs).
// In-memory or temporary databases only; no provider is reached (fetch fails the test), and keys are fakes.

let fetchCalls = 0;
beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal("fetch", () => {
    fetchCalls++;
    throw new Error("A test tried to open a network connection.");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOT = process.cwd();
const SITES = path.join(ROOT, "tests", "fixtures", "sites");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const COMPANY = { kind: "company" as const, recordId: null, name: "Boise Fab & Weld", website: "https://www.boise-fab.test/", town: "Boise", state: "ID", industry: "Manufacturing" };
const rid = () => randomUUID();
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Stands in for the seed script's shared demo password (SEED_PASSWORD); no real password is kept in the repository.
const SEED_DEMO_PASSWORD = "seed-demo-password-for-tests";

function missionInput(patch: Partial<MissionInput> = {}): MissionInput {
  return { type: "company_research", simulated: true, purpose: "The security reviewer test", subject: COMPANY, model: "gemini-4-argon", thinkingLevel: "medium", maxCostMicros: 1_000_000, review: null, ...patch };
}

function executorFor(db: DB, research: (s: Parameters<ProviderSet["research"]>[0]) => MissionProvider): MissionExecutor {
  const providers: ProviderSet = { research, reviewer: () => simulatedReviewer(redeemTicket) };
  return new MissionExecutor(async () => ({ db, providers, transport: fixtureTransport(SITES), minIntervalMs: 0 }));
}

/** The newest file write in a folder, from file times only (0 when it doesn't exist); nothing is opened. */
function newestWrite(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** Whether something listens on 127.0.0.1:3000 (a connection attempt only; nothing is sent). */
function port3000Busy(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(3000, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function run(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [TSX, ...args], { cwd: ROOT, env: { ...process.env, ...opts.env }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

describe("owner spending authority (criterion 4)", () => {
  it("is granted only with the account's own password, to a non-demo operator whose sign-in is on", async () => {
    const { db } = await freshDb();
    const { operator, client, builder } = await seedParties(db);
    await createUserWithRole(db, { name: "Morgan", email: "morgan@demo.local", password: TEST_PASSWORD, role: "operator" }, { isDemo: true });
    await createUserWithRole(db, { name: "Seeded", email: "seeded@test.local", password: SEED_DEMO_PASSWORD, role: "operator" });
    const off = await createUserWithRole(db, { name: "Off", email: "off@test.local", password: TEST_PASSWORD, role: "operator" });
    await db.update(users).set({ signInDisabledAt: new Date() }).where(eq(users.id, off));
    await expect(designateFounder(db, { email: operator.email!, password: "not-the-password" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(designateFounder(db, { email: "nobody@test.local", password: TEST_PASSWORD })).rejects.toMatchObject({ code: "forbidden" });
    await expect(designateFounder(db, { email: "morgan@demo.local", password: TEST_PASSWORD })).rejects.toThrow(/demo account/);
    await expect(designateFounder(db, { email: client.email!, password: TEST_PASSWORD })).rejects.toThrow(/isn't an operator/);
    await expect(designateFounder(db, { email: builder.email!, password: TEST_PASSWORD })).rejects.toThrow(/isn't an operator/);
    const savedSeed = process.env.SEED_PASSWORD;
    process.env.SEED_PASSWORD = SEED_DEMO_PASSWORD;
    try {
      await expect(designateFounder(db, { email: "seeded@test.local", password: SEED_DEMO_PASSWORD })).rejects.toThrow(/SEED_PASSWORD/);
    } finally {
      if (savedSeed === undefined) delete process.env.SEED_PASSWORD;
      else process.env.SEED_PASSWORD = savedSeed;
    }
    await expect(designateFounder(db, { email: "off@test.local", password: TEST_PASSWORD })).rejects.toThrow(/Sign-in is turned off/);
    expect(await founderAuthority(db)).toBeNull();
    const f = await designateFounder(db, { email: ` ${operator.email!.toUpperCase()} `, password: TEST_PASSWORD });
    expect(f).toMatchObject({ userId: operator.id, email: operator.email });
    expect(await isFounder(db, operator.id)).toBe(true);
    expect(await isFounder(db, null)).toBe(false);
    // Designating again changes nothing.
    expect((await designateFounder(db, { email: operator.email!, password: TEST_PASSWORD })).since).toBe(f.since);
    expect(await db.select().from(events).where(eq(events.type, "founder_authority_granted"))).toHaveLength(1);
  });

  it("moves only with --replace, voiding every open approval, and is revoked with the holder's password", async () => {
    const w = await world();
    const { missionId } = await runningMission(w, scope());
    await expect(designateFounder(w.db, { email: w.other.email!, password: TEST_PASSWORD })).rejects.toMatchObject({ code: "conflict" });
    expect(await isFounder(w.db, w.founder.id)).toBe(true);
    await designateFounder(w.db, { email: w.other.email!, password: TEST_PASSWORD, replace: true });
    expect(await isFounder(w.db, w.other.id)).toBe(true);
    expect(await isFounder(w.db, w.founder.id)).toBe(false);
    const [a] = await w.db.select().from(missionApprovals).where(eq(missionApprovals.missionId, missionId));
    expect(a.voidReason).toBe("Owner spending authority moved to another account.");
    expect((await w.db.select().from(events)).map((e) => e.type)).toEqual(expect.arrayContaining(["founder_authority_revoked", "founder_authority_granted"]));
    await expect(revokeFounder(w.db, { email: w.founder.email!, password: TEST_PASSWORD })).rejects.toMatchObject({ code: "conflict" });
    await expect(revokeFounder(w.db, { email: w.other.email!, password: "not-the-password" })).rejects.toMatchObject({ code: "forbidden" });
    await revokeFounder(w.db, { email: w.other.email!, password: TEST_PASSWORD });
    expect(await founderAuthority(w.db)).toBeNull();
  });

  it("is held by one account at most, and never by a demo account, a non-operator or a disabled account (the database)", async () => {
    const w = await world();
    const now = new Date();
    for (const id of [w.other.id!, w.demo.id!, w.client.id!, w.builder.id!]) {
      await expect(w.db.update(users).set({ spendingAuthorityAt: now }).where(eq(users.id, id))).rejects.toThrow();
    }
    await expect(w.db.update(users).set({ isDemo: true }).where(eq(users.id, w.founder.id!))).rejects.toThrow();
    await expect(w.db.update(users).set({ role: "client" }).where(eq(users.id, w.founder.id!))).rejects.toThrow();
    await expect(w.db.update(users).set({ signInDisabledAt: now }).where(eq(users.id, w.founder.id!))).rejects.toThrow();
    expect(await isFounder(w.db, w.founder.id)).toBe(true);
  });

  it("refuses every actor but the owner, however the actor is described", async () => {
    const w = await world();
    const forged: Actor[] = [w.other, w.demo, w.client, w.builder, SYSTEM_ACTOR, { ...w.founder, role: "client" }, { ...w.other, name: w.founder.name, email: w.founder.email }, { ...w.founder, id: null }];
    for (const actor of forged) await expect(assertFounder(w.db, actor)).rejects.toMatchObject({ code: "forbidden" });
    await assertFounder(w.db, w.founder);
  });

  it("keeps every owner-only mission action from other operators and the demo operator (criterion 4)", async () => {
    const w = await world();
    const draft = await createMission(w.db, w.other, missionInput(), rid());
    await submitMission(w.db, w.other, draft.id, rid());
    const fp = (await getMission(w.db, w.founder, draft.id)).scopeFingerprint;
    const ex = executorFor(w.db, (s) => simulatedResearcher(s.type, redeemTicket));
    for (const actor of [w.other, w.demo]) {
      await expect(approveMission(w.db, actor, draft.id, { fingerprint: fp, requestId: rid() })).rejects.toMatchObject({ code: "forbidden" });
      await expect(rejectMission(w.db, actor, draft.id, { reason: "no", requestId: rid() })).rejects.toMatchObject({ code: "forbidden" });
      await expect(startMission(w.db, actor, draft.id, rid(), ex)).rejects.toMatchObject({ code: "forbidden" });
      await expect(resumeMission(w.db, actor, draft.id, rid(), ex)).rejects.toMatchObject({ code: "forbidden" });
      await expect(cancelMission(w.db, actor, draft.id, rid(), ex)).rejects.toMatchObject({ code: "forbidden" });
      await expect(addReview(w.db, actor, draft.id, { model: "claude-haiku-5-5", maxCostMicros: 100_000, requestId: rid() })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await w.db.select().from(missionApprovals)).toHaveLength(0);
    expect((await getMission(w.db, w.founder, draft.id)).status).toBe("awaiting_approval");
  });

  it("is granted by no source code but the controls and their command-line tools", () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
    const code = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "desktop", "src")), ...files(path.join(ROOT, "scripts"))].map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));
    const writesAuthority = code.filter((c) => /\.(set|values)\(\s*\{[^}]*\bspendingAuthorityAt\s*:/s.test(c.text) || /set\s+"?spending_authority_at"?\s*=/i.test(c.text)).map((c) => c.file);
    expect(writesAuthority.sort()).toEqual(["src/lib/controls/authority.ts"]);
    const grants = code.filter((c) => /\b(designateFounder|revokeFounder|moveAuthority|prepareTestCopy|precommitSpending)\b/.test(c.text) && !c.file.startsWith("src/lib/controls/")).map((c) => c.file);
    expect(grants.sort()).toEqual(["scripts/designate-founder.ts", "scripts/prepare-test-copy.ts"]);
    const reenables = code.filter((c) => /signInDisabledAt\s*:\s*null/.test(c.text)).map((c) => c.file);
    expect(reenables).toEqual(["src/lib/controls/testcopy.ts"]);
  });
});

describe("the demo sign-in shut-off (criterion 4)", () => {
  async function preM2b() {
    const dir = tmp("kelqor-0003-");
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const kept = journal.entries.filter((e) => e.idx <= 3);
    for (const e of kept) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    return { client, db: db as unknown as DB };
  }

  it("turns off sign-in and ends the sessions of every demo account in an existing database, keeping their records", async () => {
    const { client, db } = await preM2b();
    const hash = await hashPassword(SEED_DEMO_PASSWORD);
    const people = [
      ["d1", "ops@forgex.local", "operator", true],
      ["d2", "riley@brightline.demo", "client", true],
      ["d3", "sam@builder.demo", "builder", true],
      ["r1", "pat.owner@real.test", "operator", false],
    ] as const;
    for (const [id, email, role, demo] of people) {
      await db.execute(sql`insert into users (id, email, name, password_hash, role, is_demo) values (${id}, ${email}, ${email}, ${hash}, ${role}, ${demo})`);
    }
    const token = (t: string) => createHash("sha256").update(t).digest("hex");
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    await db.execute(sql`insert into sessions (id, user_id, expires_at) values (${token("demo-session-token-0000000000")}, 'd1', ${expires}::timestamptz), (${token("real-session-token-0000000000")}, 'r1', ${expires}::timestamptz)`);
    const before = (await db.execute(sql`select count(*)::int as n from users`)) as unknown as { rows: { n: number }[] };
    // Apply 0004 and 0005, as the release step does after the backup.
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await db.select({ id: users.id, off: users.signInDisabledAt, demo: users.isDemo }).from(users);
    expect(rows).toHaveLength(before.rows[0].n);
    for (const r of rows) expect(Boolean(r.off)).toBe(r.demo);
    for (const [, email] of people.filter((p) => p[3])) {
      await expect(authenticate(db, email, SEED_DEMO_PASSWORD)).rejects.toThrow("That email and password don't match an account.");
    }
    expect(await authenticate(db, "pat.owner@real.test", SEED_DEMO_PASSWORD)).toBe("r1");
    expect(await userForSessionToken(db, "demo-session-token-0000000000")).toBeNull();
    expect((await userForSessionToken(db, "real-session-token-0000000000"))?.id).toBe("r1");
    expect(await db.select({ n: count() }).from(sessions)).toEqual([{ n: 2 }]); // nothing deleted
    await client.close();
  });

  it("refuses a disabled account at the desktop sign-in with the same answer as a wrong password", async () => {
    const w = await world();
    await w.db.update(users).set({ signInDisabledAt: new Date() }).where(eq(users.id, w.demo.id!));
    const call = (email: string, password: string) =>
      handleDesktopRequest(async () => w.db, { method: "POST", path: ["session"], headers: new Headers({ host: "127.0.0.1:3000" }), json: async () => ({ email, password }) }, { NODE_ENV: "test" });
    const disabled = await call("morgan@demo.local", TEST_PASSWORD);
    const wrong = await call("otto@test.local", "not-the-password");
    expect(disabled.status).toBe(403);
    expect(disabled.body).toEqual(wrong.body);
    expect((await call("otto@test.local", TEST_PASSWORD)).status).toBe(200);
  });
});

describe("mission routes (criteria 3, 34)", () => {
  function routes(id: string): [string, string[], unknown][] {
    const r = { requestId: rid() };
    return [
      ["GET", ["ai"], undefined],
      ["GET", ["ai", "missions"], undefined],
      ["POST", ["ai", "missions"], { ...r, mission: missionInput() }],
      ["GET", ["ai", "missions", id], undefined],
      ["PUT", ["ai", "missions", id], { ...r, mission: missionInput() }],
      ...["submit", "approve", "reject", "start", "resume", "cancel", "review", "accept", "close"].map((a): [string, string[], unknown] => ["POST", ["ai", "missions", id, a], { ...r, fingerprint: "0".repeat(64), purpose: "test", reason: "x", note: "x", model: "claude-haiku-5-5", maxCostMicros: 1 }]),
      ["GET", ["ai", "options"], undefined],
      ["GET", ["ai", "missions", id, "review-estimate", "claude-haiku-5-5"], undefined],
      ["POST", ["ai", "estimate"], { mission: missionInput() }],
      ["GET", ["ai", "approvals"], undefined],
      ["GET", ["ai", "spending"], undefined],
      ["GET", ["ai", "reconciliation", "google", "day", "2026-10-20"], undefined],
      ["POST", ["ai", "reconciliation", "figure"], { provider: "google", periodKind: "day", period: "2026-10-20", providerMicros: 1, note: "console" }],
      ["POST", ["ai", "reconciliation", "release"], { figureId: rid(), entries: [{ ledgerId: rid(), micros: 1 }], note: "console" }],
      ["POST", ["ai", "reconciliation", "unblock"], { provider: "google", note: "reviewed" }],
      ["GET", ["ai", "sources"], undefined],
      ["POST", ["ai", "sources"], { name: "x", match: "osha.gov", kind: "regulator", industries: [], purpose: "x" }],
      ["PUT", ["ai", "sources", "osha"], { status: "approved", note: "x" }],
      ["GET", ["ai", "intelligence"], undefined],
      ["POST", ["ai", "intelligence", id, "review"], undefined],
      ["GET", ["ai", "research"], undefined],
      ["GET", ["ai", "capabilities"], undefined],
      ["GET", ["ai", "running"], undefined],
    ];
  }

  it("refuse clients, builders and anyone signed out, on every route", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope());
    const tokens = { client: (await issueSessionToken(w.db, w.client.id!)).token, builder: (await issueSessionToken(w.db, w.builder.id!)).token };
    const ledgerBefore = await w.db.select({ n: count() }).from(aiUsageLedger);
    for (const [method, p, body] of routes(missionId)) {
      for (const [who, token] of [["client", tokens.client], ["builder", tokens.builder], ["nobody", null]] as const) {
        const headers = new Headers({ host: "127.0.0.1:3000" });
        if (token) headers.set("authorization", `Bearer ${token}`);
        const res = await handleDesktopRequest(async () => w.db, { method, path: p, headers, json: async () => body } as DesktopRequest, { NODE_ENV: "test" });
        expect([res.status, who, method, p.join("/")]).toEqual([who === "nobody" ? 401 : 403, who, method, p.join("/")]);
      }
    }
    expect(await w.db.select({ n: count() }).from(aiUsageLedger)).toEqual(ledgerBefore);
    expect((await w.db.select().from(missions).where(eq(missions.id, missionId)))[0].status).toBe("awaiting_approval");
  });

  it("refuse owner-only actions to other operators with 403, and leave the mission untouched", async () => {
    const w = await world();
    const draft = await createMission(w.db, w.other, missionInput(), rid());
    await submitMission(w.db, w.other, draft.id, rid());
    const token = (await issueSessionToken(w.db, w.other.id!)).token;
    for (const [method, p, body] of routes(draft.id).filter(([m, p]) => m === "POST" && (p[3] ?? p[2]) && ["approve", "reject", "start", "resume", "cancel", "review", "accept", "close", "figure", "release", "unblock"].includes(p[3] ?? p[2]))) {
      const res = await handleDesktopRequest(
        async () => w.db,
        { method, path: p, headers: new Headers({ host: "127.0.0.1:3000", authorization: `Bearer ${token}` }), json: async () => body } as DesktopRequest,
        { NODE_ENV: "test" },
      );
      expect([res.status, p.join("/")]).toEqual([403, p.join("/")]);
    }
    expect((await getMission(w.db, w.founder, draft.id)).status).toBe("awaiting_approval");
    expect(await w.db.select().from(missionApprovals)).toHaveLength(0);
  });
});

describe("tickets and the provider adapters (criterion 13)", () => {
  const forged = (o: Partial<SpendTicket> = {}) => ({ use: "send", reservationId: rid(), provider: "google", model: "gemini-4-argon", kind: "real", maxOutputTokens: 20_000, ...o }) as unknown as SpendTicket;

  it("refuse a ticket the controls didn't issue, before the SDK is called", async () => {
    const calls: string[] = [];
    const client = {
      interactions: { create: async () => (calls.push("send"), { status: "completed", steps: [], usage: { total_input_tokens: 1 } }) },
    };
    const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never, count: async () => (calls.push("count"), { totalTokens: 10 }) });
    await expect(gemini.respond(request(), forged(), signal())).rejects.toBeInstanceOf(TicketRefused);
    await expect(gemini.countInputTokens(request(), forged({ use: "count" }), signal())).rejects.toBeInstanceOf(TicketRefused);
    const anthropic = { messages: { countTokens: async () => (calls.push("claude count"), { input_tokens: 1 }), create: async () => (calls.push("claude send"), {}) } };
    const claude = claudeReviewProvider("claude-haiku-5-5", { redeem: redeemTicket, client: () => anthropic as never });
    await expect(claude.respond(request(), forged({ provider: "anthropic", model: "claude-haiku-5-5" }), signal())).rejects.toBeInstanceOf(TicketRefused);
    await expect(claude.countInputTokens(request(), forged({ use: "count", provider: "anthropic", model: "claude-haiku-5-5" }), signal())).rejects.toBeInstanceOf(TicketRefused);
    expect(calls).toEqual([]);
    expect(() => redeemTicket(forged(), { use: "send", provider: "google", model: "gemini-4-argon", kind: "real", request: request() })).toThrow(TicketRefused);
  });

  it("have a reservation in the ledger before Gemini's SDK sends anything, and settle at its reported usage", async () => {
    const w = await world();
    const m = await runningMission(w, scope());
    const seen: string[] = [];
    const openRows = async (purpose: string) => (await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.missionId))).filter((r) => r.purpose === purpose && r.status === "reserved").length;
    const count = async () => {
      seen.push(`count with ${await openRows("count")} open count entry`);
      return { totalTokens: 9_000 };
    };
    const client = {
      interactions: {
        create: async (_body: unknown, opts: { retries?: { strategy?: string } }) => {
          seen.push(`send with ${await openRows("research")} open reservation, retries ${opts.retries?.strategy}`);
          return { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }], usage: { total_input_tokens: 9_100, total_output_tokens: 700, total_thought_tokens: 300, total_tokens: 10_100 } };
        },
      },
    };
    const gemini = geminiMissionProvider("gemini-4-argon", { thinkingLevel: "medium", redeem: redeemTicket, client: () => client as never, count });
    const out = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), gemini, request(), signal());
    expect(seen).toEqual(["count with 1 open count entry", "send with 1 open reservation, retries none"]);
    expect(out).toMatchObject({ countedInputTokens: 9_000, actualMicros: 9_100 * 2 + 1_000 * 10 });
    const [row] = (await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, m.missionId))).filter((r) => r.purpose === "research");
    expect(row).toMatchObject({ status: "settled", providerRequestId: "int-1", usage: expect.objectContaining({ input: 9_100, output: 700, thinking: 300 }) });
  });

  it("can't be reused, switched to another request, or used for the other call", async () => {
    const w = await world();
    const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }));
    let stash: SpendTicket | null = null;
    const keeper = fakeProvider({ answer: () => reply() });
    const original = keeper.respond.bind(keeper);
    keeper.respond = async (req, ticket, s) => {
      stash = ticket;
      return original(req, ticket, s);
    };
    await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), keeper, request(), signal());
    expect(() => redeemTicket(stash!, { use: "send", provider: "google", model: "gemini-4-argon", kind: "real", request: request() })).toThrow(/already used/);
    // A provider that sends a different request than the one counted: refused, not billed.
    const swapper = fakeProvider();
    swapper.respond = async (req, ticket) => {
      redeemTicket(ticket, { use: "send", provider: "google", model: "gemini-4-argon", kind: "real", request: { ...req, turns: [...req.turns, { kind: "user", text: "and one more thing" }] } });
      return reply();
    };
    const e = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), swapper, request(), signal()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderFailure);
    expect((e as ProviderFailure).outcome).toBe("not_billed");
    // A provider that uses its count ticket as if it were the send ticket, and one that lies about its kind.
    const confused = fakeProvider();
    confused.countInputTokens = async (req, ticket) => {
      redeemTicket(ticket, { use: "send", provider: "google", model: "gemini-4-argon", kind: "real", request: req });
      return { counted: 1, uncounted: 0 };
    };
    expect(await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), confused, request(), signal()).catch((x) => (x as SpendRefused).reason)).toBe("count_failed");
    const liar = fakeProvider();
    liar.respond = async (req, ticket) => {
      redeemTicket(ticket, { use: "send", provider: "google", model: "gemini-4-argon", kind: "simulated", request: req });
      return reply();
    };
    expect(((await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), liar, request(), signal()).catch((x) => x)) as ProviderFailure).outcome).toBe("not_billed");
  });

  it("are the only way to a provider: the SDKs and their calls live in the adapters alone", () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
    const code = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "desktop", "src")), ...files(path.join(ROOT, "scripts"))].map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));
    const where = (re: RegExp) => code.filter((c) => re.test(c.text)).map((c) => c.file).sort();
    expect(where(/from "@google\/genai"/)).toEqual(["src/lib/ai/gemini.ts"]);
    expect(where(/from "@anthropic-ai\/sdk/)).toEqual(["src/lib/ai/claude.ts", "src/lib/scoping/ai.ts"]);
    expect(where(/\.interactions\.create\(|models\.countTokens\(|:countTokens\b/)).toEqual(["src/lib/ai/gemini.ts"]);
    expect(where(/messages\.(create|countTokens|parse)\(/)).toEqual(["src/lib/ai/claude.ts", "src/lib/scoping/ai.ts"]);
    // The benchmark's ticket-free Gemini model stays with the frozen benchmark.
    expect(where(/\bgeminiModel\(|\bgeminiClient\(/)).toEqual(["scripts/benchmark-gemini.ts", "src/lib/ai/gemini.ts"]);
    // Missions and controls never contact anyone or fetch anything themselves (criterion 32).
    const quiet = code.filter((c) => c.file.startsWith("src/lib/missions/") || c.file.startsWith("src/lib/controls/"));
    expect(quiet.filter((c) => /\bnotify(Operators)?\(|from "\.\.\/db\/schema"[^;]*\boutbox\b|\bfetch\(/.test(c.text)).map((c) => c.file)).toEqual([]);
  });
});

describe("keys (criterion 33)", () => {
  const GEMINI = `AIza${"K".repeat(35)}`;
  const ANTHROPIC = `sk-ant-api03-${"Q".repeat(40)}`;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { g: process.env.GEMINI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    process.env.GEMINI_API_KEY = GEMINI;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  });
  afterEach(() => {
    if (saved.g === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.g;
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.a;
  });

  it("never reach the ledger, an error, a log or a desktop response", async () => {
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))));
    try {
      const w = await world();
      const m = await runningMission(w, scope({ maxCostMicros: 2_000_000 }));
      const leaky = fakeProvider({
        answer: () => {
          throw new ProviderError(`upstream said: key=${GEMINI} x-api-key: ${ANTHROPIC}`, "server", "yes", 500);
        },
      });
      const e = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), leaky, request(), signal()).catch((x) => x);
      const countLeak = fakeProvider({ countError: () => new Error(`count failed for ${GEMINI}`) });
      const r = await meteredRequest(w.db, ctxFor(m, await step(w.db, m.missionId)), countLeak, request(), signal()).catch((x) => x);
      const stored = JSON.stringify(await w.db.select().from(aiUsageLedger));
      const token = (await issueSessionToken(w.db, w.founder.id!)).token;
      const get = async (p: string[]) =>
        JSON.stringify(
          (await handleDesktopRequest(async () => w.db, { method: "GET", path: p, headers: new Headers({ host: "127.0.0.1:3000", authorization: `Bearer ${token}` }), json: async () => undefined }, { NODE_ENV: "test" })).body,
        );
      const responses = [await get(["ai", "spending"]), await get(["ai", "missions", m.missionId]), await get(["ai", "options"]), await get(["ai", "approvals"])];
      for (const text of [String((e as Error).message), String((r as Error).message), stored, ...responses, ...logged]) {
        expect(text).not.toContain(GEMINI);
        expect(text).not.toContain(ANTHROPIC);
      }
      expect(stored).toContain("[redacted]");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("test mode (criterion 18)", () => {
  it("allows its switches on in-memory databases and marked copies only", async () => {
    const memory = (await freshDb()).db;
    expect(testMode(memory, { KELQOR_SYNTHETIC_COSTS: "1", KELQOR_TEST_PAGES: SITES })).toMatchObject({ syntheticCosts: true });
    const dir = tmp("kelqor-copy-");
    const handle = openDb({ dataDir: dir });
    await handle.ready;
    try {
      expect(testMode(handle.db, {})).toEqual({ syntheticCosts: false, testPagesDir: null });
      expect(() => testMode(handle.db, { KELQOR_SYNTHETIC_COSTS: "1" })).toThrow(SpendRefused);
      expect(() => testMode(handle.db, { KELQOR_SYNTHETIC_COSTS: "true" })).toThrow(SpendRefused);
      expect(() => testMode(handle.db, { KELQOR_TEST_PAGES: SITES })).toThrow(SpendRefused);
      expect(() => assertTestDatabase(handle.db)).toThrow(SpendRefused);
      fs.writeFileSync(path.join(dir, ".kelqor-test-copy"), "The security reviewer test copy\n");
      expect(testMode(handle.db, { KELQOR_SYNTHETIC_COSTS: "1" }).syntheticCosts).toBe(true);
    } finally {
      await handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const url = openDb({ url: "postgres://nobody:nothing@127.0.0.1:1/none" });
    expect(() => testMode(url.db, { KELQOR_SYNTHETIC_COSTS: "1" })).toThrow(SpendRefused);
    await url.close();
    await memory.transaction(async (tx) => expect(() => assertTestDatabase(tx as unknown as DB)).toThrow(SpendRefused));
  });

  it("refuses copies in the project's .data folder, missing folders and unmarked ones", () => {
    expect(testCopyProblem(path.join(ROOT, ".data", "pglite"))).not.toBeNull();
    expect(testCopyProblem(path.join(ROOT, ".data"))).not.toBeNull();
    expect(testCopyProblem(path.join(os.tmpdir(), `missing-${rid()}`))).toMatch(/doesn't exist/);
    const dir = tmp("kelqor-unmarked-");
    expect(testCopyProblem(dir)).toMatch(/no \.kelqor-test-copy/);
    fs.writeFileSync(path.join(dir, ".kelqor-test-copy"), "x");
    expect(testCopyProblem(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses synthetic costs and clock overrides against a database that isn't a test one", async () => {
    const dir = tmp("kelqor-real-like-");
    const handle = openDb({ dataDir: dir });
    await handle.ready;
    try {
      const db = handle.db;
      const { operator } = await seedParties(db);
      await designateFounder(db, { email: operator.email!, password: TEST_PASSWORD });
      const m = { missionId: await insertMission(db, operator, scope({ provider: "synthetic" })), runId: "" };
      await approve(db, operator, m.missionId);
      m.runId = await startRun(db, m.missionId);
      const synthetic = syntheticProvider({ inner: simulatedResearcher("company_research", redeemTicket), model: "gemini-4-argon" });
      expect(await meteredRequest(db, ctxFor(m, await step(db, m.missionId)), synthetic, request(), signal()).catch((x) => (x as SpendRefused).reason)).toBe("test_only");
      expect(await meteredRequest(db, ctxFor(m, await step(db, m.missionId), new Date()), fakeProvider(), request(), signal()).catch((x) => (x as SpendRefused).reason)).toBe("test_only");
      await expect(approve(db, operator, m.missionId, new Date())).rejects.toBeInstanceOf(SpendRefused);
      await expect(spendingSummary(db, new Date())).rejects.toBeInstanceOf(SpendRefused);
      await expect(prepareTestCopy(db, { operatorEmail: "x@test.local", operatorPassword: "long-enough-pass", enableSignIn: [] })).rejects.toBeInstanceOf(SpendRefused);
      await expect(precommitSpending(db, { dayMicros: 1_000_000 })).rejects.toBeInstanceOf(SpendRefused);
      expect(await db.select().from(aiUsageLedger)).toHaveLength(0);
    } finally {
      await handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the acceptance run's synthetic usage and delay, and refuses nonsense", () => {
    const plan = syntheticPlanFromEnv({});
    expect(plan.count!(request(), 1)).toBe(30_000);
    expect(plan.usage!(request(), 1, 30_000)).toMatchObject({ input: 30_000, output: 15_000 });
    expect(syntheticPlanFromEnv({ KELQOR_SYNTHETIC_USAGE: "50000:2000", KELQOR_SYNTHETIC_DELAY_MS: "1500" }).delayMs!(1)).toBe(1_500);
    for (const bad of [{ KELQOR_SYNTHETIC_USAGE: "50000" }, { KELQOR_SYNTHETIC_USAGE: "0:10" }, { KELQOR_SYNTHETIC_USAGE: "1000:30000" }, { KELQOR_SYNTHETIC_DELAY_MS: "-5" }]) {
      expect(() => syntheticPlanFromEnv(bad)).toThrow();
    }
  });
});

describe("Claude scoping stays off (criterion 30)", () => {
  it("drafts from the template even with a key present, and calls nothing", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"Z".repeat(40)}`;
    try {
      expect(aiScopingConfigured()).toBe(false);
      const draft = await draftScope({ ...SAMPLE_INTAKE }, { useAi: true });
      expect(draft).toMatchObject({ source: "template", model: null, costMicros: 0 });
      expect(draft.aiError).toBeUndefined();
      expect(draft.scope.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(fetchCalls).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("missions end to end over the controls (criteria 7, 8, 9, 21, 32)", () => {
  it("runs a simulated mission to completion without contacting anyone or leaving the machine", async () => {
    const w = await world();
    const outboxBefore = (await w.db.select({ n: count() }).from(outbox))[0].n;
    const ex = executorFor(w.db, (s) => simulatedResearcher(s.type, redeemTicket));
    const d = await createMission(w.db, w.other, missionInput(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    await startMission(w.db, w.founder, d.id, rid(), ex);
    await ex.idle(d.id);
    const done = await getMission(w.db, w.founder, d.id);
    expect(["completed", "needs_review"]).toContain(done.status);
    expect(done.ledger.every((e) => e.simulated && e.committedMicros === 0)).toBe(true);
    expect((await w.db.select({ n: count() }).from(outbox))[0].n).toBe(outboxBefore);
    expect(fetchCalls).toBe(0);
    expect((await spendingSummary(w.db)).day.committedMicros).toBe(0);
  });

  it("starts a mission once, however many starts arrive at the same moment (criterion 7)", async () => {
    const w = await world();
    const ex = executorFor(w.db, (s) => simulatedResearcher(s.type, redeemTicket));
    const d = await createMission(w.db, w.other, missionInput(), rid());
    await submitMission(w.db, w.other, d.id, rid());
    await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
    const same = rid();
    const results = await Promise.allSettled([...Array.from({ length: 5 }, () => startMission(w.db, w.founder, d.id, rid(), ex)), startMission(w.db, w.founder, d.id, same, ex), startMission(w.db, w.founder, d.id, same, ex)]);
    await ex.idle(d.id);
    const runs = (await w.db.select().from(missionSteps).where(eq(missionSteps.missionId, d.id))).filter((s) => s.kind === "state" && s.summary === "running");
    expect(runs).toHaveLength(1);
    const ledger = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, d.id));
    expect(new Set(ledger.map((l) => l.stepId)).size * 2).toBe(ledger.length); // one count and one request per step, never twice
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });

  it("stops at the approval's maximum and at the Boise day's cap with synthetic costs (criteria 8, 9, 12)", async () => {
    const saved = process.env.KELQOR_SYNTHETIC_COSTS;
    process.env.KELQOR_SYNTHETIC_COSTS = "1";
    try {
      const w = await world();
      const plan = { count: () => 30_000, usage: () => ({ input: 30_000, output: 15_000, thinking: 0 }) };
      const ex = executorFor(w.db, (s) => syntheticProvider({ inner: simulatedResearcher(s.type, redeemTicket), model: s.model, plan }));
      const start = async (maxCostMicros: number) => {
        const d = await createMission(w.db, w.other, missionInput({ simulated: false, synthetic: true, maxCostMicros }), rid());
        await submitMission(w.db, w.other, d.id, rid());
        await approveMission(w.db, w.founder, d.id, { fingerprint: d.scopeFingerprint, requestId: rid() });
        return d.id;
      };
      // $0.40 allows one request ($0.21 settled); the next reservation ($0.27) doesn't fit.
      const small = await start(400_000);
      await startMission(w.db, w.founder, small, rid(), ex);
      await ex.idle(small);
      const s = await getMission(w.db, w.founder, small);
      expect(s.status).toBe("budget_blocked");
      expect(s.spend).toMatchObject({ committedMicros: 210_000, reservedMicros: 0 });
      // Today's $5: approved while it fits, then other spending leaves less than one request.
      const late = await start(1_000_000);
      await precommitSpending(w.db, { dayMicros: 4_900_000 });
      await startMission(w.db, w.founder, late, rid(), ex);
      await ex.idle(late);
      const l = await getMission(w.db, w.founder, late);
      expect(l.status).toBe("budget_blocked");
      expect(l.stateReason).toMatch(/today/);
      expect(l.ledger).toHaveLength(0); // refused before even counting
      expect((await spendingSummary(w.db)).day.committedMicros).toBeLessThanOrEqual(5_000_000);
    } finally {
      if (saved === undefined) delete process.env.KELQOR_SYNTHETIC_COSTS;
      else process.env.KELQOR_SYNTHETIC_COSTS = saved;
    }
  });

  it("makes a mission Interrupted when the backend restarts mid-request, counts the request unverified, and resumes nothing (criteria 14, 21)", async () => {
    const w = await world();
    const missionId = await insertMission(w.db, w.founder, scope({ provider: "synthetic", maxCostMicros: 1_000_000 }));
    await approve(w.db, w.founder, missionId);
    await w.db.update(missions).set({ status: "approved" }).where(eq(missions.id, missionId));
    const sent: number[] = [];
    const plan = { hang: () => true, onSend: (_r: unknown, n: number) => void sent.push(n) };
    const ex = executorFor(w.db, (s) => syntheticProvider({ inner: simulatedResearcher(s.type, redeemTicket), model: s.model, plan }));
    const runId = await startRun(w.db, missionId);
    ex.start(missionId, runId);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
    // The process "restarts": another backend instance recovers.
    const before = globalThis.__kelqorBackendInstance;
    globalThis.__kelqorBackendInstance = rid();
    try {
      expect(await recoverAtStartup(w.db)).toMatchObject({ interrupted: 1, unverified: 1 });
    } finally {
      globalThis.__kelqorBackendInstance = before;
    }
    ex.cancel(missionId); // the old process's request dies with it
    await ex.idle(missionId);
    const [m] = await w.db.select().from(missions).where(eq(missions.id, missionId));
    expect(m.status).toBe("interrupted");
    const rows = await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, missionId));
    const req = rows.find((r) => r.purpose === "research")!;
    expect(req).toMatchObject({ status: "unverified", errorKind: "interrupted", committedMicros: req.reservedMicros });
    await new Promise((r) => setTimeout(r, 200));
    expect(await w.db.select().from(aiUsageLedger).where(eq(aiUsageLedger.missionId, missionId))).toHaveLength(rows.length);
    expect(sent).toHaveLength(1);
    // Resuming needs the owner.
    await expect(resumeMission(w.db, w.other, missionId, rid(), ex)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the command-line tools", () => {
  async function copyWithAccounts(marked: boolean) {
    const dir = tmp("kelqor-acceptance-copy-");
    const handle = openDb({ dataDir: dir });
    await handle.ready;
    const db = handle.db;
    await createUserWithRole(db, { name: "Morgan (ForgeX ops)", email: "ops@forgex.local", password: SEED_DEMO_PASSWORD, role: "operator" }, { isDemo: true });
    await db.update(users).set({ signInDisabledAt: new Date() }).where(eq(users.email, "ops@forgex.local"));
    await createUserWithRole(db, { name: "Pat Owner", email: "pat.owner@real.test", password: TEST_PASSWORD, role: "operator" });
    await designateFounder(db, { email: "pat.owner@real.test", password: TEST_PASSWORD });
    await handle.close();
    if (marked) fs.writeFileSync(path.join(dir, ".kelqor-test-copy"), "acceptance copy\n");
    return dir;
  }

  it("prepare-test-copy designates the test operator, re-enables only the named sign-ins, precommits, and repeats safely", async () => {
    const dir = await copyWithAccounts(true);
    try {
      const args = ["scripts/prepare-test-copy.ts", "--dir", dir, "--operator-email", "owner@kelqor.test", "--operator-name", "Acceptance Owner", "--enable-sign-in", "ops@forgex.local", "--precommit-day", "4.80"];
      const env = { KELQOR_TEST_OPERATOR_PASSWORD: "acceptance-pass-123" };
      const first = await run(args, { env });
      expect(first.code, first.out).toBe(0);
      expect(first.out).not.toContain("acceptance-pass-123");
      expect((await run(args, { env })).code).toBe(0);
      const handle = openDb({ dataDir: dir });
      await handle.ready;
      try {
        const db = handle.db;
        expect(await founderAuthority(db)).toMatchObject({ email: "owner@kelqor.test", name: "Acceptance Owner" });
        const accounts = await db.select({ email: users.email, off: users.signInDisabledAt, demo: users.isDemo }).from(users);
        expect(accounts.find((a) => a.email === "ops@forgex.local")!.off).toBeNull();
        expect(accounts.find((a) => a.email === "owner@kelqor.test")).toMatchObject({ demo: false, off: null });
        expect(await authenticate(db, "owner@kelqor.test", "acceptance-pass-123")).toBeTruthy();
        expect((await spendingSummary(db)).day.committedMicros).toBe(4_800_000); // the second run added nothing
        const adjustments = await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.purpose, "adjustment"));
        expect(adjustments).toHaveLength(1);
        expect(adjustments[0]).toMatchObject({ provider: "synthetic", synthetic: true, status: "unverified" });
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("prepare-test-copy refuses an unmarked folder, the project's .data folder and a missing password, opening nothing", async () => {
    const dir = await copyWithAccounts(false);
    try {
      const env = { KELQOR_TEST_OPERATOR_PASSWORD: "acceptance-pass-123" };
      const unmarked = await run(["scripts/prepare-test-copy.ts", "--dir", dir, "--operator-email", "owner@kelqor.test"], { env });
      expect(unmarked.code).not.toBe(0);
      expect(unmarked.out).toMatch(/Refused/);
      // The project's own database folder (the owner's real database when this runs in the real project folder): refused before
      // anything is opened. Only file times are read here, to show nothing was written.
      const own = path.join(ROOT, ".data", "pglite");
      const existedBefore = fs.existsSync(own);
      const writtenBefore = newestWrite(own);
      const data = await run(["scripts/prepare-test-copy.ts", "--dir", own, "--operator-email", "owner@kelqor.test"], { env });
      expect(data.code).not.toBe(0);
      expect(data.out).toMatch(/Refused/);
      expect(fs.existsSync(own)).toBe(existedBefore);
      expect(newestWrite(own)).toBe(writtenBefore);
      fs.writeFileSync(path.join(dir, ".kelqor-test-copy"), "x");
      const noPassword = await run(["scripts/prepare-test-copy.ts", "--dir", dir, "--operator-email", "owner@kelqor.test"], { env: { KELQOR_TEST_OPERATOR_PASSWORD: "" } });
      expect(noPassword.code).not.toBe(0);
      const handle = openDb({ dataDir: dir });
      await handle.ready;
      expect((await founderAuthority(handle.db))?.email).toBe("pat.owner@real.test");
      await handle.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("designate-founder grants, refuses a wrong password, and revokes, reading the password from stdin", async () => {
    const dir = tmp("kelqor-designate-");
    try {
      const handle = openDb({ dataDir: dir });
      await handle.ready;
      await createUserWithRole(handle.db, { name: "Pat Owner", email: "pat.owner@real.test", password: TEST_PASSWORD, role: "operator" });
      await handle.close();
      const env = { PGLITE_DIR: dir, DATABASE_URL: "" };
      if (await port3000Busy()) {
        // A backend is running (an acceptance run, say): the command must refuse and change nothing.
        const refused = await run(["scripts/designate-founder.ts", "--email", "pat.owner@real.test"], { env, input: `${TEST_PASSWORD}\n` });
        expect(refused.code).not.toBe(0);
        expect(refused.out).toMatch(/local backend is running/);
        const unchanged = openDb({ dataDir: dir });
        await unchanged.ready;
        expect(await founderAuthority(unchanged.db)).toBeNull();
        await unchanged.close();
        return;
      }
      const wrong = await run(["scripts/designate-founder.ts", "--email", "pat.owner@real.test"], { env, input: "not-the-password\n" });
      expect(wrong.code).not.toBe(0);
      const ok = await run(["scripts/designate-founder.ts", "--email", "pat.owner@real.test"], { env, input: `${TEST_PASSWORD}\n` });
      expect(ok.code, ok.out).toBe(0);
      expect(ok.out).toMatch(/now holds owner spending authority/);
      expect(ok.out).not.toContain(TEST_PASSWORD);
      const check = openDb({ dataDir: dir });
      await check.ready;
      expect((await founderAuthority(check.db))?.email).toBe("pat.owner@real.test");
      await check.close();
      const revoked = await run(["scripts/designate-founder.ts", "--email", "pat.owner@real.test", "--revoke"], { env, input: `${TEST_PASSWORD}\n` });
      expect(revoked.code, revoked.out).toBe(0);
      const after = openDb({ dataDir: dir });
      await after.ready;
      expect(await founderAuthority(after.db)).toBeNull();
      await after.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
