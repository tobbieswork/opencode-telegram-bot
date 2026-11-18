/**
 * `cont:` / `q:add:` / `q:steer:` callbacks + turn-start note prep
 * (docs/sdd/split-bot-ts.md, T3 — the "notes" feature module).
 *
 * Moved out of bot.ts verbatim (a move, not a rewrite). The feature talks to
 * the bot only through the narrow `BotCtx` interface; `Bot` satisfies it
 * structurally, so behaviour is unchanged. The stores it touches (busyNotes,
 * queue) are owned by Bot and shared with the Orchestrator; `runPromptTask`
 * still lives on Bot until the prompt-runner moves (T6).
 */
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { Lang } from "../state.js";
import { tr } from "../i18n.js";
import { warn, error } from "../logger.js";
import { audit } from "../audit.js";
import { parseBusyCallback } from "../busy.js";
import { continuePrompt, parseContinueData } from "../continue.js";
import { prepareNotes } from "../notes.js";
import { NOTES_KEY } from "../shared.js";

  /**
   * The busy reply's "📥 Xếp hàng" / "🔀 Định tuyến ngay" buttons (docs/sdd/
   * queue-and-steer.md, phase 2). Both fetch the dropped message's text from the
   * busy-note store (retained while the turn runs) and CONSUME it before any
   * await, so a double-tap can't act twice.
   *   q:add   → enqueue (cap 3; a full queue says so and keeps the note button).
   *   q:steer → immediate oc.prompt(sid, text, { delivery: "steer" }): the server
   *             delivers it at the running turn's next safe point (S-native).
   *             A failure (server error / the session already gone) falls back
   *             to the queue (Q2.3: never drop). For a Manager chat sid is the
   *             Manager's OWN session — workers are separate sessions, so a
   *             Manager steer touches only the Manager's turn (Q2.5).
   */
export async function handleBusyCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
    const parsed = parseBusyCallback(cb.data);
    if (parsed === null) {
      await ctx.tg.answerCallbackQuery(cb.id);
      return;
    }
    // Consume the entry NOW (before any await) so a double-tap can't queue/steer twice.
    const text = ctx.busyNotes.take(conv, parsed.messageId);
    if (text == null) {
      await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "Không tìm thấy nội dung tin nhắn đó.", "That message's content is no longer available."));
      return;
    }
    const senderId = cb.from?.id != null ? String(cb.from.id) : undefined;
    // Replace the tapped button's row with the outcome (best-effort).
    const settleEdit = (finalText: string): void => {
      if (messageId != null) void ctx.tg.editMessageText(conv, messageId, finalText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    };
    if (parsed.kind === "add") {
      const r = ctx.queue.push(conv, { text, senderId });
      if (!r.ok) {
        await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "Hàng chờ đầy (3 tin).", "Queue is full (3 messages)."));
        settleEdit(tr(lang, "⚠️ Hàng chờ đầy (3 tin) — bấm note để giữ.", "⚠️ Queue is full (3 messages) — use the note button to keep it."));
        return;
      }
      const pos = r.position;
      audit({ action: "queue_add", chatId: conv, userId: senderId, meta: { messageId: parsed.messageId, textLen: text.length, queuedCount: pos, senderId } });
      await ctx.tg.answerCallbackQuery(cb.id, tr(lang, `✅ Đã thêm vào hàng chờ (vị trí #${pos}).`, `✅ Added to the queue (position #${pos}).`));
      settleEdit(tr(lang, `✅ Đã thêm vào hàng chờ (vị trí #${pos}). Sẽ chạy sau khi tin hiện tại xong.`, `✅ Added to the queue (position #${pos}). Will run after the current message finishes.`));
      return;
    }
    // Steer (S-native): deliver to the running turn's session right away.
    const steerFallback = async (reason: string): Promise<void> => {
      warn("steer fallback:", reason, conv);
      audit({ action: "queue_steer", chatId: conv, userId: senderId, meta: { messageId: parsed.messageId, ok: false, degraded: true, reason } });
      const r = ctx.queue.push(conv, { text, senderId });
      if (r.ok) audit({ action: "queue_add", chatId: conv, userId: senderId, meta: { messageId: parsed.messageId, textLen: text.length, queuedCount: r.position, via: "steer_fallback" } });
      const msg = r.ok
        ? tr(lang, `Không steer được — đã cho vào hàng chờ (vị trí #${r.position}).`, `Couldn't steer — added to the queue (position #${r.position}).`)
        : tr(lang, "Không steer được và hàng chờ đã đầy (3 tin).", "Couldn't steer and the queue is full (3 messages).");
      await ctx.tg.answerCallbackQuery(cb.id, msg);
      settleEdit(msg);
    };
    const sid = ctx.st.peek(conv)?.sessionID;
    if (sid === undefined) {
      // Race: the turn already ended and the session id is gone — queue instead.
      await steerFallback("no active session");
      return;
    }
    try {
      await ctx.oc.prompt(sid, text, { delivery: "steer" });
      audit({ action: "queue_steer", chatId: conv, userId: senderId, meta: { messageId: parsed.messageId, ok: true, degraded: false } });
    } catch (e) {
      await steerFallback((e as Error)?.message ?? "prompt failed");
      return;
    }
    const msg = tr(lang, "🔀 Đang định tuyến — áp dụng tại điểm an toàn tiếp theo.", "🔀 Steering — applies at the next safe point.");
    await ctx.tg.answerCallbackQuery(cb.id, msg);
    settleEdit(msg);
  }

  /**
   * Start of a user-initiated turn: retire notes already shown last turn, or make
   * pending notes visible in this turn's system context. Never throws — a notes
   * failure must not break the turn.
   */
