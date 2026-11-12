/**
 * src/busy.ts checks (docs/sdd/queue-and-steer.md, phase 2):
 *   - buildBusyReply for all three modes — "off" is byte-identical to today's
 *     reply (BUSY_REPLY_TEXT + the single note button, exact keyboard shape);
 *   - "ask" layout: Queue + Steer now + note, in order; canSteer:false omits
 *     the Steer button; no messageId → no buttons at all;
 *   - "queue" status line (with the "you are #N" position) keeps only the note
 *     button; queueFullReply keeps the message available via the note button;
 *   - q:add:/q:steer: callback data: encode/parse round-trips, foreign and
 *     malformed data rejected, no collision with note:<id>, 64-byte cap.
 *
 * Run:  npx tsx scripts/test-busy.ts
 */
import { BUSY_REPLY_TEXT, noteButtonLabel, noteCallbackData, parseNoteCallback } from "../src/notes.js";
import type { Keyboard } from "../src/shared.js";
import {
  buildBusyReply,
  queueFullReply,
  queueFullText,
  busyKeyboard,
  addCallbackData,
  steerCallbackData,
  parseBusyCallback,
  queueButtonLabel,
  steerButtonLabel,
} from "../src/busy.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const ID = 12345;

// ── "off" mode: byte-identical to today (Q2.7) ───────────────────────────────
{
  const r = buildBusyReply({ lang: "vi", mode: "off", messageId: ID });
  check("off: text is exactly BUSY_REPLY_TEXT", r.text === BUSY_REPLY_TEXT, JSON.stringify(r.text));
  check("off: exactly one button", r.buttons.length === 1, JSON.stringify(r.buttons));
  check("off: button is the note button (label)", r.buttons[0].text === noteButtonLabel("vi"), r.buttons[0].text);
  check("off: button callback is note:<id>", r.buttons[0].callback === noteCallbackData(ID), r.buttons[0].callback);
  // The exact keyboard the pre-queue inline code produced:
  const legacy: Keyboard = { inline_keyboard: [[{ text: noteButtonLabel("vi"), callback_data: noteCallbackData(ID) }]] };
  check("off: keyboard byte-identical to the legacy inline construction", JSON.stringify(busyKeyboard(r.buttons)) === JSON.stringify(legacy));

  const ren = buildBusyReply({ lang: "en", mode: "off", messageId: ID });
  check("off (en): text unchanged, label localized", ren.text === BUSY_REPLY_TEXT && ren.buttons[0].text === noteButtonLabel("en"));

  const r0 = buildBusyReply({ lang: "vi", mode: "off" });
  check("off, no messageId: plain text, no buttons", r0.text === BUSY_REPLY_TEXT && r0.buttons.length === 0 && busyKeyboard(r0.buttons) === undefined);
}

// ── "ask" mode: Queue + Steer now + note ─────────────────────────────────────
{
  const r = buildBusyReply({ lang: "vi", mode: "ask", messageId: ID });
  check("ask: busy text kept", r.text === BUSY_REPLY_TEXT, JSON.stringify(r.text));
  check("ask: three buttons in order", r.buttons.length === 3, JSON.stringify(r.buttons));
  check("ask: [0] is Queue", r.buttons[0].text === queueButtonLabel("vi") && r.buttons[0].callback === addCallbackData(ID), JSON.stringify(r.buttons[0]));
  check("ask: [1] is Steer now", r.buttons[1].text === steerButtonLabel("vi") && r.buttons[1].callback === steerCallbackData(ID), JSON.stringify(r.buttons[1]));
  check("ask: [2] is the note button", r.buttons[2].text === noteButtonLabel("vi") && r.buttons[2].callback === noteCallbackData(ID), JSON.stringify(r.buttons[2]));

  const r2 = buildBusyReply({ lang: "vi", mode: "ask", messageId: ID, canSteer: false });
  check("ask + canSteer:false: two buttons, no Steer", r2.buttons.length === 2 && !r2.buttons.some((b) => b.callback.startsWith("q:steer:")), JSON.stringify(r2.buttons));
  check("ask + canSteer:false: order is Queue then note", r2.buttons[0].callback === addCallbackData(ID) && r2.buttons[1].callback === noteCallbackData(ID));

  const ren = buildBusyReply({ lang: "en", mode: "ask", messageId: ID });
  check("ask (en): English labels", ren.buttons.map((b) => b.text).join("|") === [queueButtonLabel("en"), steerButtonLabel("en"), noteButtonLabel("en")].join("|"), JSON.stringify(ren.buttons));

  const r0 = buildBusyReply({ lang: "vi", mode: "ask" });
  check("ask, no messageId: no buttons", r0.buttons.length === 0 && r0.text === BUSY_REPLY_TEXT);
}

