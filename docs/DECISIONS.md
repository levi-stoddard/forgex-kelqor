# Decision log

Short records of decisions that shape the product, newest last. Each says what was decided, why, and what would
make us revisit it.

## 001 — Start as a managed outcome network, not an open marketplace (2026-10-26)
**Decision:** ForgeX sells fixed-price Work Orders itself and delivers through a vetted bench of builders.
**Why:** open freelance marketplaces are shrinking (Upwork GSV −3.6%, Fiverr active buyers −21.9% in Q2 2026)
while AI implementation work grows; a managed model earns gross profit from the first order and needs no liquidity.
**Revisit when:** builder supply exceeds managed demand and acceptance rates hold (Gate 3), then open self-serve.

## 002 — Merchant of record, no escrow (2026-10-26)
**Decision:** clients pay ForgeX for the service; ForgeX pays builders as contractors.
**Why:** Stripe does not provide escrow; California licenses Internet escrow agents. Holding third-party funds
creates money-transmission risk. **Revisit:** with payments counsel before adding self-serve marketplace flows.

## 003 — Next.js + TypeScript + Postgres (Drizzle) as the single stack (2026-10-26)
**Why:** one codebase for public site and three role views, a large hiring pool, relational integrity for money.
Drizzle keeps SQL visible and migrations reviewable. **Revisit:** not before product-market fit.

