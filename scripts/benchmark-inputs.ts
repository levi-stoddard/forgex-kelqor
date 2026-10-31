// Builds the Gemini benchmark's inputs from dataset A: each company's name, town and website only, under neutral
// ids in a seeded random order, plus the id map that only the evaluation reads. The research runner never opens
// dataset A or the map. Usage: npm run benchmark:inputs
import fs from "node:fs";
import path from "node:path";

const DATASET_A = "research/pilot-2026-10-treasure-valley/prospects.json";
const ROOT = "research/benchmark-2026-gemini";
const SEED = 20261027;

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const prospects = (JSON.parse(fs.readFileSync(DATASET_A, "utf8")) as { prospects: { id: string; name: string; town: string; website: string }[] }).prospects;
const rand = mulberry32(SEED);
const order = prospects.map((p) => ({ p, key: rand() })).sort((a, b) => a.key - b.key).map((x) => x.p);
const neutralId = (i: number) => `c${String(i + 1).padStart(2, "0")}`;

write(path.join(ROOT, "inputs", "benchmark-25.json"), {
  purpose: "The 25 companies of the Treasure Valley pilot, identity only, for Gemini's independent research.",
  companies: order.map((p, i) => ({ id: neutralId(i), name: p.name, town: p.town, state: "Idaho", website: p.website })),
});
write(path.join(ROOT, "evaluation", "id-map.json"), {
  note: "Neutral benchmark id -> dataset A prospect id. Read only by the evaluation, never by the research runner.",
  seed: SEED,
  map: Object.fromEntries(order.map((p, i) => [neutralId(i), p.id])),
});
console.log(`Wrote ${order.length} companies.`);
