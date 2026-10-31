import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type AppStatus, type KelqorBridge, type View } from "../shared/bridge";

// Exposes window.kelqor: the fixed list of requests in shared/bridge.ts and nothing else. No ipcRenderer, Node
// module or general-purpose channel reaches the page.

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: KelqorBridge = {
  status: () => invoke(CHANNELS.status),
  onStatus: (listener) => subscribe<AppStatus>(CHANNELS.statusChanged, listener),
  onNavigate: (listener) => subscribe<View>(CHANNELS.navigate, listener),
  checkBackend: () => invoke(CHANNELS.checkBackend),
  startBackend: () => invoke(CHANNELS.startBackend),
  setAutoStartBackend: (enabled) => invoke(CHANNELS.setAutoStartBackend, enabled),
  signIn: (email, password) => invoke(CHANNELS.signIn, email, password),
  signOut: () => invoke(CHANNELS.signOut),
  overview: () => invoke(CHANNELS.overview),
  opportunities: () => invoke(CHANNELS.opportunities),
  opportunity: (id) => invoke(CHANNELS.opportunity, id),
  decide: (id, decision, note) => invoke(CHANNELS.decide, id, decision, note),
  setIndustry: (id, industry) => invoke(CHANNELS.setIndustry, id, industry),
  addCheck: (id, check) => invoke(CHANNELS.addCheck, id, check),
  recordCall: (id, call) => invoke(CHANNELS.recordCall, id, call),
  setSolution: (id, problemId, rung, solution) => invoke(CHANNELS.setSolution, id, problemId, rung, solution),
  addFigure: (id, figure) => invoke(CHANNELS.addFigure, id, figure),
  validateFigure: (id, figureId, validation) => invoke(CHANNELS.validateFigure, id, figureId, validation),
  setCompanyClass: (orgId, dataClass) => invoke(CHANNELS.setCompanyClass, orgId, dataClass),
  orders: () => invoke(CHANNELS.orders),
  order: (id) => invoke(CHANNELS.order, id),
  companies: () => invoke(CHANNELS.companies),
  founderQueue: () => invoke(CHANNELS.founderQueue),
  aiOperations: () => invoke(CHANNELS.aiOperations),
  setNotifications: (enabled) => invoke(CHANNELS.setNotifications, enabled),
  testNotification: () => invoke(CHANNELS.testNotification),
  openWebApp: (path) => invoke(CHANNELS.openWebApp, path),
  openSource: (url) => invoke(CHANNELS.openSource, url),
  aiMissions: () => invoke(CHANNELS.aiMissions),
  aiMission: (id) => invoke(CHANNELS.aiMission, id),
  aiOptions: () => invoke(CHANNELS.aiOptions),
  aiEstimate: (mission) => invoke(CHANNELS.aiEstimate, mission),
  aiSaveMission: (id, mission, requestId) => invoke(CHANNELS.aiSaveMission, id, mission, requestId),
  aiMissionAction: (id, action, requestId, input) => invoke(CHANNELS.aiMissionAction, id, action, requestId, input),
  aiReviewEstimate: (id, model) => invoke(CHANNELS.aiReviewEstimate, id, model),
  aiApprovals: () => invoke(CHANNELS.aiApprovals),
  aiSpending: () => invoke(CHANNELS.aiSpending),
  aiReconciliation: (provider, periodKind, period) => invoke(CHANNELS.aiReconciliation, provider, periodKind, period),
  aiRecordFigure: (input) => invoke(CHANNELS.aiRecordFigure, input),
  aiRelease: (input) => invoke(CHANNELS.aiRelease, input),
  aiUnblock: (provider, note) => invoke(CHANNELS.aiUnblock, provider, note),
  aiSources: () => invoke(CHANNELS.aiSources),
  aiAddSource: (input) => invoke(CHANNELS.aiAddSource, input),
  aiDecideSource: (key, status, note) => invoke(CHANNELS.aiDecideSource, key, status, note),
  aiIntelligence: () => invoke(CHANNELS.aiIntelligence),
  aiMarkReviewed: (id) => invoke(CHANNELS.aiMarkReviewed, id),
  aiResearch: () => invoke(CHANNELS.aiResearch),
  aiCapabilities: () => invoke(CHANNELS.aiCapabilities),
  engOverview: () => invoke(CHANNELS.engOverview),
  engMission: (id) => invoke(CHANNELS.engMission, id),
  engSaveMission: (id, mission, requestId) => invoke(CHANNELS.engSaveMission, id, mission, requestId),
  engMissionAction: (id, action, requestId, input) => invoke(CHANNELS.engMissionAction, id, action, requestId, input),
  engAddWorkspace: (input) => invoke(CHANNELS.engAddWorkspace, input),
  engDemoWorkspace: () => invoke(CHANNELS.engDemoWorkspace),
  copyText: (text) => invoke(CHANNELS.copyText, text),
  custOverview: () => invoke(CHANNELS.custOverview),
  custCustomer: (orgId, period) => invoke(CHANNELS.custCustomer, orgId, period),
  custRequest: (id) => invoke(CHANNELS.custRequest, id),
  custOnboard: (customer) => invoke(CHANNELS.custOnboard, customer),
  custAddService: (service, requestKey) => invoke(CHANNELS.custAddService, service, requestKey),
  custServiceAction: (id, action, requestKey) => invoke(CHANNELS.custServiceAction, id, action, requestKey),
  custConfigure: (id, config, requestKey) => invoke(CHANNELS.custConfigure, id, config, requestKey),
  custSubmit: (request, requestKey) => invoke(CHANNELS.custSubmit, request, requestKey),
  custReview: (id, review, requestKey) => invoke(CHANNELS.custReview, id, review, requestKey),
  custInvoice: (orgId, period, requestKey) => invoke(CHANNELS.custInvoice, orgId, period, requestKey),
  custInvoiceAction: (id, action, requestKey) => invoke(CHANNELS.custInvoiceAction, id, action, requestKey),
  custOffboard: (orgId, requestKey) => invoke(CHANNELS.custOffboard, orgId, requestKey),
};

contextBridge.exposeInMainWorld("kelqor", bridge);
