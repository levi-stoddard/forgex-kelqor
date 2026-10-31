import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import starterFile from "../../../playbooks/sources.json";
import { assertFounder } from "../controls";
import type { DB } from "../db";
import { researchSources } from "../db/schema";
import type { Actor } from "../domain/actor";
import { assert, DomainError } from "../domain/errors";
import { recordEvent } from "../domain/records";
import { INDUSTRY_LABELS } from "../playbooks";
import { isBlockedDomain, isPublicAddress } from "../research/fetcher";
import { SOURCE_KINDS, SOURCE_STATUSES, type SourceKind, type SourceStatus } from "../missions/contract";
import type { ApprovedSourceBrief, ProposedSource } from "../missions/protocol";

// Approved research sources (Milestone 2B). Missions read only the company's own site and sources approved here. A
// source is a domain or an address prefix with a kind, the industries it serves and its purpose; each change adds a
// version, so the history of what was approved, when and by whom is kept. Claude's starter list and sources found
// during missions start as proposed, and nothing proposed is read until the owner approves it.

const StarterFile = z.object({
  version: z.number().int().positive(),
  origin: z.string(),
  description: z.string(),
  sources: z.array(
    z.object({
      key: z.string().regex(/^[a-z0-9-]{2,60}$/),
      name: z.string().min(2),
      match: z.string().min(3),
      kind: z.enum(SOURCE_KINDS),
      industries: z.array(z.string()),
      purpose: z.string(),
    }),
  ),
});

export const STARTER = StarterFile.parse(starterFile);
for (const s of STARTER.sources) {
  if (!s.industries.every((i) => INDUSTRY_LABELS.includes(i))) throw new Error(`playbooks/sources.json: ${s.key} names an unknown industry.`);
}

export type SourceRow = typeof researchSources.$inferSelect;

export interface SourceView {
  key: string;
  version: number;
  status: SourceStatus;
  name: string;
  match: string;
  kind: SourceKind;
  industries: string[];
  purpose: string;
  origin: string;
  missionId: string | null;
  note: string;
  changedAt: string;
  history: { version: number; status: SourceStatus; note: string; at: string; changedById: string | null }[];
}

/** A domain ("osha.gov") or an address prefix ("https://www.bls.gov/ooh/"); public, not blocked. */
export function sourceMatchProblem(match: string): string | null {
  const m = match.trim().toLowerCase();
  let host: string;
  if (m.includes("/")) {
    let u: URL;
    try {
      u = new URL(m);
    } catch {
      return "Enter a domain such as osha.gov, or an address that starts with https://.";
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "Only web addresses can be sources.";
    if (u.username || u.password || u.port) return "A source address can't carry a user name, password or port.";
    host = u.hostname;
  } else {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(m)) return "Enter a domain such as osha.gov, or an address that starts with https://.";
    host = m;
  }
  if (isBlockedDomain(host)) return `${host} is on KELQOR's blocked list (social media, review sites, job boards and search engines).`;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPublicAddress(host)) return "Private network addresses can't be sources.";
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "Private network addresses can't be sources.";
  return null;
}

async function rows(db: DB): Promise<SourceRow[]> {
  return db.select().from(researchSources).orderBy(researchSources.key, desc(researchSources.version));
}

function views(all: SourceRow[]): SourceView[] {
  const byKey = new Map<string, SourceRow[]>();
  for (const r of all) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  return [...byKey.values()].map((versions) => {
    const latest = versions[0];
    return {
      key: latest.key,
      version: latest.version,
      status: latest.status,
      name: latest.name,
      match: latest.match,
      kind: latest.kind,
      industries: latest.industries,
      purpose: latest.purpose,
      origin: latest.origin,
      missionId: latest.missionId,
      note: latest.note,
      changedAt: latest.createdAt.toISOString(),
      history: versions.map((v) => ({ version: v.version, status: v.status, note: v.note, at: v.createdAt.toISOString(), changedById: v.changedById })),
    };
  });
}

/** Adds Claude's starter list as proposed sources, once; a key already on file is never touched. */
export async function ensureStarterSources(db: DB): Promise<number> {
  const known = new Set((await db.select({ key: researchSources.key }).from(researchSources)).map((r) => r.key));
  const missing = STARTER.sources.filter((s) => !known.has(s.key));
  if (missing.length) {
    await db.insert(researchSources).values(
      missing.map((s) => ({
        id: randomUUID(),
        key: s.key,
        version: 1,
        status: "proposed" as const,
        name: s.name,
        match: s.match,
        kind: s.kind,
        industries: s.industries,
        purpose: s.purpose,
        origin: STARTER.origin,
        note: "Proposed by Claude from general knowledge; not read yet.",
      })),
    );
  }
  return missing.length;
}

export async function listSources(db: DB): Promise<SourceView[]> {
  await ensureStarterSources(db);
  return views(await rows(db));
}

