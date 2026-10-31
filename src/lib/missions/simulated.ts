import type { ModelReply, ModelRequest, TokenUsage } from "../ai/types";
import type { CompanyReport } from "./company";
import type { MissionProvider, MissionType, SpendTicket, TicketUse } from "./contract";
import type { IndustryReport } from "./industry";

// The $0 stand-ins for simulated missions ("Simulated, no AI, $0"). They go through the same approval, metered
// pathway, ticket check, page reader and evidence checks as real missions, but call no AI provider: each asks for one
// page, then returns a report built only from the text the reader returned, labeled simulated. Their reports carry no
// research value and never become research or industry records.

export const SIMULATED_MODEL = "simulated";
export const SIMULATED_NOTE = "Simulated mission: no AI provider was called, and this report carries no research value.";

const noUsage = (): TokenUsage => ({ input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 });

function textOf(req: ModelRequest): string {
  const parts: string[] = [];
  for (const t of req.turns) {
    if (t.kind === "user") parts.push(t.text);
    else if (t.kind === "tool_results") parts.push(...t.results.map((r) => r.output));
  }
  return parts.join("\n");
}

/** The first page text the reader returned in the conversation, with the address it came from. */
function firstPage(req: ModelRequest): { url: string; words: string } | null {
  const all = textOf(req);
  const m = all.match(/URL: (\S+)[\s\S]*?<page_text[^>]*>\n([\s\S]*?)\n<\/page_text>/);
  if (!m) return null;
  const words = m[2].split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  return words ? { url: m[1], words } : null;
}

const reply = (status: ModelReply["status"], text: string, toolCalls: ModelReply["toolCalls"] = []): ModelReply => ({
  status,
  text,
  toolCalls,
  modelSteps: toolCalls.length
    ? toolCalls.map((c) => ({ type: "function_call", id: c.id, name: c.name, arguments: c.args }))
    : [{ type: "model_output", content: [{ type: "text", text: "(simulated report)" }] }],
  usage: noUsage(),
  model: SIMULATED_MODEL,
  usageReported: true,
});

function companyReport(req: ModelRequest): CompanyReport {
  const brief = req.turns[0]?.kind === "user" ? req.turns[0].text : "";
  const page = firstPage(req);
  const industry = brief.match(/^- Industry: (.+)$/m)?.[1] ?? "Other";
  return {
    identity: {
      name: brief.match(/^- Name: (.+)$/m)?.[1] ?? "",
      location: brief.match(/^- Town: (.+)$/m)?.[1] ?? "",
      claims: page ? [{ statement: "Simulated claim: the words the page reader returned first.", category: "verified_fact", sourceUrl: page.url, quote: page.words, basis: null }] : [],
    },
    industry: { industry: industry.startsWith("not set") ? "Other" : industry, activities: [], claims: [] },
    operationalProfile: { summary: SIMULATED_NOTE, claims: [] },
    software: [],
    processes: [],
    technicalIssues: [],
    hypotheses: [{ statement: "Simulated hypothesis, for testing the flow only.", category: "industry_hypothesis", sourceUrl: null, quote: null, basis: "Simulation" }],
    notVisible: [SIMULATED_NOTE],
    possibleSolutions: [],
    discoveryQuestions: [],
    contacts: { channels: [], people: [] },
    evidence: {
      sourcesUsed: page ? [{ url: page.url, usedFor: "simulation" }] : [],
      limitations: [SIMULATED_NOTE],
      gaps: [{ missing: "Everything: no AI read or judged these pages.", wouldSettle: "A real mission, which needs its own authorization" }],
      proposedSources: [],
    },
  };
}

