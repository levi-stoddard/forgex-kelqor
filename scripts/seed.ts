// Local demo data for walking through every role and status.
// Every record is flagged as demo, and every payment is a TEST payment, so none of it can show up as
// real revenue in the operator metrics. Stop `npm run dev` before running this (the embedded database
// is single-process).
//
// Demo accounts (all share one password: SEED_PASSWORD from .env.local or the environment; if it is empty, a random
// password is generated and printed once at the end of the run):
//   operator  ops@forgex.local
//   client    riley@brightline.demo   (Brightline Heating & Air)
//   client    avery@ledgerwise.demo   (Ledgerwise Bookkeeping)
//   builder   sam@builder.demo        (approved, identity verified)
//   builder   priya@builder.demo      (application waiting for review)
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDb, type DB } from "../src/lib/db";
import { builderProfiles, payouts, users } from "../src/lib/db/schema";
import { createUserWithRole, registerBuilder, registerClient } from "../src/lib/domain/accounts";
import { SYSTEM_ACTOR, type Actor } from "../src/lib/domain/actor";
import { reviewBuilder } from "../src/lib/domain/builders";
import * as orders from "../src/lib/domain/orders";
import { suggestPricing } from "../src/lib/domain/pricing";
import type { Intake } from "../src/lib/domain/types";
import type { DraftScope } from "../src/lib/scoping";
import { templateScope } from "../src/lib/scoping/heuristic";
import { refuseWhileBackendRuns } from "./local-backend-guard";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local
}

const GENERATED = !process.env.SEED_PASSWORD;
const PASSWORD = process.env.SEED_PASSWORD || randomBytes(12).toString("base64url");
process.env.ALLOW_TEST_PAYMENTS = "true"; // seeding only ever uses TEST payments

async function actorFor(db: DB, userId: string): Promise<Actor> {
  const [u] = await db
    .select({ id: users.id, role: users.role, orgId: users.orgId, name: users.name, email: users.email, builderId: builderProfiles.id })
    .from(users)
    .leftJoin(builderProfiles, eq(builderProfiles.userId, users.id))
    .where(eq(users.id, userId));
  return { ...u };
}

const draft = (intake: Intake): DraftScope => ({ ...templateScope(intake), source: "template", model: null, costMicros: 0 });

const intake = (templateSlug: string, problem: string, extra: Partial<Intake> = {}): Intake => ({
  problem,
  currentTools: "",
  desiredOutcome: "",
  volume: "",
  deadline: "",
  budgetBand: "Not sure yet",
  templateSlug,
  ...extra,
});

async function quoteAndFund(db: DB, operator: Actor, client: Actor, orderId: string, hours: [number, number]) {
  const p = suggestPricing({ hoursLow: hours[0], hoursHigh: hours[1] });
  await orders.sendQuote(db, operator, orderId, p);
  await orders.acceptQuote(db, client, orderId, true);
  await orders.recordPayment(db, SYSTEM_ACTOR, orderId, { method: "test", reference: "Seeded demo payment" });
}

async function staff(db: DB, operator: Actor, builder: Actor, orderId: string) {
  const assignmentId = await orders.inviteBuilder(db, operator, orderId, { builderId: builder.builderId! });
  await orders.respondToAssignment(db, builder, assignmentId, true);
}

async function deliver(db: DB, builder: Actor, orderId: string, summary: string) {
  const view = await orders.getOrderView(db, builder, orderId);
  await orders.submitDelivery(db, builder, orderId, {
    summary,
    links: ["https://example.com/demo-walkthrough"],
    evidence: Object.fromEntries(view.criteria.map((c) => [c.id, "Tested with the agreed sample data; see the recorded walkthrough."])),
  });
  return view.criteria;
}

