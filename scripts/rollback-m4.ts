// Undoes migration 0007 (Milestone 4) in your embedded database: drops the five managed-service tables and removes the
// migration record. M3 and everything earlier stay. Take a backup first (npm run db:backup).
//   npm run db:rollback-m4 -- --confirm
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_PGLITE_DIR, MIGRATIONS_FOLDER } from "../src/lib/db";
import { refuseWhileBackendRuns } from "./local-backend-guard";
import { guardFinancialRecords } from "./rollback-guard";

async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("This removes the managed-service tables (services, requests, events, invoices) and their records. Run it again with --confirm.");
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was rolled back.");
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const first = journal.entries.find((e) => e.tag.startsWith("0007_"));
  if (!first) throw new Error("Migration 0007 isn't in this checkout's journal; run this from the kelqor/m4 branch.");
  const sql = fs.readFileSync(path.join(process.cwd(), "docs", "m4", "rollback.sql"), "utf8").replaceAll(":m4_since", String(first.when));
  // Opened directly, so no migration runs on the way in.
  const client = new PGlite(DEFAULT_PGLITE_DIR());
  await guardFinancialRecords(client);
  try {
    await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  } catch (e) {
    await client.exec("ROLLBACK;").catch(() => {});
    throw e;
  } finally {
    await client.close();
  }
  console.log("Migrations 0007 and 0008 were undone. Switch the code back with: git switch kelqor/m3");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
