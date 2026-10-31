"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { actionContext, run, str, type ActionState } from "@/lib/actions";
import { allowAttempt } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { linkOpportunityWorkOrder } from "@/lib/domain/discovery";
import { DomainError } from "@/lib/domain/errors";
import { acceptInvite, createClientForSale, issueInvite } from "@/lib/domain/invites";
import { createWorkOrder } from "@/lib/domain/orders";
import type { Intake } from "@/lib/domain/types";
import { DOSSIER_SOURCE, getDossier } from "@/lib/research/dossiers";

/** Operator writes up a Work Order after a sales conversation, for a new or existing client. */
export async function createSaleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let target = "";
  const result = await run(async () => {
    const { db, actor, user } = await actionContext();
    if (actor.role !== "operator") throw new DomainError("Only ForgeX operators can write up Work Orders for clients.", "forbidden");
    if (!allowAttempt(`sale:${user.id}`, 30, 60 * 60 * 1000)) throw new DomainError("That's a lot of Work Orders this hour. Try again later.");
    const intake: Intake = {
      problem: str(form, "problem"),
      currentTools: str(form, "currentTools"),
      desiredOutcome: str(form, "desiredOutcome"),
      volume: str(form, "volume"),
      deadline: str(form, "deadline"),
      budgetBand: str(form, "budgetBand") || "Not sure yet",
      templateSlug: str(form, "templateSlug") || null,
    };
    // Check the request before creating anyone, so a typo doesn't leave an orphaned client account behind.
    if (intake.problem.trim().length < 20) throw new DomainError("Describe the problem in a sentence or two (at least 20 characters).");
    let orgId = str(form, "orgId");
    let newClientUserId: string | null = null;
    if (str(form, "mode") !== "existing") {
      const created = await createClientForSale(db, actor, {
        companyName: str(form, "companyName"),
        contactName: str(form, "contactName"),
        email: str(form, "email"),
        industry: str(form, "industry"),
        sizeBand: str(form, "sizeBand"),
        dataClass: (str(form, "dataClass") as "real" | "test" | "") || "",
      });
      orgId = created.orgId;
      newClientUserId = created.userId;
    }
    const order = await createWorkOrder(db, actor, intake, { orgId });
    // Drafted from a problem confirmed in discovery: keep the link back to the researched company it came from.
    const dossier = /^c\d{2}$/.test(str(form, "opportunity")) ? getDossier(str(form, "opportunity")) : null;
    if (dossier) {
      const problemId = /^[0-9a-f-]{36}$/.test(str(form, "problemId")) ? str(form, "problemId") : null;
      await linkOpportunityWorkOrder(db, actor, { source: DOSSIER_SOURCE.id, recordId: dossier.id, companyName: dossier.name, workOrderId: order.id, problemId });
    }
    const token = newClientUserId ? await issueInvite(db, actor, { userId: newClientUserId, workOrderId: order.id }) : "";
    target = `/orders/${order.id}${token ? `?invite=${token}` : ""}`;
  });
  if (result?.error) return result;
  redirect(target);
}

/** A fresh one-time link for a client contact who hasn't set a password yet. */
export async function newInviteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  let token = "";
  const result = await run(async () => {
    const { db, actor } = await actionContext();
    token = await issueInvite(db, actor, { userId: str(form, "userId"), workOrderId: orderId || null });
  });
  if (result?.error) return result;
  redirect(`/orders/${orderId}?invite=${token}`);
}

export async function acceptInviteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allowAttempt(`invite:${ip}`, 20)) return { error: "Too many attempts. Wait 15 minutes and try again." };
  if (str(form, "password") !== str(form, "confirm")) return { error: "The two passwords don't match." };
  let destination = "/services";
  const result = await run(async () => {
    const db = await getDb();
    const { userId, workOrderId } = await acceptInvite(db, str(form, "token"), { name: str(form, "name"), password: str(form, "password") });
    await createSession(userId);
    // A Work Order invitation opens that order; a managed-services invitation (Milestone 4) opens the services.
    destination = workOrderId ? `/orders/${workOrderId}` : "/services";
  });
  if (result?.error) return result;
  redirect(destination);
}
