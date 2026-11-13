/**
 * Next-step residual is keyed by MESSAGE, not by conversation (fix for the
 * 24h-review nit: a tap on a stale next-step row must restore ITS OWN message's
 * residual, not the newest row's).
 *
 *   - a worktree card row (residual = the card's own Diff/Merge/Delete) stays
 *     tappable and reverts to its own buttons, even after a newer row is offered;
 *   - a tap on a row that has no residual of its own reverts to NO buttons —
 *     never the previous row's residual (the old conv-key let it leak through);
 *   - a new offer never drops a still-live row's residual.
 *
 * Runs against a mock Bot + a temp audit file (no live Telegram / OpenCode).
 * Run:  npx tsx scripts/test-nextstep-residual.ts
 */
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { registry as nsRegistry, callbackFor } from "../src/nextsteps.js";
import type { Keyboard } from "../src/shared.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-nres-"));
const auditFile = join(tmp, "audit.log");
configureAudit({ path: auditFile });
const NOW = Date.now();
const CONV = "42";

const CARD_A: Keyboard = { inline_keyboard: [[{ text: "Diff", callback_data: "w:1:d" }]] };
const CARD_B: Keyboard = { inline_keyboard: [[{ text: "Merge", callback_data: "w:2:m" }]] };

let caseN = 0;
function makeBot() {
  caseN++;
  const dir = join(tmp, `case${caseN}`);
  mkdirSync(dir, { recursive: true });
  const edits: Array<{ conv: string; id: number; markup: Keyboard }> = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async () => 1,
    sendMessageId: async () => 1,
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    editMessageReplyMarkup: async (conv: string, id: number, opts: { reply_markup: Keyboard }) => {
      edits.push({ conv, id, markup: opts.reply_markup });
    },
    answerCallbackQuery: async () => {},
    stop: () => {},
  };
  const oc: any = {
    prompt: async () => "msg_x",
    interrupt: async () => {},
    createSession: async () => "ses_1",
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(dir, "state.json"));
  const cfg: any = { stateFile: join(dir, "state.json"), maxSchedules: 5, busyMode: "ask", nextSteps: true, nextMinSecs: 0, maxWorkers: 5 };
  const bot = new Bot(tg, oc, st, cfg);
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  // Neutralize the post-residual action so only the markup edit is observed.
  (bot as any).orch.cmdBoard = async () => "board-out";
  (bot as any).runPrompt = async () => {};
  (bot as any).cmdNew = async () => {};
  return { bot, edits, st };
}

/** Register a next-step row on `msgId` (residual optional) and return a tappable registry id. */
function offer(bot: Bot, st: StateManager, msgId: number, residual?: Keyboard): string {
  (bot as any).noteNextStepMessage(CONV, msgId, residual);
  return nsRegistry.set({ conv: CONV, sessionID: "ses_1", rule: "board", now: NOW });
}

async function tap(bot: Bot, id: string, msgId: number): Promise<void> {
  await (bot as any).handleNextStepCallback({ id: "cb" + msgId, data: callbackFor(id, 0), from: { id: 7 } } as any, CONV, msgId);
}

// ── 1. A card row keeps its own residual even after a newer card row is offered.
{
  const { bot, edits, st } = makeBot();
  st.set(CONV, { sessionID: "ses_1" });
  const idA = offer(bot, st, 100, CARD_A); // older worktree card
  const idB = offer(bot, st, 105, CARD_B); // newer worktree card
  check("two residuals are kept per message", (bot as any).nextStepResiduals.size === 2, String((bot as any).nextStepResiduals.size));

  await tap(bot, idA, 100); // tap the STALE card row
  const on100 = edits.find((e) => e.id === 100);
  check("stale-card tap restores ITS OWN buttons (not the newer row's)", !!on100 && on100.markup === CARD_A, JSON.stringify(on100?.markup));
  check("…and the newer row's message is left alone", !edits.some((e) => e.id === 105));

  // The newer card is still live and tappable with its own residual.
  const on105 = await (async () => { await tap(bot, idB, 105); return edits.find((e) => e.id === 105); })();
  check("newer-card tap restores its own buttons", !!on105 && on105.markup === CARD_B, JSON.stringify(on105?.markup));
}

// ── 2. A row with no residual of its own reverts to NO buttons (not the prior row's).
{
  const { bot, edits, st } = makeBot();
  st.set(CONV, { sessionID: "ses_1" });
  const idCard = offer(bot, st, 100, CARD_A); // a card with its own buttons
  const idPlain = offer(bot, st, 105);          // a plain footer row (no residual)
  check("a residual-less row is offered alongside the card", (bot as any).nextStepResiduals.size === 1, String((bot as any).nextStepResiduals.size));

  await tap(bot, idPlain, 105);
  const on105 = edits.find((e) => e.id === 105);
  check("residual-less row tap reverts to NO buttons", !!on105 && on105.markup.inline_keyboard.length === 0, JSON.stringify(on105?.markup));
  check("…and the card row's residual is NOT leaked to it", !!on105 && on105.markup !== CARD_A);

  // The card is still intact after the plain row was tapped.
  const on100 = edits.find((e) => e.id === 100);
  check("card row untouched by the plain-row tap", !on100);
  void idCard;
}

// ── 3. Dismiss (N3.7) reverts the conv's current footer to its OWN residual.
{
  const { bot, edits, st } = makeBot();
  st.set(CONV, { sessionID: "ses_1" });
  offer(bot, st, 100, CARD_A); // footer is now 100 (the card)
  (bot as any).dismissNextStepKeyboard(CONV);
  const on100 = edits.find((e) => e.id === 100);
  check("dismiss reverts the card to its own buttons", !!on100 && on100.markup === CARD_A, JSON.stringify(on100?.markup));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
