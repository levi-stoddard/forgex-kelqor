import { nextStep } from "../../components/order/labels";
import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { orgs, payments, workOrders } from "../db/schema";
import type { Actor } from "../domain/actor";
import { listBuilders, pendingPayouts } from "../domain/builders";
import { listCompanyDirectory } from "../domain/invites";
import { orderClass } from "../domain/classification";
import { aiScopingConfigured } from "../scoping/ai";
import { discoveryIndex, loadDiscovery, readinessOf, type DiscoveryRecords } from "../domain/discovery";
import { computeMetrics } from "../domain/metrics";
import { listOpportunityDecisions, type OpportunityDecisionRecord } from "../domain/opportunities";
import { getOrderView, listCarePlans, listOrders } from "../domain/orders";
import { orderRef } from "../domain/records";
import { OPPORTUNITY_DECISIONS, TERMINAL_STATUSES, WORK_ORDER_STATUSES, type DataClass, type WorkOrderStatus } from "../domain/types";
import { benchmarkPlaybook, discoveryQuestions, INDUSTRY_LABELS, isIndustry, questionText, suggestIndustry } from "../playbooks";
import { DOSSIER_SOURCE, evidenceItems, getDossier, listDossiers, type DossierDetail } from "../research/dossiers";
import { dossierFromResearch, NEW_COMPANY_ID } from "../missions/opportunity";
import { MISSION_SOURCE, researchVersions, type ResearchVersionView } from "../missions/results";
import { missionLabel } from "../missions/service";
import { researchStages } from "./research-ops";
import type {
  AiOperations,
  CompanySummary,
  DecisionRecord,
  Fixture,
  FounderItem,
  FounderQueue,
  OpportunityDetail,
  OpportunitySummary,
  OpportunityWorkflow,
  OrderDetail,
  OrderSummary,
  Overview,
  ProblemRecord,
} from "./types";

// Read models for the desktop app, assembled from the existing domain services so every permission check and
// per-role data shaping still applies. Dates go out as ISO strings.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const isOpen = (s: WorkOrderStatus) => !(TERMINAL_STATUSES as readonly string[]).includes(s);

/** Demo and test records are fixtures, never real business. The class is explicit (classification.ts); names aren't read. */
export function fixtureOf(dataClass: DataClass): Fixture {
  return dataClass === "real" ? null : dataClass;
}

function decisionRecord(r: OpportunityDecisionRecord | undefined): DecisionRecord | null {
  return r ? { decision: r.decision, note: r.note, decidedAt: iso(r.decidedAt)!, decidedBy: r.decidedBy } : null;
}

/** The latest research version of each company a mission researched for the first time (key "n0001" and on). */
async function newCompanies(db: DB): Promise<ResearchVersionView[]> {
  const latest = new Map<string, ResearchVersionView>();
  for (const v of await researchVersions(db)) if (NEW_COMPANY_ID.test(v.companyKey) && !latest.has(v.companyKey)) latest.set(v.companyKey, v);
  return [...latest.values()];
}

export async function opportunities(db: DB, actor: Actor): Promise<OpportunitySummary[]> {
  const summarize = async (source: string, list: DossierDetail[] | ReturnType<typeof listDossiers>) => {
    const decisions = await listOpportunityDecisions(db, actor, source);
    const index = await discoveryIndex(db, actor, source);
    return list.map((d) => {
      const decision = decisionRecord(decisions.get(d.id));
      const w = index.get(d.id);
      const readiness = readinessOf({ decision: decision?.decision ?? null, calls: w?.calls ?? [], problems: w?.problems ?? [], workOrderId: w?.workOrderId ?? null });
      return { ...d, decision, industry: w?.industry ?? suggestIndustry(d.researchIndustry), readiness };
    });
  };
  const fresh = (await newCompanies(db)).map((v) => dossierFromResearch(v, missionLabel(v.missionNumber ?? 0)));
  return [...(await summarize(DOSSIER_SOURCE.id, listDossiers())), ...(await summarize(MISSION_SOURCE, fresh))];
}

