// Runs once when the Next.js server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A backend the KELQOR desktop app started stops itself if that app goes away without stopping it.
  if (process.env.KELQOR_PARENT_PID) {
    const { watchDesktopApp } = await import("@/lib/desktop/watchdog");
    watchDesktopApp(process.env.KELQOR_PARENT_PID);
  }
  // Missions left running when the backend last stopped become Interrupted, and their open reservations unverified.
  // Nothing is resent and nothing starts: only you resume a mission.
  let db;
  try {
    const { getDb } = await import("@/lib/db");
    db = await getDb();
  } catch (e) {
    // The database may need a verified backup before it can be updated; the desktop API reports that on use.
    console.error("[missions] the database isn't open:", e instanceof Error ? e.message : e);
    return;
  }
  // Test-only switches (synthetic costs, local test pages) against your real database stop the backend here.
  const { testMode } = await import("@/lib/controls");
  try {
    testMode(db);
  } catch (e) {
    const { refuseToStart } = await import("@/lib/desktop/watchdog");
    refuseToStart(`[missions] ${e instanceof Error ? e.message : e} The backend won't start this way.`);
  }
  try {
    const { recoverAtStartup } = await import("@/lib/missions/runner");
    const { interrupted, unverified } = await recoverAtStartup(db);
    if (interrupted || unverified) console.log(`[missions] recovery: ${interrupted} interrupted, ${unverified} reservations marked unverified`);
  } catch (e) {
    console.error("[missions] recovery at start-up didn't run:", e instanceof Error ? e.message : e);
  }
  try {
    const { recoverEngineeringAtStartup } = await import("@/lib/engineering/executor");
    const interrupted = await recoverEngineeringAtStartup(db);
    if (interrupted) console.log(`[engineering] recovery: ${interrupted} interrupted`);
  } catch (e) {
    console.error("[engineering] recovery at start-up didn't run:", e instanceof Error ? e.message : e);
  }
}