// ── "queue" mode: status line + note button only ─────────────────────────────
{
  const r = buildBusyReply({ lang: "vi", mode: "queue", messageId: ID, queuedCount: 2 });
  check("queue: vi status line with position", r.text === "📥 Đã thêm vào hàng chờ (vị trí #2). Sẽ chạy sau khi tin hiện tại xong.", JSON.stringify(r.text));
  check("queue: only the note button", r.buttons.length === 1 && r.buttons[0].callback === noteCallbackData(ID), JSON.stringify(r.buttons));

  const ren = buildBusyReply({ lang: "en", mode: "queue", messageId: ID, queuedCount: 3 });
  check("queue: en status line with position", ren.text === "📥 Added to the queue (position #3). It will run after the current message finishes.", JSON.stringify(ren.text));

  const r0 = buildBusyReply({ lang: "vi", mode: "queue", messageId: ID });
  check("queue, no position: plain status line", r0.text === "📥 Đã thêm vào hàng chờ. Sẽ chạy sau khi tin hiện tại xong.", JSON.stringify(r0.text));

  const r1 = buildBusyReply({ lang: "vi", mode: "queue" });
  check("queue, no messageId: no buttons", r1.buttons.length === 0);
}

// ── queue full: never drop silently — the note button stays ──────────────────
{
  check("queueFullText vi", queueFullText("vi") === "⚠️ Hàng chờ đã đầy (3 tin).", queueFullText("vi"));
  check("queueFullText en", queueFullText("en") === "⚠️ Queue is full (3 messages).", queueFullText("en"));
  const r = queueFullReply({ lang: "vi", messageId: ID });
  check("queueFullReply: text + note button only", r.text === queueFullText("vi") && r.buttons.length === 1 && r.buttons[0].callback === noteCallbackData(ID), JSON.stringify(r));
  check("queueFullReply, no messageId: no buttons", queueFullReply({ lang: "vi" }).buttons.length === 0);
}

// ── addCallbackData / steerCallbackData: encoding ────────────────────────────
{
  check("addCallbackData encodes q:add:<id>", addCallbackData(12345) === "q:add:12345", addCallbackData(12345));
  check("addCallbackData id 0", addCallbackData(0) === "q:add:0");
  check("steerCallbackData encodes q:steer:<id>", steerCallbackData(12345) === "q:steer:12345", steerCallbackData(12345));
  check("fits Telegram's 64-byte cap for a realistic max id", Buffer.byteLength(steerCallbackData(9_999_999_999), "utf8") <= 64, String(Buffer.byteLength(steerCallbackData(9_999_999_999), "utf8")));
}

// ── parseBusyCallback: round-trips, rejects foreign/malformed data ───────────
{
  check("round-trips q:add", JSON.stringify(parseBusyCallback(addCallbackData(12345))) === JSON.stringify({ kind: "add", messageId: 12345 }));
  check("round-trips q:steer", JSON.stringify(parseBusyCallback(steerCallbackData(987))) === JSON.stringify({ kind: "steer", messageId: 987 }));
  check("round-trips id 0", parseBusyCallback("q:add:0")?.messageId === 0);

  check("rejects a bare q: prefix (q:123)", parseBusyCallback("q:123") === null);
  check("rejects an unknown q: sub-prefix (q:foo:1)", parseBusyCallback("q:foo:1") === null);
  check("rejects an empty id (q:add:)", parseBusyCallback("q:add:") === null);
  check("rejects a non-numeric id (q:add:abc)", parseBusyCallback("q:add:abc") === null);
  check("rejects a negative id (q:steer:-5)", parseBusyCallback("q:steer:-5") === null);
  check("rejects a decimal id (q:add:1.5)", parseBusyCallback("q:add:1.5") === null);
  check("rejects trailing junk (q:steer:12abc)", parseBusyCallback("q:steer:12abc") === null);
  check("rejects undefined", parseBusyCallback(undefined) === null);
  check("rejects the empty string", parseBusyCallback("") === null);
}

// ── no collision with the existing note:<id> callback ────────────────────────
{
  check("parseBusyCallback rejects note:<id>", parseBusyCallback(noteCallbackData(ID)) === null);
  check("parseNoteCallback rejects q:add:<id>", parseNoteCallback(addCallbackData(ID)) === null);
  check("parseNoteCallback rejects q:steer:<id>", parseNoteCallback(steerCallbackData(ID)) === null);
  check("the q: prefix differs from the note: prefix", !addCallbackData(1).startsWith("note:") && !steerCallbackData(1).startsWith("note:"));
}

// ── busyKeyboard: one row, callback_data mapping, empty → undefined ──────────
{
  check("empty buttons → undefined keyboard", busyKeyboard([]) === undefined);
  const kb = busyKeyboard(buildBusyReply({ lang: "vi", mode: "ask", messageId: ID }).buttons);
  check("keyboard is one row of 3", kb !== undefined && kb.inline_keyboard.length === 1 && kb.inline_keyboard[0].length === 3, JSON.stringify(kb));
  check("buttons map callback → callback_data", JSON.stringify(kb) ===
    JSON.stringify({ inline_keyboard: [[
      { text: queueButtonLabel("vi"), callback_data: "q:add:" + ID },
      { text: steerButtonLabel("vi"), callback_data: "q:steer:" + ID },
      { text: noteButtonLabel("vi"), callback_data: "note:" + ID },
    ]] }));
}

console.log(failures === 0 ? "\nall busy-reply checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
