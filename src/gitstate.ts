/**
 * A cheap "did the working tree change?" signal for the next-step Review rule.
 *
 * The session report only lists files the agent's edit tools touched; a build
 * agent that creates or rewrites files through the shell leaves it empty, so
 * the report alone cannot say whether a turn changed anything. This module
 * fingerprints the git working tree instead: take one before the turn and one
 * after, and a difference means something changed.
 *
 * Fingerprint = sha1 of HEAD + every path `git status` lists (tracked changes
 * and untracked files, not ignored ones) together with each file's mtime and
 * size. The mtime/size part matters: `git status` prints the same " M file" for
 * a file that was edited twice, so the status text alone would miss the second
 * edit.
 *
 * Read-only (`git rev-parse`, `git status`), arguments passed as a vector
 * (never a shell string), time-boxed, and bounded in size. It returns
 * `undefined` on any problem (not a repository, git missing, timeout, too many
 * changed paths) and the caller falls back to the session report. It runs git
 * in the session's own folder, the same trust boundary src/worktree.ts uses.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface FingerprintOpts {
  /** Per git call. Default 3000 ms. */
  timeoutMs?: number;
  /** More changed paths than this → give up (undefined). Default 2000. */
  maxPaths?: number;
}

/** Run git and return RAW stdout (no trimming: `-z` output is NUL-separated). */
function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) fail(err);
      else ok(stdout);
    });
  });
}

export async function gitFingerprint(dir: string, opts: FingerprintOpts = {}): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxPaths = opts.maxPaths ?? 2000;
  try {
    const root = (await git(dir, ["rev-parse", "--show-toplevel"], timeoutMs)).trim();
    if (!root) return undefined;
    // A repository with no commits has no HEAD: still fingerprintable.
    const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], timeoutMs).catch(() => "NOHEAD")).trim();
    const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeoutMs);
    const entries = status.split("\0").filter(Boolean);
    if (entries.length > maxPaths) return undefined;
    const h = createHash("sha1");
    h.update(head);
    for (const entry of entries) {
      h.update(`\0${entry}`);
      // "XY path" (a rename's second record is just the old path; stat simply fails on it).
      try {
        const s = statSync(join(root, entry.slice(3)));
        h.update(`:${s.mtimeMs}:${s.size}`);
      } catch {
        h.update(":gone");
      }
    }
    return h.digest("hex");
  } catch {
    return undefined;
  }
}
