/**
 * Checks the graceful-shutdown drain core (drainInflightCore in src/bot.ts):
 * it waits for in-flight work (fake promises standing in for runPrompt tasks
 * and the final-reply sweeps) to settle, returns true when everything settles
 * within the cap, and gives up (false) exactly at the cap when work never
 * settles.
 *
 * It also exercises the Phase-3 queue drain layer (docs/sdd/queue-and-steer.md,
 * Q1.8/Q1.11/Q1.5): the runPromptTask "drain only on a succeeded turn" gate,
 * drainQueue's one-item-per-turn FIFO + race-safe requeue, the queue-clear on
 * /stop and session switch, and the shutdown "queued turns won't run" notice —
 * all against a mock Bot (no live Telegram / OpenCode / systemd).
 *
 * Run:  npx tsx scripts/test-drain.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainInflightCore, Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── already idle: nothing to drain ─────────────────────────────────────────
{
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => false, timeoutMs: 500 });
  const dt = Date.now() - t0;
  check("idle → true", res === true);
  check("idle → returns fast (<50ms)", dt < 50, `dt=${dt}ms`);
}

// ── work that settles after 80ms: drain must actually wait for it ──────────
{
  let done = false;
  setTimeout(() => (done = true), 80); // fake in-flight promise resolving at 80ms
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => !done, timeoutMs: 2_000 });
  const dt = Date.now() - t0;
  check("work settles at 80ms → true", res === true);
  check("waited for the work (≥75ms, not returned early)", dt >= 75, `dt=${dt}ms`);
}

// ── two works: must wait for the SLOWER one ────────────────────────────────
{
  let done1 = false;
  let done2 = false;
  setTimeout(() => (done1 = true), 60);
  setTimeout(() => (done2 = true), 120);
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => !done1 || !done2, timeoutMs: 2_000 });
  const dt = Date.now() - t0;
  check("two works → true once BOTH settle", res === true);
  check("waited for the slower one (≥115ms)", dt >= 115, `dt=${dt}ms`);
}

// ── work that NEVER settles: give up at the cap, never block forever ───────
{
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => true, timeoutMs: 200, pollMs: 25 });
  const dt = Date.now() - t0;
  check("never-settling → false", res === false);
  check("gave up at the cap (~200ms, bounded)", dt >= 200 && dt <= 325, `dt=${dt}ms`);
}

// ── work that APPEARS during the drain (the real manager flow): the terminal
//    event ends the turn, which registers the final-reply sweep; the drain
//    must pick the sweep up on the next poll and wait for it too. ───────────
{
  const pending = new Set<Promise<unknown>>();
  let turnBusy = true;
  setTimeout(() => {
    turnBusy = false; // turn ends at ~50ms
    const sweep = sleep(100); // final-reply sweep settles ~150ms after start
    pending.add(sweep);
    void sweep.finally(() => pending.delete(sweep));
  }, 50);
  const t0 = Date.now();
  const res = await drainInflightCore({
    isBusy: () => turnBusy || pending.size > 0,
    timeoutMs: 2_000,
  });
  const dt = Date.now() - t0;
  check("sweep spawned by the settling turn is awaited → true", res === true);
  check("waited past the sweep (≥145ms)", dt >= 145, `dt=${dt}ms`);
}

// ── cap hit while a late sweep is still pending → false, not a hang ────────
{
  const pending = new Set<Promise<unknown>>();
  let turnBusy = true;
  setTimeout(() => {
    turnBusy = false;
    const sweep = sleep(1_000); // settles well AFTER the 200ms cap
    pending.add(sweep);
    void sweep.finally(() => pending.delete(sweep));
  }, 50);
  const t0 = Date.now();
  const res = await drainInflightCore({
    isBusy: () => turnBusy || pending.size > 0,
    timeoutMs: 200,
    pollMs: 25,
  });
  const dt = Date.now() - t0;
  check("late sweep + short cap → false", res === false);
  check("still bounded at the cap (~200ms)", dt >= 200 && dt <= 325, `dt=${dt}ms`);
}

// ── Phase-3 queue drain layer (against a mock Bot) ─────────────────────────
// A Bot whose reply/typing machinery is neutralized, so the drain logic runs in
// isolation. `oc.promptAndWait` is re-pointed per test to control the turn
// outcome; `tg.sendMessage` records what the bot would have sent.
function makeBot() {
  const tmp = mkdtempSync(join(tmpdir(), "ocbot-drain-"));
  const sent: { conv: string; text: string }[] = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (conv: string, text: string) => {
      sent.push({ conv, text });
      return 1;
    },
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
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode: "queue" };
  const bot = new Bot(tg, oc, st, cfg);
  // Neutralize the reply/typing machinery so only the drain logic is under test.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  return { bot, tg, oc, st, sent, tmp };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

// (1) drain-on-success: a SUCCEEDED turn runs the next queued message.
{
  const { bot, oc } = makeBot();
  let drainCalls = 0;
  (bot as any).drainQueue = () => drainCalls++;
  oc.promptAndWait = async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 });
  await (bot as any).runPromptTask("1", "ses_1", "go", new AbortController(), undefined, "vi");
  check("succeeded turn → drainQueue runs", drainCalls === 1, String(drainCalls));
}

// (2) hold-on-fail: a FAILED or INTERRUPTED turn holds the queue (no drain).
{
  const { bot, oc } = makeBot();
  let drainCalls = 0;
  (bot as any).drainQueue = () => drainCalls++;
  oc.promptAndWait = async () => ({ reply: "", outcome: "failed", interrupted: false, elapsedMs: 1 });
  await (bot as any).runPromptTask("1", "ses_1", "go", new AbortController(), undefined, "vi");
  check("failed turn → no drain", drainCalls === 0, String(drainCalls));
}
{
  const { bot, oc } = makeBot();
  let drainCalls = 0;
  (bot as any).drainQueue = () => drainCalls++;
  oc.promptAndWait = async () => ({ reply: "", outcome: "failed", interrupted: true, elapsedMs: 1 });
  await (bot as any).runPromptTask("1", "ses_1", "go", new AbortController(), undefined, "vi");
  check("interrupted turn → no drain", drainCalls === 0, String(drainCalls));
}

// (3) chain of 2: drainQueue runs ONE item per turn-end, FIFO, until empty.
{
  const { bot } = makeBot();
  const ran: string[] = [];
  (bot as any).runPrompt = async (_c: string, text: string) => {
    ran.push(text);
    return { busy: false };
  };
  bot.st.set("1", { sessionID: "ses_1" });
  bot.queue.push("1", { text: "first" });
  bot.queue.push("1", { text: "second" });
  (bot as any).drainQueue("1"); // turn-end #1 (after the running turn) → head
  check("drain #1 runs only the head (first)", ran.length === 1 && ran[0] === "first", JSON.stringify(ran));
  check("…the rest stays queued", bot.queue.size("1") === 1, String(bot.queue.size("1")));
  (bot as any).drainQueue("1"); // turn-end #2 (after "first" finished) → next
  check("drain #2 runs the next item (second)", ran.length === 2 && ran[1] === "second", JSON.stringify(ran));
  check("queue empty after both drains", bot.queue.size("1") === 0, String(bot.queue.size("1")));
}

// (4) queue full (cap 3): a drain runs only the head, the rest remain.
{
  const { bot } = makeBot();
  const ran: string[] = [];
  (bot as any).runPrompt = async (_c: string, text: string) => {
    ran.push(text);
    return { busy: false };
  };
  bot.st.set("1", { sessionID: "ses_1" });
  bot.queue.push("1", { text: "a" });
  bot.queue.push("1", { text: "b" });
  bot.queue.push("1", { text: "c" });
  (bot as any).drainQueue("1");
  check("queue full: only the head is drained", ran.length === 1 && ran[0] === "a", JSON.stringify(ran));
  check("…2 remain queued", bot.queue.size("1") === 2, String(bot.queue.size("1")));
}

// (race safety, Q1.11) a user message that wins the race makes runPrompt report
// busy → the drained item is put back, so it is not lost (re-runs next turn-end).
{
  const { bot } = makeBot();
  (bot as any).runPrompt = async () => ({ busy: true });
  bot.st.set("1", { sessionID: "ses_1" });
  bot.queue.push("1", { text: "A" });
  (bot as any).drainQueue("1");
  await tick(); // let the .then requeue fire
  check("lost the race → item is put back (not lost)", bot.queue.size("1") === 1 && bot.queue.list("1")[0].text === "A", JSON.stringify(bot.queue.list("1")));
}

// (5) stop clears the queue: /stop (= stopCurrent) drops every queued message.
{
  const { bot } = makeBot();
  bot.st.set("1", { sessionID: "ses_1" });
  bot.queue.push("1", { text: "a" });
  bot.queue.push("1", { text: "b" });
  await (bot as any).stopCurrent("1");
  check("/stop clears the queue", bot.queue.size("1") === 0, String(bot.queue.size("1")));
}

// (session switch, Q1.5) switching sessions clears the queue.
{
  const { bot } = makeBot();
  bot.st.set("1", { sessionID: "ses_old" });
  bot.queue.push("1", { text: "a" });
  (bot as any).applyUseState("1", "ses_new");
  check("session switch clears the queue", bot.queue.size("1") === 0, String(bot.queue.size("1")));
}

// (6) shutdown blocks the drain: while draining, no queued turn starts, and the
// chat holding queued messages is told they will not run (Q1.8).
{
  const { bot, sent } = makeBot();
  (bot as any).draining = true;
  let ran = 0;
  (bot as any).runPrompt = async () => {
    ran++;
    return { busy: false };
  };
  bot.st.set("1", { sessionID: "ses_1" });
  bot.queue.push("1", { text: "a" });
  (bot as any).drainQueue("1");
  check("shutdown: drain blocked (no turn starts)", ran === 0, String(ran));
  check("…the queued item is preserved", bot.queue.size("1") === 1, String(bot.queue.size("1")));
  (bot as any).notifyQueuedNotRunning();
  await tick();
  check("shutdown: queued conv is notified", sent.some((s) => s.conv === "1"), JSON.stringify(sent));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
