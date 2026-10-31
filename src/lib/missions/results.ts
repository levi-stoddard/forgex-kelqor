import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, like, max } from "drizzle-orm";
import { missionSpend } from "../controls";
import type { DB } from "../db";
import { industryIntelligence, missions, researchRecords, users } from "../db/schema";
import type { Actor } from "../domain/actor";
import { assert, DomainError } from "../domain/errors";
import { recordEvent } from "../domain/records";
import { assertFounder } from "../controls";
import { proposeFromMission } from "../sources/registry";
import type { CompanyReport } from "./company";
import type { MissionChecks } from "./evidence";
import type { IndustryReport } from "./industry";

// What a completed real mission leaves behind: a new version of the company's research, or of an industry's
// intelligence, beside everything earlier (nothing is overwritten), plus the sources it proposed. Simulated and
// synthetic missions never get here, so their reports stay on the mission, labeled as such.

export const MISSION_SOURCE = "kelqor-missions";

export function seriesKey(industry: string, category: string | null, region: string | null): string {
  return [industry, category ?? "", region ?? ""].map((s) => s.trim().toLowerCase()).join("|");
}

/** A new company's Opportunity Center key: "n" and a number, e.g. "n0001". */
async function newCompanyKey(db: DB): Promise<string> {
  const keys = await db.select({ key: researchRecords.companyKey }).from(researchRecords).where(like(researchRecords.companyKey, "n%"));
  const next = keys.reduce((n, k) => Math.max(n, Number(k.key.slice(1)) || 0), 0) + 1;
  return `n${String(next).padStart(4, "0")}`;
}

export async function saveResults(db: DB, missionId: string, opts: { withIssues: boolean }): Promise<{ saved: boolean; key?: string; version?: number }> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!m || m.simulated || m.provider !== "google" || !m.result) return { saved: false };
  const result = m.result as { report: Record<string, unknown>; checks: MissionChecks; sources: Record<string, unknown>[] };
  const cost = (await missionSpend(db, missionId)).committedMicros;
  const proposals = result.checks.proposedSources ?? [];
  if (m.subject.kind === "company") {
    const s = m.subject;
    let key = s.recordId;
    if (!key) {
      // The same website researched again joins its existing series.
      const [same] = await db.select({ key: researchRecords.companyKey }).from(researchRecords).where(eq(researchRecords.website, s.website)).limit(1);
      key = same?.key ?? (await newCompanyKey(db));
    }
    const [{ v }] = await db.select({ v: max(researchRecords.version) }).from(researchRecords).where(eq(researchRecords.companyKey, key));
    const version = (v ?? 0) + 1;
    await db.insert(researchRecords).values({
      id: randomUUID(),
      companyKey: key,
      version,
      companyName: s.name,
      website: s.website,
      town: s.town,
      state: s.state,
      industry: s.industry ?? ((result.report as CompanyReport).industry?.industry || null),
      missionId,
      protocol: m.protocol,
      provider: m.provider,
      model: m.model,
      report: result.report,
      checks: result.checks as unknown as Record<string, unknown>,
      sources: result.sources,
      costMicros: cost,
      withIssues: opts.withIssues,
    });
    await proposeFromMission(db, missionId, m.number, s.industry, proposals);
    return { saved: true, key, version };
  }
  const s = m.subject;
  const series = seriesKey(s.industry, s.category, s.region);
  const [{ v }] = await db.select({ v: max(industryIntelligence.version) }).from(industryIntelligence).where(eq(industryIntelligence.seriesKey, series));
  const version = (v ?? 0) + 1;
  await db.insert(industryIntelligence).values({
    id: randomUUID(),
    seriesKey: series,
    version,
    industry: s.industry,
    category: s.category,
    region: s.region,
    missionId,
    protocol: m.protocol,
    provider: m.provider,
    model: m.model,
    report: result.report,
    checks: result.checks as unknown as Record<string, unknown>,
    sources: result.sources,
    costMicros: cost,
    withIssues: opts.withIssues,
  });
  await proposeFromMission(db, missionId, m.number, s.industry, proposals);
  return { saved: true, key: series, version };
}

