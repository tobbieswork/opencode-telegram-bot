/**
 * Manager rotation — pure logic. M1: the FLOOR (min sent-context over 24h) and
 * the per-message sent-context (input + cache.read). The network side lives in
 * bot.ts (managerFloor) and is exercised live via /status.
 *
 * Run:  npx tsx scripts/test-rotation.ts
 */
import {
  managerFloorFromMessages,
  sentContext,
  ROTATION_WINDOW_MS,
  rotationInstruction,
  runRotationHandoff,
  capWords,
  HANDOFF_BRIEF_WORDS,
  rotationGate,
} from "../src/rotation.js";
import {
  appendRotationHistory,
  ROTATION_HISTORY_CAP,
  dayKey,
  upsertFloorTrend,
  FLOOR_TREND_DAYS,
  buildRotationSnapshot,
  SNAPSHOT_ROTATIONS,
  rotationVerdict,
  ROTATION_WATCH_K,
  ROTATION_UNBOUNDED_K,
  writeRotationHealth,
  readRotationHealth,
  rotationHealthPath,
  renderRotationReport,
  type RotationHistoryEntry,
  type FloorTrendEntry,
} from "../src/rotation-health.js";
import { StateManager } from "../src/state.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const H = 3600_000;
const inWindow = (t: number, tokens: object) => ({ type: "assistant", time: { created: t }, tokens });

// ── sentContext: input + cache.read (cache.write excluded) ─────────────────
{
  const flat = { type: "assistant", tokens: { input: 1000, output: 50, cache: { read: 80_000, write: 12_000 } } };
  check("sentContext flat = input + cache.read", sentContext(flat) === 81_000, String(sentContext(flat)));
  const wrapped = { info: { type: "assistant", tokens: { input: 100, cache: { read: 200 } } } };
  check("sentContext info-wrapped", sentContext(wrapped) === 300, String(sentContext(wrapped)));
  check("sentContext no tokens → 0", sentContext({ type: "assistant" }) === 0);
  // output / reasoning / cache.write are all excluded — only input + cache.read count
  check("sentContext ignores output/reasoning/write", sentContext({ type: "assistant", tokens: { input: 7, output: 999, reasoning: 888, cache: { read: 3, write: 44 } } }) === 10);
}

// ── managerFloorFromMessages: MIN over the last 24h window ─────────────────
{
  const msgs = [
    inWindow(NOW - 1 * H, { input: 90_000, cache: { read: 0 } }), // 90K
    inWindow(NOW - 2 * H, { input: 56_000, cache: { read: 0 } }), // 56K ← min
    inWindow(NOW - 3 * H, { input: 70_000, cache: { read: 0 } }), // 70K
    inWindow(NOW - 30 * H, { input: 10_000, cache: { read: 0 } }), // 10K but OLDER than 24h → excluded
    { type: "user", time: { created: NOW - 1 * H } }, // not assistant → ignored
    inWindow(NOW + 1 * H, { input: 1, cache: { read: 0 } }), // future → excluded
  ];
  check("floor = min of in-window (56K)", managerFloorFromMessages(msgs, NOW) === 56_000, String(managerFloorFromMessages(msgs, NOW)));
  check("older-than-window excluded (56K, not 10K)", managerFloorFromMessages(msgs, NOW) === 56_000);
  check("no assistant msgs → 0", managerFloorFromMessages([], NOW) === 0);
  check("only user msgs → 0", managerFloorFromMessages([{ type: "user", time: { created: NOW } }], NOW) === 0);
  check("all outside window → 0", managerFloorFromMessages([inWindow(NOW - 30 * H, { input: 100, cache: { read: 0 } })], NOW) === 0);
  const atCutoff = [inWindow(NOW - ROTATION_WINDOW_MS, { input: 42_000, cache: { read: 0 } })];
  check("message exactly at 24h cutoff is included", managerFloorFromMessages(atCutoff, NOW) === 42_000);
  const pair = [inWindow(NOW - 1 * H, { input: 80_000, cache: { read: 0 } }), inWindow(NOW - 2 * H, { input: 60_000, cache: { read: 0 } })];
  check("order-independent", managerFloorFromMessages(pair, NOW) === 60_000 && managerFloorFromMessages([...pair].reverse(), NOW) === 60_000);
}

