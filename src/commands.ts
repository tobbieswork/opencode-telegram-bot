/**
 * Single source of truth for the bot's command surface.
 *
 * Three places render this catalog, and they must never drift apart
 * (drift has bitten us twice: /agents missing from the menu+help, and
 * /reboot in the menu but not in the text dispatch):
 *
 *   1. Telegram's /autocomplete menu   → myCommands()      (setMyCommands)
 *   2. The /help card text             → helpText()        (sendHtml)
 *   3. The tappable button grid        → commandGrid()     (inline keyboard)
 *
 * Add a command here and all three surfaces update automatically.
 */

export type CmdGroupId = "session" | "model" | "manager" | "control";

export interface CmdGroup {
  id: CmdGroupId;
  /** Emoji + title, rendered as a <b> heading in /help (Vietnamese, the default). */
  title: string;
  /** English variant of the title, shown when the user's language is "en". */
  titleEn: string;
}

export interface BotCommand {
  /** Canonical command, without the leading slash. */
  cmd: string;
  /** Aliases accepted by the dispatcher, without slashes. */
  aliases?: string[];
  /** Vietnamese one-liner shown in the autocomplete menu and in /help. */
  desc: string;
  /** English one-liner, shown in /help when the user's language is "en". */
  descEn: string;
  /** Argument hint for the /help line only: "<id>", "[path]", "on|off", … */
  arg?: string;
  /** When set, the command gets a tappable button in the /help grid. */
  button?: string;
  group: CmdGroupId;
}

export const CMD_GROUPS: CmdGroup[] = [
  { id: "session", title: "📁 Phiên &amp; thư mục", titleEn: "📁 Session &amp; directory" },
  { id: "model", title: "🎛 Mode &amp; model", titleEn: "🎛 Mode &amp; model" },
  { id: "manager", title: "🧩 Worker (Manager)", titleEn: "🧩 Worker (Manager)" },
  { id: "control", title: "⚙️ Điều khiển", titleEn: "⚙️ Control" },
];

