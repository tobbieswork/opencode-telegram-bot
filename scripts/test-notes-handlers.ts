/**
 * Unit tests: the notes / busy-queue / continue callback glue in
 * src/commands/notes.ts (docs/sdd/split-bot-ts.md, T3).
 *
 * The three handlers talk to the bot only through the narrow BotCtx
 * interface, so they are driven here with a hand-built fake — no Bot
 * construction, no Telegram, no OpenCode server:
 *
 *   - handleBusyCallback   (q:add: / q:steer: busy-reply buttons)
 *   - handleContinueCallback (cont: "chạy tiếp" button)
 *   - prepareNotesTurn      (note stage transitions at turn start)
 *
 * The pure helpers (notes.ts / busy.ts / continue.ts) are covered by
 * test-notes, test-notes-callback, test-busy, test-continue; this file
 * covers the handler glue that used to be live-only.
 *
 * Run:  npx tsx scripts/test-notes-handlers.ts
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusyNoteStore, noteEntryText } from "../src/notes.js";
import { QueueStore } from "../src/queue.js";
import { configureAudit } from "../src/audit.js";
import { CONTINUE_PROMPT } from "../src/continue.js";
import { NOTES_KEY } from "../src/shared.js";
import type { BotCtx } from "../src/commands/ctx.js";
import {
  handleBusyCallback,
  handleContinueCallback,
  prepareNotesTurn,
} from "../src/commands/notes.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const CONV = "123";

interface Call {
  name: string;
  args: unknown[];
}

interface Fake {
  ctx: BotCtx;
  state: Map<string, Record<string, unknown>>;
  calls: Call[];
  busyNotes: BusyNoteStore;
  queue: QueueStore;
  inflight: Map<string, AbortController>;
  runPromptTaskCalls: Array<[string, string, string, AbortController]>;
  typingCount: () => number;
  /** Make a fake oc method throw (by name: prompt / setInstruction / removeInstruction). */
  failOc(method: string): void;
  auditLines: () => Array<Record<string, unknown>>;
}

