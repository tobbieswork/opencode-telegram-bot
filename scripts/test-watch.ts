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
 *   - W3 pure additions: watchHistory (prompt pick + list cap), watchKeyboard
 *     (Close / Close+Stop / Close+Watch-again, per status), watchRegistry (id
 *     format + TTL), watchTickDecision (timeout > idle > poll precedence),
 *     mapSessionOutcome.
 *   - W3 mock-Bot integration (src/bot.ts against a mock Telegram + OpenCode +
 *     a fake clock): card post (idle/working + buttons), event feed (prompt
 *     fetch, text fold, tool label in the card's own language, throttle),
 *     edit-failure handling (429 backoff, gone card → stopped "edit-failed"),
 *     turn-end final card (frozen, never the answer), auto-stops (idle 60 s,
 *     timeout cap, /watch replace, Close, unknown tap, session-mismatch
 *     refusal), the 5 s tick (W2.5 poll end-recovery, W3.4 idle freeze, W3.5
 *     timeout), the browse-setsess session switch (W5.1), and the W6.3 audit
 *     lines (watch_start, watch_end, exactly ONE per watch).
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
  watchHistory,
  watchKeyboard,
  watchRegistry,
  watchTickDecision,
  mapSessionOutcome,
  WATCH_CARD_LIMIT,
  WATCH_IDLE_FREEZE_MS,
  WATCH_POLL_GAP_MS,
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

// ════════════════════════════════════════════════════════════════════════════
// W3 pure additions (watch.ts)
// ════════════════════════════════════════════════════════════════════════════
{
  // watchHistory: prompt = last non-blank user message; list = last 6 ascending.
  const h = watchHistory([
    { type: "user", time: { created: 1 }, text: "first" },
    { type: "user", time: { created: 2 }, text: "second" },
    { type: "user", time: { created: 3 }, text: "third" },
    { type: "user", time: { created: 4 }, text: "fourth" },
    { type: "user", time: { created: 5 }, text: "fifth" },
    { type: "assistant", time: { created: 6 }, content: [{ type: "text", text: "p1" }, { type: "tool", text: "x" }, { type: "text", text: "p2" }] },
    { type: "user", time: { created: 7 }, text: "   " }, // blank → not the prompt
    { type: "user", time: { created: 8 }, text: "last one" },
  ]);
  check("history: prompt is the LAST non-blank user message", h.prompt === "last one", h.prompt);
  check("history: blank user messages never become the prompt", h.prompt !== "");
  check("history: assistant content parts joined with a newline", h.history.some((m) => m.type === "assistant" && m.text === "p1\np2"), JSON.stringify(h.history));
  check("history: cap 6, ascending", h.history.length === 6 && h.history[0].text === "third" && h.history[5].text === "last one", JSON.stringify(h.history));
  check("history: empty input → no prompt", watchHistory([]).prompt === undefined);
}
{
  const kw = watchKeyboard("ab12", "working", "en");
  check("kb: working = Close + Stop task", kw.inline_keyboard.length === 2, JSON.stringify(kw));
  check("kb: close data", kw.inline_keyboard[0][0].callback_data === "w:ab12:c");
  check("kb: stop data", kw.inline_keyboard[1][0].callback_data === "w:ab12:s");
  const ki = watchKeyboard("ab12", "idle", "en");
  check("kb: idle = Close only", ki.inline_keyboard.length === 1 && ki.inline_keyboard[0][0].callback_data === "w:ab12:c");
  const kf = watchKeyboard("ab12", "frozen", "vi");
  check("kb: frozen = Close + Watch again", kf.inline_keyboard.length === 2 && kf.inline_keyboard[0][0].callback_data === "w:ab12:c" && kf.inline_keyboard[1][0].callback_data === "w:ab12:r");
  check("kb: vi labels", kf.inline_keyboard[0][0].text === "❌ Đóng" && kf.inline_keyboard[1][0].text === "👁 Xem lại");
  const ke = watchKeyboard("ab12", "frozen", "en");
  check("kb: en labels", ke.inline_keyboard[0][0].text === "Close" && ke.inline_keyboard[1][0].text === "Watch again");
}
{
  const rid = watchRegistry.newId();
  check("registry: id is 4 base36 chars", /^[0-9a-z]{4}$/.test(rid), rid);
  watchRegistry.put(rid, { conv: "1", sessionID: "s", cardMsgId: 9, createdAt: Date.now() });
  check("registry: put/get round-trip", watchRegistry.get(rid)?.cardMsgId === 9);
  check("registry: newId avoids a live id", watchRegistry.newId() !== rid);
  watchRegistry.delete(rid);
  check("registry: delete → undefined", watchRegistry.get(rid) === undefined);
  const oldId = watchRegistry.newId();
  watchRegistry.put(oldId, { conv: "1", sessionID: "s", cardMsgId: 1, createdAt: Date.now() - 25 * 3600_000 });
  check("registry: expired (25 h) record dropped on get", watchRegistry.get(oldId) === undefined);
}
{
  const T = 1_000_000_000;
  const base = { createdAt: T, lastEventAt: T, maxMs: 600_000, idleMs: WATCH_IDLE_FREEZE_MS, pollGapMs: WATCH_POLL_GAP_MS, polling: false };
  check("tick: fresh idle watch → none", watchTickDecision({ ...base, phase: "idle", now: T + 1_000 }) === "none");
  check("tick: idle gap 59.9 s → none", watchTickDecision({ ...base, phase: "idle", now: T + 59_900 }) === "none");
  check("tick: idle gap just over 60 s → idle freeze", watchTickDecision({ ...base, phase: "idle", now: T + 60_001 }) === "idle");
  check("tick: fresh working watch → none", watchTickDecision({ ...base, phase: "working", now: T + 1_000 }) === "none");
  check("tick: working gap 9.9 s → none", watchTickDecision({ ...base, phase: "working", now: T + 9_900 }) === "none");
  check("tick: working gap just over 10 s → poll", watchTickDecision({ ...base, phase: "working", now: T + 10_001 }) === "poll");
  check("tick: active poll stays polling", watchTickDecision({ ...base, phase: "working", now: T + 1_000, polling: true }) === "poll");
  check("tick: timeout beats poll", watchTickDecision({ ...base, phase: "working", now: T + 600_001, polling: true }) === "timeout");
  check("tick: timeout beats idle", watchTickDecision({ ...base, phase: "idle", now: T + 600_001 }) === "timeout");
  check("tick: exactly at the cap → still not a timeout", watchTickDecision({ ...base, phase: "idle", now: T + 600_000 }) !== "timeout");
}
{
  check("outcome: succeeded → done", mapSessionOutcome("succeeded") === "done");
  check("outcome: failed → failed", mapSessionOutcome("failed") === "failed");
  check("outcome: interrupted → stopped", mapSessionOutcome("interrupted") === "stopped");
  check("outcome: undefined → done", mapSessionOutcome(undefined) === "done");
}

// ════════════════════════════════════════════════════════════════════════════
// W3 mock-Bot integration (src/bot.ts): the watch lifecycle end to end
// against a mock Telegram + mock OpenCode + a fake clock.
// ════════════════════════════════════════════════════════════════════════════
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "ocbot-watch-"));
let auditN = 0;
let auditFile = join(tmpRoot, "audit-0.log");
configureAudit({ path: auditFile });

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};
const auditLines = (): Record<string, unknown>[] => {
  try {
    return readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const byAction = (action: string) => auditLines().filter((l) => l.action === action);

const realNow = Date.now.bind(Date);
let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;

/**
 * A Bot with the watch machinery wired to mocks. The clock stays FAKED for the
 * whole section (restore it at the end).
 */
function makeWatchBot(opts: {
  listMsgs?: any[];
  busy?: boolean;
  outcome?: string;
  sessionState?: Array<{ busy: boolean; outcome?: string }>;
} = {}) {
  auditN++;
  auditFile = join(tmpRoot, `audit-${auditN}.log`);
  configureAudit({ path: auditFile });

  const sent: { conv: string; text: string; kb?: { inline_keyboard: unknown[][] } }[] = [];
  const edits: { conv: string; msgId: number; text: string; kb?: { inline_keyboard: unknown[][] } }[] = [];
  const deleted: number[] = [];
  const answers: { id: string; text?: string }[] = [];
  const ssCalls: string[] = [];
  const ssQueue = [...(opts.sessionState ?? [])];
  let failMode: "gone" | "flood" | undefined;
  const doEdit = async (conv: string, msgId: number, text: string, opts: any) => {
    if (failMode === "gone") { const e: any = new Error("message to edit not found"); e.code = 400; throw e; }
    if (failMode === "flood") { const e: any = new Error("Too Many Requests"); e.code = 429; e.retryAfter = 2; throw e; }
    edits.push({ conv, msgId, text, kb: opts?.reply_markup });
  };

  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_c: string, _t: string) => {},
    sendChatAction: async () => {},
    deleteMessage: async (_c: string, id: number) => { deleted.push(id); },
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
    stop: () => {},
    sendMessageId: async (conv: string, text: string, opts: any) => {
      const kb = opts?.reply_markup;
      sent.push({ conv, text, kb });
      return 1000 + sent.length;
    },
    editMessageTextStrict: doEdit,
    answerCallbackQuery: async (id: string, text?: string) => { answers.push({ id, text }); },
  };

  const oc: any = {
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
    prompt: async () => "msg_x",
    interrupt: async () => {},
    createSession: async () => "ses_x",
    listMessages: async () => opts.listMsgs ?? [],
    sessionState: async (sid: string) => {
      ssCalls.push(sid);
      return ssQueue.length ? ssQueue.shift()! : { busy: !!opts.busy, outcome: opts.outcome };
    },
  };

  const st = new StateManager(join(tmpRoot, `state-${auditN}.json`));
  const cfg: any = {
    stateFile: join(tmpRoot, `state-${auditN}.json`),
    maxSchedules: 5,
    watchActive: true,
    watch: true,
    stream: false,
    watchIntervalMs: 3000,
    watchMaxMin: 10,
  };
  const bot = new Bot(tg, oc, st, cfg);
  const neutral: string[] = [
    "sendReply", "sendHtml", "startTyping", "stopTyping", "startWorking",
    "stopWorking", "clearActivity", "dropPreview", "offerContinueKeyboard",
  ];
  for (const m of neutral) (bot as any)[m] = async () => {};
  // The group-floor clamp must never kick in for these conversations (DMs).
  bot.startWatchTicker = () => {}; // keep it OFF: tests drive ticks explicitly

  return {
    bot, tg, st, cfg, sent, edits, deleted, answers, ssCalls,
    setFail: (mode: "gone" | "flood" | undefined) => { failMode = mode; },
  };
}

