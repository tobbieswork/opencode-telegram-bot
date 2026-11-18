import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import { esc } from "../format.js";
import { helpText, commandGrid, myCommands } from "../commands.js";
import { appendNote, noteEntryText, showNotes, BUSY_REPLY_TEXT, parseNoteCallback } from "../notes.js";
import { warn } from "../logger.js";
import { NOTES_KEY } from "../shared.js";
import { renderRotationReport } from "../rotation-health.js";
import { collectHealth, formatHealth } from "../health.js";
import { buildProbes } from "../health-probes.js";
import { tr, STRINGS, type Str } from "../i18n.js";
import { STYLE_NAMES, resolveStyleArg, type StyleName } from "../style.js";
import type { Lang } from "../state.js";

/** `/help` — grouped command list + tappable button grid. Localized by the caller's lang. */
export async function cmdHelp(bot: Bot, conv: ConvKey, lang?: Lang): Promise<void> {
  await bot.sendHtml(conv, helpText(lang), { reply_markup: commandGrid() });
}

/**
 * `/note [text]` — jot down information while the agent is busy. Without a
 * text, show the pending notes. The note reaches the model through an
 * instruction entry at the start of the next user-initiated turn and retires
 * on the turn after that (see src/notes.ts).
 */
export async function cmdNote(bot: Bot, conv: ConvKey, arg: string): Promise<void> {
  const lang = bot.userPrefs.getLang(bot.st.peek(conv)?.createdBy ?? "");
  const text = arg.trim();
  if (!text) {
    const pending = showNotes(bot.st.get(conv));
    await bot.tg.sendMessage(
      conv,
      pending
        ? tr(lang, "📝 Ghi chú đang chờ:\n", "📝 Pending notes:\n") + esc(pending)
        : tr(lang, "Chưa có ghi chú nào. Dùng: /note (nội dung)", "No notes yet. Use: /note (content)"),
    );
    return;
  }
  const cur = bot.st.get(conv);
  const next = appendNote(cur, text, Date.now());
  bot.st.set(conv, next);
  const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
  if (sid) {
    // Best-effort immediate PUT so the note is in context by the time the next
    // turn starts; prepareNotesTurn re-puts at turn start anyway (self-healing).
    await bot.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!, lang)).catch((e) => warn("note put:", (e as Error).message));
  }
  await bot.tg.sendMessage(conv, tr(lang, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.", "📝 Saved — the agent will see it on the next turn."));
}

/**
 * "📝 Thêm vào note" button on a busy reply: append the user message that was
 * dropped (the agent was busy) to the scratchpad notes, so the agent sees it on
 * the next turn. The text is looked up in the in-memory retention map by the
 * user message's Telegram id (carried in the callback data); if the turn has
 * already ended (or the bot restarted) the entry is gone → "not found".
 */
export async function handleNoteCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const lang = bot.userPrefs.getLang(cb.from?.id ?? "");
  const id = parseNoteCallback(cb.data);
  if (id == null) {
    await bot.tg.answerCallbackQuery(cb.id);
    return;
  }
  // Consume the entry NOW (before any await) so a double-tap can't append twice.
  const text = bot.busyNotes.take(conv, id);
  if (text == null) {
    await bot.tg.answerCallbackQuery(cb.id, tr(lang, "Không tìm thấy nội dung tin nhắn đó.", "That message's content is no longer available."));
    return;
  }
  // Save via the SAME path as cmdNote: append + persist + best-effort PUT.
  const cur = bot.st.get(conv);
  const next = appendNote(cur, text, Date.now());
  bot.st.set(conv, next);
  const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
  if (sid) {
    await bot.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!, lang)).catch((e) => warn("note put:", (e as Error).message));
  }
  await bot.tg.answerCallbackQuery(cb.id, tr(lang, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.", "📝 Saved — the agent will see it on the next turn."));
  // Remove the button: edit the busy message back to plain text (empty keyboard).
  // Best-effort — the message may be too old or deleted; ignore gracefully.
  if (messageId != null) {
    await bot.tg
      .editMessageText(conv, messageId, BUSY_REPLY_TEXT, { reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
  }
}

/**
 * /health — one line per background subsystem (OpenCode, bridge, scheduler,
 * PR-watch, advisor, uptime, DNS heal). Read-only: it only reads the signals
 * the subsystems already keep, plus two cheap liveness pings.
 */
export async function cmdHealth(bot: Bot, conv: ConvKey, uid: number | string | undefined): Promise<void> {
  const lang = bot.userPrefs.getLang(uid ?? "");
  const now = Date.now();
  const lines = await collectHealth(buildProbes(bot.healthSources(), () => now), now);
  await bot.sendHtml(conv, formatHealth(lines, lang, now));
}



/**
 * `/rotation` — a read-only snapshot of the Manager's rotation health: the
 * current context floor, the 7-day floor trend, the recent rotations, and a
 * bounded / watch / unbounded verdict. It only renders data the rotation
 * monitor already recorded — it NEVER triggers a rotation (for that, wait for
 * the confirm prompt, or use /new).
 */
export async function cmdRotation(bot: Bot, conv: ConvKey): Promise<void> {
  const lang = bot.userPrefs.getLang(bot.st.peek(conv)?.createdBy ?? "");
  let snap;
  try {
    snap = bot.rotationHealthSnapshot();
  } catch (e) {
    return bot.tg.sendMessage(conv, tr(lang, `⚠️ Không đọc được snapshot rotation: ${(e as Error).message}`, `⚠️ Can't read the rotation snapshot: ${(e as Error).message}`));
  }
  if (!snap) {
    return bot.tg.sendMessage(conv, tr(lang, "Chưa có dữ liệu rotation — session Manager chưa chạy qua tick xoay nào.", "No rotation data yet — the Manager session has not run a rotation tick."));
  }
  await bot.sendHtml(conv, renderRotationReport(snap, lang));
}

/**
 * `/lang vi|en` — set the user's preferred language. Stored per-user (not per-chat),
 * so the same user gets the same language across all their chats.
 */
export async function cmdLang(bot: Bot, conv: ConvKey, arg: string, uid?: number): Promise<void> {
  const lang = arg.trim().toLowerCase();
  if (lang !== "vi" && lang !== "en") {
    const cur = bot.userPrefs.getLang(uid ?? "");
    await bot.tg.sendMessage(conv, tr(cur, STRINGS.lang_usage.vi, STRINGS.lang_usage.en));
    return;
  }
  if (uid == null) {
    await bot.tg.sendMessage(conv, "⚠️ Cannot identify user.");
    return;
  }
  bot.userPrefs.setLang(uid, lang as Lang);
  const cur = bot.userPrefs.getLang(uid);
  await bot.tg.sendMessage(
    conv,
    lang === "en" ? STRINGS.lang_set_en.en : STRINGS.lang_set_vi.vi,
  );
  // The /autocomplete menu is bot-global: re-register it in the new language
  // so it doesn't stay in the old one until the next bot restart.
  void bot.tg.setMyCommands(myCommands(lang as Lang)).catch((e) => warn("setMyCommands:", (e as Error).message));
}

/** One-line list entries and confirmations for each style (bilingual). */
const STYLE_DESC: Record<StyleName, Str> = {
  default: STRINGS.style_default,
  concise: STRINGS.style_concise,
  explanatory: STRINGS.style_explanatory,
  learning: STRINGS.style_learning,
  proactive: STRINGS.style_proactive,
};
const STYLE_SET: Record<StyleName, Str> = {
  default: STRINGS.style_set_default,
  concise: STRINGS.style_set_concise,
  explanatory: STRINGS.style_set_explanatory,
  learning: STRINGS.style_set_learning,
  proactive: STRINGS.style_set_proactive,
};

/**
 * `/style [1-5|name]` — set the user's output style by number (1-based, in
 * STYLE_NAMES order) or by name. Stored per-user (not per-chat, like /lang) and pinned to the
 * Manager conversation so replies match the style. No argument → show the
 * current style + the full list; an invalid argument → usage + list.
 */
export async function cmdStyle(bot: Bot, conv: ConvKey, arg: string, uid?: number): Promise<void> {
  const cur = bot.userPrefs.getStyle(uid ?? "");
  const lang = bot.userPrefs.getLang(uid ?? "");
  const list = STYLE_NAMES.map((n, i) => {
    const d = tr(lang, STYLE_DESC[n].vi, STYLE_DESC[n].en);
    const marker = n === cur ? ` ${tr(lang, STRINGS.style_current_marker.vi, STRINGS.style_current_marker.en)}` : "";
    return `${i + 1}. ${n} — ${d}${marker}`;
  }).join("\n");
  const a = arg.trim().toLowerCase();
  if (a === "") {
    await bot.sendHtml(
      conv,
      `${tr(lang, STRINGS.style_current.vi, STRINGS.style_current.en)}<b>${esc(cur)}</b>\n${list}\n${tr(lang, STRINGS.style_usage.vi, STRINGS.style_usage.en)}`,
    );
    return;
  }
  const resolved = resolveStyleArg(a);
  if (resolved === null) {
    await bot.sendHtml(
      conv,
      `${tr(lang, STRINGS.style_unknown.vi, STRINGS.style_unknown.en)}${esc(a)}\n${tr(lang, STRINGS.style_usage.vi, STRINGS.style_usage.en)}\n${list}`,
    );
    return;
  }
  if (uid == null) {
    await bot.tg.sendMessage(conv, "⚠️ Cannot identify user.");
    return;
  }
  bot.userPrefs.setStyle(uid, resolved);
  const set = STYLE_SET[resolved];
  await bot.tg.sendMessage(conv, tr(lang, set.vi, set.en));
}
