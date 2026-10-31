import { DomainError } from "./errors";
import type { Role, WorkOrderStatus } from "./types";

/** "system" covers trusted automated callers such as the Stripe webhook. */
export type ActorRole = Role | "system";

interface Transition {
  from: readonly WorkOrderStatus[];
  to: WorkOrderStatus;
  by: readonly ActorRole[];
}

/**
 * Every allowed status change of a Work Order. Services must go through `transition()`,
 * so a status can never change without passing this table.
 */
export const TRANSITIONS = {
  send_quote: { from: ["submitted"], to: "quoted", by: ["operator"] },
  request_quote_changes: { from: ["quoted"], to: "submitted", by: ["client"] },
  accept_quote: { from: ["quoted"], to: "accepted", by: ["client"] },
  record_payment: { from: ["accepted"], to: "funded", by: ["operator", "system"] },
  start_work: { from: ["funded"], to: "in_progress", by: ["operator", "system"] },
  submit_delivery: { from: ["in_progress"], to: "delivered", by: ["builder"] },
  request_revision: { from: ["delivered"], to: "in_progress", by: ["client"] },
  accept_delivery: { from: ["delivered"], to: "completed", by: ["client", "operator"] },
  open_dispute: { from: ["in_progress", "delivered"], to: "disputed", by: ["client", "builder", "operator"] },
  resolve_continue: { from: ["disputed"], to: "in_progress", by: ["operator"] },
  resolve_complete: { from: ["disputed"], to: "completed", by: ["operator"] },
  cancel: {
    from: ["submitted", "quoted", "accepted", "funded", "in_progress", "delivered", "disputed"],
    to: "cancelled",
    by: ["client", "operator"],
  },
} as const satisfies Record<string, Transition>;

export type OrderEvent = keyof typeof TRANSITIONS;

/** Clients can cancel on their own only before any money has moved. */
const CLIENT_CANCELLABLE: readonly WorkOrderStatus[] = ["submitted", "quoted", "accepted"];

export function canTransition(status: WorkOrderStatus, event: OrderEvent, role: ActorRole): boolean {
  const t: Transition = TRANSITIONS[event];
  if (!t.from.includes(status) || !t.by.includes(role)) return false;
  if (event === "cancel" && role === "client" && !CLIENT_CANCELLABLE.includes(status)) return false;
  return true;
}

export function transition(status: WorkOrderStatus, event: OrderEvent, role: ActorRole): WorkOrderStatus {
  if (!canTransition(status, event, role)) {
    throw new DomainError(`This Work Order can't ${event.replaceAll("_", " ")} while it is ${status.replaceAll("_", " ")}.`, "conflict");
  }
  return TRANSITIONS[event].to;
}

export function availableEvents(status: WorkOrderStatus, role: ActorRole): OrderEvent[] {
  return (Object.keys(TRANSITIONS) as OrderEvent[]).filter((e) => canTransition(status, e, role));
}
