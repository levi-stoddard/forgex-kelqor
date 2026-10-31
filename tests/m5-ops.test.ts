import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "@/lib/db";
import type { Actor } from "@/lib/domain/actor";
import { createUserWithRole } from "@/lib/domain/accounts";
import { exportCustomer } from "@/lib/ops/export";
import { restoreBackup, verifyBackup } from "@/lib/ops/restore";
import { addService, onboardCustomer, setServiceStatus, submitRequest } from "@/lib/services/service";
import { actorFor, freshDb, TEST_PASSWORD } from "./helpers";

// Milestone 5 groundwork: a verified restore that never deletes, and an export of one customer that holds only that
// customer's records.

const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** A backup folder in `npm run db:backup`'s format. */
function makeBackup(dir: string, contents: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const list = Object.keys(contents).sort().map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size, sha256: sha(path.join(dir, f)) }));
  fs.writeFileSync(path.join(dir, "BACKUP.json"), JSON.stringify({ files: list.length, files_sha256: list }));
}

describe("restoring a backup", () => {
  it("replaces the database with a verified backup, keeping the replaced one beside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-restore-"));
    const backup = path.join(root, "pglite-backup");
    const target = path.join(root, "pglite");
    makeBackup(backup, { PG_VERSION: "17", "base/1/1259": "catalog", "global/pg_control": "control" });
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "PG_VERSION"), "newer data");
    const r = restoreBackup(backup, target, new Date("2026-10-28T20:00:00Z"));
    expect(r.files).toBe(3);
    expect(fs.readFileSync(path.join(target, "base/1/1259"), "utf8")).toBe("catalog");
    expect(fs.existsSync(path.join(target, "BACKUP.json"))).toBe(false);
    expect(fs.readFileSync(path.join(r.movedAside!, "PG_VERSION"), "utf8")).toBe("newer data");
    expect(fs.existsSync(path.join(backup, "BACKUP.json"))).toBe(true);
  });

  it("refuses a backup that doesn't match its manifest, and changes nothing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelqor-restore-"));
    const backup = path.join(root, "pglite-backup");
    const target = path.join(root, "pglite");
    makeBackup(backup, { PG_VERSION: "17", "base/1/1259": "catalog" });
    fs.writeFileSync(path.join(backup, "base/1/1259"), "tampered");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "PG_VERSION"), "current");
    expect(verifyBackup(backup)).toMatch(/doesn't match/);
    expect(() => restoreBackup(backup, target)).toThrow(/Nothing was restored/);
    expect(fs.readFileSync(path.join(target, "PG_VERSION"), "utf8")).toBe("current");
    expect(fs.readdirSync(root).sort()).toEqual(["pglite", "pglite-backup"]);
    expect(() => restoreBackup(path.join(root, "nowhere"), target)).toThrow(/no BACKUP.json/);
  });
});

describe("exporting one customer", () => {
  let db: DB;
  let close: () => Promise<void>;
  let operator: Actor;
  beforeAll(async () => {
    const h = await freshDb();
    db = h.db;
    close = h.close;
    operator = await actorFor(db, await createUserWithRole(db, { name: "Olive Operator", email: "olive@test.local", password: TEST_PASSWORD, role: "operator" }));
  });
  afterAll(async () => close());

  it("holds only that customer's records, and no password hashes", async () => {
    const a = await onboardCustomer(db, operator, { companyName: "Alpha Welding (synthetic)", contactName: "Al Pha", email: "al@alpha.test", dataClass: "test" });
    const b = await onboardCustomer(db, operator, { companyName: "Beta Coatings (synthetic)", contactName: "Bea Ta", email: "bea@beta.test", dataClass: "test" });
    for (const o of [a, b]) {
      const s = await addService(db, operator, { orgId: o.orgId, category: "quote_intake", planKey: "starter" }, randomUUID());
      await setServiceStatus(db, operator, s.id, "activate", randomUUID());
      await submitRequest(db, operator, { serviceId: s.id, text: `A quote request for ${o.orgId}: 3 steel brackets by Dec 1.` }, randomUUID());
    }
    const out = await exportCustomer(db, a.orgId);
    const text = JSON.stringify(out);
    expect(out.organization.id).toBe(a.orgId);
    expect(out.services).toHaveLength(1);
    expect(out.requests).toHaveLength(1);
    expect(out.people.map((p) => p.email)).toEqual(["al@alpha.test"]);
    expect(text).not.toContain(b.orgId);
    expect(text).not.toContain("Beta Coatings");
    expect(text).not.toMatch(/passwordHash|password_hash|scrypt|\$argon/);
    // Customer-visible only: none of KELQOR's processing internals, drafts, review notes or costs.
    expect(text).not.toMatch(/"processing"|"draft"|reviewNote|aiCostMicros|reviewMinutes|"dataClass"/);
  });
});
