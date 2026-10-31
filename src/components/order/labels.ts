import type { WorkOrderStatus } from "@/lib/domain/types";

export const EVENT_LABELS: Record<string, string> = {
  created: "Request submitted",
  scope_edited: "Scope edited by ForgeX",
  scope_redrafted: "Scope redrafted",
  send_quote: "Fixed-price quote sent",
  request_quote_changes: "Client asked for quote changes",
  accept_quote: "Quote accepted",
  record_payment: "Payment received",
  builder_invited: "Builder invited",
  assignment_accepted: "Builder confirmed",
  assignment_declined: "Invitation declined",
  start_work: "Work started",
  milestone_done: "Milestone completed",
  milestone_reopened: "Milestone reopened",
  submit_delivery: "Delivery submitted",
  request_revision: "Revision requested",
  accept_delivery: "Delivery accepted",
  open_dispute: "Dispute opened",
  resolve_continue: "Dispute resolved: work continues",
  resolve_complete: "Dispute resolved: completed",
  cancel: "Cancelled",
  refund_recorded: "Refund issued",
  extra_payment: "Extra payment received (to refund)",
  payout_paid: "Builder paid",
  review_submitted: "Review left",
  care_requested: "Care plan requested",
  care_activated: "Care plan activated",
  care_cancelled: "Care plan cancelled",
};

export const ROLE_LABELS: Record<string, string> = { client: "Client", builder: "Builder", operator: "ForgeX" };

interface Viewer {
  isOperator: boolean;
  isClient: boolean;
  isAssignedBuilder: boolean;
  isInvitedBuilder: boolean;
}

/** One sentence telling this viewer what happens next. */
export function nextStep(status: WorkOrderStatus, v: Viewer, staffed: boolean): string {
  switch (status) {
    case "submitted":
      if (v.isOperator) return "Review the draft scope, set the price and send the quote.";
      return "ForgeX is reviewing your draft scope. A fixed-price quote usually follows within one business day.";
    case "quoted":
      if (v.isOperator) return "Waiting for the client to accept the quote. You can line up a builder now.";
      if (v.isInvitedBuilder) return "Review the scope, criteria and payout, then accept or decline.";
      if (v.isAssignedBuilder) return "You're assigned. Work starts once the client accepts and pays.";
      return "Review the scope and acceptance criteria, then accept the quote or ask for changes.";
    case "accepted":
      if (v.isOperator) return "Waiting for payment. Record a bank transfer when it arrives.";
      if (v.isInvitedBuilder) return "Review the scope, criteria and payout, then accept or decline.";
      if (v.isAssignedBuilder) return "You're assigned. Work starts once the client's payment is in.";
      return "Pay to start. Work begins as soon as your payment clears.";
    case "funded":
      if (v.isOperator) return staffed ? "Funded and staffed." : "Funded. Invite a builder to start the work.";
      if (v.isInvitedBuilder) return "This Work Order is funded. Accept to start right away.";
      return "Payment received. ForgeX is confirming your builder.";
    case "in_progress":
      if (v.isAssignedBuilder) return "Work through the milestones, then submit the delivery with evidence for every criterion.";
      if (v.isOperator) return "In progress with the builder.";
      return "Your builder is working. Questions go in the conversation below.";
    case "delivered":
      if (v.isClient) return "Check each acceptance criterion against the evidence, then accept or request a revision.";
      if (v.isOperator) return "Waiting for the client's review. If the review window lapses, you can accept on their behalf.";
      return "The client is reviewing your delivery.";
    case "completed":
      if (v.isClient) return "Done. Leave a review, and consider Care to keep it running.";
      if (v.isAssignedBuilder) return "Accepted. Your payout is queued, and the ledger shows when it's sent.";
      return "Completed. Pay the builder and activate Care if it was requested.";
    case "disputed":
      return v.isOperator ? "Resolve the dispute: continue the work, complete it, or cancel and refund." : "A ForgeX operator is reviewing the dispute.";
    case "cancelled":
      return "This Work Order was cancelled.";
  }
}
