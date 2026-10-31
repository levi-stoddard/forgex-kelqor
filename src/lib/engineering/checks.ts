import path from "node:path";
import { CHECK_COMMANDS, type CheckCommandId, type EngCheckResult } from "./contract";
import { redactOutput, resolveProgram, runProgram, scrubbedEnv } from "./process";

// The checks the owner approved for a mission, run by KELQOR in the mission's worktree after the agent finishes.
// Only the fixed commands in CHECK_COMMANDS can run, without a shell, with secrets removed from the environment and
// npm/npx kept offline, so a check can neither publish nor download.

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 6_000;

export async function runChecks(worktree: string, checks: CheckCommandId[], signal: AbortSignal, onStart?: (label: string) => Promise<void>): Promise<EngCheckResult[]> {
  const results: EngCheckResult[] = [];
  for (const id of checks) {
    const c = CHECK_COMMANDS[id];
    if (!c) continue;
    if (signal.aborted) break;
    await onStart?.(c.label);
    // NoDefaultCurrentDirectoryInExePath stops cmd.exe (and npm's own scripts) from running a program planted in the
    // worktree when they look a name up.
    const env = scrubbedEnv({ npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", CI: "1", NoDefaultCurrentDirectoryInExePath: "1" });
    // Resolved on PATH, never in the worktree, where an agent could plant its own npm.cmd or node.exe.
    const program = resolveProgram(process.platform === "win32" && (c.program === "npm" || c.program === "npx") ? `${c.program}.cmd` : c.program);
    const cmd = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : null;
    if (!program || (program.endsWith(".cmd") && !cmd)) {
      results.push({ check: id, label: c.label, exitCode: null, passed: false, timedOut: false, durationMs: 0, output: `${c.program} wasn't found on the backend's PATH, so the check couldn't run.` });
      continue;
    }
    // npm and npx are .cmd files on Windows, which only start through cmd.exe. /s strips the outer quotes, leaving the
    // quoted absolute path and the fixed arguments; passed verbatim so Node doesn't quote them again.
    const r = program.endsWith(".cmd")
      ? await runProgram(cmd!, ["/d", "/s", "/c", `""${program}" ${c.args.join(" ")}"`], { cwd: worktree, timeoutMs: CHECK_TIMEOUT_MS, signal, env, verbatim: true })
      : await runProgram(program, [...c.args], { cwd: worktree, timeoutMs: CHECK_TIMEOUT_MS, signal, env });
    const output = redactOutput(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim());
    results.push({
      check: id,
      label: c.label,
      exitCode: r.exitCode,
      passed: r.exitCode === 0 && !r.timedOut && !r.cancelled,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      output: output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output,
    });
  }
  return results;
}
