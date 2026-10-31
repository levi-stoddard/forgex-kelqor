import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { getDb } from "@/lib/db";
import { outbox } from "@/lib/db/schema";
import { dateTime, safeUrl } from "@/lib/format";

export const metadata: Metadata = { title: "Outbox" };

export default async function OutboxPage() {
  await requireUser(["operator"]);
  const rows = await (await getDb()).select().from(outbox).orderBy(desc(outbox.createdAt)).limit(200);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        eyebrow="ForgeX operations"
        title="Notification outbox"
        description="Every notification ForgeX would email. Nothing is sent yet: connect an email provider (Resend or Postmark) before launch."
      />
      {rows.length === 0 ? <EmptyState title="No notifications yet" /> : null}
      <div className="fx-card divide-y divide-stone-100">
        {rows.map((n) => {
          const link = n.link ? safeUrl(n.link) : null;
          return (
            <div key={n.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-stone-500">
                <span>To {n.toEmail}</span>
                <time>{dateTime(n.createdAt)}</time>
              </div>
              <p className="mt-0.5 font-medium text-stone-900">{n.subject}</p>
              <p className="text-stone-600">{n.body}</p>
              {link ? (
                <a href={link} className="fx-link text-xs break-all">
                  {link}
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
