import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { payoutPaidAction } from "@/app/actions/orders";
import { ActionForm, SubmitButton } from "@/components/forms";
import { OrdersTable } from "@/components/orders-table";
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { toActor, type SessionUser } from "@/lib/auth/session";
import { getDb, type DB } from "@/lib/db";
import { orgs } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actor";
import { builderEarnings, listBuilders, pendingPayouts } from "@/lib/domain/builders";
import { computeMetrics } from "@/lib/domain/metrics";
import { listCarePlans, listOrders } from "@/lib/domain/orders";
import { orderRef } from "@/lib/domain/records";
import { BUILDER_STATUS_LABELS, type WorkOrderStatus } from "@/lib/domain/types";
import { date, money, pct } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const user = await requireUser();
  const db = await getDb();
  const actor = toActor(user);
  if (user.role === "operator") return <OpsHome db={db} actor={actor} includeDemo={(await searchParams).demo === "1"} />;
  if (user.role === "builder") return <BuilderHome db={db} actor={actor} user={user} />;
  return <ClientHome db={db} actor={actor} />;
}

// ---------------------------------------------------------------------------

async function ClientHome({ db, actor }: { db: DB; actor: Actor }) {
  const [org] = actor.orgId ? await db.select().from(orgs).where(eq(orgs.id, actor.orgId)).limit(1) : [];
  const list = await listOrders(db, actor);
  const care = await listCarePlans(db, actor);
  const attention = list.filter((o) => o.status === "quoted" || o.status === "accepted" || o.status === "delivered");
  const ask: Partial<Record<WorkOrderStatus, string>> = {
    quoted: "Review and accept your quote",
    accepted: "Pay to start the work",
    delivered: "Review the delivery",
  };
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        eyebrow="Client HQ"
        title={org?.name ?? "Your company"}
        description="Every Work Order and Care plan for your company, in one place."
        actions={<LinkButton href="/orders/new">New request</LinkButton>}
      />
      {attention.length ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          {attention.map((o) => (
            <Link key={o.id} href={`/orders/${o.id}`} className="fx-card block px-4 py-3 ring-1 ring-ember-200 hover:shadow-md">
              <p className="text-xs font-semibold text-ember-700">{ask[o.status]}</p>
              <p className="mt-0.5 font-medium">{o.title}</p>
              <p className="text-xs text-stone-500">{orderRef(o.number)}</p>
            </Link>
          ))}
        </div>
      ) : null}
      <h2 className="mb-3 text-lg font-semibold">Work Orders</h2>
      {list.length ? (
        <OrdersTable orders={list} amount="price" />
      ) : (
        <EmptyState title="No requests yet" action={<LinkButton href="/orders/new">Start your first request</LinkButton>}>
          Describe a workflow that eats your team's time. You'll see a draft scope right away.
        </EmptyState>
      )}
      <h2 className="mt-8 mb-3 text-lg font-semibold">Care plans</h2>
      {care.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {care.map((c) => (
            <Link key={c.id} href={`/orders/${c.workOrderId}`} className="fx-card block px-4 py-3 hover:shadow-md">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{c.title}</p>
                <Badge tone={c.status === "active" ? "emerald" : c.status === "requested" ? "amber" : "neutral"}>{c.status}</Badge>
              </div>
              <p className="text-sm text-stone-500">{money(c.monthlyPriceCents)} / month</p>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-stone-500">Care keeps delivered automations monitored and maintained. You can add it once a Work Order is accepted.</p>
      )}
      <p className="mt-8 text-xs text-stone-400">Planned, not built yet: live health checks for each automation under Care.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function BuilderHome({ db, actor, user }: { db: DB; actor: Actor; user: SessionUser }) {
  const list = await listOrders(db, actor);
  const invites = list.filter((o) => o.invited);
  const active = list.filter((o) => !o.invited && o.status !== "completed" && o.status !== "cancelled");
  const done = list.filter((o) => !o.invited && o.status === "completed");
  const earnings = actor.builderId ? await builderEarnings(db, actor.builderId) : { rows: [], pendingCents: 0, paidCents: 0 };
  const approved = user.builderStatus === "approved";
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        eyebrow="Builder"
        title={`Welcome, ${user.name.split(" ")[0]}`}
        actions={
          <>
            <LinkButton href="/profile" variant="secondary">
              Edit profile
            </LinkButton>
            {approved && user.builderSlug ? <LinkButton href={`/b/${user.builderSlug}`}>Public record</LinkButton> : null}
          </>
        }
      />
      {!approved ? (
        <div className="mb-6">
          <Alert tone={user.builderStatus === "rejected" ? "rose" : "sky"} title={BUILDER_STATUS_LABELS[user.builderStatus ?? "applied"]}>
            {user.builderStatus === "applied"
              ? "We review every application. Next is a short video call with a government ID; we'll email you to schedule it."
              : "Reply to your ForgeX email if you have questions about your status."}
          </Alert>
        </div>
      ) : null}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Payouts queued" value={money(earnings.pendingCents)} />
        <Stat label="Paid to date" value={money(earnings.paidCents)} />
        <Stat label="Accepted Work Orders" value={done.length} />
      </div>
      <h2 className="mb-3 text-lg font-semibold">Invitations</h2>
      {invites.length ? <OrdersTable orders={invites} amount="payout" showCompany /> : <p className="mb-2 text-sm text-stone-500">No open invitations.</p>}
      <h2 className="mt-8 mb-3 text-lg font-semibold">Active work</h2>
      {active.length ? <OrdersTable orders={active} amount="payout" showCompany /> : <p className="text-sm text-stone-500">Nothing in progress.</p>}
      {done.length ? (
        <>
          <h2 className="mt-8 mb-3 text-lg font-semibold">Accepted</h2>
          <OrdersTable orders={done} amount="payout" showCompany />
        </>
      ) : null}
      {earnings.rows.length ? (
        <>
          <h2 className="mt-8 mb-3 text-lg font-semibold">Earnings</h2>
          <div className="fx-card divide-y divide-stone-100 text-sm">
            {earnings.rows.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <Link href={`/orders/${p.workOrderId}`} className="hover:text-ember-700">
                  {orderRef(p.number)} · {p.title}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{money(p.amountCents)}</span>
                  {p.testFunded ? <Badge>TEST order</Badge> : null}
                  {p.status === "paid" ? <Badge tone="emerald">Sent {date(p.paidAt)}</Badge> : <Badge tone="amber">Queued</Badge>}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const PIPELINE: [string, WorkOrderStatus[], string][] = [
  ["Scope and quote", ["submitted"], "New requests with a draft scope, waiting for review and pricing."],
  ["Waiting on the client", ["quoted", "accepted", "delivered"], "Quote acceptance, payment or delivery review."],
  ["Needs a builder", ["funded"], "Funded, but no builder has accepted yet."],
  ["In progress", ["in_progress"], ""],
  ["Disputes", ["disputed"], "Step in and resolve."],
  ["Completed", ["completed"], ""],
  ["Cancelled", ["cancelled"], ""],
];

async function OpsHome({ db, actor, includeDemo }: { db: DB; actor: Actor; includeDemo: boolean }) {
  const m = await computeMetrics(db, { includeDemo });
  const list = await listOrders(db, actor);
  const due = await pendingPayouts(db);
  const applications = (await listBuilders(db)).filter((b) => b.status === "applied").length;
  const care = (await listCarePlans(db, actor)).filter((c) => c.status === "requested");
  const hours = m.speed.hoursToQuote;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        eyebrow="ForgeX operations"
        title="Pipeline"
        description={
          includeDemo
            ? "Activity includes demo and test companies. Money is still split: only real money counts as cash, margin or MRR."
            : "Real companies only. Money counts only real payments; test and unverified amounts are shown apart."
        }
        actions={
          <>
            <LinkButton href={includeDemo ? "/dashboard" : "/dashboard?demo=1"} variant="secondary">
              {includeDemo ? "Show real metrics only" : "Include demo data in metrics"}
            </LinkButton>
            <LinkButton href="/ops/new">New Work Order</LinkButton>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cash collected (real)" value={money(m.cash.collectedCents)} hint={m.cash.refundedCents ? `${money(m.cash.refundedCents)} refunded` : undefined} />
        <Stat
          label="Gross margin on funded orders"
          value={money(m.grossMarginCents)}
          hint={
            m.grossMarginPct === null
              ? "No orders funded with real money yet"
              : `${pct(m.grossMarginPct)}${m.inHouseFunded ? ` · ${m.inHouseFunded} in-house, your time not counted` : ""}`
          }
        />
        <Stat label="Average order" value={m.avgOrderCents === null ? "—" : money(m.avgOrderCents)} />
        <Stat
          label="Care MRR (real)"
          value={money(m.care.mrrCents)}
          hint={m.care.testActiveCount ? `${m.care.activeCount} active · ${money(m.care.testMrrCents)} on test orders not counted` : `${m.care.activeCount} active, invoiced by hand`}
        />
        <Stat label="Request to quote" value={hours === null ? "—" : hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`} hint="Target: under 1 business day" />
        <Stat label="Accepted first time" value={m.quality.firstPassRate === null ? "—" : pct(m.quality.firstPassRate)} hint={`${m.quality.disputes} disputes`} />
        <Stat
          label="Payouts due"
          value={money(m.payouts.pendingCents)}
          hint={m.payouts.testPendingCents ? `${money(m.payouts.testPendingCents)} more on TEST orders` : `${money(m.payouts.paidCents)} paid`}
        />
        <Stat label="AI scoping cost" value={`$${m.aiCostDollars.toFixed(2)}`} />
      </div>
      {m.cash.testOrders ? (
        <p className="mt-2 text-xs text-stone-500" data-testid="test-money">
          Test money in this view: {money(m.cash.testCollectedCents)} across {m.cash.testOrders} payments (TEST payments, Stripe test mode, demo and test
          companies). It never counts as cash, margin or MRR.
        </p>
      ) : null}
      {m.cash.unverifiedPayments ? (
        <p className="mt-1 text-xs font-medium text-amber-800" data-testid="unverified-money">
          Unverified: {money(m.cash.unverifiedCents)} across {m.cash.unverifiedPayments} Stripe payments recorded before their live or test mode was stored.
          Check them in Stripe; they count as neither real nor test until then.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-stone-500">Funnel:</span>
        {(
          [
            ["Requests", m.funnel.requests],
            ["Quoted", m.funnel.quoted],
            ["Accepted", m.funnel.accepted],
            ["Funded", m.funnel.funded],
            ["Completed", m.funnel.completed],
          ] as const
        ).map(([label, n], i) => (
          <span key={label} className="flex items-center gap-2">
            {i ? <span className="text-stone-300">→</span> : null}
            <span className="rounded-full bg-white px-2.5 py-1 font-medium ring-1 ring-stone-200">
              {label} <span className="tabular-nums">{n}</span>
            </span>
          </span>
        ))}
      </div>

      <div className="mt-6 space-y-2">
        {applications ? (
          <Alert tone="sky">
            {applications} builder application{applications === 1 ? "" : "s"} waiting.{" "}
            <Link href="/ops/builders" className="fx-link">
              Review
            </Link>
          </Alert>
        ) : null}
        {care.length ? <Alert tone="amber">{care.length} Care plan request(s) to set up: open the Work Order to activate.</Alert> : null}
      </div>

      <div className="mt-8 space-y-8">
        {PIPELINE.map(([title, statuses, hint]) => {
          const rows = list.filter((o) => statuses.includes(o.status));
          if (!rows.length) return null;
          return (
            <section key={title}>
              <h2 className="text-lg font-semibold">
                {title} <span className="text-sm font-normal text-stone-500">({rows.length})</span>
              </h2>
              {hint ? <p className="mb-2 text-sm text-stone-500">{hint}</p> : <div className="mb-2" />}
              <OrdersTable orders={rows} amount="price" showCompany />
            </section>
          );
        })}
        {!list.length ? (
          <EmptyState title="No Work Orders yet">Requests from clients appear here with an AI or template draft scope ready for review.</EmptyState>
        ) : null}
      </div>

      {due.length ? (
        <Card title="Payouts due" className="mt-8" description="Released on client acceptance. Record each transfer once it's sent.">
          <div className="divide-y divide-stone-100">
            {due.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <Link href={`/orders/${p.workOrderId}`} className="font-medium hover:text-ember-700">
                    {orderRef(p.number)} · {p.title}
                  </Link>
                  <div className="text-stone-500">
                    {p.builderName} · {money(p.amountCents)}{" "}
                    {p.testFunded ? <Badge tone="amber">TEST order: no real payout due</Badge> : null}
                  </div>
                </div>
                <ActionForm action={payoutPaidAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="payoutId" value={p.id} />
                  <input type="hidden" name="orderId" value={p.workOrderId} />
                  <input name="method" defaultValue="ACH" className="fx-input w-24" aria-label="Method" />
                  <input name="reference" required placeholder="Reference" className="fx-input w-36" aria-label="Reference" />
                  <SubmitButton variant="secondary" pendingText="…">
                    Mark sent
                  </SubmitButton>
                </ActionForm>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
