<!-- A copy of the Milestone 2B authorization (revised draft, revision 6) from my decision notes, which stay private. The owner approved it for implementation on 2026-10-28 (Gate 0) with the two-agent instructions summarized in docs/m2b/PLAN.md. -->

# KELQOR — Milestone 2B implementation authorization

2026-10-27

**Approved for implementation in chat on 2026-10-28 (Gate 0).** Paid requests still need their own authorization (Gate 2). Implementation begins only when you approve this document in chat. It replaces your M2B review draft and applies your eleven decisions.

## Status and approval

- **Status:** revised draft for your review. Nothing in it is authorized yet.
- **Replaces:** your “Milestone 2B — Final Scoped Implementation Authorization — Owner Review Draft”, with your eleven decisions applied.
- **Starting point:** KELQOR 0.1.3, branch `kelqor/desktop-m1`, commit `0e46a42`.
- **To authorize implementation:** reply in chat that you approve this document, with any changes. That is Gate 0 (see Release gates). A note or setting in this document doesn't count as approval.
- **Spending:** approving this document authorizes no spending. The limits below are ceilings, not authorizations. The first paid request needs its own approval at Gate 2.

## Objective

Turn AI Operations into a working command center for AI missions you control: real on-demand execution, evidence-based results, enforced spending limits, durable accounting and clear approvals. It is the execution foundation for a universal managed-AI services company, not a dashboard of simulated agents.

M2B delivers two mission types, company research and industry research, with Gemini as the research provider, optional Claude review, and the controls around them. Everything is built and tested with simulated providers first. One real, capped mission then proves it live.

**Principles**

- Reuse what works: the benchmark's provider layer, cost calculation, page reader, evidence checks and simulated provider.
- The backend enforces every rule; the window only asks.
- Fail closed: when a cost, price, approval or budget can't be established, nothing is sent.
- Research prepares discovery. It never confirms a problem or validates money.
- Real, simulated, historical and planned work are always labeled as such.

## Boundaries

**Authorized once you approve this document (Gate 0)**

- Local source changes in the project folder on a new local branch, `kelqor/m2b`, starting from `0e46a42`, with local commits.
- Database migration 0004 after a verified backup (`.data/pglite-backup-<date>-pre-m2b`). It adds tables and columns only, and it turns off password sign-in for the five seeded demo accounts in your real database (see Owner authority and approvals).
- A local command, which you run, that designates your account as the only owner spending authority.
- Starter source lists for each industry, which I propose and you approve in the app before any mission reads them.
- Tests, packaging and installing KELQOR 0.2.0 on this PC. The 0.1.3 installer is kept for rollback.
- Simulated missions, which call no AI provider and cost $0. A simulated mission you start in the app reads a company's public pages the way research does. Automated tests use local test pages only.

**Not authorized by this document**

- Any paid AI request, Gemini or Claude, including the Gate 2 mission.
- Adding, changing or activating API keys. If a key is ever needed, you add it to `.env.local` yourself.
- Contacting anyone (email, outreach, calls, forms or messages), purchases, and new subscriptions or paid services.
- Deployment, hosting or cloud resources; GitHub pushes, pull requests or merges.
- Claude Work Order scoping, which stays off.
- Control of Claude Code or Antigravity, background agents, and customer AI agents.
- Name or branding changes; changes to frozen research, benchmark ledgers or historical records; deleting operational data.

**Always preserved**

- Milestone 1: the installed app, Headquarters, Business Workspace, Work Orders, decisions, reporting, the backend connection and sign-in.
- Milestone 2A: classifications, dossiers, evidence levels, owner checks, discovery conversations, confirmed problems, software and outcome records, solution matching, readiness and the Work Order hand-off.
- The frozen benchmark: prompt v1.3, dataset B (`dataset-b-v1`), both ledgers and every saved dossier, all read-only.

Any regression found during M2B is fixed before M2B is reported as built.

## How your decisions are applied

| # | Your decision | Where it's applied |
| --- | --- | --- |
| 1 | Search grounding off; reviewed source lists; discovery of companies and sources kept on the roadmap; gaps reported, never filled | Sources; Roadmap |
| 2 | Output cap counted once, 20,000-token limit tested, counted input, dated prices, a model per task, fail closed | Providers and models; Spending controls |
| 3 | Unknown charges reserved at the maximum and counted as unverified until reliable evidence; manual reconciliation | Spending controls; Usage ledger and reconciliation |
| 4 | Owner-only spending authority enforced by the backend; seeded accounts and the shared password dealt with first | Owner authority and approvals |
| 5 | Two gates: Built and tested, then Live verified | Release gates |
| 6 | Claude review off by default, approved per mission, inside the same caps, simulated until authorized | Providers and models; Evidence and verification |
| 7 | Claude Work Order scoping outside M2B | Boundaries; Roadmap |
| 8 | Interrupted and Needs review states; approvals bound to scope and expiring at the end of the Boise day | Mission lifecycle and recovery; Owner authority and approvals |
| 9 | Versioned industry records; no automatic playbook changes | Industry intelligence and the Opportunity Center |
| 10 | Historical levels kept; new categories for new research; customer-reported money kept apart from validated money | Evidence and verification |
| 11 | Labeled $0 simulated missions in the app, never mixed with real records or budgets | Providers and models; Testing and acceptance criteria |

