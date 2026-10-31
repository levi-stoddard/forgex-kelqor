"use server";

import { revalidatePath } from "next/cache";
import { actionContext, run, str, type ActionState } from "@/lib/actions";
import { reviewBuilder, updateBuilderProfile } from "@/lib/domain/builders";
import { DomainError } from "@/lib/domain/errors";
import { BUILDER_STATUSES, type BuilderStatus } from "@/lib/domain/types";
import { lines, parseDollars } from "@/lib/format";

export async function updateProfileAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const { db, actor, user } = await actionContext();
    await updateBuilderProfile(db, actor, {
      headline: str(form, "headline"),
      bio: str(form, "bio"),
      skills: str(form, "skills").split(","),
      hourlyRateCents: parseDollars(form.get("hourlyRate")),
      country: str(form, "country"),
      timezone: str(form, "timezone"),
      links: lines(form.get("links")),
    });
    revalidatePath("/profile");
    if (user.builderSlug) revalidatePath(`/b/${user.builderSlug}`);
    return { ok: true, message: "Profile saved." };
  });
}

export async function reviewBuilderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const { db, actor } = await actionContext();
    const status = str(form, "status") as BuilderStatus;
    if (!BUILDER_STATUSES.includes(status)) throw new DomainError("Choose a status.");
    await reviewBuilder(db, actor, str(form, "builderId"), {
      status,
      identityVerified: form.get("identityVerified") === "on",
      notes: str(form, "notes"),
    });
    revalidatePath("/ops/builders");
    return { ok: true, message: "Saved." };
  });
}
