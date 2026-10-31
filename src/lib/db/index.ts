import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

/** Driver-agnostic handle: the embedded PGlite in development and tests, node-postgres in production. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export interface DbHandle {
  db: DB;
  /** Resolves once the database is ready (the embedded database is migrated on open). */
  ready: Promise<void>;
  close: () => Promise<void>;
}

/** Where a handle's database lives; the controls allow test-only switches on memory databases and marked copies. */
export type DbLocation = { kind: "memory" } | { kind: "dir"; dir: string; isDefault: boolean } | { kind: "url" };

declare global {
  var __kelqorDbLocations: WeakMap<object, DbLocation> | undefined;
}

// Kept on globalThis: Next.js loads this module once for instrumentation and again for the routes, and a handle opened
// by one copy must be recognized by the other (otherwise test mode is refused on a marked copy, failing closed).
const locations: WeakMap<object, DbLocation> = (globalThis.__kelqorDbLocations ??= new WeakMap<object, DbLocation>());

export function dbLocation(db: DB): DbLocation | null {
  return locations.get(db as object) ?? null;
}

export const DEFAULT_PGLITE_DIR = () => path.join(process.cwd(), ".data", "pglite");
/** Written by `npm run db:backup` after it verifies a copy of the database; it permits the pending migrations. */
export const BACKUP_APPROVAL_FILE = () => path.join(process.cwd(), ".data", "backup-approval.json");

/** The backend won't migrate your own database without a fresh verified backup. */
export class MigrationNeedsBackup extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationNeedsBackup";
  }
}

interface Journal {
  entries: { tag: string; when: number }[];
}

function journal(): Journal {
  return JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
}

/** The newest file write in a database folder, read before the database is opened (opening writes to it). */
export function newestWrite(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

/**
 * Your own database (.data/pglite) is migrated only with a verified backup taken after its last change: a pending
 * migration otherwise stops the backend with an explanation. Test databases and copies are never guarded.
 */
async function guardDefaultMigrations(client: PGlite, newestBefore: number): Promise<void> {
  const applied = await client
    .query<{ created_at: string | number }>("select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1")
    .catch(() => null);
  if (!applied || applied.rows.length === 0) return; // a new, empty database has nothing to protect
  const last = Number(applied.rows[0].created_at);
  const pending = journal().entries.filter((e) => e.when > last).map((e) => e.tag);
  if (pending.length === 0) return;
  let approval: { covers?: string[]; backupDir?: string; verifiedAt?: string } | null = null;
  try {
    approval = JSON.parse(fs.readFileSync(BACKUP_APPROVAL_FILE(), "utf8"));
  } catch {
    approval = null;
  }
  const covered = Boolean(approval?.covers && pending.every((t) => approval!.covers!.includes(t)));
  const fresh = Boolean(approval?.verifiedAt && Date.parse(approval.verifiedAt) >= newestBefore - 1000);
  const present = Boolean(approval?.backupDir && fs.existsSync(path.join(approval.backupDir, "BACKUP.json")));
  if (!covered || !fresh || !present) {
    throw new MigrationNeedsBackup(
      `Your database needs ${pending.length === 1 ? "an update" : "updates"} (${pending.join(", ")}), and KELQOR applies them only after a verified backup taken since its last change. Close KELQOR and run npm run db:backup, then open it again. Nothing was changed.`,
    );
  }
}

export function openDb(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): DbHandle {
  if (opts.url) {
    // Production: run `npm run db:migrate` as a release step; the app does not migrate a shared database.
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const db = drizzleNodePg(pool, { schema }) as unknown as DB;
    locations.set(db as object, { kind: "url" });
    return { db, ready: Promise.resolve(), close: () => pool.end() };
  }
  let client: PGlite;
  let location: DbLocation;
  let newestBefore = 0;
  if (opts.memory) {
    client = new PGlite();
    location = { kind: "memory" };
  } else {
    // PGLITE_DIR points a test run at a copy of the database (desktop/scripts/acceptance.mjs).
    const dir = opts.dataDir ?? (process.env.PGLITE_DIR || DEFAULT_PGLITE_DIR());
    const isDefault = path.resolve(dir).toLowerCase() === path.resolve(DEFAULT_PGLITE_DIR()).toLowerCase();
    if (isDefault) newestBefore = newestWrite(dir);
    fs.mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
    location = { kind: "dir", dir: path.resolve(dir), isDefault };
  }
  const pgliteDb = drizzlePglite(client, { schema });
  const guarded = location.kind === "dir" && location.isDefault;
  const ready = (guarded ? guardDefaultMigrations(client, newestBefore) : Promise.resolve()).then(() => migratePglite(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER }));
  locations.set(pgliteDb as object, location);
  return { db: pgliteDb as unknown as DB, ready, close: () => client.close() };
}

declare global {
  var __forgexDb: DbHandle | undefined;
  var __forgexDbClosed: boolean | undefined;
}

/** The process-wide database (cached on globalThis so dev hot-reload reuses one connection). */
export async function getDb(): Promise<DB> {
  // Closed for a shutdown means closed for good: nothing reopens it while the process is being stopped.
  if (globalThis.__forgexDbClosed) throw new Error("The database is closed because this backend is stopping.");
  if (!globalThis.__forgexDb) {
    globalThis.__forgexDb = openDb({ url: process.env.DATABASE_URL || undefined });
  }
  await globalThis.__forgexDb.ready;
  return globalThis.__forgexDb.db;
}

/**
 * Closes the process-wide database for good, so the process can be stopped without an unclean database shutdown:
 * the desktop app asks for this before stopping a backend it started, and such a backend does it itself if the app
 * disappears. Returns false when none was open.
 */
export async function closeDb(): Promise<boolean> {
  globalThis.__forgexDbClosed = true;
  const handle = globalThis.__forgexDb;
  if (!handle) return false;
  globalThis.__forgexDb = undefined;
  await handle.ready.catch(() => {});
  await handle.close();
  return true;
}

export { schema };
