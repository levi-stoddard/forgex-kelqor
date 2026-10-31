# Commercial validation playbook: the first three paying customers

Goal: find out, with real contractors and real money, whether owners will pay ForgeX to stop losing leads, at
prices and owner hours that can grow into a business. Nothing here has happened yet. As of 2026-10-26 there are
no conversations, customers or revenue, and nothing in this document should be presented as traction.

**The owner (or someone they authorize) does all outreach and sends every message.** Claude drafts; people send.

This replaces the first draft of 2026-10-26 (three verticals, a $750 audit, $2,500–$5,000 custom Work Orders).
The stress test behind the change is in my decision notes (kept private) and in
[`docs/model/first_customers.py`](model/first_customers.py).

## 1. Who to sell to first

**Owner-led HVAC, plumbing and electrical contractors** that:

- have about 10–75 staff (roughly $2M–$15M in revenue) and an owner who still decides purchases;
- **pay for leads** (Google Local Services Ads, Google Ads, Angi, Thumbtack, Facebook), so a lost lead is money
  already spent;
- run Jobber, Housecall Pro, ServiceTitan or a similar field-service tool that can export calls, jobs and quotes;
- are reachable through someone the owner knows, or within driving distance.

Disqualify for now: no paid leads; under about 10 staff; the owner isn't involved; they only want an AI voice
receptionist (their software vendor already sells one); anything that moves money automatically.

Why this segment, briefly: the owner can see the loss in dollars (paid leads that never got a callback), the data
to measure it already exists in tools they use, and a small fixed-price entry offer fits how they buy software.
The weak spot: single features such as missed-call texting are cheap add-ons in their own software, so ForgeX has
to win on connecting every source, alerts, and cost per booked job, not on texting alone.

Fallback segment if the day-30 gate fails: small accounting and bookkeeping firms, pitched in November and
December on document collection before tax season.

## 2. The three offers

| Offer | Price | Owner hours (estimate) | What it has to prove |
| --- | --- | --- | --- |
| Revenue Leak Check | $500, credited in full to a fix ordered within 30 days | 4–6 | Owners will pay to see the number; it produces the data to price the fix |
| Lead-to-job pipeline | $1,800 setup + $149/month | 12–20 for the first build, about 8 once templated | Recurring revenue, and a measured change in response time and booked jobs |
| Owner's Monday numbers | $1,200 setup + $99/month | 10–16 | A second sale to the same owner |

The acceptance criteria for each are in the catalog (`src/lib/scoping/catalog.ts`) and on `/home-services`.
No discounts: the Leak Check credit is the discount. One exception is allowed: a free Leak Check for one "design
partner" who agrees in writing to be a named reference.

Not offered yet: AI voice answering, custom Work Orders, anything needing a builder other than the owner.

## 3. Finding 40 conversations, warm first

The model's funnel assumptions (unverified): about **17 warm introductions** produce 10 calls and 3 paid Leak
Checks in about 14 hours of the owner's time. Reaching the same 3 through cold email takes about **850
contacts** and 55 hours. Work the channels in this order:

1. **Your own network.** Anyone who owns or works at a contractor, or sells to them: insurance agents, accountants,
   bankers, equipment reps, property managers. Ask for an introduction, not a meeting.
2. **Supply houses and distributors.** Counter managers and outside sales reps at HVAC, plumbing and electrical
   distributors know every contractor in their area. (Hypothesis: test it with two or three branches.)
3. **Local trade association chapters** (ACCA, PHCC, IEC or NECA chapters). Go to a meeting as a guest and ask the
   chapter director which members struggle with leads.
4. **Contractor-software communities** (user groups and forums for Jobber, Housecall Pro, ServiceTitan). Read the
   rules first; answer questions, don't pitch.
5. **Targeted cold email, last.** Small, researched lists only, each note with a real observation (for example,
   reviews that mention slow callbacks). Include a postal address and an opt-out (CAN-SPAM). Never text a prospect
   who hasn't opted in (TCPA).

Introduction request (draft):

> Hi [Name] — I'm starting a small company that fixes lead follow-up for HVAC and plumbing shops: missed calls,
> slow callbacks, paid leads nobody chases. Do you know an owner who'd give me 20 minutes? I'm not selling on the
> first call; I want to see how they handle leads today.

Direct note (draft):

