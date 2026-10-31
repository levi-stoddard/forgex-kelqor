# Treasure Valley research pilot (2026-10-26)

Twenty-five Boise-area companies researched from permitted public sources, with a dossier, a score and an
unsent outreach draft for each. No business was contacted. `prospects.json` is the record. The owner's review
copy is exported in `decision-doc-export/research-pilot.md` (the original is in my private decision notes).

## Mix

15 construction and home-service firms (HVAC, plumbing, electrical, roofing, remodeling), 5 manufacturers, 5 IT
service firms, all in Ada and Canyon counties.

## Method

1. Candidates came from web searches with directories, review sites, LinkedIn and job boards excluded. A firm stayed
   in only if its own site shows a Treasure Valley address or service area. One candidate, a Wisconsin shop with a
   "Nampa" landing page, was dropped.
2. Each company's homepage was read for services, contact routes, hours, promises, booking and named people. About
   pages were read where names were missing.
3. A page-source scan (one request per homepage, robots.txt honored) looked for known booking, tracking, CRM and
   chat tools. Five sites refused automated requests, and the scan did not work around that.
4. Trade licenses and contractor registrations were checked one by one in the public Idaho DOPL search.
5. Any website "defect" used in a draft was confirmed in a real browser first.

## Labels and scoring

Every claim is labeled observed, inferred or hypothesis. Nothing counts as a confirmed problem until the business
confirms it. Score = fit × evidence × reach, each 0–3. The definitions and priority bands are in `prospects.json`
under `pilot.scoring`.

## Recording decisions

`founderDecision` (contact, hold or reject, with a reason) and `outcome` (sent, replied, call held, Leak Check
bought, setup bought) start empty. Decisions marked in the review copy are copied back here, so qualification accuracy can
be measured against what actually happens.

## Not checked

Idaho Secretary of State records, Census business counts (the API now needs a key), and review sites, LinkedIn,
Google Maps and job boards (excluded by policy).
