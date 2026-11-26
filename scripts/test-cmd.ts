/**
 * Unit test: the /cmd shell command (src/commands/cmd.ts) — the two-step
 * confirm (card → Run executes / Cancel dismisses), the single-use 10-min
 * token, runShellCommand (exit / timeout), tailCap, and formatCmdResult.
 *
 * Run:  npx tsx scripts/test-cmd.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { convKey } from "../src/conv.js";
import {
  runShellCommand,
  tailCap,
  formatCmdResult,
  cmdCmd,
  handleCmdRun,
  handleCmdCancel,
  _clearPendingCmdsForTest,
} from "../src/commands/cmd.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

interface Rec {
  sent: { conv: string; text: string; kb?: unknown }[];
  markupRemoved: number[];
  answers: { id: string; text?: string }[];
}

function makeBot() {
  const base = mkdtempSync(join(tmpdir(), "tg-cmd-"));
  const st = new StateManager(join(base, "state.json"));
  const rec: Rec = { sent: [], markupRemoved: [], answers: [] };
  const tg: any = {
    sendMessage: async (conv: string, text: string, opts?: { reply_markup?: unknown }) => {
      rec.sent.push({ conv, text, kb: opts?.reply_markup });
      return rec.sent.length;
    },
    editMessageReplyMarkup: async (_conv: string, msgId: number) => {
      rec.markupRemoved.push(msgId);
    },
    answerCallbackQuery: async (id: string, text?: string) => {
      rec.answers.push({ id, text });
    },
  };
  const oc: any = {
    getSession: async () => ({ tokens: { input: 1, output: 1 }, time: { updated: Date.now() } }),
    latestAssistantInfo: async () => ({}),
    listModels: async () => [],
    serverInfo: async () => ({ version: "1.2.3", urls: [] }),
    getSessionModel: async () => ({}),
    getSessionReport: async () => null,
  };
  const cfg: any = { stateFile: join(base, "state.json"), opencodeDirectory: "/tmp/opencode", rebootDelayMs: 15000 };
  const bot = new Bot(tg, oc, st, cfg);
  return { bot, rec };
}

const CONV = convKey(42);
const cb = (id: string, uid = 42): any => ({ id, from: { id: uid } });

/** Pull the Run-button token out of a confirm card's keyboard. */
function runToken(kb: unknown): string {
  const k = JSON.parse(JSON.stringify(kb)) as { inline_keyboard: { callback_data: string }[][] };
  const data = k.inline_keyboard.flat().find((b) => b.callback_data.startsWith("sh:"))?.callback_data ?? "";
  return data.slice("sh:".length);
}

