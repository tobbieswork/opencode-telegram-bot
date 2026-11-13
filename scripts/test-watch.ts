/**
 * Unit tests for the pure /watch card state machine (src/watch.ts):
 *   - clampWatchInterval: accepted range 2000-5000 (W2.1) + group floor 5000 (W2.3).
 *   - formatElapsed: seconds / minutes.
 *   - createWatch: idle vs working seed, lastRendered seeded for change detection.
 *   - renderWatch: W1.3 layout (state, elapsed, tool label, 200-char prompt,
 *     ~1200-char escaped tail), W1.4 idle card exactly like /history, final
 *     cards show outcome + duration but never the answer, both languages.
 *   - escaping: < > & are escaped; the card stays under 4,096 chars even for
 *     pathological input, with no dangling entities.
 *   - W2.1 throttle (boundary: exactly the interval re-emits), W2.2 change
 *     detection (identical render → no edit), W2.4 flood backoff (double up to
 *     10 s, honor retry_after, reset on success).
 *   - W3.1 final states: done/failed/stopped emit one un-throttled final edit
 *     and freeze (no unfreeze on later events).
 *
 * I/O paths (the actual editMessageTextStrict calls) are NOT unit-tested, per
 * repo convention (pure logic only).
 *
 * Run:  npx tsx scripts/test-watch.ts
 */
import {
  type WatchState,
  createWatch,
  onWatchEvent,
  renderWatch,
  onEditSucceeded,
  onEditFailedFlood,
  clampWatchInterval,
  formatElapsed,
  WATCH_CARD_LIMIT,
} from "../src/watch.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// A realistic wall-clock ms value, so `now - 0 >= intervalMs` is trivially true.
const WALL = 1_700_000_000_000;
const IV = 3000; // the default watch interval

/** A working watch whose turn started 1m 23s before `now` (override via extra). */
function workingState(now: number, extra?: Partial<WatchState>): WatchState {
  const s = createWatch({
    sessionID: "ses_test",
    lang: "en",
    now,
    intervalMs: IV,
    turn: { startedAt: now - 83_000 },
  });
  return extra ? { ...s, ...extra } : s;
}

// ── W1.3: the working card's lines ───────────────────────────────────────────
check("render: working header has state + elapsed (en)", renderWatch(workingState(WALL), "en", WALL) === "<b>⏳ Working · 1m 23s</b>");
check("render: working header vi", renderWatch(workingState(WALL), "vi", WALL) === "<b>⏳ Đang chạy · 1m 23s</b>");
// Tool step: the same (escaped) label as the activity line.
const toolRender = renderWatch(workingState(WALL, { toolLabel: "📖 Reading <b>src/bot.ts</b>" }), "en", WALL);
check("render: tool label shown escaped", toolRender.includes("📖 Reading &lt;b&gt;src/bot.ts&lt;/b&gt;"));
check("render: no raw HTML from the tool label", !toolRender.includes("Reading <b>"));
// Last user prompt: cut at 200, tags stripped.
const promptRender = renderWatch(workingState(WALL, { lastPrompt: "§7§ " + "x".repeat(250) }), "en", WALL);
check("render: prompt cut at 200 chars + ellipsis", promptRender.includes("👤 " + "x".repeat(200) + "…") && !promptRender.includes("x".repeat(201)));
check("render: prompt tags stripped", !promptRender.includes("§7§"));
check("render: short prompt as-is", renderWatch(workingState(WALL, { lastPrompt: "hi" }), "en", WALL).includes("👤 hi"));
// Assistant tail: ~last 1,200 chars, with an ellipsis when cut.
const tailRender = renderWatch(workingState(WALL, { text: "A".repeat(100) + "B".repeat(4000) }), "en", WALL);
check("render: tail is the LAST 1200 chars", tailRender.endsWith("B".repeat(1200)));
check("render: cut tail carries a leading ellipsis", tailRender.includes("…"));
check("render: short text has no ellipsis", !renderWatch(workingState(WALL, { text: "hi" }), "en", WALL).includes("…"));

