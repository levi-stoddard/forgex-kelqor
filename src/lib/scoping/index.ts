import type { Intake, Scope, ScopeSource } from "../domain/types";
import { aiScope, aiScopingConfigured } from "./ai";
import { templateScope } from "./heuristic";

export interface DraftScope {
  title: string;
  category: string;
  scope: Scope;
  source: ScopeSource;
  model: string | null;
  costMicros: number;
  /** Set when AI scoping was attempted and failed, so the operator knows why the template was used. */
  aiError?: string;
}

/** The catalog template, or an AI draft once AI scoping is authorized (never by a caller's say-so alone). */
export async function draftScope(intake: Intake, opts: { operatorNotes?: string; useAi?: boolean } = {}): Promise<DraftScope> {
  const useAi = (opts.useAi ?? true) && aiScopingConfigured();
  if (useAi) {
    try {
      const r = await aiScope(intake, opts.operatorNotes);
      return { ...r, source: "ai" };
    } catch (err) {
      const t = templateScope(intake);
      const aiError = err instanceof Error ? err.message : String(err);
      console.error("[scoping] AI scoping failed, using template:", aiError);
      return { ...t, source: "template", model: null, costMicros: 0, aiError };
    }
  }
  const t = templateScope(intake);
  return { ...t, source: "template", model: null, costMicros: 0 };
}

export { OUTCOMES, getOutcome } from "./catalog";
