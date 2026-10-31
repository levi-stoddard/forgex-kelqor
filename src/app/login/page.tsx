import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getSessionUser()) redirect("/dashboard");
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Sign in to ForgeX</h1>
      <Card>
        <ActionForm action={loginAction} className="space-y-4">
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" autoComplete="email" required className="fx-input" />
          </Field>
          <Field label="Password" htmlFor="password">
            <input id="password" name="password" type="password" autoComplete="current-password" required className="fx-input" />
          </Field>
          <SubmitButton pendingText="Signing in…" className="w-full">
            Sign in
          </SubmitButton>
        </ActionForm>
      </Card>
      <p className="mt-4 text-sm text-stone-600">
        New to ForgeX?{" "}
        <Link href="/signup" className="fx-link">
          Start a request
        </Link>{" "}
        or{" "}
        <Link href="/signup?role=builder" className="fx-link">
          apply as a builder
        </Link>
        .
      </p>
      {process.env.NODE_ENV !== "production" ? (
        <p className="mt-6 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
          Local development: demo accounts (operator, client, builder) are listed in README.md after you run <code>npm run setup</code>.
        </p>
      ) : null}
    </div>
  );
}
