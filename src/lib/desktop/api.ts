import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { allowAttempt } from "../auth/rate-limit";
import { issueSessionToken, revokeSessionToken, toActor, userForSessionToken } from "../auth/session";
import { closeDb, MigrationNeedsBackup, type DB } from "../db";
import { users } from "../db/schema";
import { authenticate, normalizeEmail } from "../domain/accounts";
import type { Actor } from "../domain/actor";
import { addOpportunityCheck, recordCustomerFigure, recordDiscoveryCall, setOpportunityIndustry, setProblemSolution, validateCustomerFigure } from "../domain/discovery";
import { DomainError } from "../domain/errors";
import { setCompanyDataClass } from "../domain/invites";
import { setOpportunityDecision } from "../domain/opportunities";
import { DATA_CLASSES, DECISION_MAKER_ANSWERS, PROBLEM_STATUSES, SOLUTION_RUNGS } from "../domain/types";
import { evidenceItems } from "../research/dossiers";
import { aiRoute } from "./ai";
import { engineeringRoute } from "./engineering";
import { customersRoute } from "./customers";
import { desktopApiBlocked } from "./gate";
import type { DecisionRecord, SessionGrant } from "./types";
import { aiOperations, companies, founderQueue, opportunities, opportunity, opportunityRecord, order, orders, overview } from "./views";

// The local backend's interface for the KELQOR desktop app. Every route but sign-in needs a bearer session token
// belonging to an operator, and calls the same domain services as the web app, so permissions are unchanged.

export interface DesktopRequest {
  method: string;
  path: string[];
  headers: Headers;
  json: () => Promise<unknown>;
}

export interface DesktopResponse {
  status: number;
  body: { data: unknown } | { error: string };
}

const SignIn = z.object({ email: z.string().min(3).max(320), password: z.string().min(1).max(200) });
const Decision = z.object({ decision: z.string(), note: z.string().max(4000).optional() });
const IndustryBody = z.object({ industry: z.string().max(100).nullable() });
const CheckBody = z.object({ statement: z.string().max(1000), sourceUrl: z.string().max(2000), checkedOn: z.string().max(10), note: z.string().max(2000) });
const field = (max: number) => z.string().max(max);
const CallBody = z.object({
  heldOn: field(10),
  contactName: field(200),
  contactRole: field(200),
  decisionMaker: z.enum(DECISION_MAKER_ANSWERS),
  software: field(2000),
  priorities: field(2000),
  desiredOutcome: field(2000),
  valueToThem: field(2000),
  tried: field(2000),
  pain: z.number().int().min(0).max(3).nullable(),
  nextStep: field(1000),
  notes: field(4000),
  answers: z.record(z.string().max(40), field(2000)),
  problems: z.array(field(1000)).max(10),
  findings: z.array(z.object({ key: z.string().max(40), status: z.enum(PROBLEM_STATUSES) })).max(40),
});
const SolutionBody = z.object({ rung: z.enum(SOLUTION_RUNGS), solution: field(2000) });
const FigureBody = z.object({ callId: z.string().regex(/^[0-9a-f-]{36}$/), statement: field(500), amountCents: z.number().int().min(0).max(10_000_000_000), period: field(60), basis: field(1000) });
const ValidationBody = z.object({ validatedCents: z.number().int().min(0).max(10_000_000_000), calculation: field(2000), evidence: field(2000) });
const ClassBody = z.object({ dataClass: z.enum(DATA_CLASSES) });

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<DomainError["code"], number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

function bearer(headers: Headers): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body<T>(req: DesktopRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "The request is missing required fields.");
  return parsed.data;
}