const cb = (data: string, from = 7): any => ({ id: "cb_" + data, data, from: { id: from } });
const cardKb = (e: { kb?: { inline_keyboard: unknown[][] } }) => (e.kb?.inline_keyboard ?? [] as unknown[][]) as Array<Array<{ callback_data: string; text: string }>>;
const dm = "7"; // isDmConv("7") === true → no group floor

// ── W1.4/W3.2: posting an idle card (no in-flight turn) ──────────────────────
{
  const m = makeWatchBot({
    listMsgs: [
      { type: "user", time: { created: 1 }, text: "do the thing" },
      { type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "on it" }] },
    ],
  });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  check("post: exactly one card message", m.sent.length === 1 && m.sent[0].conv === dm, JSON.stringify(m.sent));
  check("post: idle card has the Idle header", m.sent[0].text.includes("Idle"), m.sent[0].text);
  check("post: idle card shows the history", m.sent[0].text.includes("do the thing") && m.sent[0].text.includes("on it"), m.sent[0].text);
  const rows = cardKb(m.sent[0]);
  check("post: idle card has Close button", rows.length === 1 && rows[0][0].callback_data === "w:" + m.bot.watches.get(dm)!.id + ":c", JSON.stringify(rows));
  check("post: watch recorded (idle, not frozen)", m.bot.watches.get(dm)!.state.phase === "idle" && !m.bot.watches.get(dm)!.frozen);
  check("post: card message id recorded", m.bot.watches.get(dm)!.cardMsgId === m.sent[0].kb ? 1001 : m.bot.watches.get(dm)!.cardMsgId === 1001);
  const ws = byAction("watch_start");
  check("post: watch_start audited (session + user + interval meta)", ws.length === 1 && ws[0].session === "ses_1" && ws[0].userId === 7 && ws[0].meta?.intervalMs === 3000 && ws[0].meta?.isGroup === false, JSON.stringify(ws));
  check("post: no watch_end yet", byAction("watch_end").length === 0);
}

