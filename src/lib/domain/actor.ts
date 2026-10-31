import type { ActorRole } from "./state-machine";

/** Who is performing a domain action. Services authorize against this, never against raw request data. */
export interface Actor {
  id: string | null;
  role: ActorRole;
  orgId: string | null;
  builderId: string | null;
  name: string;
  email: string | null;
}

/** Trusted automated caller, e.g. the Stripe webhook after signature verification. */
export const SYSTEM_ACTOR: Actor = {
  id: null,
  role: "system",
  orgId: null,
  builderId: null,
  name: "ForgeX",
  email: null,
};
