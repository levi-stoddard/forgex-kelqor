import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, shell } from "electron";

/**
 * Deletes the Start menu and desktop shortcuts the installer made, but only ones that still point into this
 * install. Update.exe's own removal can lose a race with the running uninstall, which left the Start menu one behind.
 */
function removeOwnShortcuts(installRoot: string) {
  const root = path.resolve(installRoot).toLowerCase() + path.sep;
  for (const lnk of [
    path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "KELQOR.lnk"),
    path.join(app.getPath("desktop"), "KELQOR.lnk"),
  ]) {
    try {
      if (fs.existsSync(lnk) && path.resolve(shell.readShortcutLink(lnk).target).toLowerCase().startsWith(root)) fs.unlinkSync(lnk);
    } catch {
      // A shortcut that can't be read isn't ours to delete.
    }
  }
}

/**
 * Handles the Windows installer's lifecycle events (Squirrel.Windows): it starts the app with --squirrel-install and
 * friends so the app can create or remove its Start menu and desktop shortcuts through the installer's own
 * Update.exe, then quit. Returns true when the app should exit without opening a window.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== "win32") return false;
  const event = process.argv[1];
  if (!event?.startsWith("--squirrel-")) return false;
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const exe = path.basename(process.execPath);
  const run = (args: string[]) => {
    try {
      spawn(updateExe, args, { detached: true }).on("close", () => app.quit());
    } catch {
      app.quit();
    }
  };
  switch (event) {
    case "--squirrel-install":
    case "--squirrel-updated":
      run([`--createShortcut=${exe}`]);
      return true;
    case "--squirrel-uninstall":
      removeOwnShortcuts(path.dirname(updateExe));
      run([`--removeShortcut=${exe}`]);
      return true;
    case "--squirrel-obsolete":
      app.quit();
      return true;
    default:
      return false;
  }
}
