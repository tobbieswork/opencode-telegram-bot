/**
 * Checks the pending-prompt reminder backoff math: it must be EXPONENTIAL
 * (each gap = previous gap * factor), never a fixed interval, and the budget
 * must cap the nudges at `max` reminders. The prompt itself stays pending
 * throughout — we only decide WHEN to nudge.
 *
 * Run:  npx tsx scripts/test-reminders.ts
 */
import { rm } from "node:fs/promises";
import {
  firstReminderAt,
  nextReminderDelay,
  reminderBudgetExhausted,
  nextScheduleAfterReminder,
  stalePromptIds,
  clampTimerDelay,
  MAX_TIMER_MS,
} from "../src/reminders.js";
import { StateManager } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const MIN = 60_000;

// ── nextReminderDelay: base * factor^sent, strictly growing ─────────────────
{
  check("sent=0 → base", nextReminderDelay(5 * MIN, 2, 0) === 5 * MIN);
  check("sent=1 → base*factor", nextReminderDelay(5 * MIN, 2, 1) === 10 * MIN);
  check("sent=2 → base*factor^2", nextReminderDelay(5 * MIN, 2, 2) === 20 * MIN);
  check("sent=3 → base*factor^3", nextReminderDelay(5 * MIN, 2, 3) === 40 * MIN);

  const g0 = nextReminderDelay(5 * MIN, 2, 0);
  const g1 = nextReminderDelay(5 * MIN, 2, 1);
  const g2 = nextReminderDelay(5 * MIN, 2, 2);
  check("gap grows each time (NOT a fixed interval)", g1 > g0 && g2 > g1);
  check("each gap = previous * factor", g1 === g0 * 2 && g2 === g1 * 2);
  check("works with factor=3", nextReminderDelay(2 * MIN, 3, 2) === 18 * MIN);
}

// ── firstReminderAt: now + base ─────────────────────────────────────────────
{
  check("first reminder at now + base", firstReminderAt(5 * MIN, 1_000_000) === 1_000_000 + 5 * MIN);
}

// ── reminderBudgetExhausted: stops exactly at max ───────────────────────────
{
  check("not exhausted before max", !reminderBudgetExhausted(0, 4) && !reminderBudgetExhausted(3, 4));
  check("exhausted exactly at max", reminderBudgetExhausted(4, 4));
  check("exhausted past max", reminderBudgetExhausted(5, 4));
}

// ── full default schedule: base=5min, factor=2, max=4 → gaps 5,10,20,40 min ─
{
  const base = 5 * MIN,
    factor = 2,
    max = 4;
  const gaps: number[] = [];
  for (let sent = 0; sent < max; sent++) gaps.push(nextReminderDelay(base, factor, sent));
  check("schedule has exactly `max` reminders", gaps.length === max);
  check(
    "default gaps are 5,10,20,40 min",
    JSON.stringify(gaps.map((g) => g / MIN)) === JSON.stringify([5, 10, 20, 40]),
    JSON.stringify(gaps.map((g) => g / MIN)),
  );
}

// ── nextScheduleAfterReminder: a fired reminder must NOT advance a prompt that
//    was cancelled/answered/overwritten while the send was in flight (the race) ──
{
  const captured = { firstShownAt: 1_000, remindersSent: 0 };
  const ok = nextScheduleAfterReminder(captured, { firstShownAt: 1_000, remindersSent: 0 }, 5 * MIN, 2, 1_000_000);
  check("race: same prompt → advance", !!ok);
  check("race: advance uses captured sent+1", ok?.remindersSent === 1);
  check("race: prompt gone (cancelled) → no advance", nextScheduleAfterReminder(captured, undefined, 5 * MIN, 2, 1_000_000) === undefined);
  check(
    "race: prompt replaced (firstShownAt changed) → no advance",
    nextScheduleAfterReminder(captured, { firstShownAt: 999_999, remindersSent: 0 }, 5 * MIN, 2, 1_000_000) === undefined,
  );
}

// ── setTimeout overflow: an env-tuned backoff must never exceed 2^31-1 ms ────
{
  // OPENCODE_TG_REMIND_MAX=20 → 5min * 2^19 ≈ 99 days would overflow and fire at once.
  check("overflow: 99-day gap is clamped", nextReminderDelay(5 * MIN, 2, 19) === MAX_TIMER_MS);
  check("overflow: huge base is clamped", firstReminderAt(1e12, 1_000) === 1_000 + MAX_TIMER_MS);
  check("overflow: small delay untouched", clampTimerDelay(5 * MIN) === 5 * MIN);
}

// ── stalePromptIds: restart pruning (unknown != gone) ───────────────────────
{
  const pending = { f1: { kind: "form" as const }, f2: { kind: "form" as const }, p1: { kind: "permission" as const } };
  const sorted = (a: string[]) => [...a].sort().join(",");
  check("stale: ids OpenCode no longer lists are stale", sorted(stalePromptIds(pending, { form: new Set(["f1"]), permission: new Set(["p1"]) })) === "f2");
  check("stale: empty live sets → all stale", sorted(stalePromptIds(pending, { form: new Set(), permission: new Set() })) === "f1,f2,p1");
  check("stale: failed form listing (undefined) → forms kept", sorted(stalePromptIds(pending, { permission: new Set() })) === "p1");
  check("stale: both listings failed → nothing pruned", stalePromptIds(pending, {}).length === 0);
  check("stale: no pending prompts → nothing", stalePromptIds(undefined, { form: new Set() }).length === 0);
}

// ── restart: pending prompts persist (id-keyed) and survive a reload ─────────
{
  const file = `/tmp/oc-reminders-persist-${Date.now()}.json`;
  try {
    const st = new StateManager(file);
    st.set("123:7", { pendingPrompts: { "form-1": { kind: "form", text: "q?", firstShownAt: 1, remindersSent: 0, nextReminderAt: 2 } } });
    // A permission added for the SAME conv must coexist (keyed by id, not one slot).
    const cur = st.get("123:7").pendingPrompts!;
    st.set("123:7", { pendingPrompts: { ...cur, "perm-2": { kind: "permission", text: "p?", firstShownAt: 1, remindersSent: 1, nextReminderAt: 2 } } });
    // Reload from disk (simulates a bot restart).
    const pp = new StateManager(file).get("123:7").pendingPrompts;
    check("restart: form schedule persisted", pp?.["form-1"]?.kind === "form" && pp?.["form-1"]?.remindersSent === 0);
    check("restart: permission schedule persisted (coexists by id)", pp?.["perm-2"]?.kind === "permission" && pp?.["perm-2"]?.remindersSent === 1);
    check("restart: both prompts survive reload", Object.keys(pp ?? {}).length === 2);
  } finally {
    await rm(file, { force: true });
  }
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
