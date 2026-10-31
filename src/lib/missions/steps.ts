import { randomUUID } from "node:crypto";
import type { DB } from "../db";
import { missionSteps } from "../db/schema";
import type { MissionStepKind } from "./contract";

/** Appends one line to a mission's step log. Page text and keys never go in a step. */
export async function logStep(
  db: DB,
  missionId: string,
  kind: MissionStepKind,
  summary: string,
  data: Record<string, unknown> = {},
  extra: { requestId?: string; actorId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(missionSteps).values({ id, missionId, kind, summary: summary.slice(0, 500), data, requestId: extra.requestId ?? null, actorId: extra.actorId ?? null });
  return id;
}