// ── M2: capWords ─────────────────────────────────────────────────────────────
{
  check("capWords under limit unchanged", capWords("a b c", 10) === "a b c");
  check("capWords at limit", capWords("a b c d e", 5) === "a b c d e");
  check("capWords over limit cuts to N words", capWords("a b c d e", 3) === "a b c");
  check("capWords trims + normalizes whitespace", capWords("  a\t b  ", 5) === "a b");
  check("capWords empty", capWords("", 5) === "");
  check("capWords single word at limit 1", capWords("a b c", 1) === "a");
}

// ── M2: rotationInstruction ──────────────────────────────────────────────────
{
  const instr = rotationInstruction("/home/user/project", 300);
  check("instruction names the working dir", instr.includes("/home/user/project"));
  check("instruction asks to save memory + notes", instr.includes("ctx_memory") && instr.includes("ctx_note"));
  check("instruction caps the brief at 300 words", instr.includes("at most 300 words"));
  check("instruction covers branch/task/decisions/risks", /git branch/.test(instr) && /pending/.test(instr) && /reasoning/.test(instr) && /risk/.test(instr));
  check("instruction states it is for the replacement session", /replacement session/.test(instr));
  check("instruction custom word count (50)", rotationInstruction("/x", 50).includes("at most 50 words"));
}

// ── M2: runRotationHandoff (injected deps — no network) ──────────────────────
{
  const briefText = "Worked on X; branch main; done A, pending B; decided Y because Z; risk: W.";

  // happy path: prompts the old session, returns the trimmed brief
  {
    let calledSid = "";
    let calledText = "";
    const r = await runRotationHandoff("ses_old", "/proj", {
      prompt: async (sid, text) => { calledSid = sid; calledText = text; return { reply: "  " + briefText + "  " }; },
    });
    check("handoff prompts the OLD session", calledSid === "ses_old");
    check("handoff sends the rotation instruction", calledText.includes("/proj") && calledText.includes("Rotation handoff"));
    check("handoff returns trimmed brief", r === briefText, r);
  }
  // a long reply is capped to HANDOFF_BRIEF_WORDS words
  {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const r = await runRotationHandoff("s", "/d", { prompt: async () => ({ reply: long }) });
    check("handoff caps brief to HANDOFF_BRIEF_WORDS words", r.split(/\s+/).length === HANDOFF_BRIEF_WORDS, `got ${r.split(/\s+/).length}`);
  }
  // prompt throws → "" (graceful degrade)
  {
    const r = await runRotationHandoff("s", "/d", { prompt: async () => { throw new Error("boom"); } });
    check("handoff prompt error → empty brief", r === "");
  }
  // empty/whitespace reply → ""
  {
    const r = await runRotationHandoff("s", "/d", { prompt: async () => ({ reply: "   " }) });
    check("handoff empty reply → empty brief", r === "");
  }
}

