import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { events, outbox, users } from "../db/schema";

export const newId = () => crypto.randomUUID();

/** Human-facing Work Order reference, e.g. FX-1001. */
export const orderRef = (n: number) => `FX-${1000 + n}`;

export async function recordEvent(
  db: DB,
  e: { workOrderId?: string | null; actorId?: string | null; type: string; data?: Record<string, unknown> },
): Promise<void> {
  await db.insert(events).values({
    id: newId(),
    workOrderId: e.workOrderId ?? null,
    actorId: e.actorId ?? null,
    type: e.type,
    data: e.data ?? {},
  });
}

export interface Notice {
  subject: string;
  body: string;
  link?: string;
  workOrderId?: string | null;
}

/** Queue a notification. Delivery is the outbox's job (viewable at /ops/outbox until an email provider is wired in). */
export async function notify(db: DB, toEmail: string, n: Notice): Promise<void> {
  await db.insert(outbox).values({
    id: newId(),
    toEmail,
    subject: n.subject,
    body: n.body,
    link: n.link ?? null,
    workOrderId: n.workOrderId ?? null,
  });
}

export async function notifyOperators(db: DB, n: Notice): Promise<void> {
  const ops = await db.select({ email: users.email }).from(users).where(eq(users.role, "operator"));
  for (const op of ops) await notify(db, op.email, n);
}
