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
  /** Emoji + title, rendered as a <b> heading in /help. */
  title: string;
}

export interface BotCommand {
  /** Canonical command, without the leading slash. */
  cmd: string;
  /** Aliases accepted by the dispatcher, without slashes. */
  aliases?: string[];
  /** Vietnamese one-liner shown in the autocomplete menu and in /help. */
  desc: string;
  /** Argument hint for the /help line only: "<id>", "[path]", "on|off", … */
  arg?: string;
  /** When set, the command gets a tappable button in the /help grid. */
  button?: string;
  group: CmdGroupId;
}

export const CMD_GROUPS: CmdGroup[] = [
  { id: "session", title: "📁 Phiên &amp; thư mục" },
  { id: "model", title: "🎛 Mode &amp; model" },
  { id: "manager", title: "🧩 Worker (Manager)" },
  { id: "control", title: "⚙️ Điều khiển" },
];

export const COMMANDS: BotCommand[] = [
  // ── session ────────────────────────────────────────────────────────────
  { cmd: "new", desc: "Bắt đầu phiên làm việc mới", button: "🆕 Session mới", group: "session" },
  { cmd: "ls", aliases: ["sessions"], desc: "Liệt kê phiên gần đây", button: "📄 Sessions", group: "session" },
  { cmd: "use", arg: "<id>", desc: "Chuyển sang một phiên", group: "session" },
  { cmd: "dir", arg: "[path]", desc: "Xem/đặt thư mục làm việc", button: "📍 Thư mục", group: "session" },
  { cmd: "browse", aliases: ["b"], arg: "[path]", desc: "Duyệt thư mục bằng nút bấm", button: "📁 Duyệt", group: "session" },

  // ── model ──────────────────────────────────────────────────────────────
  { cmd: "mode", aliases: ["modes"], desc: "Chọn mode: build / plan / general / explore", button: "🎛 Mode", group: "model" },
  { cmd: "models", desc: "Liệt kê model khả dụng", button: "🤖 Models", group: "model" },
  { cmd: "model", arg: "<id>", desc: "Đặt model cho phiên này", group: "model" },
  { cmd: "agents", desc: "Liệt kê agent khả dụng", button: "🤵 Agents", group: "model" },
  { cmd: "agent", arg: "<id>", desc: "Đặt agent cho phiên này", group: "model" },
  { cmd: "variants", arg: "[tên]", desc: "Xem/đặt reasoning variant (vd: xhigh)", button: "🎚 Variants", group: "model" },
  { cmd: "variant", arg: "<tên>", desc: "Đặt reasoning variant", group: "model" },

  // ── manager ────────────────────────────────────────────────────────────
  { cmd: "spawn", arg: "<tên> [dir]", desc: "Tạo worker: topic + session riêng", group: "manager" },
  { cmd: "board", aliases: ["workers"], desc: "Trạng thái mọi worker", group: "manager" },
  { cmd: "kill", arg: "<tên>", desc: "Dừng một worker", group: "manager" },
  { cmd: "stopall", desc: "Dừng mọi worker", group: "manager" },
  { cmd: "manager", arg: "on|off", desc: "Manager nhận việc ở chat chính và giao cho worker", group: "manager" },
  { cmd: "auto", arg: "on|off", desc: "Manager tự giao việc hay chờ duyệt", group: "manager" },
  { cmd: "wt", desc: "Worktree: diff / merge / xoá (trong topic worker)", group: "manager" },
  { cmd: "prune", arg: "[số_ngày]", desc: "Dọn topic worker đã xong (mặc định >7 ngày)", group: "manager" },

  // ── control ────────────────────────────────────────────────────────────
  { cmd: "stop", desc: "Dừng task đang chạy", button: "⏹ Dừng", group: "control" },
  { cmd: "note", arg: "[ghi chú]", desc: "Ghi chú khi agent bận (trống = xem ghi chú)", group: "control" },
  { cmd: "btw", arg: "<câu hỏi>", desc: "Hỏi nhanh trên phiên tạm — không lẫn ngữ cảnh manager", group: "control" },
  { cmd: "context", aliases: ["ctx"], desc: "Ảnh chụp phiên hiện tại (usage + files)", button: "📸 Context", group: "control" },
  { cmd: "usage", desc: "Mức dùng context theo phiên + cảnh báo gần tràn", button: "📊 Usage", group: "control" },
  { cmd: "history", desc: "Xem tin nhắn gần đây", button: "📜 Lịch sử", group: "control" },
  { cmd: "status", desc: "Trạng thái kết nối", button: "🔌 Trạng thái", group: "control" },
  { cmd: "reboot", desc: "Reboot máy (2 bước xác nhận)", button: "🔄 Reboot", group: "control" },
  { cmd: "clear", desc: "Xoá state của chat này", button: "🧹 Xoá state", group: "control" },
  { cmd: "schedule", arg: "<spec> <prompt>", desc: "Đặt lịch chạy prompt tự động", button: "⏰ Lịch", group: "control" },
  { cmd: "help", desc: "Danh sách lệnh + nút bấm", button: "📖 Help", group: "control" },
];

/** Escape < > & for Telegram HTML (descriptions are trusted, args are not). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One "/cmd [arg] — desc" line for the help card. */
function cmdLine(c: BotCommand): string {
  const arg = c.arg ? ` ${c.arg}` : "";
  return `/${c.cmd}${esc(arg)} — ${esc(c.desc)}`;
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
export function helpText(): string {
  const parts: string[] = [
    "<b>🤖 OpenCode Remote</b>",
    "Gửi tin nhắn cho tôi — tôi chạy bằng OpenCode và trả kết quả.",
    "",
  ];
  for (const g of CMD_GROUPS) {
    const inGroup = COMMANDS.filter((c) => c.group === g.id);
    if (!inGroup.length) continue;
    parts.push(`<b>${g.title}</b>`);
    parts.push(...inGroup.map(cmdLine));
    parts.push("");
  }
  parts.push(
    "💡 <b>Mẹo:</b> gõ <code>/</code> để hiện menu lệnh · khi tôi cần hỏi, chọn đáp án bằng nút hoặc tự gõ · 🔥 vào tin của tôi để giao worker · 👍/👎 vào báo cáo worker để duyệt/bác",
    "",
    "Bấm một nút bên dưới để chạy lệnh ngay:",
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
