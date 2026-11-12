/**
 * The busy reply (docs/sdd/queue-and-steer.md, phase 2 — Q1.1, Q1.7, Q3.1, Q3.4, Q3.5).
 *
 * When a message arrives while the conv's turn is still running, the bot replies
 * with a busy notice. The reply depends on `config.busyMode`:
 *   - "off"   — EXACTLY today's behaviour: BUSY_REPLY_TEXT plus (when the message
 *               carries a Telegram id) the single "📝 Thêm vào note" button. This
 *               mode must stay byte-identical to the pre-queue behaviour (Q2.7).
 *   - "ask"   — busy text + Queue / Steer-now / note buttons. Nothing happens until
 *               the user taps (the default).
 *   - "queue" — the caller auto-enqueued the message before calling here; the reply
 *               is a short status line, only the note button (no add/steer buttons).
 *
 * All pure: the wiring (queue.push, oc.prompt({ delivery: "steer" })) lives in
 * bot.ts / orchestrator.ts. The button callbacks (`q:add:<id>`, `q:steer:<id>`)
 * target the user message that arrived while busy — its text is retained in the
 * BusyNoteStore under the same Telegram id (consumed on tap, as with the note
 * button) — and are distinct from the existing `note:<id>` prefix.
 */
import type { Lang } from "./state.js";
import { BUSY_REPLY_TEXT, noteButtonLabel, noteCallbackData } from "./notes.js";
import { tr } from "./i18n.js";
import type { Keyboard } from "./shared.js";

export type BusyMode = "ask" | "queue" | "off";

/** One inline button of a busy reply (`callback` maps to Telegram's callback_data). */
export interface BusyButton {
  text: string;
  callback: string;
}

export interface BusyReply {
  text: string;
  buttons: BusyButton[];
}

/** "📥 Xếp hàng" / "📥 Queue" */
export function queueButtonLabel(lang: Lang = "vi"): string {
  return tr(lang, "📥 Xếp hàng", "📥 Queue");
}

/** "🔀 Định tuyến ngay" / "🔀 Steer now" */
export function steerButtonLabel(lang: Lang = "vi"): string {
  return tr(lang, "🔀 Định tuyến ngay", "🔀 Steer now");
}

/**
 * Build the busy reply for a mode.
 *
 * `messageId` is the Telegram id of the user message that arrived while busy;
 * every button targets it (its text lives in the BusyNoteStore under that id).
 * Omit it → no buttons at all: the plain-text busy path for messages without a
 * user message (internal prompts), which is also how `off` mode behaves today.
 *
 * `off` returns EXACTLY the pre-queue reply: BUSY_REPLY_TEXT + the single note
 * button — byte-identical (Q2.7).
 */
export function buildBusyReply(opts: {
  lang: Lang;
  mode: BusyMode;
  /** Telegram id of the busy user message; omitted → no buttons. */
  messageId?: number;
  /** The position just assigned, for queue mode's "you are #N" line. */
  queuedCount?: number;
  /** false → omit the Steer button (e.g. no active session). Default true. */
  canSteer?: boolean;
}): BusyReply {
  const { lang, mode } = opts;
  const id = opts.messageId;

  if (mode === "off") {
    // Byte-identical to today: BUSY_REPLY_TEXT + the single note button.
    return { text: BUSY_REPLY_TEXT, buttons: id != null ? [{ text: noteButtonLabel(lang), callback: noteCallbackData(id) }] : [] };
  }

  if (mode === "queue") {
    const pos = id != null && opts.queuedCount != null ? tr(lang, ` (vị trí #${opts.queuedCount})`, ` (position #${opts.queuedCount})`) : "";
    const text =
      tr(lang, "📥 Đã thêm vào hàng chờ", "📥 Added to the queue") + pos +
      tr(lang, ". Sẽ chạy sau khi tin hiện tại xong.", ". It will run after the current message finishes.");
    return { text, buttons: id != null ? [{ text: noteButtonLabel(lang), callback: noteCallbackData(id) }] : [] };
  }

  // "ask": Queue + Steer now (when allowed) + the existing note button.
  const buttons: BusyButton[] = [];
  if (id != null) {
    buttons.push({ text: queueButtonLabel(lang), callback: addCallbackData(id) });
    if (opts.canSteer !== false) buttons.push({ text: steerButtonLabel(lang), callback: steerCallbackData(id) });
    buttons.push({ text: noteButtonLabel(lang), callback: noteCallbackData(id) });
  }
  return { text: BUSY_REPLY_TEXT, buttons };
}

/** The plain line shown when the queue is already full (cap 3). */
export function queueFullText(lang: Lang = "vi"): string {
  return tr(lang, "⚠️ Hàng chờ đã đầy (3 tin).", "⚠️ Queue is full (3 messages).");
}

/**
 * Busy reply when the queue is full: the message is NOT dropped — it stays
 * available through the note button (Q1.2: never drop silently).
 */
export function queueFullReply(opts: { lang: Lang; messageId?: number }): BusyReply {
  const id = opts.messageId;
  return {
    text: queueFullText(opts.lang),
    buttons: id != null ? [{ text: noteButtonLabel(opts.lang), callback: noteCallbackData(id) }] : [],
  };
}

/** Callback data for the Queue button (distinct from `note:<id>`). */
export function addCallbackData(messageId: number): string {
  return "q:add:" + messageId;
}

/** Callback data for the Steer-now button (distinct from `note:<id>`). */
export function steerCallbackData(messageId: number): string {
  return "q:steer:" + messageId;
}

export interface BusyCallback {
  kind: "add" | "steer";
  messageId: number;
}

/**
 * Parse a busy-button callback data → the action + target user-message id, or
 * null when the data is not ours or is malformed (unknown q: sub-prefix,
 * non-numeric id). Never matches a foreign `note:<id>`, `cont:…`, `ch:…` etc.
 */
export function parseBusyCallback(data: string | undefined): BusyCallback | null {
  if (!data) return null;
  let kind: "add" | "steer";
  let rest: string;
  if (data.startsWith("q:add:")) {
    kind = "add";
    rest = data.slice("q:add:".length);
  } else if (data.startsWith("q:steer:")) {
    kind = "steer";
    rest = data.slice("q:steer:".length);
  } else {
    return null;
  }
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? { kind, messageId: id } : null;
}

/** Map busy buttons to a Telegram inline keyboard (undefined when there are none). */
export function busyKeyboard(buttons: BusyButton[]): Keyboard | undefined {
  if (buttons.length === 0) return undefined;
  return { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callback }))] };
}