// ── createWatch: idle (W1.4, exactly like /history) ─────────────────────────
const idle = createWatch({
  sessionID: "ses_test",
  lang: "en",
  now: WALL,
  intervalMs: IV,
  history: [
    { type: "user", text: "fix the bug" },
    { type: "assistant", text: "on it" },
    { type: "shell", text: "whatever" },
  ],
});
check("createWatch: idle phase", idle.phase === "idle");
check("createWatch: idle render marks idle", renderWatch(idle, "en", WALL).includes("💤 Idle"));
check("createWatch: idle render has /history header", renderWatch(idle, "en", WALL).includes("<b>Recent messages</b>"));
check("createWatch: idle user line like /history", renderWatch(idle, "en", WALL).includes("👤 fix the bug"));
check("createWatch: idle assistant line like /history", renderWatch(idle, "en", WALL).includes("🤖 on it"));
check("createWatch: idle unknown type line like /history", renderWatch(idle, "en", WALL).includes("· shell"));
check("createWatch: idle vi labels", renderWatch(idle, "vi", WALL).includes("Đang nghỉ") && renderWatch(idle, "vi", WALL).includes("Tin nhắn gần đây"));
check("createWatch: lastRendered seeded to the initial render", idle.lastRendered === renderWatch(idle, "en", WALL));

// ── clampWatchInterval (W2.1 range, W2.3 group floor) ────────────────────────
check("clamp: 3000 1:1 → 3000", clampWatchInterval(3000, false) === 3000);
check("clamp: 1000 → floored to 2000", clampWatchInterval(1000, false) === 2000);
check("clamp: 9999 → capped at 5000", clampWatchInterval(9999, false) === 5000);
check("clamp: group 3000 → floored to 5000", clampWatchInterval(3000, true) === 5000);
check("clamp: group 2500 → 5000", clampWatchInterval(2500, true) === 5000);
check("clamp: group 9999 → 5000 (cap then floor agree)", clampWatchInterval(9999, true) === 5000);

// ── formatElapsed ─────────────────────────────────────────────────────────────
check("elapsed: 0 → 0s", formatElapsed(0) === "0s");
check("elapsed: negative → 0s", formatElapsed(-500) === "0s");
check("elapsed: 59.9s → 59s", formatElapsed(59_999) === "59s");
check("elapsed: 60s → 1m 0s", formatElapsed(60_000) === "1m 0s");
check("elapsed: 83s → 1m 23s", formatElapsed(83_000) === "1m 23s");
check("elapsed: 659s → 10m 59s", formatElapsed(659_000) === "10m 59s");

// ── escaping + the 4,096-char limit (pathological input) ─────────────────────
const noDanglingEntity = (line: string): boolean => !/&(?!(amp;|lt;|gt;))/.test(line);
const hostile = workingState(WALL, {
  text: "<>&".repeat(7_000),
  lastPrompt: "<".repeat(200),
  toolLabel: "<".repeat(100),
});
const hostileRender = renderWatch(hostile, "en", WALL);
check("limit: hostile working card stays under 4096", hostileRender.length < WATCH_CARD_LIMIT, `len=${hostileRender.length}`);
check("limit: no dangling entity in the tail", noDanglingEntity(hostileRender.split("\n").pop()!));
check("limit: only the header is HTML", (hostileRender.match(/<b>/g) ?? []).length === 1);
check("limit: all three chars escaped", hostileRender.includes("&amp;") && hostileRender.includes("&lt;") && hostileRender.includes("&gt;"));
const hostileIdle = createWatch({
  sessionID: "ses_test",
  lang: "en",
  now: WALL,
  intervalMs: IV,
  history: Array.from({ length: 6 }, () => ({ type: "user", text: "<".repeat(300) })),
});
const hostileIdleRender = renderWatch(hostileIdle, "en", WALL);
check("limit: hostile idle card stays under 4096", hostileIdleRender.length < WATCH_CARD_LIMIT, `len=${hostileIdleRender.length}`);
check("limit: hostile idle keeps the idle header", hostileIdleRender.startsWith("<b>💤 Idle</b>"));
// A range of prompt lengths, to be sure the tail cut never dangles an entity.
let allFit = true;
for (let n = 0; n < 40; n++) {
  const r = renderWatch(workingState(WALL, { text: "<".repeat(20_000), lastPrompt: "y".repeat(n) }), "en", WALL);
  if (r.length >= WATCH_CARD_LIMIT || !noDanglingEntity(r.split("\n").pop()!)) allFit = false;
}
check("limit: tail cut is entity-safe across prompt lengths", allFit);

// ── W2.1: the interval throttle ──────────────────────────────────────────────
let s = workingState(WALL); // lastEditedAt = 0 → the first event emits immediately
let r = onWatchEvent(s, { kind: "text-delta", now: WALL, text: "a" });
check("throttle: first event emits immediately", r.edit !== undefined && r.edit.reason === "update");
check("throttle: emit stamps lastEditedAt", r.state.lastEditedAt === WALL);
r = onWatchEvent(r.state, { kind: "text-delta", now: WALL + 1000, text: "b" });
check("throttle: +1000ms → no edit", r.edit === undefined);
check("throttle: throttled event still accumulates text", r.state.text === "ab");
r = onWatchEvent(r.state, { kind: "text-delta", now: WALL + 2999, text: "c" });
check("throttle: +2999ms (just under) → no edit", r.edit === undefined);
r = onWatchEvent(r.state, { kind: "text-delta", now: WALL + 3000, text: "d" });
check("throttle: exactly the interval → edit", r.edit !== undefined);

