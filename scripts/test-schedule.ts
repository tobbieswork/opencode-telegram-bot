/**
 * Checks the pure `/schedule` logic: parse (valid + invalid + option-token
 * stripping), nextRunAfter for every kind in Asia/Ho_Chi_Minh and
 * America/New_York across DST transitions (asserting exact epoch values and
 * the `every` wall-clock anchor), and decideRun (on-time / late-in-grace /
 * late-beyond-grace).
 *
 * Run:  npx tsx scripts/test-schedule.ts
 */
import { parseScheduleSpec, nextRunAfter, decideRun, formatSchedule, isUserAllowed } from "../src/schedule.js";
import type { Schedule } from "../src/schedule.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const Z = Date.UTC;
const HICT = "Asia/Ho_Chi_Minh"; // UTC+7, no DST
const NY = "America/New_York";    // DST: 2026 spring 2026-03-08, fall 2026-11-01

// ── parse: the five valid kinds ──────────────────────────────────────────────
{
  const daily = parseScheduleSpec("daily 08:00 check the build");
  check("daily: kind + time", daily.spec.kind === "daily" && daily.spec.time?.h === 8 && daily.spec.time?.m === 0);
  check("daily: prompt is the free text", daily.prompt === "check the build");

  const wd = parseScheduleSpec("weekdays 09:30 standup");
  check("weekdays: kind + time", wd.spec.kind === "weekdays" && wd.spec.time?.h === 9 && wd.spec.time?.m === 30);
  check("weekdays: prompt", wd.prompt === "standup");

  const wk = parseScheduleSpec("weekly mon 10:00 review");
  check("weekly: kind + day(mon=1) + time", wk.spec.kind === "weekly" && wk.spec.day === 1 && wk.spec.time?.h === 10 && wk.spec.time?.m === 0);
  check("weekly: prompt", wk.prompt === "review");

  const ev = parseScheduleSpec("every 6h ping");
  check("every: kind + hours", ev.spec.kind === "every" && ev.spec.hours === 6);
  check("every: prompt", ev.prompt === "ping");

  const once = parseScheduleSpec("once 2026-12-01 08:00 remind me", Z(2026, 9, 1, 0, 0, 0));
  check("once: kind + date + time", once.spec.kind === "once" && once.spec.date?.y === 2026 && once.spec.date?.mo === 12 && once.spec.date?.d === 1 && once.spec.time?.h === 8 && once.spec.time?.m === 0);
  check("once: prompt", once.prompt === "remind me");
}

// ── parse: option tokens stripped so the prompt is clean ─────────────────────
{
  const a = parseScheduleSpec("daily 08:00 dir=/repo agent=plan do the thing");
  check("options: dir=/agent= stripped, prompt clean", a.prompt === "do the thing", a.prompt);
  const b = parseScheduleSpec("weekly tue 09:00 agent=build run lint dir=/w");
  check("options: stripped anywhere in the tail", b.prompt === "run lint", b.prompt);
  check("options: spec still parsed when options present", a.spec.kind === "daily" && a.spec.time?.h === 8);
}

// ── parse: `every` bounds ────────────────────────────────────────────────────
{
  check("every 1h is valid", parseScheduleSpec("every 1h x").spec.hours === 1);
  check("every 168h is valid", parseScheduleSpec("every 168h x").spec.hours === 168);
  check("every 24h is valid", parseScheduleSpec("every 24h x").spec.hours === 24);
}

// ── parse: invalid inputs throw ──────────────────────────────────────────────
{
  check("throws: empty arg", throws(() => parseScheduleSpec("   ")));
  check("throws: unknown kind", throws(() => parseScheduleSpec("hourly 09:00 x")));
  check("throws: missing time (daily)", throws(() => parseScheduleSpec("daily x")));
  check("throws: missing time (weekly)", throws(() => parseScheduleSpec("weekly mon")));
  check("throws: bad hour 25:00", throws(() => parseScheduleSpec("daily 25:00 x")));
  check("throws: bad minute 08:60", throws(() => parseScheduleSpec("daily 08:60 x")));
  check("throws: non-2-digit hour 8:0", throws(() => parseScheduleSpec("daily 8:0 x")));
  check("throws: bad weekday name", throws(() => parseScheduleSpec("weekly foo 09:00 x")));
  check("throws: every < 1h (0h)", throws(() => parseScheduleSpec("every 0h x")));
  check("throws: every > 168h (200h)", throws(() => parseScheduleSpec("every 200h x")));
  check("throws: every non-hour unit (90m)", throws(() => parseScheduleSpec("every 90m x")));
  check("throws: once in the past", throws(() => parseScheduleSpec("once 2020-01-01 08:00 x", Z(2026, 9, 1, 0, 0, 0))));
  check("throws: once non-existent date (Feb 30)", throws(() => parseScheduleSpec("once 2026-02-30 08:00 x", Z(2026, 9, 1, 0, 0, 0))));
  check("throws: once malformed date", throws(() => parseScheduleSpec("once 2026/12/01 08:00 x", Z(2026, 9, 1, 0, 0, 0))));
  // a future once with no reference (nowMs undefined) is not rejected on date alone
  check("no reference time → future once still parses", parseScheduleSpec("once 2026-12-01 08:00 x").spec.kind === "once");
}

