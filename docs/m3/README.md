# Milestone 3: Engineering Agent Command Center

**Status: built and tested with the simulated agent, staged as KELQOR 0.3.0 on branch `kelqor/m3`. Not installed.**
Real agent execution is unverified: Claude Code is built but gated off, and Antigravity is a manual handoff. Both stay
labeled unverified until an owner-authorized run succeeds.

## What it does

The owner gives an AI agent an engineering task, watches it, inspects what it produced, and decides what is applied.

- **Workspaces.** The owner registers a git repository's top folder (a linked worktree, KELQOR's data folders,
  system folders and the home folder are refused). KELQOR also creates its own small **demo workspace** for simulated
  missions.
- **Missions.** A title, the task, the deliverables, the workspace, the agent, and permissions: whether the agent may
  change files, and which checks KELQOR may run (`node --test`, `npm test`, `npx vitest run`, `npx tsc --noEmit`).
- **Lifecycle.** Draft → Awaiting approval → Approved → Running → Review → Completed / Failed / Interrupted.
  - Only the owner approves, starts, cancels, resumes, reviews and applies. An operator can draft and submit.
  - Every action carries a request id and acts once. Every state change is a check-and-set, so double clicks or two
    windows change a mission once.
  - The approval binds a fingerprint of the title, task, deliverables, workspace and branch, agent and permissions.
    Any edit voids it.
- **Isolation.** Each mission runs in its own detached git worktree, cut from the base branch's commit at start (beside
  the database: `.data/engineering/worktrees/<mission>` for your data). The workspace's files and checked-out branch
  are never touched.
- **Review.** KELQOR collects the change (diff, changed files, protected files) and the check results. The change moves
  through **Proposed → Locally tested → Owner-approved → Applied**, each shown separately.
  - Applying commits the change to a **new local branch** `kelqor/eng/e-NNNN`. Nothing is ever pushed, merged or
    checked out.
- **Durability.** The log keeps every action, state, agent activity, check and error. A mission left running when
  KELQOR closes becomes Interrupted (its worktree kept) and resumes only on the owner's word. Cancel interrupts it.
- **Cost.**
  - Simulated: $0.
  - Claude Code: its own reported `total_cost_usd`, shown as agent-reported and unverified.
  - Antigravity: unknown.
  - Engineering costs aren't in the M2B ledger or caps yet (a decision below).

## Agents

| Agent | How KELQOR drives it | State on this computer (2026-10-28) |
| --- | --- | --- |
| Simulated agent | Built in; calls no AI, costs nothing, always labeled. It changes files only in the demo workspace | Working end to end |
| Claude Code | Headless `claude -p --output-format stream-json`, with: `--restricted` (no command or web tools; user, project and local settings ignored; file tools confined to the worktree), `--strict-mcp-config`, an exact `--tools` list (Read, Grep, Glob, plus Edit and Write if allowed), `--permission-mode dontAsk`, `--no-session-persistence` and `--max-budget-usd 2` | **Built, gated off.** Claude Code 2.1.309 is installed with the Claude desktop app (not on PATH); KELQOR finds it there or at `KELQOR_CLAUDE_CODE_PATH`. Missions can be approved, but Start is refused until live execution is authorized |
| Claude Code (manual handoff), added in 0.3.1 | **Manual handoff.** KELQOR prepares the isolated worktree and the brief; you run Claude Code yourself in that folder (the Claude app's Code tab, or `claude` in a terminal there), then **Import results**. KELQOR never starts Claude Code in this mode, so it can't enforce the mission's permissions inside it (keep Claude Code's own permission prompts on). Cost is unknown: it's billed to your own Claude plan | Available. The automated adapter above stays built and off |
| Gemini Antigravity | **Manual handoff.** Antigravity 2.24 offers no supported interface for another program to give it a task and follow it. KELQOR writes the task brief, opens the worktree in Antigravity when the owner clicks, and the owner imports the result; KELQOR then collects and reviews the change like any other | Found at `%LOCALAPPDATA%\Programs\Antigravity`. KELQOR can't start, watch or cost an Antigravity run |

## Claude integrations: what is built

All of it is kept. Nothing automatic runs until you authorize it, and anything turned on needs a supervised first run to
verify it.

