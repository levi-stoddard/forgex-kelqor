import { and, eq, inArray } from "drizzle-orm";
import type { ModelRequest, ToolResult, Turn } from "../ai/types";
import { activeApproval, approvalsFor, markOpenReservationsUnverified, meteredRequest, missionSpend } from "../controls";
import type { DB } from "../db";
import { missions } from "../db/schema";
import { addServed, looksLikeCredential, type ServedPages } from "../research/agent";
import { approvedSourceFor, SiteFetcher, type FetchRecord, type PageResult, type ReadScope, type Transport } from "../research/fetcher";
import { sameSite } from "../research/html";
import { approvedSourcesFor } from "../sources/registry";
import { companyBrief, CompanyReportSchema, companyReportJsonSchema, companySystemPrompt } from "./company";
import { ProviderFailure, SpendRefused, stateForRefusal, UnsafeReply, type MissionProvider, type MissionScope, type MissionStatus, type RequestPurpose, type ReviewChoice } from "./contract";
import { checkCompanyReport, checkIndustryReport, type MissionChecks } from "./evidence";
import { industryBrief, IndustryReportSchema, industryReportJsonSchema, industrySystemPrompt } from "./industry";
import { formatPage, MAX_MISSION_PAGES, MAX_MISSION_TURNS, MISSION_READ_PAGE_TOOL, type ApprovedSourceBrief } from "./protocol";
import { defaultProviders, type ProviderSet } from "./providers";
import { saveResults, reviewedIntelligence } from "./results";
import { runReview, type ReviewOutcome } from "./review";
import { logStep } from "./steps";

// The mission runner, inside the backend. It runs one mission step by step on demand, never by itself, and saves
// after every step. Every model request goes through the controls' metered pathway (reserve, send, settle); page
// reads go through KELQOR's page reader within the mission's scope. When the backend starts, missions left running
// become Interrupted and nothing is resent. Only the run that moved a mission to Running may write to it.

export type MissionRow = typeof missions.$inferSelect;

/** One page this mission was served, with its text, kept until the mission ends. */
interface ServedEntry {
  requested: string;
  page: PageResult;
  sourceKey: string | null;
}

export interface WorkingState {
  v: 1;
  phase: "research" | "verification";
  scope: { siteRoot: string | null; approved: ApprovedSourceBrief[] };
  turns: Turn[];
  turn: number;
  pages: number;
  repairsLeft: number;
  cutoffRetriesLeft: number;
  /** "repair" while the next request asks for a corrected report. */
  pending: "research" | "repair";
  attempt: number;
  consecutiveErrors: number;
  rateLimits: number;
  served: ServedEntry[];
  pagesRequested: { url: string; outcome: string }[];
  report: Record<string, unknown> | null;
}

export function scopeOf(row: MissionRow): MissionScope {
  return {
    type: row.type,
    subject: row.subject,
    protocol: row.protocol,
    provider: row.provider,
    model: row.model,
    thinkingLevel: row.thinkingLevel,
    maxOutputTokens: row.maxOutputTokens,
    maxCostMicros: row.maxCostMicros,
    review: row.review ?? null,
    simulated: row.simulated,
  };
}

const SENDING: MissionStatus[] = ["running", "verification"];

/** Page records as stored after a mission: address, outcome, retrieval time and fingerprints, never text. */
export function sourceRecords(served: ServedEntry[]): (FetchRecord & { sourceKey: string | null })[] {
  const seen = new Map<string, FetchRecord & { sourceKey: string | null }>();
  for (const s of served) seen.set(`${s.page.record.finalUrl}|${s.page.record.outcome}`, { ...s.page.record, sourceKey: s.sourceKey });
  return [...seen.values()];
}

function servedMap(served: ServedEntry[]): ServedPages {
  const map: ServedPages = new Map();
  for (const s of served) addServed(map, s.requested, s.page);
  return map;
}

export interface RunnerDeps {
  db: DB;
  providers: ProviderSet;
  transport?: Transport;
  now?: () => Date;
  /** Politeness delay between pages on one host; tests set 0. */
  minIntervalMs?: number;
}

type Outcome = { status: MissionStatus; reason: string | null };

/** Ends this run. A null outcome means the run no longer owns the mission and stops without writing. */
class Stop extends Error {
  constructor(readonly outcome: Outcome | null) {
    super(outcome ? (outcome.reason ?? outcome.status) : "This run no longer owns the mission.");
  }
}

