/**
 * Unit test: the session feature module (src/commands/session.ts, moved out
 * of bot.ts — docs/sdd/split-bot-ts.md T5).
 *
 * Covers the /new confirm card + the nw: flow (clear / keep / cancel), the
 * fresh-session mechanics (doNewSession: stop the old turn, create the
 * session, apply model, inject the carry-over instruction, stop the watch),
 * /ls, /stop (via stopTaskFor), /clear (state + question-form wipe),
 * /history and the shared applyUseState primitive, driven through a real
 * `Bot` with fake `tg`/`oc` — same harness as test-model.ts.
 *
 * Run:  npx tsx scripts/test-session.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { esc } from "../src/format.js";
import { configureAudit } from "../src/audit.js";
import {
  cmdNew,
  doNewSession,
  handleNewConfirmCallback,
  summarizeForHandoff,
  cmdList,
  cmdUse,
  applyUseState,
  handleUseCallback,
  stopTaskFor,
  cmdStop,
  cmdClear,
  cmdHistory,
} from "../src/commands/session.js";

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
  edits: { conv: string; msgId: number; text?: string; kb?: unknown }[];
  deleted: number[];
  answers: { id: string; text?: string }[];
}

function makeBot() {
  const base = mkdtempSync(join(tmpdir(), "tg-session-"));
  const st = new StateManager(join(base, "state.json"));
  configureAudit({ path: join(base, "audit.log") });
  const rec: Rec = { sent: [], edits: [], deleted: [], answers: [] };
  const tg: any = {
    sendMessage: async (conv: string, text: string, opts?: { reply_markup?: unknown }) => {
      rec.sent.push({ conv, text, kb: opts?.reply_markup });
      return rec.sent.length;
    },
    editMessageText: async (conv: string, msgId: number, text?: string, opts?: { reply_markup?: unknown }) => {
      rec.edits.push({ conv, msgId, text, kb: opts?.reply_markup });
    },
    deleteMessage: async (_conv: string, msgId: number) => {
      rec.deleted.push(msgId);
    },
    answerCallbackQuery: async (id: string, text?: string) => {
      rec.answers.push({ id, text });
    },
  };
  const calls = {
    create: [] as string[],
    setInstruction: [] as { sid: string; key: string; text: string }[],
    setModel: [] as { sid: string; model: any }[],
    setAgent: [] as { sid: string; agent: string }[],
    interrupt: [] as string[],
    prompt: [] as { sid: string; text: string }[],
    messages: [] as string[],
  };
  let n = 0;
  const oc: any = {
    createSession: async (dir: string) => {
      calls.create.push(dir);
      return `ses_new_${++n}`;
    },
    listSessions: async () => [
      { id: "ses_A", title: "Alpha", updated: 3 },
      { id: "ses_B", updated: 2 },
    ],
    listMessages: async (sid: string) => {
      calls.messages.push(sid);
      return [
        { type: "user", text: "hello", time: { created: 1 } },
        { type: "assistant", content: [{ type: "text", text: "hi there" }], time: { created: 2 } },
        { type: "tool", time: { created: 3 } },
      ];
    },
    setInstruction: async (sid: string, key: string, text: string) => {
      calls.setInstruction.push({ sid, key, text });
    },
    removeInstruction: async () => {},
    setModel: async (sid: string, model: any) => {
      calls.setModel.push({ sid, model });
    },
    setAgent: async (sid: string, agent: string) => {
      calls.setAgent.push({ sid, agent });
    },
    getSession: async () => null,
    promptAndWait: async (sid: string, text: string) => {
      calls.prompt.push({ sid, text });
      return { reply: "SUMMARY" };
    },
    interrupt: async (sid: string) => {
      calls.interrupt.push(sid);
    },
  };
  const cfg: any = {
    stateFile: join(base, "state.json"),
    maxSchedules: 5,
    replyMaxLen: 4000,
    opencodeDirectory: join(base, "workdir"),
  };
  const bot = new Bot(tg, oc, st, cfg);
  return { bot, st, rec, calls, cfg, base };
}

const CONV = "42";
const OTHER = "43";
const CB = (data: string, id = "cb1"): any => ({ id, data, from: { id: 42 } });

async function main(): Promise<void> {
  // ── /new card ────────────────────────────────────────────────────────────
  {
    const { bot, rec } = makeBot();
    await cmdNew(bot, CONV);
    const kb = JSON.stringify(rec.sent[0]?.kb);
    check("cmdNew: one card with clear/keep/cancel buttons", rec.sent.length === 1 && kb.includes("nw:clear") && kb.includes("nw:keep") && kb.includes("nw:cancel"), kb);
    check("cmdNew: card title names /new", rec.sent[0]?.text.startsWith("⚠️ <b>/new</b>"), rec.sent[0]?.text);
  }

  // ── nw:cancel — nothing happens to the session ───────────────────────────
  {
    const { bot, st, rec, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_old" });
    await handleNewConfirmCallback(bot, CB("nw:cancel"), CONV, 500);
    check("nw:cancel: no session created", calls.create.length === 0, JSON.stringify(calls.create));
    check("nw:cancel: state unchanged", st.get(CONV).sessionID === "ses_old", st.get(CONV).sessionID);
    check("nw:cancel: toast + card settled (buttons removed)", rec.answers[0]?.text?.startsWith("↩️") && rec.edits.length === 1 && JSON.stringify(rec.edits[0].kb) === JSON.stringify({ inline_keyboard: [] }), JSON.stringify({ answers: rec.answers, edits: rec.edits }));
  }

  // ── nw:clear — fresh session, no carry-over ──────────────────────────────
  {
    const { bot, st, rec, calls, base } = makeBot();
    const dir = join(base, "workdir", "sub");
    st.set(CONV, { sessionID: "ses_old", directory: dir, notes: "- pending", notesStage: "pending" });
    await handleNewConfirmCallback(bot, CB("nw:clear"), CONV, 500);
    check("nw:clear: created in the chat directory", calls.create.length === 1 && calls.create[0] === dir, JSON.stringify(calls.create));
    check("nw:clear: state switched to the fresh session + dir", st.get(CONV).sessionID === "ses_new_1" && st.get(CONV).directory === dir, JSON.stringify(st.get(CONV)));
    check("nw:clear: pending notes dropped", st.get(CONV).notes === undefined && st.get(CONV).notesStage === undefined, JSON.stringify(st.get(CONV)));
    check("nw:clear: no summary, no carry-over instruction", calls.prompt.length === 0 && calls.setInstruction.length === 0);
    check("nw:clear: reply names the new session", rec.sent.some((m) => m.text.includes("🆕 New session <code>ses_new_1</code>") && m.text.includes(`dir: <code>${esc(dir)}</code>`)), JSON.stringify(rec.sent.map((m) => m.text)));
    check("nw:clear: card settled on the chosen action", rec.edits.length === 1 && (rec.edits[0].text ?? "").includes("Clear"), JSON.stringify({ answers: rec.answers, edits: rec.edits.map((e) => e.text) }));
  }

  // ── nw:clear without an old session or directory ─────────────────────────
  {
    const { bot, st, calls, cfg } = makeBot();
    st.set(CONV, {});
    await handleNewConfirmCallback(bot, CB("nw:clear"), CONV, 500);
    check("nw:clear (empty state): falls back to cfg directory", calls.create.length === 1 && calls.create[0] === cfg.opencodeDirectory, JSON.stringify(calls.create));
    check("nw:clear (empty state): state now has a session", st.get(CONV).sessionID === "ses_new_1" && st.get(CONV).directory === cfg.opencodeDirectory, JSON.stringify(st.get(CONV)));
  }

  // ── nw:keep — summarize the old session, inject carry-over ───────────────
  {
    const { bot, st, rec, calls, base } = makeBot();
    st.set(CONV, { sessionID: "ses_old" });
    await handleNewConfirmCallback(bot, CB("nw:keep"), CONV, 500);
    check("nw:keep: summarised the OLD session", calls.prompt.length === 1 && calls.prompt[0].sid === "ses_old", JSON.stringify(calls.prompt));
    check("nw:keep: carry-over instruction injected into the fresh session", calls.setInstruction.length === 1 && calls.setInstruction[0].sid === "ses_new_1" && calls.setInstruction[0].key === "tgbot.carryover" && calls.setInstruction[0].text.includes("SUMMARY"), JSON.stringify(calls.setInstruction));
    check("nw:keep: reply shows a successful carry-over", rec.sent.some((m) => m.text.includes("🔁 carry-over: ✓")), JSON.stringify(rec.sent.map((m) => m.text)));
    check("nw:keep: card settled on the keep action", rec.edits.length === 1 && (rec.edits[0].text ?? "").includes("Clear + giữ ngữ cảnh"), JSON.stringify({ answers: rec.answers, edits: rec.edits.map((e) => e.text) }));
  }

  // ── nw:keep when the old session can't be summarised ─────────────────────
  {
    const { bot, st, rec, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_old" });
    (bot as any).oc.promptAndWait = async () => {
      throw new Error("boom");
    };
    await handleNewConfirmCallback(bot, CB("nw:keep"), CONV, 500);
    check("nw:keep (summary failed): session still created, no instruction", calls.create.length === 1 && calls.setInstruction.length === 0, JSON.stringify({ create: calls.create, ins: calls.setInstruction }));
    check("nw:keep (summary failed): reply marks the carry-over empty", rec.sent.some((m) => m.text.includes("(session cũ trống)")), JSON.stringify(rec.sent.map((m) => m.text)));
  }

  // ── doNewSession directly (agent preserved) ──────────────────────────────
  {
    const { bot, st, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_old", agent: "build" });
    await doNewSession(bot, CONV, st.get(CONV), false);
    check("doNewSession: agent re-applied to the fresh session", calls.setAgent.length === 1 && calls.setAgent[0].sid === "ses_new_1" && calls.setAgent[0].agent === "build", JSON.stringify(calls.setAgent));
    check("doNewSession: state has the new session", st.get(CONV).sessionID === "ses_new_1", st.get(CONV).sessionID);
  }

  // ── summarizeForHandoff ──────────────────────────────────────────────────
  {
    const { bot } = makeBot();
    const s = await summarizeForHandoff(bot, "ses_x");
    check("summarizeForHandoff: returns the trimmed reply", s === "SUMMARY", s);
    (bot as any).oc.promptAndWait = async () => ({ reply: "x".repeat(5000) });
    const long = await summarizeForHandoff(bot, "ses_x");
    check("summarizeForHandoff: truncates >4000 chars with an ellipsis", long.length === 4001 && long.endsWith("…"), `len=${long.length}`);
    (bot as any).oc.promptAndWait = async () => {
      throw new Error("down");
    };
    const failed = await summarizeForHandoff(bot, "ses_x");
    check("summarizeForHandoff: failure → empty string", failed === "");
  }

  // ── /ls ──────────────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { sessionID: "ses_B" });
    await cmdList(bot, CONV);
    check("cmdList: lists with the current one marked", rec.sent.length === 1 && rec.sent[0].text.includes("Sessions (2)") && rec.sent[0].text.includes("▶️ <code>ses_B</code>"), rec.sent[0]?.text);
    check("cmdList: footer names the current session", rec.sent[0].text.includes("<code>ses_B</code>") && rec.sent[0].text.includes("Alpha"), rec.sent[0].text);

    const b2 = makeBot();
    (b2.bot as any).oc.listSessions = async () => [];
    await cmdList(b2.bot, CONV);
    check("cmdList: empty → hint to /new", b2.rec.sent[0].text.includes("/new"), b2.rec.sent[0].text);
  }

  // ── /use without arg → picker ────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    await cmdUse(bot, CONV, "", st.get(CONV));
    const pick = JSON.stringify(rec.sent[0]?.kb);
    check("cmdUse (no arg): picker with both sessions + ls/close", pick.includes("use:ses_A") && pick.includes("use:ses_B") && pick.includes("use:ls") && pick.includes("use:close"), pick);
    check("cmdUse (no arg): newest first", pick.indexOf("use:ses_A") < pick.indexOf("use:ses_B"), pick.slice(0, 200));
    check("cmdUse (no arg): card has a note line + buttons", rec.sent[0].text !== undefined && rec.sent[0].kb !== undefined, JSON.stringify(rec.sent[0]?.text));
  }

  // ── /use unknown id → picker with error note ─────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    await cmdUse(bot, CONV, "zzz", st.get(CONV));
    check("cmdUse (unknown id): error note + picker", rec.sent[0].text.includes("zzz") && JSON.stringify(rec.sent[0].kb).includes("use:ses_A"), rec.sent[0].text);
  }

  // ── /use when the listing fails → trust the typed id ─────────────────────
  {
    const { bot, st, rec, calls } = makeBot();
    (bot as any).oc.listSessions = async () => {
      throw new Error("down");
    };
    st.set(CONV, { sessionID: "ses_A" });
    (bot as any).inflight.set(CONV, new AbortController());
    await cmdUse(bot, CONV, "ses_X", st.get(CONV));
    check("cmdUse (listing down): switches anyway", st.get(CONV).sessionID === "ses_X", st.get(CONV).sessionID);
    check("cmdUse (listing down): reply confirms", rec.sent.some((m) => m.text.includes("ses_X")), JSON.stringify(rec.sent.map((m) => m.text)));
    check("cmdUse (listing down): old turn interrupted", calls.interrupt.length === 1 && calls.interrupt[0] === "ses_A", JSON.stringify(calls.interrupt));
  }

  // ── /use valid → stop the old turn, switch, clear the queue ──────────────
  {
    const { bot, st, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_A" });
    const ac = new AbortController();
    (bot as any).inflight.set(CONV, ac);
    bot.queue.push(CONV, { text: "queued" });
    await cmdUse(bot, CONV, "ses_B", st.get(CONV));
    check("cmdUse (valid): inflight aborted + old session interrupted", ac.signal.aborted === true && calls.interrupt.length === 1 && calls.interrupt[0] === "ses_A", JSON.stringify(calls.interrupt));
    check("cmdUse (valid): queue cleared on the switch", bot.queue.size(CONV) === 0, String(bot.queue.size(CONV)));
    check("cmdUse (valid): state switched", st.get(CONV).sessionID === "ses_B", st.get(CONV).sessionID);
  }

  // ── use: callback — close / ls / valid / stale ───────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { sessionID: "ses_A" });
    await handleUseCallback(bot, CB("use:close"), CONV, 700);
    check("use:close: card deleted", rec.deleted.includes(700), JSON.stringify(rec.deleted));

    await handleUseCallback(bot, CB("use:ls"), CONV, 700);
    check("use:ls: card deleted + /ls sent", rec.deleted.includes(700) && rec.sent.some((m) => m.text.includes("Sessions (2)")), JSON.stringify(rec.sent.map((m) => m.text)));

    const ac = new AbortController();
    (bot as any).inflight.set(CONV, ac);
    await handleUseCallback(bot, CB("use:ses_B"), CONV, 700);
    check("use:<id>: switched + card settled", st.get(CONV).sessionID === "ses_B" && ac.signal.aborted && rec.edits.some((e) => e.msgId === 700 && (e.text ?? "").includes("ses_B")), JSON.stringify(rec.edits));
  }
  {
    const { bot, st, rec, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_A" });
    await handleUseCallback(bot, CB("use:ses_gone"), CONV, 700);
    check("use:<stale id>: toast error, state unchanged", rec.answers.some((a) => (a.text ?? "").includes("ses_gone")) && st.get(CONV).sessionID === "ses_A", JSON.stringify({ answers: rec.answers, sid: st.get(CONV).sessionID }));
    check("use:<stale id>: no interrupt", calls.interrupt.length === 0, JSON.stringify(calls.interrupt));
  }

  // ── applyUseState (shared switch primitive) ──────────────────────────────
  {
    const { bot, st } = makeBot();
    st.set(CONV, { sessionID: "ses_A", notes: "- keep?", notesStage: "pending" });
    bot.queue.push(CONV, { text: "q1" });
    applyUseState(bot, CONV, "ses_B");
    const s = st.get(CONV);
    check("applyUseState: switches + drops notes + clears queue", s.sessionID === "ses_B" && s.notes === undefined && bot.queue.size(CONV) === 0, JSON.stringify({ s, q: bot.queue.size(CONV) }));
  }

  // ── stopTaskFor (the /stop engine) ───────────────────────────────────────
  {
    const { bot, st, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_A" });
    const ac = new AbortController();
    (bot as any).inflight.set(CONV, ac);
    bot.queue.push(CONV, { text: "q1" });
    await stopTaskFor(bot, CONV, "ses_A");
    check("stopTaskFor: aborts + interrupts + clears queue", ac.signal.aborted === true && calls.interrupt.length === 1 && calls.interrupt[0] === "ses_A" && bot.queue.size(CONV) === 0, JSON.stringify(calls.interrupt));

    const b2 = makeBot();
    const ac2 = new AbortController();
    (b2.bot as any).inflight.set(OTHER, ac2);
    await stopTaskFor(b2.bot, OTHER);
    check("stopTaskFor (no session id): aborts without interrupting", ac2.signal.aborted === true && b2.calls.interrupt.length === 0, JSON.stringify(b2.calls.interrupt));
  }

  // ── /stop ────────────────────────────────────────────────────────────────
  {
    const { bot, st, rec, calls } = makeBot();
    st.set(CONV, { sessionID: "ses_A" });
    await cmdStop(bot, CONV, st.get(CONV));
    check("cmdStop: interrupts the session + replies", calls.interrupt.length === 1 && calls.interrupt[0] === "ses_A" && rec.sent.some((m) => m.text === "⏹️ Interrupted."), JSON.stringify({ i: calls.interrupt, sent: rec.sent.map((m) => m.text) }));
  }

  // ── /clear ───────────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { sessionID: "ses_A", notes: "- x", notesStage: "pending" });
    st.set(OTHER, { sessionID: "ses_O" });
    (bot as any).questionForms.set("f1", { formId: "f1", conv: CONV, sessionID: "ses_A", relayConv: CONV, fields: [], index: 0, answers: {} });
    (bot as any).questionForms.set("f2", { formId: "f2", conv: OTHER, sessionID: "ses_O", relayConv: OTHER, fields: [], index: 0, answers: {} });
    await cmdClear(bot, CONV, st.get(CONV));
    check("cmdClear: conv state wiped", st.get(CONV).sessionID === undefined, JSON.stringify(st.get(CONV)));
    check("cmdClear: other conv untouched", st.get(OTHER).sessionID === "ses_O", st.get(OTHER).sessionID);
    check("cmdClear: only this conv's question forms dropped", !(bot as any).questionForms.has("f1") && (bot as any).questionForms.has("f2"), JSON.stringify([...(bot as any).questionForms.keys()]));
    check("cmdClear: reply confirms", rec.sent.some((m) => m.text.startsWith("🧹 State cleared.")), JSON.stringify(rec.sent.map((m) => m.text)));
  }

  // ── /history ─────────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    await cmdHistory(bot, CONV, {});
    check("cmdHistory: no session → hint", rec.sent[0]?.text === "No current session. Send /new.", rec.sent[0]?.text);

    st.set(CONV, { sessionID: "ses_A" });
    await cmdHistory(bot, CONV, st.get(CONV));
    const t = rec.sent[1]?.text ?? "";
    check("cmdHistory: renders recent user/assistant/tool lines", t.includes("Recent messages") && t.includes("👤 hello") && t.includes("🤖 hi there") && t.includes("· tool"), t);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll session checks passed.");
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
