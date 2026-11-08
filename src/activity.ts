/**
 * Pure helpers for the live tool-activity line ("📖 Đang đọc src/bot.ts…").
 * Renders OpenCode tool events into short Vietnamese labels. Kept free of any
 * Telegram/state concerns so it is unit-testable (scripts/test-activity.ts).
 */

import type { Lang } from "./state.js";

/** Collapse whitespace and clip a raw value to a display-safe length. */
export function clip(s: string, max = 48): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A short “Đang …” label for a running tool call. `input` is the tool's input
 * object (shape varies by tool); unknown tools fall back to a generic label.
 */
export function toolActivityLabel(name: string, input: Record<string, unknown> | undefined, lang: Lang = "vi"): string {
  const i = input ?? {};
  switch (name) {
    case "read":
      return lang === "en" ? `📖 Reading ${clip(str(i.path))}` : `📖 Đang đọc ${clip(str(i.path))}`;
    case "write":
      return lang === "en" ? `✍️ Writing ${clip(str(i.path))}` : `✍️ Đang ghi ${clip(str(i.path))}`;
    case "edit":
      return lang === "en" ? `✏️ Editing ${clip(str(i.path))}` : `✏️ Đang sửa ${clip(str(i.path))}`;
    case "apply_patch":
    case "patch":
      return lang === "en" ? "✏️ Editing code" : "✏️ Đang sửa code";
    case "bash":
    case "shell":
      return lang === "en" ? `▶ Running ${clip(str(i.command) || "shell command", 60)}` : `▶ Đang chạy ${clip(str(i.command) || "lệnh shell", 60)}`;
    case "grep":
      return lang === "en" ? `🔍 Searching ${clip(str(i.pattern) || str(i.query))}` : `🔍 Đang tìm ${clip(str(i.pattern) || str(i.query))}`;
    case "glob":
      return lang === "en" ? `🗂 Listing ${clip(str(i.pattern))}` : `🗂 Đang liệt kê ${clip(str(i.pattern))}`;
    case "webfetch":
      return lang === "en" ? `🌐 Viewing ${clip(str(i.url), 60)}` : `🌐 Đang xem ${clip(str(i.url), 60)}`;
    case "websearch":
      return lang === "en" ? `🔎 Looking up ${clip(str(i.query))}` : `🔎 Đang tra ${clip(str(i.query))}`;
    default:
      return lang === "en" ? `🔧 Using ${clip(name, 24)}` : `🔧 Đang dùng ${clip(name, 24)}`;
  }
}

/** Running→done verb swaps for the EN labels (mirrors the vi “Đang ”→“Đã ” swap). */
const EN_DONE_SWAPS: Array<[string, string]> = [
  ["Reading ", "Read "],
  ["Writing ", "Wrote "],
  ["Editing ", "Edited "],
  ["Running ", "Ran "],
  ["Searching ", "Searched "],
  ["Listing ", "Listed "],
  ["Viewing ", "Viewed "],
  ["Looking up ", "Looked up "],
  ["Using ", "Used "],
];

/**
 * The final line when a tool finishes: swap the running verb for the done form
 * (“Đang đọc” → “Đã đọc” / “Reading” → “Read”) and append the elapsed time on
 * success.
 */
export function activityDoneLine(label: string, ok: boolean, seconds?: number, lang: Lang = "vi"): string {
  let done = label;
  if (lang === "en") {
    for (const [from, to] of EN_DONE_SWAPS) {
      const idx = done.indexOf(from);
      if (idx !== -1) done = done.slice(0, idx) + to + done.slice(idx + from.length);
      break;
    }
  } else {
    done = label.replace("Đang ", "Đã ");
  }
  const t = ok && typeof seconds === "number" && seconds >= 0 ? ` · ${seconds.toFixed(1)}s` : "";
  return `${ok ? "✅" : "❌"} ${done}${t}`;
}
