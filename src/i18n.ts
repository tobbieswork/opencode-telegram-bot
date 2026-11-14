/**
 * i18n foundation — a minimal translation helper + initial string table.
 *
 * The full i18n table (all UI strings) will be expanded in a follow-up.
 * This file provides:
 *   - the `tr()` helper that picks the right language variant
 *   - an initial set of key strings (worker templates + a few UI strings)
 *
 * Design doc: docs/sdd/language-preference.md
 */
import type { Lang } from "./state.js";

/**
 * Pick the string for the given language.
 * Returns `vi` when lang is "vi" (or unknown), `en` when lang is "en".
 */
export function tr(lang: Lang, vi: string, en: string): string {
  return lang === "en" ? en : vi;
}

/** A "❌ Lỗi: <msg>" / "❌ Error: <msg>" line, localized by lang (the caller escapes msg). */
export function errorText(lang: Lang, msg: string): string {
  return tr(lang, STRINGS.error_prefix.vi, STRINGS.error_prefix.en) + msg;
}

/** A single translatable string pair. */
export interface Str {
  vi: string;
  en: string;
}

/**
 * Initial i18n table — key strings for worker templates and UI.
 * Expand in the follow-up worker.
 */
export const STRINGS = {
  // ── Worker template strings ─────────────────────────────────────────────
  worker_spawned: {
    vi: "🧩 Worker đã được tạo",
    en: "🧩 Worker spawned",
  },
  worker_task: {
    vi: "Nhiệm vụ",
    en: "Task",
  },
  worker_assigned_by: {
    vi: "Giao bởi Manager",
    en: "Assigned by Manager",
  },
  worker_status: {
    vi: "Trạng thái",
    en: "Status",
  },
  worker_message_topic: {
    vi: "Nhắn tin trong topic này để làm việc với worker.",
    en: "Message in this topic to work with the worker.",
  },
  worker_worktree: {
    vi: "worktree riêng, nhánh",
    en: "dedicated worktree, branch",
  },
  approval_assign: {
    vi: "Manager muốn giao việc",
    en: "Manager wants to assign work",
  },
  approval_new_worker: {
    vi: "Worker mới",
    en: "New worker",
  },
  approval_read_only: {
    vi: "chỉ đọc",
    en: "read-only",
  },
  approval_send_to: {
    vi: "Gửi tới worker",
    en: "Send to worker",
  },

  // ── UI strings ──────────────────────────────────────────────────────────
  lang_set_vi: {
    vi: "✅ Ngôn ngữ: Tiếng Việt",
    en: "✅ Language: Vietnamese",
  },
  lang_set_en: {
    vi: "✅ Ngôn ngữ: English",
    en: "✅ Language: English",
  },
  lang_usage: {
    vi: "Dùng: /lang vi hoặc /lang en",
    en: "Usage: /lang vi or /lang en",
  },
  // ── /style (per-user output style) ─────────────────────────────────────────
  style_usage: {
    vi: "Dùng: /style [default|concise|explanatory|learning|proactive]",
    en: "Usage: /style [default|concise|explanatory|learning|proactive]",
  },
  style_current: {
    vi: "🎨 Style hiện tại: ",
    en: "Current style: ",
  },
  style_unknown: {
    vi: "❌ Style không rõ: ",
    en: "❌ Unknown style: ",
  },
  style_default: {
    vi: "• default — mặc định, không áp thêm hướng dẫn nào",
    en: "• default — no extra instruction (stock behavior)",
  },
  style_concise: {
    vi: "• concise — ngắn gọn: kết quả trước, không mở đầu, không tóm tắt cuối",
    en: "• concise — result first, no preamble or closing summary",
  },
  style_explanatory: {
    vi: "• explanatory — kèm khối '★ Insight' giải thích vì sao chọn cách làm đó",
    en: "• explanatory — adds a short '★ Insight' block on the why",
  },
  style_learning: {
    vi: "• learning — giải thích + chừa '// TODO: you' để bạn tự viết",
    en: "• learning — explanatory + '// TODO: you' stubs to fill in",
  },
  style_proactive: {
    vi: "• proactive — chủ động làm ngay, chỉ hỏi khi quyết định quan trọng/mạo hiểm",
    en: "• proactive — acts immediately; only asks on high-risk decisions",
  },
  style_set_default: {
    vi: "✅ Style: mặc định (không áp thêm hướng dẫn)",
    en: "✅ Style: default (no extra instruction)",
  },
  style_set_concise: {
    vi: "✅ Style: concise (ngắn gọn)",
    en: "✅ Style: concise",
  },
  style_set_explanatory: {
    vi: "✅ Style: explanatory (kèm insight)",
    en: "✅ Style: explanatory (with insight)",
  },
  style_set_learning: {
    vi: "✅ Style: learning (kèm TODO cho bạn tự viết)",
    en: "✅ Style: learning (with TODO stubs)",
  },
  style_set_proactive: {
    vi: "✅ Style: proactive (chủ động)",
    en: "✅ Style: proactive",
  },
  unknown_command: {
    vi: "Lệnh không rõ",
    en: "Unknown command",
  },
  send_help: {
    vi: "Gửi /help để xem danh sách lệnh",
    en: "Send /help for the command list",
  },
  error_prefix: {
    vi: "❌ Lỗi: ",
    en: "❌ Error: ",
  },
  working_indicator: {
    vi: "⏳ Đang xử lý…",
    en: "⏳ Working…",
  },
  // "👁 Watch" button on the Working line (shown only while /watch is active)
  // + the two short tap-notes the button answers with.
  working_watch_button: {
    vi: "👁 Theo dõi",
    en: "👁 Watch",
  },
  working_watch_inactive: {
    vi: "👁 Theo dõi đang tắt.",
    en: "👁 Watch is inactive.",
  },
  working_watch_no_session: {
    vi: "Chưa có phiên hiện tại.",
    en: "No current session.",
  },
};
