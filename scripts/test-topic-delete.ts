/**
 * Integration test for the deleted-topic cleanup (orchestrator.onTopicDeleted
 * + purgeConv + pendingTopicDelete). Telegram sends NO event for a topic
 * deleted in the UI (Bot API 10.3 has no forum_topic_deleted) — the bot
 * observes it when a send into the topic fails with "message thread not
 * found". This test drives onTopicDeleted directly (that is what the
 * Telegram.api onThreadNotFound hook calls) and asserts: the worktree is
 * removed (uncommitted work committed to the worker branch first), the session
 * is retired, the state is cleared — while a running worker is deferred and
 * purged when it ends, a worktree shared with another conv is kept, and a
 * failed worktree removal keeps the state for /prune retry.
 *
 * Run:  npx tsx scripts/test-topic-delete.ts
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktree } from "../src/worktree.js";
import { StateManager } from "../src/state.js";
import { Orchestrator } from "../src/orchestrator.js";

const pexec = promisify(execFile);
const git = (cwd: string, args: string[]) => pexec("git", args, { cwd }).then((r) => r.stdout.trim());

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tg-topic-del-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "hi");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);

  const st = new StateManager(join(base, "state.json"));
  const removed: string[] = [];
  const orch = new Orchestrator({
    tg: {},
    oc: { removeSession: async (id: string) => { removed.push(id); } },
    st,
    cfg: {},
    sendHtml: async () => {},
    applyModelAndVariant: async () => {},
    startTyping: () => {},
  } as any);

  try {
    // ── Case 1: a finished worker WITH an unmerged worktree → fully purged ──
    const wt1 = await addWorktree(repo, repo, "done-worker");
    // Give the worktree a unique commit so its branch is unmerged (the case the fix must not lose).
    writeFileSync(join(wt1.root, "work.txt"), "uncommitted work committed");
    await git(wt1.root, ["add", "work.txt"]);
    await git(wt1.root, ["commit", "-q", "-m", "worker work"]);
    const conv1 = "1:100";
    st.set(conv1, {
      sessionID: "ses_a",
      worker: { name: "done-worker", status: "done", spawnedBy: "user", repoRoot: repo, worktree: wt1, createdAt: 0, updatedAt: 0 },
    });
    check("precondition: worktree dir exists", existsSync(wt1.root));
    await orch.onTopicDeleted(conv1);
    check("worktree dir removed", !existsSync(wt1.root));
    check("session retired", removed.includes("ses_a"));
    check("state entry cleared", st.peek(conv1) === undefined);
    const branches = await git(repo, ["branch", "--list", wt1.branch]);
    check("unmerged branch KEPT (work not lost)", branches.includes(wt1.branch), branches);

    // ── Case 2: idempotent — a second delete on a gone conv is a no-op ──
    let threw = false;
    try {
      await orch.onTopicDeleted(conv1);
    } catch {
      threw = true;
    }
    check("second call on a gone conv is a no-op", !threw);

    // ── Case 3: a RUNNING worker → deferred; purged when it ends ──
    const wt2 = await addWorktree(repo, repo, "run-worker");
    const conv2 = "1:101";
    st.set(conv2, {
      sessionID: "ses_b",
      worker: { name: "run-worker", status: "running", spawnedBy: "user", repoRoot: repo, worktree: wt2, createdAt: 0, updatedAt: 0 },
    });
    await orch.onTopicDeleted(conv2);
    check("running worker: worktree KEPT", existsSync(wt2.root));
    check("running worker: state KEPT", st.peek(conv2) !== undefined);
    check("running worker: session NOT retired", !removed.includes("ses_b"));
    // The worker ends → the deferred purge fires.
    orch.onExecution(conv2, "session.execution.succeeded");
    for (let i = 0; i < 50 && st.peek(conv2) !== undefined; i++) await new Promise((r) => setTimeout(r, 50));
    check("running worker after end: state purged", st.peek(conv2) === undefined);
    check("running worker after end: worktree removed", !existsSync(wt2.root));
    check("running worker after end: session retired", removed.includes("ses_b"));

    // ── Case 4: a finished worker WITHOUT a worktree (plain session) ──
    const conv3 = "1:102";
    st.set(conv3, { sessionID: "ses_c", worker: { name: "plain", status: "done", spawnedBy: "user", createdAt: 0, updatedAt: 0 } });
    await orch.onTopicDeleted(conv3);
    check("no-worktree worker: session retired", removed.includes("ses_c"));
    check("no-worktree worker: state cleared", st.peek(conv3) === undefined);

    // ── Case 5: an unknown conv (never tracked) → no-op, no throw ──
    let threw2 = false;
    try {
      await orch.onTopicDeleted("1:999");
    } catch {
      threw2 = true;
    }
    check("unknown conv: no-op, no throw", !threw2);

    // ── Case 6: worktree SHARED with another conv (overflow respawn) → kept ──
    const wt3 = await addWorktree(repo, repo, "shared-worker");
    const conv4 = "1:103"; // the dead original worker
    const conv5 = "1:104"; // the respawn replacement still using the worktree
    for (const [c, name, status] of [
      [conv4, "shared-worker", "failed"],
      [conv5, "shared-worker2", "running"],
    ] as const) {
      st.set(c, {
        sessionID: `ses_${name}`,
        worker: { name, status, spawnedBy: "user", repoRoot: repo, worktree: wt3, createdAt: 0, updatedAt: 0 },
      });
    }
    await orch.onTopicDeleted(conv4); // the user deletes the dead worker's topic
    check("shared worktree: dir KEPT (other conv still uses it)", existsSync(wt3.root));
    check("shared worktree: other conv untouched", st.peek(conv5)?.worker?.worktree?.root === wt3.root);
    check("shared worktree: dead conv state cleared", st.peek(conv4) === undefined);

    // ── Case 7: DIRTY worktree → uncommitted work committed to the branch first ──
    const wt4 = await addWorktree(repo, repo, "dirty-worker");
    writeFileSync(join(wt4.root, "f.txt"), "MODIFIED by worker"); // tracked file changed
    writeFileSync(join(wt4.root, "scratch.txt"), "untracked work"); // new file
    const conv6 = "1:105";
    st.set(conv6, {
      sessionID: "ses_dirty",
      worker: { name: "dirty-worker", status: "done", spawnedBy: "user", repoRoot: repo, worktree: wt4, createdAt: 0, updatedAt: 0 },
    });
    await orch.onTopicDeleted(conv6);
    check("dirty worktree: dir removed", !existsSync(wt4.root));
    const branchKept = (await git(repo, ["branch", "--list", wt4.branch])).includes(wt4.branch);
    check("dirty worktree: branch kept (carries the work)", branchKept);
    const recovered = await git(repo, ["show", `${wt4.branch}:scratch.txt`]).catch(() => "");
    check("dirty worktree: uncommitted file recoverable from branch", recovered === "untracked work");
    const recoveredMod = await git(repo, ["show", `${wt4.branch}:f.txt`]).catch(() => "");
    check("dirty worktree: modified file recoverable from branch", recoveredMod === "MODIFIED by worker");

    // ── Case 8: worktree removal FAILS → state KEPT for /prune retry ──
    const wt5 = await addWorktree(repo, repo, "broken-worker");
    const conv7 = "1:106";
    st.set(conv7, {
      sessionID: "ses_broken",
      worker: { name: "broken-worker", status: "done", spawnedBy: "user", repoRoot: join(base, "no-such-repo"), worktree: wt5, createdAt: 0, updatedAt: 0 },
    });
    await orch.onTopicDeleted(conv7);
    check("failed removal: state KEPT (retryable via /prune)", st.peek(conv7) !== undefined);
    check("failed removal: worktree still there", existsSync(wt5.root));

    // ── Case 9: top-level chat conv is never retired ──
    const convChat = "1"; // no ":" → top level
    st.set(convChat, { sessionID: "ses_mgr", manager: true });
    await orch.onTopicDeleted(convChat);
    check("top-level conv: refused, state kept", st.peek(convChat)?.sessionID === "ses_mgr");

    // tidy up leftover worktrees (the repo is deleted wholesale next)
    for (const wt of [wt3, wt5]) await removeWorktree(repo, wt).catch(() => {});
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
