/**
 * Session feature: the /new confirm card + the nw: flow (clear / keep /
 * cancel), the fresh-session mechanics (doNewSession + the handoff summary),
 * /ls, /use (command + picker callback + the shared switch primitive),
 * /stop, /clear and /history. Moved out of bot.ts
 * (docs/sdd/split-bot-ts.md, T5). The feature talks to the bot only through
 * the narrow `BotCtx` interface; `Bot` satisfies it structurally so behaviour
 * is unchanged.
 */
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { ChatState, Lang } from "../state.js";
import type { SessionBrief } from "../opencode.js";
import { esc, trunc, stripTags } from "../format.js";
import { tr } from "../i18n.js";
import { warn } from "../logger.js";
import { audit } from "../audit.js";
import { dropNotes } from "../notes.js";
import { CARRYOVER_KEY, type Btn, type Keyboard } from "../shared.js";

/** `/new` — the bare confirm card (destructive, so it always asks first). */
export async function cmdNew(ctx: BotCtx, conv: ConvKey): Promise<void> {
  // Destructive — a fast mistyped /new just shows this card instead of nuking
  // the session. Three choices: clear (drop context), clear + keep the recent
  // context, or cancel. (The old /new --keep flag was removed; "keep" is now
  // a button.)
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const kb: Keyboard = {
    inline_keyboard: [
      [{ text: "🗑️ Clear", callback_data: "nw:clear" }],
      [{ text: tr(lang, "💾 Clear + giữ ngữ cảnh", "💾 Clear + keep context"), callback_data: "nw:keep" }],
      [{ text: tr(lang, "↩️ Huỷ", "↩️ Cancel"), callback_data: "nw:cancel" }],
    ],
  };
  await ctx.tg.sendMessage(
    conv,
    tr(lang, "⚠️ <b>/new</b> — chọn cách tạo phiên mới:", "⚠️ <b>/new</b> — choose how to create a new session:"),
    { reply_markup: kb },
  );
}

/** Actually create the fresh session (from the /new card's Clear / Clear+keep buttons). */
export async function doNewSession(ctx: BotCtx, conv: ConvKey, state: ChatState, keep: boolean): Promise<void> {
  // --keep: capture a short handoff summary of the CURRENT session before
  // replacing it, then inject it into the fresh session's context so the new
  // session continues with the recent thread (decisions, in-progress work)
  // instead of starting cold. Rules (project-memory) persist by default;
  // the recent conversation is what --keep carries over.
  const oldSID = state.sessionID;
  let carryover = "";
  if (keep && oldSID) {
    const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
    await ctx.tg.sendMessage(conv, tr(lang, "🔁 Đang tóm tắt session cũ để giữ mạch…", "🔁 Summarizing the old session to keep the thread…"));
    carryover = await summarizeForHandoff(ctx, oldSID);
  }
  await ctx.stopCurrent(conv, true);
  ctx.cancelAllReminders(conv); // abandoning the current session's pending prompts
  const dir = state.directory || ctx.cfg.opencodeDirectory;
  const sessionID = await ctx.oc.createSession(dir);
  await ctx.applyModelAndVariant(sessionID, state);
  if (state.agent) await ctx.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
  if (carryover) {
    // Inject the carry-over as a system-context instruction (no turn consumed),
    // so the fresh session "remembers" the recent thread for its whole life.
    await ctx.oc
      .setInstruction(
        sessionID,
        CARRYOVER_KEY,
        `You are continuing from a previous session. Carry-over context (recent decisions, in-progress work, open threads):\n${carryover}\nContinue from here, picking up where the previous session left off.`,
      )
      .catch((e) => warn("carryover instruction:", (e as Error).message));
  }
  ctx.st.set(conv, { sessionID, directory: dir, ...dropNotes() }); // a fresh session must not inherit pending notes
  ctx.stopWatch(conv, "session-changed"); // W5.1: the old session's watch is over
  await ctx.tg.sendMessage(
    conv,
    tr(ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? ""), `🆕 New session <code>${sessionID}</code>\ndir: <code>${esc(dir)}</code>${keep ? `\n🔁 carry-over: ${carryover ? "✓" : "(session cũ trống)"}` : ""}`, `🆕 New session <code>${sessionID}</code>\ndir: <code>${esc(dir)}</code>${keep ? `\n🔁 carry-over: ${carryover ? "✓" : "(old session empty)"}` : ""}`),
  );
}