## Mission types

### Mission A — Company research and discovery preparation

- **Subject:** a company already in the Opportunity Center, or a new one (name, official website, town and state; the industry is optional).
- **Protocol:** company research v2.0. It's a general protocol that draws on the industry's playbook and on industry intelligence you've reviewed. Benchmark protocol v1.3 stays frozen.
- **Reads:** the company's own website (up to 20 pages, as today) and the approved sources for its industry.
- **Produces:** verified identity and an operational profile; existing software and observable processes, where evidence supports them; observed technical issues and inconsistencies; industry-informed hypotheses, labeled as such; what public information can't show; possible solutions, existing tools and simple configuration first and custom AI last; discovery questions; business contact channels; sources, limitations, source gaps, and estimated and actual cost.
- **Contact channels:** business-level only: main phone, contact form address, general email. Named people only when the company's own site presents them as owners or managers. The current rules carry over: no social media, review sites or job boards, and no careers addresses.
- **Never:** contacts anyone, submits a form, signs in, claims an issue caused lost revenue, or marks a problem customer-confirmed. Protocol v2.0 doesn't draft outreach messages.

### Mission B — Industry intelligence and operational pain points

- **Subject:** an industry from the list, optionally narrowed to a category or operating model (for example, “metal fabrication job shops”) and a region.
- **Protocol:** industry research v1.0 (new).
- **Reads:** approved sources for that industry, plus approved general sources such as federal agencies.
- **Produces:** how these businesses operate, with their usual processes and roles; their workflows (scheduling, estimating, purchasing, operations, finance and others); common bottlenecks and administrative burdens; common software; regulatory and operational considerations, flagged for professional verification; what conventional automation or AI could improve, and what needs human or specialist review; realistic managed-AI services KELQOR could deliver; discovery questions; and source gaps.
- **Reuse:** each record serves many companies as hypotheses to test, never as facts about any one business.
- **No default industry:** construction and home services are supported like any other industry.

## Sources

**How missions find information in M2B**

- **No open-web search.** Google Search grounding stays off: Google bills it per search and offers no per-request limit, so its cost can't be capped.
- **One page reader.** Missions read pages only through KELQOR's existing reader. It honors robots.txt, identifies itself, never signs in or submits forms, refuses private network addresses, and keeps its blocked-domain list. Missions see only what any visitor sees: no probing, scanning, logins or test submissions, and no access to private analytics, customer data or business systems.
- **Approved sources.** The reader's scope widens from “the company's own site” to “the company's own site plus approved sources”. An approved source is a domain or address prefix with a name, a kind (government agency, trade association, regulator, technical resource or industry publication), the industries it serves, its purpose, and who approved it and when.
- **Starter lists.** I propose a starter list for each industry. Nothing on it is read until you approve it in the app. You can add, approve or retire sources at any time, and every change is kept as a version.
- **Proposed sources, at no extra cost.** When a page read during a mission links to a promising source outside the list, the report records it as proposed. It isn't read during that mission; you approve or reject it.
- **Gaps, never filler.** When the sources can't establish something, the report says what is missing and what kind of source would settle it. A claim without a source can be an industry-informed hypothesis at most.

**What M2B can't do**

- Find new companies or new sources by itself, beyond the proposals above. This stays a roadmap requirement (see Roadmap).
- Use state registries and licensing look-ups that need a search form. These stay your own checks.

## Providers and models

| Provider | Role in M2B | State at Gate 1 |
| --- | --- | --- |
| Gemini (Google) | Research for both mission types | Built and tested with simulation only; first live use at Gate 2 |
| Claude (Anthropic) | Optional review, off by default | Built; simulated reviewer only, since no key is configured |
| Simulation | $0 practice missions and tests | Working |

**Models**

- Each mission names its model. The defaults are Gemini 4 Argon for both mission types, with Gemini 3.8 Flash also available.
- The mission form shows each model's estimate before you choose.
- Only models with a recorded price can be chosen.

**Requests**

