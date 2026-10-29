import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
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
  async editMessageTextStrict(chatId: number, messageId: number, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    await this.editMessageText(chatId, messageId, text, opts);
  }
  async answerCallbackQuery(_id: string, _text?: string): Promise<void> {}
  async deleteMessage(_chatId: number, _messageId: number): Promise<void> {}
  async setMyCommands(_commands: Array<{ command: string; description: string }>): Promise<void> {}
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
  mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "opencode/smoke-workspace-")));
  mkdirSync(join(workspace, "child"));
  process.env.OPENCODE_DIRECTORY = workspace;
  process.env.OPENCODE_TG_BROWSE_ROOTS = workspace;
  process.env.OPENCODE_TG_UPTIME_MONITOR = "0";
  // Keep the live activity line off: its "✅ … · Ns" text would trip the
  // smoke's prompt-completed heuristics. It has its own unit tests.
  process.env.OPENCODE_TG_ACTIVITY = "0";
  process.env.STATE_FILE = mkdtempSync(tmpdir() + "/ocbot-") + "/state.json";
  const cfg = loadConfig(root);

  const oc = new OpenCodeCtl();
  const conn = await oc.connect();
  console.log(`OpenCode connected: ${conn.url} (v${conn.version})`);

  const mock = new MockTelegram();
  const tg = mock as unknown as Telegram;
  const st = new StateManager(cfg.stateFile);
  const bot = new Bot(tg, oc, st, cfg);
  const checks: Array<[string, boolean]> = [];
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

  // ── command menu (buttons under /help) ───────────────────────────────────────
  const helpKb = mock.keyboards[mock.keyboards.length - 1];
  const menuBtn = JSON.stringify(helpKb).match(/cmd:(?:new|ls|dir|browse|mode|models|variants|status|context|history|stop|clear|help)/);
  console.log("menu button:", menuBtn ? menuBtn[0] : "NOT FOUND");
  checks.push(["menu lệnh", !!menuBtn]);
  if (menuBtn) {
    await bot.handle(tap("cmd:ls"));
    show("menu: tap sessions");
    await bot.handle(tap("cmd:mode"));
    show("menu: tap mode");
  }

  await bot.handle(upd("/new"));
  show("/new");

  await bot.handle(upd("Reply with exactly the single word: HELLO. Nothing else."));
  const done = await waitFor((a) => a.some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out);
  console.log("\n(prompt task completed:", done, ")");
  checks.push(["hoàn tất prompt đầu", done]);
  show("prompt reply");

  await bot.handle(upd("/status"));
  show("/status");
  const statusMsg = mock.out[mock.out.length - 1];
  console.log("status model line:", (statusMsg.match(/model: .*/) ?? ["?"])[0]);

  await bot.handle(upd("/history"));
  show("/history");

  await bot.handle(upd("/context"));
  show("/context");
  const ctxMsg = mock.out[mock.out.length - 1];
  console.log("context has files:", /files: /.test(ctxMsg));
  console.log("context has tokens:", /tokens: /.test(ctxMsg));

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
  checks.push(["bộ chọn chế độ", !!mBtn]);
  if (mBtn) {
    await bot.handle(tap("mode:plan"));
    show("mode: tap plan");
    await bot.handle(tap("mode:build"));
    show("mode: tap build");
  }
  await bot.handle(upd("/mode explore"));
  show("mode: text switch to explore");
  await bot.handle(tap("mode:info"));
  show("mode: show roles");
  await bot.handle(tap("mode:build"));
  show("mode: back to build (for the rest of the smoke)");
  await bot.handle(tap("mode:close"));
  show("mode: close picker");

  // ── out-of-band turn (background-wake simulation) ───────────────────────────
  // Prompt the session DIRECTLY via the API (not through the bot), exactly like
  // OpenCode runs a turn triggered by a background-task completion. The bot's
  // live event subscription should relay the reply — before this feature the
  // output was silently dropped until the next restart.
  {
    const stt = st.get(42);
    if (stt.sessionID) {
      const probe = "SWEEP-PROBE-" + Date.now();
      console.log("\n== sweep: out-of-band turn == (session " + stt.sessionID + ", probe " + probe + ")");
      await oc.promptAndWait(stt.sessionID, `Reply with exactly the single word: ${probe}. Nothing else.`);
      const swept = await waitFor((a) => a.some((m) => m.includes(probe)), mock.out);
      console.log("sweep relayed the out-of-band reply to Telegram:", swept);
       show("sweep: relayed out-of-band reply");
       checks.push(["chuyển tiếp phản hồi ngoài luồng", swept]);
    }
  }

  // ── permission relay (approve a tool permission from Telegram) ──────────────
  // Create a real permission request on the session (like a tool call would).
  // If it stays pending, the live event stream must surface it as buttons and
  // tapping one must answer it through the API.
  {
    const stt = st.get(42);
    if (stt.sessionID) {
      console.log("\n== permission: relay + tap ==");
      // Deliberately outside /tmp/opencode (a saved "always" rule from earlier
      // approvals auto-allow it), so the request stays pending (effect "ask").
      const perm = await oc.createPermission(stt.sessionID, "external_directory", ["/tmp/opencode-smoke-perm-test"]);
      console.log("permission created:", perm.id, "effect:", perm.effect || "?");
      if (perm.id && perm.effect === "ask") {
        const surfaced = await waitFor((a) => a.some((m) => m.includes("🔐")), mock.out);
        console.log("permission prompt surfaced:", surfaced);
        if (surfaced) {
          await bot.handle(tap(`perm:${perm.id}:once`));
          const answered = await waitFor((a) => a.some((m) => m.startsWith("[edit]") && m.includes("Đã duyệt")), mock.out);
          console.log("permission answered via Telegram:", answered);
          if (!answered) {
            // Settle it so it doesn't linger as a pending prompt in the TUI.
            await oc.replyPermission(stt.sessionID, perm.id, "reject").catch(() => {});
            console.log("tap did not settle the request — rejected as cleanup");
          }
          show("permission: prompt + answer");
        }
      } else {
        console.log("permission auto-settled by saved rules — skipping tap (effect:", perm.effect || "unknown", ")");
      }
    }
  }

  // ── plan → build handoff ────────────────────────────────────────────────────
  // A successful turn that ENDS in plan mode should offer the one-tap
  // plan-to-build button; tapping it must switch the agent to build and run
  // the execution prompt (which the bot then relays as a normal reply).
  {
    const stt = st.get(42);
    if (stt.sessionID) {
      console.log("\n== plan-to-build: plan turn + tap ==");
      await bot.handle(upd("/mode plan"));
      const probe = "PLAN2BUILD-" + Date.now();
      await bot.handle(
        upd(
          `Viết kế hoạch ${probe}: liệt kê đúng 3 bước ngắn để tạo file hello.txt với nội dung "hi". Chỉ liệt kê, chưa thực hiện, không cần hỏi thêm.`,
        ),
      );
      const offered = await waitFor((a) => a.some((m) => m.includes("Kế hoạch đã sẵn sàng")), mock.out, 120000);
      console.log("plan-to-build offered:", offered);
      if (offered) {
        const before = mock.out.length;
        await bot.handle(tap("pb:go"));
        const executed = await waitFor((a) => a.length >= before + 2, mock.out, 120000);
        console.log("execution turn relayed after tap:", executed);
        await bot.handle(upd("/status"));
        const statusMsg = mock.out[mock.out.length - 1];
        console.log("status after tap:", (statusMsg.match(/agent: .*/) ?? ["?"])[0]);
        show("plan-to-build: offer + tap + status");
      } else {
        await bot.handle(upd("/mode build"));
        console.log("plan-to-build offer not surfaced — restoring build mode");
      }
    }
  }
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
  checks.push(["hiện câu hỏi", qok]);
  show("q: question message");
  const kb = mock.keyboards[mock.keyboards.length - 1];
  const qBtn = JSON.stringify(kb).match(/fq:[A-Za-z0-9_]+:o0:\d+/);
  console.log("form option button:", qBtn ? qBtn[0] : "NOT FOUND");
  checks.push(["nút trả lời câu hỏi", !!qBtn]);
  if (qBtn) {
    const afterTap = mock.out.length;
    await bot.handle(tap(qBtn[0]));
    const dok = await waitFor((a) => a.slice(afterTap).some((m) => /Đã gửi câu trả lời/.test(m)), mock.out, 30000);
    console.log("answer submitted:", dok);
    checks.push(["gửi câu trả lời", dok]);
    const rok = await waitFor((a) => a.slice(afterTap).some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out, 90000);
    console.log("prompt completed:", rok);
    checks.push(["hoàn tất sau câu hỏi", rok]);
    show("q: final");
  }

  const finalSession = st.get(42).sessionID;
  if (finalSession) await oc.interrupt(finalSession).catch(() => {});
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
  bot.stopScheduler();
  assert.deepEqual(checks.filter(([, ok]) => !ok), [], "Các phần kiểm tra chưa đạt");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
