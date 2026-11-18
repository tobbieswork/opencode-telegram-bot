/**
 * Telegram inline-keyboard helpers (spec: docs/sdd/message-layer.md, T3).
 *
 * Buttons are built as plain `Btn`s — the callback registry
 * (docs/sdd/callback-registry.md) does not exist yet (M2.2).
 *
 * All labels are clipped to BTN_LABEL_MAX so they do not truncate badly on a
 * phone (M2.3, the limit is set in one place).
 */
import { tr } from "../i18n.js";
import type { Lang } from "../state.js";
import type { Btn, Keyboard } from "../shared.js";

/** Max length of a button label (M2.3, set in one place). */
export const BTN_LABEL_MAX = 32;

/** A button spec: label + callback data (the helpers do the clipping). */
export interface BtnSpec {
  text: string;
  data: string;
}

function clip(text: string): string {
  return text.length <= BTN_LABEL_MAX ? text : text.slice(0, BTN_LABEL_MAX - 1) + "…";
}

function btn(spec: BtnSpec): Btn {
  return { text: clip(spec.text), callback_data: spec.data };
}

/** A single [Yes / No] confirm row: [[yes, no]] (M2.1). */
export function confirmKeyboard(lang: Lang, yes: BtnSpec, no: BtnSpec): Keyboard {
  void lang; // kept for a uniform (lang, …) helper API (M3.1)
  return { inline_keyboard: [[btn(yes), btn(no)]] };
}

/** A single button on its own row: [[button]] (M2.1). */
export function singleButton(spec: BtnSpec): Keyboard {
  return { inline_keyboard: [[btn(spec)]] };
}

/** The "❌ Đóng" / "❌ Close" row that pickers end with (M2.1). */
export function backCloseRow(lang: Lang, data: string): Btn[] {
  return [{ text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: data }];
}

/** The options for {@link pickerKeyboard}. */
export interface PickerOptions {
  /** All option labels, localized by the caller. */
  labels: string[];
  /** callback_data for the absolute option index i. */
  data: (i: number) => string;
  /** The current option's index → gets a "▶️ " marker. */
  current?: number;
  /** Buttons per row (default 2). */
  cols?: 1 | 2;
  /** Options per page (default 10). */
  pageSize?: number;
  /** The 0-based page to render (default 0). */
  page?: number;
  /** callback_data for the nav arrows; omitted → no paging at all. */
  pageData?: (page: number) => string;
  /** Append the close row (default true). */
  close?: boolean;
  /** The close button's callback_data (required while `close` is on). */
  closeData?: string;
}

/**
 * An options list with paging + close (M2.1): `cols` buttons per row, a "▶️ "
 * marker on the current option, a [⬅️, "n/N", ➡️] nav row while there is more
 * than one page (the middle button re-requests the same page, i.e. no-op),
 * and a close row last.
 */
export function pickerKeyboard(lang: Lang, opts: PickerOptions): Keyboard {
  const cols = opts.cols ?? 2;
  const pageSize = opts.pageSize ?? 10;
  const pages = Math.max(1, Math.ceil(opts.labels.length / pageSize));
  const page = Math.max(0, Math.min(opts.page ?? 0, pages - 1));
  const rows: Btn[][] = [];
  const start = page * pageSize;
  const slice = opts.labels.slice(start, start + pageSize);
  for (let i = 0; i < slice.length; i += cols) {
    rows.push(
      slice
        .slice(i, i + cols)
        .map((label, j) => {
          const idx = start + i + j;
          return { text: (idx === opts.current ? "▶️ " : "") + clip(label), callback_data: opts.data(idx) };
        }),
    );
  }
  if (opts.pageData && opts.labels.length > pageSize) {
    const nav: Btn[] = [];
    if (page > 0) nav.push({ text: "⬅️", callback_data: opts.pageData(page - 1) });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: opts.pageData(page) });
    if (page < pages - 1) nav.push({ text: "➡️", callback_data: opts.pageData(page + 1) });
    rows.push(nav);
  }
  if (opts.close ?? true) {
    if (opts.closeData === undefined) throw new Error("pickerKeyboard: closeData is required while the close row is on");
    rows.push(backCloseRow(lang, opts.closeData));
  }
  return { inline_keyboard: rows };
}
