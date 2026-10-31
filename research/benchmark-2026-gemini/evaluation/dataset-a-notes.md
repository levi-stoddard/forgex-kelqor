# Notes on dataset A found after its freeze

Dataset A stays unchanged (tag `dataset-a-v1`); findings about it are recorded here instead.

- **2026-10-27, Gem Heating & Air Conditioning** (`gem-heating`, benchmark `c10`): its
  [site terms](https://www.gemheating.com/terms-conditions/) forbid systematic or automated data collection without
  the company's written consent. The pilot read the site with automated tools on 2026-10-26, before site terms were
  checked. The benchmark excludes it, and no ForgeX agent collects data from that site automatically. Contacting the
  company by hand is not affected.
- **2026-10-27, Boss Tool & Manufacturing** (`boss-tool`, `c03`) and **D & A Heating and Cooling** (`da-heating`,
  `c20`): both refuse ForgeX's fetcher, with a bot check and HTTP 403 respectively. The benchmark excludes them, so
  dataset A has no Gemini counterpart for these companies.
- **2026-10-27, Idaho Roofing Contractors** (`c06`) and **Cornerstone Comfort** (`c13`): their site terms forbid
  copying or reproducing site content without permission. Dataset A and dataset B keep only facts and short
  internal quotes, never page copies, and neither may be published.
- The license-search note (Idaho DOPL robots.txt) is in dataset A's manifest.
