import { Notification } from "electron";
import type { NotificationState } from "../shared/bridge";

// Windows desktop notifications, sent only by the main process and only after the owner turns them on in
// Settings. The window's own web notification permission is always denied.

export class Notifier {
  private last: NotificationState["last"] = null;
  // Keep each notification referenced until it closes, so its click handler survives garbage collection.
  private readonly live = new Set<Notification>();

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly icon: string | undefined,
    private readonly onChange: () => void,
    private readonly onClick: (target: string | undefined) => void,
  ) {}

  get state(): NotificationState {
    return { supported: Notification.isSupported(), enabled: this.isEnabled(), last: this.last };
  }

  private record(title: string, outcome: NonNullable<NotificationState["last"]>["outcome"], detail: string | null) {
    this.last = { title, at: new Date().toISOString(), outcome, detail };
    this.onChange();
  }

  /** Shows a notification if they are on; `target` names the view a click should open. */
  show(title: string, body: string, target?: string): boolean {
    if (!this.isEnabled() || !Notification.isSupported()) return false;
    const n = new Notification({ title, body, icon: this.icon });
    this.live.add(n);
    n.on("show", () => this.record(title, "shown", null));
    n.on("failed", (_event, error) => this.record(title, "failed", error));
    n.on("click", () => {
      this.record(title, "clicked", null);
      this.onClick(target);
    });
    n.on("close", () => this.live.delete(n));
    this.record(title, "sent", null);
    n.show();
    return true;
  }
}
