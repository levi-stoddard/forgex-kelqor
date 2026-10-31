import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui";
import type { OrderListItem } from "@/lib/domain/orders";
import { orderRef } from "@/lib/domain/records";
import { date, money } from "@/lib/format";

export function OrdersTable({
  orders,
  amount,
  showCompany = false,
}: {
  orders: OrderListItem[];
  amount: "price" | "payout";
  showCompany?: boolean;
}) {
  return (
    <div className="fx-card overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="border-b border-stone-200 text-xs text-stone-500">
          <tr>
            <th className="px-4 py-2 font-medium">Work Order</th>
            {showCompany ? <th className="px-4 py-2 font-medium">Client</th> : null}
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">{amount === "price" ? "Price" : "Payout"}</th>
            <th className="px-4 py-2 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {orders.map((o) => (
            <tr key={o.id} className="hover:bg-stone-50">
              <td className="px-4 py-2.5">
                <Link href={`/orders/${o.id}`} className="font-medium text-stone-900 hover:text-ember-700">
                  {o.title}
                </Link>
                <div className="text-xs text-stone-500">
                  {orderRef(o.number)}
                  {o.isDemo ? " · demo" : ""}
                </div>
              </td>
              {showCompany ? <td className="px-4 py-2.5 text-stone-700">{o.orgName}</td> : null}
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  <StatusBadge status={o.status} />
                  {o.invited ? <Badge tone="ember">Invitation</Badge> : null}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(amount === "price" ? o.priceCents : o.builderPayoutCents)}</td>
              <td className="px-4 py-2.5 text-right text-stone-500">{date(o.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
