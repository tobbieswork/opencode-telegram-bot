/**
 * git helpers for the Mac node daemon (argument vectors, never shell strings).
 */
import { execFile } from "node:child_process";

export function git(dir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", dir, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      // Never wait on an interactive credential/passphrase prompt — fail fast
      // instead of hanging the daemon (launchd has no TTY).
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim()));
      else ok(stdout.trim());
    });
  });
}

/**
 * SSH remote URLs hang in a launchd context (no ssh-agent, passphrase
 * prompts with no TTY) — convert to HTTPS. When a token is provided,
 * embed it so headless auth works without a keychain/agent.
 */
export function resolveCloneUrl(raw: string, token: string): string {
  let url = raw;
  if (raw.startsWith("git@github.com:")) url = "https://github.com/" + raw.slice("git@github.com:".length);
  else if (raw.startsWith("ssh://git@github.com/")) url = "https://github.com/" + raw.slice("ssh://git@github.com/".length);
  if (token && url.startsWith("https://")) url = url.replace("https://", `https://x-access-token:${token}@`);
  return url;
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
