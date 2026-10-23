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

// richReplies is default-OFF; only an explicit "1"/"true" enables it.
delete process.env.OPENCODE_TG_RICH;
check("richReplies unset → false (default off)", loadConfig(process.cwd()).richReplies === false);
process.env.OPENCODE_TG_RICH = "1";
check('richReplies "1" → true', loadConfig(process.cwd()).richReplies === true);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
