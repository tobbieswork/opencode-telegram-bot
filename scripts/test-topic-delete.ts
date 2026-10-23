/**
 * Integration test for the topic-deletion cleanup (orchestrator.onTopicDeleted
 * + purgeConv). Builds a throwaway git repo, gives a worker a real worktree,
 * then simulates a forum_topic_deleted and asserts the worktree is removed, the
 * session is retired, and the state entry is cleared — while a running worker
 * is left untouched. No live bot/service needed.
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

    // ── Case 3: a RUNNING worker → left completely untouched ──
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

    // tidy up the running worker's worktree (the repo is deleted wholesale next)
    await removeWorktree(repo, wt2).catch(() => {});
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
