/**
 * /queue command + the queue_* audit events (docs/sdd/queue-and-steer.md,
 * phase 4 — Q3.2, Q3.3, Q4.2):
 *   - formatQueueAge: human age (45s / 1m / 1h 30m, clamps negatives);
 *   - cmdQueue: empty / list (position + truncated text + age) / clear;
 *   - queue_add (auto-queue on arrival), queue_run (drain), queue_drop
 *     (stop) — the audit lines the bot writes, verified by reading the file.
 *
 * Runs against a mock Bot + a temp audit file (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-queue-cmd.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, formatQueueAge } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-qcmd-"));
const auditFile = join(tmp, "audit.log");
configureAudit({ path: auditFile });

function makeBot(busyMode: "ask" | "queue" | "off" = "queue") {
  const sent: string[] = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_conv: string, text: string) => { sent.push(text); return 1; },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
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
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode };
  const bot = new Bot(tg, oc, st, cfg);
  // Neutralize the reply/typing/stream machinery so only the queue logic runs.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  return { bot, sent, st };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
function auditLines(): Record<string, unknown>[] {
  try {
    return readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const byAction = (action: string) => auditLines().filter((l) => l.action === action);

// ── formatQueueAge (Q3.2) ──────────────────────────────────────────────────────
{
  check("age <60s → \"45s\"", formatQueueAge(45_000) === "45s", formatQueueAge(45_000));
  check("age 90s → \"1m\"", formatQueueAge(90_000) === "1m", formatQueueAge(90_000));
  check("age 60m → \"1h\"", formatQueueAge(60 * 60_000) === "1h", formatQueueAge(60 * 60_000));
  check("age 90m → \"1h 30m\"", formatQueueAge(90 * 60_000) === "1h 30m", formatQueueAge(90 * 60_000));
  check("age clamps negatives (−5 → \"0s\")", formatQueueAge(-5) === "0s", formatQueueAge(-5));
}

// ── /queue list (empty / 3 items) ──────────────────────────────────────────────
{
  const { bot, sent } = makeBot();
  const conv = "42";
  await (bot as any).cmdQueue(conv, "");
  check("empty queue → 'no messages' line", sent.some((t) => /No messages|Không có tin/i.test(t)), sent.join(" | "));

  bot.queue.push(conv, { text: "alpha short" });
  bot.queue.push(conv, { text: "beta message" });
  bot.queue.push(conv, { text: "gamma " + "x".repeat(80) }); // long → truncated
  await (bot as any).cmdQueue(conv, "");
  const line = sent[sent.length - 1];
  check("list header shows count (3)", /Queue \(3\)|Hàng chờ \(3\)/.test(line), line);
  check("list is numbered #1, #2, #3 in order", line.indexOf("#1") < line.indexOf("#2") && line.indexOf("#2") < line.indexOf("#3"), line);
  check("list shows each item's text", line.includes("alpha short") && line.includes("beta message"), line);
  check("list truncates long text (… marker)", line.includes("…"), line);
  check("long text is NOT shown in full (80 x's gone)", !line.includes("x".repeat(60)), line);
}

// ── /queue clear ───────────────────────────────────────────────────────────────
{
  const { bot, sent } = makeBot();
  const conv = "42";
  await (bot as any).cmdQueue(conv, "clear");
  check("clear on empty queue → 'already empty'", /already empty|đã trống/i.test(sent[sent.length - 1]), sent[sent.length - 1]);
  bot.queue.push(conv, { text: "a" });
  bot.queue.push(conv, { text: "b" });
  await (bot as any).cmdQueue(conv, "clear");
  check("clear reports the count (2)", /Cleared 2|Đã xoá 2/i.test(sent[sent.length - 1]), sent[sent.length - 1]);
  check("queue is empty after clear", bot.queue.size(conv) === 0, String(bot.queue.size(conv)));
}

// ── audit: queue_add (auto-queue on arrival, busyMode "queue") ─────────────────
{
  const { bot } = makeBot("queue");
  const conv = "42";
  const state = (bot as any).st.get(conv);
  (bot as any).inflight.set(conv, new AbortController()); // busy: a turn is running
  await (bot as any).runPrompt(conv, "auto-queued-me", state, 123, "vi");
  const ev = byAction("queue_add");
  check("queue_add written on auto-queue", ev.length === 1, JSON.stringify(ev));
  check("queue_add meta has messageId + auto:true + queuedCount", ev[0]?.meta?.messageId === 123 && ev[0]?.meta?.auto === true && ev[0]?.meta?.queuedCount === 1, JSON.stringify(ev[0]?.meta));
  check("the message is actually enqueued", bot.queue.size(conv) === 1 && bot.queue.list(conv)[0].text === "auto-queued-me", String(bot.queue.size(conv)));
}

// ── audit: queue_run (drain) ───────────────────────────────────────────────────
{
  const { bot } = makeBot();
  const conv = "42";
  const ran: string[] = [];
  (bot as any).runPrompt = async (_c: string, text: string) => { ran.push(text); return { busy: false }; };
  bot.queue.push(conv, { text: "drain-me" });
  (bot as any).drainQueue(conv); // synchronous shift + audit; runPrompt is fire-and-forget
  await tick();
  const ev = byAction("queue_run");
  check("queue_run written on drain", ev.length === 1, JSON.stringify(ev));
  check("queue_run meta has waitedMs >= 0", typeof ev[0]?.meta?.waitedMs === "number" && (ev[0] as any).meta.waitedMs >= 0, JSON.stringify(ev[0]?.meta));
  check("drained item was run", ran.length === 1 && ran[0] === "drain-me", JSON.stringify(ran));
  check("queue is empty after drain", bot.queue.size(conv) === 0, String(bot.queue.size(conv)));
}

// ── audit: queue_drop (stop) ───────────────────────────────────────────────────
{
  const { bot } = makeBot();
  const conv = "42";
  bot.queue.push(conv, { text: "x" });
  bot.queue.push(conv, { text: "y" });
  await (bot as any).stopCurrent(conv); // interrupt=false → drops the queue, reason "stop"
  const ev = byAction("queue_drop");
  check("queue_drop written on stop", ev.length === 1, JSON.stringify(ev));
  check("queue_drop meta has count 2 + reason 'stop'", ev[0]?.meta?.count === 2 && ev[0]?.meta?.reason === "stop", JSON.stringify(ev[0]?.meta));
  check("queue is empty after stop", bot.queue.size(conv) === 0, String(bot.queue.size(conv)));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll /queue command + queue audit checks passed.");