// ── nextRunAfter: Asia/Ho_Chi_Minh (UTC+7, no DST) ───────────────────────────
{
  // daily 08:00 → before the slot, fires same day
  check(
    "ICT daily: before slot → same day 08:00",
    nextRunAfter({ kind: "daily", time: { h: 8, m: 0 } }, Z(2026, 10, 1, 0, 0, 0), HICT) === Z(2026, 10, 1, 1, 0, 0),
  );
  // after the slot → next day
  check(
    "ICT daily: after slot → next day",
    nextRunAfter({ kind: "daily", time: { h: 8, m: 0 } }, Z(2026, 10, 1, 2, 0, 0), HICT) === Z(2026, 10, 2, 1, 0, 0),
  );
  // weekdays 09:00: afterMs on a Sunday → Monday
  check(
    "ICT weekdays: Sunday → Monday 09:00",
    nextRunAfter({ kind: "weekdays", time: { h: 9, m: 0 } }, Z(2026, 10, 1, 0, 0, 0), HICT) === Z(2026, 10, 2, 2, 0, 0),
  );
  // weekly Monday 10:00
  check(
    "ICT weekly: → Monday 10:00",
    nextRunAfter({ kind: "weekly", day: 1, time: { h: 10, m: 0 } }, Z(2026, 10, 1, 0, 0, 0), HICT) === Z(2026, 10, 2, 3, 0, 0),
  );
  // every 6h: created 14:30 local → fires 18:00 the SAME day (the anchor)
  check(
    "ICT every 6h: created 14:30 → 18:00 same day (NOT 20:30)",
    nextRunAfter({ kind: "every", hours: 6 }, Z(2026, 10, 1, 7, 30, 0), HICT) === Z(2026, 10, 1, 11, 0, 0),
  );
  // every 6h: past 18:00 → next day 00:00
  check(
    "ICT every 6h: after last slot → next day 00:00",
    nextRunAfter({ kind: "every", hours: 6 }, Z(2026, 10, 1, 11, 30, 0), HICT) === Z(2026, 10, 1, 17, 0, 0),
  );
  // every 5h (N does not divide 24): slots 00/05/10/15/20; after 21:00 → next day 00:00
  check(
    "ICT every 5h: fixed wall-clock slots, after 21:00 → next day 00:00",
    nextRunAfter({ kind: "every", hours: 5 }, Z(2026, 10, 1, 14, 0, 0), HICT) === Z(2026, 10, 1, 17, 0, 0),
  );
  // once
  check(
    "ICT once: fixed instant",
    nextRunAfter({ kind: "once", date: { y: 2026, mo: 12, d: 1 }, time: { h: 8, m: 0 } }, Z(2026, 10, 1, 0, 0, 0), HICT) === Z(2026, 11, 1, 1, 0, 0),
  );
}