async function signIn(db: DB, req: DesktopRequest): Promise<SessionGrant> {
  const { email, password } = await body(req, SignIn);
  if (!allowAttempt(`desktop-signin:${normalizeEmail(email)}`, 10, 15 * 60 * 1000)) {
    throw new HttpError(429, "Too many sign-in attempts. Wait a few minutes and try again.");
  }
  const userId = await authenticate(db, email, password);
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  // Only operators get a desktop session in this release; clients and builders keep using the web app.
  if (!user || user.role !== "operator") throw new HttpError(403, "The KELQOR Command Center is for operators in this release.");
  const { token, expiresAt } = await issueSessionToken(db, userId);
  return { token, expiresAt: expiresAt.toISOString(), user: { id: user.id, name: user.name, email: user.email, role: "operator" } };
}

async function operator(db: DB, req: DesktopRequest): Promise<{ actor: Actor; token: string }> {
  const token = bearer(req.headers);
  const user = token ? await userForSessionToken(db, token) : null;
  if (!token || !user) throw new HttpError(401, "Your session has ended. Sign in again.");
  if (user.role !== "operator") throw new HttpError(403, "The KELQOR Command Center is for operators in this release.");
  return { actor: toActor(user), token };
}

async function route(db: DB, req: DesktopRequest): Promise<unknown> {
  const method = req.method.toUpperCase();
  const p = req.path;
  const at = (m: string, ...parts: (string | RegExp)[]) =>
    method === m && p.length === parts.length && parts.every((part, i) => (typeof part === "string" ? part === p[i] : part.test(p[i])));

  if (at("POST", "session")) return signIn(db, req);

  const { actor, token } = await operator(db, req);
  if (at("DELETE", "session")) {
    await revokeSessionToken(db, token);
    return { signedOut: true };
  }
  if (at("GET", "me")) return { id: actor.id, name: actor.name, email: actor.email, role: actor.role };
  if (at("GET", "overview")) return overview(db, actor);
  if (at("GET", "opportunities")) return opportunities(db, actor);
  const RECORD = /^(c\d{2}|n\d{4})$/;
  if (at("GET", "opportunities", RECORD)) {
    const found = await opportunity(db, actor, p[1]);
    if (!found) throw new HttpError(404, "That research dossier doesn't exist.");
    return found;
  }
  if (at("PUT", "opportunities", RECORD, "decision")) {
    const record = await opportunityRecord(db, p[1]);
    if (!record) throw new HttpError(404, "That research dossier doesn't exist.");
    const dossier = record.dossier;
    const input = await body(req, Decision);
    const saved = await setOpportunityDecision(db, actor, {
      source: record.source,
      recordId: dossier.id,
      companyName: dossier.name,
      decision: input.decision,
      note: input.note,
    });
    const answer: DecisionRecord = { decision: saved.decision, note: saved.note, decidedAt: saved.decidedAt.toISOString(), decidedBy: saved.decidedBy };
    return answer;
  }
  // Discovery-first work on a researched company. Each change returns the company's updated workflow.
  if (p[0] === "opportunities" && RECORD.test(p[1] ?? "") && p.length >= 3 && p[2] !== "decision") {
    const record = await opportunityRecord(db, p[1]);
    if (!record) throw new HttpError(404, "That research dossier doesn't exist.");
    const dossier = record.dossier;
    const ref = { source: record.source, recordId: dossier.id, companyName: dossier.name };
    if (at("PUT", "opportunities", RECORD, "industry")) {
      await setOpportunityIndustry(db, actor, { ...ref, industry: (await body(req, IndustryBody)).industry });
    } else if (at("POST", "opportunities", RECORD, "checks")) {
      await addOpportunityCheck(db, actor, { ...ref, ...(await body(req, CheckBody)) });
    } else if (at("POST", "opportunities", RECORD, "calls")) {
      const input = await body(req, CallBody);
      // Findings are named by key; their wording comes from the saved research, never from the window.
      const predicted = new Map(evidenceItems(dossier).filter((e) => e.predictedPain).map((e) => [e.key, e.statement]));
      if (!input.findings.every((f) => predicted.has(f.key))) throw new HttpError(400, "That finding isn't one of this company's predicted problems.");
      await recordDiscoveryCall(db, actor, { ...ref, ...input, findings: input.findings.map((f) => ({ ...f, statement: predicted.get(f.key)! })) });
    } else if (at("POST", "opportunities", RECORD, "figures")) {
      await recordCustomerFigure(db, actor, { ...ref, ...(await body(req, FigureBody)) });
    } else if (at("PUT", "opportunities", RECORD, "figures", /^[0-9a-f-]{36}$/, "validation")) {
      await validateCustomerFigure(db, actor, { source: ref.source, recordId: ref.recordId, figureId: p[3], ...(await body(req, ValidationBody)) });
    } else if (at("PUT", "opportunities", RECORD, "problems", /^[0-9a-f-]{36}$/, "solution")) {
      const input = await body(req, SolutionBody);
      await setProblemSolution(db, actor, { source: ref.source, recordId: ref.recordId, problemId: p[3], rung: input.rung, solution: input.solution });
    } else {
      throw new HttpError(404, "Not found.");
    }
    return (await opportunity(db, actor, dossier.id))!.workflow;
  }
  if (at("PUT", "companies", /^[0-9a-f-]{36}$/, "class")) return setCompanyDataClass(db, actor, { orgId: p[1], dataClass: (await body(req, ClassBody)).dataClass });
  if (at("GET", "orders")) return orders(db, actor);
  if (at("GET", "orders", /^[0-9a-f-]{36}$/)) return order(db, actor, p[1]);
  if (at("GET", "companies")) return companies(db, actor);
  if (at("GET", "decisions")) return founderQueue(db, actor);
  if (at("GET", "ai")) return aiOperations(db, actor);
  if (p[0] === "ai") {
    const answer = await aiRoute(db, actor, method, p, (schema) => body(req, schema));
    if (answer !== undefined) return answer;
  }
  if (p[0] === "eng") {
    const answer = await engineeringRoute(db, actor, method, p, (schema) => body(req, schema));
    if (answer !== undefined) return answer;
  }
  if (p[0] === "cust") {
    const answer = await customersRoute(db, actor, method, p, (schema) => body(req, schema));
    if (answer !== undefined) return answer;
  }
  throw new HttpError(404, "Not found.");
}

