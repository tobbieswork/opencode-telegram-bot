/**
 * Checks the pure decision logic behind the "⏯ Chạy tiếp" (continue) button:
 * when a turn ends, decide whether to offer the button, how to encode/parse its
 * callback data (bounded by Telegram's 64-byte cap), and the anti-spam dedupe so
 * one failed turn never offers the button twice.
 *
 * Run:  npx tsx scripts/test-continue.ts
 */
import {
  CONTINUE_PROMPT,
  CONTINUE_BUTTON_LABEL,
  CONTINUE_CB_PREFIX,
  CALLBACK_DATA_MAX_BYTES,
  shouldOfferContinue,
  continueCallbackData,
  parseContinueData,
  alreadyOfferedContinue,
} from "../src/continue.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── shouldOfferContinue: only a genuine failure (NOT a user /stop) ──────────
{
  check("failed + not interrupted → offer", shouldOfferContinue({ outcome: "failed", interrupted: false }) === true);
  check("failed + interrupted (/stop) → no offer", shouldOfferContinue({ outcome: "failed", interrupted: true }) === false);
  check("succeeded → no offer", shouldOfferContinue({ outcome: "succeeded", interrupted: false }) === false);
  check("interrupted, no outcome → no offer", shouldOfferContinue({ outcome: undefined, interrupted: true }) === false);
  check("no outcome, not interrupted → no offer", shouldOfferContinue({ outcome: undefined, interrupted: false }) === false);
  check("unknown outcome → no offer", shouldOfferContinue({ outcome: "stopped", interrupted: false }) === false);
}

// ── continueCallbackData: encodes the session, bounded at 64 bytes ───────────
{
  const ses = "ses_e9e427328ffekR4DYZT51sVe8M"; // 32 chars, like a real id
  const data = continueCallbackData(ses);
  check("encodes as cont:<sessionID>", data === CONTINUE_CB_PREFIX + ses, data);
  check("fits under the 64-byte cap", data !== undefined && Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES);
  // The exact boundary: prefix is 5 bytes, so a 59-byte id → 64 (allowed), 60 → 65 (dropped).
  const fits = "s".repeat(CALLBACK_DATA_MAX_BYTES - CONTINUE_CB_PREFIX.length); // 59
  const tooLong = "s".repeat(CALLBACK_DATA_MAX_BYTES - CONTINUE_CB_PREFIX.length + 1); // 60
  check("boundary: 64-byte payload is kept", continueCallbackData(fits) !== undefined);
  check("boundary: 65-byte payload is dropped", continueCallbackData(tooLong) === undefined);
}

// ── parseContinueData: round-trips, rejects foreign/malformed data ───────────
{
  const ses = "ses_abc123XYZ";
  check("round-trips a valid id", parseContinueData(continueCallbackData(ses)) === ses);
  check("rejects a foreign prefix (pb:go)", parseContinueData("pb:go") === undefined);
  check("rejects an fq: button", parseContinueData("fq:f1:o0") === undefined);
  check("rejects a bare prefix (empty id)", parseContinueData(CONTINUE_CB_PREFIX) === undefined);
  check("rejects undefined data", parseContinueData(undefined) === undefined);
  check("rejects empty string", parseContinueData("") === undefined);
}

// ── alreadyOfferedContinue: one failure → one button ─────────────────────────
{
  check("same turn id → already offered (dedupe)", alreadyOfferedContinue("turn-1", "turn-1") === true);
  check("different turn id → not yet (new failure may offer)", alreadyOfferedContinue("turn-1", "turn-2") === false);
  check("never offered (undefined) → not yet", alreadyOfferedContinue(undefined, "turn-1") === false);
}

// ── end-to-end dedupe shape: offer for a fresh turn, not again for the same ──
{
  // Simulate the bot's offer loop for one conv across two turns of one session.
  const sessionID = "ses_e9e427328ffekR4DYZT51sVe8M";
  let lastOffered: string | undefined;
  const offer = (turnId: string): string | undefined => {
    if (!shouldOfferContinue({ outcome: "failed", interrupted: false })) return undefined;
    const data = continueCallbackData(sessionID);
    if (!data) return undefined;
    if (alreadyOfferedContinue(lastOffered, turnId)) return undefined;
    lastOffered = turnId;
    return data;
  };
  const first = offer("turn-1");
  const sameTurn = offer("turn-1");
  const nextTurn = offer("turn-2");
  check("fresh turn offers a button", first === CONTINUE_CB_PREFIX + sessionID);
  check("re-offering the SAME turn is blocked", sameTurn === undefined);
  check("a NEW turn still offers", nextTurn === CONTINUE_CB_PREFIX + sessionID);
}

// ── the user-facing strings are pinned ────────────────────────────────────────
{
  check("continue prompt is the one-liner", CONTINUE_PROMPT === "Tiếp tục phần còn lại, không hỏi lại.", CONTINUE_PROMPT);
  check("button label is Vietnamese", CONTINUE_BUTTON_LABEL === "⏯ Chạy tiếp", CONTINUE_BUTTON_LABEL);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
