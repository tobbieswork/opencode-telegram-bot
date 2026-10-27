/**
 * Checks the pure helpers behind the "📝 Thêm vào note" busy-reply button:
 * encoding/parsing its callback data (round-trips, rejects foreign/malformed
 * data) and the capped per-conversation retention push (oldest dropped first).
 *
 * Run:  npx tsx scripts/test-notes-callback.ts
 */
import {
  NOTE_CB_PREFIX,
  NOTE_BUTTON_LABEL,
  NOTE_RETENTION_CAP,
  noteCallbackData,
  parseNoteCallback,
  pushBusyNote,
} from "../src/notes.js";
import type { BusyNoteEntry } from "../src/notes.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── noteCallbackData: encodes note:<messageId> ───────────────────────────────
{
  check("encodes as note:<id>", noteCallbackData(12345) === "note:12345", noteCallbackData(12345));
  check("encodes id 0", noteCallbackData(0) === "note:0");
  check("fits Telegram's 64-byte cap for a realistic max id", Buffer.byteLength(noteCallbackData(9_999_999_999), "utf8") <= 64);
}

// ── parseNoteCallback: round-trips, rejects foreign/malformed data ───────────
{
  check("round-trips a valid id", parseNoteCallback(noteCallbackData(12345)) === 12345);
  check("round-trips id 0", parseNoteCallback("note:0") === 0);
  check("rejects a foreign prefix (cont:…)", parseNoteCallback("cont:ses_abc") === null);
  check("rejects a foreign prefix (pb:go)", parseNoteCallback("pb:go") === null);
  check("rejects a bare prefix (empty id)", parseNoteCallback(NOTE_CB_PREFIX) === null);
  check("rejects a non-numeric id", parseNoteCallback("note:abc") === null);
  check("rejects an id with trailing junk", parseNoteCallback("note:12abc") === null);
  check("rejects a negative id", parseNoteCallback("note:-5") === null);
  check("rejects a decimal id", parseNoteCallback("note:1.5") === null);
  check("rejects undefined data", parseNoteCallback(undefined) === null);
  check("rejects an empty string", parseNoteCallback("") === null);
}

// ── pushBusyNote: caps at 10, drops the OLDEST first ─────────────────────────
{
  let list: BusyNoteEntry[] = [];
  for (let i = 1; i <= NOTE_RETENTION_CAP; i++) list = pushBusyNote(list, i, `msg ${i}`);
  check("keeps all entries up to the cap", list.length === NOTE_RETENTION_CAP, String(list.length));
  check("oldest is kept at the cap", list[0].id === 1, JSON.stringify(list.map((e) => e.id)));
  check("newest is appended", list[list.length - 1].id === NOTE_RETENTION_CAP);

  list = pushBusyNote(list, NOTE_RETENTION_CAP + 1, "msg 11");
  check("over cap → still capped", list.length === NOTE_RETENTION_CAP, String(list.length));
  check("oldest dropped", list[0].id === 2, JSON.stringify(list.map((e) => e.id)));
  check("newest kept", list[list.length - 1].id === NOTE_RETENTION_CAP + 1);

  let big: BusyNoteEntry[] = [];
  for (let i = 1; i <= NOTE_RETENTION_CAP + 5; i++) big = pushBusyNote(big, i, `m${i}`);
  check("15 pushes → 10 kept (ids 6..15)", big.length === 10 && big[0].id === 6 && big[big.length - 1].id === 15, JSON.stringify(big.map((e) => e.id)));

  const input: BusyNoteEntry[] = [{ id: 1, text: "a" }];
  pushBusyNote(input, 2, "b");
  check("input is not mutated", input.length === 1 && input[0].id === 1);
}

// ── the user-facing label is pinned ──────────────────────────────────────────
{
  check("button label is Vietnamese", NOTE_BUTTON_LABEL === "📝 Thêm vào note", NOTE_BUTTON_LABEL);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
