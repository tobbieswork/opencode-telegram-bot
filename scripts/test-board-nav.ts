/**
 * Manager board → per-worker topic-jump buttons (Telegram `switch_to_topic`):
 *   - maybeOfferManagerBoard offers one switch_to_topic row per BUSY worker that
 *     has an introMessageId anchor; unanchored workers (spawned before the anchor
 *     existed) are skipped; if none is anchored, NOTHING is sent (no line at all);
 *   - labels are localized (VN default + EN) and carry the worker's status word;
 *   - off-mode (nextSteps off) sends nothing (byte-identical to today);
 *   - an OLD pending "board" next-step callback (offered before this deploy) still
 *     routes to cmdBoard — the tap branch is unchanged, those buttons live on the
 *     24h registry TTL.
 *
 * The /board typed command and cmdBoard itself are unchanged and out of scope.
 *
 * Runs against a mock Bot + a temp audit file (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-board-nav.ts
 */
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { registry as nsRegistry, callbackFor } from "../src/nextsteps.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-bnav-"));
const auditFile = join(tmp, "audit.log");
configureAudit({ path: auditFile });
const NOW = Date.now();

interface Sent {
  conv: string;
  text: string;
  opts: Record<string, any>;
}

let caseN = 0;
function makeBot(nextSteps: boolean = true) {
  caseN++;
  const dir = join(tmp, `case${caseN}`);
  mkdirSync(dir, { recursive: true });
  const sent: Sent[] = [];
  const answers: Array<{ id: string; text?: string }> = [];
  let msgId = 1000;
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (conv: string, text: string) => { sent.push({ conv, text, opts: {} }); return ++msgId; },
    sendMessageId: async (conv: string, text: string, opts: Record<string, any> = {}) => { sent.push({ conv, text, opts }); return ++msgId; },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    editMessageReplyMarkup: async () => {},
    answerCallbackQuery: async (id: string, text?: string) => { answers.push({ id, text }); },
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
  const st = new StateManager(join(dir, "state.json"));
  const cfg: any = { stateFile: join(dir, "state.json"), maxSchedules: 5, busyMode: "ask", nextSteps, nextMinSecs: 0, maxWorkers: 5 };
  const bot = new Bot(tg, oc, st, cfg);
  // Neutralize the reply/typing/stream machinery so only the board logic runs.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  return { bot, sent, answers, st };
}

