import { Briefcase, Building2, ClipboardCheck, Cpu, LayoutDashboard, LogOut, Settings as SettingsIcon, Target, Wrench, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppStatus, View } from "../shared/bridge";
import { BackendBanner, BackendPill, Loading, Logo } from "./components";
import { kelqor } from "./lib";
import { AiOperationsView } from "./views/AiOperations";
import { BusinessView } from "./views/Business";
import { DecisionsView } from "./views/Decisions";
import { CustomersView } from "./views/Customers";
import { EngineeringView } from "./views/Engineering";
import { OpportunitiesView } from "./views/Opportunities";
import { OverviewView } from "./views/Overview";
import { SettingsView } from "./views/Settings";
import { SignInView } from "./views/SignIn";

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: "overview", label: "Headquarters", icon: LayoutDashboard },
  { view: "opportunities", label: "Opportunity Center", icon: Target },
  { view: "business", label: "Business Workspace", icon: Briefcase },
  { view: "customers", label: "Customer Operations", icon: Building2 },
  { view: "ai", label: "AI Operations", icon: Cpu },
  { view: "engineering", label: "Engineering Missions", icon: Wrench },
  { view: "decisions", label: "Owner Decisions", icon: ClipboardCheck },
  { view: "settings", label: "Settings", icon: SettingsIcon },
];

/** What the views share: whether actions may run, a counter that bumps on every reconnect, and navigation. */
export interface ViewProps {
  status: AppStatus;
  online: boolean;
  epoch: number;
  go: (view: View, focus?: { opportunity?: string; order?: string }) => void;
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>("overview");
  const [focus, setFocus] = useState<{ opportunity?: string; order?: string }>({});
  const [epoch, setEpoch] = useState(0);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    void kelqor().status().then(setStatus);
    const offStatus = kelqor().onStatus(setStatus);
    const offNavigate = kelqor().onNavigate((v) => setView(v));
    return () => {
      offStatus();
      offNavigate();
    };
  }, []);

  // Refetch everything shown once the backend comes back.
  useEffect(() => {
    const state = status?.backend.state ?? null;
    if (state === "connected" && previous.current !== "connected") setEpoch((e) => e + 1);
    previous.current = state;
  }, [status?.backend.state]);

  if (!status) return <Loading label="Starting KELQOR…" />;
  if (!status.user) return <SignInView status={status} />;

  const online = status.backend.state === "connected";
  const local = status.localBackend;
  // Until the backend KELQOR starts first answers, say so, rather than show views full of connection errors.
  const waiting = epoch === 0 && !online && (status.backend.state === "checking" || local.state === "starting" || (local.state === "off" && local.autoStart));
  const go: ViewProps["go"] = (v, f = {}) => {
    setFocus(f);
    setView(v);
  };
  const props: ViewProps = { status, online, epoch, go };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-white">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <Logo />
          <div>
            <div className="text-base leading-tight font-bold tracking-wide text-stone-900">KELQOR</div>
            <div className="text-xs text-stone-500">Command Center</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              type="button"
              data-nav={v}
              onClick={() => go(v)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                view === v ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100"
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>
        <div className="space-y-3 border-t border-stone-100 px-4 py-4">
          <BackendPill backend={status.backend} starting={local.state === "starting"} />
          <div className="text-xs text-stone-500">
            Signed in as <span className="font-medium text-stone-800">{status.user.name}</span>
          </div>
          <button type="button" data-action="sign-out" className="fx-btn fx-btn-ghost w-full justify-start px-2 py-1.5 text-xs" onClick={() => void kelqor().signOut()}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>
      <main className="kq-scroll flex-1 bg-stone-50">
        {!online ? (
          <div className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50 px-6 py-3">
            <BackendBanner status={status} />
          </div>
        ) : null}
        <div className="mx-auto max-w-6xl px-6 py-6">
          {waiting ? (
            <div data-testid="waiting-for-backend">
              <Loading label="Waiting for the local backend…" />
            </div>
          ) : (
            <>
              {view === "overview" ? <OverviewView {...props} /> : null}
              {view === "opportunities" ? <OpportunitiesView {...props} initialId={focus.opportunity} /> : null}
              {view === "business" ? <BusinessView {...props} initialOrder={focus.order} /> : null}
              {view === "customers" ? <CustomersView {...props} /> : null}
              {view === "ai" ? <AiOperationsView {...props} /> : null}
              {view === "engineering" ? <EngineeringView {...props} /> : null}
              {view === "decisions" ? <DecisionsView {...props} /> : null}
              {view === "settings" ? <SettingsView {...props} /> : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