/** A company's saved research: a frozen benchmark dossier ("c01"), or the latest mission research of a new one ("n0001"). */
export async function opportunityRecord(db: DB, id: string): Promise<{ dossier: DossierDetail; source: string; versions: ResearchVersionView[] } | null> {
  if (NEW_COMPANY_ID.test(id)) {
    const versions = await researchVersions(db, id);
    if (!versions.length) return null;
    return { dossier: dossierFromResearch(versions[0], missionLabel(versions[0].missionNumber ?? 0)), source: MISSION_SOURCE, versions };
  }
  const d = getDossier(id);
  return d ? { dossier: d, source: DOSSIER_SOURCE.id, versions: await researchVersions(db, id) } : null;
}

/** A company's name and industry go to the existing New Work Order page; research notes and contacts never do. */
export function salePath(name: string, industry: string | null): string {
  return `/ops/new?${new URLSearchParams({ companyName: name, ...(industry && isIndustry(industry) ? { industry } : {}) })}`;
}

export async function opportunity(db: DB, actor: Actor, id: string): Promise<OpportunityDetail | null> {
  const record = await opportunityRecord(db, id);
  if (!record) return null;
  const { dossier: d, source, versions } = record;
  const decisions = await listOpportunityDecisions(db, actor, source);
  const decision = decisionRecord(decisions.get(id));
  const workflow = workflowOf(d, decision, await loadDiscovery(db, actor, source, d.id));
  const historical = source === DOSSIER_SOURCE.id;
  if (!historical) workflow.researchFrame = "Company research v2.0 prepares discovery for any industry. It doesn't qualify, score or rank the company.";
  const latest = versions[0];
  return {
    ...d,
    decision,
    source: historical
      ? { id: DOSSIER_SOURCE.id, label: `Historical: ${DOSSIER_SOURCE.label}`, dataset: `${DOSSIER_SOURCE.dataset}` }
      : { id: MISSION_SOURCE, label: `${missionLabel(latest.missionNumber ?? 0)}, ${latest.protocol}`, dataset: `Mission research, version ${latest.version}` },
    historical,
    researchVersions: versions,
    salePath: salePath(d.name, workflow.industry.value ?? workflow.industry.suggested),
    workflow,
  };
}

/** The discovery-first workflow for one company: the frozen dossier's evidence, and the owner's own records on it. */
export function workflowOf(d: DossierDetail, decision: DecisionRecord | null, r: DiscoveryRecords): OpportunityWorkflow {
  const evidence = evidenceItems(d);
  const suggested = suggestIndustry(d.industry.industry);
  const heldOn = new Map(r.calls.map((c) => [c.id, c.heldOn]));
  const problems: ProblemRecord[] = r.problems.map((p) => ({
    id: p.id,
    callId: p.callId,
    heldOn: heldOn.get(p.callId) ?? "",
    origin: p.findingKey ? "research" : "customer",
    findingKey: p.findingKey,
    statement: p.statement,
    status: p.status,
    solutionRung: p.solutionRung,
    solution: p.solution,
    // Only ids go in the address; the New Work Order page loads the problem itself.
    workOrderPath: p.status === "confirmed" && p.solutionRung ? `/ops/new?${new URLSearchParams({ opportunity: d.id, problem: p.id })}` : null,
  }));
  return {
    industry: { value: r.industry, suggested, options: INDUSTRY_LABELS },
    researchFrame: `Gemini's category was judged against the benchmark's home-services segment (protocol v1.3): ${benchmarkPlaybook().research.segment}. It isn't a verdict on any other industry.`,
    evidence,
    counts: {
      verified: evidence.filter((e) => e.level === 1).length,
      defects: evidence.filter((e) => e.level === 2).length,
      hypotheses: evidence.filter((e) => e.level === 3).length,
      founderChecks: r.checks.length,
      customerConfirmed: problems.filter((p) => p.status === "confirmed").length,
      dismissed: problems.filter((p) => p.status === "not_a_problem").length,
    },
    checks: r.checks.map((c) => ({ id: c.id, statement: c.statement, sourceUrl: c.sourceUrl, checkedOn: c.checkedOn, note: c.note, createdBy: c.createdBy, createdAt: iso(c.createdAt)! })),
    calls: r.calls.map((c) => ({
      id: c.id,
      heldOn: c.heldOn,
      contactName: c.contactName,
      contactRole: c.contactRole,
      decisionMaker: c.decisionMaker,
      software: c.software,
      priorities: c.priorities,
      desiredOutcome: c.desiredOutcome,
      valueToThem: c.valueToThem,
      tried: c.tried,
      pain: c.pain,
      nextStep: c.nextStep,
      notes: c.notes,
      answers: Object.entries(c.answers).map(([questionId, answer]) => ({ questionId, question: questionText(questionId) ?? questionId, answer })),
      recordedBy: c.recordedBy,
      createdAt: iso(c.createdAt)!,
    })),
    problems,
    figures: r.figures.map((f) => ({
      id: f.id,
      callId: f.callId,
      heldOn: r.calls.find((c) => c.id === f.callId)?.heldOn ?? "",
      statement: f.statement,
      amountCents: f.amountCents,
      period: f.period,
      basis: f.basis,
      status: f.validatedAt ? ("validated" as const) : ("customer_reported" as const),
      validatedCents: f.validatedCents,
      calculation: f.calculation,
      evidence: f.evidence,
      validatedAt: iso(f.validatedAt),
      createdAt: iso(f.createdAt)!,
    })),
    questions: discoveryQuestions(r.industry ?? suggested),
    readiness: readinessOf({ decision: decision?.decision ?? null, calls: r.calls, problems: r.problems, workOrderId: r.workOrder?.id ?? null }),
    workOrder: r.workOrder ? { ...r.workOrder, webPath: `/orders/${r.workOrder.id}` } : null,
  };
}

