import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { builderProfiles, orgs, users } from "../db/schema";
import { safeUrl } from "../format";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password";
import { uniqueSlug } from "./builders";
import { assert, DomainError } from "./errors";
import { newId, notifyOperators, recordEvent } from "./records";
import type { Role } from "./types";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function assertNewAccount(db: DB, email: string, password: string, name: string): Promise<void> {
  assert(name.trim().length >= 2, "Enter your name.");
  assert(EMAIL_RE.test(email) && email.length <= 254, "Enter a valid email address.");
  const problem = passwordProblem(password);
  assert(!problem, problem ?? "");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  assert(!existing, "An account with that email already exists. Sign in instead.", "conflict");
}

export async function registerClient(
  db: DB,
  input: { name: string; email: string; password: string; companyName: string; industry?: string; sizeBand?: string; website?: string },
  opts: { isDemo?: boolean } = {},
): Promise<{ userId: string; orgId: string }> {
  const email = normalizeEmail(input.email);
  await assertNewAccount(db, email, input.password, input.name);
  assert(input.companyName.trim().length >= 2, "Enter your company name.");
  const website = input.website?.trim() ? safeUrl(input.website.includes("://") ? input.website : `https://${input.website}`) : null;
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const orgId = newId();
    const userId = newId();
    await tx.insert(orgs).values({
      id: orgId,
      name: input.companyName.trim(),
      industry: input.industry?.trim() || null,
      sizeBand: input.sizeBand?.trim() || null,
      website,
      isDemo: opts.isDemo ?? false,
      // A public sign-up is a real prospect; only the seed makes demo companies. An operator can correct either.
      dataClass: opts.isDemo ? "demo" : "real",
    });
    await tx.insert(users).values({ id: userId, email, name: input.name.trim(), passwordHash, role: "client", orgId, isDemo: opts.isDemo ?? false });
    await recordEvent(tx as unknown as DB, { actorId: userId, type: "client_registered", data: { orgId } });
    return { userId, orgId };
  });
}

export async function registerBuilder(
  db: DB,
  input: { name: string; email: string; password: string; headline: string; skills: string[]; links: string[]; sampleWork: string; country?: string },
  opts: { isDemo?: boolean } = {},
): Promise<{ userId: string; builderId: string }> {
  const email = normalizeEmail(input.email);
  await assertNewAccount(db, email, input.password, input.name);
  assert(input.headline.trim().length >= 5, "Add a one-line headline about what you build.");
  assert(input.sampleWork.trim().length >= 40, "Describe a recent automation you shipped (at least a few sentences).");
  const links = input.links.map((l) => l.trim()).filter(Boolean).map((l) => safeUrl(l));
  assert(links.every(Boolean), "Portfolio links must be valid http(s) URLs.");
  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(db, input.name);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    const userId = newId();
    const builderId = newId();
    await tx.insert(users).values({ id: userId, email, name: input.name.trim(), passwordHash, role: "builder", isDemo: opts.isDemo ?? false });
    await tx.insert(builderProfiles).values({
      id: builderId,
      userId,
      slug,
      headline: input.headline.trim().slice(0, 120),
      skills: input.skills.map((s) => s.trim()).filter(Boolean).slice(0, 15),
      links: links as string[],
      sampleWork: input.sampleWork.trim().slice(0, 4000),
      country: input.country?.trim() || null,
    });
    await recordEvent(tx, { actorId: userId, type: "builder_applied", data: { builderId } });
    await notifyOperators(tx, {
      subject: `New builder application: ${input.name.trim()}`,
      body: `${input.headline.trim()}. Review it under Builders.`,
      link: `${process.env.APP_URL || "http://localhost:3000"}/ops/builders`,
    });
    return { userId, builderId };
  });
}

export async function createUserWithRole(
  db: DB,
  input: { name: string; email: string; password: string; role: Role },
  opts: { isDemo?: boolean } = {},
): Promise<string> {
  assert(input.role === "operator", "Use the client or builder sign-up for those roles.");
  const email = normalizeEmail(input.email);
  await assertNewAccount(db, email, input.password, input.name);
  const id = newId();
  await db.insert(users).values({
    id,
    email,
    name: input.name.trim(),
    passwordHash: await hashPassword(input.password),
    role: "operator",
    isDemo: opts.isDemo ?? false,
  });
  return id;
}

/**
 * Returns the user id when the email/password pair is valid. Same error either way to avoid account probing. An
 * account whose sign-in is off (the seeded demo accounts after migration 0004) is refused with the same error, after
 * the same password check, so neither the message nor the timing shows that it exists.
 */
export async function authenticate(db: DB, emailInput: string, password: string): Promise<string> {
  const email = normalizeEmail(emailInput);
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, signInDisabledAt: users.signInDisabledAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // Hash even when the user doesn't exist so response time doesn't reveal which emails have accounts.
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
  if (!user || !ok || user.signInDisabledAt) throw new DomainError("That email and password don't match an account.", "forbidden");
  return user.id;
}
