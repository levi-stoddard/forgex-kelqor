import { unstable_rethrow } from "next/navigation";
import { requireUser } from "./auth/guards";
import { toActor } from "./auth/session";
import { getDb } from "./db";
import { DomainError } from "./domain/errors";

export type ActionState = { ok?: boolean; error?: string; message?: string } | undefined;

/** Run a server action body: domain errors become a form message; framework redirects pass through. */
export async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof DomainError) return { error: err.message };
    console.error("[action]", err);
    return { error: "Something went wrong on our side. Please try again." };
  }
}

/** The signed-in actor and database for a server action. Redirects to /login when signed out. */
export async function actionContext() {
  const user = await requireUser();
  const db = await getDb();
  return { db, user, actor: toActor(user) };
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

export { safeNext } from "./safe-next";
