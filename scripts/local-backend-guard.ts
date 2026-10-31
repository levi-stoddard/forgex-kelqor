// The embedded database (.data/pglite) can be open in only one program at a time, and the local backend keeps it
// open while it runs: KELQOR starts the backend whenever the app is open, and npm run desktop:backend starts it by
// hand. Scripts that open the embedded database check here first. A DATABASE_URL database has no such limit.

async function backendRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return typeof body?.ok === "boolean"; // the backend's own answer; another program on the port gives none
  } catch (e) {
    // Only "nothing is listening" is safe: a listener too slow to answer may be a backend still starting.
    return (e as { cause?: { code?: string } }).cause?.code !== "ECONNREFUSED";
  }
}

/** Exits with an explanation while the local backend has the embedded database open. */
export async function refuseWhileBackendRuns(outcome: string): Promise<void> {
  if (process.env.DATABASE_URL || !(await backendRunning())) return;
  console.error(
    `The local backend is running and has the database open (KELQOR starts it while the app is open, or npm run desktop:backend did). Close KELQOR or stop the backend, then run this again. ${outcome}`,
  );
  process.exit(1);
}
