import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designateFounder } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { createUserWithRole } from "@/lib/domain/accounts";
import { handleDesktopRequest } from "@/lib/desktop/api";
import type { EngMissionDetail } from "@/lib/engineering/contract";
import { engineeringExecutor } from "@/lib/engineering/executor";
import { freshDb, TEST_PASSWORD } from "./helpers";

// Milestone 3 integrated simulated acceptance at the backend: the whole engineering workflow driven through the same
// desktop API the window calls, as the operator and as the owner: create, approve, assign, execute, review the
// artifacts, apply and complete. The simulated agent works on the demo workspace in a temporary folder. The
// installed-app version of this run is desktop/scripts/acceptance-m3.mjs.

const ENG = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-m3-acc-"));
process.env.KELQOR_ENG_DIR = ENG;
process.env.KELQOR_SIM_AGENT_DELAY_MS = "5";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=NUL", ...args], { cwd, encoding: "utf8" }).trim();

let db: DB;
let close: () => Promise<void>;

beforeAll(async () => {
  const h = await freshDb();
  db = h.db;
  close = h.close;
  await createUserWithRole(db, { name: "Fran Owner", email: "fran@test.local", password: TEST_PASSWORD, role: "operator" });
  await designateFounder(db, { email: "fran@test.local", password: TEST_PASSWORD });
  await createUserWithRole(db, { name: "Oscar Operator", email: "oscar@test.local", password: TEST_PASSWORD, role: "operator" });
});

afterAll(async () => {
  await close();
  fs.rmSync(ENG, { recursive: true, force: true });
});

