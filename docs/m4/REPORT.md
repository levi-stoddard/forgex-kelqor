# KELQOR 0.4.0 — Milestone 4 and Milestone 5 preparation: report

Date: 2026-10-28. Built by the implementation agent, verified by the security reviewer. Branch `kelqor/m4`, local commits only; nothing pushed,
deployed, billed or sent.

**Status:** M4 is **installed** (KELQOR 0.4.0, 2026-10-28, on your authorization). Your database is migrated, and every
existing record is unchanged (section 7). M5 is prepared and tested locally. **Production deployment hasn't been done**
and needs separate authorization.

## 1. Features completed and demonstrated

**Customer organizations, onboarding and isolation**

- KELQOR onboards a customer: an organization (real, demo or test), its first contact and a one-time invitation link.
- The customer signs in on the web, at `/services`, and reaches only its own workspace:
  - Every read and write checks the organization.
  - Another customer's records answer "not found".
  - Customer views are built field by field, so drafts, review notes, AI costs and margins never reach a customer.
- The database enforces it too. Every customer record carries its organization, and composite keys make a request,
  invoice line or replacement invoice point to the same customer's records.
- Offboarding ends every service, turns off sign-in, ends open sessions and revokes unused invitations. Nothing is
  deleted.

**Managed services**

- There are six service categories. Quote and inquiry intake has a full processor; the other five produce an organized
  summary until each gets its own.
- There are three plans: Starter, Growth and Pilot. A plan's terms are copied into the customer's agreement when the
  service starts.
- KELQOR adds, configures, activates, pauses, resumes and ends services. The configuration covers the customer approval
  threshold, the minimum job and the turnaround.

**Customer Command Center (web)**

- Services, requests and status.
- Sending a request.
- Answering KELQOR's questions.
- Approving or returning a result.
- Invoices, labeled simulated and numbered for that customer alone.
- The monthly report.

**Operator controls (desktop, Customer Operations)**

- The customer list and onboarding.
- The review queue, with overdue flags.
- A customer page: services and configuration, requests entered for the customer, the report, costs and margin,
  simulated invoices, and offboarding.
- The review editor: what processing found, with evidence, questions and assumptions; a priced draft that can be edited
  line by line; and the reply.

**The end-to-end demonstration (simulated)**

1. The customer sends a quote request.
2. Processing extracts the fields and prices a draft. This is deterministic: no AI and $0.
3. KELQOR reviews it. The review is bound to the exact draft it saw.
4. The customer approves. The approval is bound to the exact deliverable the customer saw.
5. The deliverable is complete.
6. It appears in the monthly report, the usage, the costs and the invoice.

Every action runs exactly once per request key. A refused action is recorded as refused, and the customer doesn't see
it.

**Commercial foundations (simulated)**

- Plans and agreements.
- Usage, including overage.
- Review time costed at an assumed labor rate.
- Monthly invoices: draft, issued, paid or void.
- Profitability for each customer.

The database freezes an issued invoice: its total must equal its lines, and its lines can't be changed, moved or
truncated. A correction is a new invoice that replaces a voided one. Every invoice is marked simulated; the database
refuses anything else.

**M5 foundations (built and tested locally)**

- `npm run db:restore`: restores from a verified backup. It checks every file, and the database being replaced is moved
  aside, never deleted.
- `npm run customer:export`: exports one customer's own records, holding only what that customer can see.
- `npm run db:rollback-m4`: rolls M4 back. The guard refuses to drop issued or paid invoices without a backup from the
  last hour.
- `/api/health`: returns `{ok}` only.
- The deployment plan is in `docs/m5/DEPLOYMENT.md`. It covers hosting options, what a first deployment needs, the
  hosted equivalents of each local foundation, how to connect customer systems, and the decisions.

## 2. Test results

**Automated tests: 303 of 303 pass (16 files).** M4 adds 19 tests in `tests/m4-services.test.ts` and M5 adds 3 in
`tests/m5-ops.test.ts`. They cover:

