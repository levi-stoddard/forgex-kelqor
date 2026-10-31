import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSessionToken } from "@/lib/auth/session";
import type { DB } from "@/lib/db";
import { carePlans, events, opportunityProblems, orgs, outbox, payments, payouts, workOrders } from "@/lib/db/schema";
import { handleDesktopRequest, type DesktopRequest } from "@/lib/desktop/api";
import type { OpportunityDetail, OpportunityWorkflow, Overview } from "@/lib/desktop/types";
import { registerClient } from "@/lib/domain/accounts";
import type { Actor } from "@/lib/domain/actor";
import { SYSTEM_ACTOR } from "@/lib/domain/actor";
import { builderEarnings } from "@/lib/domain/builders";
import { moneyClass, orderClass } from "@/lib/domain/classification";
import { linkOpportunityWorkOrder, readinessOf, recordDiscoveryCall, setOpportunityIndustry, setProblemSolution, workOrderPrefill } from "@/lib/domain/discovery";
import { createClientForSale, setCompanyDataClass } from "@/lib/domain/invites";
import { computeMetrics } from "@/lib/domain/metrics";
import { acceptQuote, createWorkOrder, recordPayment, sendQuote } from "@/lib/domain/orders";
import { discoveryQuestions, INDUSTRY_LABELS, questionText, suggestIndustry } from "@/lib/playbooks";
import { benchmarkRoot, DOSSIER_SOURCE, evidenceItems, getDossier, listDossiers } from "@/lib/research/dossiers";
import { systemPrompt } from "@/lib/research/spec";
import { draftScope } from "@/lib/scoping";
import { aiScopingConfigured } from "@/lib/scoping/ai";
import { isWebAppPath } from "../desktop/src/main/security";
import { freshDb, SAMPLE_INTAKE, seedParties } from "./helpers";

// Milestone 2A: money that counts only real companies' real money, and the discovery-first Opportunity Center.
// No model is ever called, and the frozen research files are only read.

let db: DB;
let close: () => Promise<void>;
let operator: Actor;
let client: Actor;
let builderId: string;
let token: string;

