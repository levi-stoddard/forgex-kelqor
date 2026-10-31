# Milestone 4: Customer AI Operations

**Status: built and tested with synthetic customers, simulated processing and simulated billing. Version 0.4.0, branch
`kelqor/m4`.** No AI model runs for a customer yet, no payment system is connected, and no real customer is set up.

## What it does

KELQOR runs managed AI services for customer organizations. Customers use a web portal; KELQOR's operators use the
Command Center.

- **Customers and onboarding:**
  - **Organizations and accounts:** a customer is an organization (the existing `orgs`) with customer accounts (role `client`).
  - **Onboard:** Customer Operations › **Onboard** creates the organization and its first contact. You get a one-time
    invitation link (the existing invite flow); the contact sets a password with it. KELQOR sends nothing.
  - **Synthetic customers:** a synthetic or practice customer is a test record and never counts as real business.
- **Services:**
  - **Categories:** six configurable categories: quote and inquiry intake, document processing, business reporting,
    workflow coordination, customer support, and industry workflow.
  - **Per customer:** each customer service is a category plus its own settings: a rate card, the approval rule, required
    details, job types and a turnaround commitment.
  - **Plans:** three plans: Starter, Growth and a 30-day Pilot.
  - **Agreements:** activating a service copies the plan's terms into its agreement, so later price changes never alter
    it. A service can be paused, resumed or ended.
- **The request workflow:** customer request → processing → KELQOR review → customer approval (when the rule asks) →
  deliverable → report.
  - **Processing:** quote intake has a dedicated processor. It reads the inquiry (contact, job type, quantity, material,
    sizes, finish, deadline) and lists what's missing as questions. It then prices a draft quote from the customer's own
    rate card, stating every assumption, and drafts a reply. The other categories use a generic simulated assistant until
    each gets its own processor. **All processing is simulated: no AI model is called, and it costs $0.**
  - **KELQOR review:**
    - The reviewer sees everything processing found, with the evidence, and can edit the quote lines and the reply.
    - Approving releases the result. Asking sends questions to the customer; failing closes the request with a message.
    - Every decision is bound to the exact draft the reviewer saw.
    - The customer never sees the draft, the internal note or costs before release.
  - **Customer approval:** bound to the exact result the customer saw. The customer can approve, ask for changes (back to
    KELQOR) or decline. Answering KELQOR's questions re-processes the request.
- **Customer Command Center** (web: **Services**):
  - active services and what each delivers;
  - work waiting on the customer, in progress and completed;
  - results with priced quotes and a reply to send;
  - usage against the plan;
  - simulated invoices;
  - a monthly report: requests, median turnaround, on-time against the commitment, quoted value, missing details
    caught and approvals.
- **Customer Operations** (desktop, for operators):
  - every customer, with its open, needs-review, waiting-on-them and overdue or failed counts;
  - a cross-customer review queue;
  - each customer's services, requests, simulated invoices (prepare, issue, record payment), the report, and the
    operating cost and margin;
  - entering a request on a customer's behalf.
- **Commercial foundations:**
  - **Invoices:** the monthly fee, a setup fee in the month the service starts, and usage beyond the plan.
  - **Costs:** a customer's cost combines AI processing (simulated, $0) with review minutes × a labor rate. The rate,
    $60/h, is an assumption until you set it.
  - **Simulated only:** **the database refuses any invoice that isn't marked simulated.**

## Isolation

- **Customers:** every managed-service function takes the signed-in account. A customer account can reach only its own
  organization. Anything else answers "not found", so even its existence doesn't show, and a customer naming another
  organization is ignored.
- **Operators and builders:** operators manage every customer; builders have no part in managed services.
- **The desktop Command Center:** still operators only.
- **Tests:** they cover cross-customer reads and actions, attempts on operator controls, and the customer view hiding
  KELQOR's internals. The installed-app acceptance checks the same from a real browser.

## Demonstration (synthetic, after installing 0.4.0)

1. In KELQOR, open **Customer Operations**.
2. Onboard "Treasure Valley Fabrication (synthetic)": record **Test**, any contact name, and an email such as
   `terry@tvfab.test`. Copy the invitation link it shows.
3. Open the customer:
   1. **Add** "Quote and inquiry intake" on Starter, then **Activate** it.
   2. To always see the customer-approval step, set "Customer approves results above" to 0 when you add it. The default
      is $2,500.
4. Open the invitation link in your browser and set a password. You're now the customer. Open **Services** ›
   **Send a request**, and paste an inquiry, for example:

   ```text
   Hi, this is Dana Ruiz from Ridgeline Builders (208-555-0199, dana@ridgeline.test).
   We need 12 steel handrail brackets, 1/4" plate, powder coated black, for a deck job. Each is about 6 x 8 inches.
   We need them by Nov 15. Can you quote?
   ```

5. In KELQOR, go to **Review queue** and open the request:
   - Look at what processing found, the questions and the priced draft.
   - Adjust a line or the reply if you like.
   - Click **Approve and release**.
6. In the browser, open the request: the priced quote and the reply are there. Click **Approve**.
7. In KELQOR, go to the customer and click **Prepare the invoice**, then **Issue**. The customer's **Services** page shows
   the invoice (simulated), and **Monthly report** shows the work and the quoted value. The customer page in KELQOR
   shows the cost and margin.

## Known limits

- **Processing:** simulated. A live processor would run through M2B's metered pathway (approval, reservation, ledger);
  that needs your authorization.
- **Reach:** the customer portal runs on this computer only (`127.0.0.1:3000`); real customers need M5 hosting.
- **Email:** nothing is sent. Invitation links are copied by hand, and replies are copied by the customer.
- **Invoices:** monthly fees aren't prorated for a service started mid-month.
- **Generic processors:** the five categories other than quote intake produce an organized summary only, until each
  gets its own processor.
