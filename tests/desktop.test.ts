import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSessionToken } from "@/lib/auth/session";
import { getDb, type DB } from "@/lib/db";
import { events, opportunityDecisions, sessions } from "@/lib/db/schema";
import { handleDesktopRequest, type DesktopRequest } from "@/lib/desktop/api";
import { desktopApiBlocked, isLoopbackHost } from "@/lib/desktop/gate";
import { fixtureOf, salePath } from "@/lib/desktop/views";
import { watchDesktopApp } from "@/lib/desktop/watchdog";
import type { Actor } from "@/lib/domain/actor";
import { setOpportunityDecision } from "@/lib/domain/opportunities";
import { createWorkOrder } from "@/lib/domain/orders";
import { benchmarkRoot, DOSSIER_SOURCE, getDossier, listDossiers } from "@/lib/research/dossiers";
import { Backend } from "../desktop/src/main/backend";
import { findNode, LocalBackend, projectProblem } from "../desktop/src/main/local-backend";
import { isHttpUrl, isLoopbackUrl, isWebAppPath, resolveAppAsset } from "../desktop/src/main/security";
import { freshDb, SAMPLE_INTAKE, seedParties, TEST_PASSWORD } from "./helpers";

// The KELQOR desktop app's backend interface and the desktop main process's checks. No model is ever called.

let db: DB;
let close: () => Promise<void>;
let parties: { operator: Actor; client: Actor; builder: Actor };

