import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { DesktopUser, SessionGrant } from "@/lib/desktop/types";
import { DATA_CLASSES, DECISION_MAKER_ANSWERS, OPPORTUNITY_DECISIONS, PROBLEM_STATUSES, SOLUTION_RUNGS } from "@/lib/domain/types";
import { PROVIDERS, SOURCE_KINDS } from "@/lib/missions/contract";
import { MISSION_ACTIONS, MissionInput } from "@/lib/missions/input";
import { CHECK_COMMAND_IDS, ENG_ACTIONS, ENG_AGENTS, RESPONSE_MAX_CHARS } from "@/lib/engineering/contract";
import { CHANNELS, type AppStatus, type NotificationState, type Result } from "../shared/bridge";
import type { Backend } from "./backend";
import type { LocalBackend } from "./local-backend";
import type { Notifier } from "./notifications";
import { APP_ORIGIN, isHttpUrl, isWebAppPath } from "./security";
import type { Store } from "./store";

// Every request the window can make. Each has its own channel and argument schema, comes only from the KELQOR
// window, and maps to one narrow action: a desktop API call, a settings change, or opening an approved page.

interface Deps {
  backend: Backend;
  localBackend: LocalBackend;
  store: Store;
  notifier: Notifier;
  window: () => BrowserWindow | null;
  status: () => AppStatus;
  broadcast: () => void;
}

const RecordId = z.string().regex(/^(c\d{2}|n\d{4})$/);
const Uuid = z.string().regex(/^[0-9a-f-]{36}$/);
const Period = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/);
const OrderId = z.string().regex(/^[0-9a-f-]{36}$/);
const NONE = z.tuple([]);
const refused = <T>(): Result<T> => ({ ok: false, error: "That request isn't allowed.", offline: false, signedOut: false });