// ── M3: rotationGate (two-tier trigger) ──────────────────────────────────────
{
  const NOW = 1_800_000_000_000;
  const cfg = { autoFloorK: 110, confirmFloorK: 90, minIntervalMs: 24 * 3600_000, confirmRepromptMs: 12 * 3600_000 };
  const base = { nowMs: NOW, ...cfg };

  check("gate: floor 0 → idle", rotationGate({ floorK: 0, busy: false, ...base }) === "idle");
  check("gate: below confirm → idle", rotationGate({ floorK: 80, busy: false, ...base }) === "idle");
  check("gate: == confirmFloorK (boundary) → idle", rotationGate({ floorK: 90, busy: false, ...base }) === "idle");
  check("gate: above confirm, idle → confirm", rotationGate({ floorK: 100, busy: false, ...base }) === "confirm");
  check("gate: above confirm, busy → defer", rotationGate({ floorK: 100, busy: true, ...base }) === "defer");
  check("gate: above confirm, just prompted → idle (re-prompt throttle)", rotationGate({ floorK: 100, busy: false, lastRotationPromptMs: NOW - 1 * 3600_000, ...base }) === "idle");
  check("gate: above confirm, prompted 13h ago → confirm again", rotationGate({ floorK: 100, busy: false, lastRotationPromptMs: NOW - 13 * 3600_000, ...base }) === "confirm");

  check("gate: == autoFloorK (boundary) → confirm (not auto)", rotationGate({ floorK: 110, busy: false, ...base }) === "confirm");
  check("gate: above auto, idle → auto", rotationGate({ floorK: 120, busy: false, ...base }) === "auto");
  check("gate: above auto, busy → defer", rotationGate({ floorK: 120, busy: true, ...base }) === "defer");
  // Out-of-band manager turn: a schedule task / background wake running on the
  // manager session is NOT in `inflight` — it is tracked only in
  // orch.managerInflight. checkManagerRotation computes busy =
  // inflight.has(conv) || orch.managerInflight, so this surfaces as busy=true.
  // Guards against a regression that rotated mid-turn and interrupted it via
  // stopCurrent (would be "auto", not "defer").
  check("gate: out-of-band manager busy (inflight empty, managerInflight true) + floor > auto → defer, not auto", rotationGate({ floorK: 120, busy: true, ...base }) === "defer" && rotationGate({ floorK: 120, busy: false, ...base }) === "auto");

  // idempotency: within the min interval of a last rotation → defer (both tiers)
  check("gate: above auto, within interval → defer", rotationGate({ floorK: 120, busy: false, lastRotationMs: NOW - 2 * 3600_000, ...base }) === "defer");
  check("gate: above confirm, within interval → defer", rotationGate({ floorK: 100, busy: false, lastRotationMs: NOW - 2 * 3600_000, ...base }) === "defer");
  check("gate: above auto, past interval → auto", rotationGate({ floorK: 120, busy: false, lastRotationMs: NOW - 25 * 3600_000, ...base }) === "auto");

  // auto takes priority over confirm (a floor above auto never offers confirm)
  check("gate: above auto, recently prompted → still auto (not throttled to idle)", rotationGate({ floorK: 120, busy: false, lastRotationPromptMs: NOW - 1 * 3600_000, ...base }) === "auto");
}

// ── Part 1: rotation tracking — appendRotationHistory (cap + append) ──────
{
  const mk = (i: number): RotationHistoryEntry => ({ at: i, floorK: 100, tier: "auto", outcome: "success" });
  check("appendRotationHistory empty → 1", appendRotationHistory(undefined, mk(1)).length === 1);
  const two = appendRotationHistory(appendRotationHistory(undefined, mk(1)), mk(2));
  check("appendRotationHistory appends", two.length === 2 && two[0].at === 1 && two[1].at === 2);
  let h: RotationHistoryEntry[] | undefined;
  for (let i = 1; i <= ROTATION_HISTORY_CAP + 5; i++) h = appendRotationHistory(h, mk(i));
  check("appendRotationHistory caps at ROTATION_HISTORY_CAP", h!.length === ROTATION_HISTORY_CAP, `len=${h!.length}`);
  check("appendRotationHistory keeps the most recent", h![0].at === 6 && h![h!.length - 1].at === ROTATION_HISTORY_CAP + 5, `first=${h![0].at} last=${h![h!.length - 1].at}`);
  const before = [{ at: 1, floorK: 5, tier: "confirm" as const, outcome: "fail" as const }];
  appendRotationHistory(before, mk(2));
  check("appendRotationHistory does not mutate input", before.length === 1);
}

