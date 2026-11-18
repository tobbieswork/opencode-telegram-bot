/**
 * Quick-replies auto-hide: when a reply carries a choices keyboard, the
 * PREVIOUS still-active choices keyboard in the same conv is hidden — its
 * registry record is deleted (a tap racing the edit answers "expired") and
 * its buttons are removed from the old message. A tapped keyboard (the ✓
 * history) is never clobbered; a reply without options leaves the previous
 * keyboard alone; convs are isolated.
 *
 * Runs against a mock Bot + the REAL sendReply / handleChoiceCallback
 * (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-suggest-hide.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { registry } from "../src/choices.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-qhide-"));
configureAudit({ path: join(tmp, "audit.log") });

interface SentMsg { id: number; text: string; opts?: Record<string, unknown> }
interface Edit { messageId: number; markup: Record<string, unknown> }

function makeBot() {
  const sent: SentMsg[] = [];
  const edits: Edit[] = [];
  const answers: string[] = [];
  let nextId = 100;
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_c: string, text: string) => (sent.push({ id: ++nextId, text }), nextId),
    sendMessageId: async (_c: string, text: string, opts?: Record<string, unknown>) => {
      const id = ++nextId;
      sent.push({ id, text, opts });
      return id;
    },
    sendRich: async (_c: string, text: string, opts?: Record<string, unknown>) => {
      const id = ++nextId;
      sent.push({ id, text, opts });
      return id;
    },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
    editMessageReplyMarkup: async (_c: string, messageId: number, markup: Record<string, unknown>) => {
      edits.push({ messageId, markup });
    },
    answerCallbackQuery: async () => {},
    stop: () => {},
  };
  const oc: any = {
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
    prompt: async () => "msg_x",
    interrupt: async () => {},
    createSession: async () => "ses_1",
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(tmp, "state.json"));
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode: "ask", suggest: true, replyMaxLen: 3000 };
  const bot = new Bot(tg, oc, st, cfg);
  (bot as any).runPrompt = async (conv: string, text: string) => {
    (bot as any)._lastPrompt = { conv, text };
    return { busy: false };
  };
  (bot as any).orch.promptManager = async () => {};
  // Neutralize the non-send reply machinery (typing / working / preview).
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  return { bot, sent, edits, st, answers };
}

/** The registry id embedded in a sent keyboard's callback_data ("ch:<id>:<i>"). */
function regIdOf(opts?: Record<string, unknown>): string | undefined {
  const rows: any[][] = (opts as any)?.reply_markup?.inline_keyboard ?? [];
  const first = rows.flat()[0];
  if (!first) return undefined;
  const m = /^ch:([0-9a-z]{4}):/.exec(first.callback_data ?? "");
  return m ? m[1] : undefined;
}

// ── S1: a new options reply hides the previous active keyboard ─────────────
{
  const { bot, sent, edits, st, answers } = makeBot();
  const conv = "42";
  st.set(conv, { sessionID: "ses_1" });
  await bot.sendReply(conv, "Reply one\n\n[OPTIONS: alpha | beta]");
  const first = sent[sent.length - 1];
  const id1 = regIdOf(first.opts);
  check("S1 first reply carries a keyboard", Boolean(id1), JSON.stringify(first.opts));
  const prevEdits = edits.length;
  await bot.sendReply(conv, "Reply two\n\n[OPTIONS: gamma | delta]");
  const second = sent[sent.length - 1];
  const id2 = regIdOf(second.opts);
  check("S1 second reply carries a keyboard", Boolean(id2), JSON.stringify(second.opts));
  check("S1 old keyboard removed from the old message", edits.length === prevEdits + 1 && edits[prevEdits].messageId === first.id, JSON.stringify(edits.slice(prevEdits)));
  check("S1 removal edit clears the markup", edits[prevEdits] && JSON.stringify(edits[prevEdits].markup) === "{}", JSON.stringify(edits[prevEdits]));
  check("S1 old registry record deleted (stale tap can't fire)", id1 !== undefined && registry.get(id1) === undefined);
  check("S1 new keyboard still recorded", id2 !== undefined && registry.get(id2) !== undefined);
  const act = (bot as any).activeChoice.get(conv);
  check("S1 pointer now points at the new message", act?.messageId === second.id && act?.regId === id2, JSON.stringify(act));
}

// ── S2: a tapped keyboard's ✓ history survives the next options reply ──────
{
  const { bot, sent, edits, st, answers } = makeBot();
  const conv = "43";
  st.set(conv, { sessionID: "ses_1" });
  await bot.sendReply(conv, "Reply one\n\n[OPTIONS: alpha | beta]");
  const first = sent[sent.length - 1];
  const id1 = regIdOf(first.opts);
  await (bot as any).handleChoiceCallback({ id: "c1", data: `ch:${id1}:0`, from: { id: "1" } } as any, conv, (t?: string) => answers.push(t), first.id);
  const afterTap = edits[edits.length - 1];
  check("S2 tap replaced the keyboard with the ✓ button", afterTap?.messageId === first.id && /✓ alpha/.test(JSON.stringify(afterTap.markup)), JSON.stringify(afterTap));
  const actAfterTap = (bot as any).activeChoice.get(conv);
  check("S2 pointer cleared after the tap", actAfterTap === undefined, JSON.stringify(actAfterTap));
  const prevEdits = edits.length;
  await bot.sendReply(conv, "Reply two\n\n[OPTIONS: gamma | delta]");
  check("S2 the ✓ message was NOT touched by the new reply", edits.length === prevEdits, JSON.stringify(edits.slice(prevEdits)));
}

// ── S3: a reply without options leaves the previous keyboard alone ─────────
{
  const { bot, sent, edits, st, answers } = makeBot();
  const conv = "44";
  st.set(conv, { sessionID: "ses_1" });
  await bot.sendReply(conv, "Reply one\n\n[OPTIONS: alpha | beta]");
  const first = sent[sent.length - 1];
  const id1 = regIdOf(first.opts);
  const prevEdits = edits.length;
  await bot.sendReply(conv, "Plain reply, no options.");
  check("S3 no options in the new reply → no markup edit", edits.length === prevEdits, JSON.stringify(edits.slice(prevEdits)));
  check("S3 previous keyboard still active", id1 !== undefined && registry.get(id1) !== undefined);
  const act = (bot as any).activeChoice.get(conv);
  check("S3 pointer unchanged", act?.messageId === first.id && act?.regId === id1, JSON.stringify(act));
  const last = sent[sent.length - 1];
  check("S3 plain reply carries no keyboard", last.opts === undefined || !(last.opts as any)?.reply_markup, JSON.stringify(last.opts));
}

// ── S4: convs are isolated (a new reply in conv B never touches conv A) ────
{
  const { bot, edits, st } = makeBot();
  const convA = "45";
  const convB = "46";
  st.set(convA, { sessionID: "ses_1" });
  st.set(convB, { sessionID: "ses_2" });
  await bot.sendReply(convA, "Reply A\n\n[OPTIONS: alpha | beta]");
  const prevEdits = edits.length;
  await bot.sendReply(convB, "Reply B\n\n[OPTIONS: gamma | delta]");
  check("S4 no markup edits at all (each conv's first keyboard)", edits.length === prevEdits, JSON.stringify(edits.slice(prevEdits)));
  check("S4 conv A pointer intact", (bot as any).activeChoice.get(convA)?.regId !== undefined);
  check("S4 conv B pointer set", (bot as any).activeChoice.get(convB)?.regId !== undefined);
}

if (failures) {
  console.error(`\n${failures} suggest-hide check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll suggest-hide checks passed.");
