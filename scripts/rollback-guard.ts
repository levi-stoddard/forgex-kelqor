import fs from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { BACKUP_APPROVAL_FILE } from "../src/lib/db";

// Before a rollback drops Milestone 4's tables: says what will be deleted, and refuses to delete issued or paid
// invoices (financial records) unless a verified backup (npm run db:backup) was made in the last hour.
export async function guardFinancialRecords(client: PGlite): Promise<void> {
  const exists = (await client.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name = 'invoices'")).rows[0].n > 0;
  if (!exists) return;
  const count = async (sql: string) => (await client.query<{ n: number }>(sql)).rows[0].n;
  const issued = await count("select count(*)::int as n from invoices where status in ('issued', 'paid')");
  const requests = await count("select count(*)::int as n from service_requests");
  const services = await count("select count(*)::int as n from customer_services");
  console.log(`This deletes ${services} customer services, ${requests} requests and ${issued} issued or paid invoices (all simulated).`);
  if (issued === 0) return;
  const approval = fs.existsSync(BACKUP_APPROVAL_FILE()) ? (JSON.parse(fs.readFileSync(BACKUP_APPROVAL_FILE(), "utf8")) as { verifiedAt?: string }) : null;
  const fresh = approval?.verifiedAt && Date.now() - new Date(approval.verifiedAt).getTime() < 60 * 60 * 1000;
  if (!fresh) {
    console.error("Issued invoices would be deleted, and there's no verified backup from the last hour. Run npm run db:backup first. Nothing was rolled back.");
    process.exit(1);
  }
}