const recordFiles = () => {
  const dir = path.join(benchmarkRoot(), DOSSIER_SOURCE.stage, DOSSIER_SOURCE.model);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
};
const fingerprint = () => recordFiles().map((f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex")).join(",");
let before: string;

beforeAll(async () => {
  before = fingerprint();
  process.env.ALLOW_TEST_PAYMENTS = "true";
  const h = await freshDb();
  db = h.db;
  close = h.close;
  const parties = await seedParties(db);
  operator = parties.operator;
  client = parties.client;
  builderId = parties.builder.builderId!;
  token = (await issueSessionToken(db, operator.id!)).token;
});
afterAll(async () => {
  await close();
});

function req(method: string, route: string, body?: unknown, t = token): DesktopRequest {
  const headers = new Headers({ host: "127.0.0.1:3000", authorization: `Bearer ${t}` });
  return { method, path: route.split("/"), headers, json: async () => body };
}
const api = async <T>(method: string, route: string, body?: unknown, t?: string) => {
  const res = await handleDesktopRequest(async () => db, req(method, route, body, t), { NODE_ENV: "test" });
  return { status: res.status, data: (res.body as { data?: T }).data as T, error: (res.body as { error?: string }).error };
};

async function orderFor(orgId: string) {
  const o = await createWorkOrder(db, operator, SAMPLE_INTAKE, { orgId });
  await db.update(workOrders).set({ priceCents: 100_000, builderPayoutCents: 0 }).where(eq(workOrders.id, o.id));
  return o.id;
}
async function paid(orderId: string, amountCents: number, method: "offline" | "stripe" | "test", livemode: boolean | null = null) {
  await db.insert(payments).values({ id: randomUUID(), workOrderId: orderId, amountCents, method, status: "succeeded", livemode, succeededAt: new Date() });
}
async function monthly(orderId: string, orgId: string, cents: number) {
  await db.insert(carePlans).values({ id: randomUUID(), workOrderId: orderId, orgId, monthlyPriceCents: cents, builderShareCents: 0, status: "active", activatedAt: new Date() });
}

describe("money: only real companies' real money counts", () => {
  let testOrg: string;
  let demoOrg: string;
  let testOrder: string;

  it("gives every company an explicit class when it's created, and never reads names", async () => {
    await expect(createClientForSale(db, operator, { companyName: "Unstated Co", contactName: "Una", email: "una@unstated.test", dataClass: "" })).rejects.toThrow(/real customer or a test record/);
    const t = await createClientForSale(db, operator, { companyName: "Practice Plumbing", contactName: "Pat", email: "pat@practice.test", dataClass: "test" });
    testOrg = t.orgId;
    const demo = await registerClient(db, { name: "Dee Demo", email: "dee@demo.test", password: "a-demo-password-1", companyName: "Seeded Demo Heating" }, { isDemo: true });
    demoOrg = demo.orgId;
    const named = await createClientForSale(db, operator, { companyName: "Looks Like A Test (test)", contactName: "Ray", email: "ray@real.test", dataClass: "real" });
    const classOf = async (id: string) => (await db.select({ c: orgs.dataClass }).from(orgs).where(eq(orgs.id, id)))[0].c;
    expect(await classOf(testOrg)).toBe("test");
    expect(await classOf(demoOrg)).toBe("demo");
    expect(await classOf(named.orgId)).toBe("real"); // stated real, whatever the name says
    expect(await classOf(client.orgId!)).toBe("real"); // a public sign-up
  });

  it("splits money into real, test and unverified, and keeps the last two out of every real total", async () => {
    const real = await orderFor(client.orgId!);
    const live = await orderFor(client.orgId!);
    const stripeTest = await orderFor(client.orgId!);
    const unknown = await orderFor(client.orgId!);
    testOrder = await orderFor(testOrg);
    const demoOrder = await orderFor(demoOrg); // written up through the sale flow: the order itself isn't flagged demo
    await paid(real, 100_000, "offline");
    await paid(live, 50_000, "stripe", true);
    await paid(stripeTest, 40_000, "stripe", false);
    await paid(unknown, 30_000, "stripe", null);
    await paid(testOrder, 20_000, "offline");
    await paid(demoOrder, 10_000, "offline");
    await monthly(real, client.orgId!, 14_900);
    await monthly(stripeTest, client.orgId!, 9_900);
    await monthly(testOrder, testOrg, 24_900);

    const m = await computeMetrics(db);
    expect(m.cash.collectedCents).toBe(150_000); // the bank transfer and the live Stripe payment
    expect(m.cash.testCollectedCents).toBe(40_000); // Stripe test mode
    expect(m.cash.unverifiedCents).toBe(30_000); // mode never recorded: neither real nor test
    expect(m.care.mrrCents).toBe(14_900);
    expect(m.care.testMrrCents).toBe(9_900);
    expect(m.funnel.requests).toBe(4); // the real company's orders only

    const all = await computeMetrics(db, { includeDemo: true });
    expect(all.cash.collectedCents).toBe(150_000); // real money is the same with demo and test companies included
    expect(all.cash.testCollectedCents).toBe(70_000);
    expect(all.care.testMrrCents).toBe(34_800);

    const overview = await api<Overview>("GET", "overview");
    expect(overview.data.money).toEqual({ collectedCents: 150_000, mrrCents: 14_900, testCollectedCents: 70_000, testMrrCents: 34_800, unverifiedCents: 30_000 });
  });

  it("classifies payments and orders by rule", () => {
    expect(orderClass(true, "real")).toBe("demo");
    expect(orderClass(false, "test")).toBe("test");
    expect(moneyClass({ method: "offline", livemode: null }, "real")).toBe("real");
    expect(moneyClass({ method: "offline", livemode: null }, "test")).toBe("test");
    expect(moneyClass({ method: "stripe", livemode: true }, "demo")).toBe("test");
    expect(moneyClass({ method: "test", livemode: null }, "real")).toBe("test");
  });

  it("stores Stripe's live/test flag with each Stripe payment", async () => {
    const o = await createWorkOrder(db, operator, SAMPLE_INTAKE, { orgId: client.orgId! });
    await sendQuote(db, operator, o.id, { priceCents: 60_000, builderPayoutCents: 0, carePriceCents: null });
    await acceptQuote(db, client, o.id, true);
    await recordPayment(db, SYSTEM_ACTOR, o.id, { method: "stripe", stripeSessionId: `cs_test_${randomUUID()}`, amountCents: 60_000, livemode: false });
    const [p] = await db.select().from(payments).where(eq(payments.workOrderId, o.id));
    expect(p.livemode).toBe(false);
    expect((await computeMetrics(db)).cash.collectedCents).toBe(150_000); // a test-mode Stripe payment adds nothing real
  });

  it("owes no real payout on a test company's order", async () => {
    await db.insert(payouts).values({ id: randomUUID(), workOrderId: testOrder, builderId, amountCents: 5_000, status: "pending" });
    const e = await builderEarnings(db, builderId);
    expect(e.pendingCents).toBe(0);
    expect(e.rows.find((r) => r.workOrderId === testOrder)?.testFunded).toBe(true);
  });

  it("lets only an operator correct a company's class, audited, and the money follows", async () => {
    await expect(setCompanyDataClass(db, client, { orgId: testOrg, dataClass: "real" })).rejects.toThrow(/permission/);
    await setCompanyDataClass(db, operator, { orgId: testOrg, dataClass: "real" });
    expect((await computeMetrics(db)).cash.collectedCents).toBe(170_000);
    const [audit] = await db.select().from(events).where(eq(events.type, "company_reclassified"));
    expect(audit.data).toMatchObject({ orgId: testOrg, from: "test", to: "real" });
    const res = await api<{ dataClass: string }>("PUT", `companies/${testOrg}/class`, { dataClass: "test" });
    expect(res.data.dataClass).toBe("test");
    expect((await computeMetrics(db)).cash.collectedCents).toBe(150_000);
  });
});

describe("evidence, industries and the frozen benchmark", () => {
  it("puts every research statement at level 1, 2 or 3, never higher", () => {
    const all = listDossiers().flatMap((d) => evidenceItems(getDossier(d.id)!));
    expect(all.length).toBeGreaterThan(400);
    expect(all.every((e) => e.level === 1 || e.level === 2 || e.level === 3)).toBe(true);
    const c13 = evidenceItems(getDossier("c13")!);
    expect(c13.find((e) => e.key === "opportunityEvidence.0")).toMatchObject({ level: 2, predictedPain: true }); // the dead email address
    const c22 = evidenceItems(getDossier("c22")!);
    expect(c22.find((e) => e.key === "opportunityEvidence.2")?.statement).toMatch(/expiration date of 7\/31\/25/);
    expect(c22.find((e) => e.key === "opportunityEvidence.2")?.level).toBe(2);
    expect(c22.filter((e) => e.key.startsWith("problems.")).every((e) => e.level === 3)).toBe(true); // the model's problems are never checked
  });

  it("suggests each company's own industry, not home services for everyone", () => {
    const by: Record<string, string[]> = {};
    for (const d of listDossiers()) (by[suggestIndustry(d.researchIndustry) ?? "none"] ??= []).push(d.id);
    expect(by["Manufacturing"]).toEqual(["c01", "c03", "c04", "c08", "c11"]);
    expect(by["IT and technology services"]).toEqual(["c02", "c09", "c15", "c21", "c23"]);
    expect(by["Home services and trades"]).toHaveLength(15);
    expect(suggestIndustry("Audit services for nonprofits")).toBeNull(); // "it services" only matches from a word start
  });

  it("asks every industry the general questions, and adds an industry's own", () => {
    expect(discoveryQuestions("Manufacturing").map((q) => q.id)).toEqual(["time", "repetitive", "dropped", "costly", "software", "tried", "automate", "worth"]);
    expect(discoveryQuestions("Home services and trades")).toHaveLength(15);
    expect(questionText("hs-after-hours")).toMatch(/after hours/);
    for (const before of ["Home services and trades", "Accounting and bookkeeping", "Insurance agency", "Property management", "Professional services", "Other"]) {
      expect(INDUSTRY_LABELS).toContain(before); // every value the forms offered before still exists
    }
  });

  it("still sends the benchmark's research prompt exactly as it ran", () => {
    const run = JSON.parse(fs.readFileSync(path.join(benchmarkRoot(), "full-run", "runs", "2026-10-27T18-20-08-426Z.json"), "utf8")) as { systemPromptSha256: string };
    expect(createHash("sha256").update(systemPrompt()).digest("hex")).toBe(run.systemPromptSha256);
  });
});

describe("discovery-first Opportunity Center", () => {
  let wf: OpportunityWorkflow;

  it("starts at research, labels the research frame, and waits for the owner's decision", async () => {
    const res = await api<OpportunityDetail>("GET", "opportunities/c22");
    wf = res.data.workflow;
    expect(wf.readiness.stage).toBe("not_qualified");
    expect(wf.industry).toMatchObject({ value: null, suggested: "Home services and trades" });
    expect(wf.researchFrame).toMatch(/home-services segment/);
    expect(wf.counts).toMatchObject({ defects: 5, customerConfirmed: 0 });
    await api("PUT", "opportunities/c22/decision", { decision: "qualified", note: "Discovery only." });
    expect((await api<OpportunityDetail>("GET", "opportunities/c22")).data.workflow.readiness.stage).toBe("ready_for_discovery");
  });

  it("records the owner's own checks with their source", async () => {
    const bad = await api("POST", "opportunities/c22/checks", { statement: "LinkedIn lists 11-50 employees", sourceUrl: "", checkedOn: "2026-10-27", note: "" });
    expect(bad.status).toBe(400); // a source or a note is required
    const res = await api<OpportunityWorkflow>("POST", "opportunities/c22/checks", {
      statement: "LinkedIn lists 11-50 employees",
      sourceUrl: "https://www.linkedin.com/company/example",
      checkedOn: "2026-10-27",
      note: "",
    });
    expect(res.data.checks).toHaveLength(1);
    expect(res.data.counts.founderChecks).toBe(1);
  });

  it("never makes a problem customer-confirmed without a recorded conversation", async () => {
    // The database itself refuses a problem without its conversation.
    await expect(
      db.insert(opportunityProblems).values({ id: randomUUID(), source: DOSSIER_SOURCE.id, recordId: "c22", callId: randomUUID(), statement: "x", status: "confirmed", createdById: operator.id! }),
    ).rejects.toThrow();
    const base = { heldOn: "2026-10-27", contactName: "", contactRole: "", decisionMaker: "unknown", software: "", priorities: "", desiredOutcome: "", valueToThem: "", tried: "", pain: null, nextStep: "", notes: "", answers: {}, problems: [] };
    expect((await api("POST", "opportunities/c22/calls", { ...base, findings: [{ key: "opportunityEvidence.99", status: "confirmed" }] })).status).toBe(400);
    expect((await api("POST", "opportunities/c22/calls", { ...base, findings: [{ key: "identity.0", status: "confirmed" }] })).status).toBe(400); // company info isn't a predicted problem
    expect((await api("POST", "opportunities/c22/calls", { ...base, findings: [] })).status).toBe(400); // nothing they said
    expect((await api("POST", "opportunities/c22/calls", { ...base, heldOn: "2999-01-01", notes: "x" })).status).toBe(400); // not in the future
  });

  it("records a conversation in the customer's words and reopens it", async () => {
    const res = await api<OpportunityWorkflow>("POST", "opportunities/c22/calls", {
      heldOn: "2026-10-27",
      contactName: "Sample Owner",
      contactRole: "Owner",
      decisionMaker: "yes",
      software: "ServiceTitan, QuickBooks",
      priorities: "Fewer missed web requests",
      desiredOutcome: "Every web request reaches dispatch within 5 minutes",
      valueToThem: "Two booked jobs a month would pay for it",
      tried: "Checking the inbox more often",
      pain: 2,
      nextStep: "Send a short proposal",
      notes: "",
      answers: { time: "Re-keying web requests into ServiceTitan", "hs-after-hours": "It waits until morning" },
      problems: ["Web requests sit in an inbox until someone retypes them into ServiceTitan"],
      findings: [
        { key: "opportunityEvidence.2", status: "confirmed" },
        { key: "problems.0", status: "not_a_problem" },
      ],
    });
    expect(res.status).toBe(200);
    const reopened = (await api<OpportunityDetail>("GET", "opportunities/c22")).data.workflow;
    expect(reopened.calls).toHaveLength(1);
    expect(reopened.calls[0].answers.find((a) => a.questionId === "hs-after-hours")?.question).toMatch(/after hours/);
    const confirmed = reopened.problems.filter((p) => p.status === "confirmed");
    expect(confirmed.map((p) => p.origin).sort()).toEqual(["customer", "research"]);
    // A confirmed research finding keeps the research's wording, not anything the window sent.
    expect(confirmed.find((p) => p.origin === "research")?.statement).toBe(evidenceItems(getDossier("c22")!).find((e) => e.key === "opportunityEvidence.2")!.statement);
    expect(reopened.counts).toMatchObject({ customerConfirmed: 2, dismissed: 1 });
    expect(reopened.readiness.stage).toBe("choose_solution");
    wf = reopened;
  });

  it("gives a solution only to a confirmed problem", async () => {
    const dismissed = wf.problems.find((p) => p.status === "not_a_problem")!;
    expect((await api("PUT", `opportunities/c22/problems/${dismissed.id}/solution`, { rung: "configuration", solution: "Remove it" })).status).toBe(400);
    const raised = wf.problems.find((p) => p.origin === "customer")!;
    const res = await api<OpportunityWorkflow>("PUT", `opportunities/c22/problems/${raised.id}/solution`, { rung: "integration", solution: "Send web form requests straight into ServiceTitan" });
    expect(res.data.readiness.stage).toBe("ready_to_propose"); // the owner was in the call
    wf = res.data;
  });

  it("drafts a Work Order from a confirmed problem without committing anyone", async () => {
    const problem = wf.problems.find((p) => p.origin === "customer")!;
    expect(problem.workOrderPath).toBe(`/ops/new?opportunity=c22&problem=${problem.id}`);
    expect(isWebAppPath(problem.workOrderPath!)).toBe(true);
    const prefill = (await workOrderPrefill(db, operator, { source: DOSSIER_SOURCE.id, recordId: "c22", problemId: problem.id }))!;
    expect(prefill.problem).toMatch(/^Web requests sit in an inbox[\s\S]*Simplest solution identified: An integration between their tools: Send web form requests/);
    expect(prefill).toMatchObject({ desiredOutcome: "Every web request reaches dispatch within 5 minutes", currentTools: "ServiceTitan, QuickBooks", industry: null });
    expect(await workOrderPrefill(db, operator, { source: DOSSIER_SOURCE.id, recordId: "c22", problemId: wf.problems.find((p) => p.status === "not_a_problem")!.id })).toBeNull();

    // What the New Work Order page's action does with that prefill, step by step.
    const { orgId } = await createClientForSale(db, operator, { companyName: "Plumbing Solutions of Idaho", contactName: "Sample Owner", email: "owner@example.test", dataClass: "real" });
    const order = await createWorkOrder(db, operator, { ...SAMPLE_INTAKE, problem: prefill.problem, desiredOutcome: prefill.desiredOutcome, currentTools: prefill.currentTools, templateSlug: null }, { orgId });
    await linkOpportunityWorkOrder(db, operator, { source: DOSSIER_SOURCE.id, recordId: "c22", companyName: "Plumbing Solutions of Idaho", workOrderId: order.id, problemId: problem.id });
    const [o] = await db.select().from(workOrders).where(eq(workOrders.id, order.id));
    expect(o.status).toBe("submitted"); // unpriced and unquoted
    expect(o.quoteSentAt).toBeNull();
    expect(await db.select().from(payments).where(eq(payments.workOrderId, order.id))).toHaveLength(0);
    expect(await db.select().from(outbox).where(eq(outbox.toEmail, "owner@example.test"))).toHaveLength(0); // nothing goes to the customer
    const after = (await api<OpportunityDetail>("GET", "opportunities/c22")).data.workflow;
    expect(after.readiness.stage).toBe("work_order_drafted");
    expect(after.workOrder?.id).toBe(order.id);
  });

  it("lets the owner set the industry, and only to a listed one", async () => {
    expect((await api("PUT", "opportunities/c06/industry", { industry: "Spaceships" })).status).toBe(400);
    const res = await api<OpportunityWorkflow>("PUT", "opportunities/c06/industry", { industry: "Manufacturing" });
    expect(res.data.industry.value).toBe("Manufacturing");
    expect(res.data.questions).toHaveLength(8); // the manufacturing questions are the general ones for now
  });

  it("moves readiness only on recorded evidence", () => {
    const call = (decisionMaker: "yes" | "no" | "unknown") => ({ decisionMaker });
    const base = { decision: "qualified" as const, calls: [], problems: [], workOrderId: null };
    expect(readinessOf({ ...base, decision: null }).stage).toBe("not_qualified");
    expect(readinessOf({ ...base, decision: "rejected" }).stage).toBe("not_pursuing");
    expect(readinessOf(base).stage).toBe("ready_for_discovery");
    expect(readinessOf({ ...base, calls: [call("no")] }).stage).toBe("no_confirmed_problem");
    const confirmed = { status: "confirmed" as const, solutionRung: null };
    expect(readinessOf({ ...base, calls: [call("no")], problems: [confirmed] }).stage).toBe("choose_solution");
    expect(readinessOf({ ...base, calls: [call("no")], problems: [{ ...confirmed, solutionRung: "configuration" }] }).stage).toBe("confirm_decision_maker");
    expect(readinessOf({ ...base, calls: [call("yes")], problems: [{ ...confirmed, solutionRung: "configuration" }] }).stage).toBe("ready_to_propose");
  });

  it("refuses all of it to anyone but an operator", async () => {
    const ref = { source: DOSSIER_SOURCE.id, recordId: "c22", companyName: "Plumbing Solutions of Idaho" };
    await expect(setOpportunityIndustry(db, client, { ...ref, industry: null })).rejects.toThrow(/operators/);
    await expect(recordDiscoveryCall(db, SYSTEM_ACTOR, { ...ref, heldOn: "2026-10-27", contactName: "", contactRole: "", decisionMaker: "unknown", software: "", priorities: "", desiredOutcome: "", valueToThem: "", tried: "", pain: null, nextStep: "", notes: "x", answers: {}, problems: [], findings: [] })).rejects.toThrow(/operators/);
    await expect(setProblemSolution(db, client, { source: ref.source, recordId: "c22", problemId: randomUUID(), rung: "configuration", solution: "x x" })).rejects.toThrow(/operators/);
    const clientToken = (await issueSessionToken(db, client.id!)).token;
    expect((await api("POST", "opportunities/c22/checks", { statement: "x", sourceUrl: "", checkedOn: "2026-10-27", note: "y" }, clientToken)).status).toBe(403);
  });

  it("audits every change and leaves the frozen research files untouched", async () => {
    const types = (await db.select({ type: events.type }).from(events)).map((e) => e.type);
    for (const t of ["opportunity_checked", "discovery_recorded", "problem_solution_set", "drafted_from_discovery", "opportunity_industry_set"]) expect(types).toContain(t);
    const calls = await db.select().from(opportunityProblems).where(and(eq(opportunityProblems.recordId, "c22"), eq(opportunityProblems.status, "confirmed")));
    expect(calls.every((p) => p.callId)).toBe(true);
    expect(fingerprint()).toBe(before);
  });
});

describe("Claude scoping stays off until it has a spending limit", () => {
  it("ignores an Anthropic key, so no model call can happen", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9"; // even a broken lock couldn't reach Anthropic from here
    try {
      expect(aiScopingConfigured()).toBe(false);
      const draft = await draftScope(SAMPLE_INTAKE, { useAi: true });
      expect(draft).toMatchObject({ source: "template", costMicros: 0 });
      expect(draft.aiError).toBeUndefined(); // no attempt was made, so nothing failed
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.url;
    }
  });
});
