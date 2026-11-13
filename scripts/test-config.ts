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
import { loadConfig, watchStartupWarning } from "../src/config.js";
import { watchInactiveReason, watchNoSession } from "../src/watch.js";

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

// advisor URL: scheme normalization (bare host:port gains http://; full URLs kept).
delete process.env.MAC_ADVISOR_URL;
delete process.env.MAC_ADVISOR_TOKEN;
const advOff = loadConfig(process.cwd());
check("advisor OFF when no MAC_ADVISOR_URL", advOff.advisor === false, String(advOff.advisor));
process.env.MAC_ADVISOR_URL = "100.75.153.113:8391";
process.env.MAC_ADVISOR_TOKEN = "tok";
const advBare = loadConfig(process.cwd());
check("bare MAC_ADVISOR_URL gains http://", advBare.advisorUrl === "http://100.75.153.113:8391", advBare.advisorUrl);
check("advisor ON with url+token", advBare.advisor === true, String(advBare.advisor));
process.env.MAC_ADVISOR_URL = "https://mac.tail:8391";
const advFull = loadConfig(process.cwd());
check("full MAC_ADVISOR_URL kept", advFull.advisorUrl === "https://mac.tail:8391", advFull.advisorUrl);
process.env.MAC_ADVISOR_URL = "";
const advEmpty = loadConfig(process.cwd());
check("advisor OFF when url empty", advEmpty.advisor === false, String(advEmpty.advisor));
delete process.env.MAC_ADVISOR_URL;
delete process.env.MAC_ADVISOR_TOKEN;

// ADVISOR_* names win over the pre-rename MAC_ADVISOR_* ones (both work).
process.env.ADVISOR_URL = "100.64.0.9:8391";
process.env.ADVISOR_TOKEN = "new-tok";
process.env.MAC_ADVISOR_URL = "100.75.153.113:8391";
process.env.MAC_ADVISOR_TOKEN = "old-tok";
const advNew = loadConfig(process.cwd());
check("ADVISOR_URL wins over MAC_ADVISOR_URL", advNew.advisorUrl === "http://100.64.0.9:8391", advNew.advisorUrl);
check("ADVISOR_TOKEN wins over MAC_ADVISOR_TOKEN", advNew.advisorToken === "new-tok", advNew.advisorToken);
check("default agent is claude", advNew.advisorDefaultAgent === "claude", advNew.advisorDefaultAgent);
process.env.ADVISOR_DEFAULT_AGENT = "Gemini";
check("ADVISOR_DEFAULT_AGENT alias gemini → agy", loadConfig(process.cwd()).advisorDefaultAgent === "agy");
process.env.ADVISOR_DEFAULT_AGENT = "gpt";
check("unknown ADVISOR_DEFAULT_AGENT → claude", loadConfig(process.cwd()).advisorDefaultAgent === "claude");
delete process.env.ADVISOR_DEFAULT_AGENT;
delete process.env.ADVISOR_URL;
delete process.env.ADVISOR_TOKEN;
const advOld = loadConfig(process.cwd());
check("MAC_ADVISOR_* still enables the advisor", advOld.advisor === true && advOld.advisorToken === "old-tok", `${advOld.advisor} ${advOld.advisorToken}`);
delete process.env.MAC_ADVISOR_URL;
delete process.env.MAC_ADVISOR_TOKEN;

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

