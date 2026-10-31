import type {
  AiOperations,
  CallInputDto,
  CheckInput,
  CompanySummary,
  DecisionRecord,
  DesktopUser,
  FigureInput,
  FigureValidation,
  FounderQueue,
  OpportunityDetail,
  OpportunitySummary,
  OpportunityWorkflow,
  OrderDetail,
  OrderSummary,
  Overview,
} from "@/lib/desktop/types";
import type { DataClass, OpportunityDecision, SolutionRung } from "@/lib/domain/types";
import type { ReconciliationView } from "@/lib/controls";
import type { ApprovalCenter, Capability, MissionOptions, SpendingView } from "@/lib/desktop/ai";
import type { MissionEstimate } from "@/lib/missions/estimate";
import type { MissionAction, MissionInput } from "@/lib/missions/input";
import type { IntelligenceView, ResearchVersionView } from "@/lib/missions/results";
import type { MissionDetail, MissionSummary } from "@/lib/missions/service";
import type { SourceView } from "@/lib/sources/registry";
import type { EngineeringOverview } from "@/lib/desktop/engineering";
import type { CustomerDetail, CustomersOverview } from "@/lib/desktop/customers";
import type { CustomerServiceView, InvoiceView, OperatorRequestView } from "@/lib/services/contract";
import type { EngAction, EngMissionDetail, EngMissionInput, EngWorkspaceView } from "@/lib/engineering/contract";

/** Extra fields some mission actions take: the fingerprint and purpose approved, a reason or note, the reviewer chosen. */
export interface MissionActionInput {
  fingerprint?: string;
  purpose?: string;
  reason?: string;
  note?: string;
  model?: string;
  maxCostMicros?: number;
}

export interface SourceInput {
  name: string;
  match: string;
  kind: SourceView["kind"];
  industries: string[];
  purpose: string;
}

// The only interface the KELQOR window has to the rest of the computer: a fixed set of requests, each checked by
// the main process. The window never sees the session token, the backend address it uses, or any API key.

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; offline: boolean; signedOut: boolean };

export type BackendState = "checking" | "connected" | "disconnected";

export interface BackendStatus {
  state: BackendState;
  url: string;
  checkedAt: string | null;
  error: string | null;
}

export interface NotificationState {
  supported: boolean;
  enabled: boolean;
  last: { title: string; at: string; outcome: "sent" | "shown" | "failed" | "clicked"; detail: string | null } | null;
}

/**
 * The backend KELQOR manages: "off" before it starts, "external" when one was already running (used, never
 * stopped), "starting"/"running" for the one KELQOR started, "stopping"/"stopped" on exit, "failed" with a reason.
 */
export type LocalBackendState = "off" | "external" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface LocalBackendInfo {
  state: LocalBackendState;
  /** True while KELQOR's own backend process is alive, so KELQOR will stop it on exit. */
  managed: boolean;
  projectDir: string;
  logFile: string;
  detail: string | null;
  autoStart: boolean;
}

export interface AppStatus {
  backend: BackendStatus;
  localBackend: LocalBackendInfo;
  user: DesktopUser | null;
  notifications: NotificationState;
  app: { version: string; packaged: boolean; electron: string; dataDir: string; tokenProtected: boolean };
}

/** The owner headquarters' areas; a notification click can open one. */
export const VIEWS = ["overview", "opportunities", "business", "customers", "ai", "engineering", "decisions", "settings"] as const;
export type View = (typeof VIEWS)[number];

