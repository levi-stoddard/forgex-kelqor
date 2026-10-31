// Undoes migrations 0004 and 0005 (Milestone 2B) in your embedded database: drops the M2B tables, the two users columns
// and the 0005 functions, and removes the two migration records (docs/m2b/ROLLBACK.md). Take a backup first.
//   npm run db:rollback-m2b -- --confirm
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_PGLITE_DIR, MIGRATIONS_FOLDER } from "../src/lib/db";
import { refuseWhileBackendRuns } from "./local-backend-guard";
import { guardFinancialRecords } from "./rollback-guard";

async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("This removes every M2B table and its records. Read docs/m2b/ROLLBACK.md, then run it again with --confirm.");
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was rolled back.");
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const first = journal.entries.find((e) => e.tag.startsWith("0004_"));
  if (!first) throw new Error("Migration 0004 isn't in this checkout's journal; run this from the kelqor/m2b branch.");
  const sql = fs.readFileSync(path.join(process.cwd(), "docs", "m2b", "rollback.sql"), "utf8").replaceAll(":m2b_since", String(first.when));
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
  console.log("Migrations 0004 and 0005 were undone. Demo sign-in is back on. Switch the code back with: git switch kelqor/desktop-m1");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
