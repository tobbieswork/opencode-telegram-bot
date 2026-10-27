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
import { BusyNoteStore } from "../src/notes.js";
import { Telegram } from "../src/telegram.js";

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
    busyNotes: new BusyNoteStore(),
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

    // ── Case 10: CONCURRENT purges for the same conv collapse to ONE real purge ──
    // A dead topic fires onTopicDeleted from several failing sends at once
    // (typing loop, an edit, a report). Without the purgeConv guard these race on
    // the worktree (index.lock) and can leave state half-cleared. With it, only
    // one purge does the git work; the rest return immediately.
    {
      const wtC = await addWorktree(repo, repo, "conc-worker");
      writeFileSync(join(wtC.root, "c.txt"), "concurrent work"); // dirty → a real commit step
      const convC = "1:200";
      st.set(convC, {
        sessionID: "ses_conc",
        worker: { name: "conc-worker", status: "done", spawnedBy: "user", repoRoot: repo, worktree: wtC, createdAt: 0, updatedAt: 0 },
      });
      let removeCalls = 0;
      const orchConc = new Orchestrator({
        tg: {}, oc: { removeSession: async () => {} }, st, cfg: {}, busyNotes: new BusyNoteStore(), sendHtml: async () => {},
        applyModelAndVariant: async () => {}, startTyping: () => {},
        removeWorktree: async (root: string, wt: any) => { removeCalls++; return removeWorktree(root, wt); }, // count + real work
      } as any);
      const results = await Promise.all([0, 1, 2, 3, 4].map(() => orchConc.onTopicDeleted(convC)));
      check("concurrent: all 5 onTopicDeleted resolve (no crash)", results.length === 5);
      check("concurrent: exactly ONE real purge (removeWorktree called once)", removeCalls === 1, `removeCalls=${removeCalls}`);
      check("concurrent: state clean", st.peek(convC) === undefined);
      check("concurrent: worktree removed", !existsSync(wtC.root));
    }

    // ── Case 11: onTopicGone fires for an idle (non-running) conv, NOT for a running worker ──
    {
      const goneCalls: string[] = [];
      const orchGone = new Orchestrator({
        tg: {}, oc: { removeSession: async () => {} }, st, cfg: {}, busyNotes: new BusyNoteStore(), sendHtml: async () => {},
        applyModelAndVariant: async () => {}, startTyping: () => {},
        onTopicGone: (conv: any) => { goneCalls.push(String(conv)); },
        removeWorktree: async () => "ok", // no real work in this case
      } as any);
      // Idle manager topic → purge now → onTopicGone called
      const convM = "1:201";
      st.set(convM, { sessionID: "ses_m2", manager: true });
      await orchGone.onTopicDeleted(convM);
      check("onTopicGone: called for idle manager topic", goneCalls.includes("1:201"), JSON.stringify(goneCalls));
      check("onTopicGone: manager topic purged", st.peek(convM) === undefined);
      // Running worker → deferred → onTopicGone NOT called
      const wtG = await addWorktree(repo, repo, "gone-worker");
      const convW = "1:202";
      st.set(convW, {
        sessionID: "ses_w2",
        worker: { name: "gone-worker", status: "running", spawnedBy: "user", repoRoot: repo, worktree: wtG, createdAt: 0, updatedAt: 0 },
      });
      await orchGone.onTopicDeleted(convW);
      check("onTopicGone: NOT called for running worker (deferred)", !goneCalls.includes("1:202"), JSON.stringify(goneCalls));
      check("onTopicGone: running worker kept (deferred)", st.peek(convW) !== undefined);
      await removeWorktree(repo, wtG).catch(() => {});
      st.clear(convW);
    }

    // ── Case 12: deferred purge FAILS → in-memory flag + persisted marker KEPT for retry ──
    {
      const wtF = await addWorktree(repo, repo, "fail-worker");
      const convF = "1:203";
      st.set(convF, {
        sessionID: "ses_f",
        worker: { name: "fail-worker", status: "running", spawnedBy: "user", repoRoot: join(base, "no-such-repo"), worktree: wtF, createdAt: 0, updatedAt: 0 },
      });
      await orch.onTopicDeleted(convF); // deferred (running) → marker persisted
      check("deferred: marker persisted in state", st.peek(convF)?.topicDeletedPending === true);
      orch.onExecution(convF, "session.execution.succeeded"); // worker ends → purge attempted, FAILS (bad repoRoot)
      await new Promise((r) => setTimeout(r, 300)); // let the (failed) deferred purge settle
      check("deferred failed purge: state KEPT (retryable)", st.peek(convF) !== undefined);
      check("deferred failed purge: marker STILL present", st.peek(convF)?.topicDeletedPending === true);
      check("deferred failed purge: worktree still there", existsSync(wtF.root));
      await removeWorktree(repo, wtF).catch(() => {});
      st.clear(convF);
    }

    // ── Case 13: a STOPPED worker (via /stop → interrupted) with a pending delete → purged ──
    // The pendingTopicDelete flush happens BEFORE the "stopped" early-return in
    // onWorkerFinished, so a stopped worker's deleted topic is still purged.
    {
      const wtS = await addWorktree(repo, repo, "stop-worker");
      const convS = "1:204";
      st.set(convS, {
        sessionID: "ses_s",
        worker: { name: "stop-worker", status: "running", spawnedBy: "user", repoRoot: repo, worktree: wtS, createdAt: 0, updatedAt: 0 },
      });
      await orch.onTopicDeleted(convS); // deferred (running)
      orch.onExecution(convS, "session.execution.interrupted"); // user /stop → "stopped" → onWorkerFinished
      for (let i = 0; i < 50 && st.peek(convS) !== undefined; i++) await new Promise((r) => setTimeout(r, 50));
      check("stopped worker: purged (state cleared)", st.peek(convS) === undefined);
      check("stopped worker: worktree removed", !existsSync(wtS.root));
    }

    // ── Case 14: onThreadNotFound only fires for topic-targeting methods (whitelist) ──
    // A "message thread not found" from a NON-topic method must not purge a
    // conversation (a false positive destroys session + worktree, irreversibly).
    {
      const realFetch = globalThis.fetch;
      const threadNotFoundCalls: [number, number][] = [];
      const tg = new Telegram("token", undefined);
      tg.onThreadNotFound = (chatId, threadId) => threadNotFoundCalls.push([chatId, threadId]);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })) as any;
      const call = (method: string, body: any) => (tg as any).api(method, body).catch(() => {});
      await call("sendMessage", { chat_id: 10, message_thread_id: 5 }); // in whitelist
      check("whitelist: topic-targeting method (sendMessage) FIRES", threadNotFoundCalls.length === 1, `calls=${threadNotFoundCalls.length}`);
      await call("getChat", { chat_id: 10, message_thread_id: 5 }); // out of whitelist, but still carries message_thread_id
      check("whitelist: non-topic method (getChat) does NOT fire", threadNotFoundCalls.length === 1, `calls=${threadNotFoundCalls.length}`);
      await call("deleteMessage", { chat_id: 10, message_thread_id: 6 }); // in whitelist
      check("whitelist: deleteMessage FIRES again", threadNotFoundCalls.length === 2, `calls=${threadNotFoundCalls.length}`);
      globalThis.fetch = realFetch;
    }

    // ── Case 15: startup reap re-purges a persisted marker whose worker is no longer running ──
    // (item 3a: the marker survives a restart; the in-memory flag does not.)
    {
      const wtR = await addWorktree(repo, repo, "reap-worker");
      const convR = "1:205";
      // Marker set + worker settled to a non-busy status (as healWorkers would do after a restart).
      st.set(convR, {
        sessionID: "ses_r",
        worker: { name: "reap-worker", status: "done", spawnedBy: "user", repoRoot: repo, worktree: wtR, createdAt: 0, updatedAt: 0 },
        topicDeletedPending: true,
      });
      // Marker set + worker still running → must be RE-ARMED, not purged (let it finish).
      const wtR2 = await addWorktree(repo, repo, "reap-running");
      const convR2 = "1:206";
      st.set(convR2, {
        sessionID: "ses_r2",
        worker: { name: "reap-running", status: "running", spawnedBy: "user", repoRoot: repo, worktree: wtR2, createdAt: 0, updatedAt: 0 },
        topicDeletedPending: true,
      });
      await orch.reapPendingTopicDeletes();
      check("reap: not-running marker conv purged", st.peek(convR) === undefined);
      check("reap: not-running worktree removed", !existsSync(wtR.root));
      check("reap: running marker conv KEPT (re-armed, not purged)", st.peek(convR2) !== undefined);
      check("reap: running worktree kept", existsSync(wtR2.root));
      // The re-armed running conv is purged when it actually ends.
      orch.onExecution(convR2, "session.execution.succeeded");
      for (let i = 0; i < 50 && st.peek(convR2) !== undefined; i++) await new Promise((r) => setTimeout(r, 50));
      check("reap: re-armed running conv purged when it ends", st.peek(convR2) === undefined);
      await removeWorktree(repo, wtR2).catch(() => {});
    }

    // ── Case 16: /prune of an ALREADY-deleted topic — the deleteForumTopic failure
    // fires onTopicDeleted (→ purgeConv #1, fire-and-forget, exactly like the
    // production hook in bot.ts) while the /prune loop ALSO calls purgeConv directly
    // (#2). Both must collapse to ONE real purge (the purging guard), not race on
    // the worktree's index.lock.
    {
      const wtP = await addWorktree(repo, repo, "prune-worker");
      writeFileSync(join(wtP.root, "p.txt"), "prune work"); // dirty → a real commit step
      const convP = "1:207";
      st.set(convP, {
        sessionID: "ses_p",
        worker: { name: "prune-worker", status: "done", spawnedBy: "user", repoRoot: repo, worktree: wtP, createdAt: 0, updatedAt: 0 },
      });
      let removeCalls = 0;
      const orchP = new Orchestrator({
        tg: {}, oc: { removeSession: async () => {} }, st, cfg: {}, busyNotes: new BusyNoteStore(), sendHtml: async () => {},
        applyModelAndVariant: async () => {}, startTyping: () => {},
        removeWorktree: async (root: string, wt: any) => { removeCalls++; return removeWorktree(root, wt); },
      } as any);
      // A real Telegram client wired exactly like production (bot.ts): a thread-not-found
      // from a topic-targeting method → onTopicDeleted, fire-and-forget. Stub fetch so
      // deleteForumTopic fails with "message thread not found" (topic already deleted).
      const tg = new Telegram("token");
      tg.onThreadNotFound = (c, t) => { void orchP.onTopicDeleted(`${c}:${t}`).catch(() => {}); };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })) as any;
      try {
        await tg.deleteForumTopic(convP).catch(() => {}); // fails → hook → onTopicDeleted → purgeConv #1
        await (orchP as any).purgeConv(convP); // the /prune loop's direct purgeConv #2
        for (let i = 0; i < 50 && removeCalls < 1; i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 200)); // let the fire-and-forget #1 observe the guard too
      } finally {
        globalThis.fetch = realFetch;
      }
      check("prune deleted-topic: exactly ONE real purge (no index.lock race)", removeCalls === 1, `removeCalls=${removeCalls}`);
      check("prune deleted-topic: state clean", st.peek(convP) === undefined);
      check("prune deleted-topic: worktree removed", !existsSync(wtP.root));
    }

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
