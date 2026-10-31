import { anthropicKeyConfigured, claudeReviewProvider } from "../ai/claude";
import { geminiMissionProvider } from "../ai/gemini";
import { redeemTicket, syntheticProvider, testMode } from "../controls";
import type { DB } from "../db";
import type { Transport } from "../research/fetcher";
import { fixtureTransport } from "../research/fixtures";
import type { MissionProvider, MissionScope, ReviewChoice } from "./contract";
import { simulatedResearcher, simulatedReviewer } from "./simulated";

// Which model a mission talks to. Real providers are Gemini for research and Claude for review; "simulation" is the
// $0 stand-in. The synthetic-cost provider and local test pages exist only in test mode, which the controls refuse
// against the real database. Every provider redeems the controls' single-use ticket before it sends anything.

export const RESEARCH_MODELS = [
  { provider: "google", model: "gemini-4-argon", label: "Gemini 4 Argon", default: true },
  { provider: "google", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", default: false },
] as const;

export const REVIEW_MODELS = [
  { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { provider: "anthropic", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { provider: "anthropic", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
] as const;

export interface ProviderSet {
  research(scope: MissionScope): MissionProvider;
  /** Null when the reviewer is unavailable (no Anthropic key for a real review). */
  reviewer(choice: ReviewChoice): MissionProvider | null;
  /** Local test pages in test mode; the real page reader otherwise. */
  transport?: Transport;
}

export function geminiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export function defaultProviders(db: DB, env: NodeJS.ProcessEnv = process.env): ProviderSet {
  const mode = testMode(db, env);
  // A test run (an acceptance copy) never reaches a real provider, whatever mission it creates.
  const testing = mode.syntheticCosts || Boolean(mode.testPagesDir);
  return {
    research(scope) {
      if (scope.simulated || scope.provider === "simulation") return simulatedResearcher(scope.type, redeemTicket);
      if (testing && scope.provider !== "synthetic") throw new Error("Real AI providers are off in test mode: this database is an isolated test copy.");
      if (scope.provider === "synthetic") {
        if (!mode.syntheticCosts) throw new Error("The synthetic-cost provider runs only in test mode, against an isolated copy of the database.");
        return syntheticProvider({ inner: simulatedResearcher(scope.type, redeemTicket), model: scope.model });
      }
      if (scope.provider === "google") return geminiMissionProvider(scope.model, { thinkingLevel: scope.thinkingLevel, redeem: redeemTicket });
      throw new Error(`No research provider is available for ${scope.provider}.`);
    },
    reviewer(choice) {
      if (choice.provider === "simulation") return simulatedReviewer(redeemTicket);
      if (choice.provider === "synthetic") {
        if (!mode.syntheticCosts) throw new Error("The synthetic-cost reviewer runs only in test mode, against an isolated copy of the database.");
        return syntheticProvider({ inner: simulatedReviewer(redeemTicket), model: choice.model });
      }
      if (testing || !anthropicKeyConfigured(env)) return null;
      return claudeReviewProvider(choice.model, { redeem: redeemTicket });
    },
    transport: mode.testPagesDir ? fixtureTransport(mode.testPagesDir) : undefined,
  };
}
