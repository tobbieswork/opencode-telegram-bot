/**
 * Focused harness for W2 (docs/sdd/background-workers.md): relaying a
 * background worker's Telegram output to the MAIN chat.
 *
 *  I4 — onWorkerFinished: the done card / review line goes to relayConv(conv)
 *       (= the main chat), not the bg conv; closeForumTopic and the
 *       pendingTopicDelete purge are skipped; the [Bot event] still reaches
 *       the Manager via queueReport(chatOf(conv)). No raw assistant text is
 *       relayed anywhere for a worker that has no worktree card.
 *  I5 — setStatus: the topic-title edit (editForumTopic) is skipped for a bg
 *       conv (a live worker still gets its title edit).
 *  I6 — sweepUnrelayedReplies: raw assistant text is never relayed for a bg
 *       conv (the live sweep is unchanged).
 *  I7 — sendToWorker: the "📨 Manager:" instruction display goes to the main
 *       chat (a live worker's display stays in its topic).
 *
 * Live-path control: a live (topic) worker's done card still lands in its
 * topic and auto-close still closes that topic.
 *
 * Run:  npx tsx scripts/test-bg-relay.ts
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
import type { Config } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-bgrelay-"));

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
  sent: { conv: string; text: string; kb?: any }[];
  sentIds: { conv: string; text: string; kb?: any }[];
  editTopics: { conv: string; name: string }[];
  closeTopics: string[];
  typings: string[];
  prompts: { sid: string; text: string }[];
  nextSteps: { conv: string; id: number; residual?: any }[];
  topicCreations: () => number;
  sessions: () => number;
  latest: (v: { text: string; time: number } | undefined) => void;
  reports: () => Map<string, string[]>;
  clearReportTimers: () => void;
}

function makeHarness(file: string, worktreeMode: "auto" | "always", withRepo: boolean): H {
  const base = join(tmp, file);
  const root = join(base, "work");
  mkdirSync(join(root, "proj"), { recursive: true });
  const repo = join(base, "repo");
  if (withRepo) makeRepo(repo);
  const sent: { conv: string; text: string; kb?: any }[] = [];
  const sentIds: { conv: string; text: string; kb?: any }[] = [];
  const editTopics: { conv: string; name: string }[] = [];
  const closeTopics: string[] = [];
  const typings: string[] = [];
  const prompts: { sid: string; text: string }[] = [];
  const nextSteps: { conv: string; id: number; residual?: any }[] = [];
  let topicCreations = 0;
  let sessions = 0;
  let latestReply: { text: string; time: number } | undefined;
  const tg: any = {
    botUsername: async () => "mock_bot",
    createForumTopic: async () => (topicCreations++, 100 + topicCreations),
    editForumTopic: async (conv: string, name: string) => (editTopics.push({ conv, name }), undefined),
    closeForumTopic: async (conv: string) => (closeTopics.push(conv), undefined),
    openForumTopic: async () => {},
    deleteForumTopic: async () => {},
    answerCallbackQuery: async () => {},
    deleteMessage: async () => {},
    editMessageText: async () => {},
    sendChatAction: async (conv: string) => (typings.push(conv), undefined),
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
    sessionState: async () => ({ busy: false }),
  };
  const cfg = {
    opencodeDirectory: root,
    browseRoots: withRepo ? [root, repo] : [root],
    managerDir: join(base, "mgr"),
    maxWorkers: 4,
    worktreeMode,
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
    startTyping: (conv) => (typings.push(conv), undefined),
    startWorking: () => {},
    stopWorking: () => {},
    noteNextStepMessage: (conv, id, residual) => (nextSteps.push({ conv, id, residual }), undefined),
  };
  const orch = new Orchestrator(host);
  return {
    orch,
    st,
    root,
    repo,
    sent,
    sentIds,
    editTopics,
    closeTopics,
    typings,
    prompts,
    nextSteps,
    topicCreations: () => topicCreations,
    sessions: () => sessions,
    latest: (v) => (latestReply = v),
    reports: () => (orch as any).reports,
    clearReportTimers: () => {
      for (const t of (orch as any).reportTimers.values()) clearTimeout(t);
      (orch as any).reportTimers.clear();
    },
  };
}

const spec = (name: string, directory: string, extra: object = {}) =>
  ({ name, directory, spawnedBy: "user", writes: true, ...extra } as any);

const BG = "bg:42:fix";

// ── I4 + I5: bg worker finishes — card to the MAIN chat, no topic calls ────
{
  const h = makeHarness("card", "always", true);
  const r = await h.orch.spawn("42", spec("fix", h.repo, { task: "do X", background: true }));
  check("bg conv is bg:<chatId>:<name>", r.conv === BG, r.conv);
  const before = h.sentIds.length + h.sent.length + h.editTopics.length + h.closeTopics.length;
  // The Manager watches this chat: the [Bot event] must still reach it.
  h.st.set("42", { manager: true, sessionID: "ses_mgr" });
  h.latest({ text: "raw assistant tail text", time: Date.now() });
  await (h.orch as any).onWorkerFinished(BG, "done");
  const freshIds = h.sentIds.slice(before);
  const freshHtml = h.sent.slice(before);
  const card = freshIds.find((s) => s.kb);
  check("done card is sent to the MAIN chat", !!card && card.conv === "42", JSON.stringify(freshIds));
  check("done card carries the worktree keyboard", !!card?.kb?.inline_keyboard?.some((row: any[]) => row.some((b: any) => /Diff/.test(b.text))), JSON.stringify(card?.kb));
  check("nothing is sent to the bg conv", freshIds.every((s) => s.conv !== BG) && freshHtml.every((s) => s.conv !== BG), JSON.stringify([...freshIds, ...freshHtml]));
  check("closeForumTopic NOT called", h.closeTopics.length === 0, JSON.stringify(h.closeTopics));
  check("editForumTopic NOT called (I5, via setStatus)", h.editTopics.length === 0, JSON.stringify(h.editTopics));
  const reports = h.reports().get("42") ?? [];
  check("[Bot event] still queued for the Manager on chatOf(conv)", reports.length === 1 && /^\[worker fix\] DONE\nraw assistant tail text$/.test(reports[0]), JSON.stringify(reports));
  h.clearReportTimers();
  check("worker settled to done", h.st.peek(BG)?.worker?.status === "done");
}

// ── I4: bg worker WITHOUT a worktree — no raw text relay, manager gets tail ─
{
  const h = makeHarness("nowt", "auto", false);
  const r = await h.orch.spawn("42", spec("quiet", join(h.root, "proj"), { task: "do Q", background: true }));
  h.st.set("42", { manager: true, sessionID: "ses_mgr" });
  h.latest({ text: "quiet worker finished", time: Date.now() });
  await (h.orch as any).onWorkerFinished(r.conv, "done");
  check("no Telegram message at all for a worktree-less bg worker (no raw text)", h.sentIds.length === 0 && h.sent.length === 0, JSON.stringify([...h.sentIds, ...h.sent]));
  check("no closeForumTopic / editForumTopic", h.closeTopics.length === 0 && h.editTopics.length === 0);
  const reports = h.reports().get("42") ?? [];
  check("the Manager still gets the done report with the tail", reports.length === 1 && reports[0].includes("[worker quiet] DONE") && reports[0].includes("quiet worker finished"), JSON.stringify(reports));
  h.clearReportTimers();
}

// ── I5: live worker still gets its topic-title edit on status change ───────
{
  const h = makeHarness("live", "always", true);
  const r = await h.orch.spawn("42", spec("live", h.repo, { task: "do L" }));
  check("live conv is the topic conv", !r.conv.startsWith("bg:") && r.conv.startsWith("42:"), r.conv);
  (h.orch as any).setStatus(r.conv, "waiting");
  check("live setStatus still edits the topic title", h.editTopics.some((e) => e.conv === r.conv), JSON.stringify(h.editTopics));
  // Live done path unchanged: card in the topic + auto-close of the topic.
  h.latest({ text: "live tail", time: Date.now() });
  await (h.orch as any).onWorkerFinished(r.conv, "done");
  const card = h.sentIds.find((s) => s.conv === r.conv && s.kb);
  check("live done card still lands in the topic (not the main chat)", !!card && !h.sentIds.some((s) => s.conv === "42" && s.kb), JSON.stringify(h.sentIds));
  check("live auto-close still closes the topic", h.closeTopics.some((c) => c === r.conv), JSON.stringify(h.closeTopics));
  h.clearReportTimers();
}

// ── I7: sendToWorker shows the instruction in the MAIN chat for bg ─────────
{
  const h = makeHarness("send", "auto", false);
  const r = await h.orch.spawn("42", spec("fix", join(h.root, "proj"), { task: "do X", background: true }));
  (h.orch as any).setStatus(BG, "done"); // free the worker (not busy)
  const before = h.sent.length;
  const tBefore = h.typings.length;
  await (h.orch as any).sendToWorker(BG, "now do Y");
  const fresh = h.sent.slice(before);
  const freshTypings = h.typings.slice(tBefore);
  check("📨 Manager: instruction is rendered to the MAIN chat", fresh.some((s) => s.conv === "42" && /📨 <b>Manager:<\/b>/.test(s.text) && /now do Y/.test(s.text)), JSON.stringify(fresh));
  check("instruction is NOT sent to the bg conv", fresh.every((s) => s.conv !== BG), JSON.stringify(fresh));
  check("typing indicator goes to the main chat (not the bg conv)", freshTypings.length > 0 && freshTypings.every((c) => c === "42"), JSON.stringify(freshTypings));
  const last = h.prompts[h.prompts.length - 1];
  check("the worker session still gets the original markdown", last?.text === "now do Y", JSON.stringify(last));
  // Live contrast: the same call on a topic worker stays in the topic.
  const l = await h.orch.spawn("42", spec("live", join(h.root, "proj"), { task: "do L" }));
  (h.orch as any).setStatus(l.conv, "done");
  const b2 = h.sent.length;
  await (h.orch as any).sendToWorker(l.conv, "now do Z");
  const fresh2 = h.sent.slice(b2);
  check("live worker's instruction display stays in its topic", fresh2.some((s) => s.conv === l.conv && /📨 <b>Manager:<\/b>/.test(s.text)), JSON.stringify(fresh2));
}

// ── I6: the raw-text sweep is skipped for a bg conv, live sweep unchanged ──
{
  const base = join(tmp, "sweep");
  mkdirSync(base, { recursive: true });
  const st = new StateManager(join(base, "state.json"));
  const sentIds: { conv: string; text: string }[] = [];
  const tg: any = { sendMessageId: async (conv: string, text: string) => (sentIds.push({ conv, text }), 1) };
  const t0 = Date.now() - 60_000;
  const t1 = Date.now();
  const replyMsg = { type: "assistant", time: { created: t1 }, content: [{ type: "text", text: "raw assistant text" }] };
  const oc: any = { listMessages: async () => [replyMsg] };
  const cfg: any = { stateFile: join(base, "state.json"), replyMaxLen: 4000, richReplies: false, react: false };
  const bot = new Bot(tg, oc, st, cfg);

  st.set(BG, { sessionID: "ses_1", lastRelayedTime: t0, worker: { name: "fix", status: "done" } as any });
  await (bot as any).sweepUnrelayedReplies(BG, "test");
  check("sweep relays NO raw assistant text for a bg conv", sentIds.length === 0, JSON.stringify(sentIds));

  st.set("42", { sessionID: "ses_2", lastRelayedTime: t0 });
  await (bot as any).sweepUnrelayedReplies("42", "test");
  check("sweep still relays for a live conv (unchanged)", sentIds.length === 1 && sentIds[0].conv === "42" && /raw assistant text/.test(sentIds[0].text), JSON.stringify(sentIds));
}

// ── B3.4/B2.5: /stop on a bg worker — no closeForumTopic (no topic exists) ─
{
  const h = makeHarness("stop", "always", true);
  const r = await h.orch.spawn("42", spec("stopme", h.repo, { task: "do S", background: true }));
  check("bg worker conv is the synthetic bg conv", r.conv === "bg:42:stopme", r.conv);
  const before = h.closeTopics.length;
  const msg = await (h.orch as any).stopWorker(r.conv, true);
  check("stopWorker returns the stop notice", /Stopped worker|Đã dừng worker/.test(msg), msg);
  check("stopWorker does NOT call closeForumTopic for a bg conv (B2.5)", h.closeTopics.length === before, JSON.stringify(h.closeTopics));
  check("bg worker marked stopped", h.st.peek(r.conv)?.worker?.status === "stopped");
  // Live control: a live worker's /stop still closes its topic.
  const l = await h.orch.spawn("42", spec("livestop", h.repo, { task: "do L" }));
  const beforeLive = h.closeTopics.length;
  await (h.orch as any).stopWorker(l.conv, true);
  check("live /stop still closes the topic (unchanged)", h.closeTopics.length === beforeLive + 1 && h.closeTopics[h.closeTopics.length - 1] === l.conv, JSON.stringify(h.closeTopics));
  h.clearReportTimers();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
