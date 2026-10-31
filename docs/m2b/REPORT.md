# Milestone 2B completion report (Gate 1: built and tested)

2026-10-28. KELQOR 0.2.0, local branch `kelqor/m2b`, local commits only (nothing pushed). Built by the implementation agent and
The security reviewer agent; see [PLAN.md](PLAN.md) for who owned what. No paid AI request was made: every mission so far was
simulated ($0, no AI) or used invented test costs on an isolated copy. A simulated success is not evidence that live
execution works; that is Gate 2.

## the implementation agent (Lead Systems Engineer)

**Built**

- **Missions:** create, edit, submit, approve, reject, start, resume, cancel, add review, accept with issues, close.
  Each owner action carries a request id and acts once. One executor inside the backend runs a mission step by step,
  saves after every step, and never starts one by itself. At start-up, missions left running become Interrupted.
  Closing KELQOR during a mission warns first.
- **Mission A, company research v2.0** (any industry; no outreach drafts) and **Mission B, industry research v1.0**
  (approved sources only): report schemas, prompts and briefs; $0 simulated providers; Claude review (cited pages read
  again, changed pages reported, a verdict per claim, claims only moved down).
- **Providers:**
  - **Gemini:** the mission adapter uses Google's token counter and sends the approved thinking level. It honors
    cancellation and redeems a single-use ticket before every call. The SDK's automatic retries are off: by default it
    retries up to four times, which would send requests no budget covered.
  - **Claude:** the review adapter uses the same pattern with Anthropic's counter, no retries and no caching.
  - The frozen benchmark's adapter is unchanged.
- **Sources:**
  - The page reader's scope is the company's own site plus approved sources.
  - The sources are kept as versioned records.
  - Claude's starter list proposes 38 sources over seven industries plus general ones; none is read until you approve it.
  - A source found during a mission is proposed, not read.
- **Evidence checks:** eight categories, of which AI may assign four, and checks only move a claim down. They check
  quotes against the pages served, flag citations outside the approved list, content more than 12 months old and
  revenue-impact claims, and check contact channels. They send a mission to Needs review for a failed identity claim,
  more than one quoted claim in five failing, or a rule breach.
- **Results:**
  - Company research versions sit beside the frozen dossier ("Historical: benchmark dataset B, frozen").
  - A company researched for the first time gets its own Opportunity Center entry (`n0001` and on), where decisions,
    checks and discovery work as in M2A.
  - Industry research versions carry Mark reviewed.
  - Customer-reported figures stay estimates until you validate them.
- **AI Operations:** Missions, New mission (with the estimate), Approval Center, mission detail (live state, step log,
  cost, ledger, results), Spending (remaining amounts, the ledger, reconciliation, benchmark history kept separate),
  Sources, Industry intelligence, Capabilities.
- **Database:**
  - Migration 0004 is additive and turns off demo sign-in.
  - KELQOR now refuses to migrate your database without a fresh `npm run db:backup`.
  - It can be rolled back with `npm run db:rollback-m2b`.
- **Docs:** roadmap (M2B built, M2C proposed), ADRs 023–027, architecture, README, [ROLLBACK.md](ROLLBACK.md).

**Provider and mission status**

| Provider | State |
| --- | --- |
| Gemini (research) | Built; tested only with fake clients; first live use at Gate 2 |
| Claude (review) | Built; unavailable for real missions (no Anthropic key); the simulated reviewer works |
| Simulation | Working end to end in the installed app |

**Remaining functional limitations**

- Research quality is unproven until real missions run.
- Gemini token counting is unverified live: KELQOR counts an equivalent standard request and adds 15% plus 512 tokens.
  Gate 2 compares the count with Google's reported input.
- Two new-company missions finishing at the same instant could collide on the new entry's number. The second would end
  Interrupted with its research kept.
- A Claude review added after the research that then fails can't be retried. The mission can only be accepted with
  issues or closed.
