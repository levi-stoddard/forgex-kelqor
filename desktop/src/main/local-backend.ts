import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LocalBackendInfo, LocalBackendState } from "../shared/bridge";

// Starts the project's own local backend when KELQOR opens and stops it when KELQOR exits, so the port is open only
// while the app runs. It runs one fixed command (Next.js dev on 127.0.0.1) in one validated project folder; nothing
// the window sends can change either. A backend that was already running is used as is and never stopped. If KELQOR
// is ended without exiting (a crash, Task Manager), the backend notices and stops itself (src/lib/desktop/watchdog.ts).

/** Why `dir` isn't the ForgeX/KELQOR project this app may start, or null when it is. */
export function projectProblem(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
    if (pkg.name !== "forgex" || !pkg.scripts?.["desktop:backend"]) return `${dir} isn't the ForgeX project folder.`;
  } catch {
    return `The project folder ${dir} wasn't found.`;
  }
  if (!fs.existsSync(nextBin(dir))) return `Next.js isn't installed in ${dir}. Run npm install there.`;
  return null;
}

export const nextBin = (dir: string) => path.join(dir, "node_modules", "next", "dist", "bin", "next");

/** The node.exe on the PATH, or in the default install folder; null when Node.js isn't installed. */
export function findNode(pathEnv: string | undefined, exists: (p: string) => boolean = fs.existsSync): string | null {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    const clean = dir.trim().replace(/^"|"$/g, "");
    if (clean && exists(path.join(clean, "node.exe"))) return path.join(clean, "node.exe");
  }
  const fallback = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe");
  return exists(fallback) ? fallback : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    // Windows has no signals; taskkill ends the backend and the helper processes Next.js started.
    const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    k.on("close", () => resolve());
    k.on("error", () => resolve());
  });
}

export class LocalBackend {
  private child: ChildProcess | null = null;
  private token = "";
  private state: LocalBackendState = "off";
  private detail: string | null = null;
  private launching: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly o: {
      projectDir: string;
      port: number;
      origin: string;
      logFile: string;
      autoStart: () => boolean;
      isHealthy: () => Promise<boolean>;
      onChange: () => void;
    },
  ) {}

  get info(): LocalBackendInfo {
    return { state: this.state, managed: this.child !== null, projectDir: this.o.projectDir, logFile: this.o.logFile, detail: this.detail, autoStart: this.o.autoStart() };
  }

  /** True while a backend KELQOR started is up or coming up, which exiting must stop. */
  get running(): boolean {
    return this.child !== null;
  }

  private set(state: LocalBackendState, detail: string | null = null) {
    this.state = state;
    this.detail = detail;
    this.o.onChange();
  }

  /**
   * Starts the backend unless one already answers, replacing one this app started that no longer does; resolves once
   * it's healthy, failed, or found running.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // One start at a time: asking again while one is under way waits for that one.
    this.launching ??= this.launch().finally(() => (this.launching = null));
    return this.launching;
  }

  /** For exiting: nothing starts from now on, and a backend KELQOR started is stopped. */
  close(): Promise<void> {
    this.closed = true;
    return this.stop();
  }

  private async launch(): Promise<void> {
    if (await this.o.isHealthy()) {
      if (!this.child) this.set("external", "A backend was already running, so KELQOR uses it and leaves it running when you exit.");
      return;
    }
    if (this.child) await this.stop(); // started by this app but no longer answering
    if (this.closed) return; // KELQOR began exiting meanwhile
    const problem = projectProblem(this.o.projectDir);
    if (problem) return this.set("failed", problem);
    const node = findNode(process.env.PATH);
    if (!node) return this.set("failed", "Node.js wasn't found on this computer, so KELQOR can't start the backend.");

    this.token = randomBytes(32).toString("base64url");
    fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
    const log = fs.openSync(this.o.logFile, "w");
    let child: ChildProcess;
    try {
      child = spawn(node, [nextBin(this.o.projectDir), "dev", "--hostname", "127.0.0.1", "--port", String(this.o.port)], {
        cwd: this.o.projectDir,
        // The token lets this app, and only it, close the backend's database before stopping it; the process ID
        // lets the backend stop itself if this app disappears.
        env: { ...process.env, KELQOR_BACKEND_TOKEN: this.token, KELQOR_PARENT_PID: String(process.pid) },
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } catch (e) {
      fs.closeSync(log);
      return this.set("failed", `The backend couldn't be started: ${e instanceof Error ? e.message : String(e)}`);
    }
    fs.closeSync(log);
    this.child = child;
    this.set("starting");
    // While stopping, stop() records the outcome; any other end is a failure.
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state !== "stopping") this.set("failed", `The backend stopped unexpectedly (exit code ${code ?? "none"}). Its log is ${this.o.logFile}.`);
    });
    child.on("error", (e) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state !== "stopping") this.set("failed", `The backend couldn't be started: ${e.message}`);
    });

    // A first start compiles the app, which can take a while on a cold cache. Stopping meanwhile ends the wait.
    const deadline = Date.now() + 120_000;
    while (this.state === "starting" && this.child === child && Date.now() < deadline) {
      if (await this.o.isHealthy()) {
        if (this.state === "starting" && this.child === child) this.set("running");
        return;
      }
      await sleep(1000);
    }
    if (this.state === "starting" && this.child === child) await this.stop(`The backend didn't become ready within 2 minutes. Its log is ${this.o.logFile}.`);
  }

  /**
   * Stops the backend if KELQOR started it: the database is closed first, then the processes end. With `failure`,
   * the stop is recorded as a failure with that explanation.
   */
  async stop(failure: string | null = null): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.set("stopping");
    try {
      await fetch(`${this.o.origin}/api/desktop/shutdown`, { method: "POST", headers: { "x-kelqor-backend-token": this.token }, signal: AbortSignal.timeout(3000) });
    } catch {
      // The backend may already be gone; ending the processes below is what matters.
    }
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await killTree(child.pid);
    await Promise.race([exited, sleep(8000)]);
    if (this.child === child) this.child = null;
    this.set(failure ? "failed" : "stopped", failure);
  }
}
