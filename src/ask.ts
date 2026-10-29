import type { Bot } from "./bot.js";
import { chatOf, parseConv, type ConvKey } from "./conv.js";
import { esc, trunc, timeAgo } from "./format.js";

/**
 * `/ask` — the user's direct line to the Claude advisor (a second-opinion model
 * on the Mac, reached over Tailscale).
 *
 *  - `/ask <question>`  → open a fresh advisor thread (a new forum topic + a new
 *    Claude session). Claude's answer is posted in that topic, and the user can
 *    keep asking by typing in the topic (each reply resumes the session).
 *  - `/ask` (no arg)    → list this chat's open advisor threads (id, title, turns).
 *
 * This is the user-facing counterpart of the Manager's `consult` tool; both go
 * through the same Advisor (src/node/advisor.ts). It does nothing when the
 * advisor is not enabled (no MAC_ADVISOR_URL / MAC_ADVISOR_TOKEN).
 */
export async function cmdAsk(bot: Bot, conv: ConvKey, arg: string): Promise<void> {
  if (!bot.advisor) {
    await bot.sendHtml(conv, "🧠 Cố vấn Claude chưa bật (thiếu <code>MAC_ADVISOR_URL</code> / <code>MAC_ADVISOR_TOKEN</code>).");
    return;
  }
  const q = arg.trim();
  if (!q) {
    const ts = bot.advisor.listThreads(chatOf(conv));
    if (!ts.length) {
      await bot.sendHtml(
        conv,
        "Cú pháp: <code>/ask &lt;câu hỏi&gt;</code>\n" +
          "Hỏi Claude (model khác, cố vấn thứ hai) — mở một topic riêng, bạn có thể hỏi tiếp trong đó.",
      );
      return;
    }
    const cap = bot.cfg.advisorMaxTurnsPerSession;
    const lines = ts.map((t) => `• id ${parseConv(t.conv).threadId} · ${esc(t.title)} · ${t.turns}/${cap} lượt · ${timeAgo(t.lastActive)}`);
    await bot.sendHtml(
      conv,
      `🧠 <b>Các thread cố vấn</b>\n${lines.join("\n")}\n\nGõ <code>/ask &lt;câu&gt;</code> để mở thread mới, hoặc nhắn trực tiếp trong topic để hỏi tiếp.`,
    );
    return;
  }
  const chat = chatOf(conv);
  try {
    const title = q.replace(/\s+/g, " ").slice(0, 60);
    await bot.advisor.startThread({ chat, title, message: q });
    await bot.sendHtml(conv, "🧠 Đã mở thread cố vấn — câu trả lời đã gửi trong topic mới. Nhắn tiếp trong topic đó để hỏi thêm.");
  } catch (e) {
    await bot.sendHtml(conv, `❌ Không mở được thread cố vấn: ${esc(trunc(String((e as Error)?.message ?? e), 300))}`).catch(() => {});
  }
}
