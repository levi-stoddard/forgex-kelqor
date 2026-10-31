import type { BackendStatus, Result } from "../shared/bridge";

// The main process's client for the local development backend. Only this process holds the session token; the
// window asks for data over IPC. Connection state comes from the backend's real health check, polled.

type Method = "GET" | "POST" | "PUT" | "DELETE";

const OFFLINE = "The local backend isn't running or can't be reached.";

export class Backend {
  status: BackendStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly url: string,
    private readonly getToken: () => string | null,
    private readonly onStatus: (previous: BackendStatus, next: BackendStatus) => void,
    private readonly onSessionEnded: () => void,
  ) {
    this.status = { state: "checking", url, checkedAt: null, error: null };
  }

  start(intervalMs = 5000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<BackendStatus> {
    const checkedAt = new Date().toISOString();
    let next: BackendStatus;
    try {
      const res = await fetch(`${this.url}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      next =
        res.ok && body?.ok
          ? { state: "connected", url: this.url, checkedAt, error: null }
          : {
              state: "disconnected",
              url: this.url,
              checkedAt,
              error: res.status === 503 ? "The backend is running but can't open its database." : `The backend answered with HTTP ${res.status}.`,
            };
    } catch {
      next = { state: "disconnected", url: this.url, checkedAt, error: OFFLINE };
    }
    const previous = this.status;
    this.status = next;
    if (previous.state !== next.state || previous.error !== next.error) this.onStatus(previous, next);
    return next;
  }

  /** One request to the desktop API. Fails fast, without side effects, while the backend is unreachable. */
  async call<T>(method: Method, route: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<Result<T>> {
    if (this.status.state !== "connected" && (await this.check()).state !== "connected") {
      return { ok: false, error: this.status.error ?? OFFLINE, offline: true, signedOut: false };
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      const token = this.getToken();
      if (!token) {
        this.onSessionEnded(); // signed in without a token is a dead end: back to the sign-in screen
        return { ok: false, error: "Sign in first.", offline: false, signedOut: true };
      }
      headers.Authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/desktop/${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await this.check();
      return { ok: false, error: OFFLINE, offline: true, signedOut: false };
    }
    const payload = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
    if (res.status === 401) {
      this.onSessionEnded();
      return { ok: false, error: payload?.error ?? "Your session has ended. Sign in again.", offline: false, signedOut: true };
    }
    if (!res.ok || !payload || !("data" in payload)) {
      return { ok: false, error: payload?.error ?? `The backend answered with HTTP ${res.status}.`, offline: false, signedOut: false };
    }
    return { ok: true, data: payload.data as T };
  }
}
