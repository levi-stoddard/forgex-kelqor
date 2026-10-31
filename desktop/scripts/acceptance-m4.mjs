// Milestone 4 acceptance checks, run by acceptance.mjs against the INSTALLED app on its isolated copy of the database.
// KELQOR's side runs in the app window; the customer's side runs in a headless Microsoft Edge with a throwaway
// profile, pointed only at the app's local backend, so the customer portal is checked as a customer would use it.
// Every customer is synthetic, all processing is simulated, and invoices are simulated.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, js } from "./cdp.mjs";

const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const EDGE_PORT = 9334;
// The phone run (--phone): an iPhone-sized screen with touch, and taps instead of clicks.
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, mobile: true };
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// Shapes of real keys and secrets. A match is reported by its kind and file only, never its value.
const SECRET_SHAPES = {
  "Google API key": /AIza[0-9A-Za-z_-]{35}/,
  "Anthropic API key": /sk-ant-[0-9A-Za-z_-]{20,}/,
  "Stripe secret or restricted key": /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/,
  "Stripe webhook secret": /\bwhsec_[0-9A-Za-z]{16,}/,
  "private key": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  "database address with a password": /postgres(?:ql)?:\/\/[^\s:@/"']+:[^\s@/"']+@/,
};
// Fields only KELQOR's operators see (OperatorRequestView, customer costs): none may reach a customer's page.
const INTERNAL_FIELDS = ["draftHash", "reviewNote", "reviewMinutes", "reviewedBy", "aiCostMicros", "costSource", "marginCents", "reviewCostCents", "stateReason", "customerVisible"];
const INQUIRY = `Hi, this is Dana Ruiz from Ridgeline Builders (208-555-0199, dana@ridgeline.test).
We need 12 steel handrail brackets, 1/4" plate, powder coated black, for a deck job. Each is about 6 x 8 inches.
We need them by Nov 15. Can you quote?
Thanks,
Dana Ruiz`;

/** A headless Edge, driven like the app window. */
async function openBrowser(sleep, diagnostics, phone) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-portal-"));
  const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${EDGE_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: "ignore", detached: false });
  await sleep(1500);
  const page = await connect(EDGE_PORT, 30_000, (url) => url === "about:blank" || url.startsWith("http://127.0.0.1:3000") || url.startsWith("http://localhost:3000"));
  await page.send("Page.enable");
  // What the portal page did, for diagnosing a failed step: each navigation and why, loads, console errors, exceptions.
  // Kept in memory and written once, when the browser closes, so the run adds no writes of its own while pages load.
  const started = Date.now();
  const lines = [];
  const note = (line) => lines.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${line}`);
  page.onEvent((method, p) => {
    if (method === "Page.frameRequestedNavigation") note(`navigation requested (${p.reason}, ${p.disposition}) ${p.url}`);
    else if (method === "Page.frameNavigated" && !p.frame.parentId) note(`navigated ${p.frame.url}`);
    else if (method === "Page.loadEventFired") note("load");
    else if (method === "Runtime.exceptionThrown") note(`exception ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 400)}`);
    else if (method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(p.type)) note(`console.${p.type} ${p.args.map((x) => x.value ?? x.description).join(" ").slice(0, 400)}`);
    else if (method === "Log.entryAdded" && p.entry.level !== "verbose") note(`log.${p.entry.level} ${p.entry.text.slice(0, 300)} ${p.entry.url ?? ""}`);
    // The development server's update channel: what it tells the page, which is what makes a page reload itself.
    else if (method === "Network.webSocketCreated") note(`socket opened ${p.url}`);
    else if (method === "Network.webSocketFrameReceived") note(`socket said ${String(p.response.payloadData).slice(0, 200)}`);
    else if (method === "Network.webSocketFrameSent") note(`socket sent ${String(p.response.payloadData).slice(0, 200)}`);
  });
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  // The development server's update socket (/_next/hmr) can send "reloadPage: HMR hash mismatch" as soon as a page
  // connects while it rebuilds. The reload connects again, and the loop wiped what was typed (seen 2026-10-28 and -29;
  // Next.js 16.4.3). A production build never tells a page to reload itself, so the portal is checked the same way:
  // before any page script runs, that socket's "reloadPage" messages are dropped. The socket itself stays (the
  // development client needs it to hydrate), and everything it says is still in the diagnostics.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const Real = window.WebSocket;
      class NoForcedReload extends Real {
        set onmessage(handler) { super.onmessage = (e) => { if (typeof e.data === "string" && e.data.includes('"type":"reloadPage"')) return; handler(e); }; }
        get onmessage() { return super.onmessage; }
      }
      window.WebSocket = new Proxy(Real, { construct: (target, args) => (String(args[0]).includes("/_next/hmr") ? new NoForcedReload(...args) : new Real(...args)) });
    })();`,
  });
  await page.send("Network.enable");
  if (phone) {
    await page.send("Emulation.setDeviceMetricsOverride", PHONE);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setUserAgentOverride", { userAgent: PHONE_UA, platform: "iPhone" });
  }
  // Every page and script the portal served, for the cache and secrets checks.
  const responses = [];
  page.onEvent((method, p) => {
    if (method === "Network.responseReceived" && /^http:\/\/(127\.0\.0\.1|localhost):3000\//.test(p.response.url) && ["Document", "Script", "Fetch"].includes(p.type)) {
      responses.push({ type: p.type, url: p.response.url, status: p.response.status, cacheControl: p.response.headers["cache-control"] ?? p.response.headers["Cache-Control"] ?? "" });
    }
  });
  const go = async (url) => {
    await page.send("Page.navigate", { url });
    await sleep(800);
    await page.waitFor(`document.readyState === "complete"`, `the page ${url}`, 30_000);
  };
  const close = () => {
    fs.writeFileSync(diagnostics, `${lines.join("\n")}\n`);
    page.close();
    try {
      child.kill();
    } catch {
      // already gone
    }
    // Edge can hold its throwaway profile a little longer; a leftover temp folder isn't worth failing the run over.
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        console.log(`note: the browser's throwaway profile ${profile} is still in use and was left for Windows to clean up`);
      }
    }, 2000);
  };
  return { page, go, close, responses };
}

