/**
 * Unit tests for the pure streaming-draft state machine (src/stream.ts):
 *   - newDraftID: always non-zero, monotonic increment.
 *   - onTextDelta: first delta emits immediately (lastSentAt=0); per-part
 *     throttle boundary (1499 vs 1500 ms); text accumulates within a part;
 *     part id rollover → fresh draft + text reset (no carry-over); 4096-char
 *     tail (exactly 4096 unchanged, 4097 → last 4096).
 *   - onToolStart: visible text → "Thinking…" placeholder on the SAME draft_id
 *     (throttled); null state / empty text → no action.
 *
 * I/O paths (the actual sendMessageDraft calls) are NOT unit-tested, per repo
 * convention (pure logic only).
 *
 * Run:  npx tsx scripts/test-stream.ts
 */
import { DraftState, onTextDelta, onToolStart, newDraftID } from "../src/stream.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// A realistic wall-clock ms value, so `now - 0 >= throttleMs` is trivially true
// (this is what makes the first delta of a part emit immediately).
const WALL = 1_700_000_000_000;

// ── newDraftID ────────────────────────────────────────────────────────────────
check("newDraftID() → 1", newDraftID() === 1);
check("newDraftID(1) → 2", newDraftID(1) === 2);
check("newDraftID(5) → 6", newDraftID(5) === 6);
check("newDraftID(0) → 1 (never zero)", newDraftID(0) === 1);
check("newDraftID always non-zero", newDraftID() > 0 && newDraftID(42) > 0);

// ── first delta emits immediately (lastSentAt = 0) ───────────────────────────
const r0 = onTextDelta(null, "p1", "Hello", WALL);
check("first delta emits immediately (lastSentAt=0)", r0.action !== undefined);
check("first delta action text", r0.action?.text === "Hello");
check("first delta draftID = 1", r0.state.draftID === 1);
check("first delta partID recorded", r0.state.partID === "p1");
check("first delta text accumulated", r0.state.text === "Hello");
check("first delta lastSentAt set to now", r0.state.lastSentAt === WALL);

// ── per-part throttle boundary (1499 vs 1500) ────────────────────────────────
// r0.state.lastSentAt === WALL, so "t=0" here is the moment the last draft sent.
check("throttle: +100ms → no action", onTextDelta(r0.state, "p1", "x", WALL + 100).action === undefined);
check("throttle: +1499ms → no action", onTextDelta(r0.state, "p1", "x", WALL + 1499).action === undefined);
const rT = onTextDelta(r0.state, "p1", "x", WALL + 1500);
check("throttle: +1500ms → action", rT.action !== undefined);
check("throttle: +1500ms action carries accumulated text", rT.action?.text === "Hellox");
const rNo = onTextDelta(r0.state, "p1", "x", WALL + 100);
check("throttled delta does not advance lastSentAt", rNo.state.lastSentAt === WALL);

// ── text accumulates across deltas within one part (while throttled) ─────────
let acc = onTextDelta(null, "p1", "Hel", 1_000_000).state;
acc = onTextDelta(acc, "p1", "lo ", 1_000_001).state;
acc = onTextDelta(acc, "p1", "world", 1_000_002).state;
check("text accumulates across deltas within a part", acc.text === "Hello world");

// ── part id rollover → fresh draft, text reset (no carry-over) ───────────────
const rol = onTextDelta(null, "p1", "First", 1_000_000).state;
check("rollover: initial draftID", rol.draftID === 1);
check("rollover: initial text", rol.text === "First");
const rol2 = onTextDelta(rol, "p2", "Second", 2_000_000);
check("rollover: new draftID (monotonic)", rol2.state.draftID === 2);
check("rollover: partID updated", rol2.state.partID === "p2");
check("rollover: text reset (old text not carried over)", rol2.state.text === "Second");
check("rollover: action emitted for the new draft", rol2.action !== undefined);
check("rollover: action uses the new draftID", rol2.action?.draftID === 2);
check("rollover: action text is the new part only", rol2.action?.text === "Second");

// ── 4096-char tail ───────────────────────────────────────────────────────────
const exact = "a".repeat(4096);
const rExact = onTextDelta(null, "p1", exact, 1_000_000);
check("tail: exactly 4096 unchanged", rExact.action?.text === exact);
check("tail: exactly 4096 → length 4096", rExact.action?.text?.length === 4096);
const over = "X" + "a".repeat(4096); // 4097 chars, oldest = 'X'
const rOver = onTextDelta(null, "p1", over, 1_000_000);
check("tail: 4097 → last 4096 (drops oldest)", rOver.action?.text === "a".repeat(4096));
check("tail: 4097 → length 4096", rOver.action?.text?.length === 4096);

// ── onToolStart: visible text → Thinking… on the SAME draft_id ───────────────
const stText: DraftState = { partID: "p1", draftID: 7, text: "Some visible text", lastSentAt: 0 };
const rTool = onToolStart(stText, 1_000_000);
check("tool start → action", rTool.action !== undefined);
check("tool start → SAME draftID (animated transition)", rTool.action?.draftID === 7);
check("tool start → empty text (Thinking… placeholder)", rTool.action?.text === "");
check("tool start → lastSentAt advanced (throttle)", rTool.state?.lastSentAt === 1_000_000);
check("tool start → partID/text preserved", rTool.state?.partID === "p1" && rTool.state?.text === "Some visible text");
const rToolSoon = onToolStart(rTool.state, 1_000_100);
check("tool start throttled (within window) → no action", rToolSoon.action === undefined);
const rToolLate = onToolStart(rTool.state, 1_000_1500);
check("tool start after window → action again", rToolLate.action !== undefined);

// ── onToolStart: null state / empty text → no action ─────────────────────────
const rNull = onToolStart(null, 1_000_000);
check("tool start with null state → no action", rNull.action === undefined);
check("tool start with null state → state stays null", rNull.state === null);
const stEmpty: DraftState = { partID: "p1", draftID: 3, text: "", lastSentAt: 0 };
const rEmpty = onToolStart(stEmpty, 1_000_000);
check("tool start with empty text → no action", rEmpty.action === undefined);
check("tool start with empty text → state preserved", rEmpty.state?.draftID === 3 && rEmpty.state?.partID === "p1");
check("tool start with empty text → lastSentAt unchanged", rEmpty.state?.lastSentAt === 0);

// ── end-to-end flow: stream → tool (Thinking…) → new part streams fresh ──────
let f = onTextDelta(null, "p1", "Let me check", 1_000_000).state; // lastSentAt=1_000_000
const fTool = onToolStart(f, 1_002_000); // 2000 ms later → passes throttle
check("flow: tool start flashes Thinking… (same draftID)", fTool.action?.text === "" && fTool.action?.draftID === 1);
const f2 = onTextDelta(fTool.state, "p2", "Done!", 1_003_000); // new part id
check("flow: new part → new draftID", f2.state.draftID === 2);
check("flow: new part → old text not carried over", f2.state.text === "Done!");
check("flow: new part → action emitted with fresh text", f2.action?.text === "Done!");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