- isolation between two customers on every read and write;
- composite same-customer keys;
- the invoice freeze: a line can't be changed or moved off an issued invoice, both tables refuse TRUNCATE, and the total
  must equal the lines;
- replacement after a void, and refusal of a replacement that names another customer's invoice;
- exactly-once actions, with refused actions recorded as refused;
- review bound to the draft, and the customer's approval bound to the deliverable;
- per-customer numbering;
- offboarding, including revoked invitations;
- restore and export;
- the static check that customer processing can't call an AI provider or the network;
- the M2B, M3 and M4 rollbacks.

**Installed-app acceptance: 152 of 152 checks pass, in three runs** (the last was 2026-10-28 23:18Z). The run
used the staged 0.4.0 build, an isolated KELQOR data folder, a marked copy of the database, and a headless browser for
the customer side.

| Area | Checks |
| --- | --- |
| M1 (app, backend, sign-in, window security, records, decision, offline and forced-close recovery) | 52 |
| M2A | 13 |
| M2B | 39 |
| 0.2.3 | 2 |
| M3 (engineering missions and the Claude handoffs) | 27 |
| **M4 customer demo, end to end, in the app and the browser** | **16** |
| Setup | 3 |

The 16 M4 checks follow the demo end to end:

1. A customer is onboarded.
2. A service is configured and activated.
3. The customer accepts the invitation and sees only its own workspace.
4. The customer sends a request, which is processed and held for review with no draft shown.
5. KELQOR reviews it and releases it.
6. The customer sees the quote and approves it, and the deliverable is complete.
7. The simulated invoice is issued, and the customer sees it numbered for itself.
8. The customer sees the report.
9. KELQOR sees the costs and margin.
10. Opening another customer's request answers "not found". Sending to another customer's service is refused even when
    that service's id is forced into the form and submitted, and the other customer receives nothing. The security reviewer asked for
    this check to actually try the submission.

**The security reviewer:**

- On e02ae1c, the security reviewer required composite keys, the invoice freeze, a replacement path and refused-action records. All
  were fixed in 72c590a.
- On 72c590a, the security reviewer's verdict was PASS except one required fix: a line could be moved off an issued invoice. That and
  three low-severity items were fixed in fd66384.
- **fd66384: PASS.** This is M4's sign-off at the code and simulated level. 06fa1b4's app change (the invitation's
  wording and landing page) was also reviewed and passes: both destinations are fixed paths, and neither comes from
  user input.
  - The security reviewer's direct-SQL attacks on the invoices were all refused, and the legitimate cases still work.
  - Offboarding revokes invitations.
  - Statically, 0007 and 0008 only create the five new tables, their indexes, triggers and two functions. They change no
    existing table or row.
  - On a marked test copy, the security reviewer's dumps of the existing tables were identical before and after the M4 migrations.
  - For the install, the security reviewer requires the same byte-identical dumps on your real database, before and after migrating,
    as for 0.2.x.
  - Customer processing doesn't go through M2B's metered path yet. It needs no metering because it is simulated, and a
    static test plus a documented rule keep it that way: real processing must go through `meteredRequest`.

**Fixed while getting acceptance green:**

- The invitation page told managed-services customers about a "Work Order" and a "fixed price". It now says what the
  invitation opens and lands on /services.
- The acceptance clicked the page's first form button, which, once the customer was signed in, was the header's Sign
  out.
- A hung browser call could end the run silently. Every call now has a timeout.

**Not fully explained:** in some runs, the development server (`next dev`) kept refreshing the open portal page, wiping
what was typed. Each refresh followed a recompile that changed nothing.

- I couldn't reproduce it outside the acceptance run.
- ~~The acceptance now runs the portal with hot reload blocked.~~ Corrected 2026-10-29: the block doesn't apply to the
  development server's update socket, which still connects. The form steps retry instead, and the browser log now
  records what the socket says, so the next loop will show its trigger. It happened again on 2026-10-29, on the first
  page, in the first two of six runs. Moving the run's data folder out of the project didn't prevent it.