> Subject: leads at [Company]
>
> Hi [Name] — I'm [your name], starting ForgeX in [region]. I help contractors who pay for leads make sure every
> one gets a fast reply and a callback. Could I have 20 minutes to see how leads are handled at [Company] today? If
> there's nothing worth fixing, I'll say so.

Follow up once after 5 business days. Never claim customers, results or partnerships ForgeX doesn't have.

## 4. The call (20–30 minutes) and the ask

1. Where do your leads come from, about how many a month, and what do you spend on them?
2. Walk me through the last lead that came in after hours. What happened to it?
3. Who answers the phone, and what happens when they can't?
4. How do you know how fast each lead gets a response?
5. Which lead source is your best and your worst per booked job? How do you know?
6. What have you tried: an answering service, an AI receptionist, your software's add-ons? What happened?
7. If this were fixed, which number would tell you? (Their answer becomes an acceptance criterion.)

**Always end with the ask:** "I can measure it. The Revenue Leak Check is $500. You send three exports; within
five business days you get your real answer rate, response time by lead source and open quotes, with a dollar
figure. If you order a fix within 30 days, the $500 is credited."

Record for every call: pain (0–3), monthly lead spend, decision-maker (yes/no), said yes to the Check (yes/no), and
any objection in their own words.

## 5. Running a sale in the app

1. After the call: **Pipeline → New Work Order**. Enter the company, the contact and what they told you, and pick
   the starting offer. The client never fills in a sign-up form.
2. Review the draft scope. The quote form starts at the list price with a **$0 builder payout (in-house)** and, for
   setups, "the monthly fee is part of the service" ticked.
3. Send the quote, then send the **one-time client link** yourself (it is shown once, lasts 14 days, and a new one
   can be made under "Client access"). Nothing is emailed by the app until an email provider is approved.
4. The client sets a password, reviews the scope and criteria, accepts and pays. Until Stripe live mode is
   approved, record the bank transfer as an operator. **Never use a TEST payment for a real client.**
5. To deliver in-house, create a builder account for yourself with a separate email, record your identity check
   and approve it, then assign it with a $0 payout. Submit evidence for each criterion; the client accepts.
6. For setups, the monthly service is recorded automatically at acceptance. **Monthly billing is manual (invoice)
   until Stripe subscriptions are added**, which only matters once the first setup goes live.

## 6. Gates

| Gate | When | Continue if | Otherwise |
| --- | --- | --- | --- |
| 1 | Day 30 | 3 paid Leak Checks, or 1 paid setup, from no more than 60 qualified conversations | Change the offer or try the fallback segment. Build no new product until one passes |
| 2 | Day 60 | 2+ paid setups; actual hours no more than 1.5× the estimate; at least one client with a measured change (median response time, booked jobs from recovered leads) | Fix delivery or pricing before selling more |
| 3 | Day 120 | About 3 new setups a month; monthly churn at or under 5%; owner hours within about 140 a month | Decide: raise prices, add a seller, or hold |

**Stop rule:** fewer than 2 paid Leak Checks after 40 qualified conversations means the problem isn't urgent
enough at this price for this segment. Test the fallback segment, or sell the scoping and acceptance software to
automation agencies instead.

What the model says these gates mean (assumptions, not forecasts): at 1.5 new setups a month the business reaches
about $5,000 a month of operating profit by month 18 and does not cover a $6,000 owner draw; at 3 a month it
covers the draw from about month 3. The number of new setups a month moves the result more than any price.

## 7. Money before the first revenue (each item needs owner approval)

| Item | Cost (estimate) | Needed when |
| --- | --- | --- |
| Twilio number and A2P 10DLC registration (brand $46 + campaign vetting $15, verified on Twilio's help center) | about $61–70 once, then a few dollars a month | Before the first pipeline build (registration can take 1–3 weeks) |
| Domain and business email | about $20 a year + $6–7 a month | Before sending from a ForgeX address |
| Client agreement (for example the free Common Paper Professional Services Agreement) | $0; counsel review extra | Before the first paid Leak Check |
| Tech E&O and general liability insurance | quotes are free; about $100 a month assumed | Before the first setup |

Target: no more than about $300 before the first revenue, excluding insurance and legal review.

## 8. What to record on every Work Order

Estimated vs. actual owner hours, revision rounds, days from call to quote and from payment to acceptance,
payment method and fees, and the client's own words about the outcome. For the pipeline, also: answer rate and
median response time before (from the Leak Check) and 30 days after go-live, and jobs booked from text-backs and
alerts. These numbers replace the assumptions in `docs/model/first_customers.py`.
