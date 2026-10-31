import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Milestone 5 groundwork: restoring the embedded database from a verified backup (made by `npm run db:backup`).
// Nothing is deleted: the database being replaced is moved aside, beside it, and the backup itself is left as it was.
// Every file is checked against the backup's own manifest before and after the copy.

interface Manifest {
  files: number;
  files_sha256: { file: string; bytes: number; sha256: string }[];
}

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/** The backup's files match its manifest exactly. Returns what is wrong, or null. */
export function verifyBackup(backupDir: string): string | null {
  const mf = path.join(backupDir, "BACKUP.json");
  if (!fs.existsSync(mf)) return `${backupDir} has no BACKUP.json, so it isn't a verified backup.`;
  const manifest = JSON.parse(fs.readFileSync(mf, "utf8")) as Manifest;
  const present = files(backupDir).filter((f) => f !== "BACKUP.json");
  if (present.length !== manifest.files_sha256.length) return `The backup holds ${present.length} files; its manifest lists ${manifest.files_sha256.length}.`;
  for (const f of manifest.files_sha256) {
    const full = path.join(backupDir, f.file);
    if (!fs.existsSync(full)) return `${f.file} is missing from the backup.`;
    if (fs.statSync(full).size !== f.bytes || sha(full) !== f.sha256) return `${f.file} in the backup doesn't match its manifest.`;
  }
  return null;
}

/**
 * Replaces `target` with the backup. The current `target` is renamed to `<target>-replaced-<stamp>` first, so the
 * restore can itself be undone; the result is then checked file by file against the backup's manifest.
 */
export function restoreBackup(backupDir: string, target: string, now = new Date()): { movedAside: string | null; files: number } {
  const problem = verifyBackup(backupDir);
  if (problem) throw new Error(`${problem} Nothing was restored.`);
  if (path.resolve(backupDir) === path.resolve(target)) throw new Error("The backup and the database are the same folder. Nothing was restored.");
  let movedAside: string | null = null;
  if (fs.existsSync(target)) {
    movedAside = `${target}-replaced-${now.toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(target, movedAside);
  }
  try {
    fs.cpSync(backupDir, target, { recursive: true, filter: (src) => path.basename(src) !== "BACKUP.json" || path.dirname(src) !== backupDir });
  } catch (e) {
    throw new Error(`The restore stopped while copying (${e instanceof Error ? e.message : String(e)}). ${movedAside ? `The database it was replacing is kept at ${movedAside}.` : ""}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "BACKUP.json"), "utf8")) as Manifest;
  for (const f of manifest.files_sha256) {
    const full = path.join(target, f.file);
    if (!fs.existsSync(full) || sha(full) !== f.sha256) throw new Error(`The restored ${f.file} doesn't match the backup. The replaced database is kept at ${movedAside}.`);
  }
  return { movedAside, files: manifest.files_sha256.length };
}
