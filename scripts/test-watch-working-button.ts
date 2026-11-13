/**
 * Unit tests for the "👁 Watch" button on the "⏳ Working…" line
 * (src/bot.ts: startWorking + handleCallback's ww: branch).
 *
 *   - (a) watchActive=true  → startWorking posts the Working line WITH a
 *     ww:go button (en + vi label), and the per-10s elapsed edit PRESERVES
 *     that same button.
 *   - (b) watchActive=false → startWorking posts the line with NO
 *     reply_markup (byte-identical off-mode: no keyboard at all).
 *   - (c) a ww:go tap with an active session calls startWatch for that conv.
 *   - (d) a ww:go tap with no session answers a "no session" note and does
 *     NOT call startWatch.
 *   - (e) a ww:go tap while watchActive=false answers an "inactive" note and
 *     does NOT call startWatch (the defensive gate, mirroring cmdWatch).
 *
 * Run:  npx tsx scripts/test-watch-working-button.ts
 */
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "ocbot-watch-btn-"));
let n = 0;
configureAudit({ path: join(tmpRoot, "audit.log") });

/** Drain pending microtasks (chained promises need a couple of ticks). */
const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

/**
 * A manager GROUP conversation: negative chat id, so isDmConv() is false and
 * startWorking actually runs (DMs show native typing and skip it).
 */
const GROUP = "-1004495820706";
const GROUP_CHAT_ID = -1004495820706;

/** The message a ww:go callback_query carries: it resolves to GROUP via convOf. */
const msg = (): any => ({ message_id: 1001, chat: { id: GROUP_CHAT_ID }, is_topic_message: false });

/** A Bot with the Working line + the ww: tap wired to mocks. */
function makeBot(opts: { watchActive: boolean }): {
  bot: Bot;
  sent: { conv: string; text: string; kb?: any }[];
  edits: { conv: string; msgId: number; text: string; kb?: any }[];
  answers: { id: string; text?: string }[];
  startWatchCalls: { conv: string; uid?: number }[];
  st: StateManager;
} {
  n++;
  configureAudit({ path: join(tmpRoot, `audit-${n}.log`) });

  const sent: { conv: string; text: string; kb?: any }[] = [];
  const edits: { conv: string; msgId: number; text: string; kb?: any }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const startWatchCalls: { conv: string; uid?: number }[] = [];

  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async () => {},
    sendHtml: async () => {},
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    // Records the reply_markup (the button) exactly as startWorking forwards it.
    editMessageText: async (conv: string, msgId: number, text: string, opts: any) => {
      edits.push({ conv, msgId, text, kb: opts?.reply_markup });
    },
    editMessageTextStrict: async () => true,
    stop: () => {},
    sendMessageId: async (conv: string, text: string, opts: any) => {
      sent.push({ conv, text, kb: opts?.reply_markup });
      return 1000 + sent.length;
    },
    answerCallbackQuery: async (id: string, text?: string) => { answers.push({ id, text }); },
  };

  const oc: any = {
    listMessages: async () => [],
    sessionState: async () => ({ busy: false }),
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
  };

  const st = new StateManager(join(tmpRoot, `state-${n}.json`));
  const cfg: any = {
    stateFile: join(tmpRoot, `state-${n}.json`),
    maxSchedules: 5,
    working: true, // the Working indicator is on, so startWorking runs
    watchActive: opts.watchActive,
    watch: true,
    stream: false,
    allowAny: true, // pass handleCallback's allow-list gate for the tap tests
    watchIntervalMs: 3000,
    watchMaxMin: 10,
  };
  const bot = new Bot(tg, oc, st, cfg);
  // Spy on startWatch so the tap tests can assert the button hands off to it
  // (and that the no-session / inactive paths do NOT call it).
  (bot as any).startWatch = async (conv: string, _state: any, uid?: number) => {
    startWatchCalls.push({ conv, uid });
  };
  return { bot, sent, edits, answers, startWatchCalls, st };
}

const wwBtn = { text: "👁 Watch", callback_data: "ww:go" };
const hasWwButton = (kb: any): boolean =>
  JSON.stringify(kb?.inline_keyboard?.[0]?.[0]) === JSON.stringify(wwBtn);

