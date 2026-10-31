import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, protocol, screen, session, type MenuItemConstructorOptions } from "electron";
import type { DesktopUser, FounderQueue } from "@/lib/desktop/types";
import { CHANNELS, VIEWS, type AppStatus, type View } from "../shared/bridge";
import { Backend } from "./backend";
import { registerIpc } from "./ipc";
import { LocalBackend } from "./local-backend";
import { Notifier } from "./notifications";
import { APP_ORIGIN, contentType, CSP, isLoopbackUrl, resolveAppAsset } from "./security";
import { handleSquirrelEvent } from "./squirrel";
import { Store } from "./store";

// KELQOR Command Center, main process. It owns everything privileged: the session token, the connection to the
// local backend, notifications and the browser hand-off. The window only renders the packaged interface.

const DEFAULT_BACKEND = "http://127.0.0.1:3000";
// The project folder this build was made from (set by scripts/build.mjs); KELQOR starts its backend from there.
declare const __KELQOR_PROJECT_DIR__: string;
const PROJECT_DIR = process.env.KELQOR_PROJECT_DIR || __KELQOR_PROJECT_DIR__;
const RENDERER_DIR = path.join(__dirname, "renderer");
const ICON = path.join(__dirname, "assets", "kelqor.png");
// The ID Squirrel gives the installed app's shortcuts; notifications must use the same one to appear.
const INSTALLED_APP_ID = "com.squirrel.kelqor.KELQOR";

// Must run before the app is ready: the packaged interface is served from app://kelqor, a secure standard origin.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Test runs give KELQOR a data folder of their own (desktop/scripts/acceptance.mjs), so they never use or change the
// owner's sign-in and settings. Must also run before the app is ready.
const dataDirOverride = process.env.KELQOR_DATA_DIR;
if (dataDirOverride && path.isAbsolute(dataDirOverride)) app.setPath("userData", dataDirOverride);

function backendUrl(): string {
  const fromEnv = process.env.KELQOR_BACKEND_URL;
  return fromEnv && isLoopbackUrl(fromEnv) ? fromEnv.replace(/\/+$/, "") : DEFAULT_BACKEND;
}

