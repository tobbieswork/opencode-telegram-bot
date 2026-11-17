/**
 * Minimal GitHub REST helper for the spec-to-tasks PR flow (S5).
 *
 * Shells `gh api -X <METHOD> repos/<owner>/<repo>/<path> [--input <json>]` in
 * ARGUMENT-ARRAY form (never a shell string) with a 20s timeout — the same
 * auth path the rest of the bot already uses (the `gh` binary + the token in
 * ~/.config/gh/hosts.yml). Unlike the PR watcher's private `ghApi` (bound to
 * the single watched repo), this one takes repo + method + path + body as
 * parameters, so it can address ANY repo — the slug is derived per spec from
 * the spec's own git root (see githubRepoSlug).
 *
 * The transport is injectable (setGhApiImpl) so tests can stub the calls.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./worktree.js";

export type GhApiFn = (repo: string, method: string, path: string, body?: unknown) => Promise<any>;

async function ghApiDefault(repo: string, method: string, path: string, body?: unknown): Promise<any> {
  const args = ["api", "-X", method, `repos/${repo}/${path}`];
  let dir: string | undefined;
  try {
    if (body !== undefined) {
      // `gh api --input` takes a FILE PATH, not the raw body: passing the JSON
      // literal makes gh open a file literally named `{"title":…}` and fail
      // with "no such file or directory" (live bug, S7 PR flow). Write the
      // body to a temp file instead and clean it up afterwards.
      dir = await mkdtemp(join(tmpdir(), "gh-api-"));
      const file = join(dir, "body.json");
      await writeFile(file, JSON.stringify(body));
      args.push("--input", file);
    }
    return await new Promise((resolve, reject) => {
      execFile(process.env.OPENCODE_TG_GH_BIN || "gh", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`gh api ${method} ${path}: ${stderr?.trim() || err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e as Error);
        }
      });
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

let impl: GhApiFn = ghApiDefault;

/** Test seam: replace the gh transport (pass undefined to restore the real one). */
export function setGhApiImpl(fn: GhApiFn | undefined): void {
  impl = fn ?? ghApiDefault;
}

/** One gh REST call against `repos/<repo>/<path>`; resolves the parsed JSON body. */
export async function ghApi<T = any>(repo: string, method: string, path: string, body?: unknown): Promise<T> {
  return (await impl(repo, method, path, body)) as T;
}

/**
 * The `owner/name` GitHub repo slug of the git root's `origin` remote, or
 * undefined when there is no origin (or it is not a GitHub URL). Handles both
 * `https://github.com/…` and `git@github.com:…` forms, with or without a
 * trailing `.git`.
 */
export async function githubRepoSlug(gitRootDir: string): Promise<string | undefined> {
  // Use the raw stored URL (`remote.origin.url`), NOT `remote get-url`, which
  // applies `url.*.insteadOf` rewrites (and would return a rewritten local path
  // in the test fixtures that rewrite a github.com URL to a local bare repo).
  const url = (await runGit(gitRootDir, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
  return parseRepoUrl(url);
}

/** Pure: parse a GitHub remote URL into `owner/name` (exported for tests). */
export function parseRepoUrl(url: string): string | undefined {
  const u = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = u.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return undefined;
}
