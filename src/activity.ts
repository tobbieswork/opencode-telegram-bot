/**
 * Pure helpers for the live tool-activity line ("📖 Đang đọc src/bot.ts…").
 * Renders OpenCode tool events into short Vietnamese labels. Kept free of any
 * Telegram/state concerns so it is unit-testable (scripts/test-activity.ts).
 */

/** Collapse whitespace and clip a raw value to a display-safe length. */
export function clip(s: string, max = 48): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A short "Đang …" label for a running tool call. `input` is the tool's input
 * object (shape varies by tool); unknown tools fall back to a generic label.
 */
export function toolActivityLabel(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (name) {
    case "read":
      return `📖 Đang đọc ${clip(str(i.path))}`;
    case "write":
      return `✍️ Đang ghi ${clip(str(i.path))}`;
    case "edit":
      return `✏️ Đang sửa ${clip(str(i.path))}`;
    case "apply_patch":
    case "patch":
      return "✏️ Đang sửa code";
    case "bash":
    case "shell":
      return `▶ Đang chạy ${clip(str(i.command) || "lệnh shell", 60)}`;
    case "grep":
      return `🔍 Đang tìm ${clip(str(i.pattern) || str(i.query))}`;
    case "glob":
      return `🗂 Đang liệt kê ${clip(str(i.pattern))}`;
    case "webfetch":
      return `🌐 Đang xem ${clip(str(i.url), 60)}`;
    case "websearch":
      return `🔎 Đang tra ${clip(str(i.query))}`;
    default:
      return `🔧 Đang dùng ${clip(name, 24)}`;
  }
}

/**
 * The final line when a tool finishes: swap the running verb for the done form
 * ("Đang đọc" → "Đã đọc") and append the elapsed time on success.
 */
export function activityDoneLine(label: string, ok: boolean, seconds?: number): string {
  const done = label.replace("Đang ", "Đã ");
  const t = ok && typeof seconds === "number" && seconds >= 0 ? ` · ${seconds.toFixed(1)}s` : "";
  return `${ok ? "✅" : "❌"} ${done}${t}`;
}
