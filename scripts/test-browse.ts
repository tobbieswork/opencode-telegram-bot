/**
 * Unit test: the folder browser feature module (src/commands/browse.ts,
 * moved out of bot.ts — docs/sdd/split-bot-ts.md T5).
 *
 * Covers /dir, /browse (open, root clamp, not-a-directory, no roots) and
 * the bs: callback menu (nav / up / pg / hid / open / list / setdir /
 * setsess / close / noop + the closed-browser hint), driven through a real
 * `Bot` with fake `tg`/`oc` over a REAL temp directory tree — same harness
 * as test-model.ts. The path-jail helpers (listDirs / isUnderRoot) are
 * covered separately in test-fsbrowser.ts.
 *
 * Run:  npx tsx scripts/test-browse.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { cmdDir, cmdBrowse, renderBrowse, handleBrowseCallback } from "../src/commands/browse.js";

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

/** Real tree: root/{alpha/beta, gamma, pagedir/p01..p14, .hidden} + a file. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "tg-browse-"));
  const root = join(base, "root");
  mkdirSync(join(root, "alpha", "beta"), { recursive: true });
  mkdirSync(join(root, "gamma"));
  mkdirSync(join(root, ".hidden"));
  const paged = join(root, "pagedir");
  for (let i = 1; i <= 14; i++) mkdirSync(join(paged, `p${String(i).padStart(2, "0")}`), { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
  return { base, root };
}

function makeBot(root: string, roots: string[] = [root]) {
  const base = mkdtempSync(join(tmpdir(), "tg-browse-"));
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
    setModel: [] as { sid: string; model: any }[],
    setAgent: [] as { sid: string; agent: string }[],
  };
  let n = 0;
  const oc: any = {
    interrupt: async () => {},
    getSession: async () => null,
    createSession: async (dir: string) => {
      calls.create.push(dir);
      return `ses_new_${++n}`;
    },
    setModel: async (sid: string, model: any) => {
      calls.setModel.push({ sid, model });
    },
    setAgent: async (sid: string, agent: string) => {
      calls.setAgent.push({ sid, agent });
    },
  };
  const cfg: any = {
    stateFile: join(base, "state.json"),
    maxSchedules: 5,
    replyMaxLen: 4000,
    opencodeDirectory: root,
    browseRoots: roots,
  };
  const bot = new Bot(tg, oc, st, cfg);
  return { bot, st, rec, calls, cfg };
}

const CONV = "42";
const CB = (data: string, id = "cb1"): any => ({ id, data, from: { id: 42 } });
/** The keyboard of the most recent sent/edited browser message, as JSON. */
function lastKb(rec: Rec): string {
  const last = [...rec.sent, ...rec.edits].pop() as { kb?: unknown } | undefined;
  return JSON.stringify(last?.kb);
}

