# Gemini research benchmark: protocol v1.3

Version 1 was fixed and committed on 2026-10-27, before any paid request. Version 1.3, approved by the owner
after the dry run, is the one below. Earlier versions are kept at the tags `benchmark-protocol-v1`, `-v1.1` and
`-v1.2`. The benchmark measures whether Gemini, working through ForgeX's research module, produces accurate
research, real opportunities and feasible solutions for the same 25 companies as dataset A, at a controlled cost.
Changing anything below after a paid run starts means a new protocol version, recorded here.

## Datasets

| Dataset | Where | State |
| --- | --- | --- |
| A: Claude's pilot | `research/pilot-2026-10-treasure-valley/` | Frozen, tag `dataset-a-v1` |
| B: Gemini's research | `research/benchmark-2026-gemini/<stage>/` | Full run frozen, tag `dataset-b-v1` |
| C: the evaluation | `research/benchmark-2026-gemini/evaluation/` | Claude's review of B in `evaluation/full-run/`; A's ledger and the owner review to come |

## What Gemini receives

- `inputs/benchmark-25.json`: each company's name, town, state and website, under neutral ids c01–c25 in an order
  shuffled with seed 20261027. The mapping to dataset A is `evaluation/id-map.json`, which the runner never reads.
- The prompt in `src/lib/research/spec.ts`, version `gemini-benchmark-v1.3`. It holds the owner's 18-item
  specification and rules word for word, ForgeX's segment and what each qualification category means, ForgeX's
  evidence rules, and ForgeX's service catalog with prices. Run summaries record its version and SHA-256, with
  those of the tool and the report schema (`src/lib/research/schema.ts`).
- The homepage as read by ForgeX's fetcher, and one tool, `read_page`, for other pages on the company's own site.
- In a restricted run (see below), only the company's identity and the reason ForgeX didn't read its site, and no
  page tool.

Gemini receives nothing from dataset A, the id map, this repository or any memory. Google Search grounding, URL
context, other sites, LinkedIn, review sites, job boards and Idaho's license search are all unavailable to it.
Tests in `tests/research.test.ts` check the inputs and prompt for leaks from dataset A.

## Source access

- ForgeX's fetcher only. It honors robots.txt (RFC 9309), identifies itself as `ForgeXResearch/0.1`, connects only to
  public addresses, and never signs in, submits forms or keeps cookies.
- Refusals and bot checks are recorded, never retried another way. Requests to one host are at least 3 s apart.
- Limits: up to 20 pages per company, and 30,000 characters of text per page.
- A preflight checks robots.txt, homepage access and site terms for anti-automation wording. `access-decisions.json`
  records who is included.
- An excluded company with a `restricted` entry gets a restricted run instead of being skipped, so all 25 stay in
  the benchmark. Its homepage is tried once more at run time only if `restricted.recheck` is true. If the homepage
  then loads and no linked terms page restricts automated access, the site is researched in full; otherwise the
  run stays restricted. A site whose terms forbid automated collection (c10) is never fetched.
- Kept: URLs, retrieval times, HTTP status, SHA-256 fingerprints of each page and its text, Gemini's output and
  short quotes. Full page copies are never kept.

## Models and runs

- Models: `gemini-4-argon` and `gemini-3.8-flash`, at Google's default settings.
- Every request uses the Interactions API with `store=false`, structured output against the report schema, and at
  most 32,000 output tokens.
- Each company gets at most 12 turns, plus one repair request if its report fails validation.
- Dry run: 2 Idaho companies outside the 25 (`inputs/dry-run.json`), on both models.
- Full run: all 25 companies on each model. 22 are researched from their websites, and c03, c10 and c20 get
  restricted runs. c01–c05, the first five of the seeded random order, then run twice more on each model to
  measure consistency.
- If a model isn't available to the project, that is reported. No other model is substituted.

## Spending

- A stage runs only if `authorizations.json` records the owner's approval of it, with its cap, inputs and models.
- Before each request, the runner prices its worst case: every input token at the full rate, plus twice the output
  limit at the output rate. It refuses any request that could cross the stage cap or the company cap (Argon $2.00,
  Flash $1.00).
- Every request's actual cost goes to `ledger.jsonl`, an append-only file the runner resumes from.
- The run stops when:
  - the cap is reached;
  - two companies cost more than three times their estimate (Argon $0.60, Flash $0.20);
  - three API errors happen in a row, or three rate-limit refusals in total;
  - a response contains a credential-like string;
  - the model requests any tool except `read_page`.
- Google-side prepaid credits and the AI Studio spend cap are only a backstop. Google says usage can overshoot
  during its billing lag of about 10 minutes.

## Google-side settings

- Use a dedicated ForgeX project, with a key restricted to the Gemini API. The key lives in `.env.local` only.
- On 2026-10-27 the owner approved the existing billing account, which other projects also use, so a separate
  billing account isn't required at this stage. Google's spend cap and any prepaid balance are shared with those
  projects.
