import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hashPassword, passwordProblem } from "../auth/password";
import type { DB } from "../db";
import { invites, orgs, users, workOrders } from "../db/schema";
import { normalizeEmail } from "./accounts";
import type { Actor } from "./actor";
import { assert, DomainError } from "./errors";
import { newId, notify, recordEvent } from "./records";
import { DATA_CLASSES, DATA_CLASS_LABELS, TERMINAL_STATUSES, type DataClass } from "./types";

// Owner-led selling: after a sales call an operator writes up the Work Order and sends the client a one-time
// link. The client sets a password and lands on their quote; they never have to fill in a sign-up form.

const INVITE_DAYS = 14;
/** Stored instead of a password hash until the invite is accepted; it never verifies, so sign-in fails. */
export const PENDING_PASSWORD = "!invite-pending";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const appUrl = () => process.env.APP_URL || "http://localhost:3000";
export const inviteUrl = (token: string) => `${appUrl()}/invite/${token}`;

function requireOperator(actor: Actor) {
  if (actor.role !== "operator") throw new DomainError("You don't have permission to do that.", "forbidden");
}

export async function createClientForSale(
  db: DB,
  actor: Actor,
  input: { companyName: string; contactName: string; email: string; industry?: string; sizeBand?: string; dataClass: DataClass | "" },
): Promise<{ orgId: string; userId: string }> {
  requireOperator(actor);
  // Stated every time, never guessed: a company written up by hand is either a real customer or a test record.
  const dataClass = input.dataClass === "real" || input.dataClass === "test" ? input.dataClass : null;
  assert(dataClass, "Say whether this is a real customer or a test record.");
  const email = normalizeEmail(input.email);
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Enter the client contact's email address.");
  assert(input.companyName.trim().length >= 2, "Enter the client's company name.");
  assert(input.contactName.trim().length >= 2, "Enter the contact's name.");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  assert(!existing, "That email already has a ForgeX account. Choose their company from the list instead.", "conflict");
  const orgId = newId();
  const userId = newId();
  await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.insert(orgs).values({
      id: orgId,
      name: input.companyName.trim(),
      industry: input.industry?.trim() || null,
      sizeBand: input.sizeBand?.trim() || null,
      dataClass,
    });
    await tx.insert(users).values({ id: userId, email, name: input.contactName.trim(), passwordHash: PENDING_PASSWORD, role: "client", orgId });
    await recordEvent(tx, { actorId: actor.id, type: "client_created_by_operator", data: { orgId, userId } });
  });
  return { orgId, userId };
}

/**
 * A fresh one-time link for a client who hasn't set a password yet. Older open links for that person stop
 * working. Accounts that are already active sign in normally, so a link can never be used to take one over.
 */
export async function issueInvite(db: DB, actor: Actor, input: { userId: string; workOrderId?: string | null }): Promise<string> {
  requireOperator(actor);
  const [u] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  assert(u && u.role === "client", "Invitations are only for client contacts.", "not_found");
  assert(u.passwordHash === PENDING_PASSWORD, "This contact already has an active account; send them the Work Order link instead.", "conflict");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.userId, u.id), isNull(invites.usedAt), isNull(invites.revokedAt)));
    await tx.insert(invites).values({
      id: newId(),
      tokenHash: tokenHash(token),
      userId: u.id,
      workOrderId: input.workOrderId ?? null,
      createdById: actor.id!,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
    });
    await notify(tx, u.email, {
      subject: "Your ForgeX Work Order is ready to review",
      body: `${actor.name} wrote up the Work Order you discussed. Set a password to see the scope, the acceptance criteria and the fixed price.`,
      link: inviteUrl(token),
      workOrderId: input.workOrderId ?? null,
    });
  });
  return token;
}