/** The approved sources for an industry: those listed for it, and the general ones (no industries). */
export async function approvedSourcesFor(db: DB, industry: string | null): Promise<ApprovedSourceBrief[]> {
  return views(await rows(db))
    .filter((s) => s.status === "approved" && (s.industries.length === 0 || (industry !== null && s.industries.includes(industry))))
    .map((s) => ({ key: s.key, name: s.name, match: s.match, kind: s.kind, purpose: s.purpose }));
}

async function addVersion(db: DB, latest: SourceView, patch: { status: SourceStatus; note: string; changedById: string | null }) {
  await db.insert(researchSources).values({
    id: randomUUID(),
    key: latest.key,
    version: latest.version + 1,
    status: patch.status,
    name: latest.name,
    match: latest.match,
    kind: latest.kind,
    industries: latest.industries,
    purpose: latest.purpose,
    origin: latest.origin,
    missionId: latest.missionId,
    note: patch.note,
    changedById: patch.changedById,
  });
}

/** Approve, reject or retire a source. Owner only: what a mission may read is a spending and evidence decision. */
export async function decideSource(db: DB, actor: Actor, input: { key: string; status: Exclude<SourceStatus, "proposed">; note: string }): Promise<SourceView> {
  await assertFounder(db, actor);
  const latest = views(await rows(db)).find((s) => s.key === input.key);
  if (!latest) throw new DomainError("That source doesn't exist.", "not_found");
  assert(SOURCE_STATUSES.includes(input.status) && input.status !== ("proposed" as SourceStatus), "Choose approve, reject or retire.");
  if (input.status === "approved") {
    const problem = sourceMatchProblem(latest.match);
    assert(!problem, problem ?? "");
  }
  if (latest.status === input.status) return latest;
  await addVersion(db, latest, { status: input.status, note: input.note.trim().slice(0, 1000), changedById: actor.id });
  await recordEvent(db, { actorId: actor.id, type: "research_source_decided", data: { key: input.key, status: input.status } });
  return views(await rows(db)).find((s) => s.key === input.key)!;
}

const AddSource = z.object({
  name: z.string().trim().min(2).max(200),
  match: z.string().trim().min(3).max(300),
  kind: z.enum(SOURCE_KINDS),
  industries: z.array(z.string()).max(20),
  purpose: z.string().trim().max(500),
});

/** A source added by hand. The owner's is approved at once; anyone else's waits as proposed. */
export async function addSource(db: DB, actor: Actor, input: z.input<typeof AddSource>): Promise<SourceView> {
  assert(actor.role === "operator", "Only operators manage research sources.", "forbidden");
  const s = AddSource.parse(input);
  const problem = sourceMatchProblem(s.match);
  assert(!problem, problem ?? "");
  assert(s.industries.every((i) => INDUSTRY_LABELS.includes(i)), "Choose industries from the list.");
  const match = s.match.toLowerCase().replace(/^www\./, "");
  const all = views(await rows(db));
  assert(!all.some((v) => v.match === match), "That source is already on the list.", "conflict");
  let founder = true;
  try {
    await assertFounder(db, actor);
  } catch {
    founder = false;
  }
  const key = `added-${randomUUID().slice(0, 8)}`;
  await db.insert(researchSources).values({
    id: randomUUID(),
    key,
    version: 1,
    status: founder ? "approved" : "proposed",
    name: s.name,
    match,
    kind: s.kind,
    industries: s.industries,
    purpose: s.purpose,
    origin: "added by you",
    note: "",
    changedById: actor.id,
  });
  await recordEvent(db, { actorId: actor.id, type: "research_source_added", data: { key, status: founder ? "approved" : "proposed" } });
  return views(await rows(db)).find((v) => v.key === key)!;
}

/** Sources a mission found linked from pages it read. They wait as proposed and aren't read until approved. */
export async function proposeFromMission(db: DB, missionId: string, missionNumber: number, industry: string | null, proposals: ProposedSource[]): Promise<number> {
  const all = views(await rows(db));
  let added = 0;
  for (const p of proposals) {
    let host: string;
    try {
      host = new URL(p.url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (sourceMatchProblem(host)) continue;
    if (all.some((v) => v.match === host || (v.match.includes("/") ? false : host.endsWith(`.${v.match}`)))) continue;
    const key = `found-${host.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60);
    if (all.some((v) => v.key === key)) continue;
    await db.insert(researchSources).values({
      id: randomUUID(),
      key,
      version: 1,
      status: "proposed",
      name: p.name.slice(0, 200),
      match: host,
      kind: p.kind,
      industries: industry && INDUSTRY_LABELS.includes(industry) ? [industry] : [],
      purpose: p.why.slice(0, 500),
      origin: `proposed by M-${String(missionNumber).padStart(4, "0")}`,
      missionId,
      note: `Linked from ${p.foundOn.slice(0, 300)}`,
    });
    all.push({ key, match: host } as SourceView);
    added++;
  }
  return added;
}

export async function sourceByKey(db: DB, key: string): Promise<SourceView | null> {
  return views(await db.select().from(researchSources).where(eq(researchSources.key, key)).orderBy(desc(researchSources.version)))[0] ?? null;
}
