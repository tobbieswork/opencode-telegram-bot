/**
 * Checks that numeric env settings fall back to safe defaults when unset or
 * non-numeric. The regression this guards: a value like OPENCODE_TG_REMIND_MAX=abc
 * used to become NaN, making the reminder backoff fire every ~1ms (infinite
 * spam). Now parseIntSetting/parseFloatSetting fall back to the default.
 *
 * Runs loadConfig() with controlled env (only the reminder knobs are asserted).
 *
 * Run:  npx tsx scripts/test-config.ts
 */
import { loadConfig } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// loadConfig() requires a bot token + allowed users; provide dummies.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";

// non-numeric values must fall back to defaults (never NaN).
process.env.OPENCODE_TG_REMIND_MAX = "abc";
process.env.OPENCODE_TG_REMIND_BASE_MS = "not-a-number";
process.env.OPENCODE_TG_REMIND_FACTOR = "xyz";
const bad = loadConfig(process.cwd());
check("remindMax NaN → default 4", bad.remindMax === 4, String(bad.remindMax));
check("remindBaseMs NaN → default 300000", bad.remindBaseMs === 300_000, String(bad.remindBaseMs));
check("remindFactor NaN → default 2", bad.remindFactor === 2, String(bad.remindFactor));
check("remindBaseMs is finite", Number.isFinite(bad.remindBaseMs), String(bad.remindBaseMs));
check("remindFactor is finite", Number.isFinite(bad.remindFactor), String(bad.remindFactor));

// empty values fall back to defaults too.
delete process.env.OPENCODE_TG_REMIND_MAX;
delete process.env.OPENCODE_TG_REMIND_BASE_MS;
delete process.env.OPENCODE_TG_REMIND_FACTOR;
const empty = loadConfig(process.cwd());
check("remindMax empty → default 4", empty.remindMax === 4, String(empty.remindMax));
check("remindBaseMs empty → default 300000", empty.remindBaseMs === 300_000, String(empty.remindBaseMs));

// valid values are respected.
process.env.OPENCODE_TG_REMIND_MAX = "6";
process.env.OPENCODE_TG_REMIND_BASE_MS = "300000";
process.env.OPENCODE_TG_REMIND_FACTOR = "3";
const good = loadConfig(process.cwd());
check("remindMax valid respected (6)", good.remindMax === 6, String(good.remindMax));
check("remindFactor valid respected (3)", good.remindFactor === 3, String(good.remindFactor));

// uptime/reboot knobs: monitor defaults ON (off only on explicit "0"), numeric
// knobs fall back to safe defaults on NaN, valid values are respected.
check("uptimeMonitor default ON", good.uptimeMonitor === true, String(good.uptimeMonitor));
check("uptimeThresholdDays default 30", good.uptimeThresholdDays === 30, String(good.uptimeThresholdDays));
check("uptimeRemindIntervalDays default 3", good.uptimeRemindIntervalDays === 3, String(good.uptimeRemindIntervalDays));
check("rebootDelayMs default 15000", good.rebootDelayMs === 15000, String(good.rebootDelayMs));

process.env.OPENCODE_TG_UPTIME_MONITOR = "0";
const monitorOff = loadConfig(process.cwd());
check("uptimeMonitor OFF on =0", monitorOff.uptimeMonitor === false, String(monitorOff.uptimeMonitor));

process.env.OPENCODE_TG_UPTIME_MONITOR = "1";
process.env.OPENCODE_TG_UPTIME_THRESHOLD_DAYS = "45";
process.env.OPENCODE_TG_UPTIME_REMIND_INTERVAL_DAYS = "7";
process.env.OPENCODE_TG_REBOOT_DELAY_MS = "30000";
const custom = loadConfig(process.cwd());
check("uptimeThresholdDays valid respected (45)", custom.uptimeThresholdDays === 45, String(custom.uptimeThresholdDays));
check("uptimeRemindIntervalDays valid respected (7)", custom.uptimeRemindIntervalDays === 7, String(custom.uptimeRemindIntervalDays));
check("rebootDelayMs valid respected (30000)", custom.rebootDelayMs === 30000, String(custom.rebootDelayMs));