async function main(): Promise<void> {
  // ── /dir ─────────────────────────────────────────────────────────────────
  {
    const { base, root } = makeTree();
    const { bot, st, rec } = makeBot(root);
    await cmdDir(bot, CONV, "", st.get(CONV));
    check("cmdDir (no arg): shows the cfg directory", rec.sent[0]?.text === `📁 Current directory:\n<code>${root}</code>`, rec.sent[0]?.text);

    await cmdDir(bot, CONV, "alpha", st.get(CONV));
    check("cmdDir (relative): resolved against the cfg dir + persisted", st.get(CONV).directory === join(root, "alpha") && rec.sent[1]?.text.includes("Directory set to"), JSON.stringify({ dir: st.get(CONV).directory, t: rec.sent[1]?.text }));

    await cmdDir(bot, CONV, join(base, "nope"), st.get(CONV));
    check("cmdDir (missing): error, state unchanged", rec.sent[2]?.text?.startsWith("❌ No such directory") && st.get(CONV).directory === join(root, "alpha"), rec.sent[2]?.text);
  }

  // ── /browse guards ───────────────────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec, calls } = makeBot(root, []);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    check("cmdBrowse (no roots): friendly error, no browser", rec.sent.length === 1 && rec.sent[0].kb === undefined && !(bot as any).browsers.has(CONV), rec.sent[0]?.text);
    void calls;
  }
  {
    const { base, root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "file.txt", (bot as any).st.get(CONV));
    check("cmdBrowse (a file): not-a-directory error, no browser", rec.sent[0]?.text?.startsWith("❌ Không phải thư mục") && !(bot as any).browsers.has(CONV), rec.sent[0]?.text);

    await cmdBrowse(bot, CONV, "../../outside", (bot as any).st.get(CONV));
    const b = (bot as any).browsers.get(CONV);
    check("cmdBrowse (outside roots): clamped to a root with a note", b?.path === root && b?.note !== undefined && b?.note.includes("⚠️"), JSON.stringify({ path: b?.path, note: b?.note }));
    check("cmdBrowse (outside roots): card lists the root", lastKb(rec).includes("bs:nav:0"), lastKb(rec).slice(0, 200));
    (bot as any).browsers.delete(CONV);

    await cmdBrowse(bot, CONV, join(root, "ghost"), (bot as any).st.get(CONV));
    check("cmdBrowse (missing): not-a-directory error, no browser", rec.sent[2]?.text?.startsWith("❌ Không phải thư mục") && !(bot as any).browsers.has(CONV), rec.sent[2]?.text);
  }

  // ── open the browser at the root ─────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    const b = (bot as any).browsers.get(CONV);
    const kb = lastKb(rec);
    check("cmdBrowse: browser state opened at the root", b?.path === root && b?.view === "list" && b?.page === 0, JSON.stringify({ path: b?.path, view: b?.view }));
    check("cmdBrowse: lists dirs only (file skipped, hidden hidden)", kb.includes("alpha") && kb.includes("gamma") && kb.includes("pagedir") && !kb.includes(".hidden") && !kb.includes("file.txt"), kb);
    check("cmdBrowse: at a root there is no Up button", !kb.includes("bs:up"), kb.slice(0, 200));
    check("cmdBrowse: show-hidden + open-here + close buttons", kb.includes("bs:hid") && kb.includes("bs:open") && kb.includes("bs:close"), kb.slice(0, 200));
    check("cmdBrowse: single page → no pager row", !kb.includes("bs:pg:"), kb.slice(0, 200));
    check("cmdBrowse: footer counts subdirectories", rec.sent[0].text.includes("3 thư mục con") || rec.sent[0].text.includes("3 subdirectories"), rec.sent[0].text);
  }

  // ── bs:nav into a dir, then bs:up back ───────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    const id = 1; // the browser message id (fake tg returns rec.sent.length)

    // items are sorted: alpha, gamma, pagedir → alpha is index 0
    await handleBrowseCallback(bot, CB("bs:nav:0"), CONV, id);
    const b = (bot as any).browsers.get(CONV);
    check("bs:nav: entered the tapped directory", b?.path === join(root, "alpha") && b?.page === 0, b?.path);
    check("bs:nav: re-rendered in place", rec.edits.length === 1 && rec.edits[0].msgId === id && lastKb(rec).includes("beta"), JSON.stringify({ edits: rec.edits.length, kb: lastKb(rec).slice(0, 200) }));
    check("bs:nav: Up button appears below a root", lastKb(rec).includes("bs:up"), lastKb(rec).slice(0, 200));

    await handleBrowseCallback(bot, CB("bs:up"), CONV, id);
    check("bs:up: back to the root", (bot as any).browsers.get(CONV)?.path === root, (bot as any).browsers.get(CONV)?.path);
    await handleBrowseCallback(bot, CB("bs:up"), CONV, id);
    check("bs:up at a root: stays (no parent within roots)", (bot as any).browsers.get(CONV)?.path === root, (bot as any).browsers.get(CONV)?.path);

    await handleBrowseCallback(bot, CB("bs:nav:99"), CONV, id);
    check("bs:nav (stale index): error toast, no edit", rec.answers.some((a) => (a.text ?? "").startsWith("⚠️")) && rec.edits.length === 3, JSON.stringify({ answers: rec.answers.map((a) => a.text), edits: rec.edits.length }));
  }

  // ── bs:hid toggles hidden dirs ───────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    check("hid: hidden dir absent by default", !lastKb(rec).includes(".hidden"), lastKb(rec).slice(0, 200));
    await handleBrowseCallback(bot, CB("bs:hid"), CONV, 1);
    const b = (bot as any).browsers.get(CONV);
    check("bs:hid: shows hidden dirs + resets the page", b?.showHidden === true && b?.page === 0 && lastKb(rec).includes(".hidden"), JSON.stringify({ hidden: b?.showHidden, kb: lastKb(rec).slice(0, 200) }));
    await handleBrowseCallback(bot, CB("bs:hid"), CONV, 1);
    check("bs:hid: toggles back", (bot as any).browsers.get(CONV)?.showHidden === false && !lastKb(rec).includes(".hidden"), lastKb(rec).slice(0, 200));
  }

  // ── bs:open → choose view → bs:setdir ────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, st, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, join(root, "gamma"), (bot as any).st.get(CONV));
    const id = 1;
    await handleBrowseCallback(bot, CB("bs:open"), CONV, id);
    let b = (bot as any).browsers.get(CONV);
    let kb = lastKb(rec);
    check("bs:open: choose view with setdir/setsess/back/close", b?.view === "choose" && kb.includes("bs:setdir") && kb.includes("bs:setsess") && kb.includes("bs:list") && kb.includes("bs:close"), kb);

    await handleBrowseCallback(bot, CB("bs:setdir"), CONV, id);
    b = (bot as any).browsers.get(CONV);
    kb = lastKb(rec);
    check("bs:setdir: chat directory persisted + done view", st.get(CONV).directory === join(root, "gamma") && b?.view === "done" && b?.opened === false && b?.result?.includes(join(root, "gamma")), JSON.stringify({ dir: st.get(CONV).directory, view: b?.view }));
    check("bs:setdir (not opened): offers to open a session here", kb.includes("bs:setsess"), kb);

    await handleBrowseCallback(bot, CB("bs:list"), CONV, id);
    check("bs:list: back to the list view", (bot as any).browsers.get(CONV)?.view === "list", (bot as any).browsers.get(CONV)?.view);
  }

  // ── bs:setsess — stop, create, apply model/agent, persist ────────────────
  {
    const { root } = makeTree();
    const { bot, st, rec, calls } = makeBot(root);
    st.set(CONV, { sessionID: "ses_old", agent: "build" });
    const ac = new AbortController();
    (bot as any).inflight.set(CONV, ac);
    await cmdBrowse(bot, CONV, join(root, "alpha"), (bot as any).st.get(CONV));
    const id = 1;
    await handleBrowseCallback(bot, CB("bs:setsess"), CONV, id);
    const b = (bot as any).browsers.get(CONV);
    check("bs:setsess: running turn stopped", ac.signal.aborted === true, String(ac.signal.aborted));
    check("bs:setsess: session created IN the browsed dir", calls.create.length === 1 && calls.create[0] === join(root, "alpha"), JSON.stringify(calls.create));
    check("bs:setsess: chat state → new session + directory", st.get(CONV).sessionID === "ses_new_1" && st.get(CONV).directory === join(root, "alpha"), JSON.stringify(st.get(CONV)));
    check("bs:setsess: agent re-applied to the fresh session", calls.setAgent.length === 1 && calls.setAgent[0].sid === "ses_new_1" && calls.setAgent[0].agent === "build", JSON.stringify(calls.setAgent));
    check("bs:setsess: done view, already opened", b?.view === "done" && b?.opened === true && b?.result?.includes("ses_new_1"), JSON.stringify({ view: b?.view, opened: b?.opened }));
    check("bs:setsess (opened): no repeat setsess button", !lastKb(rec).includes("bs:setsess"), lastKb(rec));
  }

  // ── bs:close ─────────────────────────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    await handleBrowseCallback(bot, CB("bs:close"), CONV, 1);
    check("bs:close: browser dropped + card deleted", !(bot as any).browsers.has(CONV) && rec.deleted.includes(1), JSON.stringify({ has: (bot as any).browsers.has(CONV), deleted: rec.deleted }));
  }

  // ── bs:* with no open browser ────────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await handleBrowseCallback(bot, CB("bs:nav:0"), CONV, 99);
    check("bs:* (closed): friendly hint, no crash", rec.answers.length === 1 && (rec.answers[0].text ?? "").includes("browse") && rec.edits.length === 0, JSON.stringify(rec.answers));
  }

  // ── bs:noop + pagination ─────────────────────────────────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, join(root, "pagedir"), (bot as any).st.get(CONV));
    const id = 1;
    let b = (bot as any).browsers.get(CONV);
    check("pagedir: 14 entries → 2 pages + pager row", b?.items.length === 14 && lastKb(rec).includes("bs:pg:1") && lastKb(rec).includes("1/2"), JSON.stringify({ items: b?.items.length, kb: lastKb(rec).slice(0, 240) }));

    await handleBrowseCallback(bot, CB("bs:pg:1"), CONV, id);
    b = (bot as any).browsers.get(CONV);
    check("bs:pg:1: shows the second page (last two entries)", b?.page === 1 && lastKb(rec).includes("p13") && lastKb(rec).includes("p14") && !lastKb(rec).includes("p01"), JSON.stringify({ page: b?.page, kb: lastKb(rec).slice(0, 240) }));

    await handleBrowseCallback(bot, CB("bs:pg:-1"), CONV, id);
    check("bs:pg (underflow): clamped to page 0", (bot as any).browsers.get(CONV)?.page === 0, String((bot as any).browsers.get(CONV)?.page));

    await handleBrowseCallback(bot, CB("bs:noop"), CONV, id);
    check("bs:noop: re-renders without changing state", (bot as any).browsers.get(CONV)?.page === 0 && rec.edits.length >= 3, `edits=${rec.edits.length}`);
  }

  // ── renderBrowse (pure-ish renderer over live state) ─────────────────────
  {
    const { root } = makeTree();
    const { bot, rec } = makeBot(root);
    await cmdBrowse(bot, CONV, "", (bot as any).st.get(CONV));
    const b = (bot as any).browsers.get(CONV);
    b.note = "⚠️ clamped";
    const v = renderBrowse(bot, b);
    check("renderBrowse: note is shown above the listing", v.text.includes("⚠️ clamped"), v.text);
    void rec;
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll browse checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
