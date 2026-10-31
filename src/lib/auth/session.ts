import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { getDb, type DB } from "../db";
import { builderProfiles, sessions, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import type { BuilderStatus, Role } from "../domain/types";

export const SESSION_COOKIE = "fx_session";
const SESSION_DAYS = 30;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  orgId: string | null;
  builderId: string | null;
  builderStatus: BuilderStatus | null;
  builderSlug: string | null;
}

/** Stores a new session and returns its raw token, which is never stored. The cookie and the desktop app both use it. */
export async function issueSessionToken(db: DB, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export async function revokeSessionToken(db: DB, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function createSession(userId: string): Promise<void> {
  const { token, expiresAt } = await issueSessionToken(await getDb(), userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(await getDb(), token);
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user for this request, or null. Cached per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForSessionToken(await getDb(), token);
});

/**
 * The user an unexpired session token belongs to, or null. A session of an account whose sign-in is off (the seeded
 * demo accounts after migration 0004) no longer counts, so sessions issued before the shut-off end with it.
 */
export async function userForSessionToken(db: DB, token: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      orgId: users.orgId,
      builderId: builderProfiles.id,
      builderStatus: builderProfiles.status,
      builderSlug: builderProfiles.slug,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(builderProfiles, eq(builderProfiles.userId, users.id))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date()), isNull(users.signInDisabledAt)))
    .limit(1);
  return rows[0] ?? null;
}

export function toActor(user: SessionUser): Actor {
  return { id: user.id, role: user.role, orgId: user.orgId, builderId: user.builderId, name: user.name, email: user.email };
}
