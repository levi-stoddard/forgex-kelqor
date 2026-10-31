# KELQOR roadmap

KELQOR is a universal managed-AI services company. We run the intelligence, engineering, automation and managed AI
services; customers use a simple interface to ask for outcomes, explain what they need, approve decisions and review
results. Construction and home services are the first test market, not a boundary.

Each milestone starts only with the owner's explicit authorization. This file is the committed plan: an item listed
here is planned, not built, unless its milestone says otherwise.

## Milestones

| Milestone | What it delivers | Status |
| --- | --- | --- |
| **M1** | The KELQOR Windows Command Center: Opportunity Center (saved research and owner decisions), Business Workspace, Owner Decisions, AI Operations, desktop notifications; the app starts and stops its local backend | Built (0.1.0–0.1.2); owner acceptance pending |
| **M2A** | Discovery-first Opportunity Center, plus M1 stabilization (below) | Built (0.1.3); owner acceptance pending |
| **M2B** | AI missions you control from the Windows app: company and industry research, Gemini as the research provider, optional Claude review, owner-only approvals, the $2/$5/$20 spending caps, a durable usage ledger and manual reconciliation (docs/m2b) | Built and tested with simulated providers (0.2.0); live verification (Gate 2) needs its own authorization |
| **M2C** | Controlled discovery: KELQOR finds new companies and trustworthy sources without the owner supplying every address. Each mechanism needs its own approval and a bounded cost before anything is sent | Proposed |
| **M3** | Secure coordination with Claude Code and Gemini Antigravity through their supported integrations | Built and simulated-tested (staged as 0.3.0, branch `kelqor/m3`); real-agent execution unverified, see [docs/m3/README.md](m3/README.md) |
| **M4** | Customer-specific managed AI services, and a simple customer experience for requesting outcomes, approving and reviewing results | Committed, not started |
| **M5** | Cloud, on-premises/local and hybrid operation, as each is commercially justified | Committed, not started |

### M2A, as built

- **Stabilization:** every company has an explicit class (real, demo or test). Money is kept in three buckets (real, test, unverified), and only real money counts as cash, margin or monthly revenue. That closes the four places test or demo money reached real totals. Claude scoping stays off until M2B adds its spending limit.
- **Industry as configuration:** `playbooks/industries.json` lists the industries KELQOR works with. Each has discovery questions, and a research playbook carries its segment. The frozen benchmark's prompt is unchanged, byte for byte.
- **Discovery-first workflow** for each researched company:
  - evidence levels;
  - the owner's own checks;
  - discovery conversations in the customer's words;
  - problems the customer confirmed or dismissed;
  - the simplest solution for each;
  - readiness for the next commercial action;
  - a Work Order drafted from a confirmed problem, which sends, quotes and charges nothing.

### M2B, as built

- **Missions:** company research (protocol v2.0, any industry) and industry research (protocol v1.0, approved sources only), each with a number such as M-0001, run on demand by the backend's mission runner and saved after every step. Nothing starts by itself.
- **Controls:** only the account designated with `npm run designate-founder` can approve, start or resume a mission, add review or release a charge. Approvals bind the exact scope and expire at the end of the Boise day. Every request is counted, reserved in one database transaction against the $2 mission, $5 day and $20 month caps, then settled, recorded as not billed, or held as unverified at its full reservation.
- **Sources:** missions read only the company's own site and approved sources; Claude's starter list waits for approval, and sources found during missions are proposed, not read.
- **Evidence:** eight categories, of which AI can assign four; checks only move a claim down. Research versions sit beside the frozen dossiers, and industry records are versioned and used only once reviewed.
- **Not yet verified live:** no paid request has been made. Gate 2 (one real, capped mission under its own authorization) proves token counting, settlement and reconciliation against Google's billing.

### M2C, proposed

Candidates, each needing its own approval and a cost bounded before anything is sent:

- a search service billed per query that KELQOR calls itself, so each query is counted and capped first (needs a new account and key);
- Claude's web search, which takes a per-request search limit (needs an Anthropic key);
- Gemini Search grounding, only if Google adds a per-request limit;
- public business registries' bulk data, where offered.

M2B's source proposals are the first, zero-cost step. Controlled Claude Work Order scoping follows later as a mission type under the same approvals and caps. M3, M4 and M5 are unchanged; M2B adds no coding, command execution or repository changes.

## Operating functions (planned roles, not running agents)

An organizational function doesn't mean a permanently running AI process. Execution starts on demand, under the owner's control; a background worker isn't required. Existing models and infrastructure are reused before anything new is added.

| Function | Today | Planned |
| --- | --- | --- |
| Operations Coordinator | Owner Decisions queue, Work Order state machine, audit log, desktop alerts; the mission queue, approvals and recovery (M2B), with no autonomous agent | Engineering coordination (M3) |
| Sales & Research | Missions A and B from the app (M2B; real use after Gate 2), the discovery-first Opportunity Center | Controlled discovery of new companies and sources (M2C) |
| Engineering | None in the product. The owner delivers in-house, and Claude Code builds KELQOR | Delivery tooling for the first paying customer's stack (M2B–M4) |
| Verification | Mission evidence checks, Claude review once authorized; Work Order acceptance criteria with evidence; discovery confirmation | Health checks on delivered automations (M4) |
| Customer Support | Per-order messages and disputes; no email is sent | Customer experience and support (M4) |
| Finance & Reporting | Metrics that count only real money; the AI usage ledger, spending caps and reconciliation (M2B) | Billing (M4) |
| Learning & Memory (shared) | Audited decisions, discovery records and outcomes; reviewed industry intelligence versions (M2B) | Playbook improvements reviewed from outcomes |

## Before any production use

These were found in the 2026-10-27 assessment (in my decision notes, kept private) and stay open until fixed:

- **Sign-in:** MVP only, with no MFA, password reset or email verification (ADR 009).
- **Rate limits:** held in memory, keyed on a spoofable header.
- **Web app:** no content security policy.
- **Email:** no provider; notifications go only to an outbox table (ADR 010).
- **Payments:** Stripe test mode only, one-time payments only.
- **Desktop API:** answers on this computer only, from the development server.
- **Database:** the embedded database is single-process, with no automatic backups.
- **Terms:** counsel-approved terms are still needed.
