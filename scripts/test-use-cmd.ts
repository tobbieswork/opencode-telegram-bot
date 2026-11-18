/**
 * /use (issue #157): switching sessions must stop the running turn on the old
 * session AND validate the target session before switching:
 *   - turn inflight on A, /use B → oc.interrupt awaited for A, state → B;
 *   - /use to a non-existent id → clear error, state unchanged, no interrupt;
 *   - the same two behaviours via the use: picker callback (stale buttons);
 *   - pending /note content is dropped on the switch (notes are conv-scoped
 *     and would otherwise be injected into the new session's next turn).
 *
 * Runs against a mock Bot (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-use-cmd.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { cmdUse, handleUseCallback } from "../src/commands/session.js";
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

const tmp = mkdtempSync(join(tmpdir(), "ocbot-ucmd-"));
configureAudit({ path: join(tmp, "audit.log") });

function makeBot() {
  const sent: string[] = [];
  const answered: string[] = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_conv: string, text: string) => { sent.push(text); return 1; },
    answerCallbackQuery: async (_id: string, text?: string) => { answered.push(text ?? ""); },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
    stop: () => {},
  };
  const interrupted: string[] = [];
  const list: Array<{ id: string; title?: string; updated?: number }> = [
    { id: "ses_A", updated: 3 },
    { id: "ses_B", updated: 2 },
  ];
  const oc: any = {
    listSessions: async () => list,
    interrupt: async (sid: string) => { interrupted.push(sid); },
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
    prompt: async () => "msg_x",
    createSession: async () => "ses_new",
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(tmp, "state.json"));
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode: "queue" };
  const bot = new Bot(tg, oc, st, cfg);
  // Neutralize the reply/typing/stream machinery so only the switch logic runs.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  return { bot, sent, answered, interrupted, list, st };
}

const conv = "42";

// ── /use while a turn is inflight on A → interrupt A, state → B ─────────────
{
  const { bot, interrupted, st } = makeBot();
  st.set(conv, { sessionID: "ses_A" });
  const ac = new AbortController();
  (bot as any).inflight.set(conv, ac); // a turn is running on A
  await cmdUse(bot as any, conv, "ses_B", st.get(conv));
  check("inflight /use → oc.interrupt awaited for the OLD session", interrupted.length === 1 && interrupted[0] === "ses_A", JSON.stringify(interrupted));
  check("inflight /use → inflight controller aborted", ac.signal.aborted === true);
  check("inflight /use → state switched to B", st.get(conv).sessionID === "ses_B", st.get(conv).sessionID);
}

// ── /use to a non-existent id → error, state unchanged, no interrupt ────────
{
  const { bot, sent, interrupted, st } = makeBot();
  st.set(conv, { sessionID: "ses_A" });
  (bot as any).inflight.set(conv, new AbortController());
  await cmdUse(bot as any, conv, "ses_nope", st.get(conv));
  check("unknown id → error mentioning the id", sent.some((t) => /Không có session|No session/.test(t) && t.includes("ses_nope")), sent.join(" | "));
  check("unknown id → state unchanged (still A)", st.get(conv).sessionID === "ses_A", st.get(conv).sessionID);
  check("unknown id → no interrupt sent", interrupted.length === 0, JSON.stringify(interrupted));
}

// ── /use drops pending notes (conv-scoped; must not leak into session B) ────
{
  const { bot, st } = makeBot();
  st.set(conv, { sessionID: "ses_A", notes: "- 12:00: remember the API key", notesStage: "pending" });
  await cmdUse(bot as any, conv, "ses_B", st.get(conv));
  const s = st.get(conv);
  check("switch drops pending notes", s.notes === undefined && s.notesStage === undefined, JSON.stringify({ notes: s.notes, notesStage: s.notesStage }));
}

// ── use: callback while inflight on A → interrupt A, state → B ──────────────
{
  const { bot, interrupted, st } = makeBot();
  st.set(conv, { sessionID: "ses_A" });
  (bot as any).inflight.set(conv, new AbortController());
  await handleUseCallback(bot as any, { id: "cb1", data: "use:ses_B", from: { id: 1 } }, conv, 7);
  check("callback /use → oc.interrupt awaited for the OLD session", interrupted.length === 1 && interrupted[0] === "ses_A", JSON.stringify(interrupted));
  check("callback /use → state switched to B", st.get(conv).sessionID === "ses_B", st.get(conv).sessionID);
}

// ── use: callback with a stale (deleted) session → error, state unchanged ───
{
  const { bot, answered, interrupted, st } = makeBot();
  st.set(conv, { sessionID: "ses_A" });
  (bot as any).inflight.set(conv, new AbortController());
  await handleUseCallback(bot as any, { id: "cb2", data: "use:ses_gone", from: { id: 1 } }, conv, 7);
  check("stale callback → toast error mentioning the id", answered.some((t) => /Không có session|No session/.test(t) && t.includes("ses_gone")), JSON.stringify(answered));
  check("stale callback → state unchanged (still A)", st.get(conv).sessionID === "ses_A", st.get(conv).sessionID);
  check("stale callback → no interrupt sent", interrupted.length === 0, JSON.stringify(interrupted));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll /use switch (stop + validate + notes) checks passed.");
