// Apply database migrations. Embedded PGlite by default; a real Postgres when DATABASE_URL is set.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { MIGRATIONS_FOLDER, openDb } from "../src/lib/db";
import { refuseWhileBackendRuns } from "./local-backend-guard";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local: use defaults
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    await pool.end();
    console.log(`Migrated ${new URL(url).host}`);
    return;
  }
  await refuseWhileBackendRuns("Nothing was migrated.");
  const handle = openDb();
  await handle.ready;
  await handle.close();
  console.log("Migrated the embedded database in .data/pglite");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
