import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { OpenCodeCtl } from "../src/opencode.js";
import { StateManager } from "../src/state.js";
import { Bot } from "../src/bot.js";
import { Telegram, Update } from "../src/telegram.js";
import { extractOptionsMarker } from "../src/choices.js";

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
  // Rich path (OPENCODE_TG_RICH=1 in .env): the bot tries sendRichMessage
  // first; the mock records the markdown as-is (no HTML conversion) and
  // resolves a message id, mirroring the real sendRich.
  async sendRich(_to: number, markdown: string, opts: { reply_markup?: unknown } = {}): Promise<number> {
    const id = ++this.msgCounter;
    this.out.push(markdown);
    if (opts?.reply_markup) this.keyboards.push(opts.reply_markup);
    return id;
  }
  // Next-step one-shot revert (N3.1) edits the footer's reply markup in place;
  // the mock is a no-op (the smoke doesn't observe the row being dropped).
  async editMessageReplyMarkup(_chatId: number, _messageId: number, _opts: Record<string, unknown> = {}): Promise<void> {}
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
  process.env.OPENCODE_DIRECTORY = "/tmp/opencode/testws";
  // The next-step Review rule decides "did this turn change anything?" from the
  // git working tree, so the smoke workspace must be a git repo (idempotent).
  mkdirSync("/tmp/opencode/testws", { recursive: true });
  if (!existsSync(join("/tmp/opencode/testws", ".git"))) execFileSync("git", ["init", "-q", "/tmp/opencode/testws"]);
  // Keep the live activity line off: its "✅ … · Ns" text would trip the
  // smoke's prompt-completed heuristics. It has its own unit tests.
  process.env.OPENCODE_TG_ACTIVITY = "0";
  process.env.STATE_FILE = mkdtempSync(tmpdir() + "/ocbot-") + "/state.json";
  // Auto-queue mode for the queue scenario below: a message that arrives while
  // a turn is running is enqueued on arrival (busy reply "Đã thêm vào hàng chờ").
  process.env.OPENCODE_TG_BUSY_MODE = "queue";
  // S7 (next-step buttons, end-to-end): the feature is on and the "review" rule
  // has no minimum-turn gate, so the build turn that writes a file below offers
  // the "🔍 Review changes" button and tapping it starts a review turn.
  // Test scope only — the source default (90 s) is NOT changed.
  process.env.OPENCODE_TG_NEXT_STEPS = "1";
  process.env.OPENCODE_TG_NEXT_MIN_SECS = "0";
  // R5 (quick replies, end-to-end): the instruction is pinned on the session so
  // the model may offer [OPTIONS: …] buttons. The model CANNOT be forced to
  // comply, so the scenario is a soft check: it reports compliance and fails
  // only if a valid marker was received but not rendered. Test scope only.
  process.env.OPENCODE_TG_SUGGEST = "1";
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

  // ── command menu (buttons under /help) ───────────────────────────────────────
  const helpKb = mock.keyboards[mock.keyboards.length - 1];
  const menuBtn = JSON.stringify(helpKb).match(/cmd:(?:new|ls|dir|browse|mode|models|variants|status|context|history|stop|clear|help)/);
  console.log("menu button:", menuBtn ? menuBtn[0] : "NOT FOUND");
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

  // ── next-step: Review button → review turn (S7, end-to-end) ────────────────
  // A plain build turn that WRITES a file must offer the "🔍 Review changes"
  // next-step button (NEXT_STEPS on, NEXT_MIN_SECS=0 so any turn qualifies);
  // tapping it must start a real review turn (the read-only review-code prompt).
  // The session is idle here (the question turn above completed) and in build.
  console.log("\n=== NEXT-STEP REVIEW (end-to-end) ===");
  {
    // Guard: force the build agent so the "review" rule's agent gate holds.
    await bot.handle(upd("/mode build"));
    const outBefore = mock.out.length;
    const kbBefore = mock.keyboards.length;
    // A build turn that actually creates a file → the session's modified-files
    // set gains a path → the "review" rule's filesNew gate passes.
    const nsProbe = "NSX-" + Date.now();
    await bot.handle(
      upd(
        `Create a brand-new file named hello-nextstep-${nsProbe}.txt whose only line is: nextstep smoke ${nsProbe}. ` +
          "Actually create the file now (use whatever file tool is available). Do not do anything else; " +
          "end with a single short confirmation sentence.",
      ),
    );
    // Turn completes → its quiet footer carries the "· Ns" marker + the keyboard.
    const buildDone = await waitFor((a) => a.slice(outBefore).some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out, 120000);
    console.log("build turn (file write) completed:", buildDone);
    // The "🔍 Review changes" button rides the footer keyboard (callback ns:<id>:<k>).
    let nsBtn: string | undefined;
    for (const kb of mock.keyboards.slice(kbBefore)) {
      const m = JSON.stringify(kb).match(/ns:[0-9a-z]{4}:\d+/);
      if (m) { nsBtn = m[0]; break; }
    }
    console.log("review next-step button shown:", nsBtn ?? "NOT FOUND");
    show("ns: build turn result + review button");
    if (!nsBtn) {
      console.log("❌ NEXT-STEP: no Review button on a file-changing build turn — feature not working");
      process.exitCode = 1;
    } else {
      // Let the build turn's end-of-turn cleanup settle (inflight cleared) so the
      // tap is not refused by the N3.3 "task running" check.
      await waitMs(500);
      const afterTap = mock.out.length;
      await bot.handle(tap(nsBtn));
      // The tap starts a review turn: a NEW turn runs the read-only review and
      // completes with its own footer (success "· Ns" or a failure "Ns</i>").
      const reviewDone = await waitFor(
        (a) => a.slice(afterTap).some((m) => /· \d+(\.\d+)?s/.test(m) || /\d+(\.\d+)?s<\/i>/.test(m)),
        mock.out,
        120000,
      );
      console.log("review turn started + completed after tap:", reviewDone);
      show("ns: review turn after tap");
      if (!reviewDone) {
        console.log("❌ NEXT-STEP: review turn did not run after tapping Review — feature not working");
        process.exitCode = 1;
      } else {
        console.log("✅ NEXT-STEP: file-write build turn → Review button → tap → review turn completed");
      }
    }
  }

  // ── quick replies: decision prompt → soft compliance check (R5) ───────────
  // A decision-style prompt in a fresh session. The model may or may not end
  // with a valid [OPTIONS: …] marker — it cannot be forced (R0 measures this).
  // A VALID marker still visible in the relayed text means the render path
  // failed to strip it (extractOptionsMarker on the relayed text returns
  // non-null only for a valid, last-line marker with a non-empty body) — that
  // is the one failure this soft check reports.
  console.log("\n=== QUICK REPLIES (soft compliance check) ===");
  {
    await bot.handle(upd("/new"));
    const outBefore = mock.out.length;
    const kbBefore = mock.keyboards.length;
    await bot.handle(
      upd(
        "I want to add a settings page to a small web app. Suggest 2-3 different directions I could take " +
          "(e.g. where the settings live and how they are stored). Keep each direction to one line. " +
          "Then stop — I will pick from your options.",
      ),
    );
    const done = await waitFor((a) => a.slice(outBefore).some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out, 120000);
    console.log("decision turn completed:", done);
    // A rendered quick-replies keyboard = one or more ch:<id>:<i> buttons on the reply.
    let qrOptions = 0;
    for (const kb of mock.keyboards.slice(kbBefore)) {
      const hits = JSON.stringify(kb).match(/ch:[0-9a-z]{4}:\d+/g);
      if (hits && hits.length > 0) {
        qrOptions = hits.length;
        break;
      }
    }
    // The relayed reply (last chunk holds the tail, where the marker lives).
    const fresh = mock.out.slice(outBefore);
    const plain = (fresh[fresh.length - 1] ?? "").replace(/<[^>]+>/g, "");
    const parsed = extractOptionsMarker(plain);
    show("qr: decision turn + quick replies");
    if (!done) {
      console.log("❌ QUICK-REPLIES: decision turn did not complete");
      process.exitCode = 1;
    } else if (qrOptions > 0) {
      console.log(`✅ QUICK-REPLIES: model offered ${qrOptions} option(s) as buttons (compliance 1/1 this turn)`);
    } else if (parsed !== null) {
      console.log("❌ QUICK-REPLIES: a valid [OPTIONS: …] marker was received but not rendered — feature not working");
      process.exitCode = 1;
    } else if (plain.includes("[OPTIONS:")) {
      console.log("⚠️  QUICK-REPLIES: marker present but invalid (sent as text, no buttons — by design). Compliance 0/1 this turn.");
    } else {
      console.log("⚠️  QUICK-REPLIES: no marker in the reply — model did not comply this turn (soft check, not a failure).");
    }
  }

  // ── queue: a message sent while a turn is running is queued, then runs after ─
  console.log("\n=== QUEUE (auto-queue during a busy turn, then drains) ===");
  await bot.handle(upd("/new"));
  show("queue: new session");
  // A long turn (count to 50, one number per line) keeps the session busy long
  // enough that the next message lands while it is still running (inflight set).
  await bot.handle(upd("Đếm từ 1 đến 50, viết TỪNG SỐ ra một dòng, rất cẩn thận, đừng tóm tắt."));
  const qProbe = "QRUN-" + Date.now();
  // The 2nd message arrives while the first turn is running → auto-queued
  // (busyMode "queue"). It carries a message_id so the busy reply + note button
  // target it (the auto-queue path does not require the id, but keep it realistic).
  const qSecond: Update = {
    update_id: Math.floor(Math.random() * 1e6),
    message: { text: "Reply with exactly the single word: " + qProbe + ". Nothing else.", chat: { id: 42 }, from: { id: 1 }, message_id: 7777 },
  };
  await bot.handle(qSecond);
  show("queue: 2nd message while busy (auto-queued)");
  const queued = await waitFor((a) => a.some((m) => m.includes("Đã thêm vào hàng chờ")), mock.out, 20000);
  console.log("2nd message was auto-queued (queue_add):", queued);
  await bot.handle(upd("/queue"));
  show("queue: /queue list");
  const ql = mock.out[mock.out.length - 1];
  console.log("/queue lists the queued message:", ql.includes("QRUN") ? "yes" : "NO — see /queue output above");
  // Wait for the first (count) turn to finish → its drain runs the queued item.
  const firstDone = await waitFor((a) => a.some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out, 120000);
  console.log("first (count) turn completed:", firstDone);
  // The queued message now runs as its own turn; its relayed reply has the probe.
  const ran = await waitFor((a) => a.some((m) => m.includes(qProbe)), mock.out, 120000);
  console.log("queued message was RUN after the turn ended (queue_run):", ran);
  show("queue: drained + ran");
  await bot.handle(upd("/queue"));
  show("queue: /queue after drain (should be empty)");

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
