import { eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { builderProfiles, users } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { createUserWithRole, registerBuilder, registerClient } from "@/lib/domain/accounts";
import { reviewBuilder } from "@/lib/domain/builders";

export async function freshDb() {
  const handle = openDb({ memory: true });
  await handle.ready;
  return handle;
}

export async function actorFor(db: DB, userId: string): Promise<Actor> {
  const [u] = await db
    .select({ id: users.id, role: users.role, orgId: users.orgId, name: users.name, email: users.email, builderId: builderProfiles.id })
    .from(users)
    .leftJoin(builderProfiles, eq(builderProfiles.userId, users.id))
    .where(eq(users.id, userId));
  return { id: u.id, role: u.role, orgId: u.orgId, builderId: u.builderId, name: u.name, email: u.email };
}

export const TEST_PASSWORD = "test-password-123";

/** One operator, one client company, one approved builder. */
export async function seedParties(db: DB) {
  const opId = await createUserWithRole(db, { name: "Olive Operator", email: "ops@test.local", password: TEST_PASSWORD, role: "operator" });
  const operator = await actorFor(db, opId);
  const c = await registerClient(db, { name: "Casey Client", email: "casey@acme.test", password: TEST_PASSWORD, companyName: "Acme HVAC", industry: "home services", sizeBand: "20-50 staff" });
  const client = await actorFor(db, c.userId);
  const b = await registerBuilder(db, {
    name: "Bao Builder",
    email: "bao@builder.test",
    password: TEST_PASSWORD,
    headline: "Automation engineer for service businesses",
    skills: ["n8n", "HubSpot"],
    links: ["https://example.com/portfolio"],
    sampleWork: "Built a lead routing automation for a 40-person plumbing company that cut response times from hours to minutes.",
  });
  await reviewBuilder(db, operator, b.builderId, { status: "approved", identityVerified: true, notes: "Video call + ID checked" });
  const builder = await actorFor(db, b.userId);
  return { operator, client, builder };
}

export const SAMPLE_INTAKE = {
  problem: "Web quote requests and missed calls sit in a shared inbox for hours before anyone follows up, and we lose jobs to faster competitors.",
  currentTools: "HubSpot CRM, Google Workspace, RingCentral",
  desiredOutcome: "Every lead gets a reply within 5 minutes and lands in HubSpot assigned to the right estimator.",
  volume: "About 60 leads a week",
  deadline: "Before the spring season",
  budgetBand: "$2,500 – $5,000",
  templateSlug: null,
};
