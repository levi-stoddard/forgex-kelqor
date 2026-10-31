// Backs up the embedded database before a migration: copies .data/pglite to .data/pglite-backup-<date>-<label>,
// checks the copy file by file (size and SHA-256), and records the verified backup in .data/backup-approval.json.
// The backend applies pending migrations to your own database only with that record, and only while the database
// hasn't changed since the backup (src/lib/db/index.ts).
//   npm run db:backup -- --label pre-m2b
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKUP_APPROVAL_FILE, DEFAULT_PGLITE_DIR, MIGRATIONS_FOLDER } from "../src/lib/db";
import { refuseWhileBackendRuns } from "./local-backend-guard";

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

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main() {
  await refuseWhileBackendRuns("Nothing was backed up.");
  const labelAt = process.argv.indexOf("--label");
  const label = (labelAt > 0 ? process.argv[labelAt + 1] : "manual") ?? "manual";
  if (!/^[a-z0-9-]{2,40}$/.test(label)) throw new Error("--label takes lowercase letters, digits and dashes.");
  const src = DEFAULT_PGLITE_DIR();
  if (!fs.existsSync(src)) throw new Error(`There is no database at ${src}.`);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Boise", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dest = path.join(path.dirname(src), `pglite-backup-${day}-${label}`);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists; nothing was overwritten.`);
  const startedAt = new Date();
  const before = files(src).map((f) => ({ file: f, bytes: fs.statSync(path.join(src, f)).size, sha256: sha(path.join(src, f)) }));
  fs.cpSync(src, dest, { recursive: true });
  const after = files(dest).map((f) => ({ file: f, bytes: fs.statSync(path.join(dest, f)).size, sha256: sha(path.join(dest, f)) }));
  const same = before.length === after.length && before.every((b, i) => after[i].file === b.file && after[i].bytes === b.bytes && after[i].sha256 === b.sha256);
  if (!same) {
    throw new Error(`The copy in ${dest} doesn't match the database file for file. It was kept for inspection; no migration was approved.`);
  }
  // Nothing may have written to the database while it was copied.
  const again = files(src).map((f) => sha(path.join(src, f)));
  if (again.length !== before.length || again.some((h, i) => h !== before[i].sha256)) {
    throw new Error("The database changed while it was being copied. Close every program that uses it and run this again.");
  }
  const bytes = before.reduce((n, f) => n + f.bytes, 0);
  const manifest = { source: src, label, createdAt: startedAt.toISOString(), files: before.length, bytes, files_sha256: before };
  fs.writeFileSync(path.join(dest, "BACKUP.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const tags = (JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] }).entries.map((e) => e.tag);
  fs.writeFileSync(BACKUP_APPROVAL_FILE(), `${JSON.stringify({ backupDir: dest, verifiedAt: new Date().toISOString(), covers: tags }, null, 2)}\n`);
  console.log(`Backed up ${before.length} files (${(bytes / 1e6).toFixed(1)} MB) to ${dest}, verified file by file.`);
  console.log(`The backend may now apply migrations up to ${tags.at(-1)} to your database, until it changes again.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
