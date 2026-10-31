import { z } from "zod";
import { isFounder } from "../controls";
import type { DB } from "../db";
import type { Actor } from "../domain/actor";
import { DomainError } from "../domain/errors";
import { CHECK_COMMANDS, CHECK_COMMAND_IDS, ENG_ACTIONS, LIVE_AGENT_EXECUTION_AUTHORIZED, RESPONSE_MAX_CHARS, type EngAction } from "../engineering/contract";
import { engineeringExecutor } from "../engineering/executor";
import { agentStatuses, createEngMission, engMissionAction, getEngMission, listEngMissions, updateEngMission } from "../engineering/service";
import { addWorkspace, demoWorkspace, listWorkspaces } from "../engineering/workspaces";

// Engineering Missions routes for the desktop app (Milestone 3), all under /api/desktop/eng/ and for operators only
// (the caller checks that). The mission service and the workspace registry check the owner's authority themselves.

const RequestId = z.object({ requestId: z.string().regex(/^[0-9a-f-]{36}$/) });
const WithMission = RequestId.extend({ mission: z.unknown() });
const Action = RequestId.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reason: z.string().max(2000).optional(),
  tree: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  // A little over the saved limit, so an oversized paste gets the service's clear message rather than a bare 400.
  response: z.string().max(RESPONSE_MAX_CHARS * 2).optional(),
});
const Workspace = z.strictObject({ name: z.string().max(80), path: z.string().min(3).max(500), baseBranch: z.string().max(200) });

type Body = <T>(schema: z.ZodType<T>) => Promise<T>;

export async function engineeringOverview(db: DB, actor: Actor) {
  return {
    isFounder: actor.id ? await isFounder(db, actor.id) : false,
    liveAgentExecution: LIVE_AGENT_EXECUTION_AUTHORIZED,
    agents: await agentStatuses(),
    workspaces: await listWorkspaces(db),
    missions: await listEngMissions(db, actor),
    checks: CHECK_COMMAND_IDS.map((id) => ({ id, label: CHECK_COMMANDS[id].label })),
  };
}
export type EngineeringOverview = Awaited<ReturnType<typeof engineeringOverview>>;

/** Answers an Engineering Missions route, or returns undefined when the path isn't one. */
export async function engineeringRoute(db: DB, actor: Actor, method: string, p: string[], body: Body): Promise<unknown | undefined> {
  const at = (m: string, ...parts: (string | RegExp)[]) =>
    method === m && p.length === parts.length && parts.every((part, i) => (typeof part === "string" ? part === p[i] : part.test(p[i])));
  const ID = /^[0-9a-f-]{36}$/;
  const deps = { executor: engineeringExecutor() };

  if (at("GET", "eng")) return engineeringOverview(db, actor);
  if (at("GET", "eng", "missions", ID)) return getEngMission(db, actor, p[2]);
  if (at("POST", "eng", "missions")) {
    const b = await body(WithMission);
    return createEngMission(db, actor, b.mission, b.requestId);
  }
  if (at("PUT", "eng", "missions", ID)) {
    const b = await body(WithMission);
    return updateEngMission(db, actor, p[2], b.mission, b.requestId);
  }
  if (at("POST", "eng", "missions", ID, /^[a-z_]{3,20}$/) && (ENG_ACTIONS as readonly string[]).includes(p[3])) {
    return engMissionAction(db, actor, p[2], p[3] as EngAction, await body(Action), deps);
  }
  if (at("POST", "eng", "workspaces")) return addWorkspace(db, actor, await body(Workspace));
  if (at("POST", "eng", "workspaces", "demo")) {
    // Creating the demo workspace is the owner's, like registering any workspace.
    if (!(actor.id && (await isFounder(db, actor.id)))) throw new DomainError("Only the owner's account can set up workspaces.", "forbidden");
    return demoWorkspace(db, actor);
  }
  return undefined;
}
