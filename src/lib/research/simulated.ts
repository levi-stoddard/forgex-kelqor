import type { ModelReply, ModelRequest, ResearchModel, TokenUsage } from "../ai/types";
import type { ResearchReport } from "./schema";

// An offline stand-in for cost-free runs: it asks for one more page, then returns a report built only from what
// the fetcher read. It exercises the fetcher, budget guard, validation and quote checks end to end without
// calling any provider. Its reports say they are simulated and carry no research value. In a restricted run,
// where nothing was read, its report has no claims.

const noUsage = (): TokenUsage => ({ input: 0, cachedInput: 0, output: 0, thinking: 0, toolUse: 0, total: 0 });

export function simulatedModel(): ResearchModel {
  return {
    provider: "simulation",
    model: "simulated",
    async respond(req: ModelRequest): Promise<ModelReply> {
      const first = req.turns[0];
      const brief = first?.kind === "user" ? first.text : "";
      const homepage = brief.match(/^URL: (\S+)/m)?.[1] ?? "";
      const alreadyAsked = req.turns.some((t) => t.kind === "tool_results");
      if (!alreadyAsked && req.toolChoice === "auto") {
        const link = [...brief.matchAll(/-> (https?:\/\/\S+)/g)].map((m) => m[1]).find((u) => u !== homepage);
        if (link) {
          const call = { id: "sim-1", name: "read_page", args: { url: link } };
          return {
            status: "tool_calls", text: "", toolCalls: [call],
            modelSteps: [{ type: "function_call", id: call.id, name: call.name, arguments: call.args }],
            usage: noUsage(), model: "simulated",
          };
        }
      }
      const pageText = brief.match(/<page_text[^>]*>\n([\s\S]*?)\n<\/page_text>/)?.[1] ?? "";
      const quote = pageText.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
      const name = brief.match(/^- Name: (.+)$/m)?.[1] ?? "";
      const website = brief.match(/^- Official website: (\S+)$/m)?.[1] ?? "";
      const report: ResearchReport = {
        identity: {
          name,
          location: brief.match(/^- Town: (.+)$/m)?.[1] ?? "",
          claims: homepage ? [{ statement: "Simulated claim taken from the homepage text.", label: "fact", sourceUrl: homepage, quote }] : [],
        },
        industry: { industry: "Simulated", activities: [], claims: [] },
        publicInformation: { officialWebsite: homepage || website, claims: [] },
        licensing: { claims: [], limitations: "Simulated run: no research was done." },
        existingSoftware: [],
        opportunityEvidence: [],
        problems: [],
        existingSolutions: [],
        forgexSolutions: [],
        feasibility: { rating: "not applicable", explanation: "Simulated run." },
        aiDelivery: { rating: "not applicable", explanation: "Simulated run." },
        humanReview: [],
        risks: [],
        commercial: { supportable: false, value: null, implementationCost: null, assumptions: [] },
        contacts: { decisionMakerRoles: [], people: [], channels: [] },
        discovery: { questions: [], outreachSubject: "", outreachBody: "" },
        evidence: { sourcesUsed: homepage ? [{ url: homepage, usedFor: "simulation" }] : [], limitations: ["Simulated run: no research was done."] },
        qualification: { category: "insufficient evidence", rationale: "Simulated run." },
      };
      return {
        status: "completed", text: JSON.stringify(report), toolCalls: [],
        modelSteps: [{ type: "model_output", content: [{ type: "text", text: "(simulated report)" }] }],
        usage: noUsage(), model: "simulated",
      };
    },
  };
}
