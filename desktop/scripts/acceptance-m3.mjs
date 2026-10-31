// Milestone 3 acceptance checks, run by acceptance.mjs against the INSTALLED app on its isolated copy of the database.
// Engineering missions here use the simulated agent on KELQOR's demo workspace, which the backend creates beside the
// copy (never beside your own data). Claude Code is only checked for being gated: no real agent is started.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { js } from "./cdp.mjs";

const gitOut = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=NUL", ...args], { cwd, encoding: "utf8" }).trim();

export async function m3Acceptance(c) {
  const { app, check, until, go, api, out, sleep } = c;
  const bridge = (expr) => app.evaluate(`(async () => { const k = window.kelqor; ${expr} })()`);
  const detail = (id) => bridge(`return k.engMission("${id}");`);
  const waitFor = async (id, test, ms = 60_000) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      last = await detail(id);
      if (last.ok && test(last.data)) return last.data;
      await sleep(500);
    }
    return last?.ok ? last.data : null;
  };
  const click = async (selector, label) => {
    await until(app, js.exists(`${selector}:not([disabled])`), label, 20_000);
    await app.evaluate(js.click(selector));
  };

  await c.signInAs(app, c.founderEmail, c.founderPassword);
  await go(app, "engineering", '[data-testid="eng-status"]');
  check(3, "Engineering Missions opens in the Command Center", await app.evaluate(js.exists('[data-view="engineering"] [data-eng-tab="agents"]')));
  const o = await bridge("return k.engOverview();");
  const agent = (id) => o.data?.agents.find((a) => a.id === id);
  check(3, "the simulated agent is available and labeled simulated", agent("simulated")?.state === "connected" && agent("simulated")?.mode === "simulated", JSON.stringify(agent("simulated")));
  check(3, "Claude Code is shown as installed but not authorized, or not connected; never as running live", ["blocked", "disconnected"].includes(agent("claude_code")?.state), `${agent("claude_code")?.state}: ${agent("claude_code")?.detail}`);
  check(3, "Antigravity is a manual handoff, never an automated agent", agent("antigravity")?.mode === "manual", `${agent("antigravity")?.state}: ${agent("antigravity")?.detail}`);
  check(3, "Claude Code is also offered as a manual handoff, available now, beside the automated adapter that stays off", agent("claude_code_manual")?.mode === "manual" && agent("claude_code_manual")?.state === "connected" && agent("claude_code")?.mode === "automated", `${agent("claude_code_manual")?.state}: ${agent("claude_code_manual")?.detail}`);
  check(3, "live agent execution is off", o.data?.liveAgentExecution === false && (await app.evaluate(`document.querySelector('[data-testid="eng-live"]')?.innerText ?? ""`)).startsWith("Off"));
  await app.screenshot(path.join(out, "30-engineering-agents.png"));

  // The demo workspace, created beside the isolated copy.
  const demo = await bridge("return k.engDemoWorkspace();");
  check(3, "the owner sets up the demo workspace beside the isolated copy, not beside your data", demo.ok && demo.data.demo && /acceptance/i.test(demo.data.path) && !/\\\.data\\engineering/i.test(demo.data.path), demo.ok ? demo.data.path : demo.error);
  const headBefore = demo.ok ? gitOut(demo.data.path, "rev-parse", "HEAD") : null;

  // A mission drafted in the window's form, then submitted.
  await click('[data-eng-tab="new"]', "the New mission tab");
  await until(app, js.exists('[data-testid="eng-form"]'), "the mission form");
  const input = {
    title: "Add a repeat-customer discount",
    task: "Add a discount for repeat customers to the quote pricing, between 0 and 50%, never below a minimum, with tests.",
    deliverables: "discountedTotal() in src/pricing.js and its tests.",
    workspaceId: demo.data.id,
    agent: "simulated",
    permissions: { editFiles: true, checks: ["node-test"] },
  };
  const saved = await bridge(`const s = await k.engSaveMission(null, ${JSON.stringify(input)}, "${randomUUID()}"); if (!s.ok) return s; return k.engMissionAction(s.data.id, "submit", "${randomUUID()}", {});`);
  check(3, "a mission is drafted and submitted for approval", saved.ok && saved.data.status === "awaiting_approval", saved.ok ? saved.data.status : saved.error);
  const id = saved.data.id;
  const direct = await api("POST", `eng/missions/${id}/approve`, c.operatorToken, { requestId: randomUUID(), fingerprint: saved.data.scopeFingerprint });
  check(3, "another operator can't approve it, even at the backend directly", direct.status === 403, `${direct.status} ${direct.body.error ?? ""}`);

  // The owner approves and starts it from the window, and watches it.
  await click('[data-eng-tab="review"]', "the review tab");
  await click(`[data-eng-mission="${id}"]`, "the mission in the review list");
  await click('[data-action="eng-approve"]', "Approve");
  const approved = await waitFor(id, (m) => m.status === "approved", 20_000);
  check(3, "the owner approves exactly the scope shown", approved?.status === "approved" && approved.approval?.fingerprint === saved.data.scopeFingerprint);
  await click('[data-action="eng-start"]', "Start");
  const reviewed = await waitFor(id, (m) => m.status === "review" && !m.activity, 90_000);
  check(3, "the simulated agent runs in an isolated worktree and the mission reaches review", reviewed?.status === "review" && /worktrees/.test(reviewed.worktreePath ?? ""), reviewed ? `${reviewed.status}; ${reviewed.worktreePath}` : "no detail");
  const d = reviewed?.deliverable;
  check(3, "its deliverable lists the changed files and the diff", d?.files.length === 2 && d.files.some((f) => f.path === "test/discount.test.js") && d.diff.includes("discountedTotal"), JSON.stringify(d?.files ?? null));
  check(3, "KELQOR ran the approved check in the worktree, and the change is locally tested", d?.checks.length === 1 && d.checks[0].passed && reviewed.changeState === "tested", JSON.stringify(d?.checks?.map((x) => ({ label: x.label, passed: x.passed })) ?? null));
  check(3, "the work is labeled simulated and cost $0", reviewed?.simulated === true && reviewed.costSource === "simulated" && reviewed.costMicros === 0 && (await app.evaluate(`document.querySelector('[data-testid="eng-mission"]')?.innerText.includes("Simulated") ?? false`)));
  const log = (reviewed?.events ?? []).map((e) => e.kind);
  check(3, "the log keeps actions, states, activity, checks and the artifact", ["action", "state", "activity", "check", "artifact"].every((k) => log.includes(k)), log.join(","));
  check(3, "the workspace itself is untouched while the mission runs", demo.ok && gitOut(demo.data.path, "rev-parse", "HEAD") === headBefore && gitOut(demo.data.path, "status", "--porcelain") === "");
  // The window refreshes a running mission every two seconds, so wait for it to show the review before reading it.
  const treeShown = await until(app, `document.querySelector('[data-testid="eng-mission"]')?.innerText.includes(${JSON.stringify((d?.tree ?? "-").slice(0, 12))}) ?? false`, "the change's tree in the window", 15_000).then(() => true, () => false);
  check(3, "the review shows the change's tree, which is what was tested", /^[0-9a-f]{40}$/.test(d?.tree ?? "") && d.checkedTree === d.tree && treeShown, `${d?.tree}; checked ${d?.checkedTree}; shown ${treeShown}`);
  const unseen = await bridge(`return k.engMissionAction("${id}", "approve_change", "${randomUUID()}", { tree: "${"0".repeat(40)}" });`);
  check(3, "approving a change other than the one shown is refused", unseen.ok === false && /differs from the one you reviewed/.test(unseen.error ?? ""), unseen.error);
  await app.screenshot(path.join(out, "31-engineering-review.png"));

  // Review: the owner approves the change, then applies it to a new local branch.
  await click('[data-action="eng-approve_change"]', "Approve change");
  const ok = await waitFor(id, (m) => m.changeState === "founder_approved", 20_000);
  check(3, "the owner approves the change before anything is applied", ok?.changeState === "founder_approved");
  await click('[data-action="eng-apply"]', "Apply");
  const applied = await waitFor(id, (m) => m.status === "completed", 30_000);
  const branchCommit = applied?.appliedBranch ? gitOut(demo.data.path, "rev-parse", applied.appliedBranch) : null;
  check(3, "applying commits to a new local branch, and nothing else changes in the workspace", applied?.changeState === "applied" && branchCommit === applied.appliedCommit && gitOut(demo.data.path, "rev-parse", "HEAD") === headBefore && gitOut(demo.data.path, "status", "--porcelain") === "", applied ? `${applied.appliedBranch} ${applied.appliedCommit}` : "no detail");
  await app.screenshot(path.join(out, "32-engineering-applied.png"));

  // Workflow B: copy the assignment for a Claude conversation, paste the answer back as unverified evidence.
  await click('[data-action="eng-copy-assignment"]', "Copy assignment");
  const copiedNote = await until(app, `document.querySelector('[data-testid="eng-copied"]')?.innerText ?? false`, "the copy confirmation", 10_000).catch(() => null);
  const assignment = (await detail(id)).data?.assignment ?? "";
  check(3, "Copy assignment copies the full assignment (task, deliverables, rules, workspace) and starts nothing", /^Copied/.test(copiedNote ?? "") && ["## Task", "## Deliverables", "## Rules", "## Workspace"].every((h) => assignment.includes(h)), copiedNote);
  const beforeResponse = (await detail(id)).data;
  const fakeKey = `AIza${"Q".repeat(35)}`;
  // Pasted and saved through the window, as the owner would: the text box, then Save response.
  const pastedText = `Claude: I added discountedTotal() and all tests pass. Key ${fakeKey}`;
  await until(app, js.exists('[data-testid="eng-response-input"]'), "the response box", 15_000);
  await app.evaluate(`(() => { const el = document.querySelector('[data-testid="eng-response-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(el, ${JSON.stringify(pastedText)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('[data-action="eng-save-response"]', "Save response");
  await until(app, `(document.querySelector('[data-testid="eng-responses"]')?.innerText ?? "").includes("all tests pass")`, "the saved response", 15_000).catch(() => null);
  const response = await detail(id);
  const shownResponse = await until(app, `(() => { const t = document.querySelector('[data-testid="eng-responses"]')?.innerText ?? ""; return t.includes("Unverified") && t.includes("all tests pass") ? t : false; })()`, "the saved response", 15_000).catch(() => null);
  check(3, "a pasted response is shown as unverified evidence, with a possible secret removed", response.ok && response.data.responses.at(-1)?.redacted === true && !JSON.stringify(response.data).includes(fakeKey) && Boolean(shownResponse) && !shownResponse.includes(fakeKey), response.ok ? "saved" : response.error);
  check(3, "the pasted response changes nothing about the mission's state, change or approval", response.ok && response.data.status === beforeResponse.status && response.data.changeState === beforeResponse.changeState && response.data.appliedCommit === beforeResponse.appliedCommit && JSON.stringify(response.data.approval) === JSON.stringify(beforeResponse.approval));
  await app.screenshot(path.join(out, "33-engineering-claude-response.png"));

  // Cancelling a running mission makes it Interrupted, keeps its worktree and log, and starts nothing by itself.
  const slow = await bridge(`const s = await k.engSaveMission(null, ${JSON.stringify({ ...input, title: "Cancel check" })}, "${randomUUID()}"); if (!s.ok) return s; await k.engMissionAction(s.data.id, "submit", "${randomUUID()}", {}); const d = await k.engMission(s.data.id); await k.engMissionAction(s.data.id, "approve", "${randomUUID()}", { fingerprint: d.data.scopeFingerprint }); await k.engMissionAction(s.data.id, "start", "${randomUUID()}", {}); return k.engMissionAction(s.data.id, "cancel", "${randomUUID()}", {});`);
  await sleep(4000);
  const cancelled = slow.ok ? await detail(slow.data.id) : slow;
  check(3, "cancelling a running mission makes it Interrupted, keeps its log, and nothing resumes by itself", cancelled.ok && cancelled.data.status === "interrupted" && cancelled.data.events.some((e) => e.summary.startsWith("Cancelled")) && cancelled.data.allowed.resume, cancelled.ok ? `${cancelled.data.status}: ${cancelled.data.stateReason}` : cancelled.error);

  // Claude Code is gated: approvable, never startable while live execution is off.
  const repo = path.join(out, "m3-sample-repo");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "index.js"), "export const x = 1;\n");
  gitOut(repo, "init", "--initial-branch=main");
  gitOut(repo, "add", "-A");
  gitOut(repo, "-c", "user.name=acceptance", "-c", "user.email=acceptance@test.local", "commit", "-m", "init");
  const ws = await bridge(`return k.engAddWorkspace(${JSON.stringify({ name: "Acceptance sample repo", path: repo, baseBranch: "main" })});`);
  const cc = ws.ok
    ? await bridge(`const s = await k.engSaveMission(null, ${JSON.stringify({ ...input, title: "Claude Code gate check", workspaceId: ws.data.id, agent: "claude_code", permissions: { editFiles: true, checks: [] } })}, "${randomUUID()}"); if (!s.ok) return s; await k.engMissionAction(s.data.id, "submit", "${randomUUID()}", {}); const d = await k.engMission(s.data.id); await k.engMissionAction(s.data.id, "approve", "${randomUUID()}", { fingerprint: d.data.scopeFingerprint }); return k.engMissionAction(s.data.id, "start", "${randomUUID()}", {});`)
    : ws;
  check(3, "a Claude Code mission can be approved but not started while live agent execution is off", cc.ok === false && /isn't authorized|isn't available/.test(cc.error ?? ""), cc.error);
  const all = await bridge("return k.engOverview();");
  const real = (all.data?.missions ?? []).filter((m) => m.agent !== "simulated");
  check(3, "no real agent mission ever ran: none is running, in review or completed", real.length > 0 && real.every((m) => ["draft", "awaiting_approval", "approved"].includes(m.status) && m.costSource === "none"), real.map((m) => `${m.label} ${m.agent} ${m.status}`).join("; "));
  check(3, "nothing was pushed: the demo and sample repositories have no remote", demo.ok && gitOut(demo.data.path, "remote") === "" && gitOut(repo, "remote") === "");
  return app;
}