- A mission keeps the approved-source list it started with, even if a source is retired while it runs.
- A few malformed requests answer with a server error rather than a validation error (an unknown provider on
  reconciliation; a refused test mode on the options route).
- The close warning is skipped when no one is signed in.
- If the database needs a backup when the backend starts, every request fails until you run `npm run db:backup` and
  open KELQOR again.

## the security reviewer agent (Security, Controls & Verification Engineer)

**Security and authorization, verified**

- **Owner authority:**
  - The database lets one account at most hold it, and never a demo account, a non-operator or an account with sign-in
    off.
  - Only `npm run designate-founder`, with that account's password, grants it.
  - Moving or revoking it voids every open approval.
  - It is checked again on every paid request.
- **Demo accounts:** sign-in is off and their existing sessions end; their records stay.
- **Approvals:** each binds the exact scope's fingerprint and expires at Boise midnight. The 25-hour day on
  November 1, 2026 is handled. There is one open approval per kind, and any edit voids it.
- **Tickets:** they live in a private map, can be used once, and are bound to the exact request. Forged, reused,
  swapped and mislabelled tickets are all refused.
- **Static checks:** the SDK calls live only in the adapters, and only the command-line tools can grant authority.
- **Keys:** they never reach the ledger, errors, logs or desktop responses (tested with fake keys).
- **Routes:** clients and builders are refused on every mission route.
- **Scoping:** Claude scoping stays off even with a key present.

**Budgets and the ledger**

- **Caps:**
  - $2 per mission, $5 per Boise day and $20 per Boise month are enforced across missions and at the day and month
    boundaries.
  - Under concurrency, eight missions raced for $1.20 of today's budget and exactly five requests were sent.
  - Retries and repairs are reserved and counted.
- **Uncertain outcomes:** a request that may have reached the provider counts in full as unverified until reconciled.
  A reply over its reservation settles and stops that provider. A reply reporting no usage is unverified, never $0.
- **The ledger:** append-only, enforced by database triggers in migration 0005.
- **Reconciliation:** owner-only and append-only; a release never goes below what is settled.

**Defects found and resolved**

| # | Severity | Defect | Resolution |
| --- | --- | --- | --- |
| B1 | Blocker | The installed 0.1.3 app could have migrated your database with unfinished M2B code and no backup, because it starts its backend from the project folder | The project folder stayed on 0.1.3 until release; both agents built in separate worktrees; KELQOR now refuses to migrate without a fresh verified backup |
| V1 | Material | A review resumed after an interruption could leave a mission showing Running with nothing running | Fixed; regression test |
| V2 | Low | An empty usage report counted as reported | Fixed in the adapters and the controls |
| V4 | Medium | Editing an approved mission was refused instead of voiding the approval | Fixed: the edit voids it and returns the mission to Awaiting approval |
| V5 | Medium | A review whose approval lapsed was skipped and the mission completed | Fixed: the mission goes to Needs review |
| Low items | Low | Four of ten | Fixed; the other six are listed as limitations above |

**Remaining financial and operational risks**

- **Billing ceilings:** Google and Anthropic offer no per-request billing ceiling. KELQOR caps what it sends; it can't
  cap what they bill. Reconciliation against their consoles catches differences.
- **Unverified charges:** they hold budget until you reconcile them. This is deliberate.
- **Shared database:** the shared-Postgres concurrency path (`DATABASE_URL`) is untested; there is no Postgres server
  here.
- **Haiku pricing:** Claude Haiku 5.5 above 100,000 input tokens is refused until its price is recorded.

**Independent acceptance recommendation:** go to Gate 1 once V4 and V5 are fixed and their tests pass. Both are done.

## Joint result

- **Automated tests:** 236 pass, 0 fail. That's 125 from M1 and M2A, plus 111 for M2B: controls 49, security 27,
  verification 5, missions 21, integration 9.