export interface KelqorBridge {
  status(): Promise<AppStatus>;
  onStatus(listener: (status: AppStatus) => void): () => void;
  onNavigate(listener: (view: View) => void): () => void;
  checkBackend(): Promise<AppStatus>;
  /** Starts the project's local backend if it isn't running (the same fixed command KELQOR runs at startup). */
  startBackend(): Promise<AppStatus>;
  setAutoStartBackend(enabled: boolean): Promise<AppStatus>;
  signIn(email: string, password: string): Promise<Result<DesktopUser>>;
  signOut(): Promise<Result<null>>;
  overview(): Promise<Result<Overview>>;
  opportunities(): Promise<Result<OpportunitySummary[]>>;
  opportunity(id: string): Promise<Result<OpportunityDetail>>;
  decide(id: string, decision: OpportunityDecision, note: string): Promise<Result<DecisionRecord>>;
  /** Discovery-first workflow on a researched company. Each returns the company's updated workflow. */
  setIndustry(id: string, industry: string | null): Promise<Result<OpportunityWorkflow>>;
  addCheck(id: string, check: CheckInput): Promise<Result<OpportunityWorkflow>>;
  recordCall(id: string, call: CallInputDto): Promise<Result<OpportunityWorkflow>>;
  setSolution(id: string, problemId: string, rung: SolutionRung, solution: string): Promise<Result<OpportunityWorkflow>>;
  /** A financial figure the customer gave in a recorded conversation, and its validation (Milestone 2B). */
  addFigure(id: string, figure: FigureInput): Promise<Result<OpportunityWorkflow>>;
  validateFigure(id: string, figureId: string, validation: FigureValidation): Promise<Result<OpportunityWorkflow>>;
  /** Corrects a company's class (real, demo or test); audited. */
  setCompanyClass(orgId: string, dataClass: DataClass): Promise<Result<{ id: string; dataClass: DataClass }>>;
  orders(): Promise<Result<OrderSummary[]>>;
  order(id: string): Promise<Result<OrderDetail>>;
  companies(): Promise<Result<CompanySummary[]>>;
  founderQueue(): Promise<Result<FounderQueue>>;
  aiOperations(): Promise<Result<AiOperations>>;
  setNotifications(enabled: boolean): Promise<NotificationState>;
  testNotification(): Promise<NotificationState>;
  openWebApp(path: string): Promise<Result<null>>;
  openSource(url: string): Promise<Result<null>>;
  /** AI Operations (Milestone 2B). Every action carries a request id made in the window, so it acts at most once. */
  aiMissions(): Promise<Result<MissionSummary[]>>;
  aiMission(id: string): Promise<Result<MissionDetail>>;
  aiOptions(): Promise<Result<MissionOptions>>;
  aiEstimate(mission: MissionInput): Promise<Result<MissionEstimate>>;
  aiSaveMission(id: string | null, mission: MissionInput, requestId: string): Promise<Result<MissionDetail>>;
  aiMissionAction(id: string, action: MissionAction, requestId: string, input: MissionActionInput): Promise<Result<MissionDetail>>;
  aiReviewEstimate(id: string, model: string): Promise<Result<{ pages: number; inputTokens: number; micros: number | null; priceVersion: string | null }>>;
  aiApprovals(): Promise<Result<ApprovalCenter>>;
  aiSpending(): Promise<Result<SpendingView>>;
  aiReconciliation(provider: string, periodKind: "day" | "month", period: string): Promise<Result<ReconciliationView>>;
  aiRecordFigure(input: { provider: string; periodKind: "day" | "month"; period: string; providerMicros: number; note: string }): Promise<Result<ReconciliationView>>;
  aiRelease(input: { figureId: string; entries: { ledgerId: string; micros: number }[]; note: string }): Promise<Result<ReconciliationView>>;
  aiUnblock(provider: string, note: string): Promise<Result<unknown>>;
  aiSources(): Promise<Result<SourceView[]>>;
  aiAddSource(input: SourceInput): Promise<Result<SourceView>>;
  aiDecideSource(key: string, status: "approved" | "rejected" | "retired", note: string): Promise<Result<SourceView>>;
  aiIntelligence(): Promise<Result<IntelligenceView[]>>;
  aiMarkReviewed(id: string): Promise<Result<IntelligenceView>>;
  aiResearch(): Promise<Result<ResearchVersionView[]>>;
  aiCapabilities(): Promise<Result<Capability[]>>;
  /** Engineering Missions (Milestone 3). Every action carries a request id made in the window, so it acts at most once. */
  engOverview(): Promise<Result<EngineeringOverview>>;
  engMission(id: string): Promise<Result<EngMissionDetail>>;
  engSaveMission(id: string | null, mission: EngMissionInput, requestId: string): Promise<Result<EngMissionDetail>>;
  engMissionAction(id: string, action: EngAction, requestId: string, input: { fingerprint?: string; reason?: string; tree?: string; response?: string }): Promise<Result<EngMissionDetail>>;
  /** Customer AI Operations (Milestone 4). Each change carries a request key made in the window, so it acts once. */
  custOverview(): Promise<Result<CustomersOverview>>;
  custCustomer(orgId: string, period: string): Promise<Result<CustomerDetail>>;
  custRequest(id: string): Promise<Result<OperatorRequestView>>;
  custOnboard(customer: { companyName: string; contactName: string; email: string; industry?: string; dataClass: "real" | "test" }): Promise<Result<{ orgId: string; userId: string; inviteUrl: string }>>;
  custAddService(service: { orgId: string; category: string; planKey: string; name?: string; config?: Record<string, unknown> }, requestKey: string): Promise<Result<CustomerServiceView>>;
  custServiceAction(id: string, action: "activate" | "pause" | "resume" | "end", requestKey: string): Promise<Result<CustomerServiceView>>;
  custConfigure(id: string, config: Record<string, unknown>, requestKey: string): Promise<Result<CustomerServiceView>>;
  custSubmit(request: { serviceId: string; text: string; from?: string; title?: string }, requestKey: string): Promise<Result<OperatorRequestView>>;
  custReview(id: string, review: Record<string, unknown>, requestKey: string): Promise<Result<OperatorRequestView>>;
  custInvoice(orgId: string, period: string, requestKey: string): Promise<Result<InvoiceView>>;
  custInvoiceAction(id: string, action: "issue" | "mark_paid" | "void", requestKey: string): Promise<Result<InvoiceView>>;
  custOffboard(orgId: string, requestKey: string): Promise<Result<{ servicesEnded: number; accountsDisabled: number }>>;
  /** Puts text on the clipboard (Copy Assignment). The window can't read the clipboard. */
  copyText(text: string): Promise<Result<null>>;
  engAddWorkspace(input: { name: string; path: string; baseBranch: string }): Promise<Result<EngWorkspaceView>>;
  engDemoWorkspace(): Promise<Result<EngWorkspaceView>>;
}