// ── nextRunAfter: America/New_York (DST) ─────────────────────────────────────
{
  // daily 08:00 across the FALL transition (2026-11-01, 02:00 EDT → 01:00 EST)
  check(
    "NY daily: across DST end → 08:00 EST = 13:00 UTC",
    nextRunAfter({ kind: "daily", time: { h: 8, m: 0 } }, Z(2026, 9, 31, 16, 0, 0), NY) === Z(2026, 10, 1, 13, 0, 0),
  );
  // daily 08:00, afterMs exactly AT the 08:00 slot → strictly after → next day
  check(
    "NY daily: afterMs == slot → strictly after, next day",
    nextRunAfter({ kind: "daily", time: { h: 8, m: 0 } }, Z(2026, 9, 30, 12, 0, 0), NY) === Z(2026, 9, 31, 12, 0, 0),
  );
  // weekly Sunday 03:00 across the SPRING transition (2026-03-08, 02:00 → 03:00); 03:00 EDT is valid
  check(
    "NY weekly Sun: across spring forward → 03:00 EDT = 07:00 UTC",
    nextRunAfter({ kind: "weekly", day: 0, time: { h: 3, m: 0 } }, Z(2026, 2, 1, 12, 0, 0), NY) === Z(2026, 2, 8, 7, 0, 0),
  );
  // daily 02:30 in the spring-forward GAP (02:30 does not exist) → mapped forward to 03:30 EDT
  check(
    "NY daily: target in spring gap → maps to post-gap 03:30 EDT",
    nextRunAfter({ kind: "daily", time: { h: 2, m: 30 } }, Z(2026, 2, 7, 17, 0, 0), NY) === Z(2026, 2, 8, 7, 30, 0),
  );
  // every 6h across the FALL transition: wall-clock anchor holds (00/06/12/18 local)
  check(
    "NY every 6h: across DST end, still fires at local 06:00 = 11:00 UTC",
    nextRunAfter({ kind: "every", hours: 6 }, Z(2026, 10, 1, 5, 0, 0), NY) === Z(2026, 10, 1, 11, 0, 0),
  );
  // once across the FALL transition
  check(
    "NY once: 2026-11-01 08:00 (post-transition) = 13:00 UTC",
    nextRunAfter({ kind: "once", date: { y: 2026, mo: 11, d: 1 }, time: { h: 8, m: 0 } }, Z(2026, 10, 1, 0, 0, 0), NY) === Z(2026, 10, 1, 13, 0, 0),
  );
}

// ── decideRun: on-time / late-in-grace / late-beyond-grace ───────────────────
{
  const grace = 60 * 60 * 1000; // 1h
  check("decideRun: now == next → run", decideRun(1_000, 1_000, grace) === "run");
  check("decideRun: now < next → run", decideRun(1_000, 500, grace) === "run");
  check("decideRun: just late (within grace) → catchup", decideRun(1_000, 1_000 + 1, grace) === "catchup");
  check("decideRun: late exactly at grace → catchup (boundary)", decideRun(1_000, 1_000 + grace, grace) === "catchup");
  check("decideRun: late beyond grace → skip", decideRun(1_000, 1_000 + grace + 1, grace) === "skip");
  check("decideRun: far in the future → run", decideRun(1_000, 0, grace) === "run");
}

// ── formatSchedule: one short human line ─────────────────────────────────────
{
  const base = { conv: "1:1", tz: "Asia/Ho_Chi_Minh", dir: ".", agent: "plan", nextRunAt: 0, enabled: true, createdBy: 1, createdAt: 0 };
  check("format: daily", formatSchedule({ ...base, id: "a1b2", prompt: "", spec: { kind: "daily", time: { h: 8, m: 0 } } as Schedule["spec"] }) === "daily 08:00 · #a1b2");
  check("format: weekly", formatSchedule({ ...base, id: "zz99", prompt: "", spec: { kind: "weekly", day: 1, time: { h: 9, m: 30 } } as Schedule["spec"] }) === "weekly mon 09:30 · #zz99");
  check("format: every", formatSchedule({ ...base, id: "k001", prompt: "", spec: { kind: "every", hours: 6 } as Schedule["spec"] }) === "every 6h · #k001");
  check("format: once", formatSchedule({ ...base, id: "w4", prompt: "", spec: { kind: "once", date: { y: 2026, mo: 12, d: 1 }, time: { h: 8, m: 0 } } as Schedule["spec"] }) === "once 2026-12-01 08:00 · #w4");
  check("format: weekdays", formatSchedule({ ...base, id: "w5", prompt: "", spec: { kind: "weekdays", time: { h: 9, m: 0 } } as Schedule["spec"] }) === "weekdays 09:00 · #w5");
}

// ── isUserAllowed: allowAny + allow-list (regression: silent schedule skip) ─
{
  check("allowed: in list → true", isUserAllowed({ allowAny: false, allowedUserIds: [1] }, 1));
  check("allowed: not in list → false", !isUserAllowed({ allowAny: false, allowedUserIds: [1] }, 2));
  check("allowed: allowAny + empty list → true (regression)", isUserAllowed({ allowAny: true, allowedUserIds: [] }, 999));
  check("allowed: neither allowAny nor list → false", !isUserAllowed({ allowAny: false, allowedUserIds: [] }, 999));
  check("allowed: uid undefined → false", !isUserAllowed({ allowAny: false, allowedUserIds: [1] }, undefined));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