- The two final runs had no recompiles at all.
- If you see a portal page reload by itself during the demo, reload once and continue. It's specific to development
  mode, which a hosted portal won't use.

## 3. Customer demo instructions

See `docs/m4/README.md`, "Demonstration". After 0.4.0 is installed, it takes about 10 minutes, with a synthetic
customer. In short:

1. Onboard "Treasure Valley Fabrication (synthetic)".
2. Add and activate Quote intake.
3. Open the invitation link as the customer and send the sample inquiry.
4. Review and release it in KELQOR.
5. Approve it as the customer.
6. Prepare and issue the invoice.
7. See the report and the margin.

## 4. M5 readiness and genuine blockers

**Ready**

- The restore, export, rollback, rollback guard and health check, each with tests.
- Migrations run behind the backup guard.
- Offboarding and the isolation tests.
- The deployment plan.

**Blockers.** None of these are engineering work that can be done without you:

1. **Hosting and providers:** no host, database, domain or email sender has been chosen or bought. Customers can only
   reach the portal on this computer, at 127.0.0.1:3000.
2. **Live AI for customers:** processing is simulated. Real processing must run through M2B's metered path, and that
   needs your authorization and a budget.
3. **Real billing:** Stripe live mode, prices, tax handling and customer terms.
4. **Legal:** retention periods, a privacy policy and customer terms.
5. **Connecting customer systems** (email inboxes, forms, CRMs): designed, not built. Each needs a real customer
   account to build and test against.

## 5. Owner decisions

1. **Hosting:** the provider, the monthly budget, the domain, and whether to go hybrid (recommended: the desktop stays
   local, and the portal and database are hosted).
2. **Database and email providers.**
3. **Live AI for customer services:**
   - the per-customer budget;
   - whether customer AI costs share the $5 day and $20 month caps or have their own.
4. **Live billing and plan prices:** Starter $499, Growth $999 plus $500 setup, and the Pilot at $0.
5. **The review labor rate:** $60 an hour is assumed.
6. **Retention, privacy policy and customer terms.**
7. **The first real customer:** who, and on which service and plan.
8. **Billing policy as built** (confirm or change):
   - Overage counts declined and open requests.
   - Paused services are still billed.
   - An invoice can be issued before the month ends.
   - There are no credit notes and no proration yet.
9. **A customer approval waiting for the customer doesn't expire.** Decide whether it should.
10. **The older marketplace pages and Stripe pay action for client accounts.** They are still reachable by M4 customer
    accounts. Keep them, hide them for M4 customers, or retire them.
11. ~~Installing 0.4.0~~: done 2026-10-28 (section 7).

## 6. Recommended next action toward the first paying customer

1. Run the 10-minute demo yourself (0.4.0 is installed).
2. Then choose the first real customer and decide items 1–3. With those, the next milestone hosts the portal and turns on
   metered live processing for that one customer under a small cap. Billing stays manual or simulated until the first
   month's results justify Stripe live mode.

## 7. Installation (2026-10-28)

You authorized it in chat ("KELQOR is closed. Proceed with the approved 0.4.0 installation"). The implementation agent installed it and
The security reviewer compared the records independently.

1. **Backup:** `.data/pglite-backup-2026-10-28-pre-m4`, 1,183 files (60.3 MB), checked file by file against its
   manifest. After the install it still matches its manifest, and it's the rollback backup.
2. **Before:** each agent copied the backup into its own scratch folder, checked the copy against the manifest, and
   dumped every row and table definition from it. Both found 34 tables, 340 rows and 7 migrations. Neither opened the
   backup itself.
3. **Migration:** `npm run db:migrate`, on `kelqor/m4` at `118431c`, with KELQOR closed: no KELQOR process, and nothing
   on port 3000. Nobody signed in between the migration and the after copy.
