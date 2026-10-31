import { CircleAlert, LoaderCircle, Play, RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, Badge, type Tone } from "@/components/ui";
import type { EvidenceStatus, Fixture } from "@/lib/desktop/types";
import type { AppStatus, BackendStatus, Result } from "../shared/bridge";
import { kelqor } from "./lib";

/**
 * The backend's state in one place: starting (KELQOR is bringing it up), or unavailable with the reason and a way to
 * start it. Renders nothing while connected.
 */
export function BackendBanner({ status }: { status: AppStatus }) {
  const local = status.localBackend;
  if (local.state === "starting")
    return (
      <div data-testid="starting-banner">
        <Alert tone="sky" title="Starting the local backend…">
          <span className="flex items-center gap-1.5">
            <LoaderCircle size={14} className="animate-spin" /> KELQOR starts it from {local.projectDir} and stops it when you exit. The first start can take up to a minute.
          </span>
        </Alert>
      </div>
    );
  if (status.backend.state === "connected" || status.backend.state === "checking") return null;
  const canStart = local.state !== "stopping";
  return (
    <div data-testid="offline-banner">
      <Alert tone="rose" title="The local backend is unavailable">
        <div className="flex items-start justify-between gap-4">
          <span>
            {local.state === "failed" && local.detail ? local.detail : (status.backend.error ?? "KELQOR can't reach the backend.")} Decisions and other changes are paused until
            it reconnects.
            {local.autoStart ? null : (
              <>
                {" "}
                Automatic start is off; you can also run <code className="rounded bg-white/70 px-1">npm run desktop:backend</code> in{" "}
                <code className="rounded bg-white/70 px-1">{local.projectDir}</code>.
              </>
            )}
          </span>
          <span className="flex shrink-0 gap-2">
            {canStart ? (
              <button type="button" data-action="start-backend" className="fx-btn fx-btn-primary px-3 py-1 text-xs" onClick={() => void kelqor().startBackend()}>
                <Play size={13} /> Start the backend
              </button>
            ) : null}
            <button type="button" className="fx-btn fx-btn-secondary px-3 py-1 text-xs" onClick={() => void kelqor().checkBackend()}>
              <RefreshCw size={13} /> Check now
            </button>
          </span>
        </div>
      </Alert>
    </div>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-stone-900" />
      <path d="M10 8h3.2v6.6L19 8h3.9l-6.3 7.2L23.2 24h-4l-4.9-6.6-1.1 1.2V24H10z" className="fill-ember-500" />
    </svg>
  );
}

export function BackendPill({ backend, starting = false }: { backend: BackendStatus; starting?: boolean }) {
  if (backend.state === "connected")
    return (
      <span data-testid="backend-state" data-state="connected" className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 ring-inset">
        <Wifi size={13} /> Backend connected
      </span>
    );
  if (starting)
    return (
      <span data-testid="backend-state" data-state="starting" className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
        <LoaderCircle size={13} className="animate-spin" /> Starting backend
      </span>
    );
  if (backend.state === "disconnected")
    return (
      <span data-testid="backend-state" data-state="disconnected" className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 ring-1 ring-rose-200 ring-inset">
        <WifiOff size={13} /> Backend disconnected
      </span>
    );
  return (
    <span data-testid="backend-state" data-state="checking" className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
      <LoaderCircle size={13} className="animate-spin" /> Checking backend
    </span>
  );
}

const EVIDENCE: Record<EvidenceStatus, { tone: Tone; label: string; hint: string }> = {
  verified: { tone: "emerald", label: "Fact · quote verified", hint: "The quote was found on the cited page when it was read." },
  "verified-in-details": { tone: "emerald", label: "Fact · verified in page details", hint: "Found in the cited page's links, scripts or contact details." },
  "on-another-page": { tone: "amber", label: "Fact · quote on another page", hint: "The quote is real but sits on a different page than the one cited." },
  "not-confirmed": { tone: "rose", label: "Unverified · quote not found", hint: "The run-time check couldn't find this quote on the page cited, so this isn't verified. Don't present it as fact without checking it yourself." },
  inference: { tone: "sky", label: "Inference", hint: "A conclusion drawn from facts on the site, not stated there." },
  hypothesis: { tone: "neutral", label: "Hypothesis · unsupported", hint: "Not supported by anything read. Treat as a question to ask." },
};

export function EvidenceBadge({ status }: { status: EvidenceStatus }) {
  const e = EVIDENCE[status];
  return (
    <span title={e.hint} data-evidence={status}>
      <Badge tone={e.tone}>{e.label}</Badge>
    </span>
  );
}

/** Labels seeded demo records and hand-made "(test)" records, which never count as real business. */
export function FixtureBadge({ fixture }: { fixture: Fixture }) {
  if (!fixture) return null;
  return (
    <span data-fixture={fixture} title={fixture === "demo" ? "Seeded demonstration data, not a real customer or payment" : "A test record made by hand (its company is named “(test)”), not a real customer"}>
      <Badge tone="amber">{fixture === "demo" ? "Demo data" : "Test data"}</Badge>
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-stone-500">
      <LoaderCircle size={16} className="animate-spin" /> {label}
    </div>
  );
}

/** Shows why a request failed: the backend being unreachable is said plainly, and nothing is retried silently. */
export function Failure({ result, onRetry }: { result: Result<unknown>; onRetry?: () => void }) {
  if (result.ok) return null;
  return (
    <Alert tone="rose" title={result.offline ? "The local backend is unavailable" : "This couldn't be loaded"}>
      <div className="flex items-start justify-between gap-4">
        <span className="flex items-center gap-1.5">
          <CircleAlert size={14} /> {result.error}
        </span>
        {onRetry ? (
          <button type="button" className="fx-btn fx-btn-secondary shrink-0 px-3 py-1 text-xs" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </Alert>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-6 mb-2 flex items-baseline justify-between gap-3">
      <h3 className="text-sm font-semibold tracking-wide text-stone-500 uppercase">{children}</h3>
      {aside}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-stone-500">{children}</p>;
}
