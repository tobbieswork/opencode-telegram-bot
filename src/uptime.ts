/**
 * Pure logic for the machine uptime monitor + reboot reminder.
 *
 * The box runs 24/7 for the bot. Kernel security updates only take effect
 * after a reboot, so we nudge the user to reboot roughly every month. The box
 * allows `sudo -n systemctl reboot` without a password (NOPASSWD entry), so
 * the reminder carries a two-step-confirmed reboot BUTTON instead of just
 * pointing at a terminal.
 *
 * This module is deliberately PURE (no fs/child_process): reading /proc/uptime
 * and firing the reboot live in bot.ts; everything decided here is unit-testable
 * (see scripts/test-uptime.ts).
 */

/** Reboot when uptime passes this many days (kernel updates need a reboot). */
export const DEFAULT_UPTIME_THRESHOLD_DAYS = 30;
/** After a snooze, how long before we nudge again. */
export const DEFAULT_REMIND_INTERVAL_DAYS = 3;
/** Grace period before the actual reboot so the "rebooting…" message gets delivered. */
export const DEFAULT_REBOOT_DELAY_MS = 15_000;
/** Max token age the wrapper accepts (ms). */
export const REBOOT_TOKEN_TTL_MS = 10_000;
/** The wrapper binary (NOPASSWD sudoers permits this, NOT `systemctl reboot`). */
export const SAFE_REBOOT_BIN = "/usr/local/sbin/safe-reboot";
/**
 * One-shot token file, under the bot user's state dir (NOT in the repo): the
 * bot mints a fresh token here milliseconds before firing; the wrapper
 * (running as root) checks arg == file token and age < TTL, then burns it.
 * Kept in sync with TOKEN_FILE in /usr/local/sbin/safe-reboot.
 */
export function rebootTokenFile(homeDir: string): string {
  return `${homeDir}/.local/state/opencode-bot/reboot-token`;
}
/** Token file content: one line "<hex-token> <epoch-ms>" (wrapper parses this). */
export function buildTokenLine(token: string, nowMs: number): string {
  return `${token} ${nowMs}\n`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse `/proc/uptime` — first field is seconds since boot ("12345.67 23456.78").
 * Returns undefined on any problem (unreadable file, non-Linux, non-numeric).
 */
export function parseProcUptime(text: string): number | undefined {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
}

/**
 * Should we (re)send the reboot reminder now?
 *   uptime ≥ threshold AND (never reminded OR last reminder older than the interval)
 */
export function shouldRemindAboutReboot(p: {
  uptimeSec: number;
  lastReminderMs?: number;
  now: number;
  thresholdMs: number;
  remindIntervalMs: number;
}): boolean {
  if (p.uptimeSec * 1000 < p.thresholdMs) return false;
  if (p.lastReminderMs === undefined) return true;
  return p.now - p.lastReminderMs >= p.remindIntervalMs;
}

/** Human-readable uptime, Vietnamese (the bot's language): "43 ngày 2 giờ" / "7 giờ" / "12 phút". */
export function formatUptimeHuman(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  if (days > 0) return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  if (hours > 0) return `${hours} giờ`;
  return `${Math.max(1, Math.floor(sec / 60))} phút`;
}

export const msPerDay = (days: number): number => days * MS_PER_DAY;
