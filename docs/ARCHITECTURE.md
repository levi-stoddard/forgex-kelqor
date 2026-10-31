# ForgeX architecture

One TypeScript web application (Next.js 16, React 19) on Postgres, with Stripe for payments and the Claude API for
scoping. Business rules live in `src/lib/domain`; pages and server actions are thin wrappers that authenticate the
user, build an `Actor`, and call a domain service.

```
Browser ──► Next.js (server components + server actions + route handlers)
              │
              ├── src/lib/domain ── state machine, pricing, permissions, audit log, outbox
              │        │
              │        └── Drizzle ORM ──► Postgres (PGlite locally; managed Postgres in production)
              ├── src/lib/scoping ──► Claude API (structured output) — falls back to catalog templates
              └── src/lib/payments ──► Stripe Checkout ──► webhook / return route ──► recordPayment()
```

## Core concept: the Work Order

| Status | Meaning | Who moves it on |
| --- | --- | --- |
| `submitted` | Request in, draft scope ready | Operator sends the quote |
| `quoted` | Fixed price sent | Client accepts or requests changes (back to `submitted`) |
| `accepted` | Terms accepted | Payment (Stripe, bank transfer, or dev-only TEST) |
| `funded` | Paid to ForgeX (merchant of record) | Starts automatically once a builder has accepted |
| `in_progress` | Builder working | Builder submits a delivery with evidence for every criterion |
| `delivered` | Client reviewing | Client accepts (→ `completed`) or requests a revision (→ `in_progress`) |
| `completed` | Accepted; payout queued (none when in-house) | Operator records the payout; a setup's monthly service starts; client may review |
| `disputed` | Operator mediating | Operator: continue, complete, or cancel |
| `cancelled` | Stopped | Operator records any refund |

All status changes go through `transition()` in `src/lib/domain/state-machine.ts`, which checks both the current
status and the actor's role. Updates are guarded with `WHERE status = <expected>`, so two concurrent actions can't
both succeed (the loser gets "This Work Order just changed").

## Permissions

| | Client (own company) | Builder (assigned) | Builder (invited only) | Operator |
| --- | --- | --- | --- | --- |
| Scope, criteria, milestones | ✓ | ✓ | ✓ | ✓ edit before quote |
| Client price, Care price | ✓ | — | — | ✓ |
| Builder payout | — | ✓ | ✓ (their offer) | ✓ |
| Margin and contribution | — | — | — | ✓ |
| Conversation | ✓ | ✓ | — | ✓ (+ internal notes) |
| Payments | ✓ | — | — | ✓ |

Clients outside the owning company, and builders without an assignment or open invitation, get "not found" rather
than "forbidden", so ids can't be probed. `getOrderView()` shapes the data per role; pages never query orders directly.

## Money

- ForgeX is the **merchant of record**: the client buys the Work Order from ForgeX; ForgeX pays the builder as an
  independent contractor. This avoids holding third-party funds as an escrow agent (Stripe does not offer escrow;
  California licenses Internet escrow agents). Counsel must confirm before launch.
- Every Checkout session is saved as a `pending` payment the moment it is created, and an open session is reused
  rather than opening a second one. `recordPayment()` locks the session's row (`SELECT … FOR UPDATE`), so the webhook
  and the success redirect can both report the same payment safely.
- Money Stripe has captured is never dropped: a payment that can't fund the order (already funded, cancelled, or the
  wrong amount) is recorded and flagged "refund required" for an operator, and the client is told it will be refunded.
- Refunds check the operator role and refund rules first (`refundablePayment()`), then call Stripe with an
  idempotency key per payment, so a retry can't refund twice.
- TEST payments exist only when `ALLOW_TEST_PAYMENTS=true` and `NODE_ENV` isn't production. Metrics exclude them,
  payouts on TEST-funded orders are flagged as not real money owed, and public records label them "Test data".
- One payout per Work Order (unique index), created on acceptance; operators record the transfer reference.
- Pricing rules (`src/lib/domain/pricing.ts`): payout = midpoint hours × $90 × 1.15, rounded to $25; price =
  payout ÷ (1 − 35%), rounded up to $50, minimum $2,000; Care ≈ 6% of the price a month ($149–$999).
  Productized offers skip the formula: the quote starts at the catalog's `listPriceCents` (and `monthlyCents`),
  with a $0 payout. The quote minimum is $250.
