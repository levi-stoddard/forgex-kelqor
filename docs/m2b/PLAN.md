# Milestone 2B: shared development plan

The owner authorized the bounded local M2B implementation on 2026-10-28, to be built by exactly two Claude agents.
This file is their shared plan: who owns what, the contracts between them, and the order of work. The governing
requirements are [AUTHORIZATION.md](AUTHORIZATION.md) (the owner's approved 21-section document) plus the
safeguards in the owner's instruction, summarized under Rules.

## The team

| Agent | Role | Where it works |
| --- | --- | --- |
| **The implementation agent**, Lead Systems Engineer | The functional system and final integration: missions, providers, research protocols, sources, evidence, results, the window, migrations, packaging, the real database and the install | The owner's session, in its own worktree on branch `kelqor/m2b` |
| **The security reviewer agent**, Security, Controls & Verification Engineer | Owner authority, approvals, spending caps, the ledger, reconciliation, and independent verification of everything | A separate Claude agent with its own context, in its own worktree on branch `kelqor/m2b-controls` |

Claude Code Agent Teams isn't available in this app session, so the security reviewer runs as a background Claude agent
(supported subagent delegation), with its own context and its own git worktree. The implementation agent messages it; the security reviewer replies
to the main session. No other agent is started.

The project folder stays on `kelqor/desktop-m1` at `0e46a42` until the release step. The installed 0.1.3 app starts its
backend from that folder whenever it opens, so it must never see unreleased M2B code or migrations (the security reviewer's
finding B1). Both agents build and test in their own worktrees, with `node_modules` linked to the main project folder.

## Rules (both agents)

- No paid AI request of any kind: no Gemini or Claude call, no token-counting call, nothing that could spend any part
  of the $2/$5/$20 ceilings. Real providers are exercised only through fakes that never open a network connection.
- No key is read, printed, logged, added or changed. `.env.local` is never opened. The security reviewer's worktree has no
  `.env.local` at all.
- No GitHub push, pull request, merge to `main`, deployment, outreach, purchase or subscription.
- Only the implementation agent touches the real database (the project's `.data` folder), runs a migration against it, packages or installs the
  app, or starts the installed app. The security reviewer uses in-memory test databases and isolated copies only.
- Neither agent edits a file the other owns. A needed change in the other's file is sent as a message with the exact
  change, and the owner makes it. `src/lib/missions/contract.ts` and the schema change only by agreement.
- Inside a transaction callback, use only the transaction handle: the outer handle deadlocks PGlite.
- Clock overrides (`now`) are passed only by tests; the controls honor them on test databases only.
- Fail closed. When a check can't be performed, nothing is sent.
- Simulated work is labeled simulated everywhere, costs $0, never counts toward budgets and never creates research
  or industry records. A simulated success is not evidence that live execution works.
- Existing data is preserved: frozen research, both benchmark ledgers, dossiers, decisions, discovery records and
  Work Orders. Any M1 or M2A regression is fixed before M2B is reported as built.

## Ownership

| Area | Files | Owner |
| --- | --- | --- |
| Shared contract | `src/lib/missions/contract.ts` | Both (the implementation agent commits agreed changes) |
| Schema and migration 0004 (tables, columns, indexes, keys, the demo sign-in shut-off) | `src/lib/db/schema.ts`, `drizzle/0004_*`, `drizzle/meta/*` | The implementation agent, to the security reviewer's requirements |
| Migration 0005: CHECK constraints and triggers for missions, approvals, the ledger and reconciliations | `drizzle/0005_m2b_control_rules.sql` | The security reviewer |
| Database location, the migration backup guard, `db:backup` | `src/lib/db/index.ts` (`dbLocation`, `MigrationNeedsBackup`), `scripts/backup-db.ts` | The implementation agent |
| Owner authority | `src/lib/controls/authority.ts`, `scripts/designate-founder.ts` | The security reviewer |
| Demo sign-in shut-off | `src/lib/auth/session.ts`, `authenticate()` in `src/lib/domain/accounts.ts` | The security reviewer |
| Approvals and scope fingerprints | `src/lib/controls/approvals.ts` | The security reviewer |
| Spending: reservations, caps, tickets, Boise periods | `src/lib/controls/spending.ts`, `boise.ts`, `tickets.ts` | The security reviewer |
| Price versions | `src/lib/ai/pricing.ts` (additions only; existing exports unchanged for the frozen benchmark) | The security reviewer |
| Ledger and reconciliation | `src/lib/controls/ledger.ts`, `reconciliation.ts` | The security reviewer |
| Test mode guard, synthetic-cost provider, acceptance copy preparation | `src/lib/controls/testmode.ts`, `synthetic.ts`, `prepareTestCopy`, `scripts/prepare-test-copy.ts` | The security reviewer |
| Controls entry point | `src/lib/controls/index.ts` | The security reviewer |
| Control, security and verification tests | `tests/m2b-controls.test.ts`, `tests/m2b-security.test.ts`, `tests/m2b-verification.test.ts`, `tests/fixtures/sentinel/**` | The security reviewer |
| Provider interface additions | `src/lib/ai/types.ts` | The implementation agent |
| Gemini mission adapter (count, thinking level, cancellation, tickets) | `src/lib/ai/gemini.ts` | The implementation agent |
| Claude review adapter | `src/lib/ai/claude.ts` | The implementation agent |
| Simulated mission providers | `src/lib/missions/simulated.ts` | The implementation agent |
| Mission service, runner, recovery | `src/lib/missions/service.ts`, `runner.ts`, `recovery.ts`, `providers.ts` | The implementation agent |
| Protocols v2.0 (company) and v1.0 (industry) | `src/lib/missions/company.ts`, `industry.ts` | The implementation agent |
| Evidence checks and categories | `src/lib/missions/evidence.ts` | The implementation agent |
| Claude review step | `src/lib/missions/review.ts` | The implementation agent |
| Results: research versions, industry intelligence | `src/lib/missions/results.ts` | The implementation agent |
| Approved sources and the reader's scope | `src/lib/sources/*`, `src/lib/research/fetcher.ts`, `playbooks/sources.json` | The implementation agent |
| Customer-reported figures | `src/lib/domain/discovery.ts` | The implementation agent |
| Desktop API, views, bridge, IPC, preload, screens | `src/lib/desktop/*`, `desktop/src/**` | The implementation agent |
| Startup recovery hook | `src/instrumentation.ts` | The implementation agent |
| Mission and integration tests, local test pages | `tests/m2b-missions.test.ts`, `tests/fixtures/sites/**` | The implementation agent |
| Acceptance run | `desktop/scripts/acceptance.mjs`, `desktop/scripts/cdp.mjs` | The implementation agent |
| Docs, versions, `package.json` | `docs/**`, `README.md`, `package.json`, `desktop/package.json` | The implementation agent |

Frozen, owned by neither: `scripts/benchmark-gemini.ts`, `src/lib/research/spec.ts`, `agent.ts`, `budget.ts`,
`simulated.ts`, `research/**`, `src/lib/scoping/ai.ts` (Claude scoping stays off). Two exceptions, neither changing
behavior: `agent.ts` may gain exports of existing helpers so the mission checks reuse them, and `fetcher.ts` (the implementation agent)
accepts a read scope beside the site root string the benchmark passes.

## The contract

Types are in [`src/lib/missions/contract.ts`](../../src/lib/missions/contract.ts). Money is integer micro-dollars.

### What the security reviewer's controls provide (`src/lib/controls/index.ts`)

Agreed in Stage 1 from the security reviewer's review. Control writes accept a database or a transaction (a savepoint);
`meteredRequest` alone refuses a transaction, because its reservation must be committed before anything is sent.

```ts
// Owner authority
founderAuthority(db) / isFounder(db, userId) / assertFounder(db, actor)   // operator, not demo, sign-in on, designated
designateFounder(db, { email, password, replace? }) / revokeFounder(db, { email, password })
                                  // the CLI only; audited; void every open approval; refuse the seed's public password

// Boise calendar: boiseDay(at), boiseMonth(at), endOfBoiseDay(at), daylight saving included (Nov 1, 2026 has 25 hours)

// Prices (src/lib/ai/pricing.ts additions; existing exports unchanged)
missionPrice(model, at): { version, input, cachedInput, output, rule, maxInputTokens }
                                  // within 24 h either side of 00:00Z on a listed change date: the higher price per part
reservationFor(model, { counted, uncounted }, maxOutputTokens, at): { inputTokens, micros, price }
                                  // inputTokens = ceil((counted + uncounted) * 1.15) + 512; micros = input + output limit once
isMissionModel(provider, model)

// Approvals
scopeFingerprint(scope) / reviewFingerprint(missionFingerprint, review)
grantApproval(db, actor, { missionId, kind, seenFingerprint, review?, requestId, now? }): ApprovalView
                                  // scope, fingerprint and maximum come from the mission row; seenFingerprint is what the
                                  // window showed; "mission" from awaiting_approval, approved (expired), interrupted or
                                  // budget_blocked; "review" adds a later review on its own approval; idempotent per requestId
activeApproval(db, missionId, kind, now?) / approvalsFor(db, missionId) / voidApprovals(db, missionId, reason, now?)

// The paid-request pathway: the only way any provider is reached
meteredRequest(db, ctx: MeteredContext, provider, request, signal): MeteredReply
  // 0 refuse a transaction handle
  // 1 read-only pre-check of everything in 3 at the output-only maximum: nothing is counted for a mission that couldn't send
  // 2 count ticket, provider.countInputTokens, a $0 "count" ledger row
  // 3 one transaction under an advisory lock: run id, paid state for the purpose (research while Running, review
  //   in Verification), fingerprints, approval live and from today, approver's authority unchanged since approval,
  //   provider, model, kind and thinking level as approved, output limit, attempt 1 to 3, input within the price entry;
  //   caps in order: the purpose's approved maximum, the $2 mission, the Boise day $5, the Boise month $20, each read
  //   from committed_micros; record the reservation; any error is cap_unconfirmed
  // 4 send ticket, provider.respond
  // 5 settle at the row's own prices; over the reservation (cost, input or output) settles and blocks the provider;
  //   not billed only when nothing left or a 400/401/403/404/413/422/429 refusal; anything else unverified in full;
  //   a reply without usage is unverified; a credential-like reply is recorded then thrown as UnsafeReply
redeemTicket(ticket, { use, provider, model, kind, request })     // single use, bound, private map; TicketRefused
missionSpend(db, missionId) / spendingSummary(db, now?) / ledgerEntries(db, filter)
markOpenReservationsUnverified(db, reason, now?)                  // other backend instances' open rows only

// Reconciliation (owner only for every write): reconciliationView, recordProviderFigure, releaseUnverified,
// unblockProvider. An adjustment is dated when it is recorded and linked to the period it reconciles.

// Test mode
testMode(db, env?): { syntheticCosts, testPagesDir }   // KELQOR_SYNTHETIC_COSTS=1, KELQOR_TEST_PAGES=<dir>; throws
                                                       // test_only unless the database is in memory or a marked copy
assertTestDatabase(db)                                 // memory, or a dir outside <cwd>\.data holding .kelqor-test-copy
syntheticProvider({ inner, model })                    // inner drives the conversation; invented usage, flagged synthetic
prepareTestCopy(db, { operatorEmail, operatorPassword, enableSignIn })   // acceptance copies only
```

### What the implementation agent's mission system provides

```ts
// src/lib/missions/service.ts: every owner action carries a requestId and acts once per requestId
createMission(db, actor, input): Promise<MissionView>          // operators; draft
updateMission(db, actor, missionId, input): Promise<MissionView>   // draft or awaiting approval; returns to draft,
                                                                    // voids approvals
submitMission / approveMission / rejectMission / startMission / cancelMission / resumeMission /
addReview / acceptWithIssues / closeAsFailed(db, actor, { missionId, requestId, ... })
getMission(db, actor, missionId) / listMissions(db, actor)

// src/lib/missions/runner.ts: one in-process executor inside the backend; nothing starts by itself
missionExecutor(deps?: { providers?, transport?, now? })  // .start(missionId, runId), .cancel(missionId), .idle(missionId)
recoverAtStartup(db, now?)   // Running or Verification become Interrupted; open reservations become unverified

// src/lib/missions/providers.ts
providerFor(scope, env?): MissionProvider   // google (Gemini), simulation, synthetic in test mode only
reviewerFor(choice, env?): MissionProvider | null   // anthropic needs a key; simulation always available
```

Desktop routes, all under `/api/desktop/ai/` and all operator-only: `missions`, `missions/:id` and its actions,
`approvals`, `spending`, `ledger`, `reconciliation`, `sources`, `intelligence`, `capabilities`, `estimate`.

## Schema (migrations 0004 and 0005, additive)

- **0004 (the implementation agent):** `users.spending_authority_at` (one account at most, by a partial unique index; a check refuses
  demo accounts, non-operators and accounts with sign-in off) and `users.sign_in_disabled_at` (set for every demo
  account). New tables: `missions`, `mission_steps`, `mission_approvals`, `ai_usage_ledger`,
  `spending_reconciliations`, `research_sources`, `research_records`, `industry_intelligence`, `discovery_figures`.
  The ledger has a database-computed `committed_micros`; approvals record the approver's authority date and allow one
  open approval per kind; research and intelligence rows can reference only a real (non-simulated) mission.
- **0005 (the security reviewer):** CHECK constraints and triggers: no deletes on the ledger, approvals or reconciliations; ledger
  status changes only from reserved; releases only rise; amounts and prices immutable.
- An unfinished mission's working state lives on `missions.working_state` and is cleared when the mission ends
  (Needs review included); the step log is `mission_steps`.
- The real database is migrated only after `npm run db:backup` verifies a copy taken since its last change.

## Notes for the owner's report

- The lifecycle table says Running is the only paid state, but Claude review runs in Verification. The build allows
  review requests only in Verification and research requests only in Running.
- A reconciliation adjustment is dated when it is recorded, so it reduces today's and this month's remaining budget,
  and it is linked to the period it reconciles. Confirm this reading.

## Order of work

1. **Foundation (both):** The security reviewer reviews this plan, the contract and the schema; the implementation agent applies agreed changes,
   generates 0004 and commits the foundation on `kelqor/m2b`. The security reviewer's worktree starts from that commit.
2. **Parallel build.** The security reviewer: authority, sign-in shut-off, approvals, spending and tickets, ledger, prices, test
   mode, synthetic provider, then reconciliation, the CLI and its tests. The implementation agent: providers, reader scope and sources,
   protocols, evidence, runner and service, results, figures, routes and screens.
   - **Checkpoint A:** The security reviewer's core controls (authority, approvals, `meteredRequest`, ledger, Boise, prices, test
     mode) are committed and tested; the implementation agent merges them and wires the runner to them.
3. **Integration.** The implementation agent merges `kelqor/m2b-controls`, runs everything, and hands the combined branch to the security reviewer,
   which reviews it independently, adds verification tests and reports reproducible defects.
4. **Fixes.** Material defects are fixed by their owner and re-verified by the security reviewer.
5. **Release (the implementation agent).** Back up the real database, migrate it and compare row counts, package and install 0.2.0,
   run the full acceptance on an isolated copy, commit, and report. No paid mission.

## Acceptance criteria and their tests

| # | Criterion (AUTHORIZATION.md) | Automated test owner | Installed-app check |
| --- | --- | --- | --- |
| 1 | Company mission for an existing and a new company | The implementation agent | Yes |
| 2 | Industry mission | The implementation agent | Yes |
| 3 | Unapproved mission can't run, even through the backend directly | The security reviewer | Yes |
| 4 | Owner-only actions; refusals for demo, other operators, clients, builders; no route grants authority; demo sign-in off | The security reviewer | Yes |
| 5 | Approval void on scope change, single mission, Boise midnight expiry, mid-run expiry stops the next request | The security reviewer | Partly (scope change) |
| 6 | Runs only through the runner; nothing starts when KELQOR opens | The implementation agent, verified by the security reviewer | Yes |
| 7 | Double clicks, two windows, reconnections start once | The security reviewer | Yes |
| 8–11 | $2 mission, $5 day, $20 month caps at Boise boundaries; concurrency | The security reviewer | Yes, with synthetic costs on the copy |
| 12 | Retries and repairs reserved, counted, within the approval | The security reviewer | No |
| 13 | No model request without a reservation | The security reviewer | No |
| 14 | Timeout after sending or backend stop mid-request: full reservation unverified | The security reviewer | Yes (restart) |
| 15 | Unpriced model, failed count or missing approval sends nothing | The security reviewer | No |
| 16 | December 1 price change by date, higher price near the boundary | The security reviewer | No |
| 17 | Reconciliation release rules and records | The security reviewer | Yes |
| 18 | Simulated $0, no budgets; synthetic refuses the real database | The security reviewer | Yes |
| 19–23 | Recovery: failures keep work and usage; cancel; restart makes Interrupted; reconnect; provider errors end in the right state | The implementation agent and the security reviewer | 20–22 yes |
| 24 | Reader scope: company site plus approved sources; blocked domains; robots.txt | The implementation agent, verified by the security reviewer | No |
| 25–27 | Evidence: downgrades, Needs review, gaps, no AI-made confirmation or raised category | The implementation agent, verified by the security reviewer | Yes (results) |
| 28 | Proposed sources wait and aren't read | The implementation agent, verified by the security reviewer | Yes |
| 29 | Claude review: off unless approved, in the caps, impossible without a key, simulated end to end, re-read cost, changed sources | The implementation agent, verified by the security reviewer | Yes (simulated) |
| 30 | Claude scoping off; template scoping works | The security reviewer | No |
| 31 | Frozen research, ledgers, dossiers, M1 and M2A records unchanged | The security reviewer (tests), the implementation agent (real database) | Yes |
| 32 | No contact or external action; outbox unchanged | The security reviewer | Yes |
| 33 | No key in responses, logs, ledger or exports | The security reviewer | Yes |
| 34 | Client and builder accounts refused on every mission route | The security reviewer | No |
| 35 | All M1 and M2A tests and acceptance checks still pass | Both | Yes |
| 36 | Installed 0.2.0 passes the full acceptance on an isolated copy | The implementation agent | Yes |

## Messages

The security reviewer sends findings and checkpoints to the main session; the implementation agent messages the security reviewer by name. Each message names
the commit it refers to. Defect reports give the file, the steps to reproduce and what was expected.
