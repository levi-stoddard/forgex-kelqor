import type { Intake, Scope } from "../domain/types";
import { CUSTOM_OUTCOME, getOutcome, OUTCOMES, type OutcomeTemplate } from "./catalog";

/** Pick the catalog outcome whose keywords best match the request (or the one the client chose). */
export function classifyIntake(intake: Intake): OutcomeTemplate {
  const chosen = getOutcome(intake.templateSlug);
  if (chosen && chosen.slug !== "custom") return chosen;
  const text = ` ${[intake.problem, intake.desiredOutcome, intake.currentTools].join(" ").toLowerCase()} `;
  let best: OutcomeTemplate = CUSTOM_OUTCOME;
  let bestScore = 0;
  for (const outcome of OUTCOMES) {
    const score = outcome.keywords.reduce((n, k) => (text.includes(k) ? n + (k.includes(" ") ? 2 : 1) : n), 0);
    if (score > bestScore) {
      best = outcome;
      bestScore = score;
    }
  }
  return best;
}

function firstSentence(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Deterministic scope from the catalog template, personalised with the client's own details. */
export function templateScope(intake: Intake): { title: string; category: string; scope: Scope } {
  const outcome = classifyIntake(intake);
  const t = outcome.scope;
  const assumptions = [...t.assumptions];
  if (intake.currentTools.trim()) assumptions.push(`Works with your current tools: ${intake.currentTools.trim()}.`);
  if (intake.volume.trim()) assumptions.push(`Expected volume: ${intake.volume.trim()}.`);
  if (intake.deadline.trim()) assumptions.push(`Target timeline: ${intake.deadline.trim()}.`);

  const questions: string[] = [];
  if (!intake.currentTools.trim()) questions.push("Which systems does this touch (CRM, accounting, helpdesk, email, spreadsheets)?");
  if (!intake.volume.trim()) questions.push("Roughly how many items does this involve per week?");
  if (!intake.desiredOutcome.trim()) questions.push("What would success look like in numbers (time saved, response time, error rate)?");
  if (outcome.slug === "custom") questions.push("Can you walk us through the steps a person takes today, start to finish?");

  const goal = intake.desiredOutcome.trim() || intake.problem.trim();
  const title = outcome.slug === "custom" ? firstSentence(intake.problem, 70) || outcome.title : outcome.title;

  return {
    title,
    category: outcome.slug,
    scope: {
      summary: `${outcome.title}: ${firstSentence(goal)}`,
      objectives: t.objectives,
      inScope: t.inScope,
      outOfScope: t.outOfScope,
      deliverables: t.deliverables,
      acceptanceCriteria: t.acceptanceCriteria,
      milestones: t.milestones,
      assumptions,
      clientResponsibilities: t.clientResponsibilities,
      risks: t.risks,
      estimateHoursLow: outcome.hoursLow,
      estimateHoursHigh: outcome.hoursHigh,
      complexity: outcome.complexity,
      recommendedSkills: outcome.skills,
      clarifyingQuestions: questions,
    },
  };
}