async function main(): Promise<void> {
  // ── runShellCommand ─────────────────────────────────────────────────
  {
    const r = await runShellCommand("echo hello-cmd-test");
    check("run: exit 0 + stdout captured", r.exit === 0 && !r.timedOut && r.stdout.trim() === "hello-cmd-test", JSON.stringify(r));
  }
  {
    const r = await runShellCommand("exit 3");
    check("run: non-zero exit code preserved", r.exit === 3 && !r.timedOut, JSON.stringify(r));
  }
  {
    const r = await runShellCommand("sleep 5", { timeoutMs: 300 });
    check("run: timeout → timedOut, exit null", r.timedOut === true && r.exit === null, JSON.stringify(r));
  }
  {
    const r = await runShellCommand("kill -9 $$");
    check("run: self-signal-kill → signal SIGKILL, exit null, not timedOut", r.signal === "SIGKILL" && r.exit === null && r.timedOut === false, JSON.stringify(r));
  }

  // ── tailCap ─────────────────────────────────────────────────────────
  {
    check("tailCap: short unchanged", JSON.stringify(tailCap("abc", 10)) === JSON.stringify({ text: "abc", cut: 0 }));
    const { text, cut } = tailCap("x".repeat(100), 10);
    check("tailCap: keeps tail + reports cut", text === "x".repeat(10) && cut === 90, JSON.stringify({ len: text.length, cut }));
  }

  // ── formatCmdResult ─────────────────────────────────────────────────
  {
    const { ok, html } = formatCmdResult("echo hi", { stdout: "hi", stderr: "", exit: 0, timedOut: false, signal: null, durationMs: 12 }, "en");
    check("format: exit 0 → success + exit 0 + stdout pre", ok === true && html.includes("exit 0") && html.includes("<pre>hi</pre>"), html);
  }
  {
    const { ok, html } = formatCmdResult("false", { stdout: "", stderr: "boom", exit: 2, timedOut: false, signal: null, durationMs: 5 }, "en");
    check("format: non-zero → error + stderr section", ok === false && html.includes("exit 2") && html.includes("stderr"), html);
  }
  {
    const { ok, html } = formatCmdResult("sleep 5", { stdout: "", stderr: "", exit: null, timedOut: true, signal: null, durationMs: 5000 }, "en");
    check("format: timeout → warning, not success", ok === false && html.includes("timed out"), html);
  }
  {
    const { ok, html } = formatCmdResult("kill -9 $$", { stdout: "", stderr: "", exit: null, timedOut: false, signal: "SIGKILL", durationMs: 5 }, "en");
    check("format: signal-kill → 'killed by SIGKILL', not success", ok === false && html.includes("killed by SIGKILL"), html);
  }
  {
    const { html } = formatCmdResult("echo a<b>", { stdout: "x<y>&z", stderr: "", exit: 0, timedOut: false, signal: null, durationMs: 1 }, "en");
    check("format: command + output HTML-escaped", html.includes("a&lt;b&gt;") && html.includes("x&lt;y&gt;&amp;z"), html);
  }

  // ── confirm flow: /cmd posts a card, does NOT execute ───────────────
  {
    _clearPendingCmdsForTest();
    const { bot, rec } = makeBot();
    await cmdCmd(bot, CONV, "echo run-me", 42);
    const kb = JSON.stringify(rec.sent[0].kb);
    check("card: posted with Run+Cancel buttons, command shown, not executed", rec.sent.length === 1 && kb.includes("sh:") && kb.includes("shcancel:") && rec.sent[0].text.includes("echo run-me"), JSON.stringify(rec.sent));
  }

  // ── confirm flow: Run executes the bound command ────────────────────
  {
    _clearPendingCmdsForTest();
    const { bot, rec } = makeBot();
    await cmdCmd(bot, CONV, "echo from-token", 42);
    const token = runToken(rec.sent[0].kb);
    check("run: token extracted from the card", token.length > 0, `token=${token}`);
    await handleCmdRun(bot, cb("r1"), CONV, token, () => {}, 999);
    check("run: executed → result posted (exit 0 + 'from-token')", rec.sent.length === 2 && rec.sent[1].text.includes("from-token") && rec.sent[1].text.includes("exit 0"), JSON.stringify(rec.sent.map((s) => s.text)));
    check("run: buttons removed from the card", rec.markupRemoved.includes(999), JSON.stringify(rec.markupRemoved));
  }

  // ── confirm flow: Run is single-use (2nd tap → expired) ─────────────
  {
    _clearPendingCmdsForTest();
    const { bot, rec } = makeBot();
    await cmdCmd(bot, CONV, "echo once", 42);
    const token = runToken(rec.sent[0].kb);
    await handleCmdRun(bot, cb("r1"), CONV, token, () => {}, 999); // 1st tap → executes
    rec.sent.length = 0;
    await handleCmdRun(bot, cb("r2"), CONV, token, (t) => { if (t) rec.answers.push({ id: "r2", text: t }); }, 999); // 2nd tap → expired
    const toast = rec.answers.find((a) => a.id === "r2")?.text ?? "";
    check("run: 2nd tap → expired toast, no re-execution", rec.sent.length === 0 && (toast.toLowerCase().includes("expired") || toast.includes("hết hạn")), JSON.stringify(rec.answers));
  }

  // ── confirm flow: Cancel dismisses, no execution ────────────────────
  {
    _clearPendingCmdsForTest();
    const { bot, rec } = makeBot();
    await cmdCmd(bot, CONV, "echo never", 42);
    await handleCmdCancel(bot, cb("r1"), CONV, (t) => { if (t) rec.answers.push({ id: "r1", text: t }); }, 999);
    const toast = rec.answers.find((a) => a.id === "r1")?.text ?? "";
    check("cancel: answers + removes buttons, no execution", rec.sent.length === 1 && rec.markupRemoved.includes(999) && (toast.includes("Cancelled") || toast.includes("huỷ")), JSON.stringify({ sent: rec.sent.length, answers: rec.answers }));
  }

  // ── usage (empty arg) ───────────────────────────────────────────────
  {
    _clearPendingCmdsForTest();
    const { bot, rec } = makeBot();
    await cmdCmd(bot, CONV, "   ", 42);
    check("usage: empty arg → usage hint, no card", rec.sent.length === 1 && rec.sent[0].text.includes("/cmd") && (!rec.sent[0].kb || !JSON.stringify(rec.sent[0].kb).includes("sh:")), rec.sent[0].text);
  }

  if (failures) {
    console.error(`\n${failures} FAILURE(S) in test-cmd`);
    process.exit(1);
  }
  console.log("\nALL PASSED — test-cmd");
}
main();