function industryReport(req: ModelRequest): IndustryReport {
  const brief = req.turns[0]?.kind === "user" ? req.turns[0].text : "";
  const page = firstPage(req);
  const category = brief.match(/^- Category or operating model: (.+)$/m)?.[1] ?? null;
  const region = brief.match(/^- Region: (.+)$/m)?.[1] ?? null;
  return {
    scope: {
      industry: brief.match(/^- Industry: (.+)$/m)?.[1] ?? "",
      category: category === "the industry as a whole" ? null : category,
      region: region === "not limited" ? null : region,
    },
    operations: {
      summary: SIMULATED_NOTE,
      roles: [],
      claims: page ? [{ statement: "Simulated claim: the words the page reader returned first.", category: "verified_fact", sourceUrl: page.url, quote: page.words, basis: null }] : [],
    },
    workflows: [],
    bottlenecks: [{ statement: "Simulated hypothesis, for testing the flow only.", category: "industry_hypothesis", sourceUrl: null, quote: null, basis: "Simulation" }],
    software: [],
    regulatory: [],
    improvements: [],
    services: [],
    discoveryQuestions: [],
    evidence: {
      sourcesUsed: page ? [{ url: page.url, usedFor: "simulation" }] : [],
      limitations: [SIMULATED_NOTE],
      gaps: [
        page
          ? { missing: "Everything: no AI read or judged these pages.", wouldSettle: "A real mission, which needs its own authorization" }
          : { missing: "No approved source could be read for this industry.", wouldSettle: "Approving sources for it in AI Operations > Sources" },
      ],
      proposedSources: [],
    },
  };
}

/** The address the simulated researcher reads: a link from the homepage, or the first start page of the brief. */
function nextPage(req: ModelRequest, type: MissionType): string | null {
  const brief = req.turns[0]?.kind === "user" ? req.turns[0].text : "";
  if (type === "company_research") {
    const homepage = brief.match(/^URL: (\S+)/m)?.[1] ?? "";
    return [...brief.matchAll(/-> (https?:\/\/\S+)/g)].map((m) => m[1]).find((u) => u !== homepage) ?? null;
  }
  const starts = brief.split("Start pages:\n")[1]?.split("\n\n")[0] ?? "";
  return starts.match(/^- (https?:\/\/\S+)/m)?.[1] ?? null;
}

type Redeem = (ticket: SpendTicket, use: TicketUse) => void;

const estimate = (req: ModelRequest) => ({ counted: Math.ceil((req.system.length + JSON.stringify(req.turns).length) / 3), uncounted: 0 });

export function simulatedResearcher(type: MissionType, redeem: Redeem): MissionProvider {
  return {
    provider: "simulation",
    model: SIMULATED_MODEL,
    kind: "simulated",
    thinkingLevel: null,
    async countInputTokens(req, ticket) {
      redeem(ticket, { use: "count", provider: "simulation", model: SIMULATED_MODEL, kind: "simulated", request: req });
      return estimate(req);
    },
    async respond(req, ticket) {
      redeem(ticket, { use: "send", provider: "simulation", model: SIMULATED_MODEL, kind: "simulated", request: req });
      const asked = req.turns.some((t) => t.kind === "tool_results");
      if (!asked && req.toolChoice === "auto") {
        const url = nextPage(req, type);
        if (url) return reply("tool_calls", "", [{ id: "sim-1", name: "read_page", args: { url } }]);
      }
      return reply("completed", JSON.stringify(type === "company_research" ? companyReport(req) : industryReport(req)));
    },
  };
}

/** The $0 reviewer: every claim it is shown gets "supported", with a note that nothing was judged. */
export function simulatedReviewer(redeem: Redeem): MissionProvider {
  return {
    provider: "simulation",
    model: SIMULATED_MODEL,
    kind: "simulated",
    thinkingLevel: null,
    async countInputTokens(req, ticket) {
      redeem(ticket, { use: "count", provider: "simulation", model: SIMULATED_MODEL, kind: "simulated", request: req });
      return estimate(req);
    },
    async respond(req, ticket) {
      redeem(ticket, { use: "send", provider: "simulation", model: SIMULATED_MODEL, kind: "simulated", request: req });
      const ids = [...textOf(req).matchAll(/^claim (\S+):/gm)].map((m) => m[1]);
      const verdicts = ids.map((id) => ({ id, verdict: "supported", note: "Simulated review: nothing was judged." }));
      return reply("completed", JSON.stringify({ verdicts, summary: "Simulated review: no AI provider was called." }));
    },
  };
}
