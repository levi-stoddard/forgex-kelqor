import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designateFounder } from "@/lib/controls";
import type { DB } from "@/lib/db";
import { invoiceLines, invoices } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { acceptInvite } from "@/lib/domain/invites";
import { createUserWithRole } from "@/lib/domain/accounts";
import { CATEGORIES } from "@/lib/services/catalog";
import type { CustomerRequestView, OperatorRequestView } from "@/lib/services/contract";
import { processRequest } from "@/lib/services/processors";
import {
  addService,
  answerRequest,
  customerCosts,
  customerReport,
  decideRequest,
  deliverableHash,
  generateInvoice,
  getRequest,
  listCustomers,
  listInvoices,
  listRequests,
  listServices,
  onboardCustomer,
  reviewRequest,
  setInvoiceStatus,
  setServiceStatus,
  submitRequest,
} from "@/lib/services/service";
import { boiseMonth } from "@/lib/controls";
import { actorFor, freshDb, TEST_PASSWORD } from "./helpers";

// Milestone 4, the implementation agent's tests: managed services for customer organizations, with synthetic customers, simulated
// processing and simulated billing. The central property is isolation: one customer never reaches another's records.

const key = () => randomUUID();
const INQUIRY = `Hi, this is Dana Ruiz from Ridgeline Builders (208-555-0199, dana@ridgeline.test).
We need 12 steel handrail brackets, 1/4" plate, powder coated black, for a deck job. Each is about 6 x 8 inches.
We need them by Nov 15. Can you quote?
Thanks,
Dana Ruiz`;

let db: DB;
let close: () => Promise<void>;
let operator: Actor;
let clientA: Actor;
let clientB: Actor;
let orgA: string;
let orgB: string;
let serviceA: string;
let serviceB: string;
const period = boiseMonth(new Date());

async function customer(name: string, email: string) {
  const o = await onboardCustomer(db, operator, { companyName: name, contactName: `${name} Owner`, email, industry: "Manufacturing", dataClass: "test" });
  const token = o.inviteUrl.split("/").pop()!;
  await acceptInvite(db, token, { name: `${name} Owner`, password: TEST_PASSWORD });
  return { orgId: o.orgId, actor: await actorFor(db, o.userId) };
}

beforeAll(async () => {
  const h = await freshDb();
  db = h.db;
  close = h.close;
  const fid = await createUserWithRole(db, { name: "Fran Owner", email: "fran@test.local", password: TEST_PASSWORD, role: "operator" });
  await designateFounder(db, { email: "fran@test.local", password: TEST_PASSWORD });
  operator = await actorFor(db, fid);
  const a = await customer("Treasure Valley Fabrication (synthetic)", "owner@tvfab.test");
  const b = await customer("Snake River Signs (synthetic)", "owner@srsigns.test");
  orgA = a.orgId;
  clientA = a.actor;
  orgB = b.orgId;
  clientB = b.actor;
  const sa = await addService(db, operator, { orgId: orgA, category: "quote_intake", planKey: "starter", config: { customerApprovalAboveCents: 0 } }, key());
  serviceA = (await setServiceStatus(db, operator, sa.id, "activate", key())).id;
  const sb = await addService(db, operator, { orgId: orgB, category: "support_assistance", planKey: "pilot" }, key());
  serviceB = (await setServiceStatus(db, operator, sb.id, "activate", key())).id;
});

afterAll(async () => {
  await close();
});

