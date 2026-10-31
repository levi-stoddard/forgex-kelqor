// Gives owner spending authority to your KELQOR account, or takes it away. Only this command can do either: no
// screen and no backend route can grant or change it. Run it while KELQOR is closed:
//   npm run designate-founder -- --email you@example.com
//   npm run designate-founder -- --email someone@example.com --replace     (moves it from the current holder)
//   npm run designate-founder -- --email you@example.com --revoke
// It asks for that account's password (never put it on the command line). Moving or revoking authority voids every
// open mission approval, and both are written to the audit log. It doesn't read .env.local.
import readline from "node:readline";
import { designateFounder, founderAuthority, revokeFounder } from "../src/lib/controls";
import { openDb } from "../src/lib/db";
import { refuseWhileBackendRuns } from "./local-backend-guard";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
function value(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Reads a password without showing it: masked on a terminal, one line when piped. */
function askPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      let done = false;
      rl.once("line", (line) => {
        done = true;
        rl.close();
        resolve(line);
      });
      rl.once("close", () => {
        if (!done) resolve("");
      });
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(typed);
        }
        if (ch === "\u0003") {
          finish();
          return reject(new Error("Cancelled. Nothing was changed."));
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const email = value("--email");
  if (!email || email.startsWith("--")) {
    console.error("Usage: npm run designate-founder -- --email you@example.com [--replace | --revoke]");
    process.exit(1);
  }
  if (flag("--replace") && flag("--revoke")) {
    console.error("Use --replace or --revoke, not both. Nothing was changed.");
    process.exit(1);
  }
  await refuseWhileBackendRuns("Nothing was changed.");
  const password = await askPassword(`Password for ${email}: `);
  if (!password) {
    console.error("No password was entered. Nothing was changed.");
    process.exit(1);
  }
  const handle = openDb({ url: process.env.DATABASE_URL || undefined });
  try {
    await handle.ready;
    if (flag("--revoke")) {
      await revokeFounder(handle.db, { email, password });
      console.log(`Owner spending authority was revoked from ${email}. Open mission approvals were voided.`);
    } else {
      const before = await founderAuthority(handle.db);
      const now = await designateFounder(handle.db, { email, password, replace: flag("--replace") });
      if (before?.userId === now.userId) console.log(`${now.email} already holds owner spending authority (since ${now.since}). Nothing changed.`);
      else console.log(`${now.email} now holds owner spending authority.${before ? ` It was taken from ${before.email}, and open approvals were voided.` : ""}`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