function makeFake(): Fake {
  const base = mkdtempSync(join(tmpdir(), "tg-notes-handlers-"));
  const auditPath = join(base, "audit.jsonl");
  configureAudit({ path: auditPath });
  const calls: Call[] = [];
  const state = new Map<string, Record<string, unknown>>();
  const busyNotes = new BusyNoteStore();
  const queue = new QueueStore();
  const inflight = new Map<string, AbortController>();
  const runPromptTaskCalls: Array<[string, string, string, AbortController]> = [];
  let typing = 0;
  const ocFailures = new Set<string>();

  const ctx = {
    tg: {
      answerCallbackQuery: async (_id: string, alert?: string) => {
        calls.push({ name: "answer", args: [alert] });
      },
      editMessageText: async (conv: string, msgId: number, text: string) => {
        calls.push({ name: "edit", args: [conv, msgId, text] });
      },
      editMessageReplyMarkup: async (conv: string, msgId: number) => {
        calls.push({ name: "editMarkup", args: [conv, msgId] });
      },
    },
    oc: {
      prompt: async (sid: string, text: string, opts: unknown) => {
        calls.push({ name: "prompt", args: [sid, text, opts] });
        if (ocFailures.has("prompt")) throw new Error("boom");
      },
      setInstruction: async (sid: string, key: string, text: string) => {
        calls.push({ name: "setInstruction", args: [sid, key, text] });
        if (ocFailures.has("setInstruction")) throw new Error("boom");
      },
      removeInstruction: async (sid: string, key: string) => {
        calls.push({ name: "removeInstruction", args: [sid, key] });
        if (ocFailures.has("removeInstruction")) throw new Error("boom");
      },
    },
    st: {
      get: (conv: string) => state.get(conv) ?? {},
      peek: (conv: string) => state.get(conv),
      set: (conv: string, patch: Record<string, unknown>) => {
        state.set(conv, { ...state.get(conv), ...patch });
      },
    },
    orch: {},
    userPrefs: { getLang: (_userId: string) => "vi" as const },
    permissionPrompts: new Map<string, unknown>(),
    startPromptReminder: () => {},
    cancelReminder: () => {},
    findPromptConv: () => undefined,
    editCardInPlace: async () => 0,
    busyNotes,
    queue,
    inflight,
    startTyping: () => {
      typing++;
    },
    runPromptTask: async (conv: string, sid: string, text: string, ac: AbortController) => {
      runPromptTaskCalls.push([conv, sid, text, ac]);
    },
  } as unknown as BotCtx;

  return {
    ctx,
    state,
    calls,
    busyNotes,
    queue,
    inflight,
    runPromptTaskCalls,
    typingCount: () => typing,
    failOc: (method: string) => ocFailures.add(method),
    auditLines: () => {
      if (!existsSync(auditPath)) return [];
      return readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

function cb(data: string): { id: string; from: { id: number }; data: string } {
  return { id: "cb-1", from: { id: 42 }, data };
}

const answered = (f: Fake, alert: string | undefined) =>
  f.calls.some((c) => c.name === "answer" && c.args[0] === alert);
const edited = (f: Fake, conv: string, msgId: number, text: string) =>
  f.calls.some((c) => c.name === "edit" && c.args[0] === conv && c.args[1] === msgId && c.args[2] === text);

// ── handleBusyCallback ────────────────────────────────────────────────────────

async function testBusyMalformed(): Promise<void> {
  const f = makeFake();
  await handleBusyCallback(f.ctx, cb("q:add:xyz"), CONV);
  check("busy malformed: answers silently", f.calls.length === 1 && f.calls[0].name === "answer" && f.calls[0].args[0] === undefined);
  check("busy malformed: nothing else happens", f.queue.size(CONV) === 0 && !f.calls.some((c) => c.name === "edit"));
}

async function testBusyNotFound(): Promise<void> {
  const f = makeFake();
  await handleBusyCallback(f.ctx, cb("q:add:999"), CONV);
  check("busy not-found: alert", answered(f, "Không tìm thấy nội dung tin nhắn đó."));
  check("busy not-found: no edit, no queue", !f.calls.some((c) => c.name === "edit") && f.queue.size(CONV) === 0);
}

async function testBusyAdd(): Promise<void> {
  const f = makeFake();
  f.busyNotes.push(CONV, 900, "hello note");
  await handleBusyCallback(f.ctx, cb("q:add:900"), CONV, 55);
  const item = f.queue.list(CONV)[0];
  check("busy add: queued with sender id", f.queue.size(CONV) === 1 && item?.text === "hello note" && item?.senderId === "42");
  check("busy add: note consumed", f.busyNotes.take(CONV, 900) === null);
  check("busy add: answer", answered(f, "✅ Đã thêm vào hàng chờ (vị trí #1)."));
  check("busy add: settle edit", edited(f, CONV, 55, "✅ Đã thêm vào hàng chờ (vị trí #1). Sẽ chạy sau khi tin hiện tại xong."));
  const add = f.auditLines().find((e) => e.action === "queue_add");
  check("busy add: audited", !!add && (add.meta as Record<string, unknown>)?.queuedCount === 1 && (add.meta as Record<string, unknown>)?.messageId === 900);
  check("busy add: no steer audit", !f.auditLines().some((e) => e.action === "queue_steer"));
}

async function testBusyAddFull(): Promise<void> {
  const f = makeFake();
  f.busyNotes.push(CONV, 901, "late note");
  for (let i = 1; i <= 3; i++) f.queue.push(CONV, { text: `q${i}`, senderId: "1" });
  await handleBusyCallback(f.ctx, cb("q:add:901"), CONV, 56);
  check("busy add full: answer", answered(f, "Hàng chờ đầy (3 tin)."));
  check("busy add full: settle edit", edited(f, CONV, 56, "⚠️ Hàng chờ đầy (3 tin) — bấm note để giữ."));
  check("busy add full: queue unchanged", f.queue.size(CONV) === 3);
}

async function testBusySteerOk(): Promise<void> {
  const f = makeFake();
  f.busyNotes.push(CONV, 902, "steer me");
  f.state.set(CONV, { sessionID: "sid-1" });
  await handleBusyCallback(f.ctx, cb("q:steer:902"), CONV, 57);
  const p = f.calls.find((c) => c.name === "prompt");
  check("busy steer: oc.prompt(sid, text, {delivery:'steer'})", !!p && p.args[0] === "sid-1" && p.args[1] === "steer me" && (p.args[2] as { delivery?: string })?.delivery === "steer");
  check("busy steer: answer", answered(f, "🔀 Đang định tuyến — áp dụng tại điểm an toàn tiếp theo."));
  check("busy steer: settle edit", edited(f, CONV, 57, "🔀 Đang định tuyến — áp dụng tại điểm an toàn tiếp theo."));
  check("busy steer: queue untouched", f.queue.size(CONV) === 0);
  const steer = f.auditLines().find((e) => e.action === "queue_steer");
  check("busy steer: audited ok", !!steer && (steer.meta as Record<string, unknown>)?.ok === true && (steer.meta as Record<string, unknown>)?.degraded === false);
}

async function testBusySteerFallbackPromptFail(): Promise<void> {
  const f = makeFake();
  f.busyNotes.push(CONV, 903, "steer me 2");
  f.state.set(CONV, { sessionID: "sid-1" });
  f.failOc("prompt");
  await handleBusyCallback(f.ctx, cb("q:steer:903"), CONV, 58);
  const item = f.queue.list(CONV)[0];
  check("busy steer fail: fell back to queue", f.queue.size(CONV) === 1 && item?.text === "steer me 2");
  check("busy steer fail: answer", answered(f, "Không steer được — đã cho vào hàng chờ (vị trí #1)."));
  check("busy steer fail: settle edit", edited(f, CONV, 58, "Không steer được — đã cho vào hàng chờ (vị trí #1)."));
  const steer = f.auditLines().find((e) => e.action === "queue_steer");
  const m = steer?.meta as Record<string, unknown>;
  check("busy steer fail: audited degraded", !!steer && m?.ok === false && m?.degraded === true && m?.reason === "boom");
  const add = f.auditLines().find((e) => e.action === "queue_add");
  check("busy steer fail: fallback add audited", (add?.meta as Record<string, unknown>)?.via === "steer_fallback");
}

async function testBusySteerNoSession(): Promise<void> {
  const f = makeFake();
  f.busyNotes.push(CONV, 904, "steer me 3");
  // no state entry for the conv → st.peek returns undefined
  await handleBusyCallback(f.ctx, cb("q:steer:904"), CONV, 59);
  check("busy steer no-session: queue fallback", f.queue.size(CONV) === 1);
  check("busy steer no-session: no prompt call", !f.calls.some((c) => c.name === "prompt"));
  const steer = f.auditLines().find((e) => e.action === "queue_steer");
  check("busy steer no-session: audited reason", (steer?.meta as Record<string, unknown>)?.reason === "no active session");
}

// ── handleContinueCallback ───────────────────────────────────────────────────

async function testContinueHappy(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { sessionID: "sid-7" });
  await handleContinueCallback(f.ctx, cb("cont:sid-7"), CONV, 77);
  check("continue: one-shot keyboard dropped", f.calls.some((c) => c.name === "editMarkup" && c.args[0] === CONV && c.args[1] === 77));
  check("continue: answered", answered(f, "⏯ Đang chạy tiếp…"));
  check("continue: typing started", f.typingCount() === 1);
  const r = f.runPromptTaskCalls[0];
  check(
    "continue: runPromptTask(conv, sid, CONTINUE_PROMPT, ac)",
    !!r && r[0] === CONV && r[1] === "sid-7" && r[2] === CONTINUE_PROMPT && r[3] === f.inflight.get(CONV),
  );
}

async function testContinueStale(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { sessionID: "sid-A" });
  await handleContinueCallback(f.ctx, cb("cont:sid-B"), CONV, 78);
  check("continue stale: rejected", answered(f, "Nút này không còn áp dụng cho phiên hiện tại."));
  check("continue stale: no run", f.runPromptTaskCalls.length === 0 && !f.inflight.has(CONV) && f.typingCount() === 0);
}

async function testContinueMalformed(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { sessionID: "sid-7" });
  await handleContinueCallback(f.ctx, cb("cont:"), CONV, 79);
  check("continue malformed: rejected", answered(f, "Nút này không còn áp dụng cho phiên hiện tại."));
  check("continue malformed: no run", f.runPromptTaskCalls.length === 0);
}