export const COMMANDS: BotCommand[] = [
  // ── session ────────────────────────────────────────────────────────────
  // `note` intentionally sits above `new` in the "/" autocomplete menu: the
  // two are adjacent and easy to mistype when tapping fast, and note is the
  // safe one. The /help card is grouped (note stays in the control group),
  // so this only affects the flat menu order.
  { cmd: "note", arg: "[ghi chú]", desc: "Ghi chú khi agent bận (trống = xem ghi chú)", descEn: "Jot a note while the agent is busy (empty = view notes)", group: "control" },
  { cmd: "new", desc: "Bắt đầu phiên làm việc mới", descEn: "Start a new work session", button: "🆕 Session mới", group: "session" },
  { cmd: "ls", aliases: ["sessions"], desc: "Liệt kê phiên gần đây", descEn: "List recent sessions", button: "📄 Sessions", group: "session" },
  { cmd: "use", arg: "<id>", desc: "Chuyển sang một phiên", descEn: "Switch to a session", group: "session" },
  { cmd: "dir", arg: "[path]", desc: "Xem/đặt thư mục làm việc", descEn: "View/set working directory", button: "📍 Thư mục", group: "session" },
  { cmd: "browse", aliases: ["b"], arg: "[path]", desc: "Duyệt thư mục bằng nút bấm", descEn: "Browse directories with buttons", button: "📁 Duyệt", group: "session" },

  // ── model ──────────────────────────────────────────────────────────────
  { cmd: "mode", aliases: ["modes"], desc: "Chọn mode: build / plan / general / explore", descEn: "Pick mode: build / plan / general / explore", button: "🎛 Mode", group: "model" },
  { cmd: "models", desc: "Liệt kê model khả dụng", descEn: "List available models", button: "🤖 Models", group: "model" },
  { cmd: "model", arg: "<id>", desc: "Đặt model cho phiên này", descEn: "Set the model for this session", group: "model" },
  { cmd: "agents", desc: "Liệt kê agent khả dụng", descEn: "List available agents", button: "🤵 Agents", group: "model" },
  { cmd: "agent", arg: "<id>", desc: "Đặt agent cho phiên này", descEn: "Set the agent for this session", group: "model" },
  { cmd: "variants", arg: "[tên]", desc: "Xem/đặt reasoning variant (vd: xhigh)", descEn: "View/set reasoning variant (e.g. xhigh)", button: "🎚 Variants", group: "model" },
  { cmd: "variant", arg: "<tên>", desc: "Đặt reasoning variant", descEn: "Set reasoning variant", group: "model" },

  // ── manager ────────────────────────────────────────────────────────────
  { cmd: "spawn", arg: "<tên> [dir]", desc: "Tạo worker: topic + session riêng", descEn: "Create a worker: own topic + session", group: "manager" },
  { cmd: "board", aliases: ["workers"], desc: "Trạng thái mọi worker", descEn: "Status of all workers", group: "manager" },
  { cmd: "kill", arg: "<tên>", desc: "Dừng một worker", descEn: "Stop a worker", group: "manager" },
  { cmd: "stopall", desc: "Dừng mọi worker", descEn: "Stop all workers", group: "manager" },
  { cmd: "manager", arg: "on|off", desc: "Manager nhận việc ở chat chính và giao cho worker", descEn: "Manager takes work in the main chat, delegates to workers", group: "manager" },
  { cmd: "auto", arg: "on|off", desc: "Manager tự giao việc hay chờ duyệt", descEn: "Manager auto-dispatches or waits for approval", group: "manager" },
  { cmd: "wt", desc: "Worktree: diff / merge / xoá (trong topic worker)", descEn: "Worktree: diff / merge / remove (in worker topic)", group: "manager" },
  { cmd: "prune", arg: "[số_ngày]", desc: "Dọn topic worker đã xong (mặc định >7 ngày)", descEn: "Clean up finished worker topics (default >7 days)", group: "manager" },

  // ── control ────────────────────────────────────────────────────────────
  { cmd: "stop", desc: "Dừng task đang chạy", descEn: "Stop the running task", button: "⏹ Dừng", group: "control" },
  { cmd: "btw", arg: "<câu hỏi>", desc: "Hỏi nhanh trên phiên tạm — không lẫn ngữ cảnh manager", descEn: "Quick question on a temp session — no manager context", group: "control" },
  { cmd: "ask", arg: "[claude|gemini] <câu hỏi>", desc: "Hỏi cố vấn Claude/Gemini — topic riêng, hỏi tiếp được", descEn: "Ask the Claude/Gemini advisor — own topic, follow-ups ok", group: "control" },
  { cmd: "review", arg: "[PR|branch|commit]", desc: "Review code (chỉ đọc, chạy skill review-code)", descEn: "Review code (read-only, runs review-code skill)", group: "control" },
  { cmd: "context", aliases: ["ctx"], desc: "Ảnh chụp phiên hiện tại (usage + files)", descEn: "Snapshot of the current session (usage + files)", button: "📸 Context", group: "control" },
  { cmd: "usage", desc: "Mức dùng context theo phiên + cảnh báo gần tràn", descEn: "Context usage per session + near-overflow warning", button: "📊 Usage", group: "control" },
  { cmd: "rotation", desc: "Sức khoẻ xoay phiên Manager (nền + lịch sử)", descEn: "Manager session rotation health (floor + history)", button: "♻️ Rotation", group: "control" },
  { cmd: "history", desc: "Xem tin nhắn gần đây", descEn: "View recent messages", button: "📜 Lịch sử", group: "control" },
  { cmd: "status", desc: "Trạng thái kết nối", descEn: "Connection status", button: "🔌 Trạng thái", group: "control" },
  { cmd: "reboot", desc: "Reboot máy (2 bước xác nhận)", descEn: "Reboot the machine (2-step confirm)", button: "🔄 Reboot", group: "control" },
  { cmd: "clear", desc: "Xoá state của chat này", descEn: "Clear this chat's state", button: "🧹 Xoá state", group: "control" },
  { cmd: "schedule", arg: "<spec> <prompt>", desc: "Đặt lịch chạy prompt tự động", descEn: "Schedule an automated prompt run", button: "⏰ Lịch", group: "control" },
  { cmd: "lang", arg: "vi|en", desc: "Đặt ngôn ngữ: vi (Tiếng Việt) / en (English)", descEn: "Set language: vi (Tiếng Việt) / en (English)", group: "control" },
  { cmd: "help", desc: "Danh sách lệnh + nút bấm", descEn: "Command list + buttons", button: "📖 Help", group: "control" },
];

