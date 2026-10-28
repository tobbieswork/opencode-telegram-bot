import type { Bot } from "./bot.js";
import type { ChatState } from "./state.js";
import type { ConvKey } from "./conv.js";
import { esc, trunc } from "./format.js";

/**
 * `/btw` — a quick side question (Claude Code's "by the way"), answered on a
 * throwaway session so it never bloats the manager's context:
 *
 *  - runs in a FRESH one-shot session (same dir/model/agent as this conv),
 *    in parallel with whatever the manager is doing — it does not queue
 *    behind the current turn and does not touch the manager session;
 *  - the reply is posted in this conv, then the session is deleted — the
 *    question/answer leaves no trace in any persisted session history;
 *  - the session is intentionally NOT bound to a conv in state, so a write
 *    permission ask it triggers is auto-rejected by the permission handler
 *    (see onPermissionAsked) instead of hanging; reads work unattended.
 */
const BTW_TIMEOUT_MS = 3 * 60 * 1000;
const BTW_REPLY_MAX = 4000;

export async function cmdBtw(bot: Bot, conv: ConvKey, state: ChatState, arg: string): Promise<void> {
  const q = arg.trim();
  if (!q) {
    await bot.sendHtml(
      conv,
      "Cú pháp: <code>/btw &lt;câu hỏi&gt;</code>\n" +
        "Hỏi nhanh trên một phiên tạm (đồng dir/model với chat này) — trả lời hiện ở đây, " +
        "không lẫn vào ngữ cảnh của manager. Dùng được cả khi manager đang bận."
    );
    return;
  }
  if (bot.btwRunning.has(conv)) {
    await bot.sendHtml(conv, "⏳ Đang có một /btw chạy trong chat này — đợi nó xong rồi hỏi tiếp nhé.");
    return;
  }
  bot.btwRunning.add(conv);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BTW_TIMEOUT_MS);
  let sid: string | null = null;
  try {
    const dir = state.directory || bot.cfg.opencodeDirectory;
    sid = await bot.oc.createSession(dir, { title: "btw" });
    // Match the conv's current model/agent so the answer comes from the same
    // "head" the user is talking to. Failures here are non-fatal (server
    // defaults apply).
    if (state.model) {
      await bot.oc
        .setModel(sid, { id: state.model.id, providerID: state.model.providerID, ...(state.variant ? { variant: state.variant } : {}) })
        .catch(() => {});
    }
    if (state.agent) await bot.oc.setAgent(sid, state.agent).catch(() => {});
    const res = await bot.oc.promptAndWait(sid, q, { signal: ac.signal });
    if (ac.signal.aborted || res.interrupted) {
      await bot.sendHtml(conv, "⏱️ /btw quá 3 phút — đã huỷ phiên tạm. Câu hỏi có lẽ cần một task thật sự (🔥 hoặc /spawn).");
    } else if (res.error) {
      await bot.sendHtml(conv, `❌ /btw lỗi: ${esc(trunc(res.error.message ?? res.error.type ?? "unknown", 300))}`);
    } else if (!res.reply) {
      await bot.sendHtml(conv, "❓ /btw kết thúc mà không có trả lời (có thể phiên tạm bị từ chối quyền chạy tool).");
    } else {
      await bot.sendHtml(conv, `💬 <b>btw</b>\n${esc(trunc(res.reply, BTW_REPLY_MAX))}`);
    }
  } catch (e) {
    // Never drop the turn silently — see the /schedule rule (project memory #105).
    await bot.sendHtml(conv, `❌ /btw lỗi: ${esc(trunc(String((e as Error)?.message ?? e), 300))}`).catch(() => {});
  } finally {
    clearTimeout(timer);
    bot.btwRunning.delete(conv);
    if (sid) {
      // Belt and braces: interrupt in case a hung turn survived the abort,
      // then delete the throwaway session so it leaves no server trace.
      await bot.oc.interrupt(sid).catch(() => {});
      await bot.oc.removeSession(sid).catch(() => {});
    }
  }
}
