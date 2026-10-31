// Looks for short phrases on specific pages with ForgeX's polite fetcher (robots.txt honored), for the evaluation.
// Usage: npx tsx <this file> "<url>=<needle>|<needle>" ... ; prefix a needle with "raw:" to search the page's HTML.
import { SiteFetcher, nodeTransport } from "../../../../../src/lib/research/fetcher.ts";

const norm = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const fetcher = new SiteFetcher();
for (const arg of process.argv.slice(2)) {
  const at = arg.indexOf("=");
  const url = arg.slice(0, at);
  const site = new URL(url).origin + "/";
  const p = await fetcher.fetchPage(url, site);
  console.log(`\n${url} -> ${p.record.outcome}`);
  if (!p.inventory) continue;
  const inv = p.inventory;
  const hay = norm([inv.title, inv.description, inv.text, ...inv.links.map((l) => `${l.url} ${l.text}`), ...inv.forms.map((f) => f.action)].join("\n"));
  let raw = "";
  for (const nd of arg.slice(at + 1).split("|")) {
    const isRaw = nd.startsWith("raw:");
    const needle = norm(isRaw ? nd.slice(4) : nd);
    if (isRaw && !raw) {
      // Same page, already allowed by robots.txt above; one plain GET for its HTML.
      const res = await nodeTransport(new URL(p.record.finalUrl), { maxBytes: 2_000_000, timeoutMs: 20_000 });
      raw = res.body.toString("utf8").toLowerCase();
    }
    const h = isRaw ? raw : hay;
    const i = h.indexOf(needle);
    console.log(`  * "${nd}": ${i < 0 ? "NOT on the page" : "..." + h.slice(Math.max(0, i - (isRaw ? 250 : 120)), i + needle.length + (isRaw ? 250 : 120)).replace(/\s+/g, " ") + "..."}`);
  }
}