- **Output limit:** 20,000 tokens per request, thinking included. In the frozen full run, the largest of the 250 requests used 12,734 tokens on Argon and 14,441 on Flash.
- **Thinking level:** set explicitly and recorded. It guides how much the model thinks but doesn't cap it; the output limit does.
- **Cut-off responses:** a response stopped at the output limit is retried once within the mission's budget, then marked for review.
- **Counted input:** input tokens are counted with Google's token-counting endpoint before every request. Known risks explains its limits.

**Prices**

- A dated price table, extending today's.
- **Gemini 4 Argon:** $2 per million input tokens and $10 per million output tokens through November 30, 2026, then $4 and $20.
- **Gemini 3.8 Flash:** $0.75 and $3.75 through December 31, 2026, then $1.50 and $7.50.
- **Claude reviewers:** prices are added from Anthropic's table when built: Opus 5.5 $4 and $20, Sonnet 5.5 $2 and $10, Haiku 5.5 $0.10 and $0.50 (higher above 100,000 input tokens).
- Every ledger entry records the price version used.
- Within 24 hours of a listed price change, the higher price applies, because Google gives dates without a time zone.

**Claude review**

- Off by default, and requested per mission. You choose the reviewer model.
- It counts toward the same $2 mission limit and the daily and monthly caps.
- With no Anthropic key, review shows “Unavailable” and no Claude request can be made. Live review needs a key you add yourself and a separate authorization.

**Claude Work Order scoping** stays off. Template scoping keeps working unchanged.

**Simulation**

- **Simulated missions in the app:** labeled “Simulated, no AI, $0” everywhere. They go through the full approval and run flow and read public pages like real missions. They never create research or industry records, never appear as research in the Opportunity Center, and never count toward budgets.
- **Synthetic-cost provider:** test-only. It reports invented usage so that caps, unknown charges and reconciliation can be tested. The backend refuses to start with it switched on against your real database.

## Spending controls

| Limit | Ceiling | Period |
| --- | --- | --- |
| Per mission | $2.00 | The mission's whole life, across its approvals, retries and review |
| Per day | $5.00 | Calendar day, America/Boise |
| Per month | $20.00 | Calendar month, America/Boise |

These are ceilings, not spending authorization. They cover every paid request KELQOR sends: research steps, retries, format repairs and Claude review. A mission's maximum can be set below $2.

**Before every paid request**

1. Count the request's input tokens.
2. Work out its maximum cost: the counted input at the input price, plus the 20,000-token output limit at the output price. The output limit is counted once, because Google documents it as a hard cutoff that includes thinking.
3. In one database transaction, check that the approval is valid for this mission, its scope and its approver; check that adding the maximum to what's already committed keeps the mission, the day and the month within their caps; then record the reservation. If any check fails, nothing is sent and the mission becomes Budget blocked or Interrupted, with the reason recorded.
4. Send the request.

Committed means settled costs, plus unverified costs, plus open reservations. A cost counts on the Boise day and month in which its request was sent. Concurrent missions can't overspend, because reservations pass through the database one at a time.

**After the request**

| What happened | Recorded as | Counts against the caps |
| --- | --- | --- |
| A response with usage | Settled at Google's reported usage and the price version; the rest of the reservation is released | The settled cost |
| Refused before processing: connection refused, invalid request, bad key or rate limit | Not billed, with the reason | Nothing |
| May have reached the provider, with usage unknown: a timeout after sending, a dropped connection, a server error, or KELQOR or its backend stopping mid-request | Unverified, at the full reservation | The full reservation, until reliable evidence supports an adjustment |
| Reported cost above the reservation | Settled at the actual cost; further requests to that provider are blocked until you review | The actual cost |

**Retries:** each retry is a new reserved request. At most two retries per step; three errors in a row fail the mission, and repeated rate limits stop it. Nothing retries after a mission ends.

**Fail closed:** nothing is sent when the model has no price, the input can't be counted, the approval is missing, expired or for a different scope, the approver lacks spending authority, or a cap can't be confirmed.

**What you see:** remaining amounts for today, this month and each mission; committed, settled and unverified spending; and every request in the ledger. The benchmark's historical $6.57 ($0.51 dry run, $6.06 full run) is shown separately, read from its frozen ledgers and never counted toward M2B's caps.

**What these controls can't do:** Google offers no per-request billing ceiling, so KELQOR caps what it sends, not what Google bills. Reconciliation catches any difference afterwards.

## Owner authority and approvals

**Owner spending authority**

- Only one account can hold owner spending authority: yours. Only that account can approve a mission, start or resume one, add Claude review, or release an unverified charge.
- You grant it by running a local command while KELQOR is closed, `npm run designate-founder -- --email <your email>`, which asks for that account's password. No screen and no backend route can grant or change it, so no account can grant it to itself. Granting and revoking are recorded in the audit log.
- The database refuses it for demo accounts and for anyone who isn't an operator.
- The backend checks it on every paid request, not only at approval.

