import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every program an engineering mission runs (git, the approved checks, an agent) goes through here: no shell, an
// exact program and arguments, a working folder, a time limit, cancellation, capped output, and an environment with
// KELQOR's own secrets removed, so nothing a mission runs can read the backend's keys or tokens.

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|COOKIE|SESSION)/i;
const OUTPUT_CAP = 200_000;

/** The backend's environment without anything that looks like a secret, plus `extra`. */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_NAME.test(k)) env[k] = v;
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

/** Text with the backend's secret values, and things shaped like keys, replaced. */
export function redactOutput(text: string): string {
  let out = text;
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 12 && SECRET_NAME.test(k)) out = out.split(v).join("[redacted]");
  return out.replace(/AIza[0-9A-Za-z_-]{30,}/g, "[redacted]").replace(/sk-ant-[0-9A-Za-z_-]{20,}/g, "[redacted]");
}

/**
 * A program's absolute path, found on the backend's PATH and never in the working folder. On Windows both cmd.exe and
 * Node's launcher look in the working folder first, where an agent could have planted its own npm.cmd, node.exe or
 * git.exe; resolving the path first means only the installed program runs.
 */
export function resolveProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  if (name.includes("/") || name.includes("\\")) return null;
  const exts = process.platform === "win32" ? (path.extname(name) ? [""] : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Called with each complete line of standard output, as it arrives. */
  onLine?: (line: string) => void;
  input?: string;
  /** Windows only: pass the arguments to the program exactly as given (for cmd.exe's own quoting rules). */
  verbatim?: boolean;
}

/** Runs a program without a shell. Never throws for the program's own failure; the result says what happened. */
export function runProgram(program: string, args: string[], o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const kill = () => {
      try {
        if (process.platform === "win32" && child?.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child?.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const abort = () => {
      cancelled = true;
      kill();
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      if (buffered && o.onLine) o.onLine(buffered);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started });
    };
    const resolved = resolveProgram(program);
    if (!resolved) {
      stderr = `${program} wasn't found on the backend's PATH.`;
      setImmediate(() => finish(null));
      return;
    }
    try {
      child = spawn(resolved, args, { cwd: o.cwd, env: o.env ?? scrubbedEnv(), shell: false, windowsHide: true, windowsVerbatimArguments: o.verbatim === true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      stderr = e instanceof Error ? e.message : String(e);
      setImmediate(() => finish(null));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    if (o.signal?.aborted) abort();
    o.signal?.addEventListener("abort", abort);
    child!.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length < OUTPUT_CAP) stdout += text;
      if (o.onLine) {
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) o.onLine(line);
      }
    });
    child!.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child!.on("error", (e) => {
      stderr += `${e.message}\n`;
      finish(null);
    });
    child!.on("close", (code) => finish(code));
    if (o.input !== undefined) child!.stdin!.end(o.input);
    else child!.stdin!.end();
  });
}

/** An empty folder used as git's hooks directory, so no hook from a workspace or an agent's change ever runs. */
export function emptyHooksDir(): string {
  const dir = path.join(os.tmpdir(), "kelqor-no-git-hooks");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  return dir;
}