// ── W2.2: edit only when the rendered text changed ──────────────────────────
{
  const base = workingState(WALL); // lastRendered seeded at WALL
  const armed = { ...base, lastEditedAt: WALL - IV }; // throttle passes at WALL
  const rSame = onWatchEvent(armed, { kind: "tool-step", now: WALL, label: "" }); // label was already ""
  check("change: identical render → no edit", rSame.edit === undefined);
  const rDiff = onWatchEvent(armed, { kind: "tool-step", now: WALL, label: "📖 Reading x" });
  check("change: different render → edit", rDiff.edit !== undefined);
  check("change: the edit carries the new render", rDiff.edit?.text === renderWatch(rDiff.state, "en", WALL));
}
// Idle no-ops: events that cannot change the card never emit.
{
  const i = createWatch({ sessionID: "s", lang: "en", now: WALL, intervalMs: IV, history: [{ type: "user", text: "hi" }] });
  const a = onWatchEvent(i, { kind: "tool-step", now: WALL + 10_000, label: "x" });
  const b = onWatchEvent(a.state, { kind: "text-delta", now: WALL + 20_000, text: "y" });
  check("change: tool-step while idle → no edit, state untouched", a.edit === undefined && JSON.stringify(a.state) === JSON.stringify(i));
  check("change: text-delta while idle → no edit, state untouched", b.edit === undefined && JSON.stringify(b.state) === JSON.stringify(i));
}

// ── W2.4: flood-control backoff (double up to 10 s, honor retry_after) ──────
{
  const s0 = { ...workingState(WALL), lastEditedAt: WALL, intervalMs: IV, baseIntervalMs: IV };
  const s1 = onEditFailedFlood(s0, 2, WALL);
  check("backoff: interval doubles 3000 → 6000", s1.intervalMs === 6000);
  check("backoff: retry_after honored as floor", s1.earliestEditAt === WALL + 2000);
  check("backoff: failed edit does not stamp lastRendered", s1.lastRendered === s0.lastRendered);
  const rEarly = onWatchEvent(s1, { kind: "tool-step", now: WALL + 5999, label: "x" });
  check("backoff: +5999ms (under doubled interval) → no edit", rEarly.edit === undefined);
  const rLate = onWatchEvent(s1, { kind: "tool-step", now: WALL + 6000, label: "x" });
  check("backoff: +6000ms → edit (floor already passed)", rLate.edit !== undefined);
  // The retry_after floor dominates a short interval.
  const s2 = { ...workingState(WALL), lastEditedAt: WALL - 100_000, intervalMs: IV, baseIntervalMs: IV };
  const s3 = onEditFailedFlood(s2, 100, WALL);
  check("backoff: 100s retry_after → floor +100s", s3.earliestEditAt === WALL + 100_000);
  check("backoff: interval still doubles", s3.intervalMs === 6000);
  const rFloor = onWatchEvent(s3, { kind: "tool-step", now: WALL + 99_999, label: "x" });
  check("backoff: just before retry_after → no edit", rFloor.edit === undefined);
  const rAfter = onWatchEvent(s3, { kind: "tool-step", now: WALL + 100_000, label: "x" });
  check("backoff: at retry_after → edit", rAfter.edit !== undefined);
  // Doubling caps at 10 s, then stays there.
  const s4 = onEditFailedFlood(s1, 0, WALL);
  check("backoff: 6000 → 10000", s4.intervalMs === 10_000);
  const s5 = onEditFailedFlood(s4, 0, WALL);
  check("backoff: capped at 10000", s5.intervalMs === 10_000);
  // A successful edit resets to the base interval and clears the floor.
  const s6 = onEditSucceeded(s4, "rendered", WALL + 1);
  check("backoff: success resets interval to base", s6.intervalMs === IV && s6.earliestEditAt === 0);
  check("backoff: success stamps time + sent text", s6.lastEditedAt === WALL + 1 && s6.lastRendered === "rendered");
}

