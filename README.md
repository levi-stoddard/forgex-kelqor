# ForgeX + KELQOR

This is a cleaned-up public copy of a private project I built in 2026, published without its git history. It is the
latest milestone branch (Milestone 4, plus the Milestone 5 operations groundwork). Third-party contact details in the
research data are redacted, and a few internal notes are reworded or left out. Everything else is the code as I wrote
and tested it.

## What it is

**ForgeX** is a web app for selling fixed-price automation work. A small business describes a problem, ForgeX drafts a
scoped **Work Order** with written acceptance criteria, an operator prices and sends it, and the client pays ForgeX.
Whoever delivers (the owner in-house, or a vetted builder) is paid only after the client accepts the work criterion by
criterion. Monthly services keep delivered automations running. The first market I aimed at is owner-led HVAC,
plumbing and electrical contractors, sold through three productized offers: a $500 Revenue Leak Check, a lead-to-job
pipeline and a Monday numbers report.

**KELQOR** is the operations side I built on top of it:

- **A Windows command center** (Electron and React) for the owner. It starts the local backend, signs in, and talks to
  it only through `/api/desktop` routes. It has an Opportunity Center for discovery-first selling (researched companies,
  evidence levels, the customer's own words, confirmed problems), a queue of owner decisions, and notifications.
- **AI missions with hard spending controls** (Milestone 2B). Company and industry research missions run on Gemini
  only after the owner approves the exact scope. Every request is reserved against caps of $2 per mission, $5 per day
  and $20 per month before it is sent, recorded in an append-only usage ledger, and reconciled by hand against the
  provider's figures. The database enforces the same rules with CHECK constraints and triggers.
- **An engineering agent console** (Milestone 3). The owner gives an AI coding agent a task. It runs in its own detached
  git worktree, KELQOR collects the diff and runs the allowed checks, and the change is committed to a new local branch
  only after the owner approves exactly what was reviewed. A change that touches a protected file such as `.env` can't
  be approved.
- **Customer AI operations and a customer portal that works on a phone** (Milestone 4). Customer organizations get
  configured services (rate cards, approval rules, plans), submit requests through a web portal, and approve results
  bound to the exact deliverable they saw. Invoices freeze once issued. The portal is a responsive web app; the
  acceptance run drives it at phone size (375x812, touch). There is no native phone app.

## Architecture

```
KELQOR.exe (Electron main)  -- IPC --  React window (no Node, CSP, app:// scheme)
      |  encrypted session (safeStorage), health check, notifications
      v
Next.js backend on 127.0.0.1:3000: /api/desktop/*, web pages and server actions (client, builder, operator, portal)
      |
      |-- src/lib/domain       Work Orders, state machine, pricing, accounts, invites, metrics
      |-- src/lib/controls     owner authority, approvals, spending reservations, ledger, reconciliation
      |-- src/lib/missions     research missions: runner, recovery, evidence checks, optional Claude review
      |-- src/lib/engineering  engineering missions: worktrees, agent adapters, checks, secret redaction
      |-- src/lib/services     customer services, requests, review, invoices
      `-- src/lib/db           Drizzle schema; PGlite (embedded Postgres) locally, node-postgres for a real database
```

Design notes, the decision log and the milestone reports are in [docs/](docs/). Start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DECISIONS.md](docs/DECISIONS.md). The documents in `docs/m2b`,
`docs/m3` and `docs/m4` were written for the owner during the build and still read that way. Two AI agents worked on
Milestone 2B, an implementation agent and a security reviewer; `docs/m2b/PLAN.md` shows how the work was split.

## Stack

TypeScript, Next.js 16, React 19, Tailwind CSS 4, Drizzle ORM on PGlite or Postgres, Zod, Electron 44 built with
esbuild, and Vitest 5. AI providers: Google Gemini (`@google/genai`) for research and Anthropic Claude
(`@anthropic-ai/sdk`) for optional scoping and review. Stripe Checkout, test mode only, for payments.

## Running it locally

Requires Node.js 20.9 or later (I used Node 24). The desktop app needs Windows. No database install is needed.

```bash
npm ci
cp .env.example .env.local   # every value is optional; leave the keys empty
npm run setup                # create the embedded database and load demo data
npm run dev                  # http://localhost:3000
```

`npm run setup` prints a generated demo password once, unless you set `SEED_PASSWORD` in `.env.local`. All demo
accounts share it: `ops@forgex.local` (operator), `riley@brightline.demo` and `avery@ledgerwise.demo` (clients),
`sam@builder.demo` and `priya@builder.demo` (builders). Demo records are flagged in the database, and demo payments
are TEST payments that never count as revenue.

Without API keys, scoping falls back to built-in templates and missions run in simulated mode ("Simulated, no AI,
$0"). Without Stripe keys, an operator records payments by hand. `npm run desktop:start` builds and opens the desktop
app, which starts the backend itself. To approve missions, give one operator account owner authority with
`npm run designate-founder -- --email you@example.com` while KELQOR is closed. (The script keeps its original name,
like the other code identifiers.)

## Tests and build

Measured on this copy on Windows 11 with Node 24:

| Command | Result |
| --- | --- |
| `npm test` (Vitest) | 16 files, 303 tests, all pass (see the note below) |
| `npm run typecheck` | passes |
| `npm run desktop:typecheck` | passes |
| `npm run build` | the Next.js production build succeeds |
| `npm run desktop:build` | builds `desktop/dist` (main, preload and renderer) |

The tests use in-memory Postgres and local fixture sites. They make no network calls and need no keys or database
service. One test checks that a mission which writes `.env` is blocked. It relies on git staging `.env`, so it fails on
a machine whose global git excludes file ignores `.env`; with a clean global git config, all 303 pass.

`npm run desktop:acceptance` drives the installed Windows app through the Chrome DevTools protocol, on an isolated copy
of the database. It needs a packaged install (`npm run desktop:package`), so it isn't part of `npm test`.

## The research benchmark

Before trusting an AI model with prospect research, I measured it. `research/` holds three datasets:

- **A:** a 25-company research pilot (Idaho trades, manufacturers and IT firms) produced by Claude, with dossiers,
  scores and unsent outreach drafts, frozen with checksums.
- **B:** the same 25 companies researched independently by two Gemini models, `gemini-4-argon` and
  `gemini-3.8-flash`, through ForgeX's own fetcher, which honours robots.txt and reads only the company's own site.
  Each fact had to carry a source URL and a verbatim quote, and the runner checked every quote against the pages it
  served.
- **C:** the evaluation of B: quotes the run-time checks couldn't confirm, re-checked on the live pages; a seeded
  sample of 25 facts per model judged statement against quote; consistency across three runs; and costs.

The protocol was fixed and versioned before any paid request
([PROTOCOL.md](research/benchmark-2026-gemini/PROTOCOL.md)). Each paid stage needed a recorded authorization with a
hard cap: $5 for the dry run and $20 for the full run. The dry run cost about $0.51 and the full stage $6.06 (main
runs: Argon $3.49 and Flash $1.14; repeat runs $1.43).

Results in short:

- Both models identified all 25 companies correctly.
- Quotes were found on the cited pages for 385 of Argon's 388 quoted facts and 250 of Flash's 256. Every one I
  re-checked was a gap in the checker (page titles, form addresses), not a fabrication.
- In the 25-fact samples, Argon was 25 of 25 true and Flash 24 of 25 (one contradicted).
- Qualification categories and offers were identical across three runs of the same companies, but the exact facts
  and quotes varied a lot from run to run.
- Flash cost about a third as much as Argon per company. Argon read more pages and made fewer unsupported guesses about
  company size.

The comparison with dataset A and the blind owner review were still to do. In this public copy, the email addresses,
phone numbers and personal names of people at those businesses are replaced with `[redacted]`. Business names,
websites and findings are unchanged, and the pilot's checksums were regenerated for the redacted files.

## Status

Pre-launch. Nothing is deployed, no real customer is set up, and no payment system is live. The terms page and the
agreements are drafts that no lawyer has reviewed. Real agent execution and paid missions sit behind explicit owner
authorization, and paid requests only ran in the capped, recorded benchmark runs.

## Licence

Copyright (c) 2026 Levi Stoddard. All rights reserved. This source is published for portfolio review only; see
[LICENSE](LICENSE).
