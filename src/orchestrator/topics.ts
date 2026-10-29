import type { ConvKey } from "../conv.js";
import { log, warn } from "../logger.js";
import { selectFinishedWorkers, WorkerConv } from "../prune.js";
import type { Orchestrator } from "../orchestrator.js";
import { purgeConv } from "./purge.js";

/**
 * The user deleted a forum topic in the Telegram UI. Telegram sends NO event
 * for this (Bot API 10.3 has no forum_topic_deleted update — verified against
 * the docs and live): we observe it when a send into the topic fails with
 * "message thread not found" (Telegram.api → onThreadNotFound). Retire the
 * conversation. A worker still running/waiting is left alone for in-flight
 * work and gets purged when it ends (pendingTopicDelete).
 *
 * ACCEPTED LIMITATION (not a bug): a topic deleted while the conv is IDLE is
 * not detected until the next send into it fails or the user runs /prune.
 * Telegram gives us no idle signal for a deleted topic, so there is nothing
 * to react to until we actually try to send.
 */
export async function onTopicDeleted(o: Orchestrator, conv: ConvKey): Promise<void> {
  if (!String(conv).includes(":")) {
    // Defensive: topic deletion is observed from a topic send, so this can't
    // be a top-level chat — but if it ever is, never retire the main chat.
    warn(`onTopicDeleted: refusing to retire top-level conv ${conv}`);
    return;
  }
  const s = o.h.st.peek(conv);
  if (!s) return; // already gone (repeated send failures are idempotent)
  const w = s.worker;
  if (w && (w.status === "running" || w.status === "waiting")) {
    // Deferred: let the running worker finish — that is the whole point of
    // pendingTopicDelete. Do NOT call onTopicGone here: it stops the in-flight
    // turn (typing/abort/interrupt), which would kill a worker we want to run
    // to completion. Persist a marker so a restart still knows to purge this
    // conv (the in-memory flag is lost on restart); it is cleared when the
    // eventual purge succeeds (purgeConv clears the whole entry).
    o.pendingTopicDelete.add(conv);
    o.h.st.set(conv, { topicDeletedPending: true });
    log(`topic deleted for running worker ${w.name} (${conv}) — purging when the worker ends`);
    return;
  }
  // An advisor thread: tell the Mac to drop the Claude session (best-effort —
  // the Mac's own 24h TTL is the safety net if it's offline when this fires).
  if (s.advisor) await o.h.advisor?.forget(conv).catch(() => {});
  // Purge now: the topic is gone and nothing is running in it. First stop any
  // lingering bot-side turn for a normal/manager topic (a turn can still be
  // live here — typing, inflight, activity — and would keep failing sends),
  // then retire state/session/worktree.
  await o.h.onTopicGone?.(conv);
  log(`topic deleted for ${conv} — retiring (worker=${w?.name ?? "none"}, session=${s.sessionID ?? "none"}, worktree=${w?.worktree?.branch ?? "none"})`);
  const ok = await purgeConv(o, conv);
  // Purge failed (worktree removal error) → keep a persisted marker so a
  // restart can retry. Only if the state still exists (a concurrent purge may
  // have already cleared it — never resurrect a purged conv as a bare marker).
  if (!ok && o.h.st.peek(conv)) o.h.st.set(conv, { topicDeletedPending: true });
}

/**
 * Startup sweep for deferred topic-delete purges that didn't finish before a
 * crash/restart. The in-memory `pendingTopicDelete` flag is lost on restart,
 * but the persisted `topicDeletedPending` marker survives in state.json. For
 * each such conv:
 *  - worker no longer running/waiting (or no worker) → purge it now;
 *  - worker still running/waiting → re-arm the in-memory deferral so the
 *    (post-restart) turn-end triggers the purge via onWorkerFinished.
 * Runs AFTER healWorkers, so a worker that only LOOKS busy (its terminal
 * event was lost) has already been settled to done/failed/stopped and is
 * purged here rather than re-armed.
 */
export async function reapPendingTopicDeletes(o: Orchestrator): Promise<void> {
  for (const [conv, s] of Object.entries(o.h.st.all())) {
    if (!s.topicDeletedPending) continue;
    const w = s.worker;
    if (w && (w.status === "running" || w.status === "waiting")) {
      // Still live after the restart: re-arm so its turn-end purges it.
      o.pendingTopicDelete.add(conv);
      log(`reapPendingTopicDeletes (${conv}): worker ${w.name} still running — re-arming deferred purge`);
      continue;
    }
    const ok = await purgeConv(o, conv);
    if (ok) log(`reapPendingTopicDeletes (${conv}): purged topic-deleted conv after restart`);
    else warn(`reapPendingTopicDeletes (${conv}): purge failed — retry next startup or via /prune`);
  }
}

/**
 * Retroactive auto-close at startup: a worker that finished before auto-close
 * existed (or while the service was down/restarting) never got its topic
 * closed and now sits open forever. Close the topic of every finished worker
 * (done/failed/stopped); closing an already-closed topic is a no-op, so this
 * is safe to re-run on every restart. Best-effort — it never fails startup.
 * Returns the number of topics attempted.
 */
export async function closeFinishedTopicsAtStartup(o: Orchestrator): Promise<number> {
  if (!o.h.cfg.autoClose) return 0;
  try {
    const items: WorkerConv[] = [];
    for (const [conv, s] of Object.entries(o.h.st.all())) {
      if (s.worker) items.push({ conv, status: s.worker.status });
    }
    const targets = selectFinishedWorkers(items);
    for (const conv of targets) await o.h.tg.closeForumTopic(conv).catch(() => {});
    if (targets.length) log(`startup: retroactively closed ${targets.length} finished worker topics`);
    return targets.length;
  } catch (e) {
    warn("startup topic close:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}