// ── (a) watchActive=true: the line carries a ww:go button, preserved on edit ─
{
  const realSetInterval = globalThis.setInterval;
  const m = makeBot({ watchActive: true });
  (m.bot as any).userPrefs.setLang(7, "en");
  const intervals: Array<() => void> = [];
  // Capture the 10s interval so we can fire it without waiting 10s in real time.
  globalThis.setInterval = ((cb: () => void, _ms: number) => { intervals.push(cb); return {} as any; }) as any;
  (m.bot as any).startWorking(GROUP, "en");
  await flush();
  check("a: Working line posted with a ww:go Watch button (en)",
    m.sent.length === 1 && m.sent[0].conv === GROUP && hasWwButton(m.sent[0].kb),
    JSON.stringify(m.sent[0]?.kb));
  check("a: base text is the en working indicator", m.sent[0]?.text === "⏳ Working…", m.sent[0]?.text);
  check("a: a 10s elapsed interval was armed", intervals.length === 1, `intervals=${intervals.length}`);
  intervals[0]?.(); // fire the 10s elapsed edit
  await flush();
  check("a: the 10s elapsed edit PRESERVES the ww:go button",
    m.edits.length === 1 && m.edits[0].conv === GROUP && hasWwButton(m.edits[0].kb),
    JSON.stringify(m.edits[0]?.kb));
  check("a: the 10s edit text shows elapsed seconds", /⏳ Working… · \d+s$/.test(m.edits[0]?.text ?? ""), m.edits[0]?.text);
  globalThis.setInterval = realSetInterval;

  // The button label is localized too (vi).
  const mv = makeBot({ watchActive: true });
  (mv.bot as any).userPrefs.setLang(7, "vi");
  const viIntervals: Array<() => void> = [];
  globalThis.setInterval = ((cb: () => void, _ms: number) => { viIntervals.push(cb); return {} as any; }) as any;
  (mv.bot as any).startWorking(GROUP, "vi");
  await flush();
  check("a: Working line carries the vi button label (👁 Theo dõi)",
    mv.sent.length === 1 && mv.sent[0].kb?.inline_keyboard?.[0]?.[0]?.text === "👁 Theo dõi"
      && mv.sent[0].kb?.inline_keyboard?.[0]?.[0]?.callback_data === "ww:go",
    JSON.stringify(mv.sent[0]?.kb));
  globalThis.setInterval = realSetInterval;
}

// ── (b) watchActive=false: byte-identical off-mode (no keyboard at all) ─────
{
  const m = makeBot({ watchActive: false });
  (m.bot as any).userPrefs.setLang(7, "en");
  (m.bot as any).startWorking(GROUP, "en");
  await flush();
  check("b: off-mode Working line has NO reply_markup (byte-identical)",
    m.sent.length === 1 && m.sent[0].kb === undefined,
    JSON.stringify(m.sent[0]?.kb));
  check("b: off-mode base text unchanged", m.sent[0]?.text === "⏳ Working…", m.sent[0]?.text);
}

// ── (c) ww:go tap with an active session → startWatch for that conv ─────────
{
  const m = makeBot({ watchActive: true });
  (m.bot as any).userPrefs.setLang(7, "en");
  m.st.set(GROUP, { sessionID: "ses_1" });
  await (m.bot as any).handleCallback({ id: "cb_c", data: "ww:go", from: { id: 7 }, message: msg() });
  await flush();
  check("c: ww:go tap (active session) calls startWatch for that conv",
    m.startWatchCalls.length === 1 && m.startWatchCalls[0].conv === GROUP && m.startWatchCalls[0].uid === 7,
    JSON.stringify(m.startWatchCalls));
  check("c: the tap is acknowledged with a plain answer (no error note)",
    m.answers.length === 1 && m.answers[0].id === "cb_c" && m.answers[0].text === undefined,
    JSON.stringify(m.answers));
}

// ── (d) ww:go tap with NO session → "no session" note, startWatch NOT called ─
{
  const m = makeBot({ watchActive: true });
  (m.bot as any).userPrefs.setLang(7, "en");
  // no sessionID for GROUP → st.peek(GROUP) is undefined
  await (m.bot as any).handleCallback({ id: "cb_d", data: "ww:go", from: { id: 7 }, message: msg() });
  await flush();
  check("d: ww:go tap with no session does NOT call startWatch",
    m.startWatchCalls.length === 0, JSON.stringify(m.startWatchCalls));
  check("d: ...and answers the short 'no session' note (en)",
    m.answers.length === 1 && m.answers[0].text === "No current session.", JSON.stringify(m.answers));
}

// ── (e) ww:go tap while watchActive=false → "inactive" note, startWatch NOT ─
{
  const m = makeBot({ watchActive: false });
  (m.bot as any).userPrefs.setLang(7, "en");
  m.st.set(GROUP, { sessionID: "ses_1" });
  await (m.bot as any).handleCallback({ id: "cb_e", data: "ww:go", from: { id: 7 }, message: msg() });
  await flush();
  check("e: ww:go tap while watchActive=false does NOT call startWatch",
    m.startWatchCalls.length === 0, JSON.stringify(m.startWatchCalls));
  check("e: ...and answers the 'watch is inactive' note (en)",
    m.answers.length === 1 && m.answers[0].text === "👁 Watch is inactive.", JSON.stringify(m.answers));
}

// ── dispatch sanity: "ww:go" is not swallowed by the "w:" watch-card branch ─
{
  // A real watch-card callback still routes to the w: branch, not ww:.
  const m = makeBot({ watchActive: true });
  (m.bot as any).userPrefs.setLang(7, "en");
  // A w: tap with an unknown id answers "Expired." (the w: branch), proving
  // the ww: branch is distinct and the w: branch is untouched.
  await (m.bot as any).handleCallback({ id: "cb_w", data: "w:nope:c", from: { id: 7 }, message: msg() });
  await flush();
  check("dispatch: a w: tap still answers 'Expired' (ww: does not shadow it)",
    m.answers.length === 1 && /expired|Hết hiệu lực/i.test(m.answers[0].text ?? ""), JSON.stringify(m.answers));
}

console.log(failures === 0 ? "\nAll watch-working-button tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