import type { Lang } from "./state.js";

/** Escape < > & for Telegram HTML (descriptions are trusted, args are not). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One "/cmd [arg] — desc" line for the help card, localized by lang. */
function cmdLine(c: BotCommand, lang: Lang): string {
  const arg = c.arg ? ` ${c.arg}` : "";
  const desc = lang === "en" ? c.descEn : c.desc;
  return `/${c.cmd}${esc(arg)} — ${esc(desc)}`;
}

/**
 * The Telegram /autocomplete menu. `help` is pinned first (it's the
 * discovery entry point); the rest follow catalog order.
 */
export function myCommands(): Array<{ command: string; description: string }> {
  const rest = COMMANDS.filter((c) => c.cmd !== "help");
  const help = COMMANDS.find((c) => c.cmd === "help");
  const ordered = help ? [help, ...rest] : rest;
  return ordered.map((c) => ({ command: c.cmd, description: c.desc }));
}

/**
 * The /help card body (Telegram HTML). Sent via sendHtml, so <b>/<code>
 * markup is expected and raw <>& are escaped by esc().
 */
export function helpText(lang: Lang = "vi"): string {
  const en = lang === "en";
  const parts: string[] = [
    "<b>🤖 OpenCode Remote</b>",
    en
      ? "Message me — I run on OpenCode and reply with results."
      : "Gửi tin nhắn cho tôi — tôi chạy bằng OpenCode và trả kết quả.",
    en
      ? "📎 Send files (image, PDF, code, zip ≤ 20MB) — caption = instructions."
      : "📎 Gửi file (ảnh, PDF, code, zip ≤ 20MB) — kèm caption = chỉ dẫn.",
    "",
  ];
  for (const g of CMD_GROUPS) {
    const inGroup = COMMANDS.filter((c) => c.group === g.id);
    if (!inGroup.length) continue;
    parts.push(`<b>${en ? g.titleEn : g.title}</b>`);
    parts.push(...inGroup.map((c) => cmdLine(c, lang)));
    parts.push("");
  }
  parts.push(
    en
      ? "💡 <b>Tip:</b> type <code>/</code> for the command menu · when I need to ask, pick an option by button or type it · 🔥 my message to dispatch a worker · 👍/👎 a worker report to approve/reject"
      : "💡 <b>Mẹo:</b> gõ <code>/</code> để hiện menu lệnh · khi tôi cần hỏi, chọn đáp án bằng nút hoặc tự gõ · 🔥 vào tin của tôi để giao worker · 👍/👎 vào báo cáo worker để duyệt/bác",
    "",
    en ? "Tap a button below to run a command:" : "Bấm một nút bên dưới để chạy lệnh ngay:",
  );
  return parts.join("\n");
}

/**
 * The tappable button grid under /help — two buttons per row, in catalog
 * order. Button callback data is `cmd:<name>`, handled by runCommandButton.
 */
export function commandGrid(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  let row: Array<{ text: string; callback_data: string }> = [];
  for (const c of COMMANDS) {
    if (!c.button) continue;
    row.push({ text: c.button, callback_data: `cmd:${c.cmd}` });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

/** Every command name (canonical + aliases) the dispatcher accepts. */
export function knownCommands(): Set<string> {
  const s = new Set<string>();
  for (const c of COMMANDS) {
    s.add(c.cmd);
    for (const a of c.aliases ?? []) s.add(a);
  }
  return s;
}