/**
 * Where the page stands at phone size: whether anything scrolls sideways, and for each control, whether a tap at its
 * centre reaches it (nothing covers it) and how big it is.
 */
const layout = (controls) => `(() => {
  const vw = window.innerWidth;
  const clipped = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return true; } return false; };
  const wide = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !clipped(el); }).slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
  const find = { ${Object.entries(controls).map(([n, e]) => `${JSON.stringify(n)}: () => ${e}`).join(", ")} };
  const reach = Object.fromEntries(Object.entries(find).map(([name, get]) => {
    const el = get();
    if (!el) return [name, { found: false }];
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return [name, { found: true, tappable: Boolean(hit && (hit === el || el.contains(hit))), inside: r.left >= -1 && r.right <= vw + 1, w: Math.round(r.width), h: Math.round(r.height) }];
  }));
  window.scrollTo(0, 0);
  return { viewport: vw, pageWidth: document.documentElement.scrollWidth, wide, reach };
})()`;
const fitsPhone = (l) => l.pageWidth <= l.viewport && Object.values(l.reach).every((c) => c.found && c.tappable && c.inside && c.h >= 24 && c.w >= 24);
const layoutNote = (l) => `width ${l.pageWidth}/${l.viewport}${l.wide.length ? ` (wide: ${l.wide.join(", ")})` : ""}; ` + Object.entries(l.reach).map(([n, c]) => (c.found ? `${n} ${c.w}×${c.h}${c.tappable ? "" : " covered"}${c.inside ? "" : " off-screen"}` : `${n} missing`)).join("; ");

