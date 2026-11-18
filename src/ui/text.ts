/**
 * Telegram message-line helpers (spec: docs/sdd/message-layer.md, T2).
 *
 * Every helper:
 *   - is a pure function of lang + arguments — no global or mutable language
 *     state (M3.1);
 *   - localizes its own fixed wording via tr(lang, vi, en) (M3.2);
 *   - escapes plain-text arguments itself so a caller cannot forget;
 *     already-safe HTML is accepted only through the explicit raw() wrapper
 *     (M1.3);
 *   - truncates its output with the existing trunc() behaviour ("…" appended)
 *     at the Telegram message limit by default (M1.4).
 *
 * The optional `hint` (what to do next, M3.3) is rendered as a second, italic
 * line under the message.
 */
import { esc, trunc } from "../format.js";
import { STRINGS, tr } from "../i18n.js";
import type { Lang } from "../state.js";
import { UI_ICON } from "./icons.js";

/** Telegram per-message length limit (M1.4). */
export const MSG_LIMIT = 4096;
/** Telegram caption length limit (M1.4). */
export const CAPTION_LIMIT = 1024;

/** An already-safe HTML fragment — the caller vouches for it (M1.3). */
export interface RawHtml {
  readonly raw: string;
}

/** Mark a string as already-safe HTML so the helpers pass it through. */
export function raw(html: string): RawHtml {
  return { raw: html };
}

/** What the helpers accept: plain text (auto-escaped) or a raw() fragment. */
export type Text = string | RawHtml;

function render(t: Text): string {
  return typeof t === "string" ? esc(t) : t.raw;
}

/** "✅ <msg>" — a done/ok line. */
export function okLine(lang: Lang, msg: Text, limit: number = MSG_LIMIT): string {
  return trunc(`${UI_ICON.success} ${render(msg)}`, limit);
}

/** "❌ Lỗi: <msg>" / "❌ Error: <msg>", with an optional hint line (M3.3). */
export function errorLine(lang: Lang, msg: Text, hint?: Text, limit: number = MSG_LIMIT): string {
  let out = tr(lang, STRINGS.error_prefix.vi, STRINGS.error_prefix.en) + render(msg);
  if (hint !== undefined) out += `\n<i>${render(hint)}</i>`;
  return trunc(out, limit);
}

/** "⚠️ <msg>", with an optional hint line (M3.3). */
export function warnLine(lang: Lang, msg: Text, hint?: Text, limit: number = MSG_LIMIT): string {
  let out = `${UI_ICON.warning} ${render(msg)}`;
  if (hint !== undefined) out += `\n<i>${render(hint)}</i>`;
  return trunc(out, limit);
}

/** "⏳ <msg>" — a working/status line. */
export function statusLine(lang: Lang, msg: Text, limit: number = MSG_LIMIT): string {
  return trunc(`${UI_ICON.running} ${render(msg)}`, limit);
}

/** "<b><title></b>" followed by one line per entry (title auto-bolded). */
export function titledList(lang: Lang, title: Text, lines: Text[], limit: number = MSG_LIMIT): string {
  void lang; // kept for a uniform (lang, …) helper API (M3.1)
  const head = `<b>${render(title)}</b>`;
  const body = lines.map(render).join("\n");
  return trunc(body ? `${head}\n${body}` : head, limit);
}
