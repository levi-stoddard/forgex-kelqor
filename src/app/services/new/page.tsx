import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { submitServiceRequestAction } from "@/app/actions/services";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listServices } from "@/lib/services/service";

export const metadata: Metadata = { title: "Send a request" };

export default async function NewServiceRequestPage({ searchParams }: { searchParams: Promise<{ service?: string }> }) {
  const user = await requireUser(["client"]);
  const actor = toActor(user);
  const db = await getDb();
  const services = (await listServices(db, actor)).filter((s) => s.status === "active");
  const wanted = (await searchParams).service;
  const chosen = services.find((s) => s.id === wanted) ?? services[0];
  if (!chosen) return <EmptyState title="No active service">KELQOR will let you know when your service is ready.</EmptyState>;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={chosen.name} title="Send a request" description={chosen.promise} />
      <Card>
        <ActionForm action={submitServiceRequestAction} className="grid gap-4">
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <Field label="Service" htmlFor="serviceId">
            <select id="serviceId" name="serviceId" className="fx-input" defaultValue={chosen.id}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Who it's from" htmlFor="from" hint="Optional: the person or company who sent it to you.">
            <input id="from" name="from" className="fx-input" maxLength={200} />
          </Field>
          <Field label={chosen.category === "quote_intake" ? "The inquiry or quote request" : "The request"} htmlFor="text" hint="Paste it as you received it: an email, a message or your notes from a call.">
            <textarea id="text" name="text" className="fx-input h-48" required minLength={10} maxLength={20_000} />
          </Field>
          <SubmitButton pendingText="Sending…">Send to KELQOR</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