process.env.OPENCODE_TG_UPTIME_THRESHOLD_DAYS = "abc";
process.env.OPENCODE_TG_REBOOT_DELAY_MS = "100"; // below min 1000
const uptimeBad = loadConfig(process.cwd());
check("uptimeThresholdDays NaN → default 30", uptimeBad.uptimeThresholdDays === 30, String(uptimeBad.uptimeThresholdDays));
check("rebootDelayMs below min → default 15000", uptimeBad.rebootDelayMs === 15000, String(uptimeBad.rebootDelayMs));
// recoverOverflow defaults OFF (auto-spend + unattended write agent); ON only on an explicit "1"/"true".
check("recoverOverflow default OFF", empty.recoverOverflow === false, String(empty.recoverOverflow));
process.env.OPENCODE_TG_RECOVER_OVERFLOW = "1";
check("recoverOverflow ON on =1", loadConfig(process.cwd()).recoverOverflow === true);
process.env.OPENCODE_TG_RECOVER_OVERFLOW = "0";
const off = loadConfig(process.cwd());
check("recoverOverflow OFF on =0", off.recoverOverflow === false, String(off.recoverOverflow));
delete process.env.OPENCODE_TG_RECOVER_OVERFLOW;
// richReplies is default-OFF; only an explicit "1"/"true" enables it.
delete process.env.OPENCODE_TG_RICH;
check("richReplies unset → false (default off)", loadConfig(process.cwd()).richReplies === false);
process.env.OPENCODE_TG_RICH = "1";
check('richReplies "1" → true', loadConfig(process.cwd()).richReplies === true);

// --- /schedule knobs: master switch, timezone, cap, grace/timeout -----------
// Default ON (off only on an explicit "0"), caps/grace/timeout fall back to
// safe defaults on NaN, valid values are respected, a bad timezone falls back
// (never lets an invalid tz through to nextRunAfter).
delete process.env.OPENCODE_TG_RICH;
check("schedule default ON", loadConfig(process.cwd()).schedule === true);
process.env.OPENCODE_TG_SCHEDULE = "0";
check("schedule OFF on =0", loadConfig(process.cwd()).schedule === false);
delete process.env.OPENCODE_TG_SCHEDULE;

const schedBase = loadConfig(process.cwd());
check("maxSchedules default 10", schedBase.maxSchedules === 10, String(schedBase.maxSchedules));
check("scheduleGraceMs default 60min", schedBase.scheduleGraceMs === 60 * 60_000, String(schedBase.scheduleGraceMs));
check("scheduleTimeoutMs default 30min", schedBase.scheduleTimeoutMs === 30 * 60_000, String(schedBase.scheduleTimeoutMs));
check("scheduleTz default is a non-empty IANA string", typeof schedBase.scheduleTz === "string" && schedBase.scheduleTz.length > 0, String(schedBase.scheduleTz));

// valid values are respected.
process.env.OPENCODE_TG_MAX_SCHEDULES = "7";
process.env.OPENCODE_TG_SCHEDULE_GRACE_MIN = "5";
process.env.OPENCODE_TG_SCHEDULE_TIMEOUT_MIN = "15";
process.env.OPENCODE_TG_TIMEZONE = "America/New_York";
const schedGood = loadConfig(process.cwd());
check("maxSchedules valid respected (7)", schedGood.maxSchedules === 7, String(schedGood.maxSchedules));
check("scheduleGraceMs valid respected (5min)", schedGood.scheduleGraceMs === 5 * 60_000, String(schedGood.scheduleGraceMs));
check("scheduleTimeoutMs valid respected (15min)", schedGood.scheduleTimeoutMs === 15 * 60_000, String(schedGood.scheduleTimeoutMs));
check("scheduleTz valid respected", schedGood.scheduleTz === "America/New_York", String(schedGood.scheduleTz));

// garbage values → fallback + no crash.
process.env.OPENCODE_TG_MAX_SCHEDULES = "abc";
process.env.OPENCODE_TG_SCHEDULE_GRACE_MIN = "xyz";
process.env.OPENCODE_TG_SCHEDULE_TIMEOUT_MIN = "nope";
process.env.OPENCODE_TG_TIMEZONE = "Not/AZone";
const schedBad = loadConfig(process.cwd());
check("maxSchedules NaN → default 10", schedBad.maxSchedules === 10, String(schedBad.maxSchedules));
check("scheduleGraceMs NaN → default 60min", schedBad.scheduleGraceMs === 60 * 60_000, String(schedBad.scheduleGraceMs));
check("scheduleTimeoutMs NaN → default 30min", schedBad.scheduleTimeoutMs === 30 * 60_000, String(schedBad.scheduleTimeoutMs));
check("scheduleTz invalid → fallback (not the garbage)", schedBad.scheduleTz.length > 0 && schedBad.scheduleTz !== "Not/AZone", String(schedBad.scheduleTz));
delete process.env.OPENCODE_TG_TIMEZONE;

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
