import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";

/** Run git with an argument vector (never a shell string) and return trimmed stdout. */
function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim()));
      else ok(stdout.trim());
    });
  });
}

/** Top-level directory of the git repo containing `dir`, or undefined if it isn't in one. */
export async function gitRoot(dir: string): Promise<string | undefined> {
  return git(dir, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
}

export interface Worktree {
  /** Directory the worker should run in (mirrors the subfolder it was asked for). */
  directory: string;
  /** Root of the new worktree. */
  root: string;
  branch: string;
  /** Branch (or commit) the worktree was cut from — the merge target. */
  base: string;
}

/**
 * Give a worker its own checkout: `<repo>.worktrees/<name>-<id>` on a new
 * branch `tg/<name>-<id>` cut from the repo's current HEAD, so parallel workers
 * editing the same repo never overwrite each other's files. The random id keeps
 * names unique per repo (worker names are only unique per chat, and kept
 * unmerged branches outlive their worker). `dir` may be a subfolder of the
 * repo; the returned `directory` points at the same subfolder in the worktree.
 */
export async function addWorktree(repoRoot: string, dir: string, name: string): Promise<Worktree> {
  const slug = `${name}-${randomBytes(3).toString("hex")}`;
  const branch = `tg/${slug}`;
  const root = join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, slug);
  if (existsSync(root)) throw new Error(`Worktree path already exists: ${root}`);
  const head = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = head === "HEAD" ? await git(repoRoot, ["rev-parse", "HEAD"]) : head;
  await git(repoRoot, ["worktree", "add", "-b", branch, root, "HEAD"]);
  return { directory: join(root, relative(repoRoot, dir)), root, branch, base };
}

/** Short summary of what a worktree changed relative to its base: diffstat + untracked files. */
export async function diffSummary(wt: { root: string; base: string }): Promise<string> {
  const stat = await git(wt.root, ["diff", "--stat", wt.base]).catch((e) => `(diff failed: ${e.message})`);
  const untracked = await git(wt.root, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
  const lines = [stat || "(no changes to tracked files)"];
  if (untracked) {
    const files = untracked.split("\n");
    lines.push(`untracked: ${files.slice(0, 15).join(", ")}${files.length > 15 ? ` (+${files.length - 15})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * A brief snapshot of a working directory's git state for a worker that does
 * NOT run in its own worktree: the diffstat, the changed/untracked files, and
 * the last commit. Best-effort — returns "" when the directory isn't a git repo
 * (so respawning a non-repo worker degrades gracefully to "no evidence").
 */
export async function gitStatusBrief(dir: string): Promise<string> {
  if (!dir) return "";
  const [stat, porcelain, last] = await Promise.all([
    git(dir, ["diff", "--stat"]).catch(() => ""),
    git(dir, ["status", "--porcelain"]).catch(() => ""),
    git(dir, ["log", "-1", "--oneline"]).catch(() => ""),
  ]);
  if (!stat && !porcelain && !last) return ""; // not a repo (every command failed)
  const lines: string[] = [stat || "(no uncommitted diff)"];
  if (porcelain) {
    const files = porcelain.split("\n");
    lines.push(`changed: ${files.slice(0, 15).join(", ")}${files.length > 15 ? ` (+${files.length - 15})` : ""}`);
  }
  if (last) lines.push(`last: ${last}`);
  return lines.join("\n");
}

/**
 * Merge a worker's branch back into its base in the main checkout. Refuses
 * unless the main checkout is clean and on the base branch; commits whatever
 * the worker left uncommitted first; aborts cleanly on conflict.
 */
export async function mergeWorktree(
  repoRoot: string,
  wt: { root: string; branch: string; base: string },
  label: string,
): Promise<string> {
  const dirty = await git(repoRoot, ["status", "--porcelain"]);
  if (dirty) throw new Error("Thư mục repo chính đang có thay đổi chưa commit — hãy commit/stash trước khi merge.");
  const head = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head !== wt.base) throw new Error(`Repo chính đang ở nhánh "${head}", không phải "${wt.base}".`);

  if (await git(wt.root, ["status", "--porcelain"])) {
    await git(wt.root, ["add", "-A"]);
    await git(wt.root, ["commit", "-m", `tg worker ${label}: uncommitted changes`]);
  }
  const ahead = await git(repoRoot, ["rev-list", "--count", `${wt.base}..${wt.branch}`]);
  if (ahead === "0") return "Không có gì để merge (nhánh worker không có commit mới).";
  try {
    await git(repoRoot, ["merge", "--no-ff", "--no-edit", wt.branch], 120_000);
  } catch (e) {
    await git(repoRoot, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Merge bị conflict — đã huỷ merge, repo giữ nguyên. (${(e as Error).message.split("\n")[0]})`);
  }
  return `Đã merge ${wt.branch} → ${wt.base} (${ahead} commit).`;
}

/**
 * Remove a worker's worktree. Uncommitted work is COMMITTED to the worker
 * branch first (the same safeguard mergeWorktree applies), so --force never
 * destroys it; the branch is then deleted only if fully merged (`branch -d`),
 * so the committed work survives either way — at least until the branch is
 * merged, and recoverable from it until then.
 */
export async function removeWorktree(repoRoot: string, wt: { root: string; branch: string }): Promise<string> {
  if (await git(wt.root, ["status", "--porcelain"])) {
    await git(wt.root, ["add", "-A"]);
    await git(wt.root, ["commit", "-m", `tg: preserve uncommitted work before worktree removal`]);
  }
  await git(repoRoot, ["worktree", "remove", "--force", wt.root]);
  const kept = await git(repoRoot, ["branch", "-d", wt.branch]).then(
    () => false,
    () => true,
  );
  return kept ? `Đã xoá worktree. Nhánh ${wt.branch} chưa merge nên được giữ lại.` : "Đã xoá worktree và nhánh.";
}