const recordFiles = () => {
  const dir = path.join(benchmarkRoot(), DOSSIER_SOURCE.stage, DOSSIER_SOURCE.model);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
};
const fingerprint = () => recordFiles().map((f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex")).join(",");
let before: string;

beforeAll(async () => {
  before = fingerprint();
  const handle = await freshDb();
  db = handle.db;
  close = handle.close;
  parties = await seedParties(db);
});
afterAll(async () => {
  await close();
});

function req(method: string, route: string, opts: { token?: string; body?: unknown; host?: string } = {}): DesktopRequest {
  const headers = new Headers({ host: opts.host ?? "127.0.0.1:3000" });
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  return { method, path: route.split("/"), headers, json: async () => opts.body };
}
const call = (method: string, route: string, opts: { token?: string; body?: unknown; host?: string } = {}, env = { NODE_ENV: "test" }) =>
  handleDesktopRequest(async () => db, req(method, route, opts), env);
const data = <T>(res: { body: unknown }) => (res.body as { data: T }).data;
const signIn = async (email: string) => data<{ token: string }>(await call("POST", "session", { body: { email, password: TEST_PASSWORD } })).token;
const sessionCount = async () => (await db.select({ n: count() }).from(sessions))[0].n;

describe("desktop API access", () => {
  it("answers only on this computer, and never in production", async () => {
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
    expect(isLoopbackHost("192.168.1.20:3000")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
    expect(desktopApiBlocked({ NODE_ENV: "production" }, "127.0.0.1:3000")).not.toBeNull();
    expect((await call("GET", "me", { host: "evil.example.com" })).status).toBe(404);
    expect((await call("GET", "me", {}, { NODE_ENV: "production" })).status).toBe(404);
  });

  it("gives sessions to operators only, which work until revoked", async () => {
    const token = await signIn("ops@test.local");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data<{ role: string }>(await call("GET", "me", { token })).role).toBe("operator");

    const sessionsBefore = await sessionCount();
    expect((await call("POST", "session", { body: { email: "casey@acme.test", password: TEST_PASSWORD } })).status).toBe(403);
    expect((await call("POST", "session", { body: { email: "bao@builder.test", password: TEST_PASSWORD } })).status).toBe(403);
    expect(await sessionCount()).toBe(sessionsBefore); // no session is ever created for a client or builder
    const wrong = await call("POST", "session", { body: { email: "ops@test.local", password: "not-the-password" } });
    expect(wrong.status).toBe(403);
    expect((await call("POST", "session", { body: { email: "ops@test.local" } })).status).toBe(400);

    expect((await call("DELETE", "session", { token })).status).toBe(200);
    expect((await call("GET", "me", { token })).status).toBe(401);
  });

  it("refuses missing, malformed and unknown tokens, and other roles' web sessions", async () => {
    expect((await call("GET", "overview")).status).toBe(401);
    expect((await call("GET", "overview", { token: "short" })).status).toBe(401);
    expect((await call("GET", "overview", { token: randomBytes(32).toString("base64url") })).status).toBe(401);
    const { token } = await issueSessionToken(db, parties.client.id!);
    expect((await call("GET", "overview", { token })).status).toBe(403);
    expect((await call("GET", "nonsense", { token: await signIn("ops@test.local") })).status).toBe(404);
  });
});

describe("business data through the desktop API", () => {
  it("shows operators the existing orders and companies, shaped by the existing per-role views", async () => {
    const order = await createWorkOrder(db, parties.client, SAMPLE_INTAKE);
    const token = await signIn("ops@test.local");
    const list = data<{ id: string; ref: string; orgName: string; fixture: string | null }[]>(await call("GET", "orders", { token }));
    expect(list.map((o) => o.id)).toContain(order.id);
    expect(list.find((o) => o.id === order.id)).toMatchObject({ orgName: "Acme HVAC", fixture: null });

    const detail = data<{ order: { ref: string }; criteria: unknown[]; economics: unknown; webPath: string; nextStep: string }>(await call("GET", `orders/${order.id}`, { token }));
    expect(detail.criteria.length).toBeGreaterThan(0);
    expect(detail.webPath).toBe(`/orders/${order.id}`);
    expect(detail.nextStep).toMatch(/quote/);
    expect((await call("GET", `orders/${crypto.randomUUID()}`, { token })).status).toBe(404);

    const companies = data<{ name: string; contacts: { email: string }[]; orders: number }[]>(await call("GET", "companies", { token }));
    expect(companies.find((c) => c.name === "Acme HVAC")).toMatchObject({ orders: 1, contacts: [{ email: "casey@acme.test" }] });
  });

  it("labels demo and test records as fixtures from their explicit class, never from their names", () => {
    expect(fixtureOf("demo")).toBe("demo");
    expect(fixtureOf("test")).toBe("test");
    expect(fixtureOf("real")).toBeNull();
  });
});

describe("Opportunity Center", () => {
  it("reads the 25 saved Argon dossiers, with restricted runs marked", () => {
    const all = listDossiers();
    expect(all).toHaveLength(25);
    expect(all.filter((d) => d.category === "pursue now").map((d) => d.name)).toEqual(["Cornerstone Comfort", "Plumbing Solutions of Idaho"]);
    expect(all.filter((d) => d.access === "restricted").map((d) => d.id)).toEqual(["c03", "c10", "c20"]);
    expect(getDossier("c10")?.accessNote).toMatch(/Not fetched/);
  });

  it("labels each claim by its evidence and carries the independent review", () => {
    const d = getDossier("c13")!;
    const claims = d.claimSections.flatMap((s) => s.claims);
    expect(claims.length).toBeGreaterThan(10);
    for (const c of claims) {
      expect(["verified", "verified-in-details", "on-another-page", "not-confirmed", "inference", "hypothesis"]).toContain(c.evidence);
      if (c.evidence === "hypothesis") expect(c.label).toBe("hypothesis");
    }
    expect(claims.some((c) => c.evidence === "verified" && c.quote)).toBe(true);
    expect(d.review?.keyEvidence).toMatch(/yzzysservice/);
    expect(d.sources.every((s) => s.sha256 === null || /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
    // A quote the run-time check missed gets the review's verdict (Argon c18: a page title, cited as software evidence).
    expect(getDossier("c18")!.software.map((s) => s.evidence).find((c) => c.evidence === "not-confirmed")?.reviewNote).toMatch(/title/);
  });

  it("only opens ids in the cohort", async () => {
    expect(getDossier("../evaluation")).toBeNull();
    expect(getDossier("c99")).toBeNull();
    const token = await signIn("ops@test.local");
    expect((await call("GET", "opportunities/c99", { token })).status).toBe(404);
    expect((await call("GET", "opportunities/..%2F..%2Fsecrets", { token })).status).toBe(404);
  });

  it("saves, replaces and audits the owner's decision", async () => {
    const token = await signIn("ops@test.local");
    const first = await call("PUT", "opportunities/c05/decision", { token, body: { decision: "hold", note: "Ask about team size" } });
    expect(first.status).toBe(200);
    expect(data<{ decision: string }>(await call("GET", "opportunities/c05", { token }))).toMatchObject({ decision: { decision: "hold", note: "Ask about team size" } });
    await call("PUT", "opportunities/c05/decision", { token, body: { decision: "qualified" } });
    const rows = await db.select().from(opportunityDecisions).where(eq(opportunityDecisions.recordId, "c05"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "qualified", source: DOSSIER_SOURCE.id, companyName: "Crofts Electric" });
    const audit = await db.select().from(events).where(eq(events.type, "opportunity_decided"));
    expect(audit.map((e) => (e.data as { previous: string | null }).previous)).toEqual([null, "hold"]);
    const overview = data<{ opportunities: { byDecision: Record<string, number> } }>(await call("GET", "overview", { token }));
    expect(overview.opportunities.byDecision.qualified).toBe(1);

    expect((await call("PUT", "opportunities/c05/decision", { token, body: { decision: "maybe" } })).status).toBe(400);
    expect((await call("PUT", "opportunities/c99/decision", { token, body: { decision: "hold" } })).status).toBe(404);
    await expect(setOpportunityDecision(db, parties.client, { source: DOSSIER_SOURCE.id, recordId: "c05", companyName: "Crofts Electric", decision: "hold" })).rejects.toThrow(/operators/);
  });

  it("hands a qualified company to the existing sale page with its name and its own industry only", () => {
    const p = salePath("Boss Tool & Manufacturing, Inc.", "Manufacturing");
    expect(isWebAppPath(p)).toBe(true);
    const q = new URLSearchParams(p.split("?")[1]);
    expect(q.get("companyName")).toBe("Boss Tool & Manufacturing, Inc.");
    expect(q.get("industry")).toBe("Manufacturing");
    expect(new URLSearchParams(salePath("Somebody", "Not an industry").split("?")[1]).has("industry")).toBe(false); // never guessed
  });

  it("never writes to the frozen research records", () => {
    expect(fingerprint()).toBe(before);
  });
});

describe("the backend KELQOR starts and stops", () => {
  const token = randomBytes(32).toString("base64url");
  const shutdown = (env: { NODE_ENV: string; KELQOR_BACKEND_TOKEN?: string }, given?: string) => {
    const r = req("POST", "shutdown");
    if (given) r.headers.set("x-kelqor-backend-token", given);
    return handleDesktopRequest(async () => db, r, env);
  };

  it("closes its database only for the app that started it", async () => {
    expect((await shutdown({ NODE_ENV: "test" }, token)).status).toBe(404); // started by hand: no secret, no shutdown
    expect((await shutdown({ NODE_ENV: "test", KELQOR_BACKEND_TOKEN: token })).status).toBe(404);
    expect((await shutdown({ NODE_ENV: "test", KELQOR_BACKEND_TOKEN: token }, `${token.slice(0, -1)}x`)).status).toBe(404);
    expect((await shutdown({ NODE_ENV: "test", KELQOR_BACKEND_TOKEN: "short" }, "short")).status).toBe(404);
    const ok = await shutdown({ NODE_ENV: "test", KELQOR_BACKEND_TOKEN: token }, token);
    expect(ok.status).toBe(200);
    expect(data<{ databaseClosed: boolean }>(ok)).toEqual({ databaseClosed: false }); // the tests' database isn't the app's
    await expect(getDb()).rejects.toThrow(/stopping/); // and nothing reopens it before the process ends
  });

  it("starts one backend at a time, and none once KELQOR is exiting", async () => {
    let checks = 0;
    const local = (healthy: boolean) =>
      new LocalBackend({
        projectDir: path.join(process.cwd(), "no-such-folder"), // so nothing is ever spawned here
        port: 3999,
        origin: "http://127.0.0.1:3999",
        logFile: path.join(os.tmpdir(), "kelqor-test-backend.log"),
        autoStart: () => true,
        isHealthy: async () => (checks++, healthy),
        onChange: () => {},
      });
    const twice = local(false);
    await Promise.all([twice.start(), twice.start()]);
    expect(checks).toBe(1);
    expect(twice.info).toMatchObject({ state: "failed", managed: false });
    const found = local(true);
    await found.start();
    expect(found.info).toMatchObject({ state: "external", managed: false });
    const exiting = local(false);
    await exiting.close();
    await exiting.start();
    expect(checks).toBe(2); // the closed one never even looked
    expect(exiting.info.state).toBe("off");
  });

  it("stops a backend whose app has gone, and not before", async () => {
    expect(watchDesktopApp(undefined)).toBeNull();
    expect(watchDesktopApp("not a pid")).toBeNull();
    const pause = () => new Promise((r) => setTimeout(r, 60));
    let alive = true;
    let gone = 0;
    const stop = watchDesktopApp("4242", { isAlive: () => alive, onGone: () => void gone++, intervalMs: 5 });
    await pause();
    expect(gone).toBe(0);
    alive = false;
    await pause();
    expect(gone).toBe(1); // once: then it stops watching
    stop?.();
    // The real check, against this process and one that has ended.
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    const seen: string[] = [];
    const watches = [
      watchDesktopApp(String(process.pid), { onGone: () => void seen.push("this process"), intervalMs: 5 }),
      watchDesktopApp(String(ended), { onGone: () => void seen.push("ended"), intervalMs: 5 }),
    ];
    await pause();
    watches.forEach((w) => w?.());
    expect(seen).toEqual(["ended"]);
  });

  it("starts only this project's backend, with Node.js from the PATH", () => {
    expect(projectProblem(process.cwd())).toBeNull();
    expect(projectProblem(path.join(process.cwd(), "desktop"))).toMatch(/isn't the ForgeX project/);
    expect(projectProblem(path.join(process.cwd(), "no-such-folder"))).toMatch(/wasn't found/);
    const present = new Set([path.join("C:\\tools\\node", "node.exe")]);
    expect(findNode(["C:\\Windows", '"C:\\tools\\node"'].join(path.delimiter), (p) => present.has(p))).toBe(path.join("C:\\tools\\node", "node.exe"));
    expect(findNode("C:\\Windows", () => false)).toBeNull();
  });
});

describe("desktop main-process checks", () => {
  it("sends a sign-in that has lost its token back to the sign-in screen", async () => {
    let ended = 0;
    const backend = new Backend("http://127.0.0.1:3999", () => null, () => {}, () => void ended++);
    backend.status = { state: "connected", url: backend.url, checkedAt: null, error: null };
    expect(await backend.call("GET", "overview")).toMatchObject({ ok: false, signedOut: true });
    expect(ended).toBe(1);
  });

  it("talks to a backend on this computer only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://192.168.0.2:3000")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackUrl("http://user:pass@127.0.0.1:3000")).toBe(false);
    expect(isLoopbackUrl("file:///C:/Windows")).toBe(false);
  });

  it("serves only files inside the packaged interface", () => {
    const root = path.resolve("desktop/dist/renderer");
    expect(resolveAppAsset(root, "app://kelqor/index.html")).toBe(path.join(root, "index.html"));
    expect(resolveAppAsset(root, "app://kelqor/")).toBe(path.join(root, "index.html"));
    // Dot segments collapse at the origin's root, so they can't climb out of the folder...
    expect(resolveAppAsset(root, "app://kelqor/%2e%2e/main.cjs")).toBe(path.join(root, "main.cjs"));
    // ...and encoded backslashes, which a URL doesn't treat as separators, are refused once decoded.
    expect(resolveAppAsset(root, "app://kelqor/..%5C..%5Cpackage.json")).toBeNull();
    expect(resolveAppAsset(root, "app://evil/index.html")).toBeNull();
    expect(resolveAppAsset(root, "https://kelqor/index.html")).toBeNull();
  });

  it("opens only established web app pages and plain web addresses", () => {
    expect(isWebAppPath("/dashboard")).toBe(true);
    expect(isWebAppPath(`/orders/${crypto.randomUUID()}`)).toBe(true);
    expect(isWebAppPath("//evil.example.com")).toBe(false);
    expect(isWebAppPath("/ops/new?x=<script>")).toBe(false);
    expect(isWebAppPath("https://evil.example.com")).toBe(false);
    expect(isHttpUrl("https://www.cornerstonecomfort.net/")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isHttpUrl("ms-settings:privacy")).toBe(false);
  });
});