export class MissionRun {
  private readonly db: DB;
  private readonly now: () => Date;
  private readonly fetcher: SiteFetcher;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly missionId: string,
    private readonly runId: string,
    private readonly signal: AbortSignal,
  ) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.fetcher = new SiteFetcher({ transport: deps.transport, minIntervalMs: deps.minIntervalMs, now: this.now });
  }

  private async row(): Promise<MissionRow | null> {
    const [row] = await this.db.select().from(missions).where(eq(missions.id, this.missionId)).limit(1);
    return row ?? null;
  }

  /** Writes only while this run still owns the mission and it is still running. */
  private async write(patch: Partial<typeof missions.$inferInsert>): Promise<boolean> {
    const done = await this.db
      .update(missions)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(missions.id, this.missionId), eq(missions.runId, this.runId), inArray(missions.status, SENDING)))
      .returning({ id: missions.id });
    return done.length === 1;
  }

  private async save(state: WorkingState) {
    if (!(await this.write({ workingState: state as unknown as Record<string, unknown> }))) throw new Stop(null);
  }

  async run(): Promise<void> {
    const row = await this.row();
    if (!row || row.runId !== this.runId || !SENDING.includes(row.status)) return;
    try {
      const scope = scopeOf(row);
      if ((row.workingState as { resumeReview?: boolean } | null)?.resumeReview) {
        await this.reviewOnly(row, scope);
        return;
      }
      const provider = this.deps.providers.research(scope);
      const state = (row.workingState as WorkingState | null) ?? (await this.initialState(row));
      if (state.phase === "research") await this.research(row, scope, provider, state);
      await this.verify(row, scope, state);
    } catch (e) {
      if (e instanceof Stop) {
        if (e.outcome) await this.end(e.outcome);
        else await this.lostPlace();
        return;
      }
      if (e instanceof SpendRefused && stateForRefusal(e.reason, "review") === "none") {
        await this.lostPlace();
        return;
      }
      console.error("[mission runner]", e);
      await this.end({ status: "interrupted", reason: `The run stopped on an unexpected error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) });
    }
  }

  /**
   * A refusal that says this run may not send (the mission isn't in a sending state, or another run owns it) ends the
   * run without writing, unless this run still owns a sending mission: then nothing more is sent and the mission becomes
   * Interrupted, so it never sits in Running with nothing running.
   */
  private async lostPlace() {
    const row = await this.row();
    if (row && row.runId === this.runId && SENDING.includes(row.status)) {
      await this.end({ status: "interrupted", reason: "The run stopped before its next request because the mission wasn't in a state that may send it. Nothing more was sent; resume it to continue." });
    }
  }

  private async initialState(row: MissionRow): Promise<WorkingState> {
    const subject = row.subject;
    const industry = subject.kind === "company" ? subject.industry : subject.industry;
    const approved = await approvedSourcesFor(this.db, industry);
    const state: WorkingState = {
      v: 1,
      phase: "research",
      scope: { siteRoot: subject.kind === "company" ? subject.website : null, approved },
      turns: [],
      turn: 0,
      pages: 0,
      repairsLeft: 1,
      cutoffRetriesLeft: 1,
      pending: "research",
      attempt: 1,
      consecutiveErrors: 0,
      rateLimits: 0,
      served: [],
      pagesRequested: [],
      report: null,
    };
    if (subject.kind === "company") {
      const homepage = await this.read(state, subject.website);
      if (homepage.record.outcome !== "ok") {
        throw new Stop({ status: "failed", reason: `The company's homepage couldn't be read (${homepage.record.outcome}: ${homepage.record.detail}), so no AI request was sent.` });
      }
      const intelligence = await reviewedIntelligence(this.db, subject.industry);
      const brief = companyBrief(
        { name: subject.name, website: subject.website, town: subject.town, state: subject.state, industry: subject.industry, sources: approved, intelligence },
        homepage,
      );
      state.turns.push({ kind: "user", text: brief });
    } else {
      state.turns.push({ kind: "user", text: industryBrief({ industry: subject.industry, category: subject.category, region: subject.region, sources: approved }) });
    }
    await this.save(state);
    return state;
  }

  private readScope(state: WorkingState): ReadScope {
    return { siteRoot: state.scope.siteRoot, approved: state.scope.approved.map((s) => ({ key: s.key, match: s.match })) };
  }

  private async read(state: WorkingState, url: string): Promise<PageResult> {
    const scope = this.readScope(state);
    const page = await this.fetcher.fetchPage(url, scope);
    const onSite = Boolean(scope.siteRoot && sameSite(page.record.finalUrl, scope.siteRoot));
    const sourceKey = onSite ? null : (approvedSourceFor(page.record.finalUrl, scope)?.key ?? null);
    state.served.push({ requested: url, page, sourceKey });
    state.pages++;
    state.pagesRequested.push({ url, outcome: page.record.outcome });
    await logStep(this.db, this.missionId, "page_read", `${page.record.outcome === "ok" ? "Read" : "Couldn't read"} ${page.record.finalUrl}`, {
      url,
      finalUrl: page.record.finalUrl,
      outcome: page.record.outcome,
      status: page.record.status,
      detail: page.record.detail,
      retrievedAt: page.record.retrievedAt,
      sha256: page.record.sha256,
      textSha256: page.record.textSha256,
      sourceKey,
    });
    return page;
  }

  private request(scope: MissionScope, state: WorkingState): ModelRequest {
    const company = scope.type === "company_research";
    const forceAnswer = state.pages >= MAX_MISSION_PAGES || state.turn >= MAX_MISSION_TURNS - 2;
    return {
      system: company ? companySystemPrompt() : industrySystemPrompt(),
      turns: state.turns,
      tools: [MISSION_READ_PAGE_TOOL],
      toolChoice: forceAnswer ? "none" : "auto",
      outputSchema: company ? companyReportJsonSchema() : industryReportJsonSchema(),
      maxOutputTokens: scope.maxOutputTokens,
    };
  }

  private async research(row: MissionRow, scope: MissionScope, provider: MissionProvider, state: WorkingState) {
    while (state.phase === "research") {
      if (this.signal.aborted) throw new Stop({ status: "cancelled", reason: "You cancelled the mission." });
      if (state.turn >= MAX_MISSION_TURNS) throw new Stop({ status: "failed", reason: `The turn limit of ${MAX_MISSION_TURNS} was reached without a report.` });
      const purpose: RequestPurpose = state.attempt > 1 ? "retry" : state.pending;
      const stepId = await logStep(this.db, this.missionId, "model_request", `Model request ${state.turn + 1} (${purpose}${state.attempt > 1 ? `, attempt ${state.attempt}` : ""})`, {
        purpose,
        attempt: state.attempt,
        provider: provider.provider,
        model: provider.model,
      });
      let metered;
      try {
        metered = await meteredRequest(
          this.db,
          { missionId: this.missionId, runId: this.runId, stepId, attempt: state.attempt, purpose, now: this.deps.now },
          provider,
          this.request(scope, state),
          this.signal,
        );
      } catch (e) {
        await this.failedRequest(e, state);
        continue;
      }
      await logStep(this.db, this.missionId, "note", `Request settled: ${metered.reply.status}`, {
        stepId,
        ledgerId: metered.ledgerId,
        countedInputTokens: metered.countedInputTokens,
        reservedInputTokens: metered.reservedInputTokens,
        reservedMicros: metered.reservedMicros,
        actualMicros: metered.actualMicros,
        usage: metered.reply.usage,
      });
      const reply = metered.reply;
      state.consecutiveErrors = 0;
      if (looksLikeCredential(reply.text) || reply.toolCalls.some((c) => looksLikeCredential(JSON.stringify(c.args)))) {
        throw new Stop({ status: "failed", reason: "A response contained something that looks like a credential, so the mission stopped." });
      }
      if (reply.status === "incomplete") {
        // Cut off at the output limit: the same request once more, within the budget, then review.
        if (state.cutoffRetriesLeft > 0) {
          state.cutoffRetriesLeft--;
          state.attempt = 2;
          await this.save(state);
          continue;
        }
        throw new Stop({ status: "needs_review", reason: `The response was cut off at the ${scope.maxOutputTokens.toLocaleString("en-US")}-token output limit twice, so no report was produced.` });
      }
      if (reply.status === "failed") {
        await this.countError(state, `The provider answered without a result: ${reply.detail ?? "no detail"}.`);
        continue;
      }
      state.attempt = 1;
      state.turn++;
      state.turns.push({ kind: "model", steps: reply.modelSteps });
      if (reply.status === "tool_calls") {
        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) {
          if (call.name !== MISSION_READ_PAGE_TOOL.name) throw new Stop({ status: "failed", reason: `The model asked for a tool that isn't allowed: ${call.name}.` });
          const url = typeof call.args.url === "string" ? call.args.url : "";
          if (state.pages >= MAX_MISSION_PAGES) {
            results.push({ callId: call.id, name: call.name, output: `The ${MAX_MISSION_PAGES}-page limit is reached. Write the report now.`, isError: true });
            continue;
          }
          const page = await this.read(state, url);
          results.push({ callId: call.id, name: call.name, output: formatPage(page), isError: page.record.outcome !== "ok" });
        }
        state.turns.push({ kind: "tool_results", results });
        state.pending = "research";
        await this.save(state);
        continue;
      }
      const schema = scope.type === "company_research" ? CompanyReportSchema : IndustryReportSchema;
      let json: unknown = null;
      try {
        json = JSON.parse(reply.text);
      } catch {
        json = null;
      }
      const parsed = schema.safeParse(json);
      if (parsed.success) {
        state.report = parsed.data as Record<string, unknown>;
        state.phase = "verification";
        await this.save(state);
        return;
      }
      const errors = json === null ? ["The answer was not valid JSON."] : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      if (state.repairsLeft > 0) {
        state.repairsLeft--;
        state.pending = "repair";
        state.turns.push({ kind: "user", text: `The report didn't match the required format: ${errors.slice(0, 8).join("; ")}. Return the corrected JSON only.` });
        await this.save(state);
        continue;
      }
      throw new Stop({ status: "failed", reason: `The report didn't match its format after one repair: ${errors.slice(0, 3).join("; ")}` });
    }
  }

  private async countError(state: WorkingState, why: string) {
    state.consecutiveErrors++;
    state.attempt++;
    await logStep(this.db, this.missionId, "error", why);
    if (state.consecutiveErrors >= 3) throw new Stop({ status: "failed", reason: `Three errors in a row. The last: ${why}` });
    if (state.attempt > 3) throw new Stop({ status: "failed", reason: `A step failed after two retries. The last error: ${why}` });
    await this.save(state);
  }

  private async failedRequest(e: unknown, state: WorkingState) {
    if (e instanceof UnsafeReply) {
      await logStep(this.db, this.missionId, "error", e.message, { ledgerId: e.ledgerId });
      throw new Stop({ status: "failed", reason: e.message });
    }
    if (e instanceof SpendRefused) {
      const next = stateForRefusal(e.reason, state.attempt > 1 ? "retry" : state.pending);
      if (next === "none") throw new Stop(null);
      await logStep(this.db, this.missionId, "error", `Not sent: ${e.message}`, { refusal: e.reason });
      if (next === "retry") return this.countError(state, e.message);
      await this.save(state);
      throw new Stop({ status: next, reason: e.message });
    }
    if (e instanceof ProviderFailure) {
      const f = e.failure;
      await logStep(this.db, this.missionId, "error", `Request failed (${f.kind}, ${e.outcome === "unverified" ? "counted as unverified" : "not billed"}): ${f.message}`, {
        ledgerId: e.ledgerId,
        outcome: e.outcome,
        kind: f.kind,
        status: f.status ?? null,
      });
      if (this.signal.aborted || f.kind === "cancelled") throw new Stop({ status: "cancelled", reason: "You cancelled the mission. The request in flight is counted as unverified unless its response arrived." });
      if (f.kind === "auth" || f.kind === "invalid_request" || f.kind === "not_found") throw new Stop({ status: "failed", reason: `The provider refused the request (${f.kind}): ${f.message}` });
      if (f.kind === "rate_limit") {
        state.rateLimits++;
        if (state.rateLimits >= 3) {
          await this.save(state);
          throw new Stop({ status: "interrupted", reason: "Repeated rate limits stopped the mission. Resume it later." });
        }
      }
      return this.countError(state, f.message);
    }
    throw e;
  }

  private async verify(row: MissionRow, scope: MissionScope, state: WorkingState) {
    if (!(await this.write({ status: "verification" }))) throw new Stop(null);
    const served = servedMap(state.served);
    const ctx = { scope: this.readScope(state), companySite: state.scope.siteRoot, now: this.now() };
    const checks: MissionChecks =
      scope.type === "company_research"
        ? checkCompanyReport(CompanyReportSchema.parse(state.report), served, ctx)
        : checkIndustryReport(IndustryReportSchema.parse(state.report), served, ctx);
    await logStep(this.db, this.missionId, "check", `Checks: ${checks.summary.quoted - checks.summary.quotedFailed} of ${checks.summary.quoted} quoted claims verified, ${checks.flags.length} flags`, {
      summary: checks.summary,
      needsReview: checks.needsReview,
    });
    let review: ReviewOutcome | null = null;
    const reviewChoice = await this.reviewChoice(scope);
    // A review approved for this mission whose approval lapsed before it ran must not pass as "no review".
    const lapsedReview = !reviewChoice && (await approvalsFor(this.db, this.missionId)).some((a) => a.kind === "review" && a.state === "expired");
    if (reviewChoice) {
      review = await runReview({
        db: this.db,
        missionId: this.missionId,
        runId: this.runId,
        scope: { ...scope, review: reviewChoice },
        report: state.report!,
        checks,
        served: state.served.map((s) => s.page),
        readScope: this.readScope(state),
        fetcher: new SiteFetcher({ transport: this.deps.transport, minIntervalMs: this.deps.minIntervalMs, now: this.now }),
        reviewer: this.deps.providers.reviewer(reviewChoice),
        signal: this.signal,
        now: this.deps.now,
      });
    }
    await this.conclude(
      {
        report: state.report!,
        checks,
        review,
        sources: sourceRecords(state.served),
        pagesRequested: state.pagesRequested,
        approvedSources: state.scope.approved,
      },
      lapsedReview,
    );
  }

  /** The review chosen with the mission, or one added later under its own approval. */
  private async reviewChoice(scope: MissionScope): Promise<ReviewChoice | null> {
    return scope.review ?? (await activeApproval(this.db, this.missionId, "review"))?.review ?? null;
  }

  /** Review added to a mission in Needs review: the cited pages are read again and the report reviewed alone. */
  private async reviewOnly(row: MissionRow, scope: MissionScope) {
    const result = row.result as { report: Record<string, unknown>; checks: MissionChecks; sources: (FetchRecord & { sourceKey: string | null })[]; pagesRequested: { url: string; outcome: string }[]; approvedSources: ApprovedSourceBrief[] } | null;
    const reviewChoice = await this.reviewChoice(scope);
    if (!result || !reviewChoice) throw new Stop({ status: "needs_review", reason: "There is no report or approved review to run." });
    // Review is paid only in Verification, whichever state the run was resumed from.
    if (!(await this.write({ status: "verification" }))) throw new Stop(null);
    const readScope: ReadScope = {
      siteRoot: row.subject.kind === "company" ? row.subject.website : null,
      approved: (result.approvedSources ?? []).map((s) => ({ key: s.key, match: s.match })),
    };
    const review = await runReview({
      db: this.db,
      missionId: this.missionId,
      runId: this.runId,
      scope: { ...scope, review: reviewChoice },
      report: result.report,
      checks: result.checks,
      served: result.sources.map((record) => ({ record, inventory: null })),
      readScope,
      fetcher: new SiteFetcher({ transport: this.deps.transport, minIntervalMs: this.deps.minIntervalMs, now: this.now }),
      reviewer: this.deps.providers.reviewer(reviewChoice),
      signal: this.signal,
      now: this.deps.now,
    });
    await this.conclude({ ...result, review });
  }

  /** Completed only when every condition holds; otherwise Needs review, with the research kept. */
  private async conclude(result: {
    report: Record<string, unknown>;
    checks: MissionChecks;
    review: ReviewOutcome | null;
    sources: (FetchRecord & { sourceKey: string | null })[];
    pagesRequested: { url: string; outcome: string }[];
    approvedSources: ApprovedSourceBrief[];
  }, lapsedReview = false): Promise<never> {
    const { checks, review } = result;
    const reasons = [...checks.needsReview];
    if (lapsedReview) reasons.push("The Claude review approved for this mission lapsed before it ran. Approve it again, then resume the review.");
    if (review && !review.finished) reasons.push(`Claude review didn't finish: ${review.reason}`);
    if (review?.finished && review.unsupportedFacts > 0) reasons.push(`Claude review found ${review.unsupportedFacts} verified ${review.unsupportedFacts === 1 ? "fact" : "facts"} unsupported.`);
    const spend = await missionSpend(this.db, this.missionId);
    if (spend.reservedMicros > 0) reasons.push("A request in the ledger is still reserved, not settled.");
    const status: MissionStatus = reasons.length ? "needs_review" : "completed";
    if (!(await this.write({ result: { ...result, reviewReasons: reasons } as unknown as Record<string, unknown> }))) throw new Stop(null);
    // The final state first: a cancel landing now wins, and no research version is saved for a cancelled mission.
    const ended = await this.end({ status, reason: reasons.length ? reasons.join(" ") : null });
    if (ended && status === "completed") await saveResults(this.db, this.missionId, { withIssues: false });
    throw new Stop(null);
  }

  /** The mission's final state for this run, true when this run wrote it. The working state stays only for a resume. */
  private async end(outcome: Outcome): Promise<boolean> {
    const resumable = outcome.status === "interrupted" || outcome.status === "budget_blocked";
    const patch: Partial<typeof missions.$inferInsert> = { status: outcome.status, stateReason: outcome.reason, updatedAt: this.now() };
    if (!resumable) {
      patch.workingState = null;
      patch.finishedAt = this.now();
    }
    const done = await this.db
      .update(missions)
      .set(patch)
      .where(and(eq(missions.id, this.missionId), eq(missions.runId, this.runId), inArray(missions.status, SENDING)))
      .returning({ id: missions.id });
    if (done.length === 0) {
      // Someone else ended it (a cancel); its page text still goes once nothing can resume it.
      const [row] = await this.db.select({ status: missions.status }).from(missions).where(eq(missions.id, this.missionId)).limit(1);
      if (row && !["interrupted", "budget_blocked"].includes(row.status)) await this.db.update(missions).set({ workingState: null }).where(eq(missions.id, this.missionId));
      return false;
    }
    await logStep(this.db, this.missionId, "state", `${outcome.status.replace(/_/g, " ")}${outcome.reason ? `: ${outcome.reason}` : ""}`, { status: outcome.status });
    return true;
  }
}

