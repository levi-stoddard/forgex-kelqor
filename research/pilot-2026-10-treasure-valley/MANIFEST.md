# Dataset A: Claude baseline, v1

Frozen on 2026-10-27. This folder holds Claude's 25-company Treasure Valley research pilot exactly as delivered on
2026-10-26. It is ForgeX's first AI evaluation dataset: dataset A in the Gemini benchmark. Nothing here may be
edited, renamed or deleted; corrections, owner decisions and outcomes are stored elsewhere (see Rules).

> **Public copy.** Third-party email addresses, phone numbers and the names of individual people are replaced with
> `[redacted]`; business names and findings are unchanged. The byte counts and checksums below are those of the
> redacted files, so they differ from the frozen originals, which stay private.

## Files

| File | Contents | Bytes | SHA-256 (first 12) |
| --- | --- | --- | --- |
| `prospects.json` | The record: 25 prospects, each with identity, verification, evidence, hypotheses, existing software, recommendation, value, risks, contact routes, decision-maker, outreach draft, discovery questions and score | 65,640 | `3531ed5006fb` |
| `README.md` | Method, labels, scoring and what wasn't checked, as written on 2026-10-26 | 2,129 | `c265a1d6565a` |
| `decision-doc-export/research-pilot.md` | Export of the "Research pilot" page of my private decision notes, revision 7: the ranked table and the pilot's conclusions | 12,868 | `ee7d0e9eb940` |
| `decision-doc-export/pilot-dossiers.md` | Export of the "Pilot dossiers" page of my private decision notes, revision 5: the 25 dossiers as the owner reads them | 36,595 | `ffdbdee515d7` |

`SHA256SUMS` holds the full checksums, this manifest's included. To check them, run `sha256sum -c SHA256SUMS` from
Git Bash in this folder. The `.gitattributes` file stops Git from changing line endings, so a fresh copy matches
byte for byte.

## Contents at a glance

- **Mix:** 15 construction and home-service firms, 5 manufacturers and 5 IT-service firms, all in Ada and Canyon
  counties, Idaho.
- **Priorities:** 7 Contact first, 2 Second wave, 7 Hold, 1 Discovery only, 5 Skip, 3 Partner. Every score equals
  fit × evidence × reach.
- **Contact first:** Crofts Electric, Gem Heating & Air Conditioning and Cornerstone Comfort (18 each); Running Water
  Plumbing, D & A Heating and Cooling, Walker Electric and Kings Roofing & Contracting (12 each).
- **Evidence:** 79 items (70 observed, 9 inferred), each with a source link and a method. Decision-maker names for
  12 companies. No owner decisions or outcomes are recorded.

## Provenance

- **Researcher:** Claude (`claude-opus-5-5`) in a Claude Code session run for the owner. Tools: web search, page
  reading, a page-source scan, and a browser for the Idaho DOPL license search and defect checks.
- **When:** 2026-10-27 02:36–03:09 UTC (8:36–9:09 pm Mountain time on Oct 26). The record carries one research date,
  2026-10-26, rather than a time for each claim.
- **Usage:** 66 model calls; 185,575 output tokens, 292,186 cache-write tokens and 34.5 million cache-read tokens;
  16 web searches, 38 page fetches, 5 page-source scans and 48 browser tool calls. Counted from the session
  transcript on 2026-10-27.
- **Snapshots:** none were saved, so claims can only be re-checked against live pages, which may have changed since.
- **Commits:** the files were committed as delivered in `790ebff`. This manifest, the checksums and the doc exports
  were added in the commit tagged `dataset-a-v1`.

## Rules

1. Nothing in this folder changes. The files are marked read-only on the owner's machine. Git doesn't keep that
   flag, so the `dataset-a-v1` tag and the checksums are what prove the frozen state.
2. Corrections go in the benchmark's evaluation dataset (dataset C), keyed by prospect `id` and field, each with its
   source and date.
3. Owner decisions and outcomes go in `research/outcomes/pilot-2026-10-treasure-valley.json`, keyed by prospect
   `id`. This replaces the README's plan to copy them into `prospects.json`, whose `founderDecision` and `outcome`
   fields stay empty.
4. Revised research becomes a new folder with a new tag, never an edit here.

## Known issues found after delivery

- Idaho's license search site (`edopl.idaho.gov`) asks all automated agents to stay out: its robots.txt disallows
  every path. The pilot's 15 license lookups were made by Claude driving a browser, before that file was checked.
  No ForgeX agent will query that site automatically again.
- The doc exports were taken on 2026-10-27. Every decision in them reads "Not reviewed".
