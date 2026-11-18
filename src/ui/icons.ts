/**
 * Shared UI icons — the single source of truth for every icon the bot shows
 * (spec: docs/sdd/message-layer.md, M1.1).
 *
 * ICON is the per-worker status table, moved here from format.ts, which
 * re-exports it until the call sites move to this module.
 */
import type { WorkerStatus } from "../state.js";

/** Worker status → icon. */
export const ICON: Record<WorkerStatus, string> = {
  idle: "💤",
  running: "🟢",
  waiting: "🟡",
  done: "✅",
  failed: "❌",
  stopped: "⏹",
};

/** Shared UI icons (M1.1). */
export const UI_ICON = {
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
  running: "⏳",
  waiting: "⏸",
  stopped: "⏹",
  back: "↩️",
  close: "❌",
  confirm: "✅",
} as const;
