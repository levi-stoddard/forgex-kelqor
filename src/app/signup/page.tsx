import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signupBuilderAction, signupClientAction } from "@/app/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { INDUSTRY_LABELS } from "@/lib/playbooks";

export const metadata: Metadata = { title: "Create an account" };

// The industries KELQOR works with are configuration (playbooks/industries.json), shared with the sale page.
const INDUSTRIES = INDUSTRY_LABELS;
const SIZES = ["1–19 staff", "20–49 staff", "50–99 staff", "100–249 staff", "250+ staff"];

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ role?: string; next?: string }> }) {
  if (await getSessionUser()) redirect("/dashboard");
  const { role, next } = await searchParams;
  const builder = role === "builder";
  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-6 flex gap-2 rounded-lg bg-stone-200/60 p-1 text-sm font-medium" role="tablist">
        <Link
          href="/signup"
          className={`flex-1 rounded-md px-3 py-2 text-center ${!builder ? "bg-white shadow-sm" : "text-stone-600 hover:text-stone-900"}`}
          aria-selected={!builder}
          role="tab"
        >
          I need work done
        </Link>
        <Link
          href="/signup?role=builder"
          className={`flex-1 rounded-md px-3 py-2 text-center ${builder ? "bg-white shadow-sm" : "text-stone-600 hover:text-stone-900"}`}
          aria-selected={builder}
          role="tab"
        >
          I build automations
        </Link>
      </div>

      {builder ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Apply as a ForgeX builder</h1>
          <p className="mt-1 mb-6 text-sm text-stone-600">
            Approved builders receive scoped, already-funded Work Orders with a fixed payout. Before approval we verify identity on a short
            video call with a government ID.
          </p>
          <Card>
            <ActionForm action={signupBuilderAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="name">
                  <input id="name" name="name" required autoComplete="name" className="fx-input" />
                </Field>
                <Field label="Country" htmlFor="country">
                  <input id="country" name="country" autoComplete="country-name" className="fx-input" />
                </Field>
              </div>
              <Field label="Email" htmlFor="email">
                <input id="email" name="email" type="email" required autoComplete="email" className="fx-input" />
              </Field>
              <Field label="Password" htmlFor="password" hint="At least 10 characters.">
                <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" className="fx-input" />
              </Field>
              <Field label="Headline" htmlFor="headline" hint="For example: Automation engineer for home-service companies (n8n, HubSpot, Twilio).">
                <input id="headline" name="headline" required maxLength={120} className="fx-input" />
              </Field>
              <Field label="Skills and tools" htmlFor="skills" hint="Comma-separated.">
                <input id="skills" name="skills" placeholder="n8n, Zapier, HubSpot, Python, OpenAI/Claude APIs" className="fx-input" />
              </Field>
              <Field label="Portfolio links" htmlFor="links" hint="One per line: GitHub, a case study, a recorded demo.">
                <textarea id="links" name="links" rows={3} className="fx-input" />
              </Field>
              <Field label="A recent automation you shipped" htmlFor="sampleWork" hint="The problem, what you built, and the measurable result.">
                <textarea id="sampleWork" name="sampleWork" rows={5} required minLength={40} className="fx-input" />
              </Field>
              <SubmitButton pendingText="Submitting…" className="w-full">
                Submit application
              </SubmitButton>
            </ActionForm>
          </Card>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Start a request</h1>
          <p className="mt-1 mb-6 text-sm text-stone-600">
            Create an account, describe what's slowing your team down, and get a draft scope right away. Your fixed-price quote follows
            within one business day. There's no charge until you accept a quote.
          </p>
          <Card>
            <ActionForm action={signupClientAction} className="space-y-4">
              <input type="hidden" name="next" value={next ?? ""} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Your name" htmlFor="name">
                  <input id="name" name="name" required autoComplete="name" className="fx-input" />
                </Field>
                <Field label="Company" htmlFor="companyName">
                  <input id="companyName" name="companyName" required autoComplete="organization" className="fx-input" />
                </Field>
              </div>
              <Field label="Work email" htmlFor="email">
                <input id="email" name="email" type="email" required autoComplete="email" className="fx-input" />
              </Field>
              <Field label="Password" htmlFor="password" hint="At least 10 characters.">
                <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" className="fx-input" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Industry" htmlFor="industry">
                  <select id="industry" name="industry" className="fx-input" defaultValue="">
                    <option value="" disabled>
                      Choose one
                    </option>
                    {INDUSTRIES.map((i) => (
                      <option key={i}>{i}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Company size" htmlFor="sizeBand">
                  <select id="sizeBand" name="sizeBand" className="fx-input" defaultValue="">
                    <option value="" disabled>
                      Choose one
                    </option>
                    {SIZES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Website (optional)" htmlFor="website">
                <input id="website" name="website" placeholder="example.com" className="fx-input" />
              </Field>
              <SubmitButton pendingText="Creating your account…" className="w-full">
                Create account and continue
              </SubmitButton>
            </ActionForm>
          </Card>
        </>
      )}
      <p className="mt-4 text-sm text-stone-600">
        Already have an account?{" "}
        <Link href="/login" className="fx-link">
          Sign in
        </Link>
        .
      </p>
    </div>
  );
}
