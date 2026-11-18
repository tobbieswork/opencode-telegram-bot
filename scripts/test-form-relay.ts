/**
 * Checks the "typed answer" consumption guard for relayed question forms
 * (formAcceptsTypedAnswer in src/bot.ts). Once the user taps "✍️ Gõ tự do…"
 * (typed-answer mode), the next plain message is consumed for the worker in
 * both the worker's own topic and the SHARED main channel — with or without
 * a reply to the question card (a reply is no longer required; the trade-off
 * is that a manager prompt typed meanwhile goes to the worker, and the form
 * can be dismissed with ❌ Huỷ). A card that was never delivered (no
 * messageId) still refuses to consume. Pure logic — no bot, no Telegram.
 *
 * Run:  npx tsx scripts/test-form-relay.ts
 */
import { formAcceptsTypedAnswer } from "../src/bot.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const WORKER = "100:200"; // the worker's own forum topic
const MAIN = "100"; // the shared main channel (chatOf(WORKER)) where the card is relayed
const CARD = 555; // the question card's message_id in MAIN

// A form in "typed answer" mode, card delivered to the main channel.
const qf = { conv: WORKER, relayConv: MAIN, messageId: CARD, waitingCustom: 0 };

// ── worker's own topic: always consumed (the user is talking to the worker) ──
{
  check("worker topic, typed, no reply → consumed", formAcceptsTypedAnswer(qf, WORKER, undefined) === true);
  check("worker topic, typed, reply to card → consumed", formAcceptsTypedAnswer(qf, WORKER, CARD) === true);
  check("worker topic, typed, reply to other msg → consumed", formAcceptsTypedAnswer(qf, WORKER, 999) === true);
}

// ── shared main channel: consumed regardless of reply (typed mode is explicit) ──
{
  check("main channel, typed, reply to card → consumed", formAcceptsTypedAnswer(qf, MAIN, CARD) === true);
  check("main channel, typed, no reply → consumed", formAcceptsTypedAnswer(qf, MAIN, undefined) === true);
  check("main channel, typed, reply to other msg → consumed", formAcceptsTypedAnswer(qf, MAIN, 999) === true);
}

// ── not in typed mode: never consumed (button answers don't go through here) ──
{
  const idle = { ...qf, waitingCustom: undefined };
  check("idle (not typed), worker topic → NOT consumed", formAcceptsTypedAnswer(idle, WORKER, CARD) === false);
  check("idle (not typed), main channel reply to card → NOT consumed", formAcceptsTypedAnswer(idle, MAIN, CARD) === false);
}

// ── an unrelated conversation: never consumed ─────────────────────────────────
{
  check("unrelated topic in same chat → NOT consumed", formAcceptsTypedAnswer(qf, "100:300", CARD) === false);
  check("unrelated chat → NOT consumed", formAcceptsTypedAnswer(qf, "777", CARD) === false);
}

// ── worker already sits in the main chat (conv === relayConv) ─────────────────
{
  const inMain = { conv: MAIN, relayConv: MAIN, messageId: CARD, waitingCustom: 0 };
  // There is no separate manager channel to protect — any text here is for the worker.
  check("worker in main chat, no reply → consumed", formAcceptsTypedAnswer(inMain, MAIN, undefined) === true);
}

// ── card never delivered in the main channel (no messageId) → NOT consumed ────
{
  const noCard = { conv: WORKER, relayConv: MAIN, messageId: undefined, waitingCustom: 0 };
  check("main channel, reply but no card id → NOT consumed", formAcceptsTypedAnswer(noCard, MAIN, CARD) === false);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