// ── Part 1: dayKey ───────────────────────────────────────────────────────────
{
  const k = dayKey(1_767_626_000_000); // some fixed instant
  check("dayKey format YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(k), k);
  check("dayKey deterministic", dayKey(1_767_626_000_000) === k);
}

// ── Part 1: upsertFloorTrend (daily min/max + prune) ─────────────────────
{
  const d1 = "2026-01-01", d2 = "2026-01-02", d3 = "2026-01-03";
  let t = upsertFloorTrend(undefined, d1, 50);
  check("upsertFloorTrend first insert min=max", t.length === 1 && t[0].min === 50 && t[0].max === 50, JSON.stringify(t));
  t = upsertFloorTrend(t, d1, 30);
  check("upsertFloorTrend same-day lower widens min", t.length === 1 && t[0].min === 30 && t[0].max === 50, JSON.stringify(t));
  t = upsertFloorTrend(t, d1, 80);
  check("upsertFloorTrend same-day higher widens max", t.length === 1 && t[0].min === 30 && t[0].max === 80, JSON.stringify(t));
  t = upsertFloorTrend(t, d3, 20);
  t = upsertFloorTrend(t, d2, 40);
  check("upsertFloorTrend sorts days ascending", t.map((e) => e.day).join(",") === `${d1},${d2},${d3}`, JSON.stringify(t.map((e) => e.day)));
  let pr: FloorTrendEntry[] | undefined;
  for (let i = 1; i <= FLOOR_TREND_DAYS + 3; i++) pr = upsertFloorTrend(pr, `2026-01-${String(i).padStart(2, "0")}`, i);
  check("upsertFloorTrend prunes to FLOOR_TREND_DAYS", pr!.length === FLOOR_TREND_DAYS, `len=${pr!.length}`);
  check("upsertFloorTrend keeps the most recent days", pr![pr!.length - 1].day === `2026-01-${String(FLOOR_TREND_DAYS + 3).padStart(2, "0")}`, JSON.stringify(pr!.map((e) => e.day)));
}

// ── Part 1: buildRotationSnapshot ───────────────────────────────────────────
{
  const hist: RotationHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({ at: i + 1, floorK: 100 + i, tier: i % 2 ? ("confirm" as const) : ("auto" as const), outcome: "success" as const }));
  const trend: FloorTrendEntry[] = [{ day: "2026-01-01", min: 10, max: 20 }];
  const snap = buildRotationSnapshot({ now: 999, currentFloorK: 125, floorTrend: trend, rotationHistory: hist, lastRotationAt: 15, lastRotationOutcome: "success", autoK: 110, confirmK: 90 });
  check("snapshot rotations = last SNAPSHOT_ROTATIONS", snap.rotations.length === SNAPSHOT_ROTATIONS, `len=${snap.rotations.length}`);
  check("snapshot rotations are the most recent", snap.rotations[snap.rotations.length - 1].at === 15, `last=${snap.rotations[snap.rotations.length - 1].at}`);
  check("snapshot bounded false when floor > UNBOUNDED", snap.bounded === false);
  check("snapshot thresholds carried", snap.thresholds.autoK === 110 && snap.thresholds.confirmK === 90);
  check("snapshot floorTrend passed through", snap.floorTrend.length === 1);
  check("snapshot bounded true when floor < UNBOUNDED", buildRotationSnapshot({ now: 999, currentFloorK: 80, floorTrend: [], rotationHistory: [], lastRotationAt: null, lastRotationOutcome: null, autoK: 110, confirmK: 90 }).bounded === true);
  check("snapshot bounded false when floor null", buildRotationSnapshot({ now: 999, currentFloorK: null, floorTrend: [], rotationHistory: [], lastRotationAt: null, lastRotationOutcome: null, autoK: 110, confirmK: 90 }).bounded === false);
}

// ── Part 1: rotationVerdict ──────────────────────────────────────────────────
{
  check("verdict bounded < WATCH", rotationVerdict(50, null) === "bounded");
  check("verdict bounded == WATCH-1", rotationVerdict(ROTATION_WATCH_K - 1, null) === "bounded");
  check("verdict watch == WATCH", rotationVerdict(ROTATION_WATCH_K, null) === "watch");
  check("verdict watch == UNBOUNDED (boundary)", rotationVerdict(ROTATION_UNBOUNDED_K, null) === "watch");
  check("verdict unbounded > UNBOUNDED", rotationVerdict(ROTATION_UNBOUNDED_K + 1, null) === "unbounded");
  check("verdict watch when floor null", rotationVerdict(null, null) === "watch");
  check("verdict unbounded when lastOutcome fail (low floor)", rotationVerdict(50, "fail") === "unbounded");
  check("verdict unbounded when lastOutcome fail (null floor)", rotationVerdict(null, "fail") === "unbounded");
  check("verdict ignores success outcome (bounded floor)", rotationVerdict(50, "success") === "bounded");
}