// ── W3.3: the event feed — prompt fetch, text fold, tool label, throttle ────
{
  const m = makeWatchBot({
    listMsgs: [
      { type: "user", time: { created: 1 }, text: "do the thing" },
      { type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "on it" }] },
    ],
  });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  check("feed: pre — 1 card, 0 edits", m.sent.length === 1 && m.edits.length === 0);

  const w = () => m.bot.watches.get(dm)!;
  // A turn starts: the prompt is fetched from the session history (W3.3).
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  await flush();
  check("feed: turn-start edited the card once", m.edits.length === 1, JSON.stringify(m.edits.length));
  check("feed: working header appears", m.edits[0].text.includes("Working"), m.edits[0].text);
  check("feed: prompt line comes from the history fetch", m.edits[0].text.includes("do the thing"), m.edits[0].text);
  const rowsWork = cardKb(m.edits[0]);
  check("feed: working card has Close + Stop task", rowsWork.length === 2 && rowsWork[1][0].callback_data.endsWith(":s"), JSON.stringify(rowsWork));
  check("feed: phase working + not frozen", w().state.phase === "working" && !w().frozen);

  // Text deltas fold in (W3.3).
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: "hello" });
  await flush();
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: " world" });
  await flush();
  check("feed: deltas within the interval do not re-edit", m.edits.length === 1, String(m.edits.length));
  check("feed: deltas folded into state", w().state.text === "hello world", w().state.text);

  // The same tool label as the activity line, in the card's OWN language.
  m.bot.feedWatch("session.tool.input.started", { sessionID: "ses_1", id: "t1", name: "read" });
  await flush();
  check("feed: tool input.started alone never edits", m.edits.length === 1);
  fakeNow += 3000; // pass the throttle
  m.bot.feedWatch("session.tool.called", { sessionID: "ses_1", id: "t1", name: "read", input: { path: "src/a.ts" } });
  await flush();
  check("feed: tool label rendered (en, like the activity line)", m.edits.length === 2 && m.edits[1].text.includes("📖 Reading src/a.ts"), m.edits[1]?.text);
  // A different session's events are ignored.
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_OTHER", delta: "nope" });
  await flush();
  check("feed: other session's events ignored", w().state.text === "hello world");
  fakeNow += 3000; // pass the throttle
  m.bot.feedWatch("session.tool.success", { sessionID: "ses_1", id: "t1" });
  await flush();
  check("feed: tool success shows the activity-line done form", m.edits[2]?.text.includes("✅") && m.edits[2]?.text.includes("Read src/a.ts"), m.edits[2]?.text);
}

