import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { tr } from "./i18n.js";
import type { Lang } from "./state.js";

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

/** Run git in `cwd` (argument vector, never a shell string). Exported for the spec-run flow, which commits the S4 markers in the spec worktree. */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return git(cwd, args, timeoutMs);
}

/** S4: the branch a spec task runs on. Stable per spec (not per run). */
export function specBranchName(specName: string): string {
  return `spec/${specName}`;
}

/** S4: the worktree directory slug for a spec (stable per spec). */
export function specSlug(specName: string): string {
  return `spec-${specName}`;
}

/**
 * The branch a new spec branch is cut from: `origin/HEAD` (the repo's default,
 * e.g. "main") when a remote is set, else the current branch, else "main".
 */
export async function defaultBranch(repoRoot: string): Promise<string> {
  const remoteHead = await git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (remoteHead) {
    const b = remoteHead.replace(/^origin\//, "");
    if (b) return b;
  }
  const cur = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (cur && cur !== "HEAD") return cur;
  return "main";
}

/**
 * The branch a spec branch was cut from (its fork point), so "since the fork"
 * git queries can be scoped. Prefers the remote's default (origin/HEAD), then
 * common local default names (the spec branch is `spec/*`, so `main`/`master`
 * are safe candidates), then degrades to the current branch.
 */
export async function resolveBaseBranch(dir: string): Promise<string> {
  const remote = await runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (remote) {
    const b = remote.replace(/^origin\//, "");
    if (b) return b;
  }
  for (const cand of ["main", "master"]) {
    const ok = await runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${cand}`])
      .then(() => true)
      .catch(() => false);
    if (ok) return cand;
  }
  return (await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")) || "HEAD";
}

/** A spec task's worktree: stable branch `spec/<name>` from the default branch. */
export interface SpecWorktree {
  directory: string;
  root: string;
  branch: string;
  /** The branch the spec branch was cut from (its merge target). */
  base: string;
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  return git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/**
 * Ensure the spec branch `spec/<name>` and its worktree exist, creating them
 * from the repo's default branch when missing. Idempotent: an existing
 * worktree is reused; an existing branch with a deleted worktree is re-checked
 * out. Returns the worktree (directory mirrors `dir`'s subfolder).
 */
export async function ensureSpecWorktree(repoRoot: string, dir: string, specName: string): Promise<SpecWorktree> {
  const branch = specBranchName(specName);
  const slug = specSlug(specName);
  const root = join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, slug);
  const base = await defaultBranch(repoRoot);
  if (!existsSync(root)) {
    if (await branchExists(repoRoot, branch)) {
      await git(repoRoot, ["worktree", "add", root, branch]);
    } else {
      await git(repoRoot, ["worktree", "add", "-b", branch, root, base]);
    }
  }
  return { directory: join(root, relative(repoRoot, dir)), root, branch, base };
}

/**
 * T1 accept gate (ocr-hardening): the gate runs `npm run …` INSIDE the
 * worktree, but a worktree never inherits node_modules (it is gitignored,
 * not committed). Best-effort link the MAIN checkout's node_modules into
 * the worktree root when it is missing. If the main checkout has none
 * either, do nothing — the gate runs anyway and fails closed (a red
 * refusal with the command's output tail).
 */
export async function linkWorktreeNodeModules(wtRoot: string): Promise<void> {
  const nm = join(wtRoot, "node_modules");
  let replaceBrokenLink = false;
  try {
    const st = lstatSync(nm);
    if (st.isSymbolicLink() && !existsSync(nm)) replaceBrokenLink = true;
    else return;
  } catch {
    /* missing — link it below */
  }
  const commonDir = (await git(wtRoot, ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
  if (!commonDir) return;
  const gitDir = isAbsolute(commonDir) ? commonDir : join(wtRoot, commonDir);
  const mainRoot = basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;
  const src = join(mainRoot, "node_modules");
  if (!existsSync(src)) return;
  try {
    if (replaceBrokenLink) unlinkSync(nm);
    symlinkSync(src, nm);
  } catch {
    /* raced by a concurrent accept — the link existing is what we want */
  }
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


/** A worktree's changes vs its base, split by origin (for chaptered review,
 *  plannotator #4 adapted): tracked = `git diff --name-only base` (modified or
 *  added-then-staged/committed), untracked = never-`git add`ed new files. */
export interface DiffFiles {
  tracked: string[];
  untracked: string[];
}

export async function diffFileList(wt: { root: string; base: string }): Promise<DiffFiles> {
  const tracked = (await git(wt.root, ["diff", "--name-only", wt.base]).catch(() => ""))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const untracked = (await git(wt.root, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  return { tracked, untracked };
}

/** One logical group of a diff's files (a "chapter"). */
export interface DiffChapter {
  title: string;   // top-level path segment, "(root)", or "(other)"
  files: string[]; // file paths in this chapter (tracked-changed + untracked)
}

/** Max chapters in the /wt diff index (keeps the keyboard compact; overflow
 *  merges into "(other)"). */
export const DIFF_CHAPTER_MAX = 8;
/** /wt diff shows the chapter index (not the flat stat) above this many files. */
export const DIFF_CHAPTER_THRESHOLD = 12;

/**
 * Deterministic grouping of a diff's files into chapters by top-level path
 * segment — the pragmatic, zero-LLM approximation of plannotator's semantic
 * "core → consequences → glue last" ordering: biggest areas (most files)
 * first, ties by name, so the highest-signal chapters lead. Pure (no I/O).
 */
export function groupDiffChapters(tracked: string[], untracked: string[], max = DIFF_CHAPTER_MAX): DiffChapter[] {
  const all = Array.from(new Set([...tracked, ...untracked]));
  const byKey = new Map<string, string[]>();
  for (const f of all) {
    const seg = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root)";
    if (!byKey.has(seg)) byKey.set(seg, []);
    byKey.get(seg)!.push(f);
  }
  const chapters = Array.from(byKey.entries()).map(([title, files]) => ({ title, files: [...files].sort() }));
  chapters.sort((a, b) => b.files.length - a.files.length || a.title.localeCompare(b.title));
  if (chapters.length > max) {
    const keep = chapters.slice(0, max - 1);
    const rest = chapters.slice(max - 1);
    keep.push({ title: "(other)", files: rest.flatMap((c) => c.files).sort() });
    return keep;
  }
  return chapters;
}

/**
 * Patch content for one chapter: tracked files via `git diff base --`, untracked
 * (never-added) files listed by name (their full content is usually too large
 * for a Telegram message; the list tells you which new files to open).
 */
export async function chapterPatch(wt: { root: string; base: string }, diffFiles: DiffFiles, chapter: DiffChapter): Promise<string> {
  const trackedIn = chapter.files.filter((f) => diffFiles.tracked.includes(f));
  const untrackedIn = chapter.files.filter((f) => diffFiles.untracked.includes(f));
  const parts: string[] = [];
  if (trackedIn.length) {
    const p = await git(wt.root, ["diff", wt.base, "--", ...trackedIn]).catch((e) => `(diff failed: ${e.message})`);
    if (p) parts.push(p);
  }
  if (untrackedIn.length) parts.push(`(untracked: ${untrackedIn.join(", ")})`);
  return parts.join("\n\n");
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
 * A FRESH "where we are" snapshot of a worker's directory, re-read at
 * respawn time for the overflow handoff: the current branch, the uncommitted
 * work (`git status --short`), the last commit (what was already completed),
 * and the up-to-3 most recently modified tracked files (where to continue).
 * Best-effort — returns "" when the directory is not a git repo (the branch
 * lookup fails); each remaining line degrades independently.
 */
export async function gitBoundary(dir: string): Promise<string> {
  if (!dir) return "";
  const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (!branch) return ""; // not a repo (or a repo with no commits yet)
  const [status, last, recentRaw] = await Promise.all([
    git(dir, ["status", "--short"]).catch(() => ""),
    git(dir, ["log", "-1", "--format=%h %s"]).catch(() => ""),
    git(dir, ["log", "-3", "--name-only", "--format="]).catch(() => ""),
  ]);
  const lines: string[] = [
    `branch: ${branch}`,
    `uncommitted: ${status || "(clean)"}`,
    `last commit: ${last || "(no commits yet)"}`,
  ];
  // Files touched by the last 3 commits, deduped most-recent-first.
  const recent: string[] = [];
  for (const f of recentRaw.split("\n").map((s) => s.trim())) {
    if (!f || recent.includes(f)) continue;
    recent.push(f);
    if (recent.length === 3) break;
  }
  lines.push(`recent files: ${recent.length ? recent.join(", ") : "(none in recent commits)"}`);
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
  lang: Lang = "vi",
): Promise<string> {
  const dirty = await git(repoRoot, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error(
      tr(
        lang,
        "Thư mục repo chính đang có thay đổi chưa commit — hãy commit/stash trước khi merge.",
        "The main repo checkout has uncommitted changes — commit or stash before merging.",
      ),
    );
  }
  const head = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head !== wt.base) {
    throw new Error(tr(lang, `Repo chính đang ở nhánh "${head}", không phải "${wt.base}".`, `The main repo is on branch "${head}", not "${wt.base}".`));
  }

  if (await git(wt.root, ["status", "--porcelain"])) {
    await git(wt.root, ["add", "-A"]);
    await git(wt.root, ["commit", "-m", `tg worker ${label}: uncommitted changes`]);
  }
  const ahead = await git(repoRoot, ["rev-list", "--count", `${wt.base}..${wt.branch}`]);
  if (ahead === "0") return tr(lang, "Không có gì để merge (nhánh worker không có commit mới).", "Nothing to merge (the worker branch has no new commits).");
  try {
    await git(repoRoot, ["merge", "--no-ff", "--no-edit", wt.branch], 120_000);
  } catch (e) {
    await git(repoRoot, ["merge", "--abort"]).catch(() => {});
    throw new Error(tr(lang, `Merge bị conflict — đã huỷ merge, repo giữ nguyên. (${(e as Error).message.split("\n")[0]})`, `Merge conflict — the merge was aborted, the repo is unchanged. (${(e as Error).message.split("\n")[0]})`));
  }
  return tr(lang, `Đã merge ${wt.branch} → ${wt.base} (${ahead} commit).`, `Merged ${wt.branch} → ${wt.base} (${ahead} commit).`);
}

/**
 * Remove a worker's worktree. Uncommitted work is COMMITTED to the worker
 * branch first (the same safeguard mergeWorktree applies), so --force never
 * destroys it; the branch is then deleted only if fully merged (`branch -d`),
 * so the committed work survives either way — at least until the branch is
 * merged, and recoverable from it until then.
 *
 * The preservation commit runs with `--no-verify` and a fixed identity so it
 * can't be blocked by a missing git identity or a failing pre-commit hook —
 * the explicit "Xoá thật" path (wt:rmok) used to reach no commit step at all,
 * so a commit failure here is new and must not silently swallow the worktree.
 * If it does fail, the error propagates to the caller (who reports it to the
 * user). Note: `add -A` also stages UNTRACKED files (as in mergeWorktree) —
 * intended, so nothing in the worktree is lost whatever its git status.
 *
 * If the worktree directory is ALREADY GONE (deleted out-of-band — by hand,
 * disk cleanup, or a half-finished earlier removal), the preservation commit
 * is skipped and the stale registration is pruned instead, so removal still
 * succeeds and the branch cleanup below runs (issue #152: /prune, the startup
 * sweep and topic-delete retries were stuck on such convs forever).
 */
export async function removeWorktree(repoRoot: string, wt: { root: string; branch: string }, lang: Lang = "vi"): Promise<string> {
  let gone = false;
  if (!existsSync(wt.root)) {
    // The directory was deleted out-of-band (by hand, disk cleanup, or a
    // half-finished earlier removal) — there is nothing to commit/preserve.
    // Clear the registration: prune drops the stale entry, and remove is
    // best-effort because it can complain about a directory that is already
    // gone — treat that as success.
    gone = true;
    await git(repoRoot, ["worktree", "prune"]).catch(() => {});
    await git(repoRoot, ["worktree", "remove", "--force", wt.root]).catch(() => {});
  } else {
    if (await git(wt.root, ["status", "--porcelain"])) {
      await git(wt.root, ["add", "-A"]);
      await git(wt.root, [
        "-c", "user.name=Qwen3.8-27B (OpenCode)",
        "-c", "user.email=qwen38-27b-noreply@opencode.local",
        "commit", "--no-verify", "-m", "tg: preserve uncommitted work before worktree removal",
      ]);
    }
    await git(repoRoot, ["worktree", "remove", "--force", wt.root]);
  }
  const kept = await git(repoRoot, ["branch", "-d", wt.branch]).then(
    () => false,
    () => true,
  );
  return kept
    ? gone
      ? tr(lang, `Worktree đã không còn trên đĩa — đã dọn dẹp đăng ký. Nhánh ${wt.branch} chưa merge nên được giữ lại.`, `The worktree directory was already gone — cleaned up its registration. Branch ${wt.branch} is unmerged, so it was kept.`)
      : tr(lang, `Đã xoá worktree. Nhánh ${wt.branch} chưa merge nên được giữ lại.`, `Worktree deleted. Branch ${wt.branch} is unmerged, so it was kept.`)
    : gone
      ? tr(lang, "Worktree đã không còn trên đĩa — đã dọn dẹp đăng ký và nhánh.", "The worktree directory was already gone — cleaned up its registration and branch.")
      : tr(lang, "Đã xoá worktree và nhánh.", "Worktree and branch deleted.");
}
