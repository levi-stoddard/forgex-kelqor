// Writes everything KELQOR holds for one customer organization to a JSON file (offboarding, or a data request): only
// that organization's records, and no password hashes. Close KELQOR first; the database opens in one program at a time.
//   npm run customer:export -- --org <organization id> --out customer.json
import fs from "node:fs";
import { getDb } from "../src/lib/db";
import { exportCustomer } from "../src/lib/ops/export";
import { refuseWhileBackendRuns } from "./local-backend-guard";

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const org = arg("--org");
  const out = arg("--out");
  if (!org || !out) {
    console.error("Usage: npm run customer:export -- --org <organization id> --out <file.json>");
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was exported.");
  const data = await exportCustomer(await getDb(), org);
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  console.log(`Exported ${data.organization.name}: ${data.services.length} services, ${data.requests.length} requests, ${data.invoices.length} invoices, to ${out}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