**Seeded demo accounts**

- All five seeded accounts share the default password in the repo's seed script: the demo operator “Morgan (ForgeX ops)”, two demo clients and two demo builders. They are already flagged as demo in your database.
- Migration 0004 turns off password sign-in for every account flagged as demo in your real database. Their demo records stay.
- The acceptance run turns a test operator back on only inside its own isolated copy.
- After M2B, the README's demo logins work only in a freshly seeded or test database.

**Approvals**

- An approval covers one mission's exact scope: type, subject, protocol version, provider, model, thinking level, output limit, maximum cost, whether Claude review is included and with which model, and the approving account.
- Any change to those after approval voids it, and the mission returns to Awaiting approval. An approval can't be used for another mission.
- It expires at the end of the Boise calendar day on which you gave it. If it expires during a run, no further paid request is sent, and the mission becomes Interrupted until you renew it.
- Adding Claude review later needs its own approval, which must fit the mission's remaining $2 and the day and month caps.
- One approval covers every step of its mission (research steps, page reads, retries and repairs) within its maximum, so routine steps never need re-approval.
- Double clicks, two windows, retries and reconnections can't start a mission twice: each action carries a request id, and a mission can move from Approved to Running only once.
- The Approval Center also lists what can never be approved in M2B: contacting anyone, email, purchases, deployment and Claude scoping.

## Mission lifecycle and recovery

Draft → Awaiting approval → Approved → Running → Verification → Completed

Other outcomes: Needs review, Interrupted, Budget blocked, Rejected, Failed and Cancelled.

| State | Meaning |
| --- | --- |
| Draft | Editable; not submitted |
| Awaiting approval | Submitted; editing returns it to Draft |
| Approved | Approval valid; waits for you to start it. Nothing starts when KELQOR opens |
| Running | The only state in which paid requests are sent |
| Verification | Automated checks, then Claude review if approved |
| Completed | All the conditions below are met |
| Needs review | A check failed or the review found problems; evidence and partial results are kept. You accept it with its issues listed (Completed with issues) or close it as not usable (Failed); both stay on record |
| Interrupted | The backend stopped, KELQOR closed, the connection dropped or the approval expired while it ran. It never resumes by itself; you resume or cancel it |
| Budget blocked | The next request didn't fit a cap and wasn't sent. You resume it when budget is available, with a valid approval |
| Rejected | You declined it at approval |
| Failed | It can't continue: a bad key, a provider refusal, an invalid report after one repair, or repeated errors. Partial work and costs are kept |
| Cancelled | You stopped it. No further paid request is sent; a request in flight is abandoned and recorded as unverified unless its response arrives |

**Completed requires all of these**

1. The report matches its format.
2. Every claim above an industry-informed hypothesis cites a page read during the mission, and its quote was found there. Claims that fail are downgraded to unsupported. A failed identity claim, or more than one in five quoted claims failing, sends the mission to Needs review.
3. No rule is breached.
4. If Claude review was approved, it finished without finding a verified fact unsupported.
5. Every request in the ledger is settled, not billed, or unverified with its reason recorded.

**Recovery**

- **When the backend starts:** missions left Running or in Verification become Interrupted, and reservations left open become unverified. Nothing is resent.
- **Resuming:** an unfinished mission keeps its working conversation, including the text of pages it has read, so it can resume at the step it reached without paying again for finished steps. When the mission ends, that page text is removed; as today, only fingerprints, quotes and page details are kept.
- **Closing KELQOR during a run:** KELQOR warns you and offers to wait, because closing stops the backend and the request in flight then counts at its maximum.
- **Reconnecting:** the window shows the mission's true state from the backend and never resends a request.

## Usage ledger and reconciliation

**Ledger**

- Every AI request, token counts included, is recorded in the database before it is sent and updated afterwards.
- Each entry records:
  - the mission and approval;
  - the attempt and its purpose;
  - provider, model and price version;
  - the time sent, with its Boise day and month;
  - the provider's request id, when there is one;
  - counted input tokens and the output limit;
  - the reserved amount;
  - reported usage (input, cached input, output, thinking and tool use);
  - actual cost and status (reserved, settled, not billed or unverified);
  - error details, with keys redacted;
  - simulated or synthetic flags;
  - any reconciliation applied.

- Entries survive restarts and are never edited away. Partial, failed, timed-out and cancelled missions keep theirs.
- API keys stay in the backend. They never appear in desktop responses, logs, the ledger or exported research, and credential detection still checks every response.

**Manual reconciliation, with no billing credentials**

