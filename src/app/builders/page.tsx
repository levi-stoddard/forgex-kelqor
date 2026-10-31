import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "For builders" };

const POINTS = [
  { title: "No bidding", body: "Work arrives scoped, priced and already paid for by the client. You see the scope, the acceptance criteria and your fixed payout before you say yes." },
  { title: "Clear definition of done", body: "Every Work Order lists testable acceptance criteria. You submit evidence against each one, and the client accepts criterion by criterion." },
  { title: "Paid on acceptance", body: "Your payout is queued the moment the client accepts. Payouts are sent by bank transfer, and you see each one in your earnings ledger." },
  { title: "A record that proves your work", body: "Each accepted Work Order can appear on your public ForgeX record, with the client's permission. It shows verified outcomes, not self-reported skills." },
];

const STEPS = [
  "Apply with your skills, links and a recent automation you shipped.",
  "We review your work and may ask for a short paid test project.",
  "A live video call with a government ID confirms who you are. No builder is approved without it.",
  "Once approved, invitations to funded Work Orders appear on your dashboard.",
];

export default function BuildersPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <PageHeader
        eyebrow="For builders"
        title="Build, don't bid"
        description="ForgeX finds the clients, scopes the work and collects the payment. You build, prove it works, and get paid."
        actions={<LinkButton href="/signup?role=builder">Apply as a builder</LinkButton>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {POINTS.map((p) => (
          <div key={p.title} className="fx-card px-5 py-5">
            <h2 className="font-semibold">{p.title}</h2>
            <p className="mt-1 text-sm text-stone-600">{p.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">How approval works</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-stone-700">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        <div>
          <h2 className="text-lg font-semibold">What we look for</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-stone-700">
            <li>Shipped automations for real businesses: CRMs, accounting tools, helpdesks, email, documents.</li>
            <li>Comfort with workflow tools (n8n, Zapier, Make) and code when a tool isn't enough.</li>
            <li>Sound judgment with client data: least privilege, no shared passwords, a person in the loop for risky steps.</li>
            <li>Clear written communication with non-technical owners.</li>
          </ul>
          <p className="mt-4 text-xs text-stone-500">
            Builders work as independent businesses on a per-Work-Order basis and are free to take other clients. Contract terms are being
            finalized with counsel.
          </p>
        </div>
      </div>
    </div>
  );
}
