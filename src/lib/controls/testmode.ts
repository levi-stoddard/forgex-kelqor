import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PGLITE_DIR, dbLocation, type DB } from "../db";
import { SpendRefused } from "../missions/contract";

// Test mode. The synthetic-cost provider, local test pages and clock overrides exist for automated tests and the
// acceptance run only. They are honored on an in-memory database, or on an isolated copy that the acceptance run
// marked with a .kelqor-test-copy file, outside the project's .data folder. The owner's own database, a database
// in .data, a DATABASE_URL database and any handle the controls can't place are always refused.

export const TEST_COPY_MARKER = ".kelqor-test-copy";

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

function real(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

const inside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(`${p}/`);
};

/**
 * Why a database folder isn't a usable isolated test copy, or null when it is: it must exist, lie outside the
 * project's .data folder (where the owner's own database lives), and hold the acceptance run's marker file.
 */
export function testCopyProblem(dirInput: string): string | null {
  const dir = real(dirInput);
  if (!dir) return `${dirInput} doesn't exist.`;
  const dataDir = path.join(process.cwd(), ".data");
  const refused = [dataDir, real(dataDir), DEFAULT_PGLITE_DIR(), real(DEFAULT_PGLITE_DIR()), process.env.KELQOR_REAL_DATA_DIR].filter((p): p is string => Boolean(p));
  if (refused.some((p) => inside(dir, p) || inside(dirInput, p))) return `${dirInput} is inside the project's .data folder, where your own database lives.`;
  if (!fs.existsSync(path.join(dir, TEST_COPY_MARKER))) return `${dirInput} has no ${TEST_COPY_MARKER} file, so it isn't marked as an isolated test copy.`;
  return null;
}

/** True only for an in-memory database or a marked isolated copy outside the project's .data folder. */
export function isTestDatabase(db: DB): boolean {
  const loc = dbLocation(db);
  if (!loc) return false;
  if (loc.kind === "memory") return true;
  if (loc.kind !== "dir" || loc.isDefault) return false;
  return testCopyProblem(loc.dir) === null;
}

export function assertTestDatabase(db: DB): void {
  if (!isTestDatabase(db)) {
    throw new SpendRefused("test_only", "That is test-only, and this database isn't an in-memory test database or a marked isolated copy, so it was refused.");
  }
}

const switchedOn = (v: string | undefined) => v !== undefined && v.trim() !== "" && v.trim() !== "0";

/**
 * The test switches: KELQOR_SYNTHETIC_COSTS=1 and KELQOR_TEST_PAGES=<dir>. Throws SpendRefused("test_only") when one is
 * on and the database isn't a test database, so the backend refuses to run that way against your own data.
 */
export function testMode(db: DB, env: Record<string, string | undefined> = process.env): { syntheticCosts: boolean; testPagesDir: string | null } {
  const syntheticCosts = switchedOn(env.KELQOR_SYNTHETIC_COSTS);
  const pages = switchedOn(env.KELQOR_TEST_PAGES) ? env.KELQOR_TEST_PAGES!.trim() : null;
  if ((syntheticCosts || pages) && !isTestDatabase(db)) {
    throw new SpendRefused(
      "test_only",
      "Test mode is switched on (KELQOR_SYNTHETIC_COSTS or KELQOR_TEST_PAGES), but this database isn't an in-memory test database or a marked isolated copy. KELQOR refuses to run that way against your own data.",
    );
  }
  return { syntheticCosts, testPagesDir: pages ? path.resolve(pages) : null };
}

/** The clock the controls use: the real one, or a test's, which is honored on test databases only. */
export function clockFor(db: DB, override: (() => Date) | Date | undefined): () => Date {
  if (override === undefined) return () => new Date();
  assertTestDatabase(db);
  return typeof override === "function" ? override : () => new Date(override.getTime());
}
