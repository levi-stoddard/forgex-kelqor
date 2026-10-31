import type { Metadata } from "next";
import Link from "next/link";
import { acceptInviteAction } from "@/app/actions/sales";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field } from "@/components/ui";
import { getDb } from "@/lib/db";
import { findInvite } from "@/lib/domain/invites";

export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findInvite(await getDb(), token);
  if (!invite) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">This link has expired or was already used</h1>
        <p className="mt-2 text-sm text-stone-600">
          If you already set a password,{" "}
          <Link href="/login" className="fx-link">
            sign in
          </Link>
          . Otherwise ask ForgeX for a new link.
        </p>
      </div>
    );
  }
  // An invitation carries a Work Order (the original sales flow) or opens a managed-services account (Milestone 4).
  const forOrder = Boolean(invite.workOrderId);
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <p className="text-sm font-semibold text-ember-700">{invite.orgName}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{forOrder ? "Your Work Order is ready to review" : "Your services are ready"}</h1>
      <p className="mt-2 mb-6 text-sm text-stone-600">
        {forOrder
          ? "Set a password to see the scope, the acceptance criteria and the fixed price."
          : "Set a password to send requests, approve results and see your reports."}{" "}
        You'll use it with {invite.email} to sign in later.
      </p>
      <Card>
        <ActionForm action={acceptInviteAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <Field label="Your name" htmlFor="name">
            <input id="name" name="name" defaultValue={invite.name} autoComplete="name" className="fx-input" />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 10 characters.">
            <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" className="fx-input" />
          </Field>
          <Field label="Confirm password" htmlFor="confirm">
            <input id="confirm" name="confirm" type="password" required minLength={10} autoComplete="new-password" className="fx-input" />
          </Field>
          <SubmitButton pendingText={forOrder ? "Opening your Work Order…" : "Opening your services…"} className="w-full">
            Set password and continue
          </SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