/**
 * nw:clear / nw:keep / nw:cancel — the bare /new card (see cmdNew). Each
 * settles the card in place: removes its buttons (empty inline_keyboard) and
 * updates the message, so it can't be tapped twice.
 */
export async function handleNewConfirmCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const op = (cb.data ?? "").split(":")[1];
  const settle = (text: string) =>
    messageId
      ? ctx.tg.editMessageText(conv, messageId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
      : Promise.resolve();
  if (op === "clear") {
    await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "🗑️ Đang tạo phiên mới…", "🗑️ Creating a new session…"));
    await settle("🗑️ " + tr(lang, "Đã chọn: Clear", "Chosen: Clear"));
    await doNewSession(ctx, conv, ctx.st.get(conv), false); // fresh state at confirm time
    return;
  }
  if (op === "keep") {
    await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "💾 Đang tạo phiên mới…", "💾 Creating a new session…"));
    await settle("💾 " + tr(lang, "Đã chọn: Clear + giữ ngữ cảnh", "Chosen: Clear + keep context"));
    await doNewSession(ctx, conv, ctx.st.get(conv), true);
    return;
  }
  // nw:cancel (or any unknown op) — keep the current session, just settle the card.
  await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "↩️ Đã huỷ", "↩️ Cancelled"));
  await settle(tr(lang, "↩️ Đã huỷ — phiên cũ vẫn nguyên vẹn.", "↩️ Cancelled — the old session is intact."));
}

/**
 * Ask the (soon-to-be-replaced) session for a concise handoff summary of the
 * recent thread. Runs as one hidden turn in that session; the reply stays in
 * the (abandoned) session, so it never reaches the user's chat.
 */
export async function summarizeForHandoff(ctx: BotCtx, sessionID: string): Promise<string> {
  try {
    const r = await ctx.oc.promptAndWait(
      sessionID,
      "Summarize the recent conversation for handoff to a fresh session: key decisions, in-progress work, important facts, and open threads. Be concise (≤ 300 words). Do NOT summarize this summarization request itself.",
    );
    const t = (r.reply ?? "").trim();
    return t.length > 4000 ? `${t.slice(0, 4000)}…` : t;
  } catch (e) {
    warn("handoff summary:", (e as Error).message);
    return "";
  }
}

export async function cmdList(ctx: BotCtx, conv: ConvKey): Promise<void> {
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const sessions = await ctx.oc.listSessions();
  if (!sessions.length) return ctx.tg.sendMessage(conv, tr(lang, "Chưa có session — gửi /new để tạo.", "No sessions yet. Send /new."));
  const cur = ctx.st.get(conv).sessionID;
  const lines = sessions
    .slice(0, 15)
    .map((s) => `${s.id === cur ? "▶️ " : ""}<code>${s.id}</code>${s.title ? " — " + esc(s.title) : ""}`);
  const active = cur ? `\n\n${tr(lang, "Hiện tại", "Current")}: <code>${cur}</code>` : tr(lang, "\n\nChưa có session — gửi /new", "\n\nNo current session — send /new");
  await ctx.sendHtml(conv, `<b>Sessions (${sessions.length})</b>\n${lines.join("\n")}${active}`);
}

/**
 * `/use [session-id]` — switch to a session. Without a valid argument the
 * user gets a button picker of the 10 newest sessions instead of a usage line.
 */