## 004 — Embedded PGlite for local development (2026-10-26)
**Why:** real Postgres semantics with zero installs (no Docker on the owner's machine); in-memory instances make
the workflow tests fast and isolated. Production uses node-postgres via `DATABASE_URL`.
**Watch:** PGlite is single-process — stop the dev server before seeding.

## 005 — Claude for scoping, with a deterministic fallback (2026-10-26)
**Decision:** Claude Opus 5.5 drafts scopes with structured output; catalog templates are used whenever AI is
unavailable or fails. **Why:** scoping quality drives price accuracy and dispute rates; the product must keep
working without the API. Cost is tracked per order.

## 006 — TEST payments never count as revenue (2026-10-26)
**Why:** the owner directive forbids presenting simulated transactions as traction. Metrics exclude TEST and
demo data by default; TEST-funded payouts and public records are labeled.

## 007 — No builder approval without an identity check (2026-10-26)
**Why:** DOJ and FBI actions against laptop farms and fake remote IT workers (70+ US employers in one 2026 action)
target exactly this kind of remote technical work. Enforced in code, not just policy.

## 008 — Clients see prices, builders see payouts, only ForgeX sees both (2026-10-26)
**Why:** margin confidentiality and fewer disintermediation incentives. Enforced in `getOrderView()` and list views.

## 009 — Built-in email/password sessions for the MVP only (2026-10-26)
**Why:** no external accounts can be created without owner approval. **Must change before launch:** a managed
provider with MFA.

## 010 — Notifications go to an outbox table (2026-10-26)
**Why:** testable locally and nothing can be emailed by accident. **Before launch:** connect Resend or Postmark.

## 011 — First segment: owner-led contractors who buy leads (2026-10-26)
**Decision:** sell first to HVAC, plumbing and electrical contractors with about 10–75 staff who pay for leads and
use field-service software, in a region the owner can reach. Accounting firms are the fallback.
**Why:** a lost lead is money they already spent, the data to measure it is exportable, and the owner is the buyer.
**Risk:** single features (missed-call texting, AI receptionists) are cheap add-ons in their own software.
**Revisit:** if gate 1 fails (fewer than 3 paid Leak Checks or 1 setup from 60 qualified conversations by day 30).

## 012 — Productized setup + monthly offers instead of custom Work Orders (2026-10-26)
**Decision:** Revenue Leak Check $500 (credited), Lead-to-job pipeline $1,800 + $149/month, Owner's Monday numbers
$1,200 + $99/month. Custom Work Orders stay in the product but aren't sold yet.
**Why:** a new company can't win $2,500–$5,000 custom projects on trust; a small paid diagnostic plus a monthly fee
matches how contractors buy software, and templated builds roughly halve delivery hours.
**Revisit:** if fewer than 40% of paid Leak Checks turn into a setup within 30 days.

## 013 — The owner delivers the first customers in-house (2026-10-26)
**Decision:** a $0 builder payout means in-house delivery through the owner's own builder account. The builder
network is deferred until demand exceeds about 140 owner hours a month.
**Why:** learn real delivery hours before paying anyone, and keep the margin on the first sales.
**Revisit:** at about 3 new setups a month, or when owner hours exceed capacity.

## 014 — Operator-created Work Orders and one-time client links (2026-10-26)
**Decision:** operators write up Work Orders after a call and send a single-use, 14-day link (hashed at rest,
revoked on reissue, only for contacts who never set a password). The owner sends it; the app emails nothing.
**Why:** the first customers come from conversations, and the client should land on their quote in one click.
**Revisit:** when an email provider is approved (send the link from the app) or self-serve sign-ups dominate.

## 015 — Payment wording matches merchant of record (2026-10-26)
**Decision:** product copy says ForgeX is paid and the builder is paid on acceptance; it no longer says ForgeX
"holds" the client's payment, which read like escrow and contradicted ADR 002.

## 016 — KELQOR's Windows app is an Electron client of the existing backend (2026-10-27)
**Decision:** the KELQOR Command Center (Milestone 1) is an installed Electron app with its own packaged React
interface. It reaches data only through the local backend's `/api/desktop` routes, which call the same domain
services as the web app; it has no database of its own. The main process holds the session token (encrypted with
Windows data protection) and every privileged action; the window has no Node, no network and no web permissions,
and talks to the main process over one checked IPC channel per request. In this release the routes answer only on
a loopback host, only outside production, and only for operators.
**Why:** one system of record and one set of permission rules, with a native app on top, without rebuilding the
platform. Electron matches the TypeScript and React stack, so the UI primitives are shared.
**Revisit:** when the backend moves to the cloud (hosted sign-in, a non-loopback API) or team and customer roles
get desktop access.

## 017 — Owner decisions live in the database; research records stay read-only files (2026-10-27)
**Decision:** the owner's Qualified/Hold/Rejected call on a researched company is a row in
`opportunity_decisions` (migration 0002), keyed by the saved research record it was made on, and audited in
`events`. The research records themselves are read, never written: dataset B is frozen at `dataset-b-v1`. A
decision is internal sales research and never permission to contact the company.
**Why:** decisions must survive restarts and be auditable, while the benchmark evidence must stay exactly as frozen.
**Revisit:** when research runs from the app and needs prospect tables of its own (the "Business development" plan).

## 018 — The desktop app starts and stops its local backend (2026-10-27)
**Decision:** at the owner's request, KELQOR starts the local development backend when it opens and stops it
when it exits; in Milestone 1 the owner started it by hand. The backend is a child process of the app, running one
fixed command in the project folder the build came from, and never a Windows service or startup task, so nothing
listens on port 3000 while KELQOR is closed. Stopping closes the embedded database first, through a shutdown route
that answers only to a secret the app passes to the backend it started; a backend whose app has vanished stops
itself the same way. A backend someone started by hand is used and left alone.
**Why:** one step to use the app, the port open only while the app runs, and no unclean database shutdowns from
simply killing the process.
**Revisit:** when the backend moves to the cloud, or the app has to run on a computer without a copy of the project.

## 019 — Every company is explicitly real, demo or test; only real money counts (2026-10-27)
**Decision:** `orgs.data_class` records each company's class, set when it is created and changed only by an
operator (audited). Names are never read: the companies named "(test)" were classed once, by migration 0003. An order
takes its company's class, and money is real, test or unverified. A Stripe payment counts as real only when Stripe
marked it live. Cash, margin, payouts and monthly revenue count real money only; test and unverified money are shown
apart.
**Why:** four paths let test or demo money reach real totals: Care MRR on TEST-funded orders, "(test)" companies on
the web, Stripe test-mode payments, and sale-flow orders for demo companies. ADR 006 promised that never happens.
**Revisit:** when payments move to live mode, check every unverified Stripe payment in Stripe.

## 020 — Research reaches evidence level 3 at most; only a recorded conversation confirms a problem (2026-10-27)
**Decision:** each research statement is level 1 (verified company information), 2 (observed defect) or 3
(hypothesis or unverified, including every model-predicted problem). A problem becomes customer-confirmed only as part
of a recorded discovery conversation: the database requires the call. A Work Order drafted from discovery starts
unpriced and unquoted.
**Why:** a technical defect isn't a sale. The owner wants discovery-first selling, in which research prepares
conversations and doesn't replace them.
**Revisit:** when research runs from the app (M2B) and outcomes accumulate enough to learn from.

## 021 — Industries and research segments are configuration (playbooks), not code (2026-10-27)
**Decision:** `playbooks/industries.json` lists the industries KELQOR works with, and each playbook file holds
discovery questions. A research playbook also holds the segment and category definitions its prompt states. The
benchmark's home-services playbook reproduces protocol v1.3's prompt exactly, and a test proves it.
**Why:** KELQOR serves many industries. Home services was the first test market, and the fixed segment sentence in
the prompt made every other company "not a fit" by definition.
**Revisit:** before the next research run (M2B), which needs a general research playbook and a new protocol
version.

## 022 — Claude scoping stays off until it has spending controls (2026-10-27)
**Decision:** `AI_SCOPING_AUTHORIZED` is false. Every scope comes from the catalog template, whatever keys are set,
and no caller can force AI on.
**Why:** the path had no dollar cap, kept no record of prompts, and public sign-ups could trigger it. The owner
authorized no paid model calls.
**Revisit:** M2B, with a spending limit, an owner authorization, safe failure behaviour, and the shared
provider interface and pricing.

## 023 — AI missions run only through the controls' metered pathway (2026-10-28)
**Decision:** every mission request goes through `meteredRequest` in `src/lib/controls`: a read-only pre-check, a
token count under a count ticket, one database transaction that checks the approval, the owner's authority and the
$2 mission, $5 day and $20 month caps (America/Boise) and records the reservation, then the request under a single-use
send ticket. Provider adapters refuse to send without a live ticket, and the SDKs' own retries are off.
**Why:** the owner's limits must hold whatever the window or a bug asks for, and a request that may have reached a
provider must never count as free. Unknown outcomes are held as unverified at the full reservation until reconciled.

## 024 — One owner account holds spending authority; demo sign-in is off in the real database (2026-10-28)
**Decision:** `users.spending_authority_at` can be set on one account only, never a demo account or a non-operator,
and only by `npm run designate-founder` with that account's password. Migration 0004 turns off password sign-in for
every demo account. Acceptance runs re-enable a test operator only in their own isolated copy.
**Why:** the seeded accounts share a password in the repository, and the demo operator could otherwise have approved
spending.

## 025 — Missions read the company's site and approved sources only; no open-web search (2026-10-28)
**Decision:** the page reader's scope is the company's own site plus approved research sources. Search grounding stays
off. Sources found during a mission are proposed and not read until approved.
**Why:** grounding is billed per query with no per-request cap, so its cost can't be bounded. Controlled discovery is
M2C, each mechanism under its own approval.

## 026 — Research results are versions beside the frozen record; simulation never becomes research (2026-10-28)
**Decision:** a completed real mission adds a research or industry version and overwrites nothing; the database refuses
one from a simulated mission. Industry versions are used as context only after the owner marks them reviewed.
**Why:** the benchmark stays comparable, and nothing labeled simulated can pass for evidence.

## 027 — The real database is migrated only after a fresh verified backup (2026-10-28)
**Decision:** `openDb` refuses to apply a pending migration to `.data/pglite` unless `npm run db:backup` verified a copy
taken since the database last changed.
**Why:** the installed app starts its backend from the project folder, so a branch switch alone could otherwise migrate
the owner's data without a backup.
