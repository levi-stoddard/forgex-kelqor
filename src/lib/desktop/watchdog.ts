import { closeDb } from "@/lib/db";

// A backend the KELQOR desktop app started is given the app's process ID. If the app goes away without stopping it
// (a crash, or ended from Task Manager), the backend closes its database and exits, so its port never outlives the
// app. A backend started by hand gets no such ID and isn't watched.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only asks whether the process exists
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // it exists, under another account
  }
}

async function shutDown(): Promise<void> {
  await closeDb().catch(() => false);
  process.exit(0);
}

/** Watches the app whose process ID is `parentPid`; returns a function that stops watching, or null without one. */
export function watchDesktopApp(
  parentPid: string | undefined,
  o: { isAlive?: (pid: number) => boolean; onGone?: () => void | Promise<void>; intervalMs?: number } = {},
): (() => void) | null {
  const pid = Number(parentPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const isAlive = o.isAlive ?? alive;
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    void (o.onGone ?? shutDown)();
  }, o.intervalMs ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Stops this backend at start-up with the reason in its log, for a configuration it must refuse to run with. */
export function refuseToStart(reason: string): never {
  console.error(reason);
  process.exit(1);
}
