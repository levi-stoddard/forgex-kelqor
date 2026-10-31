import { redirect } from "next/navigation";
import type { Role } from "../domain/types";
import { getSessionUser, type SessionUser } from "./session";

/** Page guard: sends signed-out visitors to /login and wrong-role users to their dashboard. */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect("/dashboard");
  return user;
}
