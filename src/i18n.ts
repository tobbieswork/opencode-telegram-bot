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