/** The open invite behind a token, or null when it is unknown, used, revoked or expired. */
export async function findInvite(db: DB, token: string) {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ id: invites.id, userId: invites.userId, workOrderId: invites.workOrderId, name: users.name, email: users.email, orgName: orgs.name })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.userId))
    .innerJoin(orgs, sql`${orgs.id} = ${users.orgId}`)
    .where(and(eq(invites.tokenHash, tokenHash(token)), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function acceptInvite(
  db: DB,
  token: string,
  input: { name: string; password: string },
): Promise<{ userId: string; workOrderId: string | null }> {
  const found = await findInvite(db, token);
  assert(found, "This link has expired or was already used. Ask ForgeX for a new one.", "not_found");
  const problem = passwordProblem(input.password);
  assert(!problem, problem ?? "");
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    const [claimed] = await tx
      .update(invites)
      .set({ usedAt: new Date() })
      .where(and(eq(invites.id, found.id), isNull(invites.usedAt), isNull(invites.revokedAt)))
      .returning({ id: invites.id });
    assert(claimed, "This link was just used. Sign in instead.", "conflict");
    await tx
      .update(users)
      .set({ passwordHash, name: input.name.trim().length >= 2 ? input.name.trim() : found.name })
      .where(and(eq(users.id, found.userId), eq(users.passwordHash, PENDING_PASSWORD)));
    await recordEvent(tx, { workOrderId: found.workOrderId, actorId: found.userId, type: "invite_accepted" });
  });
  return { userId: found.userId, workOrderId: found.workOrderId };
}

/** Client companies an operator can write a Work Order for. */
export async function listClientCompanies(db: DB, actor: Actor) {
  requireOperator(actor);
  return db.select({ id: orgs.id, name: orgs.name, isDemo: orgs.isDemo, dataClass: orgs.dataClass }).from(orgs).orderBy(orgs.name);
}

/** Every client company with its contacts and Work Order counts, for the operator's workspace. */
export async function listCompanyDirectory(db: DB, actor: Actor) {
  requireOperator(actor);
  const companies = await db.select().from(orgs).orderBy(orgs.name);
  const contacts = await db
    .select({ orgId: users.orgId, name: users.name, email: users.email, activated: sql<boolean>`(${users.passwordHash} not like '!%')` })
    .from(users)
    .where(eq(users.role, "client"));
  const orders = await db.select({ orgId: workOrders.orgId, status: workOrders.status }).from(workOrders);
  return companies.map((c) => {
    const mine = orders.filter((o) => o.orgId === c.id);
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      industry: c.industry,
      sizeBand: c.sizeBand,
      isDemo: c.isDemo,
      dataClass: c.dataClass,
      createdAt: c.createdAt,
      contacts: contacts.filter((u) => u.orgId === c.id).map(({ orgId: _o, ...u }) => u),
      orders: mine.length,
      openOrders: mine.filter((o) => !(TERMINAL_STATUSES as readonly string[]).includes(o.status)).length,
    };
  });
}

/**
 * Correct a company's class (real, demo or test), audited. Its orders, payments and monthly plans move with it, so a
 * test record marked real starts counting, and a real one marked test stops.
 */
export async function setCompanyDataClass(db: DB, actor: Actor, input: { orgId: string; dataClass: DataClass }) {
  requireOperator(actor);
  assert((DATA_CLASSES as readonly string[]).includes(input.dataClass), "Choose real, demo or test.");
  const [org] = await db.select({ id: orgs.id, name: orgs.name, dataClass: orgs.dataClass }).from(orgs).where(eq(orgs.id, input.orgId)).limit(1);
  assert(org, "Company not found.", "not_found");
  if (org.dataClass === input.dataClass) return { id: org.id, dataClass: org.dataClass };
  await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.update(orgs).set({ dataClass: input.dataClass }).where(eq(orgs.id, org.id));
    await recordEvent(tx, {
      actorId: actor.id,
      type: "company_reclassified",
      data: { orgId: org.id, name: org.name, from: org.dataClass, to: input.dataClass, label: DATA_CLASS_LABELS[input.dataClass] },
    });
  });
  return { id: org.id, dataClass: input.dataClass };
}