export async function cmdUse(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  void state;
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  let sessions: SessionBrief[] | undefined;
  try {
    sessions = await ctx.oc.listSessions();
  } catch (e) {
    warn("listSessions:", (e as Error).message);
  }
  if (!arg) {
    if (!sessions) return ctx.tg.sendMessage(conv, tr(lang, "⚠️ Không liệt kê được session — kiểm tra OpenCode rồi thử lại.", "⚠️ Couldn't list sessions — check OpenCode and try again."));
    if (!sessions.length) return ctx.tg.sendMessage(conv, tr(lang, "Chưa có session — gửi /new để tạo.", "No sessions yet. Send /new."));
    return sendUsePicker(ctx, conv, sessions, undefined, lang);
  }
  // Unknown id (and the listing succeeded) → show the picker too; a failed
  // listing keeps the old behaviour of trusting the typed id.
  if (sessions && !sessions.some((s) => s.id === arg)) {
    return sendUsePicker(ctx, conv, sessions, tr(lang, `❌ Không có session <code>${esc(arg)}</code>`, `❌ No session <code>${esc(arg)}</code>`), lang);
  }
  await ctx.stopCurrent(conv, true); // stop the running turn before switching (same as /new, /clear)
  applyUseState(ctx, conv, arg);
  await ctx.tg.sendMessage(conv, tr(lang, `✅ Đang dùng session <code>${esc(arg)}</code>`, `✅ Now using session <code>${esc(arg)}</code>`));
}

/** Apply the /use switch: remember the session and drop its predecessor's pending prompts. */
export function applyUseState(ctx: BotCtx, conv: ConvKey, sessionID: string): void {
  const prev = ctx.st.peek(conv)?.sessionID;
  ctx.st.set(conv, { sessionID, ...dropNotes() }); // a switched-to session must not inherit the old session's pending notes (same as /new)
  if (prev && prev !== sessionID) ctx.stopWatch(conv, "session-changed"); // W5.1
  ctx.cancelAllReminders(conv); // switching sessions abandons the old pending prompts
  const droppedQueue = ctx.queue.clear(conv); // a session switch clears the queue (Q1.5)
  if (droppedQueue > 0) audit({ action: "queue_drop", chatId: conv, meta: { count: droppedQueue, reason: "clear" } });
}

/** The /use picker card: newest 10 sessions as buttons + a "type it instead" hint. */
export function sendUsePicker(ctx: BotCtx, conv: ConvKey, sessions: SessionBrief[], errorNote?: string, lang: Lang = "vi"): Promise<void> {
  const cur = ctx.st.get(conv).sessionID;
  const newest = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 10);
  const rows: Btn[][] = newest.map((s) => [
    { text: `${s.id === cur ? "▶️ " : ""}${s.title ? trunc(s.title, 40) : trunc(s.id, 14)}`, callback_data: `use:${s.id}` },
  ]);
  rows.push([
    { text: tr(lang, "📄 Xem tất cả", "📄 View all"), callback_data: "use:ls" },
    { text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: "use:close" },
  ]);
  return ctx.tg.sendMessage(
    conv,
    [errorNote ?? tr(lang, "❓ <b>/use</b> cần session-id", "❓ <b>/use</b> needs a session-id"), tr(lang, "Bấm để chọn session (mới nhất trước):", "Tap to pick a session (newest first):"), "Hoặc gửi: <code>/use &lt;session-id&gt;</code>"].join("\n"),
    { reply_markup: { inline_keyboard: rows } },
  );
}