- Billing must be linked, so the paid-tier data terms apply, before the first paid request. Claude checks this
  read-only.
- AI Studio logging must be off for the project. It is on by default for projects created on or after Oct 26, 2026.
- Every request uses `store=false`. Google's paid-tier abuse-monitoring logs are kept for a limited period and
  can't be turned off.

## Checks at run time

These checks are mechanical and form part of dataset B:
- each fact's quote is checked against the page it cites, while that page's text is still in memory. Its text is
  checked first, then its technical details: script, frame and host addresses, links, forms, and phone and email
  links. A quote that isn't on the cited page but is on another page the run was served counts as "found on
  another page", which separates a misplaced quote from an invented one;
- only pages that run was served count, because the fetcher's cache is shared between models;
- each contact channel is checked the same way, in the page's text and its technical details;
- rule flags record the breaches a program can see:
  - a web address or host name that no page read shows;
  - an inference whose source wasn't read;
  - a person not presented as an owner, executive or manager;
  - a careers address listed as a contact channel;
  - outreach drafted for "not a fit" or "insufficient evidence";
  - a value not shown as an illustrative calculation with stated assumptions;
  - in a restricted run, any category but "insufficient evidence";
- whether a claim says more than its quote is left to the evaluation;
- each record lists every page the run was served, including pages already cached from another model's run
  (`fromCache`);
- `npm run benchmark -- recheck --stage <name>` later repeats the checks on saved records by re-fetching their
  pages, flags any page whose fingerprint changed since the run, and writes to `<stage>/rechecks/`. A restricted
  run's site is never fetched there. A quote on a page that changed since the run can fail a re-check without
  being wrong, so the run-time check is the one that counts.

## Evaluation (dataset C)

Built only after dataset B is frozen.
- **Claim ledger:** every checkable claim from A and B is listed and checked against a primary source. Claims are
  never checked against the other dataset.
- **Verdicts:** supported, contradicted, unsupported, unverifiable, or changed since the research date. Each
  company field is then labeled both right, only Claude, only Gemini, both wrong, neither verifiable, or changed.
- **Scoring:** factual accuracy is scored apart from the commercial, technical and efficiency reviews. "No fit" and
  "already owns the fix" score as correct when the evidence supports them.
- **Owner review:** the owner audits 20 random verdicts and blind-reviews 10 dossier pairs, and checks license
  claims by hand where needed.
- **Restricted runs:** c03, c10 and c20 are scored apart from the 22, because only dataset A read their websites.
  A restricted run passes if its report states no facts, has no rule flags and is rated "insufficient evidence".
  The owner checks dataset A's claims about these companies by hand where needed.

**Pass bar** (also applied to dataset A):
- every included company identified correctly (22 of the 25 after the preflight of 2026-10-27);
- no fabricated people, numbers, emails, license numbers or links;
- at least 90% of checked facts supported, and under 5% of hypotheses presented as facts;
- at least 90% of cited sources load and support their claim;
- at least as useful as Claude's dossier for half the blind-reviewed companies;
- under $1 per company at post-promotion prices.

## Changes

- **v1.1, 2026-10-27, before any paid request:** company caps raised from $1.50 to $2.00 (Argon) and from $0.50 to
  $1.00 (Flash). The worst-case reservation, twice the output limit per request, would otherwise stop multi-turn
  research early. Stage caps are unchanged, so total spending can't exceed what the owner authorized.
- **v1.2, 2026-10-27, after the dry run and before the full run** (owner-approved): quotes are also checked
  against a page's technical details; checks count only pages served to that run; records list cached pages among
  their sources; and the `recheck` command was added. The dry-run records keep their original checks. Their
  re-check is in `dry-run/rechecks/`.
- **v1.3, 2026-10-27, after the dry-run evaluation and before the full run** (owner-approved). Eight corrections:
  1. The prompt (`gemini-benchmark-v1.3`) names people only when the company presents them as owners, executives
     or managers, and never lists careers addresses.
  2. Anything known from memory is a hypothesis, a quote must come from the cited page, and no web address may
     appear unless a page shows it.
  3. The prompt gives ForgeX's segment and defines the four categories.
  4. A value must be an illustrative calculation from the site's prices.
  5. There is no outreach for "not a fit" or "insufficient evidence", and no promised results.
  6. The prompt and tool say several pages can be read at once.
  7. The checks gain "found on another page", look for contact channels in page details, and add rule flags.
  8. The three excluded companies get restricted runs.

  The 25-company cohort is unchanged, and the owner kept the shared billing account. The dry-run records keep
  their original checks; their v1.3 re-check is in `dry-run/rechecks/`.

## Stages and approvals

| Stage | Cap | Status |
| --- | --- | --- |
| Dry run, 2 companies | $5 | Authorized and run 2026-10-27; spent $0.5141 |
| Full run, 25 companies | $20 ($55 proposed in v1) | Authorized and run 2026-10-27; spent $6.0570, including $1.4280 on the consistency rounds |
| Learning test, 20 new companies | Set later | Not authorized |