function start() {
  if (handleSquirrelEvent()) return;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId(app.isPackaged ? INSTALLED_APP_ID : process.execPath);

  let win: BrowserWindow | null = null;
  let store: Store;
  let backend: Backend;
  let localBackend: LocalBackend;
  let notifier: Notifier;
  let everConnected = false;
  let queueCount: number | null = null;
  let quitting = false;

  const status = (): AppStatus => ({
    backend: backend.status,
    localBackend: localBackend.info,
    user: store.settings.user,
    notifications: notifier.state,
    app: { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, dataDir: store.dir, tokenProtected: store.tokenProtected },
  });
  const broadcast = () => {
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.statusChanged, status());
  };
  const focus = (view?: string) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (view && (VIEWS as readonly string[]).includes(view)) win.webContents.send(CHANNELS.navigate, view as View);
  };

  app.on("second-instance", () => focus());
  app.on("window-all-closed", () => app.quit());
  // Exiting stops the backend KELQOR started (closing its port) before the app goes; one already running is left.
  app.on("before-quit", (event) => {
    if (quitting || !localBackend) return;
    quitting = true;
    const running = localBackend.running;
    const stopped = localBackend.close(); // and from here on nothing starts, even a start already under way
    if (!running) return;
    event.preventDefault();
    backend.stop();
    void stopped.finally(() => app.quit());
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  // The name shown is the backend's answer for the saved token, so it can't drift from the account actually in use.
  async function confirmUser() {
    if (!store.getToken()) return;
    const res = await backend.call<DesktopUser>("GET", "me");
    if (!res.ok) return; // a token the backend rejects has already signed the app out
    const u = store.settings.user;
    if (u?.id === res.data.id && u.name === res.data.name && u.email === res.data.email) return;
    store.update({ user: { id: res.data.id, name: res.data.name, email: res.data.email, role: "operator" } });
    broadcast();
  }

  async function watchQueue() {
    if (backend.status.state !== "connected" || !store.getToken()) return;
    const res = await backend.call<FounderQueue>("GET", "decisions");
    if (!res.ok) return;
    const count = res.data.items.length;
    if (queueCount !== null && count > queueCount) {
      notifier.show("New items need your decision", `${count} items are waiting in Owner Decisions.`, "decisions");
    }
    queueCount = count;
  }

  function savedBounds() {
    const b = store.settings.bounds;
    if (!b) return null;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? b : null;
  }

  function createWindow(): BrowserWindow {
    const b = savedBounds();
    const w = new BrowserWindow({
      width: b?.width ?? 1320,
      height: b?.height ?? 860,
      ...(b ? { x: b.x, y: b.y } : {}),
      minWidth: 1024,
      minHeight: 680,
      title: "KELQOR",
      show: false,
      backgroundColor: "#fafaf9",
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });
    if (store.settings.maximized) w.maximize();
    w.once("ready-to-show", () => w.show());
    w.on("page-title-updated", (event) => event.preventDefault());
    // Closing KELQOR stops the backend it started, which interrupts a running mission: warn and offer to wait.
    let closeConfirmed = false;
    w.on("close", (event) => {
      store.update({ bounds: w.getNormalBounds(), maximized: w.isMaximized() });
      if (closeConfirmed || quitting || !store.getToken() || backend.status.state !== "connected") return;
      event.preventDefault();
      void (async () => {
        const res = await backend.call<{ running: number }>("GET", "ai/running");
        const running = res.ok ? res.data.running : 0;
        if (running > 0) {
          const { response } = await dialog.showMessageBox(w, {
            type: "warning",
            buttons: ["Keep KELQOR open", "Close anyway"],
            defaultId: 0,
            cancelId: 0,
            title: "A mission is running",
            message: running === 1 ? "A mission is running." : `${running} missions are running.`,
            detail:
              "Closing KELQOR stops the local backend, so the mission becomes Interrupted. A request in flight counts at its maximum until you reconcile it, and nothing resumes until you resume it.",
          });
          if (response === 0) return;
        }
        closeConfirmed = true;
        if (!w.isDestroyed()) w.close();
      })();
    });
    void w.loadURL(`${APP_ORIGIN}/index.html`);
    return w;
  }

  function buildMenu() {
    const template: MenuItemConstructorOptions[] = [
      { label: "File", submenu: [{ role: "quit", label: "Quit KELQOR" }] },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          ...(app.isPackaged ? [] : ([{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
        ],
      },
      { role: "windowMenu" },
      {
        label: "Help",
        submenu: [
          {
            label: "About KELQOR",
            click: () =>
              void dialog.showMessageBox({
                type: "info",
                title: "About KELQOR",
                message: `KELQOR Command Center ${app.getVersion()}`,
                detail: `Internal development build (Milestone 1).\nElectron ${process.versions.electron}\nLocal backend: ${backend.url}\nApp data: ${store.dir}`,
              }),
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  void app.whenReady().then(() => {
    store = new Store();
    // A saved sign-in whose token is gone or unreadable isn't a sign-in: the window shows the sign-in screen.
    if (store.settings.user && !store.getToken()) store.update({ user: null });
    notifier = new Notifier(() => store.settings.notificationsEnabled, fs.existsSync(ICON) ? ICON : undefined, broadcast, focus);
    backend = new Backend(
      backendUrl(),
      () => store.getToken(),
      (previous, next) => {
        broadcast();
        if (next.state === "connected") {
          if (everConnected && previous.state === "disconnected") notifier.show("Local backend reconnected", "KELQOR is connected to the local backend again.", "overview");
          everConnected = true;
          void confirmUser();
        } else if (next.state === "disconnected" && previous.state === "connected" && !["stopping", "stopped"].includes(localBackend.info.state)) {
          notifier.show("Local backend disconnected", "KELQOR can't reach the local backend. Changes are paused until it's back.", "settings");
        }
      },
      () => {
        store.clearToken();
        if (store.settings.user) store.update({ user: null });
        broadcast();
      },
    );

    protocol.handle("app", async (request) => {
      const file = resolveAppAsset(RENDERER_DIR, request.url);
      if (!file) return new Response("Not found", { status: 404 });
      try {
        const data = await fs.promises.readFile(file);
        // no-cache: after an update the window must load the interface that shipped with it, never a cached one.
        return new Response(data, {
          headers: { "Content-Type": contentType(file), "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    // The window never gets camera, microphone, location, notification or any other web permission.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    const origin = new URL(backend.url);
    localBackend = new LocalBackend({
      projectDir: PROJECT_DIR,
      port: Number(origin.port || 80),
      origin: backend.url,
      logFile: path.join(store.dir, "backend.log"),
      autoStart: () => store.settings.autoStartBackend,
      isHealthy: async () => (await backend.check()).state === "connected",
      onChange: broadcast,
    });

    registerIpc({ backend, localBackend, store, notifier, window: () => win, status, broadcast });
    buildMenu();
    win = createWindow();
    win.on("closed", () => (win = null));
    backend.start();
    if (store.settings.autoStartBackend) void localBackend.start();
    setInterval(() => void watchQueue(), 60_000);
  });
}

start();