/** Handle a tap on the /use picker (data = `use:<id|ls|close>`). */
export async function handleUseCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const id = (cb.data ?? "").slice("use:".length);
  if (id === "close" || id === "ls") {
    await ctx.tg.answerCallbackQuery(cb.id);
    if (messageId) await ctx.tg.deleteMessage(conv, messageId).catch(() => {});
    if (id === "ls") await cmdList(ctx, conv);
    return;
  }
  // A stale picker button may reference a session that no longer exists —
  // validate before switching (a failed listing keeps the /use fallback: trust the id).
  const sessions = await ctx.oc.listSessions().catch((e) => {
    warn("listSessions:", (e as Error).message);
    return undefined;
  });
  if (sessions && !sessions.some((s) => s.id === id)) {
    await ctx.tg.answerCallbackQuery(cb.id, tr(lang, `❌ Không có session: ${trunc(id, 30)}`, `❌ No session: ${trunc(id, 30)}`));
    if (messageId)
      await ctx.tg.editMessageText(conv, messageId, tr(lang, `❌ Không có session <code>${esc(id)}</code>`, `❌ No session <code>${esc(id)}</code>`)).catch(() => {});
    return;
  }
  await ctx.stopCurrent(conv, true); // stop the running turn before switching (same as /new, /clear)
  applyUseState(ctx, conv, id);
  await ctx.tg.answerCallbackQuery(cb.id, tr(lang, `Dùng ${trunc(id, 30)}`, `Using ${trunc(id, 30)}`));
  if (messageId) await ctx.tg.editMessageText(conv, messageId, tr(lang, `✅ Đang dùng session <code>${esc(id)}</code>`, `✅ Now using session <code>${esc(id)}</code>`)).catch(() => {});
}

/**
 * Stop the conversation's running turn — the shared /stop mechanism: stop
 * waiting (stopCurrent: abort the inflight controller, clear the queue, drop
 * the preview, clear the manager's busy flag) + interrupt the turn on the
 * server. /stop uses this and replies in chat; the watch card's "Stop task"
 * button (W4.2) uses the same path without a chat reply — the card itself
 * shows "Stopped".
 */
export async function stopTaskFor(ctx: BotCtx, conv: ConvKey, sessionID?: string): Promise<void> {
  await ctx.stopCurrent(conv);
  ctx.cancelAllReminders(conv);
  if (sessionID) await ctx.oc.interrupt(sessionID).catch(() => {});
}

export async function cmdStop(ctx: BotCtx, conv: ConvKey, state: ChatState): Promise<void> {
  await stopTaskFor(ctx, conv, state.sessionID);
  await ctx.tg.sendMessage(conv, "⏹️ Interrupted.");
}

export async function cmdClear(ctx: BotCtx, conv: ConvKey, state: ChatState): Promise<void> {
  await ctx.stopCurrent(conv, true);
  ctx.cancelAllReminders(conv); // stop nudging + clear schedules before wiping state
  void state;
  ctx.st.clear(conv);
  ctx.stopWatch(conv, "session-changed"); // W5.1
  for (const [formId, qf] of ctx.questionForms) {
    if (qf.conv === conv) ctx.questionForms.delete(formId);
  }
  await ctx.tg.sendMessage(conv, "🧹 State cleared. Next message starts a fresh session.");
}

/**
 * `/history` — the last few messages of the current session, rendered from
 * the OpenCode message log (user / assistant / tool lines).
 */
export async function cmdHistory(ctx: BotCtx, conv: ConvKey, state: ChatState): Promise<void> {
  if (!state.sessionID) return ctx.tg.sendMessage(conv, "No current session. Send /new.");
  const msgs = await ctx.oc.listMessages(state.sessionID).catch(() => [] as any[]);
  const sorted = [...msgs].sort((a: any, b: any) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  const recent = sorted.slice(-6);
  const lines = recent.map((m: any) => {
    if (m.type === "user") return "👤 " + esc(trunc(stripTags(m.text ?? ""), 300));
    if (m.type === "assistant") {
      const t = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
      return "🤖 " + esc(trunc(stripTags(t), 400));
    }
    return "· " + m.type;
  });
  await ctx.sendHtml(conv, `<b>Recent messages</b>\n${lines.join("\n")}`);
}
