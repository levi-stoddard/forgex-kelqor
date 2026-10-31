// Acceptance run against the INSTALLED KELQOR app, driven through a local debugging port:
//   npm run desktop:acceptance
// Test 1: launch with the packaged interface; KELQOR starts its own local backend and stops it on exit.
// Tests 2-4: native capability and lockdown, business data, a decision that survives closing and reopening.
// Test 6: the backend failing while KELQOR is open (changes refused, then started again from the app), and KELQOR
// being ended by force (its backend then stops by itself).
// Test 2B (Milestone 2B, acceptance-m2b.mjs): missions, owner approvals, refusals, the caps with synthetic test
// costs, cancellation, interruption, recovery and reconciliation. Simulated and synthetic only: no AI provider is called.
// The copy is marked as a test copy, and a test owner with a generated password (never printed) is designated in it.
// The run never touches the owner's own data: KELQOR gets a data folder of its own and its backend a copy of the
// database, both under --out. Start with KELQOR closed and nothing on port 3000. Signs in as the seeded demo
// operator; the password comes from scripts/seed.ts (or SEED_PASSWORD) and is never printed. Screenshots and
// results go to --out (default desktop/out/acceptance/<version>). Ends only processes KELQOR started.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { m2bAcceptance, missionInput } from "./acceptance-m2b.mjs";
import { m3Acceptance } from "./acceptance-m3.mjs";
import { m4Acceptance } from "./acceptance-m4.mjs";
import { connect, js } from "./cdp.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "..");
const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
// --phone runs the customer portal on an emulated phone; --only m4 runs only the Milestone 4 checks (after setup).
const phone = args.includes("--phone");
const only = opt("--only", null);
const out = path.resolve(opt("--out", path.join(desktop, "out", "acceptance", phone ? `${version}-phone` : version)));
const exe = opt("--exe", path.join(process.env.LOCALAPPDATA ?? "", "kelqor", `app-${version}`, "KELQOR.exe"));
const PORT = 9333;
const BACKEND_PORT = 3000;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const OPERATOR = "ops@forgex.local";
const CLIENT = "riley@brightline.demo";
// Migration 0004 turns off demo sign-in; the run turns it back on for these two only, in its own copy.
const ENABLED_DEMO = [OPERATOR, CLIENT];
const OTHER_DEMO = "avery@ledgerwise.demo";
const FOUNDER = "owner@kelqor.test";
const founderPassword = randomBytes(18).toString("base64url");
const DECISION_RECORD = "c05";
// Unique per run, so test 4 always makes a fresh save that the database must then hold.
const NOTE = `Acceptance test 4 (Claude), run ${new Date().toISOString()}. Replace with your own decision.`;
// Everything window.kelqor offers (desktop/src/shared/bridge.ts): no IPC, shell, file or Node access among it.
const BRIDGE = [
  "addCheck", "addFigure", "aiAddSource", "aiApprovals", "aiCapabilities", "aiDecideSource", "aiEstimate", "aiIntelligence", "aiMarkReviewed",
  "aiMission", "aiMissionAction", "aiMissions", "aiOperations", "aiOptions", "aiReconciliation", "aiRecordFigure", "aiRelease", "aiResearch", "aiReviewEstimate",
  "aiSaveMission", "aiSources", "aiSpending", "aiUnblock", "checkBackend", "companies", "copyText", "custAddService", "custConfigure", "custCustomer", "custInvoice", "custInvoiceAction", "custOffboard", "custOnboard", "custOverview", "custRequest", "custReview", "custServiceAction", "custSubmit", "decide", "engAddWorkspace", "engDemoWorkspace", "engMission", "engMissionAction", "engOverview", "engSaveMission", "founderQueue", "onNavigate", "onStatus",
  "openSource", "openWebApp", "opportunities", "opportunity", "order", "orders", "overview", "recordCall", "setAutoStartBackend", "setCompanyClass",
  "setIndustry", "setNotifications", "setSolution", "signIn", "signOut", "startBackend", "status", "testNotification", "validateFigure",
].sort();
const password = process.env.SEED_PASSWORD || /const DEFAULT_PASSWORD = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "scripts/seed.ts"), "utf8"))[1];