export async function orders(db: DB, actor: Actor): Promise<OrderSummary[]> {
  return (await listOrders(db, actor)).map((o) => ({
    id: o.id,
    ref: orderRef(o.number),
    title: o.title,
    status: o.status,
    orgName: o.orgName,
    priceCents: o.priceCents,
    builderPayoutCents: o.builderPayoutCents,
    createdAt: iso(o.createdAt)!,
    updatedAt: iso(o.updatedAt)!,
    fixture: fixtureOf(o.dataClass),
  }));
}

export async function order(db: DB, actor: Actor, id: string): Promise<OrderDetail> {
  const v = await getOrderView(db, actor, id);
  const o = v.order;
  return {
    order: {
      id: o.id,
      ref: orderRef(o.number),
      title: o.title,
      status: o.status,
      category: o.category,
      scopeSource: o.scopeSource,
      summary: o.scope.summary,
      deliverables: o.scope.deliverables,
      priceCents: o.priceCents,
      builderPayoutCents: o.builderPayoutCents,
      carePriceCents: o.carePriceCents,
      careIncluded: o.careIncluded,
      revisionCount: o.revisionCount,
      createdAt: iso(o.createdAt)!,
      quoteSentAt: iso(o.quoteSentAt),
      acceptedAt: iso(o.acceptedAt),
      fundedAt: iso(o.fundedAt),
      deliveredAt: iso(o.deliveredAt),
      completedAt: iso(o.completedAt),
      cancelledAt: iso(o.cancelledAt),
      fixture: fixtureOf(orderClass(o.isDemo, v.org.dataClass)),
    },
    org: { name: v.org.name, industry: v.org.industry, sizeBand: v.org.sizeBand },
    nextStep: nextStep(o.status, v.viewer, Boolean(v.assignedBuilder)),
    criteria: v.criteria.map((c) => ({ text: c.text, status: c.status, evidence: c.evidence, reviewNote: c.reviewNote })),
    milestones: v.milestones.map((m) => ({ title: m.title, status: m.status, completedAt: iso(m.completedAt) })),
    deliveries: v.deliveries.map((d) => ({
      round: d.round,
      summary: d.summary,
      decision: d.decision,
      decisionNote: d.decisionNote,
      decidedAt: iso(d.decidedAt),
      createdAt: iso(d.createdAt)!,
    })),
    payments: v.payments.map((p) => ({
      amountCents: p.amountCents,
      method: p.method,
      status: p.status,
      createdAt: iso(p.createdAt)!,
      succeededAt: iso(p.succeededAt),
      refundedAt: iso(p.refundedAt),
    })),
    payout: v.payout ? { amountCents: v.payout.amountCents, status: v.payout.status, paidAt: iso(v.payout.paidAt) } : null,
    carePlan: v.carePlan ? { status: v.carePlan.status, monthlyPriceCents: v.carePlan.monthlyPriceCents, activatedAt: iso(v.carePlan.activatedAt) } : null,
    economics: v.economics,
    assignedBuilder: v.assignedBuilder?.name ?? null,
    contacts: v.clientContacts.map((c) => ({ name: c.name, email: c.email, activated: Boolean(c.activated) })),
    timeline: v.timeline.map((t) => ({ type: t.type, createdAt: iso(t.createdAt)!, actorName: t.actorName })),
    messageCount: v.messages.length,
    webPath: `/orders/${o.id}`,
  };
}

