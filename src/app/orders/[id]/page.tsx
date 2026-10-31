import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuilderPanels, DeliveryForm } from "@/components/order/builder";
import { ClientPanels, ReviewDeliveryForm } from "@/components/order/client";
import { nextStep } from "@/components/order/labels";
import { OpsPanels, ScopeEditor } from "@/components/order/ops";
import { CriteriaList, DeliveryHistory, Milestones, RequestSummary, ScopeView, Thread, Timeline } from "@/components/order/sections";
import { Alert, Badge, Card, KeyValue, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { toActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { approvedBuilders } from "@/lib/domain/builders";
import { DomainError } from "@/lib/domain/errors";
import { findInvite } from "@/lib/domain/invites";
import { getOrderView, type OrderView } from "@/lib/domain/orders";
import { orderRef } from "@/lib/domain/records";
import { date, money } from "@/lib/format";

export const metadata: Metadata = { title: "Work Order" };

function SummaryCard({ view }: { view: OrderView }) {
  const { order, viewer, assignedBuilder } = view;
  const rows: [string, string][] = [];
  if (viewer.isClient || viewer.isOperator) {
    rows.push([order.careIncluded ? "Setup (fixed)" : "Fixed price", money(order.priceCents)]);
    if (order.carePriceCents)
      rows.push([order.careIncluded ? "Monthly, from go-live" : "Optional Care after delivery", `${money(order.carePriceCents)}/month`]);
  }
  if (order.status === "quoted") rows.push(["Quote valid until", date(order.quoteExpiresAt)]);
  rows.push(["Requested", date(order.createdAt)]);
  if (order.completedAt) rows.push(["Accepted", date(order.completedAt)]);
  return (
    <Card title="Summary">
      <KeyValue rows={rows} />
      {assignedBuilder ? (
        <div className="mt-3 border-t border-stone-100 pt-3 text-sm">
          <p className="text-xs text-stone-500">Builder</p>
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {assignedBuilder.name}
            {assignedBuilder.identityVerified ? <Badge tone="emerald">ID verified</Badge> : null}
          </p>
          <p className="text-stone-600">{assignedBuilder.headline}</p>
          <Link href={`/b/${assignedBuilder.slug}`} className="fx-link text-sm">
            Verified record
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; checkout?: string; invite?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  let view: OrderView;
  try {
    view = await getOrderView(db, toActor(user), id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const { order, viewer, permissions } = view;
  const builders = viewer.isOperator ? await approvedBuilders(db) : [];
  // Shown once, right after the operator creates the link; only a still-open invite for this order is displayed.
  const invite = viewer.isOperator && sp.invite ? await findInvite(db, sp.invite) : null;
  const inviteToken = invite?.workOrderId === order.id ? sp.invite : undefined;
  const reviewed = view.criteria.some((c) => c.evidence || c.status !== "pending");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 space-y-2">
        {sp.created ? (
          <Alert tone="emerald" title="Request submitted">
            Here's your draft scope. ForgeX reviews it and sends a fixed-price quote, usually within one business day.
          </Alert>
        ) : null}
        {sp.checkout === "cancelled" ? <Alert tone="amber">Checkout was cancelled. Nothing was charged.</Alert> : null}
        {sp.checkout === "processing" ? (
          <Alert tone="sky">Your payment is processing. Bank payments can take a few business days to confirm.</Alert>
        ) : null}
        {sp.checkout === "success" ? <Alert tone="emerald">Payment received. Thank you.</Alert> : null}
        {sp.checkout === "extra" ? (
          <Alert tone="amber" title="We received an extra payment">
            This Work Order was already paid or closed, so ForgeX will refund this payment. No action is needed from you.
          </Alert>
        ) : null}
      </div>

      <PageHeader
        eyebrow={
          <>
            {orderRef(order.number)} · {view.org.name}
            {order.isDemo ? " · demo data" : ""}
          </>
        }
        title={order.title}
        actions={<StatusBadge status={order.status} />}
      />
      <div className="mb-6">
        <Alert title="What happens next">{nextStep(order.status, viewer, Boolean(order.assignedBuilderId))}</Alert>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {permissions.editScope ? (
            <ScopeEditor view={view} />
          ) : (
            <ScopeView
              scope={order.scope}
              showEstimate={viewer.isOperator || viewer.isAssignedBuilder || viewer.isInvitedBuilder}
              showQuestions={order.status === "submitted"}
            />
          )}
          <RequestSummary intake={order.intake} showBudget={viewer.isClient || viewer.isOperator} />
          {permissions.reviewDelivery ? <ReviewDeliveryForm view={view} /> : <CriteriaList criteria={view.criteria} showEvidence={reviewed} />}
          {permissions.submitDelivery ? <DeliveryForm view={view} /> : null}
          <Milestones view={view} />
          <DeliveryHistory deliveries={view.deliveries} />
          {viewer.isInvitedBuilder ? null : <Thread view={view} />}
        </div>
        <aside className="space-y-4">
          {viewer.isOperator ? <OpsPanels view={view} builders={builders} inviteToken={inviteToken} /> : null}
          {viewer.isClient ? <ClientPanels view={view} /> : null}
          {viewer.role === "builder" ? <BuilderPanels view={view} /> : null}
          <SummaryCard view={view} />
          {view.timeline.length ? <Timeline timeline={view.timeline} /> : null}
        </aside>
      </div>
    </div>
  );
}