/** True once React has attached itself to the element, so a submit goes through the page's own handler. */
const hydrated = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactProps"))); })()`;

/** Sets a form field the way typing does, so React and native forms both see it. */
const fill = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;

export async function m4Acceptance(c) {
  const { app, check, until, go, out, sleep } = c;
  const phone = Boolean(c.phone);
  const bridge = (expr) => app.evaluate(`(async () => { const k = window.kelqor; ${expr} })()`);
  const key = () => randomUUID();
  const password = `Portal-${randomUUID().slice(0, 12)}`;

  await c.signInAs(app, c.founderEmail, c.founderPassword);
  await go(app, "customers", '[data-view="customers"]');
  check(4, "Customer Operations opens in the Command Center", await app.evaluate(js.exists('[data-cust-tab="queue"]')));

  // Two synthetic customers, each with its own active service.
  const a = await bridge(`return k.custOnboard({ companyName: "Treasure Valley Fabrication (synthetic)", contactName: "Terry Valley", email: "terry@tvfab.test", industry: "Manufacturing", dataClass: "test" });`);
  const b = await bridge(`return k.custOnboard({ companyName: "Snake River Signs (synthetic)", contactName: "Sam River", email: "sam@srsigns.test", industry: "Signs", dataClass: "test" });`);
  check(4, "a synthetic customer is onboarded with a one-time invitation", a.ok && /\/invite\//.test(a.data.inviteUrl) && b.ok, a.ok ? a.data.inviteUrl.replace(/[^/]+$/, "…") : a.error);
  const svcA = await bridge(`const s = await k.custAddService({ orgId: "${a.data.orgId}", category: "quote_intake", planKey: "starter" }, "${key()}"); if (!s.ok) return s; await k.custConfigure(s.data.id, { customerApprovalAboveCents: 0 }, "${key()}"); return k.custServiceAction(s.data.id, "activate", "${key()}");`);
  const svcB = await bridge(`const s = await k.custAddService({ orgId: "${b.data.orgId}", category: "support_assistance", planKey: "pilot" }, "${key()}"); if (!s.ok) return s; return k.custServiceAction(s.data.id, "activate", "${key()}");`);
  check(4, "KELQOR configures and activates a managed service for each customer, with the plan's terms copied into the agreement", svcA.ok && svcA.data.status === "active" && svcA.data.config.customerApprovalAboveCents === 0 && Boolean(svcA.data.agreementStartedAt) && svcB.ok, svcA.ok ? `${svcA.data.name}: ${svcA.data.status}` : svcA.error);
  const bReq = await bridge(`return k.custSubmit({ serviceId: "${svcB.data.id}", text: "A customer of Snake River Signs asks whether we install signs in Nampa." }, "${key()}");`);

  if (!EDGE) {
    check(4, "Microsoft Edge is available to check the customer portal", false, "msedge.exe not found");
    return app;
  }
  // The portal is used at the invitation link's own address, so the sign-in cookie it sets is the one sent after.
  const portal = new URL(a.data.inviteUrl).origin;
  const browser = await openBrowser(sleep, path.join(out, "portal-browser.log"), phone);
  const { page } = browser;
  // A tap on a phone, a click otherwise. `expr` finds the element in the page.
  const press = async (expr) => {
    if (!phone) return page.evaluate(`(${expr}).click()`);
    const at = await page.evaluate(`(() => { const el = ${expr}; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await sleep(200);
    // A finger down and up at the control's centre (headless Edge ignores Input.synthesizeTapGesture).
    await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const fitCheck = async (where, controls) => {
    if (!phone) return;
    const l = await page.evaluate(layout(controls));
    check("4P", `on a phone, ${where} fits the screen and its controls can be tapped`, fitsPhone(l), layoutNote(l));
  };
  try {
    // Signed out, the portal sends a visitor to sign-in and shows nothing of a customer.
    await browser.go(`${portal}/services`);
    const signedOut = await page.evaluate(`({ path: location.pathname, text: document.body.innerText })`);
    check("4S", "a signed-out visitor to the customer portal is sent to sign-in", signedOut.path === "/login" && !/treasure valley/i.test(signedOut.text), signedOut.path);
    // The customer accepts the invitation and lands in its own Command Center.
    await browser.go(a.data.inviteUrl);
    // The invitation's action signs the customer in and then redirects. In development the page can reload while it
    // compiles, clearing what was typed, so fill, confirm the values held, submit and wait for the redirect, up to
    // three times.
    let accepted = null;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      await page.waitFor(hydrated("form"), "the invitation form to be ready", 60_000).catch(() => null);
      await page.evaluate(fill("#password", password));
      await page.evaluate(fill("#confirm", password));
      await sleep(500);
      const held = await page.evaluate(`document.querySelector("#password")?.value === ${JSON.stringify(password)} && document.querySelector("#confirm")?.value === ${JSON.stringify(password)}`).catch(() => false);
      if (!held) continue;
      if (attempt === 0) await fitCheck("the invitation page", { password: `document.querySelector("#password")`, submit: `document.querySelector('#password').form.querySelector('button[type="submit"]')` });
      await press(`document.querySelector('#password').form.querySelector('button[type="submit"]')`);
      accepted = await page.waitFor(`location.pathname.startsWith("/invite/") ? false : location.pathname`, "the invitation to be accepted", 45_000).catch(() => null);
    }
    if (!accepted) await page.screenshot(path.join(out, "40a-invitation-not-accepted.png"));
    await browser.go(`${portal}/services`);
    const cc = await page.waitFor(`document.querySelector('[data-testid="customer-command-center"]')?.innerText ?? false`, "the customer's Command Center", 30_000).catch(() => "");
    check(4, "the customer signs in from its invitation and sees its own Command Center", /treasure valley fabrication/i.test(cc) && /quote and inquiry intake/i.test(cc), accepted ? cc.slice(0, 120) : "the invitation wasn't accepted");
    check(4, "the customer sees nothing of another customer", !/snake river|nampa/i.test(cc));
    const header = await page.evaluate(`[...document.querySelectorAll("header a")].map((a) => a.getAttribute("href"))`);
    check(4, "the customer's header leads to its managed services, not the older marketplace pages", header.includes("/services") && header.includes("/services/new") && !header.some((h) => h === "/dashboard" || h.startsWith("/orders")), header.join(" "));
    await page.screenshot(path.join(out, "40-customer-command-center.png"));
    const cookies = (await page.send("Network.getCookies", { urls: [portal] })).cookies;
    const session = cookies.find((k) => k.name === "fx_session");
    const scriptSees = await page.evaluate(`document.cookie.includes("fx_session")`);
    // Secure is required wherever the portal isn't on this computer (production builds set it).
    const loopback = ["localhost", "127.0.0.1"].includes(new URL(portal).hostname);
    check("4S", "the customer's sign-in cookie can't be read by page scripts and isn't sent by other sites", Boolean(session) && session.httpOnly && session.sameSite === "Lax" && !scriptSees && (loopback || session.secure), session ? `httpOnly ${session.httpOnly}, SameSite ${session.sameSite}, Secure ${session.secure} (Secure is set by production builds only)` : "no session cookie");
    if (phone) {
      await fitCheck("the customer's Command Center", {
        "send a request": `document.querySelector('a[href^="/services/new?service="]')`,
        "monthly report": `document.querySelector('a[href="/services/report"]')`,
        "sign out": `[...document.querySelectorAll("header button")].find((b) => b.innerText.trim() === "Sign out")`,
      });
      await press(`document.querySelector('a[href="/services/report"]')`);
      const navigated = await page.waitFor(`location.pathname === "/services/report" && Boolean(document.querySelector('[data-testid="customer-report"]'))`, "the report after a tap", 30_000).catch(() => false);
      await press(`[...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/services" && !a.closest("header"))`).catch(() => null);
      const back = await page.waitFor(`location.pathname === "/services" && Boolean(document.querySelector('[data-testid="customer-command-center"]'))`, "the Command Center after a tap", 30_000).catch(() => false);
      check("4P", "on a phone, tapping through the portal reaches the report and back to the Command Center", navigated === true && back === true, `report: ${navigated}, back: ${back}`);
    }

    // The customer sends a quote request; KELQOR processes it (simulated) and holds it for review.
    await browser.go(`${portal}/services/new?service=${svcA.data.id}`);
    let requestUrl = null;
    for (let attempt = 0; attempt < 3 && !requestUrl; attempt++) {
      await page.waitFor(hydrated("form"), "the request form to be ready", 60_000).catch(() => null);
      await page.evaluate(fill("#from", "Dana Ruiz, Ridgeline Builders"));
      await page.evaluate(fill("#text", INQUIRY));
      await sleep(500);
      const held = await page.evaluate(`document.querySelector("#text")?.value === ${JSON.stringify(INQUIRY)}`).catch(() => false);
      if (!held) continue;
      if (attempt === 0) await fitCheck("the request form", { service: `document.querySelector("#serviceId")`, message: `document.querySelector("#text")`, send: `document.querySelector('#text').form.querySelector('button[type="submit"]')` });
      await press(`document.querySelector('#text').form.querySelector('button[type="submit"]')`);
      requestUrl = await page.waitFor(`location.pathname.startsWith("/services/requests/") ? location.pathname : false`, "the request page", 45_000).catch(() => null);
    }
    if (!requestUrl) await page.screenshot(path.join(out, "40b-request-form-not-sent.png"));
    const formNote = requestUrl ? "" : await page.evaluate(`location.pathname + " · " + (document.querySelector('[role="alert"], [data-testid="form-message"]')?.innerText ?? document.body.innerText.slice(0, 160))`);
    const requestId = requestUrl?.split("/").pop();
    const pending = requestId ? await page.waitFor(`document.querySelector('[data-testid="customer-request"]')?.dataset.status ?? false`, "the request status", 15_000).catch(() => null) : null;
    const hidden = requestId ? await page.evaluate(`!document.querySelector('[data-testid="quote-lines"]') && !document.querySelector('[data-testid="draft-reply"]')`) : false;
    check(4, "the customer's request is processed and waits for KELQOR's review, with no draft shown to the customer", pending === "in_review" && hidden, requestUrl ? `${pending}` : `not sent: ${formNote}`);

    // KELQOR reviews it in the window, then releases it for the customer's approval.
    await app.evaluate(js.click('[data-cust-tab="queue"]'));
    await until(app, js.exists(`[data-queue-request="${requestId}"]`), "the request in the review queue", 20_000);
    await app.evaluate(js.click(`[data-queue-request="${requestId}"]`));
    await until(app, js.exists('[data-action="cust-approve"]'), "the review", 20_000);
    const reviewText = await app.evaluate(`document.querySelector('[data-testid="request-review"]')?.innerText ?? ""`);
    check(4, "KELQOR's review shows what processing found, the questions and a priced draft, labeled simulated", /Dana Ruiz/.test(reviewText) && /Simulated processing/.test(reviewText) && (await app.evaluate(js.exists('[data-testid="draft-lines"]'))));
    await app.screenshot(path.join(out, "41-kelqor-review.png"));
    await app.evaluate(js.click('[data-action="cust-approve"]'));
    const released = await until(app, `document.querySelector('[data-testid="request-review"]')?.dataset.status === "awaiting_customer" ? true : false`, "the release", 20_000).catch(() => false);
    check(4, "KELQOR approves the draft and releases it for the customer's approval", released === true);

    // The customer sees the priced quote and the reply, and approves exactly that result.
    await browser.go(`${portal}/services/requests/${requestId}`);
    const total = await page.waitFor(`document.querySelector('[data-testid="quote-total"]')?.innerText ?? false`, "the quote", 20_000).catch(() => null);
    const reply = await page.evaluate(`document.querySelector('[data-testid="draft-reply"]')?.innerText ?? ""`);
    check(4, "the customer sees a priced quote and a reply ready to send", Boolean(total) && /Hi Dana/.test(reply), `${total}`);
    await page.screenshot(path.join(out, "42-customer-quote.png"));
    await page.waitFor(hydrated("form"), "the approval form to be ready", 60_000).catch(() => null);
    const approveButton = `[...document.querySelectorAll('form button[type="submit"]')].find((b) => b.innerText.trim() === "Approve")`;
    await fitCheck("the quote and its approval", { approve: approveButton, "ask for changes": `[...document.querySelectorAll('button[type="submit"]')].find((b) => b.innerText.trim() === "Ask for changes")` });
    // The approval names the exact result the customer saw. One naming anything else is refused and changes nothing.
    const tampered = await page.evaluate(`(() => { const f = (${approveButton}).form.querySelector('input[name="resultHash"]'); const real = f.value; f.value = "0".repeat(64); return { real: /^[0-9a-f]{64}$/.test(real), set: f.value === "0".repeat(64) }; })()`);
    await press(approveButton);
    const refusedNote = await page.waitFor(`(() => { const t = (${approveButton})?.form?.innerText ?? ""; return t.replace(/\s+/g, " ").trim() !== "Approve" ? t : false; })()`, "the answer to a mismatched approval", 30_000).catch(() => null);
    await browser.go(`${portal}/services/requests/${requestId}`);
    const stillWaiting = await page.waitFor(`document.querySelector('[data-testid="customer-request"]')?.dataset.status ?? false`, "the status after the mismatched approval", 15_000).catch(() => null);
    check("4S", "an approval that doesn't name the exact result shown is refused, and the request still waits for the customer", tampered.real && tampered.set && Boolean(refusedNote) && !/Approved\. The result is final/.test(refusedNote ?? "") && stillWaiting === "awaiting_customer", `${stillWaiting}; ${(refusedNote ?? "no answer shown").replace(/\s+/g, " ").replace(/\s*Approve\s*$/, "").slice(0, 120)}`);
    await page.waitFor(hydrated("form"), "the approval form to be ready", 60_000).catch(() => null);
    await press(approveButton);
    await page.waitFor(`document.body.innerText.includes("Approved. The result is final.")`, "the approval to be confirmed", 60_000).catch(() => null);
    await browser.go(`${portal}/services/requests/${requestId}`);
    const finalStatus = await page.waitFor(`document.querySelector('[data-testid="customer-request"]')?.dataset.status ?? false`, "the final status", 15_000).catch(() => null);
    check(4, "the customer approves it and the deliverable is complete", finalStatus === "completed", `${finalStatus}`);

    // Billing (simulated) and the report.
    const detail = await bridge(`return k.custOverview();`);
    const period = detail.data.period;
    const inv = await bridge(`const i = await k.custInvoice("${a.data.orgId}", "${period}", "${key()}"); if (!i.ok) return i; return k.custInvoiceAction(i.data.id, "issue", "${key()}");`);
    check(4, "KELQOR prepares and issues the month's invoice, marked simulated", inv.ok && inv.data.status === "issued" && inv.data.simulated === true && inv.data.totalCents === 49_900, inv.ok ? `${inv.data.label} ${inv.data.totalCents}` : inv.error);
    await browser.go(`${portal}/services`);
    const invoices = await page.waitFor(`document.querySelector('[data-testid="customer-invoices"]')?.innerText ?? false`, "the customer's invoices", 15_000).catch(() => "");
    await fitCheck("the Command Center with its invoice", { "monthly report": `document.querySelector('a[href="/services/report"]')` });
    check(4, "the customer sees its issued invoice, labeled simulated, numbered for it alone", invoices.includes(`Invoice ${period}`) && invoices.includes("Simulated") && !invoices.includes("INV-"), invoices.slice(0, 80));
    await browser.go(`${portal}/services/report`);
    const report = await page.waitFor(`document.querySelector('[data-testid="customer-report"]')?.innerText ?? false`, "the customer's report", 15_000).catch(() => "");
    check(4, "the customer's report shows the work done and the quoted value", /Completed\s*1/.test(report) && /Value of the quotes delivered\s*\$/.test(report), report.replace(/\s+/g, " ").slice(0, 160));
    await page.screenshot(path.join(out, "43-customer-report.png"));
    await fitCheck("the monthly report", { back: `[...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/services" && !a.closest("header"))` });
    const costs = await bridge(`return k.custCustomer("${a.data.orgId}", "${period}");`);
    check(4, "KELQOR sees the customer's operating cost and margin, marked as estimates", costs.ok && costs.data.costs.revenueCents === 49_900 && costs.data.costs.estimated === true && costs.data.costs.aiCostSource === "simulated", costs.ok ? JSON.stringify(costs.data.costs) : costs.error);

    // Isolation, from the customer's own browser: another customer's request isn't there.
    await browser.go(`${portal}/services/requests/${bReq.data?.id ?? randomUUID()}`);
    const foreign = await page.evaluate(`document.body.innerText`);
    check(4, "a customer opening another customer's request gets 'not found', and sees none of it", !foreign.includes("Nampa") && /not found|404|could not be found/i.test(foreign), foreign.replace(/\s+/g, " ").slice(0, 100));
    // The form only offers the customer's own services; force the other customer's service id into it and send it
    // anyway (the security reviewer: the check must actually try). The backend must refuse it, and the other customer gets nothing.
    const bBefore = await bridge(`return k.custCustomer("${b.data.orgId}", "${period}");`);
    await browser.go(`${portal}/services/new?service=${svcB.data.id}`);
    const offered = await page.evaluate(`document.body.innerText`);
    await page.waitFor(hydrated("form"), "the request form to be ready", 60_000).catch(() => null);
    const forced = await page.evaluate(`(() => { const sel = document.querySelector("#serviceId"); if (!sel) return false; const o = document.createElement("option"); o.value = ${JSON.stringify(svcB.data.id)}; o.textContent = "forced"; sel.appendChild(o); sel.value = o.value; return sel.value === o.value; })()`);
    await page.evaluate(fill("#text", "A forced request aimed at another customer's service, which must be refused."));
    await page.evaluate(`document.querySelector('#text').form.querySelector('button[type="submit"]').click()`);
    const landed = await page.waitFor(`location.pathname.startsWith("/services/requests/") ? location.pathname : false`, "a request page", 15_000).catch(() => null);
    const refusal = await page.evaluate(`document.querySelector('#text')?.form?.innerText ?? ""`).catch(() => "");
    const bAfter = await bridge(`return k.custCustomer("${b.data.orgId}", "${period}");`);
    const bUnchanged = bBefore.ok && bAfter.ok && bAfter.data.requests.length === bBefore.data.requests.length;
    check(4, "a customer can't send a request to another customer's service, even by forcing its id into the form", !/customer support assistance/i.test(offered) && forced === true && !landed && bUnchanged, `offered other service: ${/customer support assistance/i.test(offered)}; forced: ${forced}; request page: ${landed ?? "none"}; other customer's requests ${bBefore.data?.requests.length} → ${bAfter.data?.requests.length}; ${refusal.replace(/\s+/g, " ").slice(-80)}`);

    // Nothing of the customer's is kept on the device: no service worker, no offline cache, no browser storage, and
    // the portal's pages are served uncacheable.
    await browser.go(`${portal}/services`);
    const stored = await page.evaluate(`(async () => ({
      workers: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      caches: typeof caches === "undefined" ? 0 : (await caches.keys()).length,
      local: localStorage.length, session: sessionStorage.length,
      indexedDb: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [],
    }))()`);
    // Pages and the data payloads of in-app navigations (RSC fetches) alike; `private` alone would let the phone cache them.
    const docs = browser.responses.filter((r) => (r.type === "Document" || r.type === "Fetch") && new URL(r.url).pathname.startsWith("/services"));
    const cacheable = docs.filter((r) => !/no-store/.test(r.cacheControl));
    check("4S", "no customer information is stored on the device, and portal pages are served uncacheable", stored.workers === 0 && stored.caches === 0 && stored.local === 0 && stored.session === 0 && stored.indexedDb.length === 0 && docs.length > 0 && !cacheable.length, `${JSON.stringify(stored)}; ${docs.filter((r) => r.type === "Document").length} portal pages and ${docs.filter((r) => r.type === "Fetch").length} payloads, cache-control "${[...new Set(docs.map((r) => r.cacheControl))].join('", "')}"${cacheable.length ? `; cacheable: ${cacheable.map((r) => r.url).join(", ")}` : ""}`);

    // KELQOR's own controls stay out of reach of a customer's sign-in: the operator pages send it away, the desktop API
    // refuses it, and the portal's pages carry none of the operators' fields.
    const OPS = ["/ops/outbox", "/ops/builders", "/ops/new"];
    const API = ["/api/desktop/overview", "/api/desktop/customers", "/api/desktop/me"];
    const reach = await page.evaluate(`(async () => {
      const out = {};
      for (const p of ${JSON.stringify(OPS)}) { const r = await fetch(p, { credentials: "include" }); out[p] = new URL(r.url).pathname; }
      for (const p of ${JSON.stringify(API)}) { const r = await fetch(p, { credentials: "include" }); out[p] = r.status; }
      return out;
    })()`);
    const pages = ["/services", `/services/requests/${requestId}`, "/services/report", `/services/new?service=${svcA.data.id}`];
    const html = await page.evaluate(`(async () => { const t = []; for (const p of ${JSON.stringify(pages)}) t.push(await (await fetch(p, { credentials: "include" })).text()); return t.join(" "); })()`);
    const leaked = INTERNAL_FIELDS.filter((f) => html.includes(f));
    const opsAway = OPS.every((p) => reach[p] !== p);
    const apiRefused = API.every((p) => reach[p] === 401 || reach[p] === 403);
    check("4S", "KELQOR's internal controls aren't reachable from the customer's sign-in, and no operator field reaches the portal", opsAway && apiRefused && !leaked.length, `${JSON.stringify(reach)}; operator fields found: ${leaked.join(", ") || "none"}`);

    // No key or secret in anything the portal sends to the browser.
    const urls = [...new Set(browser.responses.map((r) => r.url))];
    const found = await page.evaluate(`(async () => {
      const shapes = ${JSON.stringify(Object.fromEntries(Object.entries(SECRET_SHAPES).map(([k, v]) => [k, v.source])))};
      const hits = []; let bytes = 0;
      for (const u of ${JSON.stringify(urls)}) {
        let text = ""; try { text = await (await fetch(u, { credentials: "include" })).text(); } catch { continue; }
        bytes += text.length;
        for (const [kind, src] of Object.entries(shapes)) if (new RegExp(src).test(text)) hits.push(kind + " in " + new URL(u).pathname);
      }
      return { hits, bytes };
    })()`);
    check("4S", "no key or secret is embedded in the portal's pages or scripts", urls.length > 0 && !found.hits.length, `${urls.length} files, ${(found.bytes / 1e6).toFixed(1)} MB scanned for ${Object.keys(SECRET_SHAPES).length} kinds of secret; ${found.hits.join(", ") || "none found"}`);
  } finally {
    browser.close();
  }
  return app;
}