// ── W5.2/W2.4: edit failures — 429 backoff, gone card → stopped edit-failed ─
{
  const m = makeWatchBot({ listMsgs: [{ type: "user", time: { created: 1 }, text: "hi" }] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  await flush();
  check("fail: pre — card + turn-start edit", m.sent.length === 1 && m.edits.length === 1);

  m.setFail("flood");
  fakeNow += 3000; // pass the throttle so the edit actually goes out
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: "boom" });
  await flush();
  const w = () => m.bot.watches.get(dm)!;
  check("fail: 429 keeps the watch alive (backoff)", !!w() && !w().frozen);
  check("fail: backoff doubled the interval (3000 → 6000)", w().state.intervalMs === 6000, String(w().state.intervalMs));
  check("fail: retry_after floor applied (2 s)", w().state.earliestEditAt === fakeNow + 2000, String(w().state.earliestEditAt));
  check("fail: no edit landed while flooded", m.edits.length === 1);
  fakeNow += 6000; // past BOTH the retry_after floor and the doubled throttle
  m.setFail(undefined);
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: "ok now" });

  await flush();
  check("fail: edit lands after the floor", m.edits.length === 2, String(m.edits.length));
  check("fail: backoff reset on success", w().state.intervalMs === 3000 && w().state.earliestEditAt === 0, `${w().state.intervalMs}/${w().state.earliestEditAt}`);

  m.setFail("gone");
  fakeNow += 10_000; // clear the (reset) throttle
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: "gone" });

  await flush();
  check("fail: gone card (400) stops the watch", !m.bot.watches.has(dm));
  const we = byAction("watch_end");
  check("fail: watch_end audited with reason edit-failed", we.length === 1 && we[0].meta?.reason === "edit-failed", JSON.stringify(we));
}