- A builder payout of **$0 means in-house delivery**: the owner's own builder account is assigned, and no payout
  row is created on acceptance.
- **Setup + monthly** (`careIncluded`): the monthly fee is part of the quote, so the Care plan record is created
  automatically when the work is accepted and the client isn't offered optional Care. Monthly billing is manual
  until Stripe subscriptions are added.

## Owner-led selling

First customers come from conversations, not sign-ups. An operator writes up the Work Order after the call
(`/ops/new`): `createClientForSale()` creates the company and a client user whose password field holds a marker
that can never verify, and `createWorkOrder()` accepts an `orgId` from operators. `issueInvite()` returns a 32-byte
random token; only its SHA-256 is stored (`invites` table). Links are single-use, expire after 14 days, are revoked
when a new one is issued, and only work for contacts who have never set a password, so a link can't take over an
active account. The operator sees the link once (a query parameter checked against an open invite for that order)
and sends it themselves; the `/invite/[token]` page sends no referrer.

## AI scoping

`draftScope()` calls Claude (`claude-opus-5-5` by default) through `client.beta.messages.parse` with a Zod
structured-output schema, `effort: "medium"`, and server-side refusal fallback. The client's text is wrapped in
tags and treated as data, not instructions. Any failure (no key, refusal, truncation, invalid output) falls back to
the deterministic catalog template, and the reason is logged on the Work Order's event. Token cost is recorded per
order (`aiCostMicros`) and summed in the operator metrics.

**Currently off (ADR 022).** `AI_SCOPING_AUTHORIZED` in `src/lib/scoping/ai.ts` is `false`, so every scope comes from
the template whatever keys are set. The path has no dollar cap, and public sign-ups can trigger it, so it stays off
until Milestone 2B gives it a spending limit, an authorization and safe failure behaviour.

## Security model (MVP)

