import { z } from "zod";

// The report Gemini returns, one section per item of the owner's specification. The Zod schema is the single
// source: the JSON Schema sent to the model is generated from it, and the reply is validated against it.

const Label = z.enum(["fact", "inference", "hypothesis"]);

const Claim = z.object({
  statement: z.string(),
  label: Label,
  sourceUrl: z.string().nullable().describe("URL of a page you read that supports the claim; null for a hypothesis"),
  quote: z.string().nullable().describe("For a fact: exact words from that page, at most 25 words. Otherwise null."),
});

export const ReportSchema = z.object({
  identity: z
    .object({ name: z.string(), location: z.string(), claims: z.array(Claim) })
    .describe("1. Verified business identity and location"),
  industry: z
    .object({ industry: z.string(), activities: z.array(z.string()), claims: z.array(Claim) })
    .describe("2. Industry and principal business activities"),
  publicInformation: z
    .object({ officialWebsite: z.string(), claims: z.array(Claim) })
    .describe("3. Official website and relevant public information"),
  licensing: z
    .object({ claims: z.array(Claim), limitations: z.string() })
    .describe("4. Applicable licensing or business-registration evidence"),
  existingSoftware: z
    .array(z.object({ product: z.string(), purpose: z.string(), evidence: Claim }))
    .describe("5. Existing software and automation systems, where verifiable"),
  opportunityEvidence: z.array(Claim).describe("6. Publicly observable evidence of operational opportunities"),
  problems: z
    .array(z.object({ problem: z.string(), label: Label, basis: z.string() }))
    .describe("7. Potential business problems, clearly separating facts from hypotheses"),
  existingSolutions: z
    .array(z.object({ solution: z.string(), addresses: z.string(), alreadyOwned: z.boolean() }))
    .describe("8. Appropriate existing software solutions"),
  forgexSolutions: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["catalog", "custom"]),
        description: z.string(),
        problem: z.string(),
        whyNotExistingSoftware: z.string(),
      }),
    )
    .describe("9. Potential custom ForgeX solutions; empty when none is justified"),
  feasibility: z
    .object({ rating: z.enum(["high", "medium", "low", "not applicable"]), explanation: z.string() })
    .describe("10. Technical implementation feasibility"),
  aiDelivery: z
    .object({ rating: z.enum(["yes", "partly", "no", "not applicable"]), explanation: z.string() })
    .describe("11. Whether AI agents could realistically deliver the recommended solution"),
  humanReview: z.array(z.string()).describe("12. Human review and approval requirements"),
  risks: z
    .array(z.object({ type: z.enum(["security", "compliance", "operational"]), description: z.string() }))
    .describe("13. Potential security, compliance, and operational risks"),
  commercial: z
    .object({
      supportable: z.boolean(),
      value: z.string().nullable(),
      implementationCost: z.string().nullable(),
      assumptions: z.array(z.string()),
    })
    .describe("14. Preliminary commercial value and implementation cost, where supportable"),
  contacts: z
    .object({
      decisionMakerRoles: z.array(z.string()),
      people: z.array(z.object({ name: z.string(), role: z.string(), sourceUrl: z.string(), quote: z.string() })),
      channels: z.array(
        z.object({ kind: z.enum(["phone", "email", "web form", "other"]), value: z.string(), sourceUrl: z.string() }),
      ),
    })
    .describe("15. Appropriate decision-maker roles and permitted business contact channels"),
  discovery: z
    .object({ questions: z.array(z.string()), outreachSubject: z.string(), outreachBody: z.string() })
    .describe("16. Suggested discovery questions and personalized outreach"),
  evidence: z
    .object({
      sourcesUsed: z.array(z.object({ url: z.string(), usedFor: z.string() })),
      limitations: z.array(z.string()),
    })
    .describe("17. Source links and evidence limitations"),
  qualification: z
    .object({
      category: z.enum(["pursue now", "pursue later", "not a fit", "insufficient evidence"]),
      rationale: z.string(),
    })
    .describe("18. Overall commercial qualification with an explainable rationale"),
});

export type ResearchReport = z.infer<typeof ReportSchema>;
export type ReportClaim = z.infer<typeof Claim>;

/** The JSON Schema sent with each request, without the draft marker Gemini doesn't need. */
export function reportJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(ReportSchema) as Record<string, unknown>;
  return schema;
}
