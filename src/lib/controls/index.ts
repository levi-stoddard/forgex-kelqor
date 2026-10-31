// Milestone 2B controls: owner authority, approvals, spending, the ledger and reconciliation.
// OWNER: the security reviewer agent. This file is the agreed interface (docs/m2b/PLAN.md, "What the security reviewer's controls provide");
// the implementation lives in the files beside it. Every write accepts a database or a transaction (a savepoint),
// except meteredRequest, which refuses a transaction because its reservation must be committed before anything is sent.

// ---- Owner authority ----
export { assertFounder, designateFounder, founderAuthority, isFounder, revokeFounder } from "./authority";

// ---- Boise calendar ----
export { boiseDay, boiseMonth, endOfBoiseDay } from "./boise";

// ---- Prices (src/lib/ai/pricing.ts additions) ----
export { isMissionModel, missionPrice, reservationFor } from "../ai/pricing";
export type { MissionPrice } from "../ai/pricing";

// ---- Approvals ----
export { activeApproval, approvalsFor, grantApproval, reviewFingerprint, scopeFingerprint, voidApprovals } from "./approvals";

// ---- The paid-request pathway ----
export { meteredRequest } from "./spending";
export { redeemTicket } from "./tickets";
export { ledgerEntries, markOpenReservationsUnverified, missionSpend, spendingSummary } from "./ledger";

// ---- Reconciliation (owner only for every write) ----
export { reconciliationView, recordProviderFigure, releaseUnverified, unblockProvider } from "./reconciliation";
export type { ReconciliationView } from "./reconciliation";

// ---- Test mode: only an in-memory database or a marked isolated copy ----
export { assertTestDatabase, testCopyProblem, testMode } from "./testmode";
export { syntheticPlanFromEnv, syntheticProvider } from "./synthetic";
export type { SyntheticPlan } from "./synthetic";
export { precommitSpending, prepareTestCopy } from "./testcopy";