// ── Part 1: snapshot file (atomic write + read + missing) ──────────────────
{
  const file = join("/tmp/opencode", `rotation-health-${process.pid}.json`);
  await rm(file, { force: true });
  check("readRotationHealth missing → null", readRotationHealth(file) === null);
  const snap = buildRotationSnapshot({ now: 12345, currentFloorK: 95, floorTrend: [{ day: "2026-01-01", min: 1, max: 2 }], rotationHistory: [{ at: 1, floorK: 90, tier: "auto", outcome: "success", newFloorK: 0 }], lastRotationAt: 1, lastRotationOutcome: "success", autoK: 110, confirmK: 90 });
  writeRotationHealth(file, snap);
  const back = readRotationHealth(file);
  check("write+read round-trips", back !== null && back.now === 12345 && back.currentFloorK === 95 && back.rotations.length === 1, back ? JSON.stringify(back) : "null");
  check("rotationHealthPath sits in stateFile's dir", rotationHealthPath("/some/dir/state.json") === "/some/dir/rotation-health.json", rotationHealthPath("/some/dir/state.json"));
  await rm(file, { force: true });
}

// ── Part 1: renderRotationReport (bounded/watch/unbounded + HTML sanity) ─────
{
  const base = {
    now: Date.now(),
    floorTrend: [{ day: "2026-01-01", min: 10, max: 20 }],
    rotations: [{ at: Date.now() - 3600_000, floorK: 110, tier: "auto" as const, outcome: "success" as const, newFloorK: 0 }],
    lastRotationAt: Date.now() - 3600_000,
    thresholds: { autoK: 110, confirmK: 90 },
  };
  const bounded = renderRotationReport({ ...base, currentFloorK: 50, lastRotationOutcome: "success" as const, bounded: true });
  check("report(bounded) shows floor + verdict", bounded.includes("Nền hiện tại: ~50K") && bounded.includes("bounded"), bounded);
  const watch = renderRotationReport({ ...base, currentFloorK: 110, lastRotationOutcome: "success" as const, bounded: false });
  check("report(watch) shows theo dõi", watch.includes("theo dõi"), watch);
  const unbounded = renderRotationReport({ ...base, currentFloorK: 130, lastRotationOutcome: "fail" as const, bounded: false });
  check("report(unbounded) shows vượt ngưỡng", unbounded.includes("vượt ngưỡng"), unbounded);
  const b = (bounded.match(/<b>/g) ?? []).length, bc = (bounded.match(/<\/b>/g) ?? []).length;
  check("report balanced <b> tags", b === bc, `${b} vs ${bc}`);
  const body = bounded.replace(/<\/?b>/g, "").replace(/<\/?(pre|code)><\/?(code|pre)>/g, "");
  check("report has no raw < (all escaped)", !body.includes("<"), body);
}

// ── Part 1: persisted fields survive a restart (StateManager round-trip) ────
{
  const file = join("/tmp/opencode", `rotation-state-${process.pid}.json`);
  await rm(file, { force: true });
  const st = new StateManager(file);
  st.set("m", {
    manager: true,
    sessionID: "ses_mgr",
    rotationHistory: [{ at: 1, floorK: 110, tier: "auto", outcome: "success", newFloorK: 0 }],
    floorTrend: [{ day: "2026-01-01", min: 10, max: 20 }],
  });
  const st2 = new StateManager(file); // simulate a bot restart
  const s2 = st2.get("m");
  check("rotationHistory survives restart", s2.rotationHistory?.length === 1 && s2.rotationHistory![0].floorK === 110, JSON.stringify(s2.rotationHistory));
  check("floorTrend survives restart", s2.floorTrend?.length === 1 && s2.floorTrend![0].max === 20, JSON.stringify(s2.floorTrend));
  await rm(file, { force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll rotation checks passed.");