// --- manager rotation knobs: floor thresholds (K) + intervals (h→ms) --------
// Defaults: auto 110K, confirm 90K, min interval 24h, confirm re-prompt 12h.
// NaN/garbage falls back to the defaults; valid values are respected.
{
  const base = loadConfig(process.cwd());
  check("rotationAutoFloorK default 110", base.rotationAutoFloorK === 110, String(base.rotationAutoFloorK));
  check("rotationConfirmFloorK default 90", base.rotationConfirmFloorK === 90, String(base.rotationConfirmFloorK));
  check("rotationMinIntervalMs default 24h", base.rotationMinIntervalMs === 24 * 3600_000, String(base.rotationMinIntervalMs));
  check("rotationConfirmRepromptMs default 12h", base.rotationConfirmRepromptMs === 12 * 3600_000, String(base.rotationConfirmRepromptMs));

  // valid values respected
  process.env.OPENCODE_TG_ROTATION_AUTO_FLOOR_K = "120";
  process.env.OPENCODE_TG_ROTATION_CONFIRM_FLOOR_K = "100";
  process.env.OPENCODE_TG_ROTATION_MIN_INTERVAL_H = "48";
  process.env.OPENCODE_TG_ROTATION_CONFIRM_REPROMPT_H = "6";
  const good = loadConfig(process.cwd());
  check("rotationAutoFloorK valid respected (120)", good.rotationAutoFloorK === 120, String(good.rotationAutoFloorK));
  check("rotationConfirmFloorK valid respected (100)", good.rotationConfirmFloorK === 100, String(good.rotationConfirmFloorK));
  check("rotationMinIntervalMs valid (48h)", good.rotationMinIntervalMs === 48 * 3600_000, String(good.rotationMinIntervalMs));
  check("rotationConfirmRepromptMs valid (6h)", good.rotationConfirmRepromptMs === 6 * 3600_000, String(good.rotationConfirmRepromptMs));

  // garbage → fallback to defaults (never NaN)
  process.env.OPENCODE_TG_ROTATION_AUTO_FLOOR_K = "abc";
  process.env.OPENCODE_TG_ROTATION_CONFIRM_FLOOR_K = "xyz";
  process.env.OPENCODE_TG_ROTATION_MIN_INTERVAL_H = "nope";
  process.env.OPENCODE_TG_ROTATION_CONFIRM_REPROMPT_H = "??";
  const bad = loadConfig(process.cwd());
  check("rotationAutoFloorK NaN → 110", bad.rotationAutoFloorK === 110, String(bad.rotationAutoFloorK));
  check("rotationConfirmFloorK NaN → 90", bad.rotationConfirmFloorK === 90, String(bad.rotationConfirmFloorK));
  check("rotationMinIntervalMs NaN → 24h", bad.rotationMinIntervalMs === 24 * 3600_000, String(bad.rotationMinIntervalMs));
  check("rotationConfirmRepromptMs NaN → 12h", bad.rotationConfirmRepromptMs === 12 * 3600_000, String(bad.rotationConfirmRepromptMs));
  for (const k of ["OPENCODE_TG_ROTATION_AUTO_FLOOR_K", "OPENCODE_TG_ROTATION_CONFIRM_FLOOR_K", "OPENCODE_TG_ROTATION_MIN_INTERVAL_H", "OPENCODE_TG_ROTATION_CONFIRM_REPROMPT_H"]) delete process.env[k];
}

// busy mode: OPENCODE_TG_BUSY_MODE (ask/queue/off; invalid → ask)
{
  delete process.env.OPENCODE_TG_BUSY_MODE;
  const def = loadConfig(process.cwd());
  check("busyMode default ask", def.busyMode === "ask", String(def.busyMode));
  process.env.OPENCODE_TG_BUSY_MODE = "queue";
  check("busyMode queue respected", loadConfig(process.cwd()).busyMode === "queue");
  process.env.OPENCODE_TG_BUSY_MODE = "off";
  check("busyMode off respected", loadConfig(process.cwd()).busyMode === "off");
  process.env.OPENCODE_TG_BUSY_MODE = "ASK";
  check("busyMode case-insensitive", loadConfig(process.cwd()).busyMode === "ask");
  process.env.OPENCODE_TG_BUSY_MODE = "bogus";
  check("busyMode invalid → ask", loadConfig(process.cwd()).busyMode === "ask");
  delete process.env.OPENCODE_TG_BUSY_MODE;
}