// ── W3.1: turn end → one final card, frozen, never the answer ───────────────
{
  const m = makeWatchBot({ listMsgs: [{ type: "user", time: { created: 1 }, text: "compute" }] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  await flush();
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", delta: "the answer is 42" });
  fakeNow += 3000;
  await flush();
  check("end: pre — card + edits, not frozen", !!m.bot.watches.get(dm) && !m.bot.watches.get(dm)!.frozen);
  const preEdits = m.edits.length;

  m.bot.feedWatch("session.execution.succeeded", { sessionID: "ses_1" });
  await flush();
  check("end: exactly ONE final edit", m.edits.length === preEdits + 1, String(m.edits.length));
  const finalText = m.edits[preEdits].text;
  check("end: final card shows Done", finalText.includes("Done"), finalText);
  check("end: final card shows a duration", /· \d+m? ?\d*s/.test(finalText), finalText);
  check("end: the answer is NOT repeated", !finalText.includes("the answer"), finalText);
  const rowsFinal = cardKb(m.edits[preEdits]);
  check("end: frozen card has Close + Watch again", rowsFinal.length === 2 && rowsFinal[1][0].callback_data.endsWith(":r"), JSON.stringify(rowsFinal));
  check("end: watch frozen", m.bot.watches.get(dm)!.frozen && m.bot.watches.get(dm)!.state.phase === "done");
  const we = byAction("watch_end");
  check("end: watch_end audited once", we.length === 1 && we[0].meta?.reason === "done", JSON.stringify(we));
  const preEnd = byAction("watch_end").length;
  // Stale events after the freeze are dropped.
  m.bot.feedWatch("session.text.delta", { sessionID: "ses_1", text: "stale" });
  m.bot.feedWatch("session.execution.succeeded", { sessionID: "ses_1" });
  await flush();
  check("end: stale events after the freeze are dropped", m.edits.length === preEdits + 1 && byAction("watch_end").length === preEnd);
}

// ── W3.4: idle freeze after 60 s of silence ─────────────────────────────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  fakeNow += 59_900;
  await (m.bot as any).watchTick();
  check("idle: 59.9 s of silence → still alive", m.bot.watches.has(dm));
  fakeNow += 1_100; // just over the 60 s threshold
  await (m.bot as any).watchTick();
  check("idle: just over 60 s of silence → frozen (card + record stay)", m.bot.watches.get(dm)!.frozen === true);
  const we = byAction("watch_end");
  check("idle: watch_end reason idle", we.length === 1 && we[0].meta?.reason === "idle", JSON.stringify(we));
  check("idle: a final edit was pushed", m.edits.length === 1 && m.edits[0].text.includes("Idle"), m.edits[0]?.text);
}

// ── W3.5: the lifetime cap (watchMaxMin) ────────────────────────────────────
{
  const m = makeWatchBot({ listMsgs: [], sessionState: [{ busy: false }, { busy: true }, { busy: true }, { busy: true }] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7); // consumes the 1st (idle) read
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  await flush();
  m.ssCalls.length = 0;
  fakeNow += m.cfg.watchMaxMin * 60_000 - 10_000;
  await (m.bot as any).watchTick(); // poll (busy) keeps lastEventAt fresh
  check("timeout: just under the cap → alive (poll kept it current)", m.bot.watches.has(dm) && m.ssCalls.length === 1, JSON.stringify(m.ssCalls.length));
  fakeNow += 11_000; // past the cap
  await (m.bot as any).watchTick();
  check("timeout: past the cap → frozen", m.bot.watches.get(dm)!.frozen === true);
  const we = byAction("watch_end");
  check("timeout: watch_end reason timeout", we.length === 1 && we[0].meta?.reason === "timeout", JSON.stringify(we));
}

// ── W1.5: a second /watch replaces the first (its card is deleted) ──────────
{
  const m = makeWatchBot({ listMsgs: [{ type: "user", time: { created: 1 }, text: "hi" }] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  const firstCard = m.bot.watches.get(dm)!.cardMsgId;
  const firstEnd = byAction("watch_end").length;
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  await flush();
  check("replace: old card deleted", m.deleted.includes(firstCard), JSON.stringify(m.deleted));
  check("replace: exactly one watch remains", m.bot.watches.size === 1);
  check("replace: old watch audited as replaced", byAction("watch_end").length === firstEnd + 1 && byAction("watch_end")[firstEnd].meta?.reason === "replaced", JSON.stringify(byAction("watch_end")));
  check("replace: new card posted", m.sent.length === 2);
}

// ── W3.6/W6.4: the Close button (and unknown-tap refusal) ───────────────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  const cardId = m.bot.watches.get(dm)!.cardMsgId;
  const id1 = m.bot.watches.get(dm)!.id;
  await (m.bot as any).handleWatchCallback(cb("w:" + id1 + ":c"), dm);
  check("close: card deleted", m.deleted.includes(cardId), JSON.stringify(m.deleted));
  check("close: watch removed", !m.bot.watches.has(dm));
  check("close: tap acknowledged", m.answers.length === 1 && m.answers[0].id === "cb_w:" + id1 + ":c", JSON.stringify(m.answers));
  const we = byAction("watch_end");
  check("close: watch_end reason closed", we.length === 1 && we[0].meta?.reason === "closed", JSON.stringify(we));

  // Unknown callback data for a known watch → refused with a hint.
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  const id2 = m.bot.watches.get(dm)!.id;
  m.answers.length = 0;
  m.deleted.length = 0;
  await (m.bot as any).handleWatchCallback(cb("w:" + id2 + ":z"), dm);
  check("close: unknown action is swallowed (watch intact, card kept)", m.bot.watches.has(dm) && m.deleted.length === 0 && (m.answers[0]?.text ?? "") === "", JSON.stringify(m.answers));
}

// ── W3.6: a tap from another session is refused (the watch stays) ───────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  const cardId = m.bot.watches.get(dm)!.cardMsgId;
  m.st.set(dm, { sessionID: "ses_2" }); // the conversation moved on
  m.answers.length = 0;
  await (m.bot as any).handleWatchCallback(cb("w:" + m.bot.watches.get(dm)!.id + ":c"), dm);
  check("mismatch: refused — watch intact", m.bot.watches.has(dm));
  check("mismatch: refused — card NOT deleted", !m.deleted.includes(cardId), JSON.stringify(m.deleted));
  check("mismatch: refusal hint shown", m.answers.length === 1 && /another session/i.test(m.answers[0].text ?? ""), JSON.stringify(m.answers));
}

// ── W3.6: "Watch again" starts a fresh watch on the same session ────────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  m.bot.feedWatch("session.execution.succeeded", { sessionID: "ses_1" });
  await flush();
  check("again: pre — frozen watch", m.bot.watches.get(dm)!.frozen);
  const before = m.sent.length;
  m.answers.length = 0;
  await (m.bot as any).handleWatchCallback(cb("w:" + m.bot.watches.get(dm)!.id + ":r"), dm);
  await flush();
  check("again: a new card is posted", m.sent.length === before + 1, `${before} → ${m.sent.length}`);
  check("again: new watch alive and not frozen", m.bot.watches.has(dm) && !m.bot.watches.get(dm)!.frozen);
  check("again: acknowledged", m.answers.length === 1);
}

// ── W2.5: the tick's fallback poll recovers a missed turn end ───────────────
{
  // Reads: [0] startWatch's own check (idle), [1] poll #1 (busy), [2] poll #2 (the turn ended).
  const m = makeWatchBot({ listMsgs: [], sessionState: [{ busy: false }, { busy: true }, { busy: false, outcome: "succeeded" }] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  await flush();
  m.ssCalls.length = 0;
  check("poll: pre — working, no poll", !m.bot.watches.get(dm)!.polling && m.ssCalls.length === 0);
  fakeNow += 10_001; // just over the 10 s event gap → the poll arms
  await (m.bot as any).watchTick();
  check("poll: armed + one sessionState read", m.bot.watches.get(dm)!.polling && m.ssCalls.length === 1, JSON.stringify(m.ssCalls.length));
  check("poll: busy → still alive", m.bot.watches.has(dm));
  // The turn ended out-of-band: the poll is still active, so the next tick re-reads.
  await (m.bot as any).watchTick();
  check("poll: found idle → frozen + final edit (turn-start, elapsed, final)", m.bot.watches.get(dm)!.frozen === true && m.edits.length === 3, JSON.stringify(m.edits.map((e) => e.text)));
  check("poll: final card says Done", m.edits[2]?.text.includes("Done"), m.edits[2]?.text);
  const we = byAction("watch_end");
  check("poll: watch_end audited", we.length === 1 && we[0].meta?.reason === "done", JSON.stringify(we));
}

// ── W5.1: the browse "Open new session" switch stops the watch ─────────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  check("setsess: pre — watch alive", m.bot.watches.has(dm));
  // Simulate the browse "setsess" action's side effect on the conversation.
  m.st.set(dm, { sessionID: "ses_2" });
  (m.bot as any).stopWatch(dm, "session-changed");
  check("setsess: watch stopped after the session switch", !m.bot.watches.has(dm));
  const we = byAction("watch_end");
  check("setsess: watch_end reason session-changed", we.length === 1 && we[0].meta?.reason === "session-changed", JSON.stringify(we));
}

// ── W6.3: the audit lines — exactly ONE watch_end per watch, ever ──────────
{
  const m = makeWatchBot({ listMsgs: [] });
  m.st.set(dm, { sessionID: "ses_1" });
  (m.bot as any).userPrefs.setLang(7, "en");
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  m.bot.feedWatch("session.execution.started", { sessionID: "ses_1" });
  m.bot.feedWatch("session.execution.succeeded", { sessionID: "ses_1" }); // → done, audited
  await flush();
  check("audit: one watch_start + one watch_end (done)", byAction("watch_start").length === 1 && byAction("watch_end").length === 1, JSON.stringify(auditLines()));
  // The frozen card is deleted by a later Close: cleanup only, no 2nd line.
  const cardId = m.bot.watches.get(dm)!.cardMsgId;
  m.deleted.length = 0;
  await (m.bot as any).handleWatchCallback(cb("w:" + m.bot.watches.get(dm)!.id + ":c"), dm);
  check("audit: Close after done deletes the card", m.deleted.includes(cardId), JSON.stringify(m.deleted));
  check("audit: still exactly ONE watch_end", byAction("watch_end").length === 1, JSON.stringify(byAction("watch_end")));
  // A second /watch after the end: one more pair, and only one more end.
  await (m.bot as any).startWatch(dm, m.st.get(dm), 7);
  await flush();
  check("audit: re-watch audited (2 starts, 1 end so far)", byAction("watch_start").length === 2 && byAction("watch_end").length === 1, JSON.stringify(auditLines().map((l) => l.action)));
}

Date.now = realNow;

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll /watch checks passed.");