4. **After:** each agent copied the migrated database and compared the two dumps. Both found them **identical**:
   - All 340 rows in the 34 existing tables are byte-identical: accounts, companies, sessions, missions and their steps
     and approvals, the AI spending ledger (real committed spend is still $0.278341), opportunity decisions, research
     records, Work Orders, payments, events and the outbox.
   - Every existing table's columns, constraints, indexes and triggers are unchanged, and so are the 4 existing
     database functions and the 7 earlier migration records.
   - Added: the five M4 tables (empty), the two invoice-freeze functions and two migration records. Postgres also added
     11 internal foreign-key triggers to `orgs` and `users`, one for each foreign key from a new M4 table to them. None
     of them changes an existing table or row.
5. **Install:** `KELQOR-Setup-0.4.0.exe --silent` (sha256 `A1155C3B…EBFF6`, the verified build). The installer didn't
   start KELQOR, and the database's file digest was the same before and after it.
6. **Acceptance:** 152 of 152 checks pass on the installed 0.4.0, on a marked copy made after the migration. They
   cover customer isolation and the complete simulated customer-service workflow. Your database's digest was unchanged
   after the run. Results are in `desktop/out/acceptance/0.4.0/results.json`.
7. **Kept for rollback:**
   - the `KELQOR-Setup-0.3.2.exe` installer, in `desktop/out/kept-installers` (sha256 `CF86A155…`);
   - the pre-m4 backup;
   - `npm run db:rollback-m4`.

## 8. The phone experience (an M5 requirement)

There's no KELQOR phone app, and none should be built or deployed yet. The customer side is a web portal, which already
sets the mobile viewport, so customers will reach it from a phone's browser. Recommendation:

1. **When:** evaluate it fully once the portal is hosted on HTTPS as a production build. Today it runs only on this
   computer, in development mode, so a real phone can't reach it. Only the emulated check (2.1) can run before then.
   Finish before onboarding the first real customer, who is likely to approve quotes from a phone.
2. **Testing, in three stages:**
   1. **Now, with no deployment:** run the existing 16 M4 portal checks a second time at phone width, in the same
      headless browser with device emulation (375×812, touch). Also check that nothing scrolls sideways and that Send
      and Approve can be reached. It's cheap, and it proves isolation and the workflow on a phone layout.
   2. **Staging (M5):** your own phone, then a real iPhone (Safari) and Android phone (Chrome), against the hosted portal
      over HTTPS, with a synthetic customer. Run the full path: invitation, sign-in, request, questions,
      approve/return, invoice and report.
   3. **The first real customers:** the same path on the customer's own phone during onboarding, observed.
3. **How to build it:** make the web portal responsive first, then make it an installable web app (manifest and
   home-screen icon, no app store). That keeps one codebase, one sign-in and one authorization path. A native app is
   worth it only if customers need push notifications or a store listing matters commercially. It would then be a
   wrapper around the same portal (Capacitor), not a second client, and it needs your approval, because store
   accounts are spend and publishing is a deployment.
4. **Security conditions (the security reviewer):**
   - the same session cookies (httpOnly, Secure, SameSite), hashed server-side sessions with expiry, and revocation on
     offboarding;
   - an offline cache that holds only static files, never customer pages or data;
   - a phone approval bound to the same deliverable hash as on the desktop;
   - none of KELQOR's own controls (AI spending, mission approvals, engineering) on the phone;
   - no keys in the client code.

## 9. The M4 walkthrough on a phone-sized screen (2026-10-29)

You approved it in chat. It ran on the installed 0.4.0, on an isolated, marked copy of the database, with synthetic
customers only. Your database, profile and settings weren't touched: the database's file digest was the same before and
after, and nothing in `%APPDATA%\KELQOR` was written. The 0.3.2 installer and the pre-M4 backup are unchanged, and the
backup still matches its manifest.

