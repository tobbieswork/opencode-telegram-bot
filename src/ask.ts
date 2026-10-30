import type { Bot } from "./bot.js";
import { chatOf, parseConv, type ConvKey } from "./conv.js";
import { esc, trunc, timeAgo } from "./format.js";
import { agentLabel, resolveAgent, type AgentId } from "./advisor/agents.js";

/**
 * `/ask` — the user's direct line to the advisor (a second-opinion model —
 * Claude or Gemini — on another machine, reached over Tailscale).
 *
 *  - `/ask <question>`         → open a fresh advisor thread with the default
 *    agent (a new forum topic + a new agent session). The answer is posted in
 *    that topic, and the user keeps asking by typing in the topic (each reply
 *    resumes the session).
 *  - `/ask gemini <question>`  → the same, with a named agent (id or alias).
 *  - `/ask` (no arg)           → list this chat's open advisor threads.
 *
 * This is the user-facing counterpart of the Manager's `consult` tool; both go
 * through the same Advisor (src/advisor/advisor.ts). It does nothing when the
 * advisor is not enabled (no ADVISOR_URL / ADVISOR_TOKEN).
 */
export async function cmdAsk(bot: Bot, conv: ConvKey, arg: string): Promise<void> {
  if (!bot.advisor) {
    await bot.sendHtml(conv, "🧠 Cố vấn chưa bật (thiếu <code>ADVISOR_URL</code> / <code>ADVISOR_TOKEN</code>).").catch(() => {});
    return;
  }
  try {
    const { agent, question: q } = parseAskArg(arg);
    if (!q) {
      const ts = bot.advisor.listThreads(chatOf(conv));
      if (!ts.length) {
        await bot.sendHtml(
          conv,
          "Cú pháp: <code>/ask [claude|gemini] &lt;câu hỏi&gt;</code>\n" +
            `Hỏi một model khác (cố vấn thứ hai, mặc định ${esc(agentLabel(bot.advisor.defaultAgent()))}) — mở một topic riêng, bạn có thể hỏi tiếp trong đó.`,
        );
        return;
      }
      const cap = bot.cfg.advisorMaxTurnsPerSession;
      const lines = ts.map(
        (t) => `• id ${parseConv(t.conv).threadId} · ${esc(agentLabel(t.agent))} · ${esc(t.title)} · ${t.turns}/${cap} lượt · ${timeAgo(t.lastActive)}`,
      );
      await bot.sendHtml(
        conv,
        `🧠 <b>Các thread cố vấn</b>\n${lines.join("\n")}\n\nGõ <code>/ask [claude|gemini] &lt;câu&gt;</code> để mở thread mới, hoặc nhắn trực tiếp trong topic để hỏi tiếp.`,
      );
      return;
    }
    const chat = chatOf(conv);
    const title = q.replace(/\s+/g, " ").slice(0, 60);
    await bot.advisor.startThread({ chat, title, message: q, agent });
    await bot.sendHtml(conv, "🧠 Đã mở thread cố vấn — câu trả lời đã gửi trong topic mới. Nhắn tiếp trong topic đó để hỏi thêm.");
  } catch (e) {
    await bot.sendHtml(conv, `❌ Lỗi: ${esc(trunc(String((e as Error)?.message ?? e), 300))}`).catch(() => {});
  }
}

/**
 * Split `/ask` arguments: a first word naming an agent ("gemini", "claude",
 * "agy") selects it when a question follows; otherwise the whole text is the
 * question for the default agent.
 */
export function parseAskArg(arg: string): { agent?: AgentId; question: string } {
  const text = arg.trim();
  const m = /^(\S+)\s+([\s\S]+)$/.exec(text);
  const agent = m ? resolveAgent(m[1]) : undefined;
  if (m && agent) return { agent, question: m[2].trim() };
  return { question: resolveAgent(text) ? "" : text };
}
