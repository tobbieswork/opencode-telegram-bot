/**
 * Unit test for the advisor thread module (src/node/advisor.ts) using the REAL
 * StateManager (temp file) + a fake Telegram + a fake client: startThread
 * (topic + fresh session), followUp (--resume), the per-session turn cap,
 * forget, listThreads, and startThread failure (topic undone).
 *
 * Run:  npx tsx scripts/test-advisor-thread.ts
 */
import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../src/state.js";
import { Advisor } from "../src/node/advisor.js";
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
  const cfg = { advisorMaxTurnsPerSession: 3 } as unknown as Config;
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

  let askCalls: { sessionId?: string; message: string; context?: string }[] = [];
  let forgetCalls: string[] = [];
  let failNextAsk = false;
  const client = {
    ask: async (req: { sessionId?: string; message: string; context?: string }): Promise<import("../src/node/advisor-client.js").AdvisorAnswer> => {
      askCalls.push(req);
      if (failNextAsk) {
        failNextAsk = false;
        throw new Error("claude down");
      }
      const sid = req.sessionId || `sid-${askCalls.length}`;
      return { answer: `advice: ${req.message}`, status: "done", sessionId: sid, costUsd: 0, tokensIn: 1, tokensOut: 2, durationMs: 5, incomplete: false };
    },
    forget: async (sid: string): Promise<void> => {
      forgetCalls.push(sid);
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
    check("forget tells the Mac to drop the session", forgetCalls.includes("sid-1"), JSON.stringify(forgetCalls));

    // 6) startThread failure undoes the topic
    failNextAsk = true;
    let threw = false;
    try {
      await advisor.startThread({ chat, title: "will fail", message: "x" });
    } catch {
      threw = true;
    }
    check("failed startThread throws", threw);
    check("failed startThread deletes the topic", deleted.length === 1, JSON.stringify(deleted));
    check("failed startThread clears state", st.peek(convKey(-100, threadCounter)) === undefined);
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