export async function companies(db: DB, actor: Actor): Promise<CompanySummary[]> {
  return (await listCompanyDirectory(db, actor)).map(({ isDemo: _demo, dataClass, ...c }) => ({ ...c, dataClass, fixture: fixtureOf(dataClass), createdAt: iso(c.createdAt)! }));
}

export async function founderQueue(db: DB, actor: Actor): Promise<FounderQueue> {
  const items: FounderItem[] = [];
  const opps = await opportunities(db, actor);
  for (const o of opps) {
    if (!o.decision && (o.category === "pursue now" || o.category === "pursue later")) {
      items.push({ kind: "opportunity", title: `Qualify ${o.name}`, detail: `Gemini rated it "${o.category}". Review the dossier and decide.`, opportunityId: o.id, fixture: null });
    }
  }
  const undecided = opps.filter((o) => !o.decision && o.category !== "pursue now" && o.category !== "pursue later").length;
  if (undecided) {
    items.push({ kind: "opportunity", title: `${undecided} other researched companies have no decision`, detail: "Rated not a fit or insufficient evidence. Confirm or override when convenient.", fixture: null });
  }
  for (const o of await orders(db, actor)) {
    const at = { webPath: `/orders/${o.id}`, fixture: o.fixture };
    if (o.status === "submitted") items.push({ kind: "quote", title: `Price and send the quote for ${o.ref}`, detail: `${o.title} (${o.orgName})`, ...at });
    if (o.status === "accepted") items.push({ kind: "payment", title: `Record payment for ${o.ref} when it arrives`, detail: `${o.title} (${o.orgName})`, ...at });
    if (o.status === "disputed") items.push({ kind: "dispute", title: `Resolve the dispute on ${o.ref}`, detail: `${o.title} (${o.orgName})`, ...at });
  }
  for (const p of await pendingPayouts(db)) {
    items.push({
      kind: "payout",
      title: `Record the payout to ${p.builderName} for ${orderRef(p.number)}`,
      detail: p.testFunded ? "Not funded with real money (a TEST payment, Stripe test mode, or a demo or test company): nothing is owed." : p.title,
      webPath: `/orders/${p.workOrderId}`,
      fixture: p.testFunded ? "test" : null,
    });
  }
  for (const b of await listBuilders(db)) {
    if (b.status === "applied") items.push({ kind: "builder", title: `Review the builder application from ${b.name}`, detail: b.headline, webPath: "/ops/builders", fixture: b.isDemo ? "demo" : null });
  }
  for (const c of await listCarePlans(db, actor)) {
    if (c.status === "requested") items.push({ kind: "care", title: `Activate the monthly service for ${orderRef(c.number)}`, detail: `${c.title} (${c.orgName})`, webPath: `/orders/${c.workOrderId}`, fixture: fixtureOf(c.dataClass) });
  }
  const spendingApprovals = researchStages().map((s) => ({ stage: s.stage, capUsd: s.capUsd, approvedOn: s.approvedOn, models: s.models, spentUsd: s.spentUsd }));
  return { items, spendingApprovals };
}

