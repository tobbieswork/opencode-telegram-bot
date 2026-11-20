/**
 * Focused harness for W3 (docs/sdd/background-workers.md): worker-system
 * integration of a background (topic-less) worker.
 *
 *  I8 (list)   — list_workers appends a `· bg` marker for background workers;
 *                live workers are listed unchanged.
 *  I8 (board)  — maybeOfferManagerBoard never offers a topic-jump row for a
 *                background worker (B3.3); when the only busy worker is a bg
 *                one, nothing is sent at all.
 *  I9 (B3.1)   — a bg worker is in workersOf(chat) and counts toward the
 *                per-chat busy capacity (assertCapacity).
 *  I9 (B3.2)   — a bg writer in a shared repo claims (and is counted for) the
 *                main checkout, so a second writer of the same repo is
 *                diverted to its own worktree — in both directions.
 *  I9 (B3.5)   — healWorkers settles a stuck bg worker whose session is idle,
 *                relaying its done card to the MAIN chat (not to the bg conv);
 *                a bg worker whose session is still busy is left alone.
 *
 * Live path untouched: a live worker is listed without the marker and keeps
 * its jump row and capacity/worktree semantics.
 *
 * Run:  npx tsx scripts/test-bg-integration.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../src/state.js";
import { Orchestrator, type Host } from "../src/orchestrator.js";
import { BusyNoteStore } from "../src/notes.js";
import { QueueStore } from "../src/queue.js";
import { Bot } from "../src/bot.js";
import { configureAudit } from "../src/audit.js";
import type { Config } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
async function throws(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-bgint-"));
const auditFile = join(tmp, "audit.log");
configureAudit({ path: auditFile });
const NOW = Date.now();

function makeRepo(dir: string): void {
  mkdirSync(join(dir, "pkg"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "pkg", "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "init");
}

interface H {
  orch: Orchestrator;
  st: StateManager;
  root: string;
  repo: string;
  sent: { conv: string; text: string }[];
  sentIds: { conv: string; text: string; kb?: any }[];
  topicCreations: () => number;
  latest: (v: { text: string; time: number } | undefined) => void;
  setState: (fn: (sid: string) => { busy: boolean; outcome?: string }) => void;
  clearReportTimers: () => void;
}

function makeHarness(file: string, opts: { worktreeMode: "auto" | "always"; withRepo: boolean; maxWorkers?: number }): H {
  const base = join(tmp, file);
  const root = join(base, "work");
  mkdirSync(join(root, "proj"), { recursive: true });
  const repo = join(base, "repo");
  if (opts.withRepo) makeRepo(repo);
  const sent: { conv: string; text: string }[] = [];
  const sentIds: { conv: string; text: string; kb?: any }[] = [];
  const prompts: { sid: string; text: string }[] = [];
  let topicCreations = 0;
  let sessions = 0;
  let latestReply: { text: string; time: number } | undefined;
  let stateFn: (sid: string) => { busy: boolean; outcome?: string } = () => ({ busy: true });
  const tg: any = {
    botUsername: async () => "mock_bot",
    createForumTopic: async () => (topicCreations++, 100 + topicCreations),
    editForumTopic: async () => {},
    closeForumTopic: async () => {},
    openForumTopic: async () => {},
    deleteForumTopic: async () => {},
    deleteMessage: async () => {},
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
    sendMessageId: async (conv: string, text: string, opts?: any) => (sentIds.push({ conv, text, kb: opts?.reply_markup }), 9000),
  };
  const oc: any = {
    createSession: async () => `ses_${++sessions}`,
    setInstruction: async () => {},
    removeInstruction: async () => {},
    prompt: async (sid: string, text: string) => (prompts.push({ sid, text }), "msg_x"),
    interrupt: async () => {},
    removeSession: async () => {},
    latestReply: async () => latestReply,
    sessionState: async (sid: string) => stateFn(sid),
  };
  const cfg = {
    opencodeDirectory: root,
    browseRoots: opts.withRepo ? [root, repo] : [root],
    managerDir: join(base, "mgr"),
    maxWorkers: opts.maxWorkers ?? 4,
    worktreeMode: opts.worktreeMode,
    bridgePort: 0,
    autoClose: true,
  } as unknown as Config;
  const st = new StateManager(join(base, "state.json"));
  const host: Host = {
    tg,
    oc,
    st,
    cfg,
    busyNotes: new BusyNoteStore(),
    queue: new QueueStore(),
    sendHtml: async (conv, html) => (sent.push({ conv, text: html }), undefined),
    applyModelAndVariant: async () => {},
    startTyping: () => {},
    startWorking: () => {},
    stopWorking: () => {},
    noteNextStepMessage: () => {},
  };
  const orch = new Orchestrator(host);
  return {
    orch,
    st,
    root,
    repo,
    sent,
    sentIds,
    topicCreations: () => topicCreations,
    latest: (v) => (latestReply = v),
    setState: (fn) => (stateFn = fn),
    clearReportTimers: () => {
      for (const t of (orch as any).reportTimers.values()) clearTimeout(t);
      (orch as any).reportTimers.clear();
    },
  };
}

const spec = (name: string, directory: string, extra: object = {}) =>
  ({ name, directory, spawnedBy: "user", writes: true, ...extra } as any);

// ── I8 (list): list_workers marks background workers with `· bg` ────────────
{
  const h = makeHarness("list", { worktreeMode: "auto", withRepo: false });
  const bg = await h.orch.spawn("42", spec("bgw", join(h.root, "proj"), { task: "do B", background: true }));
  await h.orch.spawn("42", spec("live", join(h.root, "proj"), { task: "do L" }));
  const tools = (h.orch as any).toolsFor("42") as any[];
  const out = String(await tools.find((t) => t.name === "list_workers").run({}));
  const lines = out.split("\n");
  check("both workers are listed (2 busy)", /^2 workers \(2 busy, max 4\)\./.test(out), out);
  check("bg worker carries the `· bg` marker", lines.includes("## bgw — running (build, writes) · bg"), out);
  check("live worker is listed unchanged (no marker)", lines.includes("## live — running (build, writes)"), out);
  check("only the bg worker carries the marker", lines.filter((l) => l.includes("· bg")).length === 1, out);
  check("the bg worker's dir line is present", lines.includes(`dir: ${join(h.root, "proj")}`), out);
  void bg;
}

// ── I8 (board): the manager board never offers a jump row for a bg worker ───
let caseN = 0;
function makeBot() {
  caseN++;
  const dir = join(tmp, `board${caseN}`);
  mkdirSync(dir, { recursive: true });
  const sent: { conv: string; text: string; opts: Record<string, any> }[] = [];
  let msgId = 1000;
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (conv: string, text: string) => (sent.push({ conv, text, opts: {} }), ++msgId),
    sendMessageId: async (conv: string, text: string, opts: Record<string, any> = {}) => (sent.push({ conv, text, opts }), ++msgId),
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    editMessageReplyMarkup: async () => {},
    answerCallbackQuery: async () => {},
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
  const cfg: any = { stateFile: join(dir, "state.json"), maxSchedules: 5, busyMode: "ask", nextSteps: true, nextMinSecs: 0, maxWorkers: 5 };
  const bot = new Bot(tg, oc, st, cfg);
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
function setWorker(st: StateManager, conv: string, name: string, status: string, introMessageId?: number): void {
  st.set(conv, { worker: { name, status, spawnedBy: "manager", createdAt: NOW, updatedAt: NOW, introMessageId } });
}
const rowsOf = (sent: { opts: Record<string, any> }[]) =>
  (sent.length ? sent[sent.length - 1].opts?.reply_markup?.inline_keyboard : undefined) as
    | Array<Array<{ text: string; switch_to_topic?: { message_id: number } }>>
    | undefined;

{
  const { bot, sent, st } = makeBot();
  st.set("42", { manager: true, sessionID: "ses_mgr", createdBy: "u1" });
  setWorker(st, "42:11", "w-a", "running", 101);
  setWorker(st, "bg:42:bgw", "bgw", "running"); // a bg worker has no intro anchor
  await (bot as any).maybeOfferManagerBoard("42");
  const rows = rowsOf(sent);
  check("a line is sent (the live worker is anchored)", sent.length === 1, JSON.stringify(sent.map((s) => s.text)));
  check(
    "exactly one jump row — the live worker's",
    Array.isArray(rows) && rows.length === 1 && rows[0][0].switch_to_topic?.message_id === 101,
    JSON.stringify(rows),
  );
  check("the bg worker is not a jump target", !rows?.some((r) => r.some((b) => /bgw/.test(b.text))), JSON.stringify(rows));
  check("header counts anchored workers only (⚡ 1 worker đang chạy:)", sent[0]?.text === "⚡ 1 worker đang chạy:", JSON.stringify(sent[0]?.text));
}
{
  const { bot, sent, st } = makeBot();
  st.set("42", { manager: true, sessionID: "ses_mgr", createdBy: "u1" });
  setWorker(st, "bg:42:bgw", "bgw", "running"); // the only busy worker is a bg one
  await (bot as any).maybeOfferManagerBoard("42");
  check("a bg-only busy board sends nothing (no topic to jump to)", sent.length === 0, JSON.stringify(sent));
}

// ── I9 (B3.1): a bg worker counts toward the per-chat busy capacity ─────────
{
  const h = makeHarness("cap", { worktreeMode: "auto", withRepo: false, maxWorkers: 1 });
  const bg = await h.orch.spawn("42", spec("bgw", join(h.root, "proj"), { task: "do B", background: true }));
  check(
    "bg worker is in workersOf(chat)",
    h.orch.workersOf("42").find(([k]) => k === bg.conv)?.[1].worker?.name === "bgw",
    JSON.stringify(h.orch.workersOf("42").map(([k, s]) => [k, s.worker?.name])),
  );
  check(
    "a live spawn is refused at the limit (bg counts toward busy)",
    await throws(() => h.orch.spawn("42", spec("live", join(h.root, "proj"), { task: "do L" })), /Đã có 1 worker đang chạy \(tối đa 1\)/),
  );
  check(
    "a second bg spawn is refused at the limit too",
    await throws(
      () => h.orch.spawn("42", spec("bg2", join(h.root, "proj"), { task: "do C", background: true })),
      /Đã có 1 worker đang chạy \(tối đa 1\)/,
    ),
  );
  check("no topic was created for the refused spawns", h.topicCreations() === 0, String(h.topicCreations()));
}

// ── I9 (B3.2): shared-repo worktree — a bg writer is counted, in both dirs ──
{
  const h = makeHarness("wt-a", { worktreeMode: "auto", withRepo: true });
  const live = await h.orch.spawn("42", spec("live", h.repo, { task: "do L" }));
  check("the first live writer takes the main checkout", !live.worker.worktree && live.worker.repoRoot === h.repo, JSON.stringify(live.worker));
  const bg = await h.orch.spawn("42", spec("bgw", h.repo, { task: "do B", background: true }));
  check("a bg writer behind a busy live writer gets its own worktree", !!bg.worker.worktree?.branch && bg.worker.repoRoot === h.repo, JSON.stringify(bg.worker.worktree));
}
{
  const h = makeHarness("wt-b", { worktreeMode: "auto", withRepo: true });
  const bg = await h.orch.spawn("42", spec("bgw", h.repo, { task: "do B", background: true }));
  check("a first bg writer takes the main checkout", !bg.worker.worktree && bg.worker.repoRoot === h.repo, JSON.stringify(bg.worker));
  const live = await h.orch.spawn("42", spec("live", h.repo, { task: "do L" }));
  check(
    "a live writer behind a busy bg writer is diverted to a worktree (bg counted)",
    !!live.worker.worktree?.branch && live.worker.repoRoot === h.repo,
    JSON.stringify(live.worker.worktree),
  );
}

// ── I9 (B3.5): healWorkers settles an idle bg worker; busy one is left ──────
{
  const h = makeHarness("heal", { worktreeMode: "always", withRepo: true });
  const healed = await h.orch.spawn("42", spec("heal", h.repo, { task: "do H", background: true }));
  const busy = await h.orch.spawn("42", spec("still", h.repo, { task: "do S", background: true }));
  const sHealed = h.st.get(healed.conv)!.sessionID!;
  const sBusy = h.st.get(busy.conv)!.sessionID!;
  h.latest({ text: "healed tail", time: Date.now() });
  h.setState((sid) => (sid === sBusy ? { busy: true } : { busy: false, outcome: "succeeded" }));
  const beforeIds = h.sentIds.length;
  const beforeHtml = h.sent.length;
  await h.orch.healWorkers();
  check("the idle bg session settles the stuck worker to done", h.st.peek(healed.conv)?.worker?.status === "done", h.st.peek(healed.conv)?.worker?.status);
  check("the still-busy bg session is left running", h.st.peek(busy.conv)?.worker?.status === "running", h.st.peek(busy.conv)?.worker?.status);
  const card = h.sentIds.slice(beforeIds).find((s) => s.kb);
  check("the healed done card lands in the MAIN chat", !!card && card.conv === "42", JSON.stringify(h.sentIds.slice(beforeIds)));
  check("the done card carries the worktree keyboard", !!card?.kb?.inline_keyboard?.some((row: any[]) => row.some((b: any) => /Diff/.test(b.text))), JSON.stringify(card?.kb));
  check(
    "nothing is sent to a bg conv",
    h.sentIds.slice(beforeIds).every((s) => !s.conv.startsWith("bg:")) && h.sent.slice(beforeHtml).every((s) => !s.conv.startsWith("bg:")),
    JSON.stringify([...h.sentIds.slice(beforeIds), ...h.sent.slice(beforeHtml)]),
  );
  h.clearReportTimers();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
