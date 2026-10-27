import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ChatState } from "../state.js";
import type { ConvKey } from "../conv.js";
import { esc, trunc } from "../format.js";
import { warn, error } from "../logger.js";
import { AGENT_WHITELIST } from "../shared.js";
import type { Btn } from "../shared.js";

export async function cmdAgents(bot: Bot, conv: ConvKey): Promise<void> {
  const agents = await bot.oc.listAgents();
  const cur = bot.st.get(conv).agent;
  const lines = agents
    .filter((a) => AGENT_WHITELIST.includes(a.id))
    .map((a) => `${cur === a.id ? "▶️ " : ""}<code>${a.id}</code>${a.description ? ` — ${esc(trunc(a.description, 44))}` : ""}`);
  await bot.sendHtml(conv, `<b>Agents</b>\n${lines.join("\n")}\n\nSet with /agent &lt;id&gt;`);
}

/**
 * `/agent [id]` — set the agent. Without a valid argument the user gets a
 * button picker of the whitelisted agents instead of the text list.
 */
export async function cmdAgent(bot: Bot, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  void state;
  let agents: { id: string }[] | undefined;
  try {
    agents = await bot.oc.listAgents();
  } catch (e) {
    warn("listAgents:", (e as Error).message);
  }
  if (!arg) return sendAgentPicker(bot, conv, undefined);
  // Unknown id (and the listing succeeded) → show the picker too; a failed
  // listing keeps the old behaviour of trusting the typed id.
  if (agents && !agents.some((a) => a.id === arg)) return sendAgentPicker(bot, conv, `❌ Unknown agent: <code>${esc(arg)}</code>`);
  const how = await applyAgent(bot, conv, arg);
  await bot.tg.sendMessage(conv, `✅ Agent → <code>${esc(arg)}</code> (${how === "applied" ? "applied to current session" : "applies on /new"})`);
}

/** Apply the agent switch (shared by the typed command and the picker buttons). */
async function applyAgent(bot: Bot, conv: ConvKey, agent: string): Promise<"applied" | "applies on /new"> {
  bot.st.set(conv, { agent });
  const sid = bot.st.get(conv).sessionID;
  if (sid) {
    await bot.oc.setAgent(sid, agent).catch((e) => error("setAgent:", e?.message));
    return "applied";
  }
  return "applies on /new";
}

/** The /agent picker card: one button per whitelisted agent + a hint line. */
function sendAgentPicker(bot: Bot, conv: ConvKey, errorNote?: string): Promise<void> {
  const cur = bot.st.get(conv).agent;
  const rows: Btn[][] = [];
  for (let i = 0; i < AGENT_WHITELIST.length; i += 2) {
    rows.push(
      AGENT_WHITELIST.slice(i, i + 2).map((id) => ({ text: `${cur === id ? "▶️ " : ""}${id}`, callback_data: `agent:${id}` })),
    );
  }
  rows.push([{ text: "❌ Đóng", callback_data: "agent:close" }]);
  return bot.tg.sendMessage(
    conv,
    [errorNote ?? "❓ <b>/agent</b> cần tên agent", "Hoặc gửi: <code>/agent &lt;id&gt;</code>"].join("\n"),
    { reply_markup: { inline_keyboard: rows } },
  );
}

/** Handle a tap on the /agent picker (data = `agent:<id|close>`). */
export async function handleAgentCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const id = (cb.data ?? "").slice("agent:".length);
  if (id === "close") {
    await bot.tg.answerCallbackQuery(cb.id);
    if (messageId) await bot.tg.deleteMessage(conv, messageId).catch(() => {});
    return;
  }
  try {
    const how = await applyAgent(bot, conv, id);
    await bot.tg.answerCallbackQuery(cb.id, `Agent → ${id}`);
    if (messageId) await bot.tg.editMessageText(conv, messageId, `✅ Agent → <code>${esc(id)}</code> (${how})`).catch(() => {});
  } catch (e) {
    await bot.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
  }
}