/** One executor per backend process. Nothing starts by itself: only start() runs a mission. */
export class MissionExecutor {
  private readonly runs = new Map<string, { runId: string; controller: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: () => Promise<RunnerDeps>) {}

  start(missionId: string, runId: string): void {
    if (this.runs.has(missionId)) return;
    const controller = new AbortController();
    const done = (async () => {
      let deps: RunnerDeps | null = null;
      try {
        deps = await this.deps();
        await new MissionRun(deps, missionId, runId, controller.signal).run();
      } catch (e) {
        // Nothing may escape a background run: a refused test mode or a closed database interrupts the mission.
        console.error("[mission runner]", e);
        const reason = `The run couldn't continue: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
        await deps?.db
          .update(missions)
          .set({ status: "interrupted", stateReason: reason, updatedAt: new Date() })
          .where(and(eq(missions.id, missionId), eq(missions.runId, runId), inArray(missions.status, SENDING)))
          .catch(() => {});
      } finally {
        this.runs.delete(missionId);
      }
    })();
    this.runs.set(missionId, { runId, controller, done });
  }

  /** Stops the run in this process, if there is one: nothing more is sent, and a request in flight is abandoned. */
  cancel(missionId: string): boolean {
    const run = this.runs.get(missionId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  isRunning(missionId: string): boolean {
    return this.runs.has(missionId);
  }

  /** Resolves when the mission's run in this process has finished. */
  async idle(missionId: string): Promise<void> {
    await this.runs.get(missionId)?.done;
  }

  runningCount(): number {
    return this.runs.size;
  }
}

declare global {
  var __kelqorExecutor: MissionExecutor | undefined;
}

/** The backend's executor, using the real providers (or test mode's, against an isolated database only). */
export function missionExecutor(): MissionExecutor {
  if (!globalThis.__kelqorExecutor) {
    globalThis.__kelqorExecutor = new MissionExecutor(async () => {
      const { getDb } = await import("../db");
      const db = await getDb();
      let set: ProviderSet;
      try {
        set = defaultProviders(db);
      } catch (e) {
        // A refused test mode reaches the mission as its reason for stopping, instead of escaping the run.
        const why = e instanceof Error ? e.message : String(e);
        set = {
          research: () => {
            throw new Error(why);
          },
          reviewer: () => null,
        };
      }
      return { db, providers: set, transport: set.transport };
    });
  }
  return globalThis.__kelqorExecutor;
}

/** At backend start: missions left running become Interrupted, and reservations left open become unverified. */
export async function recoverAtStartup(db: DB, now?: () => Date): Promise<{ interrupted: number; unverified: number }> {
  const reason = "The backend stopped while the mission was running. Nothing was resent; resume it when you're ready.";
  const stopped = await db
    .update(missions)
    .set({ status: "interrupted", stateReason: reason, updatedAt: now ? now() : new Date() })
    .where(inArray(missions.status, SENDING))
    .returning({ id: missions.id });
  for (const m of stopped) await logStep(db, m.id, "state", `interrupted: ${reason}`, { status: "interrupted", recovery: true });
  const unverified = await markOpenReservationsUnverified(db, "The backend stopped while this request was in flight.", now?.());
  return { interrupted: stopped.length, unverified };
}