1. In AI Operations › Spending, choose a provider and a month (or a day).
2. KELQOR shows its settled and unverified totals for that period and lists each unverified request.
3. You look up the provider's own figure for the same period in its console, then enter it with a note on where you read it.
4. KELQOR compares the two. If the provider shows less than KELQOR's settled plus unverified total, you may release unverified amounts down to the provider's figure, never below the settled total. If the provider shows more, the difference is recorded as an unverified adjustment that counts against the caps until you resolve it.
5. Every reconciliation and release is a new record; nothing is edited or deleted.

Provider dashboards update late, may use other time zones, and total a whole project. Compare whole months where you can, and use a Google project and key used only by KELQOR, so its figures are KELQOR's alone.

## Evidence and verification

**Historical research** keeps its three levels, unchanged: level 1, verified company information; level 2, observed defect; level 3, hypothesis or unverified.

**New research** uses these categories:

| Category | Assigned by | Requirement |
| --- | --- | --- |
| Verified identity or company fact | Research | A cited page read in this mission, with the quote found on it |
| Publicly observed technical defect | Research | Seen on a page read, with the quote or page detail found; no claim of impact |
| Supported inference | Research | Reasoned from cited facts or defects, which it names |
| Industry-informed hypothesis | Research | From reviewed industry intelligence or general industry knowledge; something to ask in discovery |
| Unsupported or unverified | Automatic checks | An unread source, a quote not found, or no source |
| Customer-confirmed problem | You, in a recorded discovery conversation | As in M2A |
| Customer-reported financial estimate | You, from what the customer said | The figure, its period, and the customer's basis |
| Validated financial impact | You, after assessing it | Your calculation and the supporting evidence, such as the customer's own exported data |

- AI can assign only the first four categories. Checks and review can only move a claim down, never up.
- No AI step can create a customer-confirmed problem, a customer-reported figure or a validated impact.
- A customer's number stays an estimate until you record the calculation and the evidence that validate it.

**Automated checks** carry over from the benchmark and are extended:

- Quotes are checked against the page cited, as served during the mission. Sources that weren't read are flagged. Links are checked against the pages they came from, and contact channels are checked.
- The existing rule flags stay, including careers addresses, people not presented as owners or managers, and inferences without a source.
- New: every cited source must be the company's site or an approved source; claims resting on dated content more than 12 months old are flagged as possibly stale; any claim of revenue impact is flagged.

**Claude review, when approved**

- It reads the report and the cited pages, read again through KELQOR's page reader at review time. The estimate shown before you approve includes those pages' tokens.
- Each read keeps the address, retrieval time, content fingerprint and status. The review reports pages that changed since the research, and whether each quote is still there.
- It gives each claim a verdict: supported, overstated, unsupported or source changed. It can't raise a claim's category or confirm a problem.
- If the review fails or can't fit the budget, the research is kept and the mission goes to Needs review.

**Not stored:** full page text isn't kept after a mission ends. A source version is its fingerprint, retrieval time, status and the quoted passages. A review can show whether a page or quote changed, but not what the whole page said before.

## Industry intelligence and the Opportunity Center

**Industry intelligence records**

- Mission B results are saved as versioned records in the database, one series per industry, with an optional category and region.
- A new mission adds a version and never overwrites an earlier one. Each version keeps its mission, protocol, model, sources, gaps and categories.
- You can mark a version Reviewed. Mission A uses an industry record as context only after you've reviewed it.
- Nothing rewrites the playbooks. Moving reviewed questions or sources into a playbook is a separate change, made only after you review it.

**Company research in the Opportunity Center**

- A completed Mission A appears on the company's page as a new research version, with its mission number, protocol, model, date and cost. The benchmark dossier stays beside it, labeled “Historical: benchmark dataset B, frozen”.
- A company researched for the first time gets its own Opportunity Center entry. Your decisions, checks and discovery records work for it exactly as in M2A.
- AI results never change your decisions, discovery records, confirmed problems, readiness or Work Orders. Research alone still never moves a company past “Ready for discovery”.

## AI Operations in the Windows app

AI Operations becomes the command center. Every mission has a number, such as M-0001.

1. **Missions:** every mission with its type, subject, model, state, cost (actual, unverified and maximum) and a Real or Simulated label.
2. **New mission:** the type, subject, scope and model; Claude review (off) and the maximum (up to $2); the estimate, typical and maximum; then save it as a draft or submit it.
3. **Approval Center:** missions awaiting you, each with its business purpose, scope, provider, model, estimate, maximum and the remaining budgets. You approve or reject; the actions that can never be approved are listed.
4. **Mission detail:** live state and step log, cost so far, Cancel and Resume. Results with their categories, sources with retrieval times, checks, gaps, review results and errors.
5. **Spending:** remaining amounts, the ledger, unverified items and reconciliation, with historical benchmark spending kept separate.
6. **Sources:** approved lists per industry, and proposed sources waiting for you to approve or retire.
7. **Industry intelligence:** records and their versions, with Mark reviewed.
8. **Capabilities:** what is working, simulated or planned (M2C, M3, M4 and M5).