/** IPC channel names. One channel per request; there is no general-purpose channel. */
export const CHANNELS = {
  status: "kelqor:status",
  statusChanged: "kelqor:status-changed",
  navigate: "kelqor:navigate",
  checkBackend: "kelqor:check-backend",
  startBackend: "kelqor:start-backend",
  setAutoStartBackend: "kelqor:set-auto-start-backend",
  signIn: "kelqor:sign-in",
  signOut: "kelqor:sign-out",
  overview: "kelqor:overview",
  opportunities: "kelqor:opportunities",
  opportunity: "kelqor:opportunity",
  decide: "kelqor:decide",
  setIndustry: "kelqor:set-industry",
  addCheck: "kelqor:add-check",
  recordCall: "kelqor:record-call",
  setSolution: "kelqor:set-solution",
  addFigure: "kelqor:add-figure",
  validateFigure: "kelqor:validate-figure",
  setCompanyClass: "kelqor:set-company-class",
  orders: "kelqor:orders",
  order: "kelqor:order",
  companies: "kelqor:companies",
  founderQueue: "kelqor:founder-queue",
  aiOperations: "kelqor:ai-operations",
  setNotifications: "kelqor:set-notifications",
  testNotification: "kelqor:test-notification",
  openWebApp: "kelqor:open-web-app",
  openSource: "kelqor:open-source",
  aiMissions: "kelqor:ai-missions",
  aiMission: "kelqor:ai-mission",
  aiOptions: "kelqor:ai-options",
  aiEstimate: "kelqor:ai-estimate",
  aiSaveMission: "kelqor:ai-save-mission",
  aiMissionAction: "kelqor:ai-mission-action",
  aiReviewEstimate: "kelqor:ai-review-estimate",
  aiApprovals: "kelqor:ai-approvals",
  aiSpending: "kelqor:ai-spending",
  aiReconciliation: "kelqor:ai-reconciliation",
  aiRecordFigure: "kelqor:ai-record-figure",
  aiRelease: "kelqor:ai-release",
  aiUnblock: "kelqor:ai-unblock",
  aiSources: "kelqor:ai-sources",
  aiAddSource: "kelqor:ai-add-source",
  aiDecideSource: "kelqor:ai-decide-source",
  aiIntelligence: "kelqor:ai-intelligence",
  aiMarkReviewed: "kelqor:ai-mark-reviewed",
  aiResearch: "kelqor:ai-research",
  aiCapabilities: "kelqor:ai-capabilities",
  engOverview: "kelqor:eng-overview",
  engMission: "kelqor:eng-mission",
  engSaveMission: "kelqor:eng-save-mission",
  engMissionAction: "kelqor:eng-mission-action",
  engAddWorkspace: "kelqor:eng-add-workspace",
  engDemoWorkspace: "kelqor:eng-demo-workspace",
  copyText: "kelqor:copy-text",
  custOverview: "kelqor:cust-overview",
  custCustomer: "kelqor:cust-customer",
  custRequest: "kelqor:cust-request",
  custOnboard: "kelqor:cust-onboard",
  custAddService: "kelqor:cust-add-service",
  custServiceAction: "kelqor:cust-service-action",
  custConfigure: "kelqor:cust-configure",
  custSubmit: "kelqor:cust-submit",
  custReview: "kelqor:cust-review",
  custInvoice: "kelqor:cust-invoice",
  custInvoiceAction: "kelqor:cust-invoice-action",
  custOffboard: "kelqor:cust-offboard",
} as const;