/** Short summaries of the reviewed industry intelligence for an industry, as context for company research. */
export async function reviewedIntelligence(db: DB, industry: string | null): Promise<string[]> {
  if (!industry) return [];
  const reviewed = await db
    .select()
    .from(industryIntelligence)
    .where(and(eq(industryIntelligence.industry, industry), isNotNull(industryIntelligence.reviewedAt)))
    .orderBy(desc(industryIntelligence.version));
  const latest = new Map<string, (typeof reviewed)[number]>();
  for (const r of reviewed) if (!latest.has(r.seriesKey)) latest.set(r.seriesKey, r);
  return [...latest.values()].map((r) => {
    const report = r.report as unknown as IndustryReport;
    const label = [r.industry, r.category, r.region].filter(Boolean).join(", ");
    const bottlenecks = (report.bottlenecks ?? []).slice(0, 6).map((b) => b.statement).join("; ");
    return `${label} (reviewed version ${r.version}): ${report.operations?.summary ?? ""} Common bottlenecks: ${bottlenecks || "none recorded"}.`.slice(0, 1500);
  });
}

export interface IntelligenceView {
  id: string;
  seriesKey: string;
  version: number;
  industry: string;
  category: string | null;
  region: string | null;
  missionId: string;
  missionNumber: number | null;
  protocol: string;
  model: string;
  costMicros: number;
  withIssues: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  report: Record<string, unknown>;
  checks: Record<string, unknown>;
  sources: Record<string, unknown>[];
}

export async function listIntelligence(db: DB): Promise<IntelligenceView[]> {
  const rowsWith = await db
    .select({ r: industryIntelligence, number: missions.number, reviewer: users.name })
    .from(industryIntelligence)
    .leftJoin(missions, eq(missions.id, industryIntelligence.missionId))
    .leftJoin(users, eq(users.id, industryIntelligence.reviewedById))
    .orderBy(industryIntelligence.seriesKey, desc(industryIntelligence.version));
  return rowsWith.map(({ r, number, reviewer }) => ({
    id: r.id,
    seriesKey: r.seriesKey,
    version: r.version,
    industry: r.industry,
    category: r.category,
    region: r.region,
    missionId: r.missionId,
    missionNumber: number,
    protocol: r.protocol,
    model: r.model,
    costMicros: r.costMicros,
    withIssues: r.withIssues,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewedBy: reviewer,
    createdAt: r.createdAt.toISOString(),
    report: r.report,
    checks: r.checks,
    sources: r.sources,
  }));
}

/** Marks a version reviewed, so company research may use it as context. It never changes a playbook. */
export async function markIntelligenceReviewed(db: DB, actor: Actor, id: string): Promise<IntelligenceView> {
  await assertFounder(db, actor);
  const [row] = await db.select().from(industryIntelligence).where(eq(industryIntelligence.id, id)).limit(1);
  if (!row) throw new DomainError("That industry record doesn't exist.", "not_found");
  assert(!row.reviewedAt, "That version is already marked reviewed.", "conflict");
  await db.update(industryIntelligence).set({ reviewedAt: new Date(), reviewedById: actor.id }).where(eq(industryIntelligence.id, id));
  await recordEvent(db, { actorId: actor.id, type: "industry_intelligence_reviewed", data: { id, seriesKey: row.seriesKey, version: row.version } });
  return (await listIntelligence(db)).find((v) => v.id === id)!;
}

export interface ResearchVersionView {
  id: string;
  companyKey: string;
  version: number;
  companyName: string;
  website: string;
  town: string;
  state: string;
  industry: string | null;
  missionId: string;
  missionNumber: number | null;
  protocol: string;
  model: string;
  costMicros: number;
  withIssues: boolean;
  createdAt: string;
  report: Record<string, unknown>;
  checks: Record<string, unknown>;
  sources: Record<string, unknown>[];
}

export async function researchVersions(db: DB, companyKey?: string): Promise<ResearchVersionView[]> {
  const q = db
    .select({ r: researchRecords, number: missions.number })
    .from(researchRecords)
    .leftJoin(missions, eq(missions.id, researchRecords.missionId))
    .orderBy(researchRecords.companyKey, desc(researchRecords.version));
  const rowsWith = companyKey ? await q.where(eq(researchRecords.companyKey, companyKey)) : await q;
  return rowsWith.map(({ r, number }) => ({
    id: r.id,
    companyKey: r.companyKey,
    version: r.version,
    companyName: r.companyName,
    website: r.website,
    town: r.town,
    state: r.state,
    industry: r.industry,
    missionId: r.missionId,
    missionNumber: number,
    protocol: r.protocol,
    model: r.model,
    costMicros: r.costMicros,
    withIssues: r.withIssues,
    createdAt: r.createdAt.toISOString(),
    report: r.report,
    checks: r.checks,
    sources: r.sources,
  }));
}
