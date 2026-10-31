import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { assignments, builderProfiles, orgs, payouts, reviews, users, workOrders } from "../db/schema";
import { safeUrl } from "../format";
import type { Actor } from "./actor";
import { realFundedOrderIds } from "./classification";
import { assert, DomainError } from "./errors";
import { newId, notify, orderRef, recordEvent } from "./records";
import { BUILDER_STATUSES, BUILDER_STATUS_LABELS, type BuilderStatus } from "./types";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "builder";
}

export async function uniqueSlug(db: DB, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [taken] = await db.select({ id: builderProfiles.id }).from(builderProfiles).where(eq(builderProfiles.slug, candidate)).limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

export async function updateBuilderProfile(
  db: DB,
  actor: Actor,
  input: { headline: string; bio: string; skills: string[]; hourlyRateCents: number | null; country: string; timezone: string; links: string[] },
): Promise<void> {
  if (actor.role !== "builder" || !actor.builderId) throw new DomainError("Only builders have a builder profile.", "forbidden");
  assert(input.headline.trim().length >= 5 && input.headline.length <= 120, "The headline should be 5–120 characters.");
  assert(input.bio.length <= 2000, "Keep the bio under 2,000 characters.");
  const links = input.links.map((l) => l.trim()).filter(Boolean);
  const safe = links.map(safeUrl);
  assert(safe.every(Boolean), "Links must be valid http(s) URLs.");
  assert(input.hourlyRateCents === null || (input.hourlyRateCents >= 1_000 && input.hourlyRateCents <= 100_000), "Hourly rate should be between $10 and $1,000.");
  await db
    .update(builderProfiles)
    .set({
      headline: input.headline.trim(),
      bio: input.bio.trim(),
      skills: input.skills.map((s) => s.trim()).filter(Boolean).slice(0, 15),
      hourlyRateCents: input.hourlyRateCents,
      country: input.country.trim() || null,
      timezone: input.timezone.trim() || null,
      links: safe.slice(0, 8) as string[],
    })
    .where(eq(builderProfiles.id, actor.builderId));
}

export async function reviewBuilder(
  db: DB,
  actor: Actor,
  builderId: string,
  input: { status: BuilderStatus; identityVerified: boolean; notes: string },
): Promise<void> {
  if (actor.role !== "operator") throw new DomainError("You don't have permission to do that.", "forbidden");
  assert(BUILDER_STATUSES.includes(input.status), "Choose a status.");
  // Laptop-farm and fake-candidate schemes target remote technical work: no approval without an identity check.
  if (input.status === "approved") assert(input.identityVerified, "Verify identity (live video call and government ID) before approving.");
  const [b] = await db
    .select({ id: builderProfiles.id, status: builderProfiles.status, email: users.email })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(builderProfiles.id, builderId))
    .limit(1);
  assert(b, "Builder not found.", "not_found");
  await db
    .update(builderProfiles)
    .set({
      status: input.status,
      identityVerified: input.identityVerified,
      vettingNotes: input.notes.trim().slice(0, 4000),
      approvedAt: input.status === "approved" && b.status !== "approved" ? new Date() : undefined,
    })
    .where(eq(builderProfiles.id, builderId));
  if (input.status !== "approved") {
    // A builder who is no longer approved can't hold open invitations (they could still read or accept them).
    await db
      .update(assignments)
      .set({ status: "withdrawn", respondedAt: new Date() })
      .where(and(eq(assignments.builderId, builderId), eq(assignments.status, "invited")));
  }
  await recordEvent(db, { actorId: actor.id, type: "builder_reviewed", data: { builderId, status: input.status } });
  if (b.status !== input.status) {
    await notify(db, b.email, {
      subject: `Your ForgeX builder status: ${BUILDER_STATUS_LABELS[input.status]}`,
      body:
        input.status === "approved"
          ? "You're approved. Invitations to funded Work Orders will appear on your dashboard."
          : "Your application status changed. Reply to this email if you have questions.",
      link: `${process.env.APP_URL || "http://localhost:3000"}/dashboard`,
    });
  }
}

export async function listBuilders(db: DB) {
  const rows = await db
    .select({
      id: builderProfiles.id,
      name: users.name,
      email: users.email,
      slug: builderProfiles.slug,
      headline: builderProfiles.headline,
      skills: builderProfiles.skills,
      links: builderProfiles.links,
      sampleWork: builderProfiles.sampleWork,
      country: builderProfiles.country,
      hourlyRateCents: builderProfiles.hourlyRateCents,
      status: builderProfiles.status,
      identityVerified: builderProfiles.identityVerified,
      vettingNotes: builderProfiles.vettingNotes,
      createdAt: builderProfiles.createdAt,
      isDemo: users.isDemo,
    })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .orderBy(desc(builderProfiles.createdAt));
  const completed = await db
    .select({ builderId: workOrders.assignedBuilderId })
    .from(workOrders)
    .where(eq(workOrders.status, "completed"));
  return rows.map((r) => ({ ...r, completedCount: completed.filter((c) => c.builderId === r.id).length }));
}

export async function getBuilderProfile(db: DB, builderId: string) {
  const [row] = await db
    .select({ profile: builderProfiles, name: users.name, email: users.email })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(builderProfiles.id, builderId))
    .limit(1);
  return row ?? null;
}