/**
 * True when the request carries the secret the desktop app gave this backend when it started it. A backend started
 * by hand has no such secret, so nothing can shut it down this way.
 */
function supervisorRequest(headers: Headers, env: { KELQOR_BACKEND_TOKEN?: string }): boolean {
  const expected = Buffer.from(env.KELQOR_BACKEND_TOKEN ?? "");
  const given = Buffer.from(headers.get("x-kelqor-backend-token") ?? "");
  return expected.length >= 32 && given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleDesktopRequest(
  getDb: () => Promise<DB>,
  req: DesktopRequest,
  env: { NODE_ENV?: string; KELQOR_BACKEND_TOKEN?: string } = process.env,
): Promise<DesktopResponse> {
  if (desktopApiBlocked(env, req.headers.get("host"))) return { status: 404, body: { error: "Not found." } };
  // The desktop app closes the database cleanly before it stops a backend it started.
  if (req.method.toUpperCase() === "POST" && req.path.length === 1 && req.path[0] === "shutdown") {
    if (!supervisorRequest(req.headers, env)) return { status: 404, body: { error: "Not found." } };
    return { status: 200, body: { data: { databaseClosed: await closeDb() } } };
  }
  try {
    return { status: 200, body: { data: await route(await getDb(), req) } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    if (e instanceof DomainError) return { status: STATUS_BY_CODE[e.code], body: { error: e.message } };
    if (e instanceof z.ZodError) return { status: 400, body: { error: "The request is missing required fields." } };
    if (e instanceof MigrationNeedsBackup) return { status: 503, body: { error: e.message } };
    console.error("[desktop api]", e);
    return { status: 500, body: { error: "Something went wrong on the local backend." } };
  }
}
