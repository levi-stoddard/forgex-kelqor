import { z } from "zod";
import generalFile from "../../playbooks/general.json";
import homeServicesFile from "../../playbooks/home-services.json";
import industriesFile from "../../playbooks/industries.json";

// Industry knowledge as data (playbooks/*.json): the industries KELQOR works with, the discovery questions for each,
// and, for research, the segment a research prompt judges against. Every industry gets the general questions; a
// playbook adds its own. Home services is the first market, not a boundary: add an industry in industries.json.

const Question = z.object({ id: z.string().regex(/^[a-z0-9-]{2,40}$/), text: z.string().min(5).max(300) });

const Playbook = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  version: z.number().int().positive(),
  name: z.string().min(2),
  description: z.string(),
  /** Only a playbook a research run may use has this: the segment and category definitions the prompt states. */
  research: z
    .object({
      note: z.string().optional(),
      segment: z.string().min(10),
      categories: z.object({ "pursue now": z.string(), "pursue later": z.string(), "not a fit": z.string(), "insufficient evidence": z.string() }),
    })
    .optional(),
  discoveryQuestions: z.array(Question),
});
export type Playbook = z.infer<typeof Playbook>;
export type ResearchPlaybook = Playbook & { research: NonNullable<Playbook["research"]> };

const IndustriesFile = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  industries: z.array(z.object({ label: z.string().min(2), playbook: z.string(), match: z.array(z.string().min(2)) })).min(1),
});

const playbooks = new Map<string, Playbook>([generalFile, homeServicesFile].map((p) => Playbook.parse(p)).map((p) => [p.id, p]));
export const INDUSTRIES = IndustriesFile.parse(industriesFile).industries;
export const INDUSTRY_LABELS = INDUSTRIES.map((i) => i.label);

// Checked once at load: a typo in the files fails loudly instead of quietly dropping questions.
for (const i of INDUSTRIES) if (!playbooks.has(i.playbook)) throw new Error(`playbooks/industries.json: "${i.label}" names a missing playbook "${i.playbook}".`);
{
  const ids = [...playbooks.values()].flatMap((p) => p.discoveryQuestions.map((q) => q.id));
  if (new Set(ids).size !== ids.length) throw new Error("playbooks/*.json: discovery question ids must be unique across all playbooks.");
}

export function getPlaybook(id: string): Playbook | null {
  return playbooks.get(id) ?? null;
}

/** The playbook the frozen 25-company benchmark ran under (protocol v1.3). Its research text must never change. */
export function benchmarkPlaybook(): ResearchPlaybook {
  const p = playbooks.get("home-services");
  if (!p?.research) throw new Error("playbooks/home-services.json must keep its research section: the benchmark prompt depends on it.");
  return p as ResearchPlaybook;
}

export const isIndustry = (label: string): boolean => INDUSTRY_LABELS.includes(label);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The industry a research report's own description best matches, or null. Counts each industry's match words, each
 * from a word start (so "it services" never matches "audit services"); a tie goes to the industry listed first.
 */
export function suggestIndustry(text: string): string | null {
  let best: { label: string; score: number } | null = null;
  for (const i of INDUSTRIES) {
    const score = i.match.filter((m) => new RegExp(`\\b${escape(m)}`, "i").test(text)).length;
    if (score > 0 && (!best || score > best.score)) best = { label: i.label, score };
  }
  return best?.label ?? null;
}

export interface DiscoveryQuestion {
  id: string;
  text: string;
  playbook: string;
}

/** The general questions, then the industry's own. Ids are unique across both, so answers never collide. */
export function discoveryQuestions(industry: string | null): DiscoveryQuestion[] {
  const general = playbooks.get("general")!;
  const own = INDUSTRIES.find((i) => i.label === industry)?.playbook;
  const extra = own && own !== "general" ? playbooks.get(own) : undefined;
  return [general, ...(extra ? [extra] : [])].flatMap((p) => p.discoveryQuestions.map((q) => ({ ...q, playbook: p.name })));
}

/** Every discovery question by id, across all playbooks: answers recorded under another industry still show their question. */
export function questionText(id: string): string | null {
  for (const p of playbooks.values()) {
    const q = p.discoveryQuestions.find((x) => x.id === id);
    if (q) return q.text;
  }
  return null;
}
