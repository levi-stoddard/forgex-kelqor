import fs from "node:fs";
import path from "node:path";
import { costUsd, worstCaseUsd } from "../ai/pricing";
import type { TokenUsage } from "../ai/types";

// Spending control for a benchmark stage. The owner authorizes each stage's cap; this guard refuses any request
// whose worst case could cross the stage or company cap, records every request's actual cost in an append-only
// ledger, and stops the run on repeated errors. Google's own limits are only a backstop: billing there lags.

export class BudgetStop extends Error {
  constructor(
    message: string,
    readonly scope: "run" | "company",
  ) {
    super(message);
  }
}

export interface LedgerEntry {
  at: string;
  stage: string;
  company: string;
  model: string;
  interactionId?: string;
  usage: TokenUsage;
  costUsd: number;
  stageTotalUsd: number;
}

export interface GuardOptions {
  stage: string;
  capUsd: number;
  /** Per-company cap by model, in USD. */
  companyCapUsd: Record<string, number>;
  /** What a company is expected to cost by model; two companies above 3x this stop the run. */
  expectedCompanyUsd: Record<string, number>;
  ledgerPath?: string;
  now?: () => Date;
}

export class BudgetGuard {
  private spent = 0;
  private company = { id: "", model: "", spent: 0 };
  private overruns = 0;
  private consecutiveErrors = 0;
  private rateLimited = 0;

  constructor(private readonly o: GuardOptions) {
    if (o.ledgerPath && fs.existsSync(o.ledgerPath)) {
      for (const line of fs.readFileSync(o.ledgerPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry.stage === o.stage) this.spent += entry.costUsd;
      }
    }
  }

  get stageSpentUsd(): number {
    return this.spent;
  }

  get companySpentUsd(): number {
    return this.company.spent;
  }

  startCompany(id: string, model: string) {
    if (this.company.id) this.finishCompany();
    if (!(model in this.o.companyCapUsd)) throw new BudgetStop(`No company cap is set for ${model}.`, "run");
    this.company = { id, model, spent: 0 };
  }

  finishCompany() {
    const expected = this.o.expectedCompanyUsd[this.company.model];
    if (this.company.id && expected !== undefined && this.company.spent > 3 * expected) this.overruns++;
    this.company = { id: "", model: "", spent: 0 };
    if (this.overruns >= 2) throw new BudgetStop("Two companies cost more than three times the estimate.", "run");
  }

  /** Throws unless the request's worst case fits both caps. Returns that worst case in USD. */
  reserve(model: string, inputTokens: number, maxOutputTokens: number): number {
    const worst = worstCaseUsd(model, inputTokens, maxOutputTokens, this.now());
    if (this.spent + worst > this.o.capUsd) {
      throw new BudgetStop(
        `Stage "${this.o.stage}" would exceed its $${this.o.capUsd.toFixed(2)} cap: $${this.spent.toFixed(4)} spent, next request up to $${worst.toFixed(4)}.`,
        "run",
      );
    }
    const cap = this.o.companyCapUsd[model];
    if (this.company.spent + worst > cap) {
      throw new BudgetStop(`This company would exceed its $${cap.toFixed(2)} cap on ${model}.`, "company");
    }
    return worst;
  }

  record(model: string, usage: TokenUsage, interactionId?: string): LedgerEntry {
    const cost = costUsd(model, usage, this.now());
    this.spent += cost;
    this.company.spent += cost;
    this.consecutiveErrors = 0;
    const entry: LedgerEntry = {
      at: this.now().toISOString(),
      stage: this.o.stage,
      company: this.company.id,
      model,
      interactionId,
      usage,
      costUsd: cost,
      stageTotalUsd: this.spent,
    };
    if (this.o.ledgerPath) {
      fs.mkdirSync(path.dirname(this.o.ledgerPath), { recursive: true });
      fs.appendFileSync(this.o.ledgerPath, `${JSON.stringify(entry)}\n`);
    }
    if (this.spent > this.o.capUsd) throw new BudgetStop(`Stage "${this.o.stage}" reached its cap.`, "run");
    return entry;
  }

  /** Counts API failures; three in a row, or three rate-limit refusals in the run, stop it. */
  noteError(status?: number) {
    this.consecutiveErrors++;
    if (status === 429) this.rateLimited++;
    if (this.consecutiveErrors >= 3) throw new BudgetStop("Three API errors in a row.", "run");
    if (this.rateLimited >= 3) throw new BudgetStop("Repeated rate-limit refusals.", "run");
  }

  private now() {
    return this.o.now ? this.o.now() : new Date();
  }
}
