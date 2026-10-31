# Milestone 5: deployment readiness

**Status: prepared, not deployed.** Nothing is public, no infrastructure is bought, and no real customer account is
connected. Production deployment isn't complete until a real deployment is separately authorized and verified.

## Where KELQOR runs today

- **The setup:** one Windows computer. The desktop app starts a Next.js development server (`next dev`) on
  `127.0.0.1:3000`, over an embedded PGlite database in `.data/pglite`. That suits building and demonstrating, not
  customers:
  - only this computer can reach it;
  - the database opens in one program at a time;
  - a development server isn't a production server.

## Options

| | Local only (today) | Cloud | Hybrid (recommended) |
| --- | --- | --- | --- |
| Customers can use the portal | No | Yes | Yes |
| Where data lives | This PC | A managed Postgres | A managed Postgres |
| Engineering missions (M3) | Here | Would need repository access in the cloud | Stay on this PC, next to the repositories |
| Monthly cost | $0 | A host plus a database, roughly $25–$100 to start | The same |
| Risk | The PC is the only copy unless backed up | Provider outage | The same, and engineering keeps working offline |

**Recommended: hybrid.**
- **The customer-facing part:** the web app, the backend and the database go to a managed host, with TLS and a domain.
- **The desktop app:** stays the operator Command Center. It connects to the hosted backend for customer operations and
  keeps a local backend for engineering missions, where the repositories are.
- **Live AI and billing:** each stays off until authorized separately.

## What a first deployment needs

1. **A production build:** `next build` / `next start` instead of `next dev`, with the desktop app able to point at a
   configurable backend address (it is fixed at `127.0.0.1:3000` today). A hosted portal never runs `next dev`: the
   development server's hot-reload socket and its refreshes are for this computer only (the security reviewer, M4 review).
2. **Postgres:** the `DATABASE_URL` path exists but is untested under concurrency (an M2B open item). Run the full suite
   and the controls' concurrency tests against a real Postgres before any customer data goes in.
3. **Authentication:**
   - **Web sessions:** the existing cookie sessions (hashed tokens, per-account and per-address sign-in limits). On HTTPS,
     secure cookies; the rate limits need a shared store instead of process memory.
   - **Customer accounts:** they keep coming from invitations.
   - **Optional extras:** password reset by email, and two-step sign-in for operators.
4. **Isolation:** every managed-service function enforces the organization boundary (M4). Before real customers, run the
   isolation tests against the hosted database. Add a database-level row filter by organization as a second layer.
5. **Secrets:** the host's secret store for the database, Gemini, Anthropic, Stripe and email credentials. Never in the
   repository; the key scans from M2B stay in the tests.
6. **Email:** a sending provider for invitations and notifications (the outbox exists). Nothing is sent today.
7. **Portal checks on the production build (the security reviewer, M4 phone review).** Run them before the first customer signs in.
   - **Cache headers:** the `no-store` seen on the portal so far comes from `next dev`, which sends it on everything.
     Set `Cache-Control: no-store` explicitly for `/services/*` and `/invite/*` in `proxy.ts` (Next 16's middleware).
     Then rerun the portal checks against the production build, so no customer page or data payload can be cached on a
     phone.
   - **Secrets scan:** it has only seen development bundles, so it needs to run against the production build too.
   - **Cookie:** the sign-in cookie must be `Secure` on the hosted portal. The acceptance already requires it away from
     this computer.
   - **Command:** `npm run desktop:acceptance -- --phone --only m4` runs all of these at phone size. Today it runs
     against this computer's portal only; pointing it at the hosted portal is part of M5.

## Operations foundations (built and tested locally)

- **Backup:** `npm run db:backup` makes a copy verified file by file. Migrating your database requires a fresh one.
- **Restore:** `npm run db:restore -- --from <backup> --confirm`, a new script, is verified file by file. The replaced
  database is moved aside, never deleted. It's tested against tampered and missing backups.
- **Rollback:**
  - **Per migration:** `db:rollback-m2b`, `db:rollback-m3` and `db:rollback-m4` (new), each undoing its milestone and any
    later one, each tested.
  - **App:** every earlier installer is kept in `desktop/out/kept-installers`.
- **Health:** `/api/health` reports whether the database answers and how many migrations are applied, for an uptime
  monitor.
- **Offboarding and data requests:** `npm run customer:export -- --org <id> --out <file>`, a new script, writes everything
  held for one customer and nothing else, with no password hashes. It's tested for isolation.
- **Alerts:** Customer Operations shows overdue and failed requests per customer. In a hosted setup, the same checks
  would send an operator email.

## Hosted equivalents to set up when authorized

- **Backups:** the provider's point-in-time recovery, plus a nightly export kept elsewhere, and a restore drill each
  quarter.
- **Monitoring:** an uptime check on `/api/health`, error reporting, and an alert for overdue or failed requests.
- **Deployment:** build on each release tag, take a database backup or snapshot, migrate, smoke-test `/api/health` and
  the acceptance subset, then switch traffic.
- **Rollback:** the previous release plus the milestone rollback scripts, and the snapshot as the last resort.
- **Retention:** decide how long requests, events and invoices are kept after a customer leaves. An export always
  comes first.

## Connecting customer systems (not built)

- **Inbound requests:** a dedicated inbox per customer forwarded to KELQOR, or a form or webhook into
  `submitRequest`. Least privilege: KELQOR receives copies and never gets mailbox access.
- **Outbound:** KELQOR drafts and the customer sends, as today, until the customer authorizes sending on its behalf.
- **Per-customer credentials:** a secret per customer in the host's vault, never shared across organizations.

## The phone experience

Customers will reach the portal from their phones' browsers; there's no KELQOR phone app, and none is to be built or
deployed yet. Once the portal is hosted as an HTTPS production build, and before the first real customer is onboarded:

- test the full customer path on a real iPhone and a real Android phone;
- add a phone-sized run of the portal acceptance;
- make the portal responsive, then an installable web app.

A native or wrapped app only if customers need push alerts or offline use. See `docs/m4/REPORT.md`, section 8.

## Decisions for the owner

1. **Hosting:** the provider and monthly budget, the domain, and whether to go hybrid.
2. **Database and email:** the Postgres and email-sending providers.
3. **Live AI for customer services:** run quote intake through Gemini under the M2B approvals and caps. Decide the
   per-customer budget and whether customer AI costs share the $5 day and $20 month caps or have their own.
4. **Live billing:** Stripe live mode for subscriptions; the plans' prices (Starter $499, Growth $999 with $500 setup, and
   the Pilot).
5. **The labor rate** used to cost review time ($60/h assumed).
6. **Retention periods,** a privacy policy and customer terms.
7. **The first real customer:** who, and on which service and plan.
