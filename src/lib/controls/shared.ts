import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { DB } from "../db";

// Helpers shared by the controls. Every control write runs in its own transaction, or in a savepoint when it is
// given a transaction, and never touches any other handle meanwhile: on PGlite, a query on the outer database inside
// a transaction waits for that same transaction forever.

/** True for a transaction handle (drizzle's PgTransaction), which meteredRequest refuses. */
export function isTransactionHandle(db: DB): boolean {
  return (db as unknown) instanceof PgTransaction;
}

/** Runs `fn` in a transaction, or in a savepoint of the caller's transaction. */
export function inTransaction<T>(db: DB, fn: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction(async (raw) => fn(raw as unknown as DB));
}

/** The spending lock: reservations, approvals and reconciliation writes pass through it one at a time. */
const SPENDING_LOCK = 1_262_832_721; // "KELQ"

export async function lockSpending(tx: DB): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SPENDING_LOCK})`);
}

/** The Postgres error code (such as 23505, a unique violation) of a query error, wherever the driver put it. */
export function pgErrorCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

declare global {
  var __kelqorBackendInstance: string | undefined;
}

/** This backend process's id, on every reservation it makes; recovery at start-up leaves this process's own rows alone. */
export function backendInstance(): string {
  globalThis.__kelqorBackendInstance ??= randomUUID();
  return globalThis.__kelqorBackendInstance;
}

const CREDENTIAL =
  /AIza[0-9A-Za-z_-]{35}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|\bghp_[A-Za-z0-9]{36}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;

/** Error text as stored: every secret in the environment and anything shaped like a credential removed, then cut. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env, max = 1000): string {
  let out = String(text);
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    out = out.split(value).join("[redacted]");
  }
  return out.replace(CREDENTIAL, "[redacted]").slice(0, max);
}

export const toIso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function asCount(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error("A database total isn't a whole number.");
  return n;
}