fs.mkdirSync(out, { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(test, name, pass, detail = "") {
  results.push({ test, check: name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${test}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Windows processes: what KELQOR started, who listens on the backend's port, and whether a process still exists.
let kelqorPid = null;
function descendants(pid) {
  const list = JSON.parse(
    execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const found = new Map();
  const walk = (parent) => {
    for (const p of list) {
      if (p.ParentProcessId !== parent || p.ProcessId === parent || found.has(p.ProcessId)) continue;
      found.set(p.ProcessId, p);
      walk(p.ProcessId);
    }
  };
  walk(pid);
  return [...found.values()];
}
const backendProcesses = (pid) => descendants(pid).filter((p) => p.Name.toLowerCase() === "node.exe").map((p) => p.ProcessId);
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function ended(pids, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !alive(p))) return true;
    await sleep(250);
  }
  return false;
}
function listener() {
  for (const line of execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).split(/\r?\n/)) {
    const [proto, local, , state, pid] = line.trim().split(/\s+/);
    if (proto === "TCP" && local?.endsWith(`:${BACKEND_PORT}`) && state === "LISTENING") return Number(pid);
  }
  return null;
}
const portOpen = () =>
  new Promise((resolve) => {
    const socket = net.connect(BACKEND_PORT, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
async function portClosed(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portOpen())) return true;
    await sleep(250);
  }
  return false;
}
const kelqorRunning = () => execFileSync("tasklist", ["/FI", "IMAGENAME eq KELQOR.exe", "/NH"], { encoding: "utf8" }).includes("KELQOR.exe");

// The run's own KELQOR data folder (sign-in, settings) and database copy, replaced at the start of each run.
const profile = path.join(out, "profile");
const database = path.join(out, "database");
// KELQOR runs as if opened from the Start menu, without the environment of whatever runs this script: an AI coding
// agent's markers would reach the backend KELQOR starts, and Next.js then writes an AGENTS.md into the project.
const AGENT_MARKERS = /^(AI_AGENT|ANTIGRAVITY_AGENT|AUGMENT_AGENT|CLAUDECODE|CLAUDE_CODE.*|CODEX_.*|COPILOT_.*|CURSOR_.*|GEMINI_CLI|OPENCODE_CLIENT|REPL_ID)$/i;
const appEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !AGENT_MARKERS.test(name))),
  KELQOR_DATA_DIR: profile,
  PGLITE_DIR: database,
  // Test mode, which the backend allows only on this marked copy: local test pages and synthetic test costs.
  KELQOR_TEST_PAGES: path.join(root, "tests", "fixtures", "sites"),
  KELQOR_SYNTHETIC_COSTS: "1",
  KELQOR_SYNTHETIC_USAGE: "120000:15000",
  KELQOR_SYNTHETIC_DELAY_MS: "3000",
};
/** Marks the copy as a test copy, turns two demo sign-ins back on in it and designates the test owner there. */
function prepareCopy(extra = []) {
  fs.writeFileSync(path.join(database, ".kelqor-test-copy"), `Acceptance copy made ${new Date().toISOString()}; never the owner's database.\n`);
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  execFileSync(
    process.execPath,
    [tsx, "scripts/prepare-test-copy.ts", "--dir", database, "--operator-email", FOUNDER, "--operator-name", "Acceptance Owner", "--enable-sign-in", ENABLED_DEMO.join(","), ...extra],
    { cwd: root, env: { ...appEnv, KELQOR_TEST_OPERATOR_PASSWORD: founderPassword }, stdio: "pipe" },
  );
}

async function launch() {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: "ignore", env: appEnv });
  child.unref();
  kelqorPid = child.pid;
  return connect(PORT);
}

async function closeApp(app) {
  await app.evaluate("setTimeout(() => window.close(), 50), true").catch(() => {});
  app.close();
  // The app exits once it has stopped its backend.
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      await sleep(250);
    } catch {
      return true;
    }
  }
  return false;
}

/** Closes the app normally and checks that the backend it started went with it. */
async function closeAndCheck(app, when) {
  const pids = backendProcesses(kelqorPid);
  check(1, `app closes normally (${when})`, await closeApp(app));
  const closed = await portClosed(15_000);
  const gone = await ended(pids, 15_000);
  check(1, `exiting stops the backend KELQOR started and closes port 3000 (${when})`, pids.length > 0 && closed && gone, `${pids.length} backend processes, all ended: ${gone}; port 3000 closed: ${closed}`);
}

