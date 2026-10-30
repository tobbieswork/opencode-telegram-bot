/**
 * Unit test for the advisor thread module (src/advisor/advisor.ts) using the REAL
 * StateManager (temp file) + a fake Telegram + a fake client: startThread
 * (topic + fresh session), followUp (--resume), the per-session turn cap,
 * forget, listThreads, startThread failure (topic undone), a Gemini thread
 * (agent kept across follow-ups), a thread saved before agents existed
 * (treated as Claude), an old daemon answering with the wrong agent, a second
 * follow-up while one is in flight, and the /ask argument parser.
 *
 * Run:  npx tsx scripts/test-advisor-thread.ts
 */
import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../src/state.js";
import { Advisor } from "../src/advisor/advisor.js";
import { parseAskArg } from "../src/ask.js";
import { convKey, type ConvKey } from "../src/conv.js";
import type { Config } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "advisor-thread-"));
  const stateFile = join(root, "state.json");
  const st = new StateManager(stateFile);

  let threadCounter = 100;
  const created: string[] = [];
  const deleted: string[] = [];
  const sent: [string, string][] = [];
  const typed: string[] = [];
  const tg = {
    createForumTopic: async (_chatId: number, name: string): Promise<number> => {
      threadCounter++;
      created.push(name);
      return threadCounter;
    },
    deleteForumTopic: async (conv: ConvKey): Promise<void> => {
      deleted.push(String(conv));
    },
    closeForumTopic: async (): Promise<void> => {},
    openForumTopic: async (): Promise<void> => {},
  };
  const cfg = { advisorMaxTurnsPerSession: 3, advisorDefaultAgent: "claude" } as unknown as Config;
  const host = {
    tg,
    st,
    cfg,
    sendHtml: async (conv: ConvKey, html: string): Promise<void> => {
      sent.push([String(conv), html]);
    },
    startTyping: (conv: ConvKey): void => {
      typed.push(String(conv));
    },
  };

  let askCalls: { agent: string; sessionId?: string; message: string; context?: string }[] = [];
  let forgetCalls: string[] = [];
  let failNextAsk = false;
  /** When set, the fake daemon answers as this agent (an old daemon says ""). */
  let answerAs: string | undefined;
  /** When set, ask() waits for it — a follow-up "in flight". */
  let hold: Promise<void> | undefined;
  const client = {
    ask: async (req: { agent: "claude" | "agy"; sessionId?: string; message: string; context?: string }): Promise<import("../src/advisor/advisor-client.js").AdvisorAnswer> => {
      askCalls.push(req);
      if (failNextAsk) {
        failNextAsk = false;
        throw new Error("claude down");
      }
      if (hold) await hold;
      const sid = req.sessionId || `sid-${askCalls.length}`;
      return { answer: `advice: ${req.message}`, status: "done", agent: answerAs ?? req.agent, sessionId: sid, costUsd: 0, tokensIn: 1, tokensOut: 2, durationMs: 5, incomplete: false };
    },
    forget: async (agent: string, sid: string): Promise<void> => {
      forgetCalls.push(`${agent}/${sid}`);
    },
  };

  const advisor = new Advisor(host, { url: "", token: "" }, client);
  const chat = convKey(-100);

  try {
    // 1) startThread
    const t1 = await advisor.startThread({ chat, title: "Chọn DB nào", message: "postgres hay mysql?", context: "ctx" });
    check("startThread creates a 🧠 topic", created.length === 1 && created[0].startsWith("🧠 Claude:"), created.join("|"));
    const s1 = st.get(t1.conv);
    check("startThread sets advisor state", !!s1.advisor, JSON.stringify(s1));
    check("startThread turns=1 + sessionId", s1.advisor!.turns === 1 && s1.advisor!.sessionId === "sid-1", JSON.stringify(s1.advisor));
    check("startThread sent an answer", sent.some(([, h]) => h.includes("advice: postgres hay mysql?")), sent.map(([, h]) => h).join("|"));
    check("startThread passed context to claude", askCalls[0].context === "ctx", JSON.stringify(askCalls[0]));
    check("startThread uses the default agent", askCalls[0].agent === "claude" && s1.advisor!.agent === "claude", JSON.stringify(askCalls[0]));

    // 2) followUp resumes
    const f1 = await advisor.followUp(t1.conv, "hả?");
    check("followUp resumes same session", askCalls[1].sessionId === "sid-1", JSON.stringify(askCalls[1]));
    check("followUp bumps turns to 2", st.get(t1.conv).advisor!.turns === 2);
    check("followUp not capped", f1.capped === false);

    // 3) turn cap (cap=3): 3rd turn ok, 4th capped
    await advisor.followUp(t1.conv, "ok"); // turns 3
    check("turns reached cap", st.get(t1.conv).advisor!.turns === 3);
    const before = askCalls.length;
    const f4 = await advisor.followUp(t1.conv, "quá");
    check("turn-cap refuses the next turn", f4.capped === true);
    check("turn-cap does NOT call claude", askCalls.length === before, `ask ${askCalls.length} want ${before}`);

    // 4) listThreads
    const list = advisor.listThreads(chat);
    check("listThreads returns the thread", list.length === 1 && list[0].title === "Chọn DB nào", JSON.stringify(list));

    // 5) forget
    await advisor.forget(t1.conv);
    check("forget tells the daemon to drop the session (with its agent)", forgetCalls.includes("claude/sid-1"), JSON.stringify(forgetCalls));

    // 4b) a Gemini thread keeps its agent across follow-ups
    const g = await advisor.startThread({ chat, title: "Mongo?", message: "mongo ok?", agent: "agy" });
    check("gemini thread topic is labelled Gemini", created[created.length - 1].startsWith("🧠 Gemini:"), created.join("|"));
    check("gemini thread asks agy", askCalls[askCalls.length - 1].agent === "agy", JSON.stringify(askCalls[askCalls.length - 1]));
    await advisor.followUp(g.conv, "why?");
    check("gemini follow-up stays on agy", askCalls[askCalls.length - 1].agent === "agy" && !!askCalls[askCalls.length - 1].sessionId, JSON.stringify(askCalls[askCalls.length - 1]));
    check("listThreads reports the agent", advisor.listThreads(chat).some((t) => t.agent === "agy"), JSON.stringify(advisor.listThreads(chat)));

    // 4c) a thread saved before agents existed (no agent field) is Claude's
    const legacyConv = convKey(-100, 999);
    st.set(legacyConv, { advisor: { title: "old", sessionId: "old-sid", turns: 1, lastActive: Date.now(), createdAt: Date.now() } });
    await advisor.followUp(legacyConv, "still there?");
    check("legacy thread resumes with claude", askCalls[askCalls.length - 1].agent === "claude" && askCalls[askCalls.length - 1].sessionId === "old-sid", JSON.stringify(askCalls[askCalls.length - 1]));
    await advisor.forget(legacyConv);
    check("legacy thread forget names claude", forgetCalls.includes("claude/old-sid"), JSON.stringify(forgetCalls));
    st.clear(legacyConv);

    // 4d) an old daemon ignores `agent` and answers with Claude → refused, topic undone
    answerAs = "";
    const deletedBefore = deleted.length;
    let mismatch = "";
    try {
      await advisor.startThread({ chat, title: "x", message: "x", agent: "agy" });
    } catch (e) {
      mismatch = (e as Error).message;
    }
    check("old daemon answering as Claude for Gemini → clear error", /install\.sh/.test(mismatch) && /Gemini/.test(mismatch), mismatch);
    check("…and the topic is undone", deleted.length === deletedBefore + 1, JSON.stringify(deleted));
    const okOld = await advisor.startThread({ chat, title: "y", message: "y" }); // claude via an old daemon is fine
    check("old daemon still serves Claude threads", okOld.answer.answer === "advice: y");
    answerAs = undefined;
    st.clear(okOld.conv);

    // 4e) a second follow-up while one is in flight is refused (no extra ask)
    st.set(g.conv, { advisor: { ...st.get(g.conv).advisor!, turns: 0 } }); // room under the cap
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const first = advisor.followUp(g.conv, "slow one");
    await new Promise((r) => setTimeout(r, 10));
    const callsBefore = askCalls.length;
    let busyErr = "";
    try {
      await advisor.followUp(g.conv, "impatient");
    } catch (e) {
      busyErr = (e as Error).message;
    }
    check("second follow-up while busy is refused", /still answering/.test(busyErr), busyErr);
    check("…without calling the daemon", askCalls.length === callsBefore, `${askCalls.length} vs ${callsBefore}`);
    check("…and the user is told to wait", sent.some(([c, h]) => c === String(g.conv) && h.includes("vẫn đang trả lời")));
    hold = undefined;
    release();
    await first;
    await advisor.followUp(g.conv, "after");
    check("thread accepts follow-ups again once the answer is in", askCalls[askCalls.length - 1].message === "after");
    st.clear(g.conv);

    // 6) startThread failure undoes the topic
    const deletedBefore6 = deleted.length;
    failNextAsk = true;
    let threw = false;
    try {
      await advisor.startThread({ chat, title: "will fail", message: "x" });
    } catch {
      threw = true;
    }
    check("failed startThread throws", threw);
    check("failed startThread deletes the topic", deleted.length === deletedBefore6 + 1, JSON.stringify(deleted));
    check("failed startThread clears state", st.peek(convKey(-100, threadCounter)) === undefined);

    // 7) /ask argument parsing
    const p1 = parseAskArg("gemini postgres hay mongo?");
    check("/ask gemini <q> → agy", p1.agent === "agy" && p1.question === "postgres hay mongo?", JSON.stringify(p1));
    const p2 = parseAskArg("Claude   nên dùng gì?");
    check("/ask Claude <q> → claude (case-insensitive)", p2.agent === "claude" && p2.question === "nên dùng gì?", JSON.stringify(p2));
    const p3 = parseAskArg("postgres hay mongo?");
    check("/ask <q> → default agent", p3.agent === undefined && p3.question === "postgres hay mongo?", JSON.stringify(p3));
    const p4 = parseAskArg("gemini");
    check("/ask gemini (no question) → list", p4.question === "", JSON.stringify(p4));
    const p5 = parseAskArg("  ");
    check("/ask (empty) → list", p5.question === "" && p5.agent === undefined, JSON.stringify(p5));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  void typed;
  console.log(failures === 0 ? "\n  ALL OK (advisor-thread)" : `\n  ${failures} FAILURE(S) (advisor-thread)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("advisor-thread test crashed:", e);
  process.exit(1);
});
