/**
 * Checks the pure stage machine behind `/note` (scratchpad notes written while
 * the agent is busy): append + cap, the one-turn visibility contract
 * (pending → shown → retired), re-arming when a new note arrives during the
 * visible turn, and the /new drop patch.
 *
 * Run:  npx tsx scripts/test-notes.ts
 */
import { appendNote, dropNotes, noteEntryText, NOTE_MAX_CHARS, prepareNotes, showNotes } from "../src/notes.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const T0 = Date.parse("2026-10-26T21:00:00Z");

// ── appendNote: lines accumulate, stage always re-arms to "pending" ─────────
{
  const s1 = appendNote({}, "hello", T0);
  check("first note is pending", s1.notesStage === "pending" && s1.notes === "- 21:00: hello", JSON.stringify(s1));
  const s2 = appendNote(s1, "second", T0 + 5 * 60000);
  check("second note appends a line", s2.notes === "- 21:00: hello\n- 21:05: second" && s2.notesStage === "pending", JSON.stringify(s2.notes));
  const s3 = appendNote(s2, "  padded  ", T0 + 60000);
  check("note text is trimmed", s3.notes!.endsWith("- 21:01: padded"), JSON.stringify(s3.notes));
}

// ── appendNote: size cap trims the oldest characters ────────────────────────
{
  const s = appendNote({ notes: "old".repeat(1000) }, "tail-marker", T0);
  check("cap enforced", s.notes!.length <= NOTE_MAX_CHARS, String(s.notes!.length));
  check("newest line survives the trim", s.notes!.includes("tail-marker"));
}

// ── showNotes ───────────────────────────────────────────────────────────────
{
  check("showNotes returns the text", showNotes({ notes: "x" }) === "x");
  check("showNotes empty → null", showNotes({}) === null && showNotes({ notes: "" }) === null);
}

// ── prepareNotes: the one-turn visibility contract ──────────────────────────
{
  const s = appendNote({}, "hello", T0);
  const p1 = prepareNotes(s);
  check("pending → PUT entry", typeof p1.put === "string" && p1.put!.includes("- 21:00: hello") && !p1.remove, JSON.stringify(p1));
  check("pending → marked shown", p1.state.notesStage === "shown" && p1.state.notes === s.notes, JSON.stringify(p1.state));

  const p2 = prepareNotes(p1.state);
  check("shown (no new note) → RETIRE", p2.remove === true && p2.put === undefined, JSON.stringify(p2));
  check("retired state is clean", p2.state.notes === undefined && p2.state.notesStage === undefined, JSON.stringify(p2.state));

  const p3 = prepareNotes(p2.state);
  check("empty state → no-op", p3.put === undefined && p3.remove === undefined && p3.state.notes === undefined);
}

// ── prepareNotes: a note written DURING the visible turn survives ───────────
{
  const s1 = appendNote({}, "first", T0);
  const shown = prepareNotes(s1); // visible turn starts
  const s2 = appendNote(shown.state, "second", T0 + 60000); // user writes mid-turn
  check("mid-turn note re-arms to pending", s2.notesStage === "pending" && s2.notes!.includes("second"), JSON.stringify(s2));
  const p = prepareNotes(s2);
  check("re-armed → PUT again (both notes)", typeof p.put === "string" && p.put!.includes("first") && p.put!.includes("second"));
  check("still marked shown for the next retirement", p.state.notesStage === "shown");
}

// ── dropNotes: the /new patch ───────────────────────────────────────────────
{
  const s = appendNote({}, "stale", T0);
  const merged = { ...s, ...dropNotes() };
  check("dropNotes clears notes + stage", merged.notes === undefined && merged.notesStage === undefined);
}

// ── noteEntryText: self-describing for the model ────────────────────────────
{
  const t = noteEntryText("- 21:00: abc");
  check("entry contains the notes", t.includes("- 21:00: abc"));
  check("entry is self-describing", t.includes("/note") && t.includes("Ghi chú của người dùng"));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