const req = (method: string, route: string, token: string | null, body?: unknown) => {
  const headers = new Headers({ host: "127.0.0.1:3000" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return handleDesktopRequest(async () => db, { method, path: route.split("/"), headers, json: async () => body }, { NODE_ENV: "test" });
};
const signIn = async (email: string) => ((await req("POST", "session", null, { email, password: TEST_PASSWORD })).body as { data: { token: string } }).data.token;
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;

describe("Engineering Missions, end to end through the desktop API (simulated)", () => {
  it("creates, approves, assigns, executes, reviews the artifacts, applies and completes a mission", async () => {
    const founder = await signIn("fran@test.local");
    const operator = await signIn("oscar@test.local");

    // The Command Center shows the agents; live agent execution is off.
    const overview = await req("GET", "eng", operator);
    expect(overview.status).toBe(200);
    const o = data<{ liveAgentExecution: boolean; agents: { id: string; mode: string }[] }>(overview);
    expect(o.liveAgentExecution).toBe(false);
    expect(o.agents.map((a) => `${a.id}:${a.mode}`)).toEqual(["simulated:simulated", "claude_code:automated", "antigravity:manual", "claude_code_manual:manual"]);

    // Only the owner sets up workspaces.
    expect((await req("POST", "eng/workspaces/demo", operator, {})).status).toBe(403);
    const demo = data<{ id: string; path: string; demo: boolean }>(await req("POST", "eng/workspaces/demo", founder, {}));
    expect(demo.demo).toBe(true);
    expect(demo.path.startsWith(ENG)).toBe(true);
    const head = git(demo.path, "rev-parse", "HEAD");

    // Creation and submission by an operator.
    const mission = { title: "Add a repeat-customer discount", task: "Add a discount for repeat customers to the quote pricing, with tests.", deliverables: "discountedTotal() and tests.", workspaceId: demo.id, agent: "simulated", permissions: { editFiles: true, checks: ["node-test"] } };
    const created = await req("POST", "eng/missions", operator, { mission, requestId: randomUUID() });
    expect(created.status).toBe(200);
    const id = data<EngMissionDetail>(created).id;
    expect(data<EngMissionDetail>(await req("POST", `eng/missions/${id}/submit`, operator, { requestId: randomUUID() })).status).toBe("awaiting_approval");

    // Approval: refused to the operator and to a stale fingerprint; given by the owner for the scope shown.
    const shown = data<EngMissionDetail>(await req("GET", `eng/missions/${id}`, founder));
    expect((await req("POST", `eng/missions/${id}/approve`, operator, { requestId: randomUUID(), fingerprint: shown.scopeFingerprint })).status).toBe(403);
    expect((await req("POST", `eng/missions/${id}/approve`, founder, { requestId: randomUUID(), fingerprint: "0".repeat(64) })).status).toBe(409);
    expect(data<EngMissionDetail>(await req("POST", `eng/missions/${id}/approve`, founder, { requestId: randomUUID(), fingerprint: shown.scopeFingerprint })).status).toBe("approved");

    // Assignment and execution: started by the owner only, once.
    expect((await req("POST", `eng/missions/${id}/start`, operator, { requestId: randomUUID() })).status).toBe(403);
    const start = randomUUID();
    const [a, b] = await Promise.all([req("POST", `eng/missions/${id}/start`, founder, { requestId: start }), req("POST", `eng/missions/${id}/start`, founder, { requestId: start })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await engineeringExecutor().idle(id);
    const reviewed = data<EngMissionDetail>(await req("GET", `eng/missions/${id}`, founder));
    expect(reviewed.events.filter((e) => e.kind === "state" && e.summary.startsWith("running"))).toHaveLength(1);
    expect(reviewed.status).toBe("review");

    // Artifact review: files, diff, check results, labels and cost.
    expect(reviewed.simulated).toBe(true);
    expect(reviewed.costSource).toBe("simulated");
    expect(reviewed.changeState).toBe("tested");
    expect(reviewed.deliverable!.files.map((f) => f.path).sort()).toEqual(["src/pricing.js", "test/discount.test.js"]);
    expect(reviewed.deliverable!.checks[0]).toMatchObject({ label: "node --test", passed: true });
    expect(reviewed.deliverable!.diff).toMatch(/\+export function discountedTotal/);
    expect(git(demo.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(demo.path, "status", "--porcelain")).toBe("");

    // Completion: the owner approves the change, applies it to a new local branch, and the mission completes.
    expect((await req("POST", `eng/missions/${id}/apply`, founder, { requestId: randomUUID() })).status).toBe(409);
    expect((await req("POST", `eng/missions/${id}/approve_change`, founder, { requestId: randomUUID(), tree: "0".repeat(40) })).status).toBe(409);
    expect(data<EngMissionDetail>(await req("POST", `eng/missions/${id}/approve_change`, founder, { requestId: randomUUID(), tree: reviewed.deliverable!.tree })).changeState).toBe("founder_approved");
    const applied = data<EngMissionDetail>(await req("POST", `eng/missions/${id}/apply`, founder, { requestId: randomUUID() }));
    expect(applied).toMatchObject({ status: "completed", changeState: "applied", appliedBranch: "kelqor/eng/e-0001" });
    expect(git(demo.path, "rev-parse", "kelqor/eng/e-0001")).toBe(applied.appliedCommit);
    expect(git(demo.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(demo.path, "status", "--porcelain")).toBe("");
    // Workflow B through the API: a pasted response is saved as evidence; an oversized one is refused.
    const withResponse = data<EngMissionDetail>(await req("POST", `eng/missions/${id}/add_response`, founder, { requestId: randomUUID(), response: "Claude says: done, tests pass." }));
    expect(withResponse.responses.map((r) => r.text)).toEqual(["Claude says: done, tests pass."]);
    expect(withResponse.status).toBe("completed");
    expect((await req("POST", `eng/missions/${id}/add_response`, founder, { requestId: randomUUID(), response: "x".repeat(50_000) })).status).toBe(400);
    // Nothing more can happen to a completed mission.
    for (const action of ["apply", "start", "approve_change", "resume"]) expect((await req("POST", `eng/missions/${id}/${action}`, founder, { requestId: randomUUID() })).status).toBe(409);
  });

  it("refuses no session, unknown actions and malformed input, never with a server error", async () => {
    const founder = await signIn("fran@test.local");
    expect((await req("GET", "eng", null)).status).toBe(401);
    expect((await req("POST", `eng/missions/${randomUUID()}/self_destruct`, founder, { requestId: randomUUID() })).status).toBe(404);
    expect((await req("POST", "eng/missions", founder, { mission: { title: "x" }, requestId: randomUUID() })).status).toBe(400);
    expect((await req("POST", "eng/workspaces", founder, { name: "Windows", path: "C:\\Windows", baseBranch: "main" })).status).toBe(400);
  });
});
