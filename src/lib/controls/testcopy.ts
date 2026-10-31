import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { hashPassword, passwordProblem } from "../auth/password";
import type { DB } from "../db";
import { aiUsageLedger, spendingReconciliations, users } from "../db/schema";
import { normalizeEmail } from "../domain/accounts";
import { DomainError } from "../domain/errors";
import { newId, recordEvent } from "../domain/records";
import { DAY_CAP_MICROS, MONTH_CAP_MICROS } from "../missions/contract";
import { founderRow, moveAuthority } from "./authority";
import { boiseDay, boiseMonth, boiseTime } from "./boise";
import { asCount, backendInstance, inTransaction, lockSpending } from "./shared";
import { assertTestDatabase } from "./testmode";

// The acceptance run's isolated copy of the owner's database: migration 0004 turned demo sign-in off there too, and
// the owner's own password isn't known to the run. prepareTestCopy turns sign-in back on for the accounts the run
// names and gives owner spending authority to a non-demo test operator. precommitSpending adds synthetic committed
// spending so the window can show the $5 day or $20 month cap. Both refuse anything but a test database: an in-memory
// one or a copy marked with .kelqor-test-copy outside the project's .data folder.

export async function prepareTestCopy(
  db: DB,
  input: { operatorEmail: string; operatorPassword: string; enableSignIn: string[]; operatorName?: string },
): Promise<void> {
  assertTestDatabase(db);
  const problem = passwordProblem(input.operatorPassword ?? "");
  if (problem) throw new DomainError(`The test operator's password: ${problem}`, "invalid");
  const email = normalizeEmail(input.operatorEmail ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("Give the test operator a valid email address.", "invalid");
  const name = input.operatorName?.trim() || "Acceptance owner (test copy)";
  const passwordHash = await hashPassword(input.operatorPassword);
  await inTransaction(db, async (tx) => {
    const enabled: string[] = [];
    for (const raw of input.enableSignIn ?? []) {
      const e = normalizeEmail(raw);
      const done = await tx.update(users).set({ signInDisabledAt: null }).where(eq(users.email, e)).returning({ id: users.id });
      if (done.length === 0) throw new DomainError(`There is no account ${e} in this copy.`, "not_found");
      enabled.push(e);
    }
    const [existing] = await tx.select({ id: users.id, role: users.role, isDemo: users.isDemo }).from(users).where(eq(users.email, email)).limit(1);
    let id: string;
    if (existing) {
      if (existing.role !== "operator" || existing.isDemo) throw new DomainError(`${email} must be a non-demo operator to hold owner spending authority in the copy.`, "conflict");
      await tx.update(users).set({ passwordHash, name, signInDisabledAt: null }).where(eq(users.id, existing.id));
      id = existing.id;
    } else {
      id = newId();
      await tx.insert(users).values({ id, email, name, passwordHash, role: "operator", isDemo: false });
    }
    await moveAuthority(tx, { id, name, email, role: "operator", isDemo: false, signInDisabledAt: null }, { replace: true, via: "prepare-test-copy" });
    await recordEvent(tx, { actorId: id, type: "test_copy_prepared", data: { operator: email, signInEnabled: enabled } });
  });
}

/** Noon in Boise on the first of the month that `at` falls in. */
function noonOnTheFirst(at: Date): Date {
  const t = boiseTime(at);
  for (const offset of [6, 7]) {
    const candidate = new Date(Date.UTC(t.year, t.month - 1, 1, 12 + offset));
    const c = boiseTime(candidate);
    if (c.day === 1 && c.hour === 12 && c.minute === 0) return candidate;
  }
  throw new Error("Noon on the first of the month couldn't be placed in Boise time.");
}

async function committed(tx: DB, where: "day" | "month", period: string): Promise<number> {
  const l = aiUsageLedger;
  const [r] = await tx
    .select({ s: sql<unknown>`coalesce(sum(${l.committedMicros}), 0)` })
    .from(l)
    .where(sql`${l.simulated} = false and ${where === "day" ? l.boiseDay : l.boiseMonth} = ${period}`);
  return asCount(r.s);
}

/**
 * Test copies only: raises today's committed spending to `dayMicros` (dated now) and this month's to `monthMicros`
 * (dated at noon in Boise on the 1st, so it doesn't fill today's cap; refused on the 1st), as synthetic, unverified
 * reconciliation adjustments recorded by the copy's owner. Running it again adds only what is missing.
 */
export async function precommitSpending(db: DB, input: { dayMicros?: number; monthMicros?: number; now?: Date }): Promise<{ addedDayMicros: number; addedMonthMicros: number }> {
  assertTestDatabase(db);
  const now = input.now ?? new Date();
  for (const [v, cap, label] of [
    [input.dayMicros, DAY_CAP_MICROS, "day"],
    [input.monthMicros, MONTH_CAP_MICROS, "month"],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v <= 0 || v > cap)) throw new DomainError(`The ${label} precommit must be more than $0 and at most the $${cap / 1_000_000} cap.`, "invalid");
  }
  if (input.monthMicros !== undefined && boiseTime(now).day === 1) {
    throw new DomainError("Today is the 1st in Boise, so there is no earlier day this month to date the month's precommitted spending on.", "conflict");
  }
  return inTransaction(db, async (tx) => {
    await lockSpending(tx);
    const founder = await founderRow(tx);
    if (!founder) throw new DomainError("Designate the copy's test owner first.", "conflict");
    const add = async (periodKind: "day" | "month", period: string, micros: number, at: Date) => {
      const figureId = randomUUID();
      const adjustmentId = randomUUID();
      const note = `Acceptance test copy: synthetic precommitted spending for ${period}, so the ${periodKind} cap can be shown. Not real spending.`;
      await tx.insert(spendingReconciliations).values({ id: figureId, kind: "figure", provider: "synthetic", periodKind, period, providerMicros: micros, note, recordedById: founder.id });
      await tx.insert(spendingReconciliations).values({ id: adjustmentId, kind: "adjustment", provider: "synthetic", periodKind, period, adjustmentMicros: micros, figureId, note, recordedById: founder.id });
      await tx.insert(aiUsageLedger).values({
        id: randomUUID(),
        purpose: "adjustment",
        provider: "synthetic",
        model: "precommitted",
        priceVersion: "adjustment",
        prices: { input: 0, cachedInput: 0, output: 0 },
        sentAt: at,
        boiseDay: boiseDay(at),
        boiseMonth: boiseMonth(at),
        countedInputTokens: 0,
        reservedInputTokens: 0,
        maxOutputTokens: 0,
        reservedMicros: micros,
        status: "unverified",
        errorKind: "precommitted_test_spending",
        errorDetail: note,
        synthetic: true,
        backendInstance: backendInstance(),
        reconciliationId: adjustmentId,
        settledAt: at,
      });
    };
    let addedDayMicros = 0;
    let addedMonthMicros = 0;
    if (input.monthMicros !== undefined) {
      const month = boiseMonth(now);
      addedMonthMicros = Math.max(0, input.monthMicros - (await committed(tx, "month", month)));
      if (addedMonthMicros > 0) await add("month", month, addedMonthMicros, noonOnTheFirst(now));
    }
    if (input.dayMicros !== undefined) {
      const day = boiseDay(now);
      addedDayMicros = Math.max(0, input.dayMicros - (await committed(tx, "day", day)));
      if (addedDayMicros > 0) await add("day", day, addedDayMicros, now);
    }
    return { addedDayMicros, addedMonthMicros };
  });
}