export async function overview(db: DB, actor: Actor): Promise<Overview> {
  const opps = await opportunities(db, actor);
  const byCategory = { "pursue now": 0, "pursue later": 0, "not a fit": 0, "insufficient evidence": 0, none: 0 };
  const byDecision = Object.fromEntries([...OPPORTUNITY_DECISIONS, "undecided"].map((k) => [k, 0])) as Overview["opportunities"]["byDecision"];
  for (const o of opps) {
    byCategory[o.category ?? "none"] += 1;
    byDecision[o.decision?.decision ?? "undecided"] += 1;
  }
  const list = await orders(db, actor);
  const real = list.filter((o) => !o.fixture);
  const byStatus = Object.fromEntries(WORK_ORDER_STATUSES.map((s) => [s, 0])) as Record<WorkOrderStatus, number>;
  for (const o of real) byStatus[o.status] += 1;
  const comps = await companies(db, actor);
  // The same metrics as the web dashboard: real money only, with test and unverified money reported apart. "All"
  // takes in demo and test companies so their money shows as test money; real totals are the same either way.
  const all = await computeMetrics(db, { includeDemo: true });
  const realMoney = await computeMetrics(db);
  const queue = await founderQueue(db, actor);
  return {
    opportunities: { total: opps.length, byCategory, byDecision },
    orders: {
      real: real.length,
      fixtures: list.length - real.length,
      openReal: real.filter((o) => isOpen(o.status)).length,
      openFixtures: list.filter((o) => o.fixture && isOpen(o.status)).length,
      byStatus,
    },
    companies: { real: comps.filter((c) => !c.fixture).length, fixtures: comps.filter((c) => c.fixture).length },
    money: {
      collectedCents: realMoney.cash.collectedCents,
      mrrCents: realMoney.care.mrrCents,
      testCollectedCents: all.cash.testCollectedCents,
      testMrrCents: all.care.testMrrCents,
      unverifiedCents: all.cash.unverifiedCents,
    },
    ai: { researchSpendUsd: researchStages().reduce((sum, s) => sum + s.spentUsd, 0), scopingCostUsd: realMoney.aiCostDollars },
    founderItems: queue.items.length,
  };
}

export async function aiOperations(db: DB, actor: Actor): Promise<AiOperations> {
  const opps = await opportunities(db, actor);
  const scoped = await db.select({ scopeSource: workOrders.scopeSource, isDemo: workOrders.isDemo }).from(workOrders);
  const all = await computeMetrics(db, { includeDemo: true });
  return {
    research: { stages: researchStages(), primaryModel: DOSSIER_SOURCE.model, recordsShown: opps.length },
    providers: { gemini: Boolean(process.env.GEMINI_API_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY) },
    scoping: {
      authorized: aiScopingConfigured(),
      ai: scoped.filter((s) => s.scopeSource === "ai").length,
      template: scoped.filter((s) => s.scopeSource === "template").length,
      operator: scoped.filter((s) => s.scopeSource === "operator").length,
      aiCostUsd: all.aiCostDollars,
      demoIncluded: scoped.some((s) => s.isDemo),
    },
    // Committed roadmap items (docs/ROADMAP.md). None is built or simulated; nothing here runs an agent.
    notAvailable: [
      { milestone: "M2B", name: "Owner-authorized research runs from this app", note: "Research runs today only through the benchmark runner, under a spending authorization in authorizations.json." },
      { milestone: "M2B", name: "On-demand AI missions: assignment, status, results and verification", note: "Planned; nothing in this app runs an agent today." },
      { milestone: "M2B", name: "AI usage ledger, spending limits and action approvals", note: "Research has its own budget guard and ledger; the general version for every AI task is planned." },
      { milestone: "M2B", name: "Claude scoping with a spending limit", note: "Off until it has a limit, your authorization and safe failure behaviour. Templates draft every scope meanwhile." },
      { milestone: "M3", name: "Coordination with Claude Code and Gemini Antigravity", note: "Planned through supported integrations. This app doesn't connect to or control those sessions." },
      { milestone: "M4", name: "Customer managed-AI services and a simple customer AI experience", note: "Planned. Customers use the web app's client area today." },
      { milestone: "M5", name: "Cloud, on-premises and hybrid operation", note: "Planned as commercially justified. Everything runs on this computer today." },
    ],
  };
}
