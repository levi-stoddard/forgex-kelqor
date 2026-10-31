// The desktop API is for the KELQOR app on this computer only, and only in development for this release
// (Milestone 1). It refuses requests addressed to any host but a loopback one, which also defeats DNS rebinding.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string | null | undefined): boolean {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name);
}

/** Why the desktop API won't answer this request, or null when it may. */
export function desktopApiBlocked(env: { NODE_ENV?: string }, host: string | null | undefined): string | null {
  if (env.NODE_ENV === "production") return "The desktop API is available in local development only.";
  if (!isLoopbackHost(host)) return "The desktop API only answers on this computer.";
  return null;
}