// ── W3.1: final states — one un-throttled final edit, then frozen ───────────
{
  const s0 = workingState(WALL, { text: "the answer is 42", lastPrompt: "compute", toolLabel: "🧮 Thinking" });
  const r = onWatchEvent(s0, { kind: "turn-end", now: WALL + 10_000, outcome: "done" });
  check("final: done emits a final edit", r.edit !== undefined && r.edit.reason === "final");
  check("final: done shows outcome + duration", r.edit?.text === "<b>✅ Done · 1m 33s</b>");
  check("final: the answer is NOT repeated", !r.edit?.text.includes("the answer"));
  check("final: phase is done", r.state.phase === "done");
  const again = onWatchEvent(r.state, { kind: "turn-end", now: WALL + 20_000, outcome: "failed", error: "x" });
  check("final: a second final is ignored (stays done)", again.edit === undefined && again.state.phase === "done");
  const unfreeze = onWatchEvent(r.state, { kind: "turn-start", now: WALL + 30_000, prompt: "again" });
  check("final: turn-start cannot unfreeze a frozen card", unfreeze.edit === undefined && unfreeze.state.phase === "done" && unfreeze.state.text === "");
  const stale = onWatchEvent(r.state, { kind: "text-delta", now: WALL + 40_000, text: "z" });
  check("final: stale deltas are dropped", stale.edit === undefined && stale.state.text === "");
  // The final edit bypasses the throttle (W3.1: it must land).
  const busy = { ...workingState(WALL), lastEditedAt: WALL };
  const rb = onWatchEvent(busy, { kind: "turn-end", now: WALL + 100, outcome: "stopped" });
  check("final: bypasses the throttle", rb.edit !== undefined && rb.edit.reason === "final");
  check("final: stopped shows Stopped + duration", rb.edit?.text === "<b>⏹ Stopped · 1m 23s</b>");
  // Failed: the (escaped, 200-char-capped) error message is shown.
  const rf = onWatchEvent(workingState(WALL, { turnStartedAt: WALL - 41_000 }), { kind: "turn-end", now: WALL, outcome: "failed", error: "boom <bad>" });
  check("final: failed shows error, escaped", rf.edit?.text === "<b>❌ Failed · 41s</b>\nboom &lt;bad&gt;");
  const rf2 = onWatchEvent(workingState(WALL, { turnStartedAt: WALL - 41_000 }), { kind: "turn-end", now: WALL, outcome: "failed", error: "e".repeat(250) });
  check("final: long error cut at 200", rf2.edit?.text === `<b>❌ Failed · 41s</b>\n${"e".repeat(200)}…`);
  // vi final labels.
  check("final: vi done", renderWatch({ ...workingState(WALL), phase: "done", turnStartedAt: WALL - 41_000, turnEndedAt: WALL }, "vi", WALL) === "<b>✅ Hoàn tất · 41s</b>");
  check("final: vi stopped", renderWatch({ ...workingState(WALL), phase: "stopped", turnStartedAt: WALL - 41_000, turnEndedAt: WALL }, "vi", WALL) === "<b>⏹ Đã dừng · 41s</b>");
  // A turn-end without a tracked start (missed execution.started): no duration.
  const i = createWatch({ sessionID: "s", lang: "en", now: WALL, intervalMs: IV });
  const ri = onWatchEvent(i, { kind: "turn-end", now: WALL + 5_000, outcome: "done" });
  check("final: untracked turn → no duration shown", ri.edit?.text === "<b>✅ Done</b>");
}

// ── turn-start resets the turn fields ───────────────────────────────────────
{
  const s0 = workingState(WALL, { text: "old text", toolLabel: "📖 Reading old", lastPrompt: "old prompt" });
  const r = onWatchEvent(s0, { kind: "turn-start", now: WALL + 10_000, prompt: "new prompt" });
  check("turn-start: resets text/tool and takes the new prompt", r.state.text === "" && r.state.toolLabel === "" && r.state.lastPrompt === "new prompt");
  check("turn-start: elapsed restarts from 0", renderWatch(r.state, "en", WALL + 10_000).includes("Working · 0s"));
  check("turn-start: emits an update edit", r.edit !== undefined && r.edit.reason === "update");
  const noPrompt = onWatchEvent(workingState(WALL), { kind: "turn-start", now: WALL + 1 });
  check("turn-start: without prompt keeps the previous one", noPrompt.state.lastPrompt === workingState(WALL).lastPrompt);
}

// ── the state's text buffer is tail-capped (long turns must not grow it) ────
{
  let s = workingState(WALL);
  for (let i = 0; i < 1000; i++) s = onWatchEvent(s, { kind: "text-delta", now: WALL + i * 4000, text: "z".repeat(100) }).state;
  check("text: buffer stays tail-capped after 100 KB", s.text.length <= 8000 && s.text.endsWith("z".repeat(4000)));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