**Operating functions** are functions, not agents:

| Function | In M2B |
| --- | --- |
| Sales & Research | Working: Missions A and B |
| Verification | Working: automated checks; Claude review once authorized |
| Finance & Reporting | Working for AI spending: ledger, budgets and reconciliation |
| Operations Coordinator | Working as your mission queue, approvals and recovery, with no autonomous agent |
| Engineering | Planned for M3 |
| Customer Support | Planned for M4 |
| Shared Learning & Memory | Planned; reviewed industry records are a first building block |

## Reused and new components

**Reused**, extended where noted. The benchmark runner keeps its own settings, ledger files and prompt fingerprint test, so it still behaves exactly as it ran.

| Component | Where | Change in M2B |
| --- | --- | --- |
| Provider-neutral model interface | `src/lib/ai/types.ts` | Small additions: request purpose and cancellation |
| Gemini adapter (stateless, keys redacted) | `src/lib/ai/gemini.ts` | Token counting, explicit thinking level, cancellation |
| Price table and cost calculation | `src/lib/ai/pricing.ts` | Output limit counted once for missions; price versions; Claude prices; price-change rule |
| Research loop | `src/lib/research/agent.ts` | Uses the mission spending service, saves after every step, checks the approval before every paid request, records unknown charges |
| Page reader and robots.txt handling | `src/lib/research/fetcher.ts`, `html.ts`, `robots.ts` | Approved-source scope and source versions |
| Report schema and checks | `src/lib/research/schema.ts`, `agent.ts` | Company research v2.0 schema with categories and gaps; new checks |
| Simulated provider | `src/lib/research/simulated.ts` | Both mission types, plus a test-only synthetic-cost variant |
| Playbooks | `playbooks/`, `src/lib/playbooks.ts` | Reviewed starter source lists |
| Discovery records | `src/lib/domain/discovery.ts` | Customer-reported figures and their validation |
| Desktop API, bridge and IPC | `src/lib/desktop/`, `desktop/src/` | Mission routes and methods |
| Sign-in, roles and audit log | `src/lib/auth/`, `events` | Owner authority checks |
| Anthropic SDK 1.3.0, already installed | `package.json` | Used by the new Claude adapter |
| Acceptance run | `desktop/scripts/acceptance.mjs` | M2B checks |
| Benchmark runner, prompt v1.3, dataset B and ledgers | `scripts/benchmark-gemini.ts`, `src/lib/research/spec.ts`, `research/` | None: frozen |
| Claude scoping lock | `src/lib/scoping/ai.ts` | None: stays off |

**New**

1. Mission service: create, edit, submit, approve, reject, start, cancel and resume, with scope fingerprints.
2. Mission runner, inside the backend: step-by-step execution saved after every step, recovery at startup, and no automatic starts.
3. Spending service: reservations, settlement, unverified handling, caps, Boise periods and remaining budgets.
4. Usage ledger and reconciliation records.
5. Owner authority: the designation command, backend checks and the demo sign-in shut-off.
6. Company research protocol v2.0 and industry research protocol v1.0.
7. Approved source lists, source proposals and the reader's wider scope.
8. Claude review: adapter, protocol, simulated reviewer and source re-reads.
9. Company research versions and industry intelligence records.
10. Customer-reported figures and their validation, in discovery.
11. The AI Operations screens.
12. A synthetic-cost test provider and local test pages.
13. Automated tests and acceptance checks.

## Database changes and rollback

Migration 0004 is additive. It runs only after a verified backup, and row counts are compared before and after, as with 0003.

| Change | Purpose |
| --- | --- |
| `users.spending_authority_at`: at most one account, never a demo account or a non-operator | Owner spending authority |
| `users.sign_in_disabled_at`: set for demo accounts in your database | Turns off the shared-password accounts |
| `missions` | Mission record: number, type, subject, scope fingerprint, provider, model, protocol, state, times, results, simulated flag |
| `mission_approvals` | Approvals: scope fingerprint, maximum, review choice, approver and expiry |
| `mission_steps` | Step log, errors, cancellations, and the working state of unfinished missions |
| `ai_usage_ledger` | Every AI request: reservation, usage, cost and status |
| `spending_reconciliations` | The provider figures you enter, the comparison, and releases |
| `research_sources` | Approved and proposed sources, with versions |
| `research_records` | Versions of company research from missions |
| `industry_intelligence` | Versions of industry research |
| `discovery_figures` | Customer-reported figures and their validation |

No existing table changes apart from the two `users` columns, and no existing row is edited apart from the demo sign-in shut-off.

