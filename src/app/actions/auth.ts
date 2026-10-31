"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { run, safeNext, str, type ActionState } from "@/lib/actions";
import { allowAttempt } from "@/lib/auth/rate-limit";
import { createSession, destroySession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { authenticate, registerBuilder, registerClient } from "@/lib/domain/accounts";
import { lines } from "@/lib/format";

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const email = str(form, "email");
  // Per account (can't be dodged by spoofing X-Forwarded-For) and per address (slows spraying many accounts).
  const accountOk = allowAttempt(`login-account:${email.trim().toLowerCase()}`, 10);
  const ipOk = allowAttempt(`login-ip:${await clientIp()}`, 50);
  if (!accountOk || !ipOk) {
    return { error: "Too many sign-in attempts. Wait 15 minutes and try again." };
  }
  const result = await run(async () => {
    const db = await getDb();
    const userId = await authenticate(db, email, str(form, "password"));
    await createSession(userId);
  });
  if (result?.error) return result;
  redirect(safeNext(str(form, "next")));
}

export async function signupClientAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!allowAttempt(`signup:${await clientIp()}`, 20, 60 * 60 * 1000)) return { error: "Too many sign-ups from here. Try again later." };
  const result = await run(async () => {
    const db = await getDb();
    const { userId } = await registerClient(db, {
      name: str(form, "name"),
      email: str(form, "email"),
      password: str(form, "password"),
      companyName: str(form, "companyName"),
      industry: str(form, "industry"),
      sizeBand: str(form, "sizeBand"),
      website: str(form, "website"),
    });
    await createSession(userId);
  });
  if (result?.error) return result;
  redirect(safeNext(str(form, "next"), "/orders/new"));
}

export async function signupBuilderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!allowAttempt(`signup:${await clientIp()}`, 20, 60 * 60 * 1000)) return { error: "Too many sign-ups from here. Try again later." };
  const result = await run(async () => {
    const db = await getDb();
    const { userId } = await registerBuilder(db, {
      name: str(form, "name"),
      email: str(form, "email"),
      password: str(form, "password"),
      headline: str(form, "headline"),
      skills: str(form, "skills").split(","),
      links: lines(form.get("links")),
      sampleWork: str(form, "sampleWork"),
      country: str(form, "country"),
    });
    await createSession(userId);
  });
  if (result?.error) return result;
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/");
}
