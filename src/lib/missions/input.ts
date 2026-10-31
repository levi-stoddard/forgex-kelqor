import { z } from "zod";
import { MISSION_CAP_MICROS, MISSION_TYPES, THINKING_LEVELS } from "./contract";

// A mission as the window submits it. Shared by the backend's mission service and the desktop main process, which
// checks requests before they leave; it has no database or provider imports, so the desktop bundle can include it.

const text = (max: number) => z.string().trim().max(max);

const CompanySubject = z.object({
  kind: z.literal("company"),
  recordId: z
    .string()
    .regex(/^(c\d{2}|n\d{4})$/)
    .nullable(),
  name: text(200),
  website: text(500),
  town: text(100),
  state: text(50),
  industry: z.string().max(100).nullable(),
});
const IndustrySubject = z.object({ kind: z.literal("industry"), industry: z.string().max(100), category: text(200).nullable(), region: text(200).nullable() });

export const MissionInput = z.object({
  type: z.enum(MISSION_TYPES),
  simulated: z.boolean(),
  /** Test mode only: invented costs at a real model's price, on an isolated copy of the database. */
  synthetic: z.boolean().optional(),
  purpose: text(1000),
  subject: z.discriminatedUnion("kind", [CompanySubject, IndustrySubject]),
  model: z.string().max(60),
  thinkingLevel: z.enum(THINKING_LEVELS),
  maxCostMicros: z.number().int().min(1).max(MISSION_CAP_MICROS),
  review: z.object({ provider: z.enum(["anthropic", "simulation", "synthetic"]), model: z.string().max(60), maxCostMicros: z.number().int().min(1).max(MISSION_CAP_MICROS) }).nullable(),
});
export type MissionInput = z.infer<typeof MissionInput>;

export const MISSION_ACTIONS = ["submit", "approve", "reject", "start", "resume", "cancel", "review", "accept", "close"] as const;
export type MissionAction = (typeof MISSION_ACTIONS)[number];


