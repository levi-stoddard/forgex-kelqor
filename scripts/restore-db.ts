// Restores the embedded database from a verified backup (made by npm run db:backup). The database it replaces is moved
// aside, never deleted, and the restore is checked file by file. Close KELQOR first.
//   npm run db:restore -- --from .data/pglite-backup-2026-10-28-pre-m3 --confirm
import path from "node:path";
import { DEFAULT_PGLITE_DIR } from "../src/lib/db";
import { restoreBackup } from "../src/lib/ops/restore";
import { refuseWhileBackendRuns } from "./local-backend-guard";

async function main() {
  const at = process.argv.indexOf("--from");
  const from = at > 0 ? process.argv[at + 1] : undefined;
  if (!from || !process.argv.includes("--confirm")) {
    console.error("Usage: npm run db:restore -- --from <backup folder> --confirm. The current database is kept, moved aside.");
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was restored.");
  const r = restoreBackup(path.resolve(from), DEFAULT_PGLITE_DIR());
  console.log(`Restored ${r.files} files from ${from}, verified file by file.${r.movedAside ? ` The database it replaced is kept at ${r.movedAside}.` : ""}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
