import { randomBytes } from "node:crypto";
import type { ConvKey } from "../conv.js";
import { chatOf } from "../conv.js";
import type { CallbackQuery } from "../telegram.js";
import { ICON, esc, timeAgo } from "../format.js";
import { warn } from "../logger.js";
import { selectPruneable } from "../prune.js";
import { removeWorktree } from "../worktree.js";
import type { Orchestrator } from "../orchestrator.js";

/**
 * Fully retire a conversation: remove its git worktree (if any), its OpenCode
 * session, and its state entry. Idempotent — safe when the state is already
 * gone. The worktree is removed before the state is cleared (removal reads the
 * state); uncommitted work is committed to the worker branch first, and an
 * unmerged branch is kept (removeWorktree). A worktree still referenced by
 * ANOTHER conv (e.g. the respawn replacement after an overflow) is NOT removed.
 * Returns false when the worktree could not be removed — the state is then
 * KEPT so /prune can retry, instead of orphaning the worktree and branch.
 * Shared by the /prune confirm and the deleted-topic detection.
 *
 * Concurrency-safe: guarded per-conv (o.purging) so the several concurrent
 * calls a dead topic produces (see the `purging` field) collapse to ONE real
 * purge — the in-flight one does the git work, the others return false
 * immediately instead of racing on index.lock. The guard is cleared once the
 * in-flight purge FINISHES (on both success and failure) so a later
 * send-failure or /prune can still retry a purge that failed.
 */
export async function purgeConv(o: Orchestrator, conv: ConvKey): Promise<boolean> {
  if (o.purging.has(conv)) return false; // an in-flight purge owns this conv
  o.purging.add(conv);
  try {
    const s = o.h.st.peek(conv);
    if (!s) return true; // already gone
    const w = s.worker;
    if (w?.worktree && w.repoRoot) {
      // A replacement worker (overflow respawn) may share this worktree in a new
      // topic — removing it would delete the directory from under the new worker.
      const shared = Object.entries(o.h.st.all()).some(
        ([k, os]) => k !== conv && os?.worker?.worktree?.root === w.worktree!.root,
      );
      if (shared) {
        warn(`purgeConv (${conv}): worktree shared with another conv — keeping it`);
      } else {
        try {
          await (o.h.removeWorktree ?? removeWorktree)(w.repoRoot, w.worktree);
        } catch (e) {
          warn(`removeWorktree (${w.name}) failed — state kept for /prune retry:`, (e as Error)?.message ?? e);
          return false;
        }
      }
    }
    if (s.sessionID) await o.h.oc.removeSession(s.sessionID).catch(() => {});
    o.clearConvMemory(conv);
    o.h.st.clear(conv);
    return true;
  } finally {
    // Always clear the guard: on success the state is gone (a later call sees
    // !s → true); on failure the state is kept and a later send-failure or
    // /prune must be allowed to RETRY (so don't leave the flag behind).
    o.purging.delete(conv);
  }
}

/**
 * `/prune [số_ngày]` — offer to delete finished worker topics that haven't
 * been touched for N days (default 7). The user confirms with a button
 * before anything is deleted; the list card stays valid until tapped.
 */
export async function cmdPrune(o: Orchestrator, conv: ConvKey, arg: string): Promise<void> {
  const chat = chatOf(conv);
  if (conv !== chat) {
    await o.h.sendHtml(conv, "ℹ️ Dùng /prune ở khung chat chính (General), không phải trong topic.");
    return;
  }
  const n = parseInt(arg, 10);
  const days = Number.isInteger(n) && n > 0 ? n : 7;
  const now = Date.now();
  const items = o.workersOf(chat).map(([k, s]) => ({ conv: k, status: s.worker!.status, updatedAt: s.worker!.updatedAt }));
  const convs = selectPruneable(items, now, days * 86_400_000);
  if (!convs.length) {
    await o.h.sendHtml(conv, "Không có topic worker cũ nào để dọn.");
    return;
  }
  const id = randomBytes(5).toString("hex");
  o.prunePending.set(id, { chat, convs });
  const lines = [`🧹 <b>Dọn ${convs.length} topic</b> cũ hơn ${days} ngày:`];
  for (const k of convs) {
    const w = o.h.st.peek(k)?.worker;
    if (!w) continue;
    lines.push(`${ICON[w.status]} <b>${esc(w.name)}</b> · ${w.status} · ${timeAgo(w.updatedAt)}`);
  }
  lines.push("", "<i>Bấm Xoá để xoá topic + state + session (không ảnh hưởng worker đang chạy).</i>");
  await o.h.sendHtml(conv, lines.join("\n"), {
    reply_markup: { inline_keyboard: [[{ text: "🗑 Xoá", callback_data: `prune:${id}` }]] },
  });
}

/**
 * The user confirmed a /prune: delete each listed topic (best-effort, count
 * failures), retire its OpenCode session, its git worktree, and its state
 * entry (purgeConv). A worker that started running again since the list was
 * shown is skipped; a conv whose worktree couldn't be removed is kept for retry.
 */
export async function handlePruneCallback(o: Orchestrator, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const id = (cb.data ?? "").split(":")[1];
  const p = o.prunePending.get(id);
  if (!p || p.chat !== chatOf(conv)) {
    await o.h.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã hết hạn.");
    if (messageId) await o.h.tg.editMessageText(conv, messageId, "⌛ Yêu cầu này đã hết hạn (bot đã khởi động lại hoặc đã xử lý).").catch(() => {});
    return;
  }
  o.prunePending.delete(id);
  let ok = 0;
  let skipped = 0;
  for (const k of p.convs) {
    const s = o.h.st.peek(k);
    const w = s?.worker;
    // It may have started a new turn since the list was shown — never delete a busy worker.
    if (w && (w.status === "running" || w.status === "waiting")) {
      skipped++;
      continue;
    }
    try {
      await o.h.tg.deleteForumTopic(k);
    } catch (e) {
      warn("deleteForumTopic:", (e as Error)?.message);
    }
    if (await purgeConv(o, k)) ok++; // worktree + session + state (keeps state on worktree failure)
    else skipped++;
  }
  await o.h.tg.answerCallbackQuery(cb.id);
  const msg = `🧹 Đã xoá ${ok}/${p.convs.length} topic${skipped ? ` · bỏ qua ${skipped} (đang chạy hoặc chưa xoá được worktree)` : ""}.`;
  if (messageId) await o.h.tg.editMessageText(conv, messageId, msg).catch(() => {});
  else await o.h.sendHtml(conv, msg).catch(() => {});
}
