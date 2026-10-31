import { Bell, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, Card, KeyValue, PageHeader } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { LocalBackendState } from "../../shared/bridge";
import type { ViewProps } from "../App";

const LOCAL_STATE: Record<LocalBackendState, string> = {
  off: "Not started by KELQOR",
  external: "Was already running: KELQOR uses it and leaves it running",
  starting: "Starting…",
  running: "Started by KELQOR: it stops when you exit",
  stopping: "Stopping…",
  stopped: "Stopped",
  failed: "Couldn't start",
};
import { BackendPill } from "../components";
import { kelqor } from "../lib";

export function SettingsView({ status }: ViewProps) {
  // The main process broadcasts every change (the toggles, each notification's outcome), so this stays live.
  const current = status.notifications;
  const local = status.localBackend;

  return (
    <div data-view="settings">
      <PageHeader eyebrow="Settings" title="This computer" description="Settings live in KELQOR's own data folder on this PC." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Desktop notifications" description="Windows notifications when the local backend disconnects or reconnects, and when new items need your decision.">
          {!current.supported ? <Alert tone="amber">Windows notifications aren't available on this computer.</Alert> : null}
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              data-setting="notifications"
              className="size-4 accent-ember-600"
              checked={current.enabled}
              disabled={!current.supported}
              onChange={(e) => void kelqor().setNotifications(e.target.checked)}
            />
            Allow KELQOR to show desktop notifications
          </label>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" data-action="test-notification" className="fx-btn fx-btn-secondary px-3 py-1.5 text-xs" disabled={!current.enabled} onClick={() => void kelqor().testNotification()}>
              <Bell size={13} /> Send a test notification
            </button>
          </div>
          <p className="mt-3 text-xs text-stone-500" data-testid="last-notification" data-outcome={current.last?.outcome ?? "none"}>
            {current.last ? `Last: "${current.last.title}" · ${current.last.outcome}${current.last.detail ? ` (${current.last.detail})` : ""} · ${dateTime(current.last.at)}` : "No notification sent yet."}
          </p>
          <p className="mt-1 text-xs text-stone-500">Windows can also silence KELQOR in Settings › System › Notifications.</p>
        </Card>
        <Card title="Local backend" description="The existing ForgeX application on this computer, the system of record. It listens on this computer only.">
          <div className="mb-3 flex items-center gap-2">
            <BackendPill backend={status.backend} starting={local.state === "starting"} />
            <span className="text-xs text-stone-600" data-testid="local-backend-state" data-state={local.state} data-managed={String(local.managed)}>
              {LOCAL_STATE[local.state]}
            </span>
          </div>
          <KeyValue
            rows={[
              ["Address", status.backend.url],
              ["Project folder", local.projectDir],
              ["Log", local.logFile],
              ["Last check", dateTime(status.backend.checkedAt)],
              ["Problem", (local.state === "failed" ? local.detail : status.backend.error) ?? "None"],
            ]}
          />
          <label className="mt-3 flex items-center gap-3 text-sm">
            <input type="checkbox" data-setting="auto-start-backend" className="size-4 accent-ember-600" checked={local.autoStart} onChange={(e) => void kelqor().setAutoStartBackend(e.target.checked)} />
            Start the backend when KELQOR opens, and stop it when KELQOR exits
          </label>
          <div className="mt-3 flex gap-2">
            {status.backend.state !== "connected" && local.state !== "starting" ? (
              <button type="button" className="fx-btn fx-btn-primary px-3 py-1.5 text-xs" onClick={() => void kelqor().startBackend()}>
                <Play size={13} /> Start the backend
              </button>
            ) : null}
            <button type="button" className="fx-btn fx-btn-secondary px-3 py-1.5 text-xs" onClick={() => void kelqor().checkBackend()}>
              <RefreshCw size={13} /> Check now
            </button>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            KELQOR stops only a backend it started. To run one yourself instead, turn this off and use <code>npm run desktop:backend</code> in the project
            folder.
          </p>
        </Card>
        <Card title="Session">
          <KeyValue
            rows={[
              ["Signed in as", status.user ? `${status.user.name} (${status.user.email})` : "—"],
              ["Session token", status.app.tokenProtected ? "Encrypted by Windows, held by the app only" : "Kept in memory only (Windows encryption unavailable)"],
            ]}
          />
          <p className="mt-3 flex items-center gap-1.5 text-xs text-stone-500">
            <ShieldCheck size={13} /> The interface never sees the token, API keys or the file system.
          </p>
        </Card>
        <Card title="About">
          <KeyValue
            rows={[
              ["Version", `KELQOR ${status.app.version} (${status.app.packaged ? "installed build" : "development run"})`],
              ["Electron", status.app.electron],
              ["App data", status.app.dataDir],
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
