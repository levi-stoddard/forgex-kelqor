import { eq, isNotNull, isNull } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../auth/password";
import type { DB } from "../db";
import { missionApprovals, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { normalizeEmail } from "../domain/accounts";
import { DomainError } from "../domain/errors";
import { recordEvent } from "../domain/records";
import type { FounderAuthority } from "../missions/contract";
import { inTransaction, lockSpending } from "./shared";

// Owner spending authority. One account at most holds it (a partial unique index), and the database refuses it for
// demo accounts, non-operators and accounts whose sign-in is off (a check). It is granted and revoked only by
// `npm run designate-founder`, run while KELQOR is closed, with that account's password; no route or screen calls
// designateFounder or revokeFounder. Moving or revoking it voids every open approval. Both are written to the audit log.


export interface FounderRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isDemo: boolean;
  signInDisabledAt: Date | null;
  spendingAuthorityAt: Date;
}

const founderColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  isDemo: users.isDemo,
  signInDisabledAt: users.signInDisabledAt,
  spendingAuthorityAt: users.spendingAuthorityAt,
};

/** The account holding owner spending authority, if it is still a non-demo operator with sign-in on. */
export async function founderRow(db: DB): Promise<FounderRow | null> {
  const rows = await db.select(founderColumns).from(users).where(isNotNull(users.spendingAuthorityAt)).limit(2);
  if (rows.length !== 1) return null;
  const u = rows[0];
  if (u.role !== "operator" || u.isDemo || u.signInDisabledAt || !u.spendingAuthorityAt) return null;
  return { ...u, spendingAuthorityAt: u.spendingAuthorityAt };
}

export async function founderAuthority(db: DB): Promise<FounderAuthority | null> {
  const u = await founderRow(db);
  return u ? { userId: u.id, name: u.name, email: u.email, since: u.spendingAuthorityAt.toISOString() } : null;
}

export async function isFounder(db: DB, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  return (await founderRow(db))?.id === userId;
}

export async function assertFounder(db: DB, actor: Actor): Promise<void> {
  if (!actor || actor.role !== "operator" || !actor.id || !(await isFounder(db, actor.id))) {
    throw new DomainError(
      "Only the owner's account can approve, start, resume or cancel AI missions, add Claude review, or settle AI spending.",
      "forbidden",
    );
  }
}

/** Voids every approval still open, everywhere: when authority moves or is revoked. */
export async function voidAllOpenApprovals(tx: DB, reason: string, now: Date): Promise<number> {
  const done = await tx
    .update(missionApprovals)
    .set({ voidedAt: now, voidReason: reason })
    .where(isNull(missionApprovals.voidedAt))
    .returning({ id: missionApprovals.id });
  return done.length;
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isDemo: boolean;
  signInDisabledAt: Date | null;
  passwordHash: string;
}

/** The account for an email and password, or a single error that doesn't reveal which part was wrong. */
async function verifiedAccount(db: DB, email: string, password: string): Promise<AccountRow> {
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isDemo: users.isDemo, signInDisabledAt: users.signInDisabledAt, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  const ok = u ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false);
  if (!u || !ok) throw new DomainError("That email and password don't match an account.", "forbidden");
  return u;
}

function assertEligible(u: { role: string; isDemo: boolean; signInDisabledAt: Date | null; email: string }) {
  if (u.role !== "operator") throw new DomainError(`${u.email} isn't an operator account; only an operator can hold owner spending authority.`, "forbidden");
  if (u.isDemo) throw new DomainError(`${u.email} is a demo account; a demo account can never hold owner spending authority.`, "forbidden");
  if (u.signInDisabledAt) throw new DomainError(`Sign-in is turned off for ${u.email}, so it can't hold owner spending authority.`, "forbidden");
}

/**
 * Gives `to` owner spending authority inside `tx`, taking it from the current holder when `replace` is set. Used by
 * designateFounder (after the password check) and by the acceptance copy's preparation.
 */
export async function moveAuthority(
  tx: DB,
  to: { id: string; name: string; email: string; role: string; isDemo: boolean; signInDisabledAt: Date | null },
  opts: { replace: boolean; via: string; now?: Date },
): Promise<FounderAuthority> {
  assertEligible(to);
  await lockSpending(tx);
  const [current] = await tx.select(founderColumns).from(users).where(isNotNull(users.spendingAuthorityAt)).limit(1);
  if (current && current.id === to.id) return { userId: to.id, name: to.name, email: to.email, since: current.spendingAuthorityAt!.toISOString() };
  if (current && !opts.replace) {
    throw new DomainError(`${current.email} already holds owner spending authority. Run the command again with --replace to move it to ${to.email}.`, "conflict");
  }
  const now = opts.now ?? new Date();
  if (current) {
    await tx.update(users).set({ spendingAuthorityAt: null }).where(eq(users.id, current.id));
    const voided = await voidAllOpenApprovals(tx, "Owner spending authority moved to another account.", now);
    await recordEvent(tx, { actorId: current.id, type: "founder_authority_revoked", data: { email: current.email, movedTo: to.email, approvalsVoided: voided, via: opts.via } });
  }
  await tx.update(users).set({ spendingAuthorityAt: now }).where(eq(users.id, to.id));
  await recordEvent(tx, { actorId: to.id, type: "founder_authority_granted", data: { email: to.email, replaced: current?.email ?? null, via: opts.via } });
  return { userId: to.id, name: to.name, email: to.email, since: now.toISOString() };
}

// The seed script's demo accounts share one password: SEED_PASSWORD, or a random one it prints once (scripts/seed.ts).
// No password is written in the repository. When SEED_PASSWORD is set, it is never accepted as an owner's.
function refuseSeedPassword(password: string) {
  const seed = process.env.SEED_PASSWORD;
  if (seed && password === seed) {
    throw new DomainError("That is the seed script's demo password (SEED_PASSWORD), shared by every demo account. Give the account its own password first, then designate it.", "invalid");
  }
}

/** For `npm run designate-founder` only: grants owner spending authority to the account with this email and password. */
export async function designateFounder(db: DB, input: { email: string; password: string; replace?: boolean }): Promise<FounderAuthority> {
  refuseSeedPassword(input.password);
  const u = await verifiedAccount(db, input.email, input.password);
  return inTransaction(db, (tx) => moveAuthority(tx, u, { replace: Boolean(input.replace), via: "npm run designate-founder" }));
}

/** For `npm run designate-founder -- --revoke` only: the owner gives up spending authority, with their password. */
export async function revokeFounder(db: DB, input: { email: string; password: string }): Promise<void> {
  const u = await verifiedAccount(db, input.email, input.password);
  await inTransaction(db, async (tx) => {
    await lockSpending(tx);
    const [current] = await tx.select({ id: users.id }).from(users).where(isNotNull(users.spendingAuthorityAt)).limit(1);
    if (!current || current.id !== u.id) throw new DomainError(`${u.email} doesn't hold owner spending authority.`, "conflict");
    const now = new Date();
    await tx.update(users).set({ spendingAuthorityAt: null }).where(eq(users.id, u.id));
    const voided = await voidAllOpenApprovals(tx, "Owner spending authority was revoked.", now);
    await recordEvent(tx, { actorId: u.id, type: "founder_authority_revoked", data: { email: u.email, approvalsVoided: voided, via: "npm run designate-founder -- --revoke" } });
  });
}
