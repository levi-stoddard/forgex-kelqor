// Create a ForgeX operator account (the first admin in a fresh database).
// Usage: OPERATOR_PASSWORD='…' npm run create-operator -- --email you@example.com --name "Your Name"
import { passwordProblem } from "../src/lib/auth/password";
import { openDb } from "../src/lib/db";
import { createUserWithRole } from "../src/lib/domain/accounts";
import { refuseWhileBackendRuns } from "./local-backend-guard";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("--email");
  const name = arg("--name") ?? "ForgeX Operator";
  const password = process.env.OPERATOR_PASSWORD;
  if (!email || !password) {
    console.error('Usage: OPERATOR_PASSWORD=... npm run create-operator -- --email you@example.com --name "Your Name"');
    process.exit(1);
  }
  // Check everything before touching the database, which is never opened for a request that would fail.
  const problem = passwordProblem(password);
  if (problem) {
    console.error(`${problem} Nothing was created.`);
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was created.");
  const handle = openDb({ url: process.env.DATABASE_URL || undefined });
  await handle.ready;
  await createUserWithRole(handle.db, { name, email, password, role: "operator" });
  await handle.close();
  console.log(`Operator ${email} created.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