function setManager(st: StateManager, conv: string, sessionID = "ses_mgr"): void {
  st.set(conv, { manager: true, sessionID, createdBy: "u1" });
}
function setWorker(st: StateManager, conv: string, name: string, status: "running" | "waiting", introMessageId?: number): void {
  st.set(conv, { worker: { name, status, spawnedBy: "manager", createdAt: NOW, updatedAt: NOW, introMessageId } });
}
function auditLines(): Array<Record<string, any>> {
  try {
    return readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const shownBoard = () => auditLines().filter((l) => l.action === "nextstep_shown" && (l.meta || {}).rule === "board");
const rowsOf = (sent: Sent[]) => (sent.length ? sent[sent.length - 1].opts?.reply_markup?.inline_keyboard : undefined) as
  | Array<Array<{ text: string; switch_to_topic?: { message_id: number }; callback_data?: string }>>
  | undefined;

// ── Two anchored busy workers → two switch_to_topic rows (VN default) ────────
{
  const { bot, sent, st } = makeBot(true);
  setManager(st, "42");
  setWorker(st, "42:11", "w-a", "running", 101);
  setWorker(st, "42:12", "w-b", "waiting", 102);
  const shownBefore = shownBoard().length;
  await (bot as any).maybeOfferManagerBoard("42");

  check("two anchored workers → exactly one line sent", sent.length === 1, JSON.stringify(sent.map((s) => s.text)));
  const rows = rowsOf(sent);
  check("two rows, one per worker", Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
  const r0 = rows?.[0]?.[0];
  const r1 = rows?.[1]?.[0];
  check("row0 → switch_to_topic message_id 101", r0?.switch_to_topic?.message_id === 101 && r0?.callback_data === undefined, JSON.stringify(r0));
  check("row1 → switch_to_topic message_id 102", r1?.switch_to_topic?.message_id === 102 && r1?.callback_data === undefined, JSON.stringify(r1));
  check("vi label running: 📋 w-a · đang chạy", r0?.text === "📋 w-a · đang chạy", JSON.stringify(r0?.text));
  check("vi label waiting: 📋 w-b · chờ duyệt", r1?.text === "📋 w-b · chờ duyệt", JSON.stringify(r1?.text));
  check("vi header: ⚡ 2 worker đang chạy:", sent[0]?.text === "⚡ 2 worker đang chạy:", JSON.stringify(sent[0]?.text));
  check("nextstep_shown fired with workers:2", shownBoard().length === shownBefore + 1 && shownBoard()[shownBoard().length - 1]?.meta?.workers === 2, JSON.stringify(shownBoard().slice(-1)));
}

// ── Same two anchored workers, user language = en ────────────────────────────
{
  const { bot, sent, st } = makeBot(true);
  (bot as any).userPrefs.setLang("u1", "en");
  setManager(st, "42");
  setWorker(st, "42:11", "w-a", "running", 101);
  setWorker(st, "42:12", "w-b", "waiting", 102);
  await (bot as any).maybeOfferManagerBoard("42");
  const rows = rowsOf(sent);
  check("en label running: 📋 w-a · running", rows?.[0]?.[0]?.text === "📋 w-a · running", JSON.stringify(rows?.[0]?.[0]?.text));
  check("en label waiting: 📋 w-b · waiting", rows?.[1]?.[0]?.text === "📋 w-b · waiting", JSON.stringify(rows?.[1]?.[0]?.text));
  check("en header: ⚡ 2 worker(s) running:", sent[0]?.text === "⚡ 2 worker(s) running:", JSON.stringify(sent[0]?.text));
}

// ── One anchored + one unanchored → only the anchored button ─────────────────
{
  const { bot, sent, st } = makeBot(true);
  setManager(st, "42");
  setWorker(st, "42:11", "w-a", "running", 101);
  setWorker(st, "42:12", "w-b", "running", undefined); // unanchored → skipped
  await (bot as any).maybeOfferManagerBoard("42");
  const rows = rowsOf(sent);
  check("one line sent", sent.length === 1, JSON.stringify(sent.map((s) => s.text)));
  check("only the anchored worker's button (1 row)", Array.isArray(rows) && rows.length === 1, JSON.stringify(rows));
  check("the anchored button is present", rows?.[0]?.[0]?.switch_to_topic?.message_id === 101, JSON.stringify(rows));
  check("header counts anchored (⚡ 1 worker đang chạy:)", sent[0]?.text === "⚡ 1 worker đang chạy:", JSON.stringify(sent[0]?.text));
}

// ── All busy workers unanchored → nothing sent at all ────────────────────────
{
  const { bot, sent, st } = makeBot(true);
  setManager(st, "42");
  setWorker(st, "42:11", "w-a", "running", undefined);
  setWorker(st, "42:12", "w-b", "waiting", undefined);
  const shownBefore = shownBoard().length;
  await (bot as any).maybeOfferManagerBoard("42");
  check("all unanchored → nothing sent", sent.length === 0, JSON.stringify(sent));
  check("all unanchored → no nextstep_shown audit", shownBoard().length === shownBefore, String(shownBoard().length));
}

// ── Off-mode (nextSteps off) → byte-identical: nothing sent ──────────────────
{
  const { bot, sent, st } = makeBot(false);
  setManager(st, "42");
  setWorker(st, "42:11", "w-a", "running", 101);
  const shownBefore = shownBoard().length;
  await (bot as any).maybeOfferManagerBoard("42");
  check("off-mode → nothing sent", sent.length === 0, JSON.stringify(sent));
  check("off-mode → no nextstep_shown audit", shownBoard().length === shownBefore, String(shownBoard().length));
}

// ── An OLD pending "board" callback still routes to cmdBoard ─────────────────
{
  const { bot, answers, st } = makeBot(true);
  setManager(st, "42", "ses_old");
  const id = nsRegistry.set({ conv: "42", sessionID: "ses_old", rule: "board", now: NOW });
  let boardCalls = 0;
  (bot as any).orch.cmdBoard = async (_conv: string) => { boardCalls++; };
  await (bot as any).handleNextStepCallback({ id: "cb1", data: callbackFor(id, 0), from: { id: 7 } } as any, "42");
  check("old board tap → cmdBoard called once", boardCalls === 1, String(boardCalls));
  check("old board tap → callback answered", answers.some((a) => a.id === "cb1"), JSON.stringify(answers));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll board-nav checks passed.");
