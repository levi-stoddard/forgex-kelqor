# Evaluation of the full run (dataset C, part one)

Claude's checks of dataset B (tag `dataset-b-v1`), made on 2026-10-27 after B was frozen. They cover Gemini's
research only. Claude also produced dataset A, so nothing here compares the two datasets; that is the owner's
blind review.

- `review.json`: every quote, channel and flag the run-time checks could not confirm, re-checked on the live page; a
  seeded sample of 25 facts per model judged statement against quote; the key evidence behind each prospect, each
  illustrative value and each disputed category; errors the checks missed; consistency; costs; and four gaps in the
  run-time checks.
- `specifics.json`: every number, phone and email in a fact or inference statement, looked for on the pages that
  run was served.
- `scripts/`: the read-only scripts used, run from the repository root. They re-read pages with ForgeX's fetcher
  (robots.txt honored, 3 s between requests to a host, page text kept in memory only) and make no model calls.

Verdicts map to the protocol's as follows: "supported by quote", "supported beyond quote" and "supported, wrong page
cited" are supported; "contradicted" is contradicted; a "false alarm" is a run-time flag the evidence clears.

Still to do under protocol v1.3:
- the claim ledger for dataset A, and the field-by-field comparison of A and B;
- the owner's audit of 20 random verdicts, blind review of 10 dossier pairs, and hand checks of license claims.
