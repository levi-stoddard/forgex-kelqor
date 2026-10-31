import Link from "next/link";
import type { ReactNode } from "react";
import { STATUS_LABELS, type WorkOrderStatus } from "@/lib/domain/types";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-xs font-semibold tracking-wide text-ember-700 uppercase">{eyebrow}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-stone-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`fx-card ${className}`}>
      {title || actions ? (
        <div className="flex items-start justify-between gap-3 border-b border-stone-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold text-stone-900">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-stone-500">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: "bg-stone-100 text-stone-700 ring-stone-200",
  ember: "bg-ember-50 text-ember-800 ring-ember-200",
  sky: "bg-sky-50 text-sky-800 ring-sky-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  teal: "bg-teal-50 text-teal-800 ring-teal-200",
  blue: "bg-blue-50 text-blue-800 ring-blue-200",
  indigo: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  rose: "bg-rose-50 text-rose-800 ring-rose-200",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<WorkOrderStatus, Tone> = {
  submitted: "sky",
  quoted: "violet",
  accepted: "amber",
  funded: "teal",
  in_progress: "blue",
  delivered: "indigo",
  completed: "emerald",
  cancelled: "neutral",
  disputed: "rose",
};

export function StatusBadge({ status }: { status: WorkOrderStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  return (
    <Link href={href} className={`fx-btn fx-btn-${variant} ${className}`}>
      {children}
    </Link>
  );
}

export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label className="fx-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="fx-hint">{hint}</p> : null}
    </div>
  );
}

export function Alert({ tone = "neutral", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${TONES[tone]}`}>
      {title ? <div className="font-semibold">{title}</div> : null}
      {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-stone-800">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-stone-500">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="fx-card px-4 py-3">
      <div className="text-xs font-medium text-stone-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-stone-900 tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-stone-500">{hint}</div> : null}
    </div>
  );
}

export function BulletList({ items, empty = "None." }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-stone-500">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700 marker:text-stone-400">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-stone-100 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-stone-500">{k}</dt>
          <dd className="text-right font-medium text-stone-900 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