// --- /watch config (W6.1): watchActive truth table + startup warning (W6.7) +
//     inactive / no-session reply wording (W6.8 / W1.2) -----------------------
{
  for (const k of ["OPENCODE_TG_WATCH", "OPENCODE_TG_STREAM", "OPENCODE_TG_WATCH_INTERVAL_MS", "OPENCODE_TG_WATCH_MAX_MIN"]) delete process.env[k];

  // watchActive truth table + the ONE startup warning (W6.7).
  const combos: Array<{ watch: string | undefined; stream: string | undefined; active: boolean; warning: boolean }> = [
    { watch: undefined, stream: undefined, active: true,  warning: false }, // default: watch on, stream off
    { watch: "1",       stream: "1",       active: false, warning: true  }, // watch on + stream on → warning
    { watch: "0",       stream: undefined, active: false, warning: false }, // watch off
    { watch: "0",       stream: "1",       active: false, warning: false }, // watch off (stream on is irrelevant)
  ];
  let warningFires = 0;
  for (const c of combos) {
    if (c.watch === undefined) delete process.env.OPENCODE_TG_WATCH; else process.env.OPENCODE_TG_WATCH = c.watch;
    if (c.stream === undefined) delete process.env.OPENCODE_TG_STREAM; else process.env.OPENCODE_TG_STREAM = c.stream;
    const cfg = loadConfig(process.cwd());
    const tag = `watch=${c.watch ?? "unset"}, stream=${c.stream ?? "unset"}`;
    check(`watchActive (${tag}) = ${c.active}`, cfg.watchActive === c.active, String(cfg.watchActive));
    const w = watchStartupWarning(cfg);
    const fired = w !== null;
    if (fired) warningFires++;
    check(`startup warning (${tag}) fired=${fired} (expect ${c.warning})`, fired === c.warning, w ?? "(none)");
  }
  check("startup warning fires in EXACTLY ONE of the four states", warningFires === 1, String(warningFires));

  // /watch reply wording (W6.8 / W1.2) — pure, no Bot needed. Language-agnostic
  // markers per cause, so the test pins the RIGHT reason for each state.
  check("inactive reason (watch off, vi) names WATCH=0", watchInactiveReason("vi", false, false).includes("OPENCODE_TG_WATCH=0"), watchInactiveReason("vi", false, false));
  check("inactive reason (watch off, en) names WATCH=0", watchInactiveReason("en", false, true).includes("OPENCODE_TG_WATCH=0"), watchInactiveReason("en", false, true));
  check("inactive reason (stream on, vi) names STREAM", watchInactiveReason("vi", true, true).includes("OPENCODE_TG_STREAM"), watchInactiveReason("vi", true, true));
  check("inactive reason (stream on, en) names STREAM", watchInactiveReason("en", true, true).includes("OPENCODE_TG_STREAM"), watchInactiveReason("en", true, true));
  check("no-session (vi) names /new", watchNoSession("vi").includes("/new"), watchNoSession("vi"));
  check("no-session (en) names /new", watchNoSession("en").includes("/new"), watchNoSession("en"));

  // /watch numeric knobs: defaults + NaN / below-min fallback (the accepted
  // range 2000–5000 is enforced by the core's clampWatchInterval, not here).
  delete process.env.OPENCODE_TG_WATCH;
  delete process.env.OPENCODE_TG_STREAM;
  delete process.env.OPENCODE_TG_WATCH_INTERVAL_MS;
  delete process.env.OPENCODE_TG_WATCH_MAX_MIN;
  check("watchIntervalMs default 3000", loadConfig(process.cwd()).watchIntervalMs === 3000, String(loadConfig(process.cwd()).watchIntervalMs));
  check("watchMaxMin default 10", loadConfig(process.cwd()).watchMaxMin === 10, String(loadConfig(process.cwd()).watchMaxMin));
  process.env.OPENCODE_TG_WATCH_INTERVAL_MS = "abc";
  check("watchIntervalMs NaN → default 3000", loadConfig(process.cwd()).watchIntervalMs === 3000);
  process.env.OPENCODE_TG_WATCH_INTERVAL_MS = "1000"; // below min 2000
  check("watchIntervalMs below min → default 3000", loadConfig(process.cwd()).watchIntervalMs === 3000);
  process.env.OPENCODE_TG_WATCH_INTERVAL_MS = "4500";
  process.env.OPENCODE_TG_WATCH_MAX_MIN = "25";
  check("watchIntervalMs valid respected (4500)", loadConfig(process.cwd()).watchIntervalMs === 4500);
  check("watchMaxMin valid respected (25)", loadConfig(process.cwd()).watchMaxMin === 25);
  for (const k of ["OPENCODE_TG_WATCH", "OPENCODE_TG_STREAM", "OPENCODE_TG_WATCH_INTERVAL_MS", "OPENCODE_TG_WATCH_MAX_MIN"]) delete process.env[k];
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