export function registerIpc(d: Deps): void {
  const trusted = (e: IpcMainInvokeEvent) => {
    const win = d.window();
    return Boolean(win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame?.url.startsWith(`${APP_ORIGIN}/`));
  };

  function handle<S extends z.ZodType<unknown[]>, R>(channel: string, args: S, run: (parsed: z.infer<S>) => Promise<R> | R, fallback: () => R) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      if (!trusted(event)) return fallback();
      const parsed = args.safeParse(raw);
      return parsed.success ? run(parsed.data as z.infer<S>) : fallback();
    });
  }

  const get = (channel: string, route: string) => handle(channel, NONE, () => d.backend.call("GET", route), refused);
  const notifications = (): NotificationState => d.notifier.state;

  handle(CHANNELS.status, NONE, () => d.status(), d.status);
  handle(CHANNELS.checkBackend, NONE, async () => (await d.backend.check(), d.status()), d.status);
  // Runs only the fixed backend command for the validated project folder; the window supplies no arguments.
  handle(
    CHANNELS.startBackend,
    NONE,
    () => {
      void d.localBackend.start().then(() => d.backend.check());
      return d.status();
    },
    d.status,
  );
  handle(
    CHANNELS.setAutoStartBackend,
    z.tuple([z.boolean()]),
    ([enabled]) => {
      d.store.update({ autoStartBackend: enabled });
      d.broadcast();
      return d.status();
    },
    d.status,
  );

  handle(
    CHANNELS.signIn,
    z.tuple([z.string().min(3).max(320), z.string().min(1).max(200)]),
    async ([email, password]): Promise<Result<DesktopUser>> => {
      const res = await d.backend.call<SessionGrant>("POST", "session", { email, password }, { auth: false });
      if (!res.ok) return res;
      d.store.setToken(res.data.token);
      d.store.update({ user: res.data.user });
      d.broadcast();
      return { ok: true, data: res.data.user };
    },
    refused,
  );

  handle(
    CHANNELS.signOut,
    NONE,
    async (): Promise<Result<null>> => {
      if (d.store.getToken()) await d.backend.call("DELETE", "session");
      d.store.clearToken();
      d.store.update({ user: null });
      d.broadcast();
      return { ok: true, data: null };
    },
    refused,
  );

  get(CHANNELS.overview, "overview");
  get(CHANNELS.opportunities, "opportunities");
  get(CHANNELS.orders, "orders");
  get(CHANNELS.companies, "companies");
  get(CHANNELS.founderQueue, "decisions");
  get(CHANNELS.aiOperations, "ai");
  handle(CHANNELS.opportunity, z.tuple([RecordId]), ([id]) => d.backend.call("GET", `opportunities/${id}`), refused);
  handle(CHANNELS.order, z.tuple([OrderId]), ([id]) => d.backend.call("GET", `orders/${id}`), refused);
  handle(
    CHANNELS.decide,
    z.tuple([RecordId, z.enum(OPPORTUNITY_DECISIONS), z.string().max(2000)]),
    ([id, decision, note]) => d.backend.call("PUT", `opportunities/${id}/decision`, { decision, note }),
    refused,
  );

  // Discovery-first workflow. The same limits as the backend's own checks, so a malformed request never leaves here.
  const text = (max: number) => z.string().max(max);
  handle(CHANNELS.setIndustry, z.tuple([RecordId, z.string().max(100).nullable()]), ([id, industry]) => d.backend.call("PUT", `opportunities/${id}/industry`, { industry }), refused);
  handle(
    CHANNELS.addCheck,
    z.tuple([RecordId, z.strictObject({ statement: text(1000), sourceUrl: text(2000), checkedOn: text(10), note: text(2000) })]),
    ([id, check]) => d.backend.call("POST", `opportunities/${id}/checks`, check),
    refused,
  );
  handle(
    CHANNELS.recordCall,
    z.tuple([
      RecordId,
      z.strictObject({
        heldOn: text(10),
        contactName: text(200),
        contactRole: text(200),
        decisionMaker: z.enum(DECISION_MAKER_ANSWERS),
        software: text(2000),
        priorities: text(2000),
        desiredOutcome: text(2000),
        valueToThem: text(2000),
        tried: text(2000),
        pain: z.number().int().min(0).max(3).nullable(),
        nextStep: text(1000),
        notes: text(4000),
        answers: z.record(z.string().regex(/^[a-z0-9-]{2,40}$/), text(2000)),
        problems: z.array(text(1000)).max(10),
        findings: z.array(z.strictObject({ key: z.string().regex(/^[a-zA-Z]+\.\d{1,3}$/), status: z.enum(PROBLEM_STATUSES) })).max(40),
      }),
    ]),
    ([id, call]) => d.backend.call("POST", `opportunities/${id}/calls`, call),
    refused,
  );
  handle(
    CHANNELS.setSolution,
    z.tuple([RecordId, OrderId, z.enum(SOLUTION_RUNGS), text(2000)]),
    ([id, problemId, rung, solution]) => d.backend.call("PUT", `opportunities/${id}/problems/${problemId}/solution`, { rung, solution }),
    refused,
  );
  handle(
    CHANNELS.addFigure,
    z.tuple([RecordId, z.strictObject({ callId: Uuid, statement: text(500), amountCents: z.number().int().min(0).max(10_000_000_000), period: text(60), basis: text(1000) })]),
    ([id, figure]) => d.backend.call("POST", `opportunities/${id}/figures`, figure),
    refused,
  );
  handle(
    CHANNELS.validateFigure,
    z.tuple([RecordId, Uuid, z.strictObject({ validatedCents: z.number().int().min(0).max(10_000_000_000), calculation: text(2000), evidence: text(2000) })]),
    ([id, figureId, validation]) => d.backend.call("PUT", `opportunities/${id}/figures/${figureId}/validation`, validation),
    refused,
  );
  handle(CHANNELS.setCompanyClass, z.tuple([OrderId, z.enum(DATA_CLASSES)]), ([orgId, dataClass]) => d.backend.call("PUT", `companies/${orgId}/class`, { dataClass }), refused);

  // AI Operations (Milestone 2B). The window can only ask; the backend decides who may approve or spend.
  get(CHANNELS.aiMissions, "ai/missions");
  get(CHANNELS.aiOptions, "ai/options");
  get(CHANNELS.aiApprovals, "ai/approvals");
  get(CHANNELS.aiSpending, "ai/spending");
  get(CHANNELS.aiSources, "ai/sources");
  get(CHANNELS.aiIntelligence, "ai/intelligence");
  get(CHANNELS.aiResearch, "ai/research");
  get(CHANNELS.aiCapabilities, "ai/capabilities");

  // Engineering Missions (Milestone 3). The window can only ask; the backend decides who may approve, start or apply.
  const EngMission = z.strictObject({
    title: text(120),
    task: text(8000),
    deliverables: text(4000),
    workspaceId: Uuid,
    agent: z.enum(ENG_AGENTS),
    permissions: z.strictObject({ editFiles: z.boolean(), checks: z.array(z.enum(CHECK_COMMAND_IDS as [string, ...string[]])).max(4) }),
  });
  get(CHANNELS.engOverview, "eng");
  handle(CHANNELS.engMission, z.tuple([Uuid]), ([id]) => d.backend.call("GET", `eng/missions/${id}`), refused);
  handle(
    CHANNELS.engSaveMission,
    z.tuple([Uuid.nullable(), EngMission, Uuid]),
    ([id, mission, requestId]) => (id ? d.backend.call("PUT", `eng/missions/${id}`, { mission, requestId }) : d.backend.call("POST", "eng/missions", { mission, requestId })),
    refused,
  );
  handle(
    CHANNELS.engMissionAction,
    z.tuple([Uuid, z.enum(ENG_ACTIONS), Uuid, z.strictObject({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(), reason: text(2000).optional(), tree: z.string().regex(/^[0-9a-f]{40}$/).optional(), response: text(RESPONSE_MAX_CHARS * 2).optional() })]),
    ([id, action, requestId, input]) => d.backend.call("POST", `eng/missions/${id}/${action}`, { requestId, ...input }),
    refused,
  );
  handle(CHANNELS.engAddWorkspace, z.tuple([z.strictObject({ name: text(80), path: text(500), baseBranch: text(200) })]), ([input]) => d.backend.call("POST", "eng/workspaces", input), refused);
  handle(CHANNELS.engDemoWorkspace, NONE, () => d.backend.call("POST", "eng/workspaces/demo", {}), refused);
  // Customer AI Operations (Milestone 4). Shapes are checked here; the backend checks every rule again.
  const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
  const Payload = z.record(z.string().max(60), z.unknown());
  get(CHANNELS.custOverview, "cust");
  handle(CHANNELS.custCustomer, z.tuple([Uuid, Month]), ([orgId, period]) => d.backend.call("GET", `cust/orgs/${orgId}/${period}`), refused);
  handle(CHANNELS.custRequest, z.tuple([Uuid]), ([id]) => d.backend.call("GET", `cust/requests/${id}`), refused);
  handle(CHANNELS.custOnboard, z.tuple([z.strictObject({ companyName: text(120), contactName: text(120), email: text(200), industry: text(80).optional(), dataClass: z.enum(["real", "test"]) })]), ([customer]) => d.backend.call("POST", "cust/onboard", { customer }), refused);
  handle(CHANNELS.custAddService, z.tuple([Payload, Uuid]), ([service, requestKey]) => d.backend.call("POST", "cust/services", { service, requestKey }), refused);
  handle(CHANNELS.custServiceAction, z.tuple([Uuid, z.enum(["activate", "pause", "resume", "end"]), Uuid]), ([id, action, requestKey]) => d.backend.call("POST", `cust/services/${id}/${action}`, { requestKey }), refused);
  handle(CHANNELS.custConfigure, z.tuple([Uuid, Payload, Uuid]), ([id, config, requestKey]) => d.backend.call("PUT", `cust/services/${id}/config`, { config, requestKey }), refused);
  handle(CHANNELS.custSubmit, z.tuple([Payload, Uuid]), ([request, requestKey]) => d.backend.call("POST", "cust/requests", { request, requestKey }), refused);
  handle(CHANNELS.custReview, z.tuple([Uuid, Payload, Uuid]), ([id, review, requestKey]) => d.backend.call("POST", `cust/requests/${id}/review`, { review, requestKey }), refused);
  handle(CHANNELS.custInvoice, z.tuple([Uuid, Month, Uuid]), ([orgId, period, requestKey]) => d.backend.call("POST", "cust/invoices", { orgId, period, requestKey }), refused);
  handle(CHANNELS.custInvoiceAction, z.tuple([Uuid, z.enum(["issue", "mark_paid", "void"]), Uuid]), ([id, action, requestKey]) => d.backend.call("POST", `cust/invoices/${id}/${action}`, { requestKey }), refused);
  handle(CHANNELS.custOffboard, z.tuple([Uuid, Uuid]), ([orgId, requestKey]) => d.backend.call("POST", `cust/orgs/${orgId}/offboard`, { requestKey }), refused);
  // Copy Assignment: the window may put text on the clipboard (never read it), up to a fixed size.
  handle(
    CHANNELS.copyText,
    z.tuple([text(60_000)]),
    ([value]): Result<null> => {
      clipboard.writeText(value);
      return { ok: true, data: null };
    },
    refused,
  );
  handle(CHANNELS.aiMission, z.tuple([Uuid]), ([id]) => d.backend.call("GET", `ai/missions/${id}`), refused);
  handle(CHANNELS.aiReviewEstimate, z.tuple([Uuid, z.string().regex(/^[a-z0-9.-]{3,60}$/)]), ([id, model]) => d.backend.call("GET", `ai/missions/${id}/review-estimate/${model}`), refused);
  handle(CHANNELS.aiEstimate, z.tuple([MissionInput]), ([mission]) => d.backend.call("POST", "ai/estimate", { mission }), refused);
  handle(
    CHANNELS.aiSaveMission,
    z.tuple([Uuid.nullable(), MissionInput, Uuid]),
    ([id, mission, requestId]) => (id ? d.backend.call("PUT", `ai/missions/${id}`, { mission, requestId }) : d.backend.call("POST", "ai/missions", { mission, requestId })),
    refused,
  );
  handle(
    CHANNELS.aiMissionAction,
    z.tuple([
      Uuid,
      z.enum(MISSION_ACTIONS),
      Uuid,
      z.strictObject({
        fingerprint: z.string().regex(/^[0-9a-f]{16,128}$/).optional(),
        purpose: z.string().max(1000).optional(),
        reason: text(2000).optional(),
        note: text(2000).optional(),
        model: text(60).optional(),
        maxCostMicros: z.number().int().min(1).max(2_000_000).optional(),
      }),
    ]),
    ([id, action, requestId, input]) => d.backend.call("POST", `ai/missions/${id}/${action}`, { requestId, ...input }),
    refused,
  );
  handle(
    CHANNELS.aiReconciliation,
    z.tuple([z.enum(PROVIDERS), z.enum(["day", "month"]), Period]),
    ([provider, kind, period]) => d.backend.call("GET", `ai/reconciliation/${provider}/${kind}/${period}`),
    refused,
  );
  handle(
    CHANNELS.aiRecordFigure,
    z.tuple([z.strictObject({ provider: z.enum(PROVIDERS), periodKind: z.enum(["day", "month"]), period: Period, providerMicros: z.number().int().min(0).max(1_000_000_000), note: text(2000) })]),
    ([input]) => d.backend.call("POST", "ai/reconciliation/figure", input),
    refused,
  );
  handle(
    CHANNELS.aiRelease,
    z.tuple([z.strictObject({ figureId: Uuid, entries: z.array(z.strictObject({ ledgerId: Uuid, micros: z.number().int().min(1) })).min(1).max(200), note: text(2000) })]),
    ([input]) => d.backend.call("POST", "ai/reconciliation/release", input),
    refused,
  );
  handle(CHANNELS.aiUnblock, z.tuple([z.enum(PROVIDERS), text(2000)]), ([provider, note]) => d.backend.call("POST", "ai/reconciliation/unblock", { provider, note }), refused);
  handle(
    CHANNELS.aiAddSource,
    z.tuple([z.strictObject({ name: text(200), match: text(300), kind: z.enum(SOURCE_KINDS), industries: z.array(text(100)).max(20), purpose: text(500) })]),
    ([input]) => d.backend.call("POST", "ai/sources", input),
    refused,
  );
  handle(
    CHANNELS.aiDecideSource,
    z.tuple([z.string().regex(/^[a-z0-9-]{2,60}$/), z.enum(["approved", "rejected", "retired"]), text(1000)]),
    ([key, status, note]) => d.backend.call("PUT", `ai/sources/${key}`, { status, note }),
    refused,
  );
  handle(CHANNELS.aiMarkReviewed, z.tuple([Uuid]), ([id]) => d.backend.call("POST", `ai/intelligence/${id}/review`, {}), refused);

  handle(
    CHANNELS.setNotifications,
    z.tuple([z.boolean()]),
    ([enabled]) => {
      d.store.update({ notificationsEnabled: enabled });
      d.broadcast();
      return notifications();
    },
    notifications,
  );
  handle(
    CHANNELS.testNotification,
    NONE,
    () => {
      d.notifier.show("KELQOR notifications are on", "You'll be told when the local backend disconnects and when new items need your decision.", "settings");
      return notifications();
    },
    notifications,
  );

  handle(
    CHANNELS.openWebApp,
    z.tuple([z.string().max(500)]),
    async ([path]): Promise<Result<null>> => {
      if (!isWebAppPath(path)) return refused();
      await shell.openExternal(`${d.backend.url}${path}`);
      return { ok: true, data: null };
    },
    refused,
  );
  handle(
    CHANNELS.openSource,
    z.tuple([z.string().max(2000)]),
    async ([url]): Promise<Result<null>> => {
      const win = d.window();
      if (!isHttpUrl(url) || !win) return refused();
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Open in browser", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: "Open a web page",
        message: "Open this page in your web browser?",
        detail: url,
      });
      if (response === 0) await shell.openExternal(url);
      return { ok: true, data: null };
    },
    refused,
  );
}