const until = (app, expr, label, ms) => app.waitFor(expr, label, ms);
const view = (app) => app.evaluate(`document.querySelector("[data-view]")?.dataset.view ?? (document.querySelector('[data-testid="sign-in"]') ? "sign-in" : "none")`);
const localBackend = async (app) => (await app.evaluate("window.kelqor.status()")).localBackend;
/** Waits until the backend KELQOR started answers (a first start compiles the app), and returns its state. */
async function backendUp(app, label) {
  await until(app, `window.kelqor.status().then((s) => s.localBackend.state === "running" && s.backend.state === "connected")`, label, 150_000);
  return localBackend(app);
}
const go = async (app, nav, sel) => {
  await app.evaluate(js.click(`[data-nav="${nav}"]`));
  await until(app, js.exists(sel), sel);
};
async function signIn(app, email, secret = password) {
  await until(app, js.exists('[data-testid="sign-in"]'), "sign-in form");
  await until(app, `document.querySelector('[data-testid="backend-state"]')?.dataset.state === "connected"`, "backend connected", 60_000);
  await app.evaluate(js.type("#email", email));
  await app.evaluate(js.type("#password", secret));
  await app.evaluate(js.click('button[type="submit"]'));
}
/** Signs out and back in as another account, through the window. */
async function signInAs(app, email, secret) {
  await app.evaluate("window.kelqor.signOut().then(() => true)");
  await signIn(app, email, secret);
  // KELQOR returns to the screen it was on, so wait for this account's sign-in and any view, not Headquarters.
  await until(app, `(async () => (await window.kelqor.status()).user?.email === ${JSON.stringify(email)} && Boolean(document.querySelector("[data-view]")))()`, `signed in as ${email}`, 60_000);
}
/** Ends KELQOR by force, as a crash or a closed laptop would, and opens it again. */
async function forceRestart() {
  const pids = [kelqorPid, ...backendProcesses(kelqorPid)];
  try {
    execFileSync("taskkill", ["/PID", String(kelqorPid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // As above: a process in the tree may already have exited.
  }
  await ended(pids, 20_000);
  await portClosed(20_000);
  await sleep(1500);
  const next = await launch();
  await backendUp(next, "the backend after the forced restart");
  await until(next, js.exists("[data-view]"), "a view after the forced restart", 60_000);
  return next;
}
async function api(method, route, token, body) {
  const res = await fetch(`${BACKEND}/api/desktop/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
async function openDossier(app, id) {
  await go(app, "opportunities", `[data-select-dossier="${id}"]`);
  await app.evaluate(js.click(`[data-select-dossier="${id}"]`));
  await until(app, js.exists(`[data-dossier="${id}"]`), `dossier ${id}`);
}
const savedDecision = (app) => app.evaluate(`document.querySelector("[data-saved-decision]")?.dataset.savedDecision`);

async function main() {
  // Start clean, so every backend seen here is one KELQOR started.
  const running = kelqorRunning();
  const busy = await portOpen();
  check("setup", "KELQOR is closed and port 3000 is free before the run", !running && !busy, JSON.stringify({ kelqorRunning: running, port3000InUse: busy }));
  if (running || busy) return;
  // With nothing running, the database can be copied whole; the run then signs in, saves and stops only on its own.
  const source = path.join(root, ".data", "pglite");
  // The copy's engineering folder (demo repository, worktrees) goes too: a fresh copy numbers missions from E-0001 again.
  for (const dir of [profile, database, `${database}-engineering`]) fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(source, database, { recursive: true });
  const entries = (dir) => fs.readdirSync(dir, { recursive: true }).length;
  check("setup", "the run uses its own KELQOR data folder and a copy of the database", entries(database) === entries(source), `data folder ${profile}; database ${database}`);
  try {
    prepareCopy();
    check("setup", "the copy is marked as a test copy and has a test owner", fs.existsSync(path.join(database, ".kelqor-test-copy")));
  } catch (e) {
    check("setup", "the copy is marked as a test copy and has a test owner", false, String(e.stderr ?? e.message).slice(0, 400));
    return;
  }

  // Test 1: the installed app launches with its own packaged interface and starts its own backend.
  check(1, "installed executable exists", fs.existsSync(exe), exe);
  let app = await launch();
  check(1, "window loads the packaged interface", app.url === "app://kelqor/index.html", app.url);
  const title = await until(app, `document.title === "KELQOR" ? document.title : false`, "the window title", 15_000).catch(() => app.evaluate("document.title"));
  check(1, "window title is KELQOR", title === "KELQOR", title);
  await until(app, `Boolean(document.querySelector("[data-view], [data-testid=sign-in], [data-testid=waiting-for-backend]"))`, "first screen");
  // A warm start can be ready before the window is; when it isn't, the wait is shown as a wait, not as errors.
  const startup = await app.evaluate(`({ starting: Boolean(document.querySelector('[data-testid="starting-banner"]')), pill: document.querySelector('[data-testid="backend-state"]')?.dataset.state, errors: document.body.innerText.includes("The local backend is unavailable") })`);
  if (startup.starting) {
    await app.screenshot(path.join(out, "00-starting-backend.png"));
    check(1, "while its backend starts, KELQOR says so instead of showing connection errors", startup.pill === "starting" && !startup.errors, JSON.stringify(startup));
  } else console.log("NOTE  the backend was ready before the first screen, so the starting screen wasn't seen");
  const started = await backendUp(app, "the backend KELQOR starts");
  check(1, "opening KELQOR starts the local backend", started.managed && (await portOpen()), `${started.state}, started by KELQOR: ${started.managed}, log ${started.logFile}`);
  if ((await view(app)) !== "sign-in") {
    await app.evaluate(js.click('[data-action="sign-out"]'));
    await until(app, js.exists('[data-testid="sign-in"]'), "sign-in after sign-out");
  }
  await app.screenshot(path.join(out, "01-sign-in.png"));
  if (only === "m4") {
    app = await m4Acceptance({ app, check, until, go, api, out, sleep, signInAs, founderEmail: FOUNDER, founderPassword, phone });
    await closeAndCheck(app, "at the end");
    return;
  }

  // Test 3 (access distinctions): a client account can't get into the Command Center.
  await signIn(app, CLIENT);
  await until(app, `document.querySelector('[data-testid="sign-in"] [class*="rose"]')?.innerText.includes("operators")`, "client refusal");
  check(3, "client account is refused by the desktop app", true, await app.evaluate(`document.querySelector('[data-testid="sign-in"] [class*="rose"]').innerText`));

  await signIn(app, OPERATOR);
  await until(app, js.exists('[data-view="overview"]'), "overview", 60_000);
  check(1, "operator signs in to the owner headquarters", true);
  await until(app, js.exists('[data-testid="overview-stats"]'), "overview stats");
  await app.screenshot(path.join(out, "02-headquarters.png"));

  // Test 2: lockdown of the window, then one native capability (Windows notifications).
  const probe = await app.evaluate(`(async () => {
    const r = {};
    r.require = typeof require; r.process = typeof process; r.module = typeof module; r.buffer = typeof Buffer;
    r.bridge = Object.keys(window.kelqor).sort();
    try { await fetch("${BACKEND}/api/health"); r.fetch = "allowed"; } catch (e) { r.fetch = "blocked"; }
    r.popup = window.open("https://example.com") === null ? "blocked" : "opened";
    r.webNotification = typeof Notification === "undefined" ? "absent" : await Notification.requestPermission();
    r.fileOpen = (await window.kelqor.openSource("file:///C:/Windows/System32/calc.exe")).ok;
    r.settingsOpen = (await window.kelqor.openSource("ms-settings:privacy")).ok;
    r.foreignWebApp = (await window.kelqor.openWebApp("https://evil.example.com/")).ok;
    r.badDecision = (await window.kelqor.decide("../evaluation", "hold", "")).ok;
    r.badSetting = (await window.kelqor.setAutoStartBackend("yes")).localBackend.autoStart;
    return r;
  })()`);
  check(2, "no Node.js in the window (require, process, module, Buffer)", [probe.require, probe.process, probe.module, probe.buffer].every((t) => t === "undefined"), JSON.stringify([probe.require, probe.process, probe.module, probe.buffer]));
  check(2, "window exposes only the fixed bridge", JSON.stringify(probe.bridge) === JSON.stringify(BRIDGE), probe.bridge.join(", "));
  check(2, "window can't reach the network directly", probe.fetch === "blocked");
  check(2, "pop-up windows are blocked", probe.popup === "blocked");
  check(2, "web notification permission is denied", probe.webNotification !== "granted", probe.webNotification);
  check(2, "file, settings and foreign addresses are refused", !probe.fileOpen && !probe.settingsOpen && !probe.foreignWebApp, JSON.stringify({ file: probe.fileOpen, settings: probe.settingsOpen, foreignWebApp: probe.foreignWebApp }));
  check(2, "malformed requests are refused", probe.badDecision === false && probe.badSetting === true, JSON.stringify({ decision: probe.badDecision, autoStartAfterBadValue: probe.badSetting }));
  await app.evaluate(`location.href = "https://example.com"; true`).catch(() => {});
  await sleep(800);
  check(2, "navigating away from the packaged interface is blocked", (await app.evaluate("location.href")) === "app://kelqor/index.html");

  await go(app, "settings", '[data-setting="notifications"]');
  if (!(await app.evaluate(`document.querySelector('[data-setting="notifications"]').checked`))) await app.evaluate(js.click('[data-setting="notifications"]'));
  await until(app, `!document.querySelector('[data-action="test-notification"]').disabled`, "notifications enabled");
  await app.evaluate(js.click('[data-action="test-notification"]'));
  const outcome = await until(app, `(() => { const o = document.querySelector('[data-testid="last-notification"]').dataset.outcome; return o === "shown" || o === "failed" ? o : false; })()`, "notification outcome", 15_000).catch(() => "timeout");
  check(2, "Windows shows the native notification", outcome === "shown", await app.evaluate(js.text('[data-testid="last-notification"]')));
  const card = await app.evaluate(`({ state: document.querySelector('[data-testid="local-backend-state"]')?.dataset.state, text: document.querySelector('[data-testid="local-backend-state"]')?.innerText, auto: document.querySelector('[data-setting="auto-start-backend"]')?.checked })`);
  check(1, "Settings shows the backend as started by KELQOR, with automatic start on", card.state === "running" && card.auto === true, `${card.text}; automatic start: ${card.auto}`);
  await app.screenshot(path.join(out, "03-settings.png"));

  // Test 3: existing business records through the backend's interface, with roles and fixtures intact.
  const session = await api("POST", "session", null, { email: OPERATOR, password });
  const token = session.body.data?.token;
  const orders = (await api("GET", "orders", token)).body.data ?? [];
  await go(app, "business", '[data-testid="orders-table"]');
  const shown = await app.evaluate(`[...document.querySelectorAll("[data-order]")].map((r) => r.dataset.order)`);
  check(3, "every work order in the business records is listed", shown.length === orders.length && orders.every((o) => shown.includes(o.id)), `${shown.length} of ${orders.length}`);
  const labels = await app.evaluate(`[...document.querySelectorAll("[data-fixture]")].map((e) => e.dataset.fixture)`);
  check(3, "demo and test records are labeled", labels.length === orders.filter((o) => o.fixture).length, labels.join(", "));
  await app.screenshot(path.join(out, "04-business.png"));
  const target = orders.find((o) => o.status === "delivered") ?? orders[0];
  await app.evaluate(js.click(`[data-order="${target.id}"]`));
  await until(app, js.exists('[data-testid="criteria"]'), "order detail");
  const detail = await app.evaluate(`({ title: document.querySelector("h1")?.innerText, cards: [...document.querySelectorAll("section h2")].map((h) => h.innerText), margin: document.body.innerText.includes("Gross margin") })`);
  check(3, "an order opens with its acceptance, delivery and payment status", ["Acceptance criteria", "Delivery", "Payments"].every((c) => detail.cards.includes(c)), `${target.ref}: ${detail.cards.join(", ")}`);
  check(3, "operator-only margin is shown to the operator", detail.margin);
  await app.screenshot(path.join(out, "05-order-detail.png"));
  const clientSession = await api("POST", "session", null, { email: CLIENT, password });
  check(3, "the backend refuses a client a desktop session", clientSession.status === 403, clientSession.body.error);

  // Test 4: a qualification decision is saved to the business database and survives closing the app (and with it
  // the backend).
  await openDossier(app, DECISION_RECORD);
  await app.evaluate(js.click('[data-choice="hold"]'));
  await app.evaluate(js.type("textarea", NOTE));
  await app.evaluate(js.click('[data-action="save-decision"]'));
  await until(app, `document.querySelector("[data-saved-decision]")?.dataset.savedDecision === "hold"`, "saved decision");
  await app.screenshot(path.join(out, "06-decision-saved.png"));
  check(4, `decision saved for ${DECISION_RECORD}`, true, await app.evaluate(js.text("[data-saved-decision]")));
  await closeAndCheck(app, "after the decision");
  await sleep(1500);
  app = await launch();
  await until(app, js.exists('[data-view="overview"]'), "overview after reopening", 60_000);
  check(1, "app reopens, still signed in", true);
  const reopenedBackend = await backendUp(app, "the backend after reopening");
  check(1, "reopening KELQOR starts the backend again", reopenedBackend.managed, `${reopenedBackend.state}, started by KELQOR: ${reopenedBackend.managed}`);
  await openDossier(app, DECISION_RECORD);
  const reopened = await savedDecision(app);
  check(4, "decision is still saved after reopening", reopened === "hold", reopened);
  const stored = (await api("GET", `opportunities/${DECISION_RECORD}`, token)).body.data?.decision;
  check(4, "decision is in the business database", stored?.decision === "hold" && stored?.note === NOTE, JSON.stringify(stored));
  await app.screenshot(path.join(out, "07-decision-after-reopen.png"));

  // Test 6: the backend fails while KELQOR is open. Changes are refused meanwhile, and the app can start it again.
  const pid = listener();
  const ours = pid !== null && descendants(kelqorPid).some((p) => p.ProcessId === pid);
  check(6, "the backend on port 3000 is the one KELQOR started", ours, `listening process ${pid}`);
  if (!ours) return; // never end a process KELQOR didn't start
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // taskkill reports an error when a process in the tree had already exited; the checks below confirm the stop.
  }
  await until(app, `document.querySelector('[data-testid="backend-state"]')?.dataset.state === "disconnected"`, "disconnected state", 30_000);
  const banner = await until(app, `(() => { const t = document.querySelector('[data-testid="offline-banner"]')?.innerText ?? ""; return t.includes("stopped unexpectedly") ? t : false; })()`, "the failure in the banner", 15_000).catch(() => null);
  check(6, "the app shows that the backend stopped", Boolean(banner), banner ?? "");
  check(6, `the ${DECISION_RECORD} dossier is still on screen`, await app.evaluate(js.exists(`[data-dossier="${DECISION_RECORD}"]`)));
  const ui = await app.evaluate(`({ choices: [...document.querySelectorAll("[data-choice]")].map((b) => b.disabled), save: document.querySelector('[data-action="save-decision"]')?.disabled })`);
  check(6, "decision controls are disabled while disconnected", ui.choices.length === 3 && ui.choices.every(Boolean) && ui.save === true, JSON.stringify(ui));
  const attempt = await app.evaluate(`window.kelqor.decide("${DECISION_RECORD}", "rejected", "should not save")`);
  check(6, "a direct change request is refused as offline", attempt.ok === false && attempt.offline === true, attempt.error);
  const reads = await app.evaluate(`window.kelqor.overview()`);
  check(6, "reads report the outage instead of stale data", reads.ok === false && reads.offline === true);
  check(6, "the app offers to start the backend again", await app.evaluate(js.exists('[data-action="start-backend"]')));
  await app.screenshot(path.join(out, "08-backend-stopped.png"));
  await app.evaluate(js.click('[data-action="start-backend"]'));
  const restarted = await backendUp(app, "the restarted backend");
  check(6, "Start the backend brings it back, started by KELQOR", restarted.managed, `${restarted.state}, started by KELQOR: ${restarted.managed}`);
  await openDossier(app, DECISION_RECORD);
  const decision = await savedDecision(app);
  check(6, "the refused offline change never reached the database", decision === "hold", decision);
  check(6, "decision controls are enabled again", await app.evaluate(`[...document.querySelectorAll("[data-choice]")].every((b) => !b.disabled)`));
  await app.screenshot(path.join(out, "09-backend-restarted.png"));

  // Test 6: KELQOR ended by force (as Task Manager can) gets no chance to stop its backend, so the backend stops itself.
  const forced = backendProcesses(kelqorPid);
  execFileSync("taskkill", ["/PID", String(kelqorPid), "/F"], { stdio: "ignore" }); // KELQOR alone, not its backend
  app.close();
  const forcedClosed = await portClosed(30_000);
  const forcedGone = await ended(forced, 15_000);
  check(6, "a force-closed KELQOR's backend stops by itself, closing port 3000", forced.length > 0 && forcedClosed && forcedGone, `${forced.length} backend processes, all ended: ${forcedGone}; port 3000 closed: ${forcedClosed}`);
  await sleep(1500);
  app = await launch();
  await until(app, js.exists('[data-view="overview"]'), "overview after the forced close", 60_000);
  const afterForced = await backendUp(app, "the backend after the forced close");
  check(6, "KELQOR starts its backend normally after a forced close", afterForced.managed, `${afterForced.state}, started by KELQOR: ${afterForced.managed}`);
  await openDossier(app, DECISION_RECORD);
  check(6, "the decision is intact after the forced close", (await savedDecision(app)) === "hold");

  // Milestone 2A, stabilization: every company carries an explicit class (migration 0003 classed the copy's existing
  // companies), and no test or demo money counts as real.
  const classes = await app.evaluate(`window.kelqor.companies().then((r) => r.ok ? r.data.map((c) => ({ name: c.name, dataClass: c.dataClass })) : null)`);
  check("2A", "every company has an explicit class", Array.isArray(classes) && classes.every((c) => ["real", "demo", "test"].includes(c.dataClass)), JSON.stringify(classes));
  check("2A", "the hand-made test companies are classed test, by the migration", classes?.filter((c) => /\(test\)$/i.test(c.name)).every((c) => c.dataClass === "test"));
  const money = await app.evaluate(`window.kelqor.overview().then((r) => r.ok ? r.data.money : null)`);
  check("2A", "no test or demo money counts as real", money?.collectedCents === 0 && money?.mrrCents === 0, JSON.stringify(money));
  await go(app, "business", '[data-testid="orders-table"]');
  await app.evaluate(js.click('[data-tab="companies"]')).catch(() => {});
  // Industry and evidence: a manufacturer is identified as one, and its research rating is labeled for what it was.
  await openDossier(app, "c01");
  const c01 = await app.evaluate(`({ industry: document.querySelector('[data-testid="industry-shown"]')?.innerText, frame: document.querySelector('[data-testid="research-frame"]')?.innerText, levels: [...document.querySelectorAll("[data-claim-level]")].map((e) => e.dataset.claimLevel) })`);
  check("2A", "a manufacturer is identified as manufacturing, not judged as a home-services company", /Manufacturing/.test(c01.industry ?? "") && /home-services segment/.test(c01.frame ?? ""), c01.industry);
  check("2A", "research statements carry evidence levels 1 to 3 only", c01.levels.length > 0 && c01.levels.every((l) => ["1", "2", "3"].includes(l)), `${c01.levels.length} statements`);
  await app.screenshot(path.join(out, "11-manufacturer-industry.png"));
  // The discovery workflow, through the window: a check, a conversation, a confirmed problem, its solution.
  await openDossier(app, "c22");
  check("2A", "Plumbing Solutions of Idaho starts unconfirmed", await app.evaluate(`document.querySelector('[data-testid="readiness"]')?.dataset.stage === "not_qualified"`));
  await app.evaluate(js.type("#check-statement", "LinkedIn lists 11-50 employees (acceptance check)"));
  await app.evaluate(js.type("#check-url", "https://www.linkedin.com/"));
  await app.evaluate(js.click('[data-action="add-check"]'));
  await until(app, `document.querySelectorAll("[data-check]").length === 1`, "the saved check");
  check("2A", "an owner check is saved with its source", true);
  const refused = await app.evaluate(`window.kelqor.recordCall("c22", { heldOn: "2026-10-27", contactName: "", contactRole: "", decisionMaker: "unknown", software: "", priorities: "", desiredOutcome: "", valueToThem: "", tried: "", pain: null, nextStep: "", notes: "x", answers: {}, problems: [], findings: [{ key: "identity.0", status: "confirmed" }] })`);
  check("2A", "company facts can't be marked customer-confirmed", refused.ok === false, refused.error);
  await app.evaluate(js.click('[data-action="new-call"]'));
  await until(app, js.exists('[data-testid="call-form"]'), "the conversation form");
  await app.evaluate(js.type("#call-name", "Sample Owner (acceptance)"));
  await app.evaluate(js.type("#call-role", "Owner"));
  await app.evaluate(js.select("#call-dm", "yes"));
  await app.evaluate(js.type('[data-question="time"]', "Re-keying web requests into ServiceTitan"));
  await app.evaluate(js.select('[data-finding="opportunityEvidence.2"]', "confirmed"));
  await app.evaluate(js.type('[data-raised="0"]', "Web requests wait in an inbox until someone retypes them"));
  await app.evaluate(js.type("#call-outcome", "Every web request reaches dispatch within 5 minutes"));
  await app.evaluate(js.type("#call-software", "ServiceTitan, QuickBooks"));
  await app.evaluate(js.click('[data-action="save-call"]'));
  await until(app, `document.querySelectorAll("[data-call]").length === 1`, "the saved conversation");
  const problems = await app.evaluate(`[...document.querySelectorAll("[data-problem]")].map((e) => ({ id: e.dataset.problem, origin: e.dataset.origin }))`);
  check("2A", "the conversation records a raised problem and a confirmed research finding", problems.length === 2 && problems.some((p) => p.origin === "customer") && problems.some((p) => p.origin === "research"), JSON.stringify(problems));
  const raisedId = problems.find((p) => p.origin === "customer")?.id;
  check("2A", "readiness moves to choosing a solution", await app.evaluate(`document.querySelector('[data-testid="readiness"]')?.dataset.stage === "choose_solution"`));
  await app.evaluate(js.select(`[data-solution-rung="${raisedId}"]`, "integration"));
  await app.evaluate(js.type(`[data-solution-text="${raisedId}"]`, "Send web form requests straight into ServiceTitan"));
  await app.evaluate(js.click(`[data-problem="${raisedId}"] [data-action="save-solution"]`));
  const draftPath = await until(app, `document.querySelector('[data-problem="${raisedId}"] [data-action="draft-work-order"]')?.dataset.path ?? false`, "the Work Order hand-off", 15_000).catch(() => null);
  check("2A", "a confirmed problem with a solution offers a Work Order draft, by ids only", typeof draftPath === "string" && /^\/ops\/new\?opportunity=c22&problem=[0-9a-f-]{36}$/.test(draftPath), draftPath ?? "");
  check("2A", "readiness reaches ready to propose", await app.evaluate(`document.querySelector('[data-testid="readiness"]')?.dataset.stage === "ready_to_propose"`));
  await app.screenshot(path.join(out, "12-discovery-workflow.png"));

  // Test 2B: Milestone 2B missions and their controls.
  app = await m2bAcceptance({
    app,
    check,
    until,
    go,
    api,
    out,
    sleep,
    signInAs,
    forceRestart,
    operatorToken: token,
    seedPassword: password,
    otherDemoEmail: OTHER_DEMO,
    founderEmail: FOUNDER,
    founderPassword,
  });
  // Test 3: Milestone 3 engineering missions, with the simulated agent on the demo workspace.
  app = await m3Acceptance({ app, check, until, go, api, out, sleep, signInAs, operatorToken: token, founderEmail: FOUNDER, founderPassword });
  // Test 4: Milestone 4 customer AI operations: the operator in the window, the customer in a headless browser.
  app = await m4Acceptance({ app, check, until, go, api, out, sleep, signInAs, operatorToken: token, founderEmail: FOUNDER, founderPassword, phone });
  await signInAs(app, OPERATOR, password);
  await api("DELETE", "session", token);
  await closeAndCheck(app, "after the forced close");

  // Test 1: the saved sign-in can't drift from the real one. A wrong saved name is corrected from the backend, and a
  // sign-in whose token is gone opens on the sign-in screen instead of pages that can't load.
  const settingsFile = path.join(profile, "settings.json");
  const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, user: { ...saved.user, name: "Someone Else" } }));
  await sleep(1500);
  app = await launch();
  await backendUp(app, "the backend for the name check");
  const shownAs = await until(app, `(() => { const n = document.querySelector("aside")?.innerText.match(/Signed in as (.+)/)?.[1]; return n && n !== "Someone Else" ? n : false; })()`, "the corrected name", 30_000).catch(() => "Someone Else");
  check(1, "the name shown comes from the backend, not a saved copy", shownAs === "Morgan (ForgeX ops)", shownAs);
  await openDossier(app, "c22");
  const kept = await app.evaluate(`({ calls: document.querySelectorAll("[data-call]").length, problems: document.querySelectorAll("[data-problem]").length, checks: document.querySelectorAll("[data-check]").length, stage: document.querySelector('[data-testid="readiness"]')?.dataset.stage })`);
  check("2A", "the discovery record is all still there after closing and reopening", kept.calls === 1 && kept.problems === 2 && kept.checks === 1 && kept.stage === "ready_to_propose", JSON.stringify(kept));
  await closeAndCheck(app, "after the name check");
  fs.rmSync(path.join(profile, "session.bin"), { force: true });
  await sleep(1500);
  app = await launch();
  await until(app, js.exists('[data-testid="sign-in"]'), "the sign-in screen", 30_000).catch(() => {});
  const lost = await app.evaluate(`(async () => ({ signInScreen: Boolean(document.querySelector('[data-testid="sign-in"]')), signedInAs: (await window.kelqor.status()).user?.email ?? null }))()`);
  check(1, "a sign-in that has lost its token opens on the sign-in screen", lost.signInScreen && lost.signedInAs === null, JSON.stringify(lost));
  await app.screenshot(path.join(out, "10-sign-in-after-lost-token.png"));
  await backendUp(app, "the backend before the month-cap phase");
  await closeAndCheck(app, "before the month-cap phase");

  // Test 2B, the $20 month cap: only one of the day and month caps can bind on one Boise day, so this phase starts
  // from a fresh copy whose month already holds $19.60 of synthetic spending (dated the 1st, never today).
  fs.rmSync(database, { recursive: true, force: true });
  fs.cpSync(source, database, { recursive: true });
  prepareCopy(["--precommit-month", "19.60"]);
  await sleep(1500);
  app = await launch();
  await backendUp(app, "the backend for the month-cap phase");
  await signIn(app, FOUNDER, founderPassword);
  await until(app, `(async () => (await window.kelqor.status()).user?.email === ${JSON.stringify(FOUNDER)} && Boolean(document.querySelector("[data-view]")))()`, "the owner signed in for the month-cap phase", 60_000);
  const month = await app.evaluate(`(async () => {
    const k = window.kelqor;
    const before = (await k.aiSpending()).data?.summary.month;
    const input = ${JSON.stringify(missionInput({ simulated: false, synthetic: true, purpose: "Acceptance run: month cap", maxCostMicros: 2_000_000 }))};
    const s = await k.aiSaveMission(null, input, crypto.randomUUID());
    if (!s.ok) return { error: s.error };
    await k.aiMissionAction(s.data.id, "submit", crypto.randomUUID(), {});
    const d = await k.aiMission(s.data.id);
    const a = await k.aiMissionAction(s.data.id, "approve", crypto.randomUUID(), { fingerprint: d.data.scopeFingerprint, purpose: d.data.purpose });
    return { remaining: before?.remainingMicros, approved: a.ok, error: a.error ?? null };
  })()`);
  check("2B", "the $20 Boise month cap refuses a mission that no longer fits this month (criterion 10)", month.approved === false && month.remaining === 400_000 && /month/i.test(month.error ?? ""), JSON.stringify(month));
  await go(app, "ai", '[data-testid="ai-status"]');
  await app.screenshot(path.join(out, "17-month-cap.png"));
  await closeAndCheck(app, "at the end");
}

try {
  await main();
} catch (e) {
  check("run", "acceptance run completed", false, e.message);
} finally {
  // After a failure, close a KELQOR this run opened the normal way, so it stops its backend.
  if (kelqorPid && alive(kelqorPid)) {
    try {
      execFileSync("taskkill", ["/PID", String(kelqorPid)], { stdio: "ignore" });
    } catch {
      // Already closing.
    }
  }
}
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ version, at: new Date().toISOString(), exe, results }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed} passed, ${failed} failed. Results: ${path.relative(root, path.join(out, "results.json"))}`);
process.exitCode = failed ? 1 : 0;