/** Public, verified record: only approved builders, only accepted Work Orders the client agreed to show. */
export async function getPublicRecord(db: DB, slug: string) {
  const [row] = await db
    .select({ profile: builderProfiles, name: users.name })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(and(eq(builderProfiles.slug, slug), eq(builderProfiles.status, "approved")))
    .limit(1);
  if (!row) return null;
  const done = await db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      title: workOrders.title,
      category: workOrders.category,
      completedAt: workOrders.completedAt,
      revisionCount: workOrders.revisionCount,
      orgName: orgs.name,
      industry: orgs.industry,
      sizeBand: orgs.sizeBand,
      rating: reviews.rating,
      comment: reviews.comment,
      visibility: reviews.visibility,
    })
    .from(workOrders)
    .innerJoin(orgs, eq(orgs.id, workOrders.orgId))
    .leftJoin(reviews, eq(reviews.workOrderId, workOrders.id))
    .where(and(eq(workOrders.assignedBuilderId, row.profile.id), eq(workOrders.status, "completed")))
    .orderBy(desc(workOrders.completedAt));
  // Only ratings the client agreed to publish count; a private review's score must not leak through the average.
  const isPublic = (v: string | null) => v === "public_named" || v === "public_anonymous";
  const ratings = done
    .filter((d) => isPublic(d.visibility))
    .map((d) => d.rating)
    .filter((r): r is number => typeof r === "number");
  const testIds = await notRealFundedOrderIds(db, done.map((d) => d.id));
  const records = done
    .filter((d) => d.visibility === "public_named" || d.visibility === "public_anonymous")
    .map((d) => ({
      ref: orderRef(d.number),
      title: d.title,
      category: d.category,
      completedAt: d.completedAt,
      rating: d.rating,
      comment: d.comment,
      firstPass: d.revisionCount === 0,
      // Not funded with real money (a TEST payment, Stripe test mode, or a demo or test company): shown, but never
      // as real paid work.
      testData: testIds.has(d.id),
      client:
        d.visibility === "public_named"
          ? d.orgName
          : `A ${[d.sizeBand, (d.industry ?? "service").toLowerCase()].filter(Boolean).join(" ")} business`.replace(/\s+/g, " "),
    }));
  return {
    name: row.name,
    profile: row.profile,
    stats: {
      completed: done.length,
      firstPassRate: done.length ? done.filter((d) => d.revisionCount === 0).length / done.length : null,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      reviews: ratings.length,
    },
    records,
  };
}

export async function builderEarnings(db: DB, builderId: string) {
  const rows = await db
    .select({
      id: payouts.id,
      amountCents: payouts.amountCents,
      status: payouts.status,
      method: payouts.method,
      reference: payouts.reference,
      paidAt: payouts.paidAt,
      createdAt: payouts.createdAt,
      workOrderId: workOrders.id,
      number: workOrders.number,
      title: workOrders.title,
    })
    .from(payouts)
    .innerJoin(workOrders, eq(workOrders.id, payouts.workOrderId))
    .where(eq(payouts.builderId, builderId))
    .orderBy(desc(payouts.createdAt));
  const testIds = await notRealFundedOrderIds(db, rows.map((r) => r.workOrderId));
  const flagged = rows.map((r) => ({ ...r, testFunded: testIds.has(r.workOrderId) }));
  const sum = (status: "pending" | "paid") =>
    flagged.filter((r) => r.status === status && !r.testFunded).reduce((a, r) => a + r.amountCents, 0);
  return { rows: flagged, pendingCents: sum("pending"), paidCents: sum("paid") };
}

/**
 * Orders not funded with real money: a TEST payment, Stripe test mode, or a demo or test company. Their payouts are not
 * real money owed (src/lib/domain/classification.ts).
 */
async function notRealFundedOrderIds(db: DB, workOrderIds: string[]): Promise<Set<string>> {
  const real = await realFundedOrderIds(db, workOrderIds);
  return new Set(workOrderIds.filter((id) => !real.has(id)));
}

export async function pendingPayouts(db: DB) {
  const rows = await db
    .select({
      id: payouts.id,
      amountCents: payouts.amountCents,
      createdAt: payouts.createdAt,
      workOrderId: workOrders.id,
      number: workOrders.number,
      title: workOrders.title,
      builderName: users.name,
    })
    .from(payouts)
    .innerJoin(workOrders, eq(workOrders.id, payouts.workOrderId))
    .innerJoin(builderProfiles, eq(builderProfiles.id, payouts.builderId))
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(eq(payouts.status, "pending"))
    .orderBy(desc(payouts.createdAt));
  const testIds = await notRealFundedOrderIds(db, rows.map((r) => r.workOrderId));
  return rows.map((r) => ({ ...r, testFunded: testIds.has(r.workOrderId) }));
}

export async function approvedBuilders(db: DB) {
  return db
    .select({ id: builderProfiles.id, name: users.name, headline: builderProfiles.headline, skills: builderProfiles.skills, hourlyRateCents: builderProfiles.hourlyRateCents })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(inArray(builderProfiles.status, ["approved"]))
    .orderBy(users.name);
}