async function testContinueInflight(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { sessionID: "sid-7" });
  f.inflight.set(CONV, new AbortController());
  await handleContinueCallback(f.ctx, cb("cont:sid-7"), CONV, 80);
  check("continue inflight: busy answer", answered(f, "Đang chạy task — hẵng thử lại sau."));
  check("continue inflight: no run", f.runPromptTaskCalls.length === 0 && f.typingCount() === 0);
  check("continue inflight: one-shot still dropped", f.calls.some((c) => c.name === "editMarkup" && c.args[1] === 80));
}

// ── prepareNotesTurn ─────────────────────────────────────────────────────────

async function testPrepPending(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { notes: "- 14:00: do the thing", notesStage: "pending" });
  await prepareNotesTurn(f.ctx, CONV, "sid-9");
  const s = f.calls.find((c) => c.name === "setInstruction");
  check("prep pending: instruction put", !!s && s.args[0] === "sid-9" && s.args[1] === NOTES_KEY && s.args[2] === noteEntryText("- 14:00: do the thing", "vi"));
  check("prep pending: stage → shown", (f.state.get(CONV) as Record<string, unknown>)?.notesStage === "shown");
  check("prep pending: no remove", !f.calls.some((c) => c.name === "removeInstruction"));
}

async function testPrepShown(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { notes: "line", notesStage: "shown" });
  await prepareNotesTurn(f.ctx, CONV, "sid-9");
  check("prep shown: instruction removed", f.calls.some((c) => c.name === "removeInstruction" && c.args[0] === "sid-9" && c.args[1] === NOTES_KEY));
  const st = f.state.get(CONV) as Record<string, unknown>;
  check("prep shown: notes cleared", st?.notes === undefined && st?.notesStage === undefined);
  check("prep shown: no put", !f.calls.some((c) => c.name === "setInstruction"));
}

async function testPrepNone(): Promise<void> {
  const f = makeFake();
  await prepareNotesTurn(f.ctx, CONV, "sid-9");
  check("prep none: no oc calls", !f.calls.some((c) => c.name === "setInstruction" || c.name === "removeInstruction"));
}

async function testPrepNeverThrows(): Promise<void> {
  const f = makeFake();
  f.state.set(CONV, { notes: "x", notesStage: "pending" });
  f.failOc("setInstruction");
  let threw = false;
  try {
    await prepareNotesTurn(f.ctx, CONV, "sid-9");
  } catch {
    threw = true;
  }
  check("prep: never throws", !threw);
}

async function main(): Promise<void> {
  await testBusyMalformed();
  await testBusyNotFound();
  await testBusyAdd();
  await testBusyAddFull();
  await testBusySteerOk();
  await testBusySteerFallbackPromptFail();
  await testBusySteerNoSession();
  await testContinueHappy();
  await testContinueStale();
  await testContinueMalformed();
  await testContinueInflight();
  await testPrepPending();
  await testPrepShown();
  await testPrepNone();
  await testPrepNeverThrows();
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll notes-handler checks passed.");
}

void main();
