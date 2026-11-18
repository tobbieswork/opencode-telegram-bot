/**
 * `perm:` — OpenCode tool permission asks, relayed to Telegram as buttons
 * (ask → card → resolve relay). Moved out of bot.ts (docs/sdd/split-bot-ts.md,
 * T2 pilot). The feature talks to the bot only through the narrow `BotCtx`
 * interface; `Bot` satisfies it structurally so behaviour is unchanged. The
 * reminder plumbing (start/cancelReminder, findPromptConv) and in-place card
 * editing (editCardInPlace) still live on `Bot` and are reached via `ctx`.
 */
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import { chatOf } from "../conv.js";
import type { Keyboard } from "../shared.js";
import { esc, trunc } from "../format.js";
import { tr } from "../i18n.js";
import { warn } from "../logger.js";
import { isAlreadyResolvedPermissionError } from "../perm.js";

/** A permission request is pending — relay it to the worker's main channel as buttons. */
export async function onPermissionAsked(ctx: BotCtx, d: any): Promise<void> {
  const requestID = d.id as string;
  const sessionID = d.sessionID as string;
  if (ctx.permissionPrompts.has(requestID)) return;
  const conv = ctx.st.findChatBySession(sessionID);
  if (!conv) {
    // Orphan session (e.g. a /btw throwaway): the ask can never be relayed,
    // so auto-reject — the session fails fast instead of hanging on the prompt.
    warn(`permission.asked for session ${sessionID} with no mapped chat — auto-rejecting`);
    ctx.oc.replyPermission(sessionID, requestID, "reject").catch(() => {});
    return;
  }
  ctx.orch.onWaiting(conv);
  // Relay the card to the worker's main channel so the user answers it from
  // the manager chat; the worker's conv stays the prompt's owner (status +
  // reminder schedule).
  const relayConv = chatOf(conv);
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const lines: string[] = [tr(lang, "🔐 <b>OpenCode xin quyền</b>", "🔐 <b>OpenCode requests permission</b>")];
  // The card lives in the shared main channel — name the worker that asks.
  const workerName = ctx.st.peek(conv)?.worker?.name;
  if (workerName) lines.push(`<b>${tr(lang, "Worker", "Worker")}: ${esc(workerName)}</b>`);
  lines.push(`action: <code>${esc(d.action ?? "?")}</code>`);
  for (const r of (d.resources ?? []) as string[]) {
    lines.push(`resource: <code>${esc(trunc(r, 150))}</code>`);
  }
  if (d.message) lines.push(esc(trunc(String(d.message), 300)));
  lines.push("", tr(lang, "<i>Bấm để trả lời — hoặc xử lý trong terminal TUI (bot tự cập nhật).</i>", "<i>Tap to answer — or handle it in the terminal TUI (the bot updates itself).</i>"));
  const kb: Keyboard = {
    inline_keyboard: [
      [
        { text: tr(lang, "✅ Duyệt 1 lần", "✅ Allow once"), callback_data: `perm:${requestID}:once` },
        { text: tr(lang, "♾️ Duyệt luôn", "♾️ Always allow"), callback_data: `perm:${requestID}:always` },
      ],
      [{ text: tr(lang, "❌ Từ chối", "❌ Deny"), callback_data: `perm:${requestID}:reject` }],
    ],
  };
  // Re-registration after a restart (reconcile): refresh the original card in
  // place instead of posting a duplicate permission prompt.
  const cardText = lines.join("\n");
  const prevId = ctx.st.get(conv).pendingPrompts?.[requestID]?.messageId;
  let messageId = prevId ? await ctx.editCardInPlace(relayConv, prevId, cardText, kb) : -1;
  // The card send can fail (Telegram 429, a network blip, an HTML parse
  // error). Retry it a few times; if it still fails we MUST register the
  // prompt anyway, otherwise the user never sees the ask and the agent hangs
  // on a request only a restart could recover. The armed reminder re-sends
  // the card (idempotently) until it lands.
  if (messageId < 0) messageId = await sendPermissionCard(ctx, relayConv, cardText, kb, requestID);
  const cardId = messageId > 0 ? messageId : 0; // 0 = "card missing" sentinel
  ctx.permissionPrompts.set(requestID, { requestID, sessionID, conv, relayConv, messageId: cardId });
  if (cardId === 0) {
    warn(`permission card send failed for ${requestID} — registered without a card; a reminder will re-send it`);
  }
  // Arm the reminder in both cases: with a card it nudges; with a missing
  // card (messageId 0) its fire RE-SENDS the card, and the resend path updates
  // the stored messageId so button edits work.
  ctx.startPromptReminder(conv, requestID, "permission", cardText, kb, cardId, relayConv);
}