**Rollback**

- **App:** reinstall KELQOR 0.1.3 from its kept installer.
- **Code:** switch back to `kelqor/desktop-m1` at `0e46a42`.
- **Database:** restore the pre-M2B backup, or run the documented SQL that drops the new tables and the two columns and removes migration 0004's record. Dropping the column turns demo sign-in back on.

## Testing and acceptance criteria

Every criterion is tested automatically against simulated or synthetic-cost providers, at the backend as well as in the window, and checked in the installed app wherever it has a screen. No paid request is made before Gate 2.

| # | Area | Criterion |
| --- | --- | --- |
| 1 | Missions | A company-research mission can be set up for an existing company and for a new one |
| 2 | Missions | An industry-research mission can be set up |
| 3 | Missions | An unapproved mission can't run, including through direct backend requests |
| 4 | Authority | Only the designated owner can approve, start, resume, add review or release charges. The backend refuses the demo operator, other operators, clients and builders; no route grants authority; demo accounts can't sign in to your real database |
| 5 | Approvals | An approval is void after any scope change, can't be used for another mission, and expires at Boise midnight; one expiring mid-mission stops it before the next paid request |
| 6 | Missions | Approved missions run only through the mission runner, and none starts when KELQOR opens |
| 7 | Missions | Double clicks, two windows and reconnections start a mission only once |
| 8 | Spending | The $2 mission limit is enforced |
| 9 | Spending | The $5 daily limit is enforced across missions, at the Boise day boundary |
| 10 | Spending | The $20 monthly limit is enforced, at the Boise month boundary |
| 11 | Spending | Concurrent missions can't overspend |
| 12 | Spending | Retries and repairs are reserved and counted, and can't exceed the approval |
| 13 | Spending | No model request can be sent without a ledger reservation |
| 14 | Spending | A timeout after sending, or a backend stopped mid-request, records the full reservation as unverified and counts it |
| 15 | Spending | An unpriced model, a failed token count or a missing approval sends nothing |
| 16 | Spending | The December 1 price change applies by the request's date, with the higher price near the boundary |
| 17 | Spending | A reconciliation release needs your entered figure and note, never goes below settled costs, and is recorded |
| 18 | Simulation | Simulated missions cost $0 and don't touch budgets; the synthetic-cost provider can't run against your real database |
| 19 | Recovery | Failed missions keep their partial work and accurate usage records |
| 20 | Recovery | Cancelling stops further requests, and a request in flight is handled as unverified |
| 21 | Recovery | Closing KELQOR or restarting the backend mid-mission makes it Interrupted, and nothing resumes until you resume it |
| 22 | Recovery | Reconnecting shows the true state without resending anything |
| 23 | Recovery | A missing or invalid key, an outage, rate limits, malformed or cut-off output and a failed Claude review each end in the right state, never a false success |
| 24 | Sources | The reader refuses pages outside the company's site and the approved sources; blocked domains and robots.txt are honored |
| 25 | Evidence | Unsupported quotes and mismatched sources are detected and downgraded, and failed checks lead to Needs review |
| 26 | Evidence | Missing sources produce reported gaps, never claims above hypothesis |
| 27 | Evidence | No AI step can produce a customer-confirmed problem or a financial validation, or raise a category |
| 28 | Sources | Proposed sources wait for your review and aren't read until approved |
| 29 | Claude | Review is off unless approved, counts inside the caps and is impossible without a key; with the simulated reviewer it works end to end, discloses the cost of re-reading pages and reports changed sources |
| 30 | Claude | Claude scoping stays off, and template scoping still works |
| 31 | Data | Frozen research, both ledgers, dossiers and all M1 and M2A records are unchanged, checked by git, fingerprints and row counts |
| 32 | Security | No mission can contact anyone or take an external action, and the outbox is unchanged |
| 33 | Security | API keys never appear in responses, logs, the ledger or exports |
| 34 | Security | Client and builder accounts are refused on every mission route |
| 35 | Regression | All M1 and M2A tests (125) and acceptance checks (65) still pass |
| 36 | Installed app | Installed KELQOR 0.2.0 passes its full acceptance run on an isolated copy of your data |

## Release gates

| Gate | Requires | Result |
| --- | --- | --- |
| 0 — Implementation approval | Your approval of this document in chat | Local work within Boundaries; no paid requests |
| 1 — Built and tested | All 36 criteria pass; KELQOR 0.2.0 installed; your account designated; demo sign-in off in your database; your walkthrough with simulated missions; the report delivered | M2B is **built and tested**, not yet operational |
| 2 — Live verified | Your separate spending and execution authorization for one mission; prices re-checked that day; the success criteria below met | M2B is **live verified** |

**Proposed Gate 2 mission** (needs its own authorization)

