import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { OpenCodeCtl } from "../src/opencode.js";
import { StateManager } from "../src/state.js";
import { Bot } from "../src/bot.js";
import { Telegram, Update } from "../src/telegram.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

class MockTelegram {
  out: string[] = [];
  keyboards: any[] = [];
  private msgCounter = 0;
  async sendMessage(_chatId: number, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    this.out.push(text);
    if (opts?.reply_markup) this.keyboards.push(opts.reply_markup);
  }
  async sendMessageId(_chatId: number, text: string, opts: Record<string, unknown> = {}): Promise<number> {
    const id = ++this.msgCounter;
    this.out.push(text);
    if (opts?.reply_markup) this.keyboards.push(opts.reply_markup);
    return id;
  }
  async editMessageText(_chatId: number, _messageId: number, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    this.out.push("[edit] " + text);
    if (opts?.reply_markup) this.keyboards.push(opts.reply_markup);
  }
  async answerCallbackQuery(_id: string, _text?: string): Promise<void> {}
  async deleteMessage(_chatId: number, _messageId: number): Promise<void> {}
  sendChatAction(): void {}
  async getMe() {
    return { id: 1, username: "Mock" };
  }
}

const upd = (text: string, uid = 1): Update => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { text, chat: { id: 42 }, from: { id: uid } },
});
/** Simulate a button tap on the browser message. */
const tap = (data: string, uid = 1): Update => ({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: {
    id: `cb-${Math.floor(Math.random() * 1e6)}`,
    data,
    from: { id: uid },
    message: { chat: { id: 42 }, message_id: 1 },
  },
});
const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: (a: string[]) => boolean, arr: string[], ms = 90000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(arr)) return true;
    await waitMs(300);
  }
  return pred(arr);
}

async function main(): Promise<void> {
  process.env.TELEGRAM_BOT_TOKEN = "dummy";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.OPENCODE_DIRECTORY = "/tmp/opencode/testws";
  process.env.STATE_FILE = mkdtempSync(tmpdir() + "/ocbot-") + "/state.json";
  const cfg = loadConfig(root);

  const oc = new OpenCodeCtl();
  const conn = await oc.connect();
  console.log(`OpenCode connected: ${conn.url} (v${conn.version})`);

  const mock = new MockTelegram();
  const tg = mock as unknown as Telegram;
  const st = new StateManager(cfg.stateFile);
  const bot = new Bot(tg, oc, st, cfg);
  bot.start(); // wire the event subscription so question forms are relayed

  let cursor = 0;
  const show = (label: string) => {
    const fresh = mock.out.slice(cursor);
    cursor = mock.out.length;
    console.log(`\n== ${label} ==\n` + (fresh.length ? fresh.join("\n---\n") : "(no new messages)"));
  };

  await bot.handle(upd("/help", 999));
  show("unauthorized");

  await bot.handle(upd("/help"));
  show("/help");

  await bot.handle(upd("/new"));
  show("/new");

  await bot.handle(upd("Reply with exactly the single word: HELLO. Nothing else."));
  const done = await waitFor((a) => a.some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out);
  console.log("\n(prompt task completed:", done, ")");
  show("prompt reply");

  await bot.handle(upd("/status"));
  show("/status");

  await bot.handle(upd("/history"));
  show("/history");

  await bot.handle(upd("/models"));
  show("/models");

  await bot.handle(upd("/agents"));
  show("/agents");

  // ── mode picker (buttons) ─────────────────────────────────────────────────────
  await bot.handle(upd("/mode"));
  show("mode: picker");
  const modeKb = mock.keyboards[mock.keyboards.length - 1];
  console.log("mode keyboard:", JSON.stringify(modeKb, null, 2));
  const mBtn = JSON.stringify(modeKb).match(/mode:(plan|build|general|explore)/);
  console.log("mode option button:", mBtn ? mBtn[0] : "NOT FOUND");
  if (mBtn) {
    await bot.handle(tap("mode:plan"));
    show("mode: tap plan");
    await bot.handle(tap("mode:build"));
    show("mode: tap build");
  }
  await bot.handle(upd("/mode explore"));
  show("mode: text switch to explore");
  await bot.handle(tap("mode:build"));
  show("mode: back to build (for the rest of the smoke)");
  await bot.handle(tap("mode:close"));
  show("mode: close picker");

  await bot.handle(upd("/dir"));
  show("/dir");

  await bot.handle(upd("/browse"));
  show("/browse");
  console.log("browser keyboard:", JSON.stringify(mock.keyboards[mock.keyboards.length - 1], null, 2));

  await bot.handle(tap("bs:nav:0"));
  show("browse: enter first subfolder");

  await bot.handle(tap("bs:up"));
  show("browse: go up");

  await bot.handle(tap("bs:hid"));
  show("browse: toggle hidden");

  await bot.handle(tap("bs:open"));
  show("browse: choose action");

  await bot.handle(tap("bs:setdir"));
  show("browse: set dir only");

  await bot.handle(tap("bs:list"));
  await bot.handle(tap("bs:open"));
  await bot.handle(tap("bs:setsess"));
  show("browse: set dir + open session");

  await bot.handle(tap("bs:close"));
  show("browse: close");

  await bot.handle(upd("/unknowncmd"));
  show("unknown command");

  // ── question relay (end-to-end against the real OpenCode service) ───────
  console.log("\n=== QUESTION RELAY (end-to-end) ===");
  await bot.handle(upd("/new"));
  show("q: new session");
  await bot.handle(
    upd(
      "Use the `question` tool to ask me EXACTLY ONE multiple-choice question: " +
        "header 'Pick', question 'Which number do you prefer?', options: One, Two, Three. " +
        "Ask only that one question and do nothing else.",
    ),
  );
  const qok = await waitFor((a) => a.some((m) => /Câu 1\/1/.test(m)), mock.out, 90000);
  console.log("question surfaced:", qok);
  show("q: question message");
  const kb = mock.keyboards[mock.keyboards.length - 1];
  const qBtn = JSON.stringify(kb).match(/fq:[A-Za-z0-9_]+:o0/);
  console.log("form option button:", qBtn ? qBtn[0] : "NOT FOUND");
  if (qBtn) {
    const afterTap = mock.out.length;
    await bot.handle(tap(qBtn[0]));
    const dok = await waitFor((a) => a.slice(afterTap).some((m) => /Đã gửi câu trả lời/.test(m)), mock.out, 30000);
    console.log("answer submitted:", dok);
    const rok = await waitFor((a) => a.slice(afterTap).some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out, 90000);
    console.log("prompt completed:", rok);
    show("q: final");
  }

  await bot.handle(upd("/clear"));
  show("/clear");

  console.log(`\nTotal outbound messages: ${mock.out.length}`);
  let stateDump = "(none)";
  try {
    stateDump = readFileSync(cfg.stateFile, "utf8");
  } catch {
    /* no state yet */
  }
  console.log("State file:", cfg.stateFile, "\n", stateDump);

  oc.stopEvents();
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
