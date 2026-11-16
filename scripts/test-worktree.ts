/**
 * Checks for removeWorktree (src/worktree.ts) when the worktree DIRECTORY was
 * deleted out-of-band (by hand, disk cleanup, or a half-finished removal):
 * removal must not throw, must clear the worktree registration, and must
 * still clean up the branch (merged -> deleted, unmerged -> kept). Also
 * re-checks the normal (directory present, dirty) path. Uses a real temporary
 * git repo + worktrees; no network, no OpenCode.
 *
 * Regression test for issue #152: a conv whose worktree dir was already gone
 * could never be purged — every /prune, startup sweep and topic-delete retry
 * failed on the `git -C <missing dir> status` call and kept the state forever.
 *
 * Run:  npx tsx scripts/test-worktree.ts
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktree } from "../src/worktree.js";

const pexec = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  pexec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd }).then((r) => r.stdout.trim());

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tg-worktree-"));
  const repo = join(base, "repo");
  try {
    // ── throwaway repo with one commit ─────────────────────────────────────
    mkdirSync(repo);
    await git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);

    // ── Case 1: dir already gone, branch MERGED -> no throw, branch deleted ─
    const wt1 = await addWorktree(repo, repo, "clean");
    check("precondition: worktree dir exists", existsSync(wt1.root));
    rmSync(wt1.root, { recursive: true, force: true }); // deleted out-of-band
    let msg = "";
    let threw = false;
    try {
      msg = await removeWorktree(repo, { root: wt1.root, branch: wt1.branch }, "en");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check("gone dir: removeWorktree does not throw", !threw, msg);
    check("gone dir: merged branch deleted", (await git(repo, ["branch", "--list", wt1.branch])) === "");
    check("gone dir: worktree registration cleared", (await git(repo, ["worktree", "list"])).split("\n").length === 1);
    check("gone dir: message says the directory was already gone", /already gone/i.test(msg), msg);

    // ── Case 2: dir already gone, branch UNMERGED -> no throw, branch kept ──
    const wt2 = await addWorktree(repo, repo, "wip");
    writeFileSync(join(wt2.root, "wip.txt"), "wip\n");
    await git(wt2.root, ["add", "-A"]);
    await git(wt2.root, ["commit", "-q", "-m", "wip commit"]);
    rmSync(wt2.root, { recursive: true, force: true }); // deleted out-of-band
    msg = "";
    threw = false;
    try {
      msg = await removeWorktree(repo, { root: wt2.root, branch: wt2.branch }, "en");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check("gone dir + unmerged: no throw", !threw, msg);
    check("gone dir + unmerged: branch KEPT", (await git(repo, ["branch", "--list", wt2.branch])) === wt2.branch);
    check("gone dir + unmerged: committed work survives on branch", /wip commit/.test(await git(repo, ["log", "-1", "--oneline", wt2.branch])));
    check("gone dir + unmerged: message mentions the kept branch", /kept/i.test(msg), msg);

    // ── Case 3: normal path (dir present, dirty) still preserves work ───────
    const wt3 = await addWorktree(repo, repo, "dirty");
    writeFileSync(join(wt3.root, "untracked.txt"), "untracked work\n");
    writeFileSync(join(wt3.root, "a.txt"), "changed\n");
    msg = await removeWorktree(repo, { root: wt3.root, branch: wt3.branch }, "en");
    check("normal: untracked work preserved on branch", (await git(repo, ["show", `${wt3.branch}:untracked.txt`])) === "untracked work");
    check("normal: modified file preserved on branch", (await git(repo, ["show", `${wt3.branch}:a.txt`])) === "changed");
    check("normal: branch kept (unmerged)", (await git(repo, ["branch", "--list", wt3.branch])) === wt3.branch);
    check("normal: message does not claim the directory was gone", !/already gone/i.test(msg), msg);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall worktree checks passed");
}

main();
