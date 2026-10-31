import type { Metadata } from "next";
import { createSaleAction } from "@/app/actions/sales";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { workOrderPrefill } from "@/lib/domain/discovery";
import { listClientCompanies } from "@/lib/domain/invites";
import { BUDGET_BANDS, DATA_CLASS_LABELS } from "@/lib/domain/types";
import { INDUSTRY_LABELS, isIndustry, suggestIndustry } from "@/lib/playbooks";
import { DOSSIER_SOURCE, getDossier } from "@/lib/research/dossiers";
import { OUTCOMES } from "@/lib/scoping/catalog";

export const metadata: Metadata = { title: "New Work Order for a client" };

const SIZES = ["1–19 staff", "20–49 staff", "50–99 staff", "100–249 staff", "250+ staff"];
const RECORD_ID = /^c\d{2}$/;
const PROBLEM_ID = /^[0-9a-f-]{36}$/;

export default async function NewSalePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser(["operator"]);
  const db = await getDb();
  const actor = toActor(user);
  const companies = await listClientCompanies(db, actor);
  const params = await searchParams;
  const param = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  // From the KELQOR desktop app: a qualified company arrives with its name and industry only; a problem the customer
  // confirmed in discovery arrives as ids, and its words are loaded here from the database, never from the address.
  const recordId = RECORD_ID.test(param("opportunity")) ? param("opportunity") : "";
  const problemId = PROBLEM_ID.test(param("problem")) ? param("problem") : "";
  const dossier = recordId ? getDossier(recordId) : null;
  const fromDiscovery = dossier && problemId ? await workOrderPrefill(db, actor, { source: DOSSIER_SOURCE.id, recordId: dossier.id, problemId }) : null;
  const prefillCompany = (dossier?.name ?? param("companyName")).slice(0, 200);
  const industryHint = fromDiscovery?.industry ?? (dossier ? suggestIndustry(dossier.industry.industry) : null) ?? param("industry");
  const prefillIndustry = isIndustry(industryHint) ? industryHint : "";
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader
        eyebrow="ForgeX operations"
        title="Write up a Work Order after a call"
        description="For owner-led selling: capture what the client told you, get a draft scope, price it, and send them a one-time link to review and accept. They never fill in a sign-up form."
      />
      <Card>
        {fromDiscovery ? (
          <div className="mb-5" data-testid="from-discovery">
            <Alert tone="sky" title={`Drafted from discovery with ${prefillCompany}`}>
              The problem below is the one the customer confirmed, with the simplest solution you chose. Review and edit everything. Creating the Work Order
              sends nothing, quotes nothing and charges nothing: it starts as a draft for you to price.
            </Alert>
          </div>
        ) : recordId && problemId ? (
          <div className="mb-5">
            <Alert tone="amber">That discovery problem isn&apos;t confirmed with a solution yet, so nothing was filled in from it.</Alert>
          </div>
        ) : null}
        <ActionForm action={createSaleAction} className="space-y-6">
          {fromDiscovery ? (
            <>
              <input type="hidden" name="opportunity" value={recordId} />
              <input type="hidden" name="problemId" value={problemId} />
            </>
          ) : null}
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-stone-900">Client</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" value="new" defaultChecked /> New client
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" value="existing" disabled={!companies.length} /> Existing company
              </label>
            </div>
            <Field label="Existing company (if chosen above)" htmlFor="orgId">
              <select id="orgId" name="orgId" className="fx-input" defaultValue="">
                <option value="">Choose a company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.dataClass !== "real" && !c.name.toLowerCase().includes(`(${c.dataClass})`) ? ` (${c.dataClass})` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company" htmlFor="companyName">
                <input id="companyName" name="companyName" className="fx-input" defaultValue={prefillCompany} />
              </Field>
              <Field label="Contact name" htmlFor="contactName">
                <input id="contactName" name="contactName" className="fx-input" />
              </Field>
              <Field label="Contact email" htmlFor="email" hint="They receive a one-time link to set a password.">
                <input id="email" name="email" type="email" className="fx-input" />
              </Field>
              <Field label="Industry" htmlFor="industry">
                <select id="industry" name="industry" className="fx-input" defaultValue={prefillIndustry}>
                  <option value="">Not specified</option>
                  {INDUSTRY_LABELS.map((i) => (
                    <option key={i}>{i}</option>
                  ))}
                </select>
              </Field>
              <Field label="Company size" htmlFor="sizeBand">
                <select id="sizeBand" name="sizeBand" className="fx-input" defaultValue="20–49 staff">
                  {SIZES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset className="space-y-2" data-testid="data-class">
              <legend className="text-sm font-medium text-stone-800">For a new client: is this a real customer?</legend>
              <p className="text-xs text-stone-500">Only real customers count as business. A test record never counts in revenue or totals.</p>
              <div className="flex flex-wrap gap-4 text-sm">
                {(["real", "test"] as const).map((c) => (
                  <label key={c} className="flex items-center gap-2">
                    <input type="radio" name="dataClass" value={c} /> {DATA_CLASS_LABELS[c]}
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-stone-900">What they need</legend>
            <Field label="Starting point" htmlFor="templateSlug">
              <select id="templateSlug" name="templateSlug" className="fx-input" defaultValue={fromDiscovery ? "" : "revenue-leak-check"}>
                <option value="">Let KELQOR suggest one from the problem</option>
                {OUTCOMES.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="The problem, in their words" htmlFor="problem">
              <textarea id="problem" name="problem" rows={5} required minLength={20} className="fx-input" defaultValue={fromDiscovery?.problem ?? ""} />
            </Field>
            <Field label="What success looks like" htmlFor="desiredOutcome">
              <textarea id="desiredOutcome" name="desiredOutcome" rows={2} className="fx-input" defaultValue={fromDiscovery?.desiredOutcome ?? ""} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Their tools" htmlFor="currentTools">
                <input id="currentTools" name="currentTools" placeholder="e.g. Jobber, QuickBooks, RingCentral" className="fx-input" defaultValue={fromDiscovery?.currentTools ?? ""} />
              </Field>
              <Field label="Volume" htmlFor="volume">
                <input id="volume" name="volume" placeholder="e.g. 150 leads a month" className="fx-input" />
              </Field>
              <Field label="Timeline" htmlFor="deadline">
                <input id="deadline" name="deadline" className="fx-input" />
              </Field>
              <Field label="Budget they mentioned" htmlFor="budgetBand">
                <select id="budgetBand" name="budgetBand" className="fx-input" defaultValue="Not sure yet">
                  {BUDGET_BANDS.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </Field>
            </div>
          </fieldset>
          <Alert tone="amber">
            Only write up conversations the client asked for. Sending the link is up to you; ForgeX does not email anyone until an email
            provider is connected.
          </Alert>
          <SubmitButton pendingText="Creating the Work Order…">Create Work Order and client link</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
