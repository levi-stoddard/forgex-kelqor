import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { assertFounder } from "../controls";
import { dbLocation, type DB } from "../db";
import { engWorkspaces } from "../db/schema";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import type { EngWorkspaceView } from "./contract";
import { commitOf, git, repositoryRoot } from "./git";

// The git workspaces engineering missions may work on. Only the owner registers one, only a repository's top folder
// qualifies, and KELQOR's own data folders never do. KELQOR also keeps a small demo repository of its own, so the
// complete workflow can be shown with the simulated agent without touching any real project.

/**
 * Where mission worktrees and the demo workspace live. Beside the database: <data>/engineering for your own database,
 * <copy>-engineering for an isolated test copy, and a temporary folder for an in-memory test database.
 */
export function engineeringDir(db: DB): string {
  if (process.env.KELQOR_ENG_DIR) return path.resolve(process.env.KELQOR_ENG_DIR);
  const loc = dbLocation(db);
  if (loc?.kind === "dir") return loc.isDefault ? path.join(path.dirname(loc.dir), "engineering") : `${loc.dir}-engineering`;
  if (loc?.kind === "memory") return path.join(os.tmpdir(), `kelqor-engineering-${process.pid}`);
  return path.join(process.cwd(), ".data", "engineering");
}

export const worktreeDir = (db: DB, missionId: string) => path.join(engineeringDir(db), "worktrees", missionId);

const view = (r: typeof engWorkspaces.$inferSelect): EngWorkspaceView => ({
  id: r.id,
  name: r.name,
  path: r.path,
  baseBranch: r.baseBranch,
  demo: r.demo,
  createdAt: r.createdAt.toISOString(),
});

export async function listWorkspaces(db: DB): Promise<EngWorkspaceView[]> {
  return (await db.select().from(engWorkspaces).orderBy(asc(engWorkspaces.createdAt))).map(view);
}

export async function workspaceById(db: DB, id: string): Promise<EngWorkspaceView | null> {
  const [r] = await db.select().from(engWorkspaces).where(eq(engWorkspaces.id, id)).limit(1);
  return r ? view(r) : null;
}

const under = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Registers a repository the owner chooses. Its branch must exist; nothing in it is changed. */
export async function addWorkspace(db: DB, actor: Actor, input: { name: string; path: string; baseBranch: string }): Promise<EngWorkspaceView> {
  await assertFounder(db, actor);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new DomainError("Give the workspace a name of 2 to 80 characters.");
  const dir = path.resolve(input.path.trim());
  // KELQOR's own data, mission worktrees and system folders are never workspaces.
  const forbidden = [path.join(process.cwd(), ".data"), engineeringDir(db), os.homedir() === dir ? dir : null, process.env.SystemRoot ?? null, process.env.ProgramFiles ?? null].filter(Boolean) as string[];
  if (forbidden.some((f) => under(dir, f) || dir === path.parse(dir).root)) throw new DomainError("That folder can't be an engineering workspace.");
  const root = await repositoryRoot(dir);
  if (!root) throw new DomainError("That folder isn't the top folder of a git repository (a linked worktree doesn't count).");
  const branch = input.baseBranch.trim();
  await commitOf(root, branch).catch(() => {
    throw new DomainError(`The repository has no branch "${branch}".`);
  });
  const [existing] = await db.select().from(engWorkspaces).where(eq(engWorkspaces.path, root)).limit(1);
  if (existing) throw new DomainError("That repository is already registered.", "conflict");
  const [row] = await db.insert(engWorkspaces).values({ id: randomUUID(), name, path: root, baseBranch: branch, demo: false, createdById: actor.id! }).returning();
  return view(row);
}

const DEMO_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "kelqor-demo-workspace", private: true, version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "README.md": "# KELQOR demo workspace\n\nA small project KELQOR creates for simulated engineering missions. It isn't a real project.\n",
  "src/pricing.js": "// Quote pricing for the demo shop.\nexport function quoteTotal(hours, rate) {\n  return hours * rate;\n}\n",
  "test/pricing.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { quoteTotal } from "../src/pricing.js";\n\ntest("a quote is hours times the rate", () => {\n  assert.equal(quoteTotal(3, 95), 285);\n});\n',
};

/** KELQOR's demo repository, created once and registered on first use. */
export async function demoWorkspace(db: DB, actor: Actor): Promise<EngWorkspaceView> {
  const [found] = await db.select().from(engWorkspaces).where(eq(engWorkspaces.demo, true)).limit(1);
  if (found && fs.existsSync(path.join(found.path, ".git"))) return view(found);
  const dir = path.join(engineeringDir(db), "demo-workspace");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(DEMO_FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    await git(dir, ["init", "--initial-branch=main"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=KELQOR", "-c", "user.email=kelqor@localhost", "commit", "--no-verify", "-m", "KELQOR demo workspace"]);
  }
  if (found) {
    await db.update(engWorkspaces).set({ path: dir }).where(eq(engWorkspaces.id, found.id));
    return view({ ...found, path: dir });
  }
  const [row] = await db.insert(engWorkspaces).values({ id: randomUUID(), name: "KELQOR demo workspace (simulated missions)", path: path.resolve(dir), baseBranch: "main", demo: true, createdById: actor.id! }).returning();
  return view(row);
}