describe("the quote-intake processor (simulated, no AI)", () => {
  it("reads a quote request, lists what's missing, and prices a draft from the customer's rate card", () => {
    const r = processRequest(CATEGORIES.quote_intake, CATEGORIES.quote_intake.defaults, { text: INQUIRY }, "Treasure Valley Fabrication");
    expect(r.simulated).toBe(true);
    expect(r.extracted.contact?.value).toMatch(/Dana Ruiz/);
    expect(r.extracted.contact?.value).toMatch(/dana@ridgeline\.test/);
    expect(r.extracted.quantity?.value).toBe("12");
    expect(r.extracted.material?.value).toMatch(/1\/4" .*steel|steel/);
    expect(r.extracted.deadline?.value).toMatch(/Nov 15/);
    expect(r.extracted.jobType?.value).toMatch(/fabrication/);
    expect(r.draft.lines.some((l) => /Powder coating/.test(l.description))).toBe(true);
    expect(r.draft.totalCents).toBeGreaterThanOrEqual(15_000);
    expect(r.draft.reply).toContain("Hi Dana");
    expect(r.draft.reply).toContain("Treasure Valley Fabrication");
    const sparse = processRequest(CATEGORIES.quote_intake, CATEGORIES.quote_intake.defaults, { text: "Can you make a gate? Need it asap." }, "Shop");
    expect(sparse.questions.length).toBeGreaterThanOrEqual(3);
    expect(sparse.flags.join(" ")).toMatch(/urgent/);
    // A gate is fabrication: the shop's usual 6 hours at $95, with the quantity assumed and said so.
    expect(sparse.draft.totalCents).toBe(57_000);
    expect(sparse.assumptions.join(" ")).toMatch(/Quantity assumed/);
  });
});

describe("a customer request, end to end (simulated processing and billing)", () => {
  it("goes from the customer's request through KELQOR's review and the customer's approval to a result and a report", async () => {
    const submitted = (await submitRequest(db, clientA, { serviceId: serviceA, text: INQUIRY, from: "Dana Ruiz, Ridgeline Builders" }, key())) as CustomerRequestView;
    expect(submitted.status).toBe("in_review");
    expect(submitted.simulated).toBe(true);
    // The customer doesn't see KELQOR's draft or internals before review.
    expect(submitted.result).toBeNull();
    expect("draft" in submitted).toBe(false);
    expect("processing" in submitted).toBe(false);
    const op = (await getRequest(db, operator, submitted.id)) as OperatorRequestView;
    expect(op.draft?.kind).toBe("quote");
    expect(op.costSource).toBe("simulated");
    // KELQOR reviews it, editing the reply, bound to the draft it saw.
    await expect(reviewRequest(db, operator, op.id, { decision: "approve", draftHash: "0".repeat(64), minutes: 6 }, key())).rejects.toMatchObject({ code: "conflict" });
    const reviewed = await reviewRequest(db, operator, op.id, { decision: "approve", draftHash: op.draftHash!, minutes: 6, note: "Checked the rates.", edits: { reply: `${op.draft!.reply}\n\nWe can start next week.` } }, key());
    expect(reviewed.status).toBe("awaiting_customer");
    // The customer sees the result and approves exactly that result; the internal note stays internal.
    const mine = (await getRequest(db, clientA, op.id)) as CustomerRequestView;
    expect(mine.result?.reply).toContain("We can start next week.");
    expect(JSON.stringify(mine)).not.toContain("Checked the rates.");
    expect(mine.allowed.approve).toBe(true);
    await expect(decideRequest(db, clientA, op.id, { decision: "approve", resultHash: "f".repeat(64) }, key())).rejects.toMatchObject({ code: "conflict" });
    const done = await decideRequest(db, clientA, op.id, { decision: "approve", resultHash: deliverableHash(mine.result)! }, key());
    expect(done.status).toBe("completed");
    // The report, the invoice (simulated) and the operator's costs.
    const report = await customerReport(db, clientA, orgA, period);
    expect(report).toMatchObject({ requestsReceived: 1, requestsCompleted: 1, approvalsGiven: 1, simulated: true });
    expect(report.quotedValueCents).toBe(mine.result!.totalCents);
    const inv = await generateInvoice(db, operator, { orgId: orgA, period }, key());
    expect(inv).toMatchObject({ status: "draft", simulated: true, totalCents: 49_900 });
    expect(await listInvoices(db, clientA)).toEqual([]);
    await setInvoiceStatus(db, operator, inv.id, "issue", key());
    expect((await listInvoices(db, clientA)).map((i) => i.label)).toEqual([`Invoice ${period}`]);
    await expect(generateInvoice(db, operator, { orgId: orgA, period }, key())).rejects.toThrow(/already issued/);
    const costs = await customerCosts(db, operator, orgA, period);
    expect(costs).toMatchObject({ revenueCents: 49_900, aiCostMicros: 0, aiCostSource: "simulated", reviewMinutes: 6, reviewCostCents: 600, marginCents: 49_300, estimated: true });
  });

  it("asks the customer for missing details, and processes the answer again", async () => {
    const r = await submitRequest(db, clientA, { serviceId: serviceA, text: "Can you build us a steel gate? Need it soon." }, key());
    const op = (await getRequest(db, operator, r.id)) as OperatorRequestView;
    const asked = await reviewRequest(db, operator, r.id, { decision: "ask_customer", draftHash: op.draftHash!, minutes: 2 }, key());
    expect(asked.status).toBe("needs_info");
    const mine = (await getRequest(db, clientA, r.id)) as CustomerRequestView;
    expect(mine.questions.length).toBeGreaterThan(0);
    expect(mine.allowed.answer).toBe(true);
    const answered = await answerRequest(db, clientA, r.id, { text: "Quantity 2, 1/4\" steel, 48 x 60 inches, by Dec 1. Contact: sam@gatebuyer.test" }, key());
    expect(answered.status).toBe("in_review");
    const again = (await getRequest(db, operator, r.id)) as OperatorRequestView;
    expect(again.processing?.extracted.quantity?.value).toBe("2");
  });

  it("acts once per request key, whatever the clicks", async () => {
    const k = key();
    const [a, b] = await Promise.all([submitRequest(db, clientB, { serviceId: serviceB, text: "A customer asks whether we deliver signs to Nampa." }, k), submitRequest(db, clientB, { serviceId: serviceB, text: "A customer asks whether we deliver signs to Nampa." }, k)].map((p) => p.catch((e) => e)));
    const ids = [a, b].filter((x) => x && x.id).map((x) => x.id);
    expect(new Set(ids).size).toBe(1);
    expect((await listRequests(db, clientB)).length).toBe(1);
  });
});

describe("isolation between customers", () => {
  it("never lets one customer reach another's services, requests, reports or invoices", async () => {
    const aRequests = await listRequests(db, clientA);
    expect(aRequests.length).toBeGreaterThan(0);
    for (const r of aRequests) {
      await expect(getRequest(db, clientB, r.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(decideRequest(db, clientB, r.id, { decision: "approve", resultHash: "a".repeat(64) }, key())).rejects.toMatchObject({ code: "not_found" });
      await expect(answerRequest(db, clientB, r.id, { text: "hello there" }, key())).rejects.toMatchObject({ code: "not_found" });
    }
    expect((await listRequests(db, clientB)).every((r) => !aRequests.some((x) => x.id === r.id))).toBe(true);
    expect((await listServices(db, clientB)).map((s) => s.orgId)).toEqual([orgB]);
    // A customer can't name another organization to see its things.
    expect((await listServices(db, clientB, orgA)).every((s) => s.orgId === orgB)).toBe(true);
    expect((await listRequests(db, clientB, { orgId: orgA })).every((r) => !aRequests.some((x) => x.id === r.id))).toBe(true);
    await expect(submitRequest(db, clientB, { serviceId: serviceA, text: "Trying to use another company's service." }, key())).rejects.toMatchObject({ code: "not_found" });
    await expect(customerReport(db, clientB, orgA, period)).rejects.toMatchObject({ code: "not_found" });
    expect((await listInvoices(db, clientB)).every((i) => i.orgId === orgB)).toBe(true);
  });

  it("keeps customers out of KELQOR's controls", async () => {
    const r = (await listRequests(db, clientA))[0];
    await expect(reviewRequest(db, clientA, r.id, { decision: "approve", draftHash: "0".repeat(64), minutes: 0 }, key())).rejects.toMatchObject({ code: "forbidden" });
    await expect(addService(db, clientA, { orgId: orgA, category: "quote_intake", planKey: "starter" }, key())).rejects.toMatchObject({ code: "forbidden" });
    await expect(setServiceStatus(db, clientA, serviceA, "pause", key())).rejects.toMatchObject({ code: "forbidden" });
    await expect(generateInvoice(db, clientA, { orgId: orgA, period }, key())).rejects.toMatchObject({ code: "forbidden" });
    await expect(customerCosts(db, clientA, orgA, period)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listCustomers(db, clientA)).rejects.toMatchObject({ code: "forbidden" });
    await expect(onboardCustomer(db, clientA, { companyName: "X Co", contactName: "X Person", email: "x@x.test", dataClass: "test" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses any invoice that isn't simulated, at the database", async () => {
    await expect(db.insert(invoices).values({ id: randomUUID(), orgId: orgB, period: "2026-01", status: "draft", simulated: false, totalCents: 100, createdById: operator.id! })).rejects.toThrow();
  });

  it("doesn't take requests for a paused service, and shows no draft service to the customer", async () => {
    await setServiceStatus(db, operator, serviceB, "pause", key());
    await expect(submitRequest(db, clientB, { serviceId: serviceB, text: "Does this still work while paused?" }, key())).rejects.toThrow(/isn't active/);
    await setServiceStatus(db, operator, serviceB, "resume", key());
    await addService(db, operator, { orgId: orgB, category: "business_reporting", planKey: "starter" }, key());
    expect((await listServices(db, clientB)).every((s) => s.status !== "draft")).toBe(true);
    expect((await listServices(db, operator, orgB)).some((s) => s.status === "draft")).toBe(true);
  });
});

describe("database guarantees (the security reviewer's M4 review)", () => {
  it("can't link a record to another customer's service or invoice, even bypassing the code", async () => {
    const { serviceRequests, invoiceLines } = await import("@/lib/db/schema");
    await expect(db.insert(serviceRequests).values({ id: randomUUID(), orgId: orgB, serviceId: serviceA, title: "x", input: { text: "cross-org", from: null, channel: "operator" }, submittedById: operator.id! })).rejects.toThrow();
    const inv = await generateInvoice(db, operator, { orgId: orgB, period }, key());
    await expect(db.insert(invoiceLines).values({ id: randomUUID(), orgId: orgA, invoiceId: inv.id, kind: "subscription", description: "x", quantity: 1, unitCents: 1, amountCents: 1 })).rejects.toThrow();
  });

  it("freezes an issued invoice and its lines, and refuses a total that doesn't match its lines", async () => {
    const { eq } = await import("drizzle-orm");
    const [issued] = (await listInvoices(db, operator, orgA)).filter((i) => i.status === "issued");
    expect(issued).toBeDefined();
    await expect(db.update(invoices).set({ totalCents: 1 }).where(eq(invoices.id, issued.id))).rejects.toThrow();
    await expect(db.delete(invoices).where(eq(invoices.id, issued.id))).rejects.toThrow();
    await expect(db.insert(invoiceLines).values({ id: randomUUID(), orgId: orgA, invoiceId: issued.id, kind: "overage", description: "slipped in", quantity: 1, unitCents: 100, amountCents: 100 })).rejects.toThrow();
    await expect(db.update(invoices).set({ status: "draft" }).where(eq(invoices.id, issued.id))).rejects.toThrow();
    const draft = (await listInvoices(db, operator, orgB)).find((i) => i.status === "draft")!;
    await expect(db.update(invoices).set({ status: "issued", totalCents: draft.totalCents + 1 }).where(eq(invoices.id, draft.id))).rejects.toThrow();
    // A line can't be moved off an issued invoice onto a draft (the security reviewer), and the tables can't be truncated.
    const [issuedA] = (await listInvoices(db, operator, orgA)).filter((i) => i.status === "issued");
    const draftA = await generateInvoice(db, operator, { orgId: orgA, period: "2026-01" }, key());
    await expect(db.update(invoiceLines).set({ invoiceId: draftA.id }).where(eq(invoiceLines.invoiceId, issuedA.id))).rejects.toThrow();
    expect((await listInvoices(db, operator, orgA)).find((i) => i.id === issuedA.id)!.lines.length).toBeGreaterThan(0);
    const { sql } = await import("drizzle-orm");
    await expect(db.execute(sql`truncate invoice_lines`)).rejects.toThrow();
    await expect(db.execute(sql`truncate invoices cascade`)).rejects.toThrow();
    // A replacement can't name another customer's invoice.
    await expect(db.update(invoices).set({ replacesInvoiceId: issuedA.id }).where(eq(invoices.id, draft.id))).rejects.toThrow();
  });

  it("lets a voided month be invoiced again, by a replacement that names the invoice it replaces", async () => {
    const draft = (await listInvoices(db, operator, orgB)).find((i) => i.status === "draft")!;
    await setInvoiceStatus(db, operator, draft.id, "issue", key());
    await setInvoiceStatus(db, operator, draft.id, "void", key());
    const replacement = await generateInvoice(db, operator, { orgId: orgB, period }, key());
    expect(replacement.id).not.toBe(draft.id);
    expect(replacement.status).toBe("draft");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(invoices).where(eq(invoices.id, replacement.id));
    expect(row.replacesInvoiceId).toBe(draft.id);
  });

  it("records a refused action as refused, hidden from the customer, and doesn't count it", async () => {
    const r = (await listRequests(db, clientA)).find((x) => x.status === "completed")!;
    await expect(decideRequest(db, clientA, r.id, { decision: "approve", resultHash: "a".repeat(64) }, key())).rejects.toMatchObject({ code: "conflict" });
    const mine = (await getRequest(db, clientA, r.id)) as CustomerRequestView;
    expect(mine.history.filter((h) => h.summary.startsWith("Approved by"))).toHaveLength(1);
    const op = (await getRequest(db, operator, r.id)) as OperatorRequestView;
    expect(op.events.some((e) => e.kind === "refused" && !e.customerVisible)).toBe(false);
    const report = await customerReport(db, clientA, orgA, period);
    expect(report.approvalsGiven).toBe(1);
  });

  it("numbers requests and invoices per customer for the customer, never revealing KELQOR's totals", async () => {
    const mine = (await listRequests(db, clientB)) as CustomerRequestView[];
    expect(mine.every((r) => /^Request \d+$/.test(r.label))).toBe(true);
    expect(Math.max(...mine.map((r) => r.number))).toBe(mine.length);
    expect((await listInvoices(db, clientA)).every((i) => i.label.startsWith("Invoice ") && i.number === 0)).toBe(true);
  });

  it("offboards a customer: services end, sign-in stops, sessions end, records stay", async () => {
    const { offboardCustomer } = await import("@/lib/services/service");
    const { authenticate } = await import("@/lib/domain/accounts");
    const before = (await listRequests(db, operator, { orgId: orgB })).length;
    await expect(offboardCustomer(db, clientB, orgB, key())).rejects.toMatchObject({ code: "forbidden" });
    const out = await offboardCustomer(db, operator, orgB, key());
    expect(out.accountsDisabled).toBe(1);
    expect((await listServices(db, operator, orgB)).every((s) => s.status === "ended")).toBe(true);
    await expect(authenticate(db, "owner@srsigns.test", TEST_PASSWORD)).rejects.toThrow();
    // Any unused invitation for the customer's accounts stops working too.
    const { invites } = await import("@/lib/db/schema");
    const { eq: same } = await import("drizzle-orm");
    const open = (await db.select().from(invites)).filter((i) => !i.usedAt && !i.revokedAt);
    const { users } = await import("@/lib/db/schema");
    const bUsers = (await db.select({ id: users.id }).from(users).where(same(users.orgId, orgB))).map((u) => u.id);
    expect(open.filter((i) => bUsers.includes(i.userId))).toEqual([]);
    expect((await listRequests(db, operator, { orgId: orgB })).length).toBe(before);
  });

  it("never calls an AI provider from managed services directly (any live processing must use the metered pathway)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "src", "lib", "services");
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(text, f).not.toMatch(/@google\/genai|@anthropic-ai|ai\/gemini|ai\/claude|missions\/providers|fetch\(/);
    }
  });
});

describe("rollback", () => {
  it("undoes migration 0007 alone, keeps M3, and lets it apply again", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { MIGRATIONS_FOLDER } = await import("@/lib/db");
    const client = new PGlite();
    const d = drizzle(client);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const since = journal.entries.find((e) => e.tag.startsWith("0007_"))!.when;
    const sql = fs.readFileSync(path.join(process.cwd(), "docs", "m4", "rollback.sql"), "utf8").replaceAll(":m4_since", String(since));
    await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    const count = async (names: string) => (await client.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_name in (${names})`)).rows[0].n;
    expect(await count("'customer_services','service_requests','service_events','invoices','invoice_lines'")).toBe(0);
    expect((await client.query<{ n: number }>("select count(*)::int as n from pg_proc where proname like 'kelqor_invoice%'")).rows[0].n).toBe(0);
    expect(await count("'eng_missions','missions','orgs'")).toBe(3);
    await migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    expect(await count("'customer_services','service_requests','service_events','invoices','invoice_lines'")).toBe(5);
    await client.close();
  });
});