| Integration | Status | What exists, and what doesn't |
| --- | --- | --- |
| **Claude Code, automated** (`claudeCodeAgent`, `src/lib/engineering/agents.ts`) | **Implemented, disabled, unverified** | **Exists:** <br>• It finds the binary (`KELQOR_CLAUDE_CODE_PATH`, PATH, or the Claude app's copy) and reads its version. <br>• The headless command line: `-p`, `stream-json`, `--restricted`, `--strict-mcp-config`, exact `--tools`, `.git` and shell denied, `dontAsk`, `--max-budget-usd 2` and no session persistence. <br>• It shows each tool use as live activity, reads the reported cost as agent-reported, and handles cancellation (the process tree is stopped), timeout and errors. <br>• Tests with a fake process: arguments, output parsing, cost, and the live gate. <br>**Off:** `LIVE_AGENT_EXECUTION_AUTHORIZED = false`; Start is refused, and the owner's approval is still required. <br>**Not built:** choosing the sign-in or billing (API key or subscription); counting its cost against the $5 and $20 caps; a budget per mission rather than the fixed $2; resuming a Claude Code session after an interruption (a resumed mission starts the agent again in the same worktree); a live run to verify the flags against 2.1.309 |
| **Claude Code, manual handoff** (`claudeCodeManualAgent`) | **Implemented (0.3.1)** | **Exists:** the brief, opening the folder, import, then KELQOR's own collection, checks, review and apply. <br>**Can't do:** limit or watch Claude Code inside your session, or know its cost |
| **Claude, copy and paste** (0.3.2) | **Implemented** | **Exists:** **Copy assignment** puts the complete assignment on the clipboard (the task, deliverables, rules and workspace); it starts nothing. **Save response** stores Claude's pasted answer in the mission log as unverified evidence: up to 20,000 characters, with anything key- or password-shaped removed. <br>**Never:** a saved response never changes the mission's state, its change, its checks, its approval or what may be applied |
| **Claude API, mission review** (`claudeReviewProvider`, `src/lib/ai/claude.ts`; M2B) | **Implemented, unavailable** | **Exists:** the Anthropic SDK adapter with token counting, tickets, no retries, and costs in the ledger and the caps. <br>**Unavailable:** no `ANTHROPIC_API_KEY` is configured. <br>**Works:** the simulated reviewer |
| **Claude API, Work Order scoping** (`src/lib/scoping/ai.ts`) | **Implemented, disabled** | **Exists:** the code. <br>**Off:** `AI_SCOPING_AUTHORIZED = false`. <br>**Used now:** template scoping |
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | **Not built** | **Not installed:** the automated adapter uses the CLI instead. Adopting it would be a new dependency |

## Security model

- **File boundary:** agents work only in their worktree.
- **Protected changes:** a change touching `.env*`, `.git`, `.data`, `node_modules`, key files, a symlink or a
  submodule is flagged, and it can't be approved or applied.
- **Running programs:**
  - Every program is resolved to an absolute path on the backend's PATH, never in the worktree, so a planted
    `node.exe`, `npm.cmd` or `git.exe` can't run.
  - Programs run without a shell, with a time limit and cancellation, and with secrets (keys, tokens, passwords,
    `DATABASE_URL`) removed from their environment. Output is redacted.
- **Git safety:** every git call runs with hooks and fsmonitor off and no network protocol allowed, so neither a
  workspace's configuration nor an agent's change can run code through git.
- **No commands for agents:** no agent may run commands. A check runs the code it tests, which for a real agent is code
  the agent wrote, so:
  - the simulated agent's checks run automatically;
  - a real agent's checks wait for the owner's **Run checks**, after reading the diff.
- **Offline checks:** npm and npx run offline, so a check can neither publish nor download.

## Tests

- **Automated tests:**
  - `tests/m3-engineering.test.ts` (17): the lifecycle with real git worktrees and a real `node --test`, plus the
    boundaries, cancel and recovery, duplicate starts, the live-execution gate, the Antigravity handoff and rollback.
  - `tests/m3-acceptance.test.ts` (2): the integrated simulated workflow through the desktop API the window uses.
- **Installed-app acceptance:** `desktop/scripts/acceptance-m3.mjs` (18 checks, run by `npm run desktop:acceptance`)
  drives the window. It needs KELQOR closed (port 3000, one copy at a time), so it runs at install.

## Decisions for the owner

1. **Live agent execution.** Authorize KELQOR to start Claude Code (`LIVE_AGENT_EXECUTION_AUTHORIZED`), for one
   supervised first mission.
2. **Billing for Claude Code.** Claude Code run by KELQOR uses whatever sign-in Claude Code has (your Claude
   subscription today). Decide whether KELQOR-started runs should use an Anthropic API key instead, and whether their
   reported costs count against the $5 day and $20 month caps.
3. **Per-run budget.** Each Claude Code run is capped at $2 by Claude Code's own `--max-budget-usd`. Confirm or change.

## Demonstration (after installing 0.3.0)

1. Engineering Missions › Workspaces › **Set up the demo workspace**.
2. New mission: describe a task, choose the demo workspace and the simulated agent, tick `node --test`, then
   **Save and submit for approval**.
3. Awaiting your review › open it › **Approve** › **Start**. Watch its activity and log.
4. In review, read the changed files, the diff and the check result. Then **Approve change** › **Apply to a new local
   branch**. The demo repository gets the branch `kelqor/eng/e-0001`; its checked-out files don't change.

## The first real Claude Code mission (when you authorize it)

1. Authorize live agent execution for one mission, and decide the billing and per-run budget questions above. The implementation agent
   then sets `LIVE_AGENT_EXECUTION_AUTHORIZED` and ships it; nothing else changes.
2. Register a small, low-stakes repository, or a copy of one, under Workspaces.
3. Use the **Add tests** template, with file changes allowed and one check (for example `npx vitest run`).
4. Approve and start it. Watch its log: each Read, Edit and Write is shown. Claude Code has no shell and no web access.
5. In review: read the diff first, then click **Run checks** (they run the code Claude Code wrote), then approve and
   apply to the new local branch. Compare the agent-reported cost with your Claude usage.
6. Until this succeeds, Claude Code integration stays labeled unverified.

## Known limits

- **Antigravity:** a manual handoff only. KELQOR can't start Antigravity on a task, follow its steps, stop it or know
  its cost; it opens the folder and imports what is there when you say it's done. Inside Antigravity the mission's
  permissions are advice only.
  - **Its command-line tool:** `agy` (`%LOCALAPPDATA%\agy\bin\agy.exe`) is installed and has a headless print mode
    (`-p`, `--output-format stream-json`, `--mode plan|accept-edits|auto`, `--sandbox`).
  - **Why KELQOR doesn't use it:** it has no way to name the only tools allowed, and no setting that keeps file access
    inside the worktree (Claude Code's `--restricted` does both). KELQOR therefore couldn't enforce the mission's
    boundaries, so it isn't used. That was read from its `--help` only, and it has never been run on a task.
  - **What would change that:** a documented permission model from Google, or a supervised trial you authorize, could
    make it an automated adapter.
- **Claude Code:** found through `KELQOR_CLAUDE_CODE_PATH`, PATH, or the copy the Claude desktop app keeps. Its reported
  cost is its own figure. The restricted-mode flags were read from 2.1.309's `--help`, and no run has been made yet.
- **Checks:** npm and npx run offline. A project whose tests need the network will fail its checks.
- **Parallel missions:** each mission gets its own worktree, and missions on one workspace don't share files. Applying
  two missions makes two separate branches; merging them is yours.
- **Restored databases:** after restoring an older database, mission numbers can repeat. Applying then refuses
  rather than overwrite an existing `kelqor/eng/e-NNNN` branch; rename or delete the old branch first.
- **SHA-1 repositories only:** a workspace using SHA-256 object names is refused when its change is approved or
  applied. It fails closed.
- **Worktrees:** they are kept after a mission ends, for inspection, and nothing removes them yet. `git worktree prune`
  in the workspace cleans up after you delete one.

## Install (staged)

KELQOR runs its backend from the project folder, so M3 reaches your database only when that folder moves to `kelqor/m3`.

1. Close KELQOR.
2. In the project folder, run `npm run db:backup -- --label pre-m3`. This permits migration 0006, which only adds three
   tables.
3. Run `git switch kelqor/m3`.
4. Run `desktop\out\installer\KELQOR-Setup-0.3.0.exe`, then `npm run desktop:acceptance`.

**Rollback:** reinstall the 0.2.3 installer kept in `desktop\out\kept-installers`, run `npm run db:rollback-m3 --
--confirm`, then `git switch kelqor/m2b`.