- **Installed app:** KELQOR 0.2.0 passed its full acceptance run, 106 of 106 checks: 55 for M1, 13 for M2A and 38 for
  M2B. The run used an isolated copy of your data, simulated missions and invented test costs; results are in
  `desktop\out\acceptance\0.2.0\results.json`, with screenshots. In the window, it showed:
  - a non-founder operator drafting a mission but being refused approval and start, including directly at the backend;
  - a demo account that can't sign in, and the owner approving exactly the scope shown;
  - an edit after approval voiding the approval;
  - two simultaneous starts starting once;
  - simulated company and industry missions completing at $0 with quotes verified against the pages read, and only
    approved sources read;
  - the simulated Claude review re-reading cited pages;
  - an unreadable site failing without sending anything;
  - the mission maximum, the $5 day cap and the $20 month cap each stopping spending;
  - a cancel mid-request, and a forced close mid-request, leaving the mission Interrupted with the request held as
    unverified, nothing resuming by itself, and the owner resuming it;
  - reconciliation with a figure and a release;
  - no key anywhere the window can read.
- **Defects the acceptance found:**
  - **Fixed:** Next.js loads the database module twice, so the routes didn't recognize the isolated test copy. Test
    mode was refused there, failing closed. The record of each database's location is now shared across both copies.
  - **Test-harness fixes:** the window title read too early, a forced process stop treated as fatal, sign-in waits,
    one list-click race, and a missing redirect in the test pages.
- **Your data:**
  - **The migration:** a census compared copies taken before and after it. Every existing table kept its row count, and
    your decisions, discovery records, Work Orders, payments, companies, events and outbox are byte-for-byte unchanged.
    The nine new tables are empty. Sign-in is off for the five demo accounts and on for every other account, yours
    included. No account holds owner authority yet.
  - **The backup:** `.data\pglite-backup-2026-10-28-pre-m2b`, 1,100 files (41.7 MB), verified file by file.
  - **The frozen benchmark:** research, both ledgers and the dossiers are unchanged.
  - **After the acceptance runs:** a fresh census of your database matches the post-migration one exactly. Its only
    write since the migration was KELQOR opening once after the installer, before any acceptance run.
- **Rollback:** [ROLLBACK.md](ROLLBACK.md).
  - **App:** reinstall from `desktop\out\kept-installers\KELQOR-Setup-0.1.3.exe`.
  - **Code:** `git switch kelqor/desktop-m1`.
  - **Database:** restore the backup, or run `npm run db:rollback-m2b -- --confirm`.
- **Gate 1 status:** M2B is built and tested with simulated providers (236 automated tests and 106 installed-app checks pass). Gate 1 also needs your account designated
  (below) and your walkthrough with simulated missions.
- **For live verification (Gate 2):**
  1. Designate your account.
  2. Walk through it.
  3. Give a separate, explicit authorization in chat for one paid mission, with prices checked that day.
  4. Review its result and reconcile the month against Google's console.

  A Google project and key used only by KELQOR would make reconciliation exact.
- **Proposed first live mission:** company research on Boise Metal Works (c01, manufacturing), with Gemini 4 Argon,
  Claude review off and a $1.00 maximum.
  - Before November 30, its benchmark cost suggests about $0.15 to $0.30.
  - Each request reserves about $0.20 to $0.35 before it is sent, so $1.00 leaves room to finish.
  - From November 30 prices double, and I'd raise the maximum to $1.50.

## Open items for you

- **Designate your account:** close KELQOR, then run `npm run designate-founder -- --email you@example.com` in
  the project folder. It asks for your password. Nothing can be approved, even a simulated mission, until you do.
- **Paid state:** the authorization says Running is the only paid state, but Claude review runs in Verification. The
  build allows research requests only in Running and review requests only in Verification.
- **Reconciliation dating:** an adjustment is dated when you record it, so it reduces today's and this month's
  remaining budget. Please confirm this reading.
- **Crofts Electric (c05):** your note restore is still waiting for your choice.
