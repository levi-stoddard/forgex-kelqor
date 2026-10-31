import { createHash } from "node:crypto";
import type { ModelRequest } from "../ai/types";
import { TicketRefused, type ProviderId, type ProviderKind, type SpendTicket, type TicketUse } from "../missions/contract";

// Single-use tickets: the only key a provider has to the outside world. meteredRequest issues one for a token count
// (after the pre-check) and one for the reserved request. A provider redeems it right before it calls anything.
// Each live ticket is held in this module's private map, keyed by the ticket object itself, so an object built
// elsewhere with the same fields is refused, and every ticket is bound to its use, provider, model, kind and request.

/** How long a ticket stays usable after it is issued; also never past the approval's expiry. */
export const TICKET_TTL_MS = 30_000;

type TicketStatus = "live" | "redeemed" | "burned";

interface TicketRecord {
  use: "count" | "send";
  reservationId: string;
  provider: ProviderId;
  model: string;
  kind: ProviderKind;
  maxOutputTokens: number;
  digest: string;
  notAfter: number;
  status: TicketStatus;
}

const tickets = new WeakMap<object, TicketRecord>();

/** A stable JSON text: object keys sorted, undefined values left out (as JSON does). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("A number that isn't finite can't be fingerprinted.");
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") throw new Error(`A ${typeof value} can't be fingerprinted.`);
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The fingerprint of exactly what will be sent. */
export function requestDigest(request: ModelRequest): string {
  return sha256(`kelqor-request-v1\n${canonicalJson(request)}`);
}

export function issueTicket(t: Omit<TicketRecord, "status" | "notAfter"> & { validForMs: number }): SpendTicket {
  const ticket = Object.freeze({
    use: t.use,
    reservationId: t.reservationId,
    provider: t.provider,
    model: t.model,
    kind: t.kind,
    maxOutputTokens: t.maxOutputTokens,
  });
  tickets.set(ticket, {
    use: t.use,
    reservationId: t.reservationId,
    provider: t.provider,
    model: t.model,
    kind: t.kind,
    maxOutputTokens: t.maxOutputTokens,
    digest: t.digest,
    notAfter: Date.now() + Math.max(0, Math.min(TICKET_TTL_MS, t.validForMs)),
    status: "live",
  });
  return ticket as unknown as SpendTicket;
}

/**
 * Called by every provider right before it sends anything. Throws TicketRefused for a ticket the controls didn't
 * issue, one already used or expired, or one for another use, provider, model, kind or request; a refused live ticket
 * is burned, so it can't be tried again with a corrected request.
 */
export function redeemTicket(ticket: SpendTicket, use: TicketUse): void {
  const record = ticket !== null && typeof ticket === "object" ? tickets.get(ticket as object) : undefined;
  if (!record) throw new TicketRefused("This ticket wasn't issued by KELQOR's spending controls, so nothing may be sent with it.");
  if (record.status !== "live") throw new TicketRefused(`This ticket was already ${record.status === "redeemed" ? "used" : "refused"}; each ticket allows one call.`);
  const refuse = (why: string): never => {
    record.status = "burned";
    throw new TicketRefused(why);
  };
  if (Date.now() > record.notAfter) refuse("This ticket has expired, so nothing was sent.");
  if (!use || use.use !== record.use) refuse(`This ticket is for ${record.use === "count" ? "a token count" : "the reserved request"}, not this call.`);
  if (use.provider !== record.provider || use.model !== record.model) refuse(`This ticket is for ${record.provider} ${record.model}, not ${use.provider} ${use.model}.`);
  if (use.kind !== record.kind) refuse(`This ticket is for a ${record.kind} provider, not a ${use.kind} one.`);
  if (!use.request || use.request.maxOutputTokens !== record.maxOutputTokens) refuse("This request's output limit isn't the one reserved.");
  let digest: string;
  try {
    digest = requestDigest(use.request);
  } catch {
    return refuse("This request can't be fingerprinted, so it can't be matched to its reservation.");
  }
  if (digest !== record.digest) refuse("This request isn't the one that was counted and reserved.");
  record.status = "redeemed";
}

/** Whether the provider redeemed the ticket: only then can its call have left KELQOR. */
export function ticketStatus(ticket: SpendTicket): TicketStatus | null {
  return tickets.get(ticket as object)?.status ?? null;
}

/** Ends a ticket's life once its call is over, so a late or repeated redemption is refused. */
export function retireTicket(ticket: SpendTicket): void {
  const record = tickets.get(ticket as object);
  if (record && record.status === "live") record.status = "burned";
}
