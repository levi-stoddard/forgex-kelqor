import type { Metadata } from "next";
import { updateProfileAction } from "@/app/actions/builders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Card, Field, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { getBuilderProfile } from "@/lib/domain/builders";
import { BUILDER_STATUS_LABELS } from "@/lib/domain/types";

export const metadata: Metadata = { title: "Builder profile" };

export default async function ProfilePage() {
  const user = await requireUser(["builder"]);
  const row = user.builderId ? await getBuilderProfile(await getDb(), user.builderId) : null;
  if (!row) return <div className="mx-auto max-w-3xl px-4 py-10">No builder profile found.</div>;
  const p = row.profile;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader
        eyebrow="Builder profile"
        title={row.name}
        description="This is what clients and ForgeX operators see. Your public record also lists accepted Work Orders that clients chose to share."
        actions={p.status === "approved" ? <LinkButton href={`/b/${p.slug}`} variant="secondary">View public record</LinkButton> : undefined}
      />
      <div className="mb-4">
        <Alert tone={p.status === "approved" ? "emerald" : "sky"} title={BUILDER_STATUS_LABELS[p.status]}>
          {p.identityVerified ? "Identity verified." : "Identity not yet verified: a short video call with a government ID comes before approval."}
        </Alert>
      </div>
      <Card>
        <ActionForm action={updateProfileAction} className="space-y-4">
          <Field label="Headline" htmlFor="headline">
            <input id="headline" name="headline" defaultValue={p.headline} required maxLength={120} className="fx-input" />
          </Field>
          <Field label="About" htmlFor="bio">
            <textarea id="bio" name="bio" rows={5} defaultValue={p.bio} maxLength={2000} className="fx-input" />
          </Field>
          <Field label="Skills and tools" htmlFor="skills" hint="Comma-separated.">
            <input id="skills" name="skills" defaultValue={p.skills.join(", ")} className="fx-input" />
          </Field>
          <Field label="Links" htmlFor="links" hint="One per line.">
            <textarea id="links" name="links" rows={3} defaultValue={p.links.join("\n")} className="fx-input" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Usual hourly rate (USD)" htmlFor="hourlyRate" hint="Used to calibrate fixed payouts.">
              <input id="hourlyRate" name="hourlyRate" inputMode="decimal" defaultValue={p.hourlyRateCents ? String(p.hourlyRateCents / 100) : ""} className="fx-input" />
            </Field>
            <Field label="Country" htmlFor="country">
              <input id="country" name="country" defaultValue={p.country ?? ""} className="fx-input" />
            </Field>
            <Field label="Time zone" htmlFor="timezone">
              <input id="timezone" name="timezone" defaultValue={p.timezone ?? ""} placeholder="e.g. America/Chicago" className="fx-input" />
            </Field>
          </div>
          <SubmitButton pendingText="Saving…">Save profile</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