/**
 * Send the permission card, retrying a few times with a short backoff.
 * Returns the new message id, or -1 if every attempt failed. A failed send
 * must never lose the prompt — the caller registers it (messageId 0) and arms
 * a reminder that re-sends the card.
 */
async function sendPermissionCard(ctx: BotCtx, relayConv: ConvKey, text: string, kb: Keyboard, requestID: string): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = await ctx.tg.sendMessageId(relayConv, text, { reply_markup: kb }).catch(() => -1);
    if (id > 0) return id;
    warn(`permission card send failed for ${requestID} (attempt ${attempt}/3)`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt)); // 250ms, then 500ms
  }
  return -1;
}

/** The request was answered elsewhere (e.g. the TUI) — settle the Telegram card. */
export async function onPermissionResolved(ctx: BotCtx, requestID: string, reply: string): Promise<void> {
  const p = ctx.permissionPrompts.get(requestID);
  if (!p) {
    // After a restart the in-memory map is empty, but a reminder may still be
    // persisted — cancel it (find its conv) before bailing.
    const rc = ctx.findPromptConv(requestID);
    if (rc) ctx.cancelReminder(rc, requestID);
    return;
  }
  ctx.permissionPrompts.delete(requestID);
  ctx.cancelReminder(p.conv, requestID);
  const lang = ctx.userPrefs.getLang(ctx.st.peek(p.conv)?.createdBy ?? "");
  const label = reply === "reject" ? tr(lang, "từ chối", "denied") : reply === "always" ? tr(lang, "duyệt luôn", "always allowed") : tr(lang, "duyệt", "allowed");
  if (p.messageId) {
    await ctx.tg
      .editMessageText(p.relayConv, p.messageId, tr(lang, `ℹ️ Quyền đã được ${label} ở nơi khác.`, `ℹ️ Permission was ${label} elsewhere.`))
      .catch(() => {});
  }
}

/** Handle a tap on a permission button (data = `perm:<requestID>:<once|always|reject>`). */
export async function handlePermissionCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number, answer: (toast?: string) => void = (t) => { void ctx.tg.answerCallbackQuery(cb.id, t).catch(() => {}); }): Promise<void> {
  const parts = (cb.data ?? "").split(":");
  const requestID = parts[1];
  const decision = parts[2];
  const p = ctx.permissionPrompts.get(requestID);
  if (!p) {
    answer(tr(ctx.userPrefs.getLang(cb.from?.id ?? ""), "Yêu cầu quyền này đã hết hạn.", "This permission request has expired."));
    return;
  }
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const labels: Record<string, string> = {
    once: tr(lang, "✅ Đã duyệt (1 lần).", "✅ Allowed (once)."),
    always: tr(lang, "♾️ Đã duyệt luôn — quyền này được lưu, không hỏi lại.", "♾️ Always allowed — this permission is saved and won't be asked again."),
    reject: tr(lang, "❌ Đã từ chối.", "❌ Denied."),
  };
  try {
    if (!labels[decision]) throw new Error(tr(lang, "Lựa chọn không hợp lệ.", "Invalid choice."));
    await ctx.oc.replyPermission(p.sessionID, p.requestID, decision as "once" | "always" | "reject");
    ctx.permissionPrompts.delete(requestID);
    ctx.cancelReminder(p.conv, requestID); // answered → stop nudging (schedule lives under the worker conv)
    answer();
    if (messageId) await ctx.tg.editMessageText(conv, messageId, labels[decision]).catch(() => {});
  } catch (e) {
    if (isAlreadyResolvedPermissionError(e)) {
      // The server says the request is no longer pending (answered here or
      // elsewhere, e.g. the TUI, or already gone) — settle the card and stop
      // nudging.
      ctx.permissionPrompts.delete(requestID);
      ctx.cancelReminder(p.conv, requestID); // answered elsewhere → stop nudging (schedule lives under the worker conv)
      answer(tr(lang, "Yêu cầu này đã được xử lý ở nơi khác.", "This request was handled elsewhere."));
      if (messageId) {
        await ctx.tg.editMessageText(conv, messageId, tr(lang, "ℹ️ Quyền đã được xử lý ở nơi khác.", "ℹ️ Permission was handled elsewhere.")).catch(() => {});
      }
      return;
    }
    // Any OTHER failure (network blip, transport error, a real "permission
    // denied", an HTTP 403): the request is STILL pending on the server. Keep
    // the prompt and its buttons so the user can tap again to retry.
    const msg = (e as Error)?.message ?? "";
    warn(`permission reply failed for ${requestID} (still pending, buttons kept): ${msg}`);
    answer(
      `${tr(lang, "⚠️ Chưa trả lời được — vẫn đang chờ, thử bấm lại.", "⚠️ Couldn't answer — still pending, tap again to retry.")} ${msg.slice(0, 100)}`,
    );
  }
}
