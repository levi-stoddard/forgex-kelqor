"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionContext, run, str, type ActionState } from "@/lib/actions";
import { allowAttempt } from "@/lib/auth/rate-limit";
import { DomainError } from "@/lib/domain/errors";
import { answerRequest, decideRequest, submitRequest } from "@/lib/services/service";

// Customer portal actions (Milestone 4). Every one runs as the signed-in account through the managed-services domain,
// which keeps a customer inside its own organization; the form's request key makes a double submit act once.

const formKey = (form: FormData) => {
  const k = str(form, "requestKey");
  return /^[0-9a-f-]{36}$/.test(k) ? k : randomUUID();
};

export async function submitServiceRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let target = "";
  const result = await run(async () => {
    const { db, actor, user } = await actionContext();
    if (actor.role !== "client") throw new DomainError("Requests are submitted from a customer account.", "forbidden");
    if (!allowAttempt(`svc-request:${user.id}`, 60, 60 * 60 * 1000)) throw new DomainError("That's a lot of requests this hour. Try again later.");
    const r = await submitRequest(db, actor, { serviceId: str(form, "serviceId"), title: str(form, "title") || undefined, text: str(form, "text"), from: str(form, "from") || undefined }, formKey(form));
    target = `/services/requests/${r.id}`;
  });
  if (target) redirect(target);
  return result;
}

export async function decideServiceRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const { db, actor } = await actionContext();
    const id = str(form, "requestId");
    await decideRequest(db, actor, id, { decision: str(form, "decision"), resultHash: str(form, "resultHash"), note: str(form, "note") }, formKey(form));
    revalidatePath(`/services/requests/${id}`);
    return { ok: true, message: str(form, "decision") === "approve" ? "Approved. The result is final." : "Sent to KELQOR." };
  });
}

export async function answerServiceRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const { db, actor } = await actionContext();
    const id = str(form, "requestId");
    await answerRequest(db, actor, id, { text: str(form, "text") }, formKey(form));
    revalidatePath(`/services/requests/${id}`);
    return { ok: true, message: "Thanks. KELQOR is working on it again." };
  });
}
