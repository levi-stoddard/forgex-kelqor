import type { Metadata } from "next";
import { createRequestAction } from "@/app/actions/orders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { BUDGET_BANDS } from "@/lib/domain/types";
import { aiScopingConfigured } from "@/lib/scoping/ai";
import { getOutcome, OUTCOMES } from "@/lib/scoping/catalog";
import { priceLabel } from "@/lib/scoping/display";

export const metadata: Metadata = { title: "New request" };

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  await requireUser(["client"]);
  const chosen = getOutcome((await searchParams).template);
  const ai = aiScopingConfigured();
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader
        eyebrow="New request"
        title="What's slowing your team down?"
        description="Describe it in plain words. You'll see a draft scope with acceptance criteria as soon as you submit, and a fixed-price quote usually within one business day."
      />
      {chosen && chosen.slug !== "custom" ? (
        <div className="mb-4">
          <Alert tone="ember" title={`Starting from: ${chosen.title}`}>
            {chosen.tagline} {chosen.listPriceCents ? "Price" : "Typical fixed price"}: {priceLabel(chosen)}.
          </Alert>
        </div>
      ) : null}
      <Card>
        <ActionForm action={createRequestAction} className="space-y-5">
          <Field label="Starting point" htmlFor="templateSlug">
            <select id="templateSlug" name="templateSlug" defaultValue={chosen?.slug ?? ""} className="fx-input">
              <option value="">Not sure: let ForgeX suggest one</option>
              {OUTCOMES.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="The problem" htmlFor="problem" hint="What happens today, who does it, and what it costs you: time, missed revenue, errors.">
            <textarea id="problem" name="problem" rows={5} required minLength={20} maxLength={5000} className="fx-input" />
          </Field>
          <Field label="What would success look like?" htmlFor="desiredOutcome" hint="Numbers help: response time, hours saved a week, error rate.">
            <textarea id="desiredOutcome" name="desiredOutcome" rows={3} maxLength={2000} className="fx-input" />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Tools you use today" htmlFor="currentTools">
              <input id="currentTools" name="currentTools" placeholder="e.g. HubSpot, QuickBooks, Outlook" className="fx-input" />
            </Field>
            <Field label="Volume" htmlFor="volume">
              <input id="volume" name="volume" placeholder="e.g. 60 leads a week" className="fx-input" />
            </Field>
            <Field label="Timeline" htmlFor="deadline">
              <input id="deadline" name="deadline" placeholder="e.g. before the busy season" className="fx-input" />
            </Field>
            <Field label="Budget" htmlFor="budgetBand">
              <select id="budgetBand" name="budgetBand" defaultValue="Not sure yet" className="fx-input">
                {BUDGET_BANDS.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </Field>
          </div>
          <Alert tone="amber">Don't include passwords, payment details or your customers' personal data. Access is set up later through your own accounts.</Alert>
          <SubmitButton pendingText={ai ? "Drafting your scope… this can take up to a minute" : "Drafting your scope…"}>Submit request</SubmitButton>
          <p className="fx-hint">
            {ai
              ? "Your draft scope is written by AI (Claude) and reviewed by a ForgeX operator before you see a price."
              : "Your draft scope comes from ForgeX's outcome templates and is reviewed by an operator before you see a price."}
          </p>
        </ActionForm>
      </Card>
    </div>
  );
}
