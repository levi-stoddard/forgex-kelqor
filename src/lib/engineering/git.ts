import fs from "node:fs";
import path from "node:path";
import { PROTECTED_PATHS, type EngChangedFile } from "./contract";
import { emptyHooksDir, runProgram } from "./process";

// Git for engineering missions. Every call runs with hooks and fsmonitor switched off and no network protocol, so
// neither a workspace's own configuration nor anything an agent writes can run code when KELQOR reads or commits a
// change. Calls on a mission's worktree name its git directory explicitly, from the workspace's side: an agent can
// rewrite the worktree's .git pointer file, and git would otherwise follow it to a git directory (and config) the
// agent made. KELQOR only ever creates detached worktrees, reads diffs, and commits the exact tree the owner approved
// to a new local branch; it never checks out, resets, merges, fetches or pushes, and never touches the workspace's own
// working tree.

const GIT_TIMEOUT_MS = 120_000;
const DIFF_CAP = 400_000;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function safeConfig(): string[] {
  return ["-c", `core.hooksPath=${emptyHooksDir()}`, "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never"];
}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const r = await runProgram("git", [...safeConfig(), ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (!opts.allowFail && r.exitCode !== 0) throw new GitError(`git ${args.find((a) => !a.startsWith("-")) ?? args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The repository root, when `dir` is a git repository's top folder (not a subfolder, and not itself a worktree). */
export async function repositoryRoot(dir: string): Promise<string | null> {
  if (!fs.existsSync(dir)) return null;
  const r = await runProgram("git", [...safeConfig(), "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) return null;
  const [top, common, gitDir] = r.stdout.trim().split(/\r?\n/);
  if (!top) return null;
  if (norm(top) !== norm(dir)) return null;
  // A linked worktree's git dir differs from the common dir; only a main checkout can be registered.
  if (norm(path.resolve(dir, gitDir)) !== norm(path.resolve(dir, common))) return null;
  return path.resolve(top);
}

export async function commitOf(repo: string, ref: string): Promise<string> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw new GitError("That isn't a valid branch name.");
  return (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/** The worktree's git directory as the repository records it, checked against the worktree's own .git file. */
async function worktreeGitDir(repo: string, worktree: string): Promise<string> {
  const common = path.resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim());
  const gitDir = path.join(common, "worktrees", path.basename(worktree));
  const back = path.join(gitDir, "gitdir");
  if (!fs.existsSync(back) || norm(fs.readFileSync(back, "utf8").trim()) !== norm(path.join(worktree, ".git"))) throw new GitError("The mission's worktree isn't registered with its workspace as KELQOR made it.");
  const pointer = path.join(worktree, ".git");
  const stat = fs.lstatSync(pointer, { throwIfNoEntry: false });
  const text = stat?.isFile() ? fs.readFileSync(pointer, "utf8").trim() : "";
  if (!stat?.isFile() || !text.startsWith("gitdir:") || norm(path.resolve(worktree, text.slice(7).trim())) !== norm(gitDir)) {
    throw new GitError("The worktree's .git file was changed, so KELQOR won't run git there. Nothing was collected or applied.");
  }
  return gitDir;
}

/** Git on a mission's worktree, with its git directory and work tree named explicitly. */
async function wgit(repo: string, worktree: string, args: string[]): Promise<string> {
  const gitDir = await worktreeGitDir(repo, worktree);
  return git(worktree, [`--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...args]);
}

/** A detached worktree of `repo` at `commit`, at `dest`. Reused only if it is that worktree, still at that commit. */
export async function addWorktree(repo: string, commit: string, dest: string): Promise<void> {
  if (fs.existsSync(path.join(dest, ".git"))) {
    const head = (await wgit(repo, dest, ["rev-parse", "HEAD"])).trim();
    if (head !== commit) throw new GitError(`The mission's worktree is at ${head.slice(0, 10)}, not its base ${commit.slice(0, 10)}.`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await git(repo, ["worktree", "add", "--detach", dest, commit]);
}

export interface CollectedChange {
  diff: string;
  diffTruncated: boolean;
  files: EngChangedFile[];
  protectedFiles: string[];
  /** The git tree of the whole change: what is reviewed, tested, approved and applied is exactly this tree. */
  tree: string;
}

/** Every change in the worktree against `base`, staged in the worktree's own index (the workspace's isn't touched). */
export async function collectChange(repo: string, worktree: string, base: string): Promise<CollectedChange> {
  await wgit(repo, worktree, ["add", "-A"]);
  const tree = (await wgit(repo, worktree, ["write-tree"])).trim();
  const raw = await wgit(repo, worktree, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base]);
  const numstat = await wgit(repo, worktree, ["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base]);
  const patch = await wgit(repo, worktree, ["diff", "--cached", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base]);
  const counts = new Map<string, [number, number]>();
  for (const entry of numstat.split("\0").filter(Boolean)) {
    const [a, d, ...rest] = entry.split("\t");
    counts.set(rest.join("\t"), [Number(a) || 0, Number(d) || 0]);
  }
  const files: EngChangedFile[] = [];
  const protectedFiles: string[] = [];
  const parts = raw.split("\0").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i];
    const file = parts[i + 1];
    if (!meta?.startsWith(":") || file === undefined) continue;
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [, newMode, , , code] = meta.slice(1).split(/\s+/);
    const status = code?.startsWith("A") ? "added" : code?.startsWith("D") ? "deleted" : "modified";
    const [additions, deletions] = counts.get(file) ?? [0, 0];
    files.push({ path: file, status, additions, deletions });
    // A symlink or submodule could point outside the worktree; protected paths are never a mission's to change.
    if (newMode === "120000" || newMode === "160000" || PROTECTED_PATHS.some((re) => re.test(file))) protectedFiles.push(file);
  }
  return { diff: patch.slice(0, DIFF_CAP), diffTruncated: patch.length > DIFF_CAP, files, protectedFiles, tree };
}

/**
 * Commits exactly `tree` (the one the owner approved) on top of `base`, and points a new local branch at it. The
 * worktree's current files aren't read again, so nothing written after the approval can slip in. Never pushes.
 */
export async function commitTreeToNewBranch(repo: string, worktree: string, base: string, tree: string, branch: string, message: string): Promise<string> {
  if (!/^kelqor\/eng\/e-\d{4}(-\d+)?$/.test(branch)) throw new GitError("KELQOR only creates its own kelqor/eng/ branches.");
  if (!/^[0-9a-f]{40}$/.test(tree) || !/^[0-9a-f]{40}$/.test(base)) throw new GitError("The approved change isn't a valid git tree.");
  await worktreeGitDir(repo, worktree);
  const exists = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).trim();
  if (exists) throw new GitError(`The branch ${branch} already exists, so nothing was applied.`);
  const commit = (await git(repo, ["-c", "user.name=KELQOR", "-c", "user.email=kelqor@localhost", "commit-tree", tree, "-p", base, "-m", message])).trim();
  // Created only if it doesn't exist yet: the zero old value makes git refuse an existing branch.
  await git(repo, ["update-ref", `refs/heads/${branch}`, commit, "0".repeat(40)]);
  return commit;
}
