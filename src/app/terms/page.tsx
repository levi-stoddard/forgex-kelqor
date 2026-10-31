import type { Metadata } from "next";
import { Alert, PageHeader } from "@/components/ui";
import { TERMS_VERSION } from "@/lib/domain/types";

export const metadata: Metadata = { title: "Work Order terms (draft)" };

const SECTIONS: [string, string][] = [
  [
    "1. What a Work Order is",
    "A Work Order is a fixed-price engagement defined by its scope and acceptance criteria. ForgeX sells the Work Order to the client and engages an independent builder to deliver it.",
  ],
  [
    "2. Price and payment",
    "The client pays the fixed price before work starts. ForgeX is the seller of the service and pays the builder only after the delivery is accepted. Changes to the scope are quoted separately before any extra work.",
  ],
  [
    "3. Acceptance",
    "The builder submits evidence for each acceptance criterion. The client reviews within 10 business days and marks each criterion met or not met, with a reason for anything not met. The builder then revises. If the client doesn't respond within the review window, ForgeX may accept on the client's behalf after notice.",
  ],
  [
    "4. Refunds",
    "If the work cannot meet the acceptance criteria after two revision rounds and ForgeX cannot remedy it, ForgeX refunds the price, less any part the client has accepted and is using. [Final wording, limits and timing to be set by counsel.]",
  ],
  [
    "5. Access and data",
    "Builders work in the client's own accounts using invited, least-privilege access that the client can revoke. ForgeX never asks for passwords. Builders keep client data confidential and use it only for the Work Order.",
  ],
  [
    "6. Ownership",
    "On full payment, the deliverables and related intellectual property belong to the client. Builders assign their rights so that this transfer is complete. [Assignment mechanics to be drafted by counsel.]",
  ],
  [
    "7. Builders",
    "Builders are independent businesses engaged per Work Order. They choose their own methods, tools and hours and may work for others. [Classification review by employment counsel pending.]",
  ],
  [
    "8. ForgeX Care",
    "Care is a monthly plan for monitoring, fixes and small changes to delivered automations. It renews monthly and can be cancelled at any time for the following month.",
  ],
  [
    "9. Working directly with a builder",
    "If a client wants to hire or contract a builder it met through ForgeX within 12 months, a published conversion fee applies. [Amount to be set; Upwork's comparable fee is 13.5% of estimated first-year earnings.]",
  ],
  ["10. Liability", "[Liability cap, exclusions and insurance requirements to be set by counsel.]"],
];

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader eyebrow={`Version ${TERMS_VERSION}`} title="Work Order terms" />
      <Alert tone="amber" title="Draft: not legal advice and not yet in force">
        These terms describe how the MVP works so it can be reviewed by counsel. Bracketed items are open. Real Work Orders must not be sold
        on these terms until counsel approves them.
      </Alert>
      <div className="mt-6 space-y-5">
        {SECTIONS.map(([title, body]) => (
          <section key={title}>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-stone-700">{body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
