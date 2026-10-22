/**
 * End-to-end run of the multi-session layer against the LIVE OpenCode service
 * (real LLM turns, a few minutes), with a mock Telegram that supports topics:
 *
 *   1. /spawn two workers and prompt both at once — replies land in their own topics.
 *   2. /manager on + /auto on — the Manager spawns a read-only worker through the
 *      MCP bridge, the worker reports back, the Manager summarises in the chat.
 *   3. /auto off — the Manager's next dispatch shows an approval card; tapping ✅
 *      spawns the worker.
 *
 * Run:  npm run smoke:multi
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { OpenCodeCtl } from "../src/opencode.js";
import { StateManager } from "../src/state.js";
import { Bot } from "../src/bot.js";
import { Telegram, Update } from "../src/telegram.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT = 4242;

type Out = { to: string; text: string; kb?: any };
class MockTelegram {
  out: Out[] = [];
  topics = new Map<number, string>();
  private ids = 0;
  private threads = 500;
  async sendMessage(to: any, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    this.out.push({ to: String(to), text, kb: opts.reply_markup });
  }
  async sendMessageId(to: any, text: string, opts: Record<string, unknown> = {}): Promise<number> {
    this.out.push({ to: String(to), text, kb: opts.reply_markup });
    return ++this.ids;
  }
  async editMessageText(to: any, _id: number, text: string): Promise<void> {
    this.out.push({ to: String(to), text: "[edit] " + text });
  }
  async answerCallbackQuery(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  sendChatAction(): void {}
  async createForumTopic(_chat: number, name: string): Promise<number> {
    const id = ++this.threads;
    this.topics.set(id, name);
    return id;
  }
  async editForumTopic(to: string, name: string): Promise<void> {
    this.topics.set(Number(to.split(":")[1]), name);
  }
  async closeForumTopic(): Promise<void> {}
}

const msg = (text: string, thread?: number): Update => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    text,
    chat: { id: CHAT },
    from: { id: 1 },
    ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
  },
});
const tap = (data: string, thread?: number): Update => ({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: {
    id: `cb-${Math.random()}`,
    data,
    from: { id: 1 },
    message: { chat: { id: CHAT }, message_id: 1, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) },
  },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(500);
  }
  return pred();
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "ocbot-multi-ws-")));
  mkdirSync(join(ws, "notes"));
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(ws, "notes", f), `${f}\n`);
  process.env.TELEGRAM_BOT_TOKEN = "dummy";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.OPENCODE_DIRECTORY = ws;
  process.env.OPENCODE_TG_BROWSE_ROOTS = ws;
  process.env.OPENCODE_TG_MANAGER_DIR = join(mkdtempSync(join(tmpdir(), "ocbot-mgr-")), "manager");
  process.env.STATE_FILE = mkdtempSync(join(tmpdir(), "ocbot-")) + "/state.json";
  const cfg = loadConfig(root);

  const oc = new OpenCodeCtl();
  const conn = await oc.connect();
  console.log(`OpenCode connected: ${conn.url} (v${conn.version})`);
  const mock = new MockTelegram();
  const st = new StateManager(cfg.stateFile);
  const bot = new Bot(mock as unknown as Telegram, oc, st, cfg);
  bot.start();
  const top = String(CHAT);
  const inConv = (conv: string, re: RegExp) => () => mock.out.some((o) => o.to === conv && re.test(o.text));
  const threadOf = (name: string) => [...mock.topics].find(([, n]) => n.endsWith(` ${name}`))?.[0];

  // ── 1. two topics in parallel ────────────────────────────────────────────
  console.log("\n== parallel topics ==");
  await bot.handle(msg(`/spawn alpha ${ws}`));
  await bot.handle(msg(`/spawn beta ${ws}`));
  const ta = threadOf("alpha");
  const tb = threadOf("beta");
  check("two topics created", !!ta && !!tb, JSON.stringify([...mock.topics]));
  const pa = `ALPHA-${Date.now()}`;
  const pb = `BETA-${Date.now()}`;
  const t0 = Date.now();
  // Not awaited one after the other on purpose: both prompts must run at once.
  await Promise.all([
    bot.handle(msg(`Reply with exactly the single word: ${pa}. Nothing else.`, ta)),
    bot.handle(msg(`Reply with exactly the single word: ${pb}. Nothing else.`, tb)),
  ]);
  const both = await waitFor(() => inConv(`${CHAT}:${ta}`, new RegExp(pa))() && inConv(`${CHAT}:${tb}`, new RegExp(pb))(), 180_000);
  check("each reply lands in its own topic", both);
  check("no cross-talk", !inConv(`${CHAT}:${ta}`, new RegExp(pb))() && !inConv(`${CHAT}:${tb}`, new RegExp(pa))());
  console.log(`   (both answered after ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  check("worker topics show done", await waitFor(() => mock.topics.get(ta!) === "✅ alpha" && mock.topics.get(tb!) === "✅ beta", 20_000), JSON.stringify([...mock.topics]));
  await bot.handle(msg("/board"));
  check("/board lists both", inConv(top, /alpha[\s\S]*beta|beta[\s\S]*alpha/)());

  // ── 2. Manager in auto mode ──────────────────────────────────────────────
  console.log("\n== manager (auto) ==");
  await bot.handle(msg("/manager on"));
  check("manager enabled", inConv(top, /Manager đã bật/)(), mock.out.at(-1)?.text);
  await bot.handle(msg("/auto on"));
  const before = mock.out.length;
  await bot.handle(
    msg(
      `Spawn exactly ONE worker named "counter" with agent "explore" and writes=false in directory ${join(ws, "notes")}. ` +
        "Its task: count the .txt files in that directory and reply with just the number. Do not spawn anything else.",
    ),
  );
  const counter = await waitFor(() => !!threadOf("counter"), 240_000);
  check("Manager spawned a worker through the bridge", counter, JSON.stringify([...mock.topics]));
  if (counter) {
    const tc = threadOf("counter")!;
    check("worker finished", await waitFor(() => mock.topics.get(tc) === "✅ counter", 240_000), mock.topics.get(tc));
    check("worker answered in its topic", await waitFor(inConv(`${CHAT}:${tc}`, /\b3\b/), 30_000));
    const reported = await waitFor(() => mock.out.slice(before).some((o) => o.to === top && /counter/i.test(o.text) && /\b3\b/.test(o.text)), 240_000);
    check("Manager reported the result in the main chat", reported, mock.out.slice(before).filter((o) => o.to === top).map((o) => o.text).join("\n---\n"));
  }

  // ── 3. confirm mode ──────────────────────────────────────────────────────
  console.log("\n== manager (confirm) ==");
  await bot.handle(msg("/auto off"));
  await bot.handle(
    msg(
      `Spawn exactly ONE worker named "lister" with agent "explore" and writes=false in directory ${join(ws, "notes")}. ` +
        "Its task: list the file names in that directory. Do not spawn anything else.",
    ),
  );
  const card = await waitFor(() => mock.out.some((o) => o.to === top && /Manager muốn giao việc/.test(o.text)), 240_000);
  check("approval card shown", card);
  check("nothing spawned before approval", !threadOf("lister"));
  const btn = JSON.stringify(mock.out.filter((o) => o.kb).at(-1)?.kb ?? {}).match(/ap:\d+:ok/)?.[0];
  if (btn) {
    await bot.handle(tap(btn));
    check("approve spawns the worker", await waitFor(() => !!threadOf("lister"), 30_000));
    const tl = threadOf("lister");
    if (tl) check("approved worker finishes", await waitFor(() => mock.topics.get(tl) === "✅ lister", 240_000), mock.topics.get(tl));
  }

  await bot.handle(msg("/stopall"));
  await bot.handle(msg("/manager off"));
  console.log("\n── chat transcript (main chat) ──");
  for (const o of mock.out.filter((o) => o.to === top)) console.log("•", o.text.slice(0, 300).replace(/\n/g, "\n  "));
  oc.stopEvents();
  console.log(failures === 0 ? "\nSMOKE-MULTI PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE-MULTI FAILED:", e);
  process.exit(1);
});
