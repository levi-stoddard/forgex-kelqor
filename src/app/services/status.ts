import type { Tone } from "@/components/ui";
import type { CustomerRequestView } from "@/lib/services/contract";

export const STATUS_TONE: Record<CustomerRequestView["status"], Tone> = {
  received: "neutral",
  processing: "sky",
  in_review: "sky",
  needs_info: "amber",
  awaiting_customer: "amber",
  completed: "emerald",
  declined: "neutral",
  failed: "rose",
};

