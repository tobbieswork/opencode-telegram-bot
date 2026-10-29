/**
 * git helpers for the Mac node daemon (argument vectors, never shell strings).
 */
import { execFile } from "node:child_process";

export function git(dir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", dir, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim()));
      else ok(stdout.trim());
    });
  });
}

/**
 * Push a branch to origin with a rebase-retry: the hub (bot) pushes to the
 * node/mac branch in parallel, so a rejected push means "rebase and try
 * again" (bounded — a real conflict surfaces as an error).
 */
export async function pushBranch(dir: string, branch: string, maxRetries = 3): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      return;
    } catch (e) {
      if (i >= maxRetries) throw e;
      await git(dir, ["fetch", "-q", "origin", branch]);
      await git(dir, ["rebase", "-q", "FETCH_HEAD"]);
    }
  }
}
