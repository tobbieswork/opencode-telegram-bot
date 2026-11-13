/**
 * Sticker-as-emoji (Bot API 7.0+ `sticker.emoji`): a caption-less sticker is
 * dispatched as its own emoji, exactly as if the user typed that emoji.
 *   - sticker + emoji, no caption  → routed through runPrompt with the emoji text
 *   - sticker, no emoji field      → falls back to the noteNonText 🫣 note (no prompt)
 *   - sticker + caption            → the caption wins over the emoji
 *   - plain text                   → unchanged
 *
 * Runs against a mock Bot (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-sticker-emoji.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-sticker-"));

function makeBot() {
  const sent: string[] = [];
  const prompts: Array<{ conv: string; text: string; via: string }> = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_conv: string, text: string) => {
      sent.push(text);
      return 1;
    },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
    editMessageReplyMarkup: async () => true,
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
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode: "ask", allowAny: true, uploads: false };
  const bot = new Bot(tg, oc, st, cfg);
  // Capture the routed turn; neutralize the form/reply/typing machinery.
  (bot as any).runPrompt = async (conv: string, text: string) => {
    prompts.push({ conv, text, via: "runPrompt" });
    return { busy: false };
  };
  (bot as any).handleFormText = async () => false;
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  return { bot, sent, prompts, st };
}

const conv = "42";
const msgOf = (extra: Record<string, unknown>) =>
  ({ message_id: 100, chat: { id: 42 }, from: { id: 77 }, ...extra }) as any;

// ── sticker + emoji, no caption → routed as the emoji ───────────────────────
{
  const { bot, sent, prompts } = makeBot();
  await bot.handle({ message: msgOf({ sticker: { file_id: "f1", type: "regular", emoji: "😂" } }) } as any);
  check("sticker+emoji routes through runPrompt", prompts.length === 1 && prompts[0].via === "runPrompt", JSON.stringify(prompts));
  check("prompt text is the emoji itself", prompts[0]?.text === "😂", JSON.stringify(prompts[0]));
  check("no 🫣 fallback note sent", sent.every((s) => !s.includes("🫣")), JSON.stringify(sent));
}

// ── sticker, no emoji field → falls back to the 🫣 note, no prompt ───────────
{
  const { bot, sent, prompts } = makeBot();
  await bot.handle({ message: msgOf({ sticker: { file_id: "f2", type: "regular" } }) } as any);
  check("sticker w/o emoji sends the noteNonText note", sent.some((s) => s.includes("🫣")), JSON.stringify(sent));
  check("sticker w/o emoji does NOT prompt", prompts.length === 0, JSON.stringify(prompts));
}

// ── sticker + caption → caption wins over the emoji ──────────────────────────
{
  const { bot, prompts } = makeBot();
  await bot.handle({ message: msgOf({ sticker: { file_id: "f3", type: "regular", emoji: "🔥" }, caption: "ship it" }) } as any);
  check("caption wins over the sticker emoji", prompts.length === 1 && prompts[0].text === "ship it", JSON.stringify(prompts));
}

// ── plain text message → unchanged ───────────────────────────────────────────
{
  const { bot, prompts } = makeBot();
  await bot.handle({ message: msgOf({ text: "hello" }) } as any);
  check("plain text unchanged", prompts.length === 1 && prompts[0].text === "hello", JSON.stringify(prompts));
}

console.log(failures === 0 ? "\nAll sticker-emoji checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