export async function prepareNotesTurn(ctx: BotCtx, conv: ConvKey, sid: string, lang: Lang = "vi"): Promise<void> {
    try {
      const prep = prepareNotes(ctx.st.get(conv), lang);
      if (prep.put || prep.remove) ctx.st.set(conv, prep.state);
      if (prep.put) await ctx.oc.setInstruction(sid, NOTES_KEY, prep.put);
      else if (prep.remove) await ctx.oc.removeInstruction(sid, NOTES_KEY);
    } catch (e) {
      warn("notes turn prep:", (e as Error).message);
    }
  }

  /** Handle a tap on the "⏯ Chạy tiếp" button (data = `cont:<sessionID>`). */
export async function handleContinueCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const target = parseContinueData(cb.data);
    // The button is one-shot: drop it immediately so a re-tap (or a stale button
    // left over after a /new) can never fire a second continue.
    if (messageId) {
      await ctx.tg
        .editMessageReplyMarkup(conv, messageId, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
    const state = ctx.st.peek(conv);
    // Reject malformed data, or a conv whose session is no longer the one that
    // failed (a /new or /use replaced it) — continuing would hit the wrong session.
    if (!target || !state?.sessionID || state.sessionID !== target) {
      await ctx.tg.answerCallbackQuery(cb.id, tr(ctx.userPrefs.getLang(cb.from?.id ?? ""), "Nút này không còn áp dụng cho phiên hiện tại.", "This button no longer applies to the current session."));
      return;
    }
    if (ctx.inflight.has(conv)) {
      await ctx.tg.answerCallbackQuery(cb.id, tr(ctx.userPrefs.getLang(cb.from?.id ?? ""), "Đang chạy task — hẵng thử lại sau.", "A task is running — try again in a moment."));
      return;
    }
    await ctx.tg.answerCallbackQuery(cb.id, tr(ctx.userPrefs.getLang(cb.from?.id ?? ""), "⏯ Đang chạy tiếp…", "⏯ Continuing…"));
    ctx.startTyping(conv);
    const ac = new AbortController();
    ctx.inflight.set(conv, ac);
    void ctx.runPromptTask(conv, target, continuePrompt(ctx.userPrefs.getLang(cb.from?.id ?? "")), ac).catch((e) => error("prompt task:", e?.message));
  }
