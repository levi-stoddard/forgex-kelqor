// A minimal Chrome DevTools Protocol client for driving the KELQOR window in acceptance tests: evaluate script in
// the page, take screenshots. It attaches to an app://kelqor page on a local debugging port, or (for the customer
// portal) to the page a test browser opened.
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port, timeoutMs = 45_000, match = (url) => url.startsWith("app://kelqor/")) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (!target && Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && match(t.url)) ?? null;
    } catch {
      // The app is still starting.
    }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error(`No KELQOR window on debugging port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg.method, msg.params);
    }
  };
  // A reply that never comes (the page navigated, the browser dropped the socket) must fail the call, not leave it
  // pending: with nothing else to wait on, Node would exit silently with code 13 and no results.
  let closed = null;
  ws.onclose = () => {
    closed = new Error(`The debugging connection on port ${port} closed`);
    for (const done of pending.values()) done({ error: { message: closed.message } });
    pending.clear();
  };
  const send = (method, params = {}, ms = 45_000) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`No reply to ${method} within ${ms / 1000}s`));
      }, ms);
      pending.set(i, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, label, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch (e) {
        // The page may be mid-render or reloading; a closed connection won't come back.
        if (closed) throw e;
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const screenshot = async (file) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  };
  /** Calls fn(method, params) for every protocol event (after the matching domain is enabled). */
  const onEvent = (fn) => listeners.push(fn);
  return { url: target.url, send, evaluate, waitFor, screenshot, onEvent, close: () => ws.close() };
}

/** Page-side helpers, as expressions. Values are JSON-encoded, so nothing is interpolated as code. */
export const js = {
  click: (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
  exists: (sel) => `Boolean(document.querySelector(${JSON.stringify(sel)}))`,
  attr: (sel, name) => `document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? null`,
  text: (sel) => `document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`,
  disabled: (sel) => `document.querySelector(${JSON.stringify(sel)})?.disabled ?? null`,
  select: (sel, value) =>
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  type: (sel, value) =>
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
};
