// Milestone 2B acceptance checks, run by acceptance.mjs against the INSTALLED app on its isolated copy of the
// database. Every mission here is simulated ($0, no AI) or uses synthetic test costs, which the backend allows only on
// a copy marked .kelqor-test-copy; pages come from the local test pages in tests/fixtures/sites. No provider is called.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { js } from "./cdp.mjs";

const CREDENTIAL = /AIza[0-9A-Za-z_-]{35}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const COMPANY = { kind: "company", recordId: null, name: "Boise Fab & Weld", website: "https://www.boise-fab.test/", town: "Boise", state: "ID", industry: "Manufacturing" };
const FINAL = ["completed", "completed_with_issues", "needs_review", "failed", "cancelled", "rejected", "budget_blocked", "interrupted"];

export function missionInput(patch = {}) {
  return {
    type: "company_research",
    simulated: true,
    synthetic: false,
    purpose: "Acceptance run (simulated)",
    subject: COMPANY,
    model: "gemini-4-argon",
    thinkingLevel: "medium",
    maxCostMicros: 1_000_000,
    review: null,
    ...patch,
  };
}

export async function m2bAcceptance(c) {
  const { app, check, until, go, api, out, sleep } = c;
  const bridge = (expr) => app.evaluate(`(async () => { const k = window.kelqor; ${expr} })()`);
  const save = (input) => bridge(`return k.aiSaveMission(null, ${JSON.stringify(input)}, "${randomUUID()}");`);
  const act = (id, action, input = {}) => bridge(`return k.aiMissionAction("${id}", "${action}", "${randomUUID()}", ${JSON.stringify(input)});`);
  const detail = (id) => bridge(`return k.aiMission("${id}");`);
  const settle = async (id, ms = 90_000) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      last = await detail(id);
      if (last.ok && FINAL.includes(last.data.status) && !last.data.running) return last.data;
      await sleep(500);
    }
    return last?.ok ? last.data : null;
  };
  /** Draft, submit and (as the owner) approve a mission; returns its detail. */
  const approved = async (input) => {
    const m = await save(input);
    if (!m.ok) return m;
    await act(m.data.id, "submit");
    const d = await detail(m.data.id);
    return act(m.data.id, "approve", { fingerprint: d.data.scopeFingerprint, purpose: d.data.purpose });
  };

  // -- As the demo operator, who holds no spending authority ---------------------------------------------------------
  await go(app, "ai", '[data-testid="ai-status"]');
  check("2B", "AI Operations opens as the mission command center", await app.evaluate(js.exists('[data-view="ai"] [data-ai-tab="approvals"]')));
  const center = await bridge("return k.aiApprovals();");
  check("2B", "the designated owner is the acceptance's test owner, and the demo operator isn't", center.ok && center.data.founder?.email === c.founderEmail && center.data.isFounder === false, JSON.stringify(center.data?.founder ?? center));
  const caps = await bridge("return k.aiCapabilities();");
  check("2B", "Capabilities says what is working, simulated, unavailable or planned", caps.ok && caps.data.some((x) => x.state === "planned") && caps.data.some((x) => /M2C/.test(x.name)), `${caps.data?.length} entries`);
  await app.evaluate(js.click('[data-ai-tab="new"]'));
  await until(app, js.exists('[data-testid="mission-form"]'), "the mission form");
  await app.screenshot(path.join(out, "13-new-mission-form.png"));

  const draft = await save(missionInput());
  check("2B", "an operator drafts a company mission for a new company (criterion 1)", draft.ok && draft.data.status === "draft" && draft.data.simulated, draft.ok ? draft.data.label : draft.error);
  const id = draft.data.id;
  await act(id, "submit");
  const shown = (await detail(id)).data;
  const fingerprint = shown.scopeFingerprint;
  const byOperator = await act(id, "approve", { fingerprint, purpose: shown.purpose });
  check("2B", "another operator can't approve: only the owner can (criterion 4)", byOperator.ok === false, byOperator.error);
  const direct = await api("POST", `ai/missions/${id}/start`, c.operatorToken, { requestId: randomUUID() });
  check("2B", "an unapproved mission can't run, even through the backend directly (criterion 3)", direct.status >= 400 && (await detail(id)).data.status === "awaiting_approval", `${direct.status} ${direct.body.error}`);
  const demoSignIn = await api("POST", "session", null, { email: c.otherDemoEmail, password: c.seedPassword });
  check("2B", "a demo account whose sign-in wasn't turned back on can't sign in (criterion 4)", demoSignIn.status === 403 && /don't match an account/.test(demoSignIn.body.error ?? ""), demoSignIn.body.error);
  await app.evaluate(js.click('[data-ai-tab="approvals"]'));
  await until(app, js.exists(`[data-approval="${id}"]`), "the mission in the Approval Center");
  check("2B", "the Approval Center shows the mission, with Approve unavailable to a non-founder", await app.evaluate(`document.querySelector('[data-approval="${id}"] [data-action="approve-mission"]').disabled === true`));
  await app.screenshot(path.join(out, "14-approval-center-operator.png"));

  // -- As the owner ---------------------------------------------------------------------------------------------
  await c.signInAs(app, c.founderEmail, c.founderPassword);
  await go(app, "ai", '[data-testid="ai-status"]');
  await app.evaluate(js.click('[data-ai-tab="approvals"]'));
  await until(app, js.exists(`[data-approval="${id}"] [data-action="approve-mission"]:not([disabled])`), "Approve for the owner");
  await app.evaluate(js.click(`[data-approval="${id}"] [data-action="approve-mission"]`));
  await until(app, `window.kelqor.aiMission("${id}").then((r) => r.ok && r.data.status === "approved")`, "the approval");
  check("2B", "the owner approves exactly the scope shown", true);
  // Any change voids the approval and returns the mission to Draft (criterion 5).
  // A change to the approved scope (here its maximum) voids the approval and changes the fingerprint.
  const edited = await bridge(`return k.aiSaveMission("${id}", ${JSON.stringify(missionInput({ purpose: "Acceptance run, edited after approval", maxCostMicros: 900_000 }))}, "${randomUUID()}");`);
  const voided = edited.ok && edited.data.status === "awaiting_approval" && edited.data.approvals.every((a) => a.state !== "active");
  check("2B", "editing an approved mission voids its approval and returns it to Awaiting approval (criterion 5)", voided, edited.ok ? `${edited.data.status}; approvals ${edited.data.approvals.map((a) => a.state).join(", ")}` : edited.error);
  const stale = await act(id, "approve", { fingerprint, purpose: shown.purpose });
  check("2B", "an approval for the old scope is refused", stale.ok === false, stale.error);
  // The purpose isn't part of the scope fingerprint (it never reaches the model), so it is bound separately: a purpose
  // changed while the owner's window was open can't be approved unseen.
  const opened = (await detail(id)).data;
  const renamed = await bridge(`return k.aiSaveMission("${id}", ${JSON.stringify(missionInput({ purpose: "Acceptance run, purpose changed behind the window", maxCostMicros: 900_000 }))}, "${randomUUID()}");`);
  await act(id, "submit");
  const unseen = await act(id, "approve", { fingerprint: opened.scopeFingerprint, purpose: opened.purpose });
  check("2B", "an approval for a purpose the owner wasn't shown is refused, though the scope fingerprint is the same", renamed.ok && renamed.data.scopeFingerprint === opened.scopeFingerprint && unseen.ok === false && /purpose/.test(unseen.error ?? ""), unseen.error);
  const current = (await detail(id)).data;
  const again = await act(id, "approve", { fingerprint: current.scopeFingerprint, purpose: current.purpose });
  check("2B", "the edited scope can be approved again", again.ok && again.data.status === "approved");

  const before = (await bridge("return k.aiSpending();")).data.summary;
  // Start it from the window; a second start, a double click or another window can't start it again (criterion 7).
  await app.evaluate(js.click('[data-ai-tab="missions"]'));
  await until(app, js.exists(`[data-mission="${id}"]`), "the missions table");
  await app.evaluate(js.click(`[data-mission="${id}"]`));
  await until(app, js.exists('[data-action="mission-start"]'), "Start");
  const [first, second] = await bridge(`return Promise.all([k.aiMissionAction("${id}", "start", "${randomUUID()}", {}), k.aiMissionAction("${id}", "start", "${randomUUID()}", {})]);`);
  check("2B", "two starts at once start the mission once (criterion 7)", [first, second].filter((r) => r.ok).length === 1, JSON.stringify([first.ok, second.ok, second.error ?? first.error]));
  const done = await settle(id);
  check("2B", "the simulated company mission runs through the runner and completes (criteria 1, 6)", done?.status === "completed", done ? `${done.status}${done.stateReason ? `: ${done.stateReason}` : ""}` : "no answer");
  const runs = done?.steps.filter((s) => s.kind === "state" && s.summary === "running").length;
  check("2B", "it ran exactly once", runs === 1, `${runs} runs`);
  const facts = done?.result?.checks?.claims?.filter((x) => x.finalCategory === "verified_fact" && x.verdict === "found") ?? [];
  check("2B", "its claims were checked against the local test pages read in the mission (criterion 25)", facts.length > 0, `${facts.length} verified quotes`);
  check("2B", "every ledger row of a simulated mission is labeled simulated and costs $0 (criterion 18)", done?.ledger.length > 0 && done.ledger.every((l) => l.simulated && (l.actualMicros ?? 0) === 0 && l.reservedMicros === 0), `${done?.ledger.length} rows`);
  const after = (await bridge("return k.aiSpending();")).data.summary;
  check("2B", "simulated missions don't touch the budgets (criterion 18)", after.day.committedMicros === before.day.committedMicros && after.month.committedMicros === before.month.committedMicros);
  check("2B", "its page text is gone once it ended; fingerprints and quotes stay", done?.holdsPageText === false && done.result.sources.every((s) => s.textSha256 !== undefined));
  await app.evaluate(js.click('[data-ai-tab="missions"]'));
  await until(app, js.exists(`[data-mission="${id}"]`), "the missions table again");
  await app.evaluate(js.click(`[data-mission="${id}"]`));
  await until(app, js.exists('[data-testid="mission-results"]'), "the results");
  await app.screenshot(path.join(out, "15-simulated-company-mission.png"));

  // An industry mission reads only approved sources; Claude's proposed starter list isn't read (criteria 2, 24, 28).
  const sources = await bridge("return k.aiSources();");
  check("2B", "Claude's starter sources wait as proposed until approved (criterion 28)", sources.ok && sources.data.filter((s) => s.origin === "starter list v1").every((s) => s.status === "proposed"), `${sources.data?.length} sources`);
  const added = await bridge(`return k.aiAddSource({ name: "Industry Guide (local test pages)", match: "industry-guide.test", kind: "technical resource", industries: ["Manufacturing"], purpose: "Acceptance run" });`);
  check("2B", "the owner adds and approves a source", added.ok && added.data.status === "approved", added.ok ? added.data.status : added.error);
  const industry = await approved(missionInput({ type: "industry_research", subject: { kind: "industry", industry: "Manufacturing", category: "metal fabrication job shops", region: "Idaho" } }));
  check("2B", "an industry mission is set up and approved (criterion 2)", industry.ok && industry.data.status === "approved", industry.ok ? industry.data.label : industry.error);
  await act(industry.data.id, "start");
  const ind = await settle(industry.data.id);
  const read = ind?.result?.sources?.filter((s) => s.outcome === "ok").map((s) => new URL(s.finalUrl).hostname) ?? [];
  check("2B", "it read the approved source only (criterion 24)", ind?.status === "completed" && read.length > 0 && read.every((h) => h.endsWith("industry-guide.test")), `${ind?.status}; read ${read.join(", ")}`);
  const intel = await bridge("return k.aiIntelligence();");
  check("2B", "a simulated mission never becomes an industry record", intel.ok && intel.data.length === 0);

  // Claude review with the simulated reviewer: re-reads the cited pages and reports them (criterion 29).
  const reviewed = await approved(missionInput({ review: { provider: "simulation", model: "simulated", maxCostMicros: 500_000 } }));
  await act(reviewed.data.id, "start");
  const rev = await settle(reviewed.data.id);
  check("2B", "simulated Claude review runs end to end and reports the pages it read again (criterion 29)", rev?.status === "completed" && rev.result?.review?.finished === true && rev.result.review.reads.length > 0, rev ? `${rev.status}; ${rev.result?.review?.reads?.length} pages re-read` : "");

  // An existing company whose site isn't among the local test pages: the homepage can't be read, so nothing is sent.
  const c01 = await approved(missionInput({ subject: { ...COMPANY, recordId: "c01" } }));
  await act(c01.data.id, "start");
  const c01done = await settle(c01.data.id);
  check("2B", "a mission for an existing company ends in the right state when its site can't be read (criteria 1, 23)", c01done?.status === "failed" && /homepage/.test(c01done.stateReason ?? ""), c01done?.stateReason ?? "");

  // Nothing starts when KELQOR opens (criterion 6): this one stays Approved across the restart below.
  const waiting = await approved(missionInput({ purpose: "Approved, never started" }));

  // -- Synthetic test costs: the caps, cancellation, interruption and reconciliation ------------------------------
  const synthetic = (patch = {}) => missionInput({ simulated: false, synthetic: true, purpose: "Acceptance run (synthetic costs)", ...patch });
  const capped = await approved(synthetic({ maxCostMicros: 500_000 }));
  await act(capped.data.id, "start");
  const cappedDone = await settle(capped.data.id);
  check("2B", "the mission's own maximum stops the next request before it is sent (criteria 8, 12)", cappedDone?.status === "budget_blocked", cappedDone ? `${cappedDone.status}: ${cappedDone.stateReason}` : "");
  check("2B", "synthetic ledger rows are labeled synthetic", cappedDone?.ledger.every((l) => l.synthetic), `${cappedDone?.ledger.length} rows`);

  const cancelled = await approved(synthetic({ maxCostMicros: 2_000_000 }));
  await act(cancelled.data.id, "start");
  await until(app, `window.kelqor.aiMission("${cancelled.data.id}").then((r) => r.ok && r.data.ledger.some((l) => l.status === "reserved" && l.purpose !== "count"))`, "a request in flight", 30_000);
  const cancel = await act(cancelled.data.id, "cancel");
  const cancelDone = await settle(cancelled.data.id);
  const inFlight = cancelDone?.ledger.filter((l) => l.purpose !== "count").at(-1);
  check("2B", "cancelling stops the mission, and the request in flight is recorded as unverified (criterion 20)", cancel.ok && cancelDone?.status === "cancelled" && inFlight?.status === "unverified", `${cancelDone?.status}; last request ${inFlight?.status}`);

  const interrupted = await approved(synthetic({ maxCostMicros: 2_000_000 }));
  await act(interrupted.data.id, "start");
  await until(app, `window.kelqor.aiMission("${interrupted.data.id}").then((r) => r.ok && r.data.ledger.some((l) => l.status === "reserved" && l.purpose !== "count"))`, "a request in flight", 30_000);
  const relaunched = await c.forceRestart();
  c.app = relaunched;
  const app2 = relaunched;
  const bridge2 = (expr) => app2.evaluate(`(async () => { const k = window.kelqor; ${expr} })()`);
  const after2 = await bridge2(`return k.aiMission("${interrupted.data.id}");`);
  const unverified = after2.data?.ledger.filter((l) => l.status === "unverified") ?? [];
  check("2B", "closing KELQOR mid-request makes the mission Interrupted (criterion 21)", after2.ok && after2.data.status === "interrupted", after2.data?.stateReason ?? after2.error);
  check("2B", "the request in flight counts at its full reservation as unverified (criterion 14)", unverified.length > 0 && unverified.every((l) => l.committedMicros === l.reservedMicros), `${unverified.length} unverified`);
  await sleep(5000);
  const stillStopped = await bridge2(`return k.aiMission("${interrupted.data.id}");`);
  check("2B", "nothing resumes by itself, and the window shows the true state without resending (criteria 21, 22)", stillStopped.data?.status === "interrupted" && stillStopped.data.ledger.length === after2.data.ledger.length);
  const notStarted = await bridge2(`return k.aiMission("${waiting.data.id}");`);
  check("2B", "an approved mission doesn't start when KELQOR opens (criterion 6)", notStarted.data?.status === "approved");
  const resume = await bridge2(`return k.aiMissionAction("${interrupted.data.id}", "resume", "${randomUUID()}", {});`);
  const resumed = resume.ok ? await settleOn(app2, interrupted.data.id, sleep) : null;
  check("2B", "the owner resumes it from its saved step", resume.ok && ["completed", "budget_blocked"].includes(resumed?.status), resumed ? resumed.status : resume.error);

  // The $5 day cap, across missions (criterion 9). Approvals only check what is committed when they are given, so
  // several are approved first; run one after another, they reach the cap, and the next request isn't sent.
  const queued = [];
  for (let i = 0; i < 6; i++) {
    const m = await bridge2(`const s = await k.aiSaveMission(null, ${JSON.stringify(synthetic({ maxCostMicros: 2_000_000 }))}, "${randomUUID()}"); if (!s.ok) return s; await k.aiMissionAction(s.data.id, "submit", "${randomUUID()}", {}); const d = await k.aiMission(s.data.id); return k.aiMissionAction(s.data.id, "approve", "${randomUUID()}", { fingerprint: d.data.scopeFingerprint, purpose: d.data.purpose });`);
    if (m.ok) queued.push(m.data.id);
    else {
      check("2B", "approval refuses a maximum that no longer fits today's remaining budget (criterion 9)", /day/i.test(m.error ?? ""), m.error);
      break;
    }
  }
  // 0.2.3: the header is open while the missions below settle in the background, with no tab click.
  await go(app2, "ai", '[data-testid="ai-status"]');
  const headerBefore = await app2.evaluate(`document.querySelector('[data-testid="left-today"]')?.innerText ?? ""`);
  let dayBlocked = null;
  for (const qid of queued) {
    await bridge2(`return k.aiMissionAction("${qid}", "start", "${randomUUID()}", {});`);
    const r = await settleOn(app2, qid, sleep);
    if (r?.status === "budget_blocked" && /day/i.test(r.stateReason ?? "")) {
      dayBlocked = r;
      break;
    }
  }
  const day = (await bridge2("return k.aiSpending();")).data.summary.day;
  check("2B", "the $5 Boise day cap stops the next request before it is sent, across missions (criterion 9)", Boolean(dayBlocked) && day.committedMicros <= day.capMicros, dayBlocked ? `${dayBlocked.label}: ${dayBlocked.stateReason}; day committed ${day.committedMicros}` : `day committed ${day.committedMicros} after ${queued.length} missions`);
  const expectLeft = `$${(Math.max(0, day.capMicros - day.committedMicros) / 1e6).toFixed(2)}`;
  const headerNow = await until(app2, `(() => { const t = document.querySelector('[data-testid="left-today"]')?.innerText ?? ""; return t.startsWith(${JSON.stringify(expectLeft)}) ? t : false; })()`, "the header's remaining budget", 30_000).catch(() => null);
  check("0.2.3", "the header's remaining budget refreshes by itself as missions settle, with no tab click", Boolean(headerNow) && headerNow !== headerBefore, `before "${headerBefore}", now "${headerNow}", expected ${expectLeft}`);
  if (dayBlocked) {
    await app2.evaluate(js.click('[data-ai-tab="missions"]'));
    await until(app2, js.exists(`[data-mission="${dayBlocked.id}"]`), "the missions table");
    await app2.evaluate(js.click(`[data-mission="${dayBlocked.id}"]`));
    const label = await until(app2, `(() => { const t = document.querySelector('[data-view="ai"]')?.innerText ?? ""; return t.includes("Left of the $2.00 approved") && !t.includes("$2 mission limit") ? "ok" : false; })()`, "the approved-maximum label", 20_000).catch(() => null);
    check("0.2.3", 'a mission shows what is left of its approval as "Left of the $2.00 approved", not of "the $2 mission limit"', label === "ok");
  }
  await go(app2, "ai", '[data-testid="ai-status"]');
  await app2.evaluate(js.click('[data-ai-tab="spending"]'));
  await until(app2, js.exists('[data-testid="ledger"]'), "the ledger");
  await app2.screenshot(path.join(out, "16-spending-and-ledger.png"));

  // Reconciliation with no billing credentials (criterion 17).
  const month = day.period.slice(0, 7);
  const view = await bridge2(`return k.aiReconciliation("synthetic", "month", "${month}");`);
  const figure = await bridge2(`return k.aiRecordFigure({ provider: "synthetic", periodKind: "month", period: "${month}", providerMicros: ${Math.max(0, (view.data?.settledMicros ?? 0) + 1)}, note: "Acceptance run: an invented figure" });`);
  const latest = figure.data?.figures?.[0];
  const entry = figure.data?.unverified?.[0];
  const tooMuch = entry ? await bridge2(`return k.aiRelease({ figureId: "${latest.id}", entries: [{ ledgerId: "${entry.id}", micros: ${entry.reservedMicros * 10} }], note: "too much" });`) : { ok: false };
  const release = entry ? await bridge2(`return k.aiRelease({ figureId: "${latest.id}", entries: [{ ledgerId: "${entry.id}", micros: 1 }], note: "Acceptance run: release one micro-dollar" });`) : { ok: false, error: "no unverified entry" };
  check("2B", "a reconciliation needs your figure and note; a release never goes below what is settled, and is recorded (criterion 17)", figure.ok && tooMuch.ok === false && release.ok && release.data.history.some((h) => h.kind === "release"), `${figure.ok ? "figure recorded" : figure.error}; oversized release refused: ${tooMuch.ok === false}; release: ${release.ok ? "recorded" : release.error}`);

  // No key appears anywhere the window can read (criterion 33).
  const everything = await bridge2(`return JSON.stringify([await k.aiSpending(), await k.aiMissions(), await k.aiMission("${id}"), await k.aiCapabilities(), await k.aiApprovals()]);`);
  check("2B", "no API key appears in anything the window can read (criterion 33)", !CREDENTIAL.test(everything), `${everything.length} characters checked`);
  return app2;
}

async function settleOn(app, id, sleep, ms = 90_000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await app.evaluate(`window.kelqor.aiMission("${id}")`);
    if (last.ok && FINAL.includes(last.data.status) && !last.data.running) return last.data;
    await sleep(500);
  }
  return last?.ok ? last.data : null;
}
