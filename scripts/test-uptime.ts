/**
 * Unit tests for the PURE parts of the machine uptime monitor + reboot flow
 * (src/uptime.ts): /proc/uptime parsing, the remind/snooze decision, and the
 * human-readable uptime formatting. The I/O (reading /proc/uptime, sending the
 * reminder, firing `sudo -n systemctl reboot`) is NOT unit-tested, per repo
 * convention (pure logic only).
 *
 * Run:  npx tsx scripts/test-uptime.ts
 */
import { parseProcUptime, shouldRemindAboutReboot, formatUptimeHuman, msPerDay, buildTokenLine, REBOOT_TOKEN_TTL_MS } from "../src/uptime.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── parseProcUptime ──────────────────────────────────────────────────────────
check("valid /proc/uptime", parseProcUptime("12345.67 23456.78") === 12345.67, String(parseProcUptime("12345.67 23456.78")));
check("integer seconds", parseProcUptime("9999 19998") === 9999);
check("leading/trailing whitespace", parseProcUptime("  42.5 85  ") === 42.5, String(parseProcUptime("  42.5 85  ")));
check("empty string → undefined", parseProcUptime("") === undefined);
check("non-numeric → undefined", parseProcUptime("garbage 123") === undefined);
check("negative not representable → undefined", parseProcUptime("-5 10") === undefined);

// ── shouldRemindAboutReboot ──────────────────────────────────────────────────
const thresholdMs = msPerDay(30);
const intervalMs = msPerDay(3);
const now = 1_000_000_000_000;
// Below threshold → never remind, regardless of snooze state.
check("below threshold → false", shouldRemindAboutReboot({ uptimeSec: msPerDay(29) / 1000, lastReminderMs: undefined, now, thresholdMs, remindIntervalMs: intervalMs }) === false);
// At/above threshold, never reminded → true.
check("above threshold, never reminded → true", shouldRemindAboutReboot({ uptimeSec: msPerDay(31) / 1000, lastReminderMs: undefined, now, thresholdMs, remindIntervalMs: intervalMs }) === true);
// Above threshold, reminded within the snooze interval → false.
check("above threshold, snoozed recently → false", shouldRemindAboutReboot({ uptimeSec: msPerDay(40) / 1000, lastReminderMs: now - msPerDay(1), now, thresholdMs, remindIntervalMs: intervalMs }) === false);
// Above threshold, last reminder beyond the snooze interval → true.
check("above threshold, snoozed long ago → true", shouldRemindAboutReboot({ uptimeSec: msPerDay(40) / 1000, lastReminderMs: now - msPerDay(4), now, thresholdMs, remindIntervalMs: intervalMs }) === true);
// Boundary: exactly at the threshold (uptime*1000 == thresholdMs) → true.
check("exactly at threshold → true", shouldRemindAboutReboot({ uptimeSec: 30 * 86400, lastReminderMs: undefined, now, thresholdMs, remindIntervalMs: intervalMs }) === true);

// ── formatUptimeHuman ────────────────────────────────────────────────────────
check("days + hours", formatUptimeHuman(43 * 86400 + 2 * 3600) === "43 ngày 2 giờ", formatUptimeHuman(43 * 86400 + 2 * 3600));
check("days only (0 hours)", formatUptimeHuman(5 * 86400) === "5 ngày", formatUptimeHuman(5 * 86400));
check("hours only", formatUptimeHuman(7 * 3600 + 120) === "7 giờ", formatUptimeHuman(7 * 3600 + 120));
check("minutes (floored to ≥1)", formatUptimeHuman(720) === "12 phút", formatUptimeHuman(720));
check("tiny seconds → 1 phút (no '0')", formatUptimeHuman(30) === "1 phút", formatUptimeHuman(30));

// ── token file format (single line, matches the safe-reboot wrapper) ────────
check("buildTokenLine shape", buildTokenLine("abc123", 1000) === "abc123 1000\n", JSON.stringify(buildTokenLine("abc123", 1000)));
check("token TTL is 10s", REBOOT_TOKEN_TTL_MS === 10000, String(REBOOT_TOKEN_TTL_MS));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