- Passwords: scrypt (N=2^14, r=8, p=1) with per-user salt; constant-time comparison; dummy hash on unknown emails.
- Sessions: 32-byte random token in an httpOnly, SameSite=Lax cookie (Secure in production); only its SHA-256 is stored.
- Server actions re-check the session and role on every call; Next.js checks the Origin header on server actions.
- Rate limits (in memory): sign-in, sign-up, request creation, AI redrafts.
- Links from users render only if they are http(s) (`safeUrl`). User text is always rendered as text.
- Security headers: `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, restrictive permissions policy.
- Builders can't be approved without a recorded identity check.

Before launch: managed auth with MFA, edge rate limiting, a content security policy, encrypted backups, error
monitoring, and a written information security plan (required if serving tax preparers).

## Data model

`orgs`, `users`, `sessions`, `builder_profiles`, `work_orders` (intake and scope as JSON, money as integer cents),
`acceptance_criteria`, `milestones`, `assignments`, `deliveries`, `messages`, `payments`, `payouts`, `reviews`,
`care_plans`, `invites` (one-time client links), `events` (append-only audit trail behind every timeline) and
`outbox` (notifications). See `src/lib/db/schema.ts`; migrations are in `drizzle/`.

## Production path

1. Managed Postgres (Supabase, Neon or Render) via `DATABASE_URL`; run `npm run db:migrate` as a release step.
2. Host on Vercel or Render; set `APP_URL`, Stripe live keys and webhook secret, and `ANTHROPIC_API_KEY`.
3. Replace the outbox reader with an email provider (Resend or Postmark) that sends and marks rows delivered.
4. Move rate limiting to the edge or a shared store before running more than one instance.
5. Later: Stripe Connect for builder payouts (Express accounts, separate charges and transfers), file uploads to
   object storage, and Care health checks (an authenticated heartbeat endpoint per automation).

## KELQOR desktop app (Milestone 1)

KELQOR is the project's working name; ForgeX's technical identifiers are unchanged. The KELQOR Command Center is an
installed Windows app for the owner, built with Electron, React and TypeScript in `desktop/`, and a client of this
backend (ADR 016). It reads and writes nothing except through the backend's `/api/desktop` routes.

```
KELQOR.exe (main process)                       Next.js backend, 127.0.0.1:3000 (started and stopped by KELQOR)
 ├── session token, encrypted (safeStorage)  ──► /api/desktop/*  (src/lib/desktop/api.ts)
 ├── health check every 5 s                  ──► /api/health        ├── domain services (orders, invites, metrics...)
 ├── Windows notifications (opt-in)                                 ├── opportunity_decisions (Postgres)
 └── IPC, one channel per request                                   └── research/ records, read only (dossiers.ts)
      ▲
 window: packaged React UI from app://kelqor (no Node, no network, CSP), reusing src/components and src/lib/format
```

- **Access:** the routes answer only on a loopback host and only outside production, and only for operators: a
  client or builder is refused a desktop session. Every route builds an `Actor` and calls the existing domain
  services, so per-role data shaping is unchanged.
- **Backend lifecycle (ADR 018):** opening KELQOR starts the backend from the project folder the app was built
  from (`desktop/src/main/local-backend.ts`): one fixed command, `next dev` on 127.0.0.1:3000 with Node.js from
  the PATH, logging to `%APPDATA%\KELQOR\backend.log`. Exiting stops it: the app first has it close its database
  (`POST /api/desktop/shutdown`, which answers only to the secret the app gave that backend at start), then ends
  its processes, so the port closes with the app. If the app is ended without exiting (a crash, Task Manager), the
  backend notices its process is gone and does the same itself (`src/lib/desktop/watchdog.ts`, started from
  `src/instrumentation.ts`). A backend that was already running is used and left running. It's a child process of
  the app, not a Windows service; Settings can turn the automatic start off. While it runs it holds the embedded
  database, so `create-operator`, `db:seed` and `db:migrate` refuse to run until KELQOR is closed
  (`scripts/local-backend-guard.ts`).
- **Sign-in:** a saved sign-in is only as good as its token. Without one the app opens on the sign-in screen, and on
  every connection the name shown is confirmed with the backend (`GET /api/desktop/me`).
- **Tests:** `npm run desktop:acceptance` runs the installed app with a data folder of its own (`KELQOR_DATA_DIR`)
  and a copy of the database (`PGLITE_DIR`), both under `desktop/out/acceptance`, so a run never signs the owner
  out or changes their records.
- **The window** loads the packaged interface from `app://kelqor` with a strict content security policy: no
  network, no inline code. It has no Node and no web permissions, can't navigate away or open windows, and sees
  only `window.kelqor`, a fixed list of requests (`desktop/src/shared/bridge.ts`). It never sees the token, the
  backend address or any key. The browser opens only established web app pages (`/orders/<id>`, `/ops/new`,
  `/ops/builders`, `/dashboard`), or any other web page after a native confirmation dialog.
- **Opportunity Center:** the 25 Gemini 4 Argon dossiers from the full benchmark (dataset B), read from
  `research/benchmark-2026-gemini/` and never written. Each claim is labeled by its run-time evidence check, with
  the dataset C review's verdicts beside it. The owner's Qualified/Hold/Rejected call goes in
  `opportunity_decisions` (ADR 017). A qualified company can go to the existing New Work Order page with its name
  filled in; nothing is sent to it.
- **Fixtures:** demo and test records are labeled and kept out of every real total, everywhere, by each company's
  explicit class (Milestone 2A below).
- **Not built:** AI missions, a background worker, an approval engine, team or customer access, cloud hosting.
  The app makes no AI calls.
- **Rollback:** `git switch main` restores the original code. The only database change is the additive
  `opportunity_decisions` table, which the original code ignores. To remove it, run `DROP TABLE
  opportunity_decisions;` and `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793137628455;` (the
  journal's `when` for 0002), or restore a copy of `.data/pglite` taken before the change. Uninstall the app from Windows Settings › Apps, or with
  `%LOCALAPPDATA%\kelqor\Update.exe --uninstall`; its data folder is `%APPDATA%\KELQOR`.

## Discovery-first Opportunity Center and data classification (Milestone 2A)

Research prepares a conversation; only the customer confirms a problem. Milestone 2A adds that workflow to the
Opportunity Center and makes every money total honest. The roadmap, including what is still committed (M2B–M5), is in
[ROADMAP.md](ROADMAP.md).

- **Data classification (ADR 019):**
  - every company has `orgs.data_class`: real, demo or test. Public sign-ups are real, the seed makes demo, and the sale page asks every time;
  - an operator can correct a class from the Business Workspace, audited as `company_reclassified`;
  - `src/lib/domain/classification.ts` decides the rest: an order takes its company's class, and money is real, test or unverified;
  - a Stripe payment keeps Stripe's own `livemode` flag. One recorded before the flag existed is unverified until checked;
  - only real money counts as cash, margin, payouts or monthly revenue, on the web dashboard and in the desktop app.
- **Industry as configuration (ADR 021):**
  - `playbooks/industries.json` lists the industries, with words that suggest one from a research report;
  - `playbooks/general.json` holds the discovery questions for every industry;
  - `playbooks/home-services.json` adds that industry's questions and the research segment the benchmark ran under. The research prompt reads it, and a test proves the prompt's fingerprint still matches the frozen run;
  - the sale page, the sign-up form and the desktop use the same list.
- **Evidence levels (ADR 020):** `evidenceItems()` in `src/lib/research/dossiers.ts` reads the frozen dossiers. They are never written. Each statement gets a level:
  1. verified company information;
  2. an observed defect;
  3. a hypothesis or unverified claim, which includes every model-predicted problem.

  Research never reaches the customer levels.
- **Discovery records** (`src/lib/domain/discovery.ts`, migration 0003), keyed like `opportunity_decisions`:
  - `opportunity_profiles`: the owner's industry choice, and the Work Order drafted from discovery;
  - `opportunity_checks`: the owner's own verifications, each with its source and date;
  - `discovery_calls`: conversations in the customer's words: answers, software, priorities, desired outcome, value to them, next step;
  - `opportunity_problems`: problems the customer raised, or research findings they confirmed or dismissed.

  A problem row requires its call (`call_id` is NOT NULL), so nothing is customer-confirmed without a recorded conversation. Every change is audited.
- **Readiness:** `readinessOf()` turns the decision and the records into the next commercial action. The stages run from "not qualified" through "ready for discovery", "problem confirmed", "solution identified" and "ready to propose" to "Work Order drafted".
- **Solution matching:** each confirmed problem gets the simplest rung that solves it, in this order:
  1. a feature they already own;
  2. a configuration change;
  3. an integration;
  4. a managed AI agent.
- **Work Order hand-off:**
  - the desktop opens `/ops/new?opportunity=cNN&problem=<id>`, carrying ids only;
  - the page loads the confirmed problem, the chosen solution and the latest desired outcome and tools from the database;
  - the owner reviews it and creates the Work Order, which starts "submitted": unpriced, unquoted, nothing sent;
  - `drafted_from_discovery` links it back to the company.
- **Rollback of 0003:** run `DROP TABLE opportunity_problems, discovery_calls, opportunity_checks,
  opportunity_profiles; ALTER TABLE orgs DROP COLUMN data_class; ALTER TABLE payments DROP COLUMN livemode; DELETE FROM
  drizzle.__drizzle_migrations WHERE created_at = 1793158484759;`, or restore `.data/pglite-backup-2026-10-27-pre-m2a`.

## AI missions and their controls (Milestone 2B)

The governing requirements are [m2b/AUTHORIZATION.md](m2b/AUTHORIZATION.md); the build split between the implementation agent and
The security reviewer agent is in [m2b/PLAN.md](m2b/PLAN.md).

- **Contract:** `src/lib/missions/contract.ts` holds the types both halves share: mission scope, states, providers,
  spend tickets, refusals and ledger views. Money is integer micro-dollars.
- **Missions (`src/lib/missions`):** the service (create, edit, submit, approve, reject, start, resume, cancel, add
  review, accept, close; each action carries a request id and acts once), the runner (one in-process executor, step by
  step, saved after every step, recovery at start-up), the two protocols, evidence checks, Claude review, simulated
  providers, results and estimates.
- **Controls (`src/lib/controls`):** owner authority, approvals and scope fingerprints, Boise periods, prices,
  `meteredRequest` with its tickets, the ledger, reconciliation and the test-mode guard (ADR 023, 024).
- **Providers (`src/lib/ai`):** the Gemini mission adapter (Google's token counter, explicit thinking level, no SDK
  retries, cancellation) and a Claude review adapter; the benchmark's adapter is unchanged.
- **Sources (`src/lib/sources`, `playbooks/sources.json`):** versioned approved and proposed sources; the page reader
  takes a scope of the company's site plus approved sources (ADR 025).
- **Window:** AI Operations has Missions, New mission, Approval Center, mission detail, Spending, Sources, Industry
  intelligence and Capabilities. The Opportunity Center shows research versions beside the frozen dossier, and a company
  first researched by a mission gets its own entry (`n0001` and on) (ADR 026).
- **Tables (migrations 0004 and 0005):** `missions`, `mission_steps`, `mission_approvals`, `ai_usage_ledger`,
  `spending_reconciliations`, `research_sources`, `research_records`, `industry_intelligence`, `discovery_figures`, and
  two `users` columns. Rollback: [m2b/ROLLBACK.md](m2b/ROLLBACK.md).
- **Test mode:** `KELQOR_SYNTHETIC_COSTS=1` and `KELQOR_TEST_PAGES=<dir>` work only on an in-memory database or a copy
  marked `.kelqor-test-copy`; the backend refuses them against the real database.

## Business development (planned, not built)

Proposed on 2026-10-26 as a launch priority; the design, costs and open decisions are in my
decision notes, kept private. One research step, guided by a playbook per industry, fills prospect records that the operator
reviews in ForgeX HQ (the operator dashboard; the client area's "HQ" label would be renamed). The app sends nothing:
the operator approves each draft and sends it by hand.

- Playbooks: one versioned file per industry (targets, authorized sources, signals, offers, rules), loaded into the
  same research step. Specialists are playbooks, not separate agents.
- Research: Gemini through a provider-neutral interface (`src/lib/ai`), reading pages only through ForgeX's own
  fetcher (`src/lib/research`). The fetcher reads company sites only, honors robots.txt and blocks LinkedIn, review
  sites and job boards. Google Search grounding and URL context are off, because Google's terms for their results
  don't fit a stored prospect database. Every request is priced and capped before it is sent. Every claim keeps its
  source link, retrieval time and a label (fact, inference or hypothesis). The research step is being benchmarked
  against the pilot before any use; see `research/benchmark-2026-gemini/PROTOCOL.md`.
- Records (new tables): prospects, evidence, contacts with an allowed channel, drafts, touches and outcomes, a
  do-not-contact list, and research runs with their cost. A prospect who buys becomes an org and a Work Order through
  the existing sale flow.
- Learning: outcomes are logged against the signals present; a review every 50 contacts proposes playbook changes,
  which the operator approves and commits.
- Never: scraping, automated messages, AI or prerecorded voices, cold texts, or stored Google Places content.

## Future platform options (not built)

The owner wants room for professional identities, business-to-business commerce, recruiting, professional
communities, job fairs, an interactive headquarters and more industries. None of these is built. The current
model keeps them open as follows; each starts as its own decision record when there is demand.

| Option | What already exists | The change it would need |
| --- | --- | --- |
| Professional identities | `builder_profiles` is separate from the login, and `/b/[slug]` is a verified record of accepted work | Memberships (user to org, with a role) instead of one `users.role`, so one person can be a client, a builder and an operator. Role checks live in domain functions (`requireRole`), so the swap is contained |
| Business-to-business commerce | Work Orders, payments and payouts already belong to orgs; the catalog is data | Orgs as sellers (agencies and builder studios with members), per-seller listings, and Stripe Connect before any third-party money is handled (see ADR 002) |
| Recruiting and work-to-hire | Accepted work, ratings and review visibility (named, anonymous, private) | A hire or retain offer on a builder profile, with consent controls and a separate fee agreement |
| Professional communities | Orgs, users and per-Work Order messages | A "space" entity with members and posts; moderation before launch |
| Job fairs and events | The outbox and the events audit log | Event and registration tables linking orgs and builder profiles |
| Interactive headquarters | The client dashboard is already labeled "HQ" | Grow it into a company workspace: orders, monthly services, team members and the Monday numbers |
| More industries | Catalog `featuredFor` tags and data-driven vertical pages (`/home-services`) | A template set and a landing page per industry; no schema change |

Constraints that keep these open: UUID ids everywhere, money in integer cents (add a currency column before
selling outside the US), an append-only events log that can feed activity views, and per-role data shaping in
`getOrderView()`.