**How:** `npm run desktop:acceptance -- --phone --only m4`. This runs the walkthrough of `docs/m4/README.md` end to end
in the installed app, with the customer on an emulated iPhone-sized screen: 375×812, mobile, touch, and every press a
touch tap. KELQOR's side runs in the app window. The M1–M3 checks weren't repeated.

This was the M4 walkthrough on the installed application. It used an isolated copy rather than your real database, as you asked, so no demo customer was added to your records.

**Result: 40 of 40 pass** (`desktop/out/acceptance/0.4.0-phone/results.json`, 2026-10-29 18:32Z). The same M4
checks at desktop size: 33 of 33 pass. 303 automated tests pass. The security reviewer reviewed the checks and the results: PASS.

| Requirement | Checks | Result |
| --- | --- | --- |
| The walkthrough: onboard, service, invitation, request, review, release, approval, invoice, report, costs | the 17 M4 checks, at phone size | Pass |
| Navigation: the header leads a managed-services customer to Services and a new service request; tapping goes Command Center → report → back | 2 | Pass, after one fix (below) |
| Responsive layout: nothing scrolls sideways; every key control is uncovered, on screen and at least 24×24 px (invitation, Command Center, request form, quote and approval, invoice, report) | 6 | Pass, after one fix (below) |
| Authentication: a signed-out visit goes to sign-in; the sign-in cookie is HttpOnly and SameSite=Lax, hidden from page scripts, and must be Secure anywhere but this computer | 2 | Pass |
| Customer isolation: another customer's request is "not found"; sending to another customer's service is refused even when forced; nothing of the other customer is shown | 3 of the 17 | Pass |
| Approval binding: an approval naming any result other than the one shown is refused ("The result changed since you opened it"), and the request still waits; the real approval then completes | 1 | Pass |
| Nothing stored offline: no service worker, offline cache, local or session storage or IndexedDB; every portal page and data payload (10 and 6) served `no-store` | 1 | Pass |
| Internal controls not exposed: the operator pages send the customer away; the desktop API answers 401; none of 10 operator-only fields (draft hash, review notes, review time, AI cost, margin…) appears in the portal's pages | 1 | Pass |
| No secrets in client code: every file served to the customer (pages, scripts, payloads) scanned for Google, Anthropic and Stripe keys, webhook secrets, private keys and database passwords | 1 | Pass: none found |

**Found and fixed:**

1. **The customer header sent a managed-services customer to the older marketplace pages.** Its "New request" went to
   `/orders/new` and "HQ" to `/dashboard`, where the Stripe pay action is, so a customer on a phone could start the
   wrong kind of request.
   - Now, for a customer with a managed service, the header shows Services and New request (`/services/new`), and
     the logo leads to Services.
   - Marketplace clients see the header unchanged. The marketplace pages themselves still exist; what to do with them
     is still owner decision 10.
2. **The "← Your services" back link was too small to tap.** On the report and request pages it was 19 px tall; it's
   now 36 px.

Both changes are in pages served from the project, so the installed 0.4.0 serves them without a reinstall.

**The development server's reload loop is explained.** The update socket logged `reloadPage: "HMR hash mismatch"` each
time a page connected while the server was rebuilding. Each reload connected again, so the loop sustained itself. It's
Next.js 16.4.3's development server, not KELQOR's code, and a production build has no such socket.

- The acceptance's test browser now drops those forced-reload messages.
- In the final runs the server didn't send any, so the filter is loaded but hasn't yet been exercised.
- During your own demo, a portal page could still reload itself in development mode. Reload once and continue.

**Still open (recommended):**

1. **The header logo is still labeled "ForgeX home".** Rename it when the brand decision is made.
2. **Production-build checks for M5** (now in `docs/m5/DEPLOYMENT.md`, item 7):
   - set `no-store` explicitly for the portal, because today it comes from `next dev`;
   - rerun the cache and secrets checks against the production build;
   - require the `Secure` cookie on the hosted portal.

**Recommended at M5 (unchanged):** the hosted staging portal on a real iPhone and Android phone, then the first
customers' own phones. Make it an installable web app only after that.
