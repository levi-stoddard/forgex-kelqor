// Prepares the acceptance run's isolated copy of the database (test copies only):
//   tsx scripts/prepare-test-copy.ts --dir <copy> --operator-email owner@kelqor.test --operator-name "Acceptance Owner"
//       --enable-sign-in ops@forgex.local [--enable-sign-in another@x] [--precommit-day 4.80] [--precommit-month 19.80]
// The test operator's password comes from KELQOR_TEST_OPERATOR_PASSWORD, never the command line. The folder must hold
// a .kelqor-test-copy marker and lie outside the project's .data folder; it is refused before anything is opened.
// The copy is migrated where it is, the test operator is created or reset (non-demo), sign-in is turned back on for
// the named accounts only, and owner spending authority moves to the test operator. Running it again changes
// nothing more. Precommitted spending is synthetic and recorded as unverified adjustments, in the copy only.
import { precommitSpending, prepareTestCopy, testCopyProblem } from "../src/lib/controls";
import { openDb } from "../src/lib/db";

const args = process.argv.slice(2);
function value(name: string): string | undefined {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
function values(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1] && !args[i + 1].startsWith("--")) out.push(...args[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
  });
  return out;
}
function usd(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error(`${name} takes dollars and cents, such as 4.80.`);
  return Math.round(Number(raw) * 1_000_000);
}

async function main() {
  const dir = value("--dir");
  const operatorEmail = value("--operator-email");
  const password = process.env.KELQOR_TEST_OPERATOR_PASSWORD ?? "";
  if (!dir || !operatorEmail) {
    console.error("Usage: tsx scripts/prepare-test-copy.ts --dir <copy> --operator-email <email> [--operator-name <name>] [--enable-sign-in <email>] [--precommit-day <usd>] [--precommit-month <usd>]");
    process.exit(1);
  }
  if (!password) {
    console.error("Set KELQOR_TEST_OPERATOR_PASSWORD to the test operator's password. Nothing was changed.");
    process.exit(1);
  }
  const problem = testCopyProblem(dir);
  if (problem) {
    console.error(`Refused: ${problem} Nothing was opened.`);
    process.exit(1);
  }
  const dayMicros = usd("--precommit-day");
  const monthMicros = usd("--precommit-month");
  const handle = openDb({ dataDir: dir });
  try {
    await handle.ready;
    const enableSignIn = values("--enable-sign-in");
    await prepareTestCopy(handle.db, { operatorEmail, operatorPassword: password, operatorName: value("--operator-name"), enableSignIn });
    console.log(`Test copy ready: ${operatorEmail} holds owner spending authority${enableSignIn.length ? `; sign-in is on again for ${enableSignIn.join(", ")}` : ""}.`);
    if (dayMicros !== undefined || monthMicros !== undefined) {
      const added = await precommitSpending(handle.db, { dayMicros, monthMicros });
      console.log(`Precommitted synthetic spending: $${(added.addedDayMicros / 1e6).toFixed(2)} today, $${(added.addedMonthMicros / 1e6).toFixed(2)} on the 1st of the month.`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