async function main() {
  const url = process.env.DATABASE_URL || undefined;
  if (url && !process.argv.includes("--allow-remote")) {
    throw new Error("Refusing to seed demo data into DATABASE_URL. Pass --allow-remote if this really is a development database.");
  }
  await refuseWhileBackendRuns("Nothing was seeded.");
  const handle = openDb({ url });
  await handle.ready;
  const db = handle.db;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, "ops@forgex.local"));
  if (existing) {
    console.log("Demo data already present; nothing to do. Delete .data/pglite to start over.");
    await handle.close();
    return;
  }

  const demo = { isDemo: true };
  const operator = await actorFor(db, await createUserWithRole(db, { name: "Morgan (ForgeX ops)", email: "ops@forgex.local", password: PASSWORD, role: "operator" }, demo));
  const riley = await actorFor(
    db,
    (await registerClient(db, { name: "Riley Chen", email: "riley@brightline.demo", password: PASSWORD, companyName: "Brightline Heating & Air (demo)", industry: "Home services and trades", sizeBand: "20–49 staff" }, demo)).userId,
  );
  const avery = await actorFor(
    db,
    (await registerClient(db, { name: "Avery Patel", email: "avery@ledgerwise.demo", password: PASSWORD, companyName: "Ledgerwise Bookkeeping (demo)", industry: "Accounting and bookkeeping", sizeBand: "50–99 staff" }, demo)).userId,
  );
  const samIds = await registerBuilder(
    db,
    {
      name: "Sam Okafor",
      email: "sam@builder.demo",
      password: PASSWORD,
      headline: "Automation engineer for home-service and accounting teams",
      skills: ["n8n", "HubSpot", "QuickBooks API", "Twilio", "Python"],
      links: ["https://example.com/sam-portfolio"],
      sampleWork: "Built lead routing for a 40-person plumbing company: web, phone and email leads into HubSpot with a five-minute auto-reply. Median first response fell from three hours to four minutes.",
      country: "United States",
    },
    demo,
  );
  await reviewBuilder(db, operator, samIds.builderId, { status: "approved", identityVerified: true, notes: "Demo builder. Video + ID check recorded." });
  const sam = await actorFor(db, samIds.userId);
  await registerBuilder(
    db,
    {
      name: "Priya Raman",
      email: "priya@builder.demo",
      password: PASSWORD,
      headline: "Document AI and accounting integrations",
      skills: ["Document AI", "Xero", "Make"],
      links: ["https://example.com/priya-portfolio"],
      sampleWork: "Automated invoice intake for a 25-person bookkeeping firm with a human review queue; manual entry dropped by about 70% in the first month.",
      country: "Canada",
    },
    demo,
  );

  // 1. Brightline: a fresh request waiting for ForgeX to scope and quote.
  const leads = intake(
    "lead-response",
    "Web quote requests and missed calls sit in a shared inbox for hours before anyone follows up, and we lose jobs to faster competitors.",
    { currentTools: "HubSpot, Google Workspace, RingCentral", desiredOutcome: "Every lead gets a reply within 5 minutes and lands in HubSpot with the right estimator.", volume: "About 60 leads a week", deadline: "Before spring" },
  );
  await orders.createWorkOrder(db, riley, leads, { draft: draft(leads), isDemo: true });

  // 2. Brightline: completed, reviewed publicly, builder paid, Care active.
  const reporting = intake("reporting", "Every Monday our office manager spends three hours pulling numbers from ServiceTitan and QuickBooks into a spreadsheet for the owners.", {
    currentTools: "ServiceTitan, QuickBooks Online, Google Sheets",
  });
  const o2 = await orders.createWorkOrder(db, riley, reporting, { draft: draft(reporting), isDemo: true });
  await quoteAndFund(db, operator, riley, o2.id, [14, 26]);
  await staff(db, operator, sam, o2.id);
  const criteria2 = await deliver(db, sam, o2.id, "Dashboard and Monday summary are live; reconciled two weeks against the manual sheet.");
  await orders.reviewDelivery(db, riley, o2.id, { decisions: Object.fromEntries(criteria2.map((c) => [c.id, "met"])), notes: {}, note: "Saves us Monday mornings." });
  const [payout] = await db.select().from(payouts).where(eq(payouts.workOrderId, o2.id));
  await orders.markPayoutPaid(db, operator, payout.id, { method: "ACH", reference: "DEMO-ACH-001" });
  await orders.submitReview(db, riley, o2.id, { rating: 5, comment: "Our Monday report now arrives before the 8 a.m. meeting.", visibility: "public_anonymous" });
  await orders.requestCarePlan(db, riley, o2.id);
  const care = (await orders.getOrderView(db, operator, o2.id)).carePlan!;
  await orders.setCarePlanStatus(db, operator, care.id, "active");

  // 3. Ledgerwise: in progress, first milestone done, a conversation under way.
  const docs = intake("document-intake", "Clients email us receipts and vendor bills as PDFs and photos; two staff re-key them into QuickBooks every day.", {
    currentTools: "QuickBooks Online, Outlook, Karbon",
    volume: "About 400 documents a month",
  });
  const o3 = await orders.createWorkOrder(db, avery, docs, { draft: draft(docs), isDemo: true });
  await quoteAndFund(db, operator, avery, o3.id, [22, 36]);
  await staff(db, operator, sam, o3.id);
  const v3 = await orders.getOrderView(db, sam, o3.id);
  await orders.setMilestoneDone(db, sam, v3.milestones[0].id, true);
  await orders.postMessage(db, sam, o3.id, "Kickoff done. I have the 30 test documents. Can you invite me to QuickBooks with the Accountant role?");
  await orders.postMessage(db, avery, o3.id, "Invite sent from QuickBooks. Use the Sandbox company first, please.");

  // 4. Ledgerwise: quote sent, waiting for the client to accept.
  const inbox = intake("inbox-triage", "Our shared client-services inbox gets 150 emails a day; urgent IRS notices get buried under routine questions.", {
    currentTools: "Microsoft 365",
  });
  const o4 = await orders.createWorkOrder(db, avery, inbox, { draft: draft(inbox), isDemo: true });
  await orders.sendQuote(db, operator, o4.id, suggestPricing({ hoursLow: 12, hoursHigh: 22 }));

  // 5. Brightline: delivered, waiting for the client's review.
  const support = intake("support-assistant", "Customers keep calling to ask about maintenance plans, service areas and what a diagnostic visit costs.", {
    currentTools: "Website on WordPress, Podium for chat",
  });
  const o5 = await orders.createWorkOrder(db, riley, support, { draft: draft(support), isDemo: true });
  await quoteAndFund(db, operator, riley, o5.id, [24, 40]);
  await staff(db, operator, sam, o5.id);
  await deliver(db, sam, o5.id, "Assistant is live on the website chat in test mode; evaluation set and admin guide are in the shared folder.");

  await handle.close();
  console.log("Demo data created. Accounts are listed at the top of scripts/seed.ts and in README.md.");
  if (GENERATED) console.log(`Generated demo password (shown once; set SEED_PASSWORD to choose your own): ${PASSWORD}`);
  else console.log("All demo accounts use the password in SEED_PASSWORD.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