- Mission A on Boise Metal Works (c01, manufacturing), with Gemini 4 Argon and Claude review off, at a maximum of $1.00.
- Its benchmark research cost $0.15 at today's prices, about $0.30 at December prices.
- It tests the general protocol outside home services and can be compared with its frozen benchmark dossier.

**Success criteria**

- The mission completes within its maximum.
- Every request is settled in the ledger with Google's reported usage, and counted input matched reported input within the margin.
- Every quoted claim is verified or downgraded, and gaps are stated.
- You review the result.
- The month reconciles against Google's console once the charge appears there.

M2B isn't described as operational until Gate 2 passes.

## Roadmap

`docs/ROADMAP.md` is updated during implementation:

- **M2C — Controlled discovery (new, proposed).** KELQOR finds new companies and trustworthy sources without your supplying every address. Each mechanism needs its own approval, and its cost must be bounded before anything is sent. M2B's source proposals are the first, zero-cost step. Candidates:
  - a search service billed per query that KELQOR calls itself, so each query is counted and capped before it's sent (needs a new account and key);
  - Claude's web search, which takes a per-request search limit (needs an Anthropic key);
  - Gemini Search grounding, only if Google adds a per-request limit;
  - public business registries' bulk data, where offered.

- **Controlled Claude Work Order scoping:** later, as a mission type under the same approvals and caps.
- **M3 — Engineering agent coordination:** unchanged: Claude Code and Antigravity, with assignments, progress evidence, independent verification and your acceptance. M2B adds no coding, command execution or repository changes.
- **M4 — Managed customer AI:** unchanged.
- **M5 — Deployment and operations:** unchanged: cloud, on-premises and hybrid, customer isolation, monitoring, recurring delivery, multi-industry expansion and profitability.

M2B's missions, approvals, ledger and caps are built so M2C to M5 can reuse them.

## Known risks and unresolved limitations

1. **No open-web search.** Coverage is limited to company sites and approved sources. Gaps are reported, not filled.
2. **No provider-side hard ceiling.** KELQOR caps what it sends. A provider billing change or error would show up only at reconciliation.
3. **Gemini token counting isn't documented as exact or free for KELQOR's requests.** Google documents its counting endpoint for standard requests, but doesn't say the count equals billing, that counting is free, or that it accepts the request format KELQOR uses today. Plan: count an equivalent standard request, reserve with a margin, and compare every response's reported input; Gemini requests stop if a reported input ever exceeds its reservation. If faithful counting isn't possible, the M2B adapter moves to Google's standard request format, where counting is documented; the frozen benchmark isn't touched either way. The first live mission shows whether counting calls are billed.
4. **Unverified charges can hold budget until reconciled.** This is deliberate and conservative.
5. **Research quality is unproven.** The new protocols are unproven until live missions; simulation tests the controls, not research quality.
6. **Cut-off responses cost a retry.** A response cut off at 20,000 tokens is retried or reviewed, and the retry costs money. The benchmark's largest request used 14,441.
7. **Some pages can't be read:** robots.txt exclusions, script-only pages, forms and blocking. They're reported as not read.
8. **Registry and licensing look-ups** that need forms stay your own checks.
9. **Reconciliation is manual and approximate:** delays, time zones and project-wide totals.
10. **Closing KELQOR interrupts missions,** because the backend stops with the app (ADR 018). A request in flight counts at its maximum until reconciled.
11. **Claude review can't be verified live** until you add a key and authorize it.
12. **Prices double:** Argon on December 1, 2026 and Flash on January 1, 2027, so the same caps buy about half the research. For Argon, a typical company rises from about $0.14 to $0.27 and the heaviest from $0.62 to $1.23. With M2B's settings all 25 benchmark companies still fit the $2 limit at December prices; today's settings would stop 2.
13. **Regulatory findings** from industry research are research, not legal or compliance advice, and are flagged for professional verification.
14. **Local only.** M2B runs on this PC through the local backend; cloud execution is M5.
15. **Prices are kept by hand.** Unpriced models are refused, but a price change on Google's side would show up only at reconciliation.

## Completion report

At Gate 1, and again at Gate 2, the report gives:

1. Exactly what was implemented.
2. The mission types supported.
3. Each provider and its state: working, simulated or unavailable.
4. How approvals and budgets behave.
5. How the ledger behaves, and its billing limits.
6. Research verification capabilities.
7. Test results, failures included.
8. Results from the installed app.
9. Files, migrations and database changes.
10. Version, branch and local commit.
11. Known limitations.
12. Rollback instructions.
13. What remains for M2C to M5.
14. The recommended first live mission (Gate 1), or its outcome (Gate 2).

M2B isn't described as complete or operational unless its capabilities work and its criteria are met.
