/**
 * Focused harness for W1 (docs/sdd/background-workers.md): spawning a
 * background worker — `SpawnSpec.background` + the `spawn_worker` tool's
 * `background` param + `spawnReserved`'s skip-topic branch.
 *
 * A background spawn creates the session (+ worktree) with NO Telegram topic:
 * no `createForumTopic`, no intro message, no deep-link card — the worker is
 * stored under the synthetic `bg:<chatId>:<name>` conv, and `findWorker`
 * rejects a duplicate name in either mode. Off-mode (no `background`) stays
 * byte-identical: topic + intro + deep-link exactly as before.
 *
 * Run:  npx tsx scripts/test-bg-spawn.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../src/state.js";
import { Orchestrator, type Host } from "../src/orchestrator.js";
import { BusyNoteStore } from "../src/notes.js";
import { QueueStore } from "../src/queue.js";
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

const tmp = mkdtempSync(join(tmpdir(), "ocbot-bgspawn-"));

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
  topicCreations: () => number;
  topics: string[];
  sent: { conv: string; text: string; kb?: any }[];
  introConvs: string[];
  prompts: { sid: string; text: string }[];
  sessions: () => number;
  lastKb: () => any;
  approvals: () => any[];
}

function makeHarness(file: string, worktreeMode: "auto" | "always", withRepo: boolean): H {
  const base = join(tmp, file);
  const root = join(base, "work");
  mkdirSync(join(root, "proj"), { recursive: true });
  const repo = join(base, "repo");
  if (withRepo) makeRepo(repo);
  const topics: string[] = [];
  const sent: { conv: string; text: string; kb?: any }[] = [];
  const introConvs: string[] = [];
  const prompts: { sid: string; text: string }[] = [];
  let topicCreations = 0;
  let sessions = 0;
  let lastKb: any;
  const tg: any = {
    // Bot API 10.4 deep-link: private-chat topic links need the bot's @username.
    botUsername: async () => "mock_bot",
    createForumTopic: async (_chat: number, name: string) => (topicCreations++, topics.push(name), 100 + topics.length),
    editForumTopic: async () => {},
    closeForumTopic: async () => {},
    openForumTopic: async () => {},
    answerCallbackQuery: async () => {},
    deleteMessage: async () => {},
    deleteForumTopic: async () => {},
    editMessageText: async () => {},
    sendMessageId: async (conv: string, text: string, opts?: any) => {
      sent.push({ conv, text, kb: opts?.reply_markup });
      introConvs.push(conv);
      return 9000;
    },
  };
  const oc: any = {
    createSession: async () => `ses_${++sessions}`,
    setInstruction: async () => {},
    removeInstruction: async () => {},
    prompt: async (sid: string, text: string) => (prompts.push({ sid, text }), "msg_x"),
    interrupt: async () => {},
    removeSession: async () => {},
    latestReply: async () => undefined,
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
    sendHtml: async (conv, html, opts) => {
      sent.push({ conv, text: html, kb: opts?.reply_markup });
      if (opts?.reply_markup) lastKb = opts.reply_markup;
    },
    applyModelAndVariant: async () => {},
    startTyping: () => {},
  };
  const orch = new Orchestrator(host);
  return {
    orch,
    st,
    root,
    repo,
    topicCreations: () => topicCreations,
    topics,
    sent,
    introConvs,
    prompts,
    sessions: () => sessions,
    lastKb: () => lastKb,
    approvals: () => [...((orch as any).approvals ?? new Map()).values()],
  };
}

const spec = (name: string, directory: string, extra: object = {}) =>
  ({ name, directory, spawnedBy: "user", writes: true, ...extra } as any);

// ── background spawn: session (+ worktree), no topic ───────────────────────
{
  const h = makeHarness("auto", "auto", false);
  const r = await h.orch.spawn("42", spec("fix", join(h.root, "proj"), { task: "do X", background: true }));
  check("bg conv key is bg:<chatId>:<name>", r.conv === "bg:42:fix", r.conv);
  check("createForumTopic NOT called", h.topicCreations() === 0 && h.topics.length === 0);
  check("no intro message, no deep-link card — nothing sent", h.sent.length === 0 && h.introConvs.length === 0, JSON.stringify(h.sent));
  const state = h.st.get("bg:42:fix");
  check("session created and bound to the bg conv", !!state?.sessionID && h.st.findChatBySession(state.sessionID) === "bg:42:fix", JSON.stringify(state));
  check("worker stored under the bg conv", state?.worker?.name === "fix" && state?.worker?.status === "running" && state?.worker?.spawnedBy === "user");
  check("task is prompted on the bg session", h.prompts.length === 1 && h.prompts[0].sid === state?.sessionID && /worker "fix"/.test(h.prompts[0].text) && /do X$/.test(h.prompts[0].text), JSON.stringify(h.prompts));

  // B1.4 — findWorker rejects a duplicate name in either mode.
  check(
    "live spawn with the bg worker's name is rejected",
    await throws(() => h.orch.spawn("42", spec("fix", join(h.root, "proj"), { task: "do Y" })), /Đã có worker|already exists/),
  );
  check(
    "bg spawn with the bg worker's name is rejected",
    await throws(() => h.orch.spawn("42", spec("fix", join(h.root, "proj"), { task: "do Z", background: true })), /Đã có worker|already exists/),
  );
  check("duplicate rejection created no extra session", h.sessions() === 1);

  // Off-mode byte-identical: a live spawn on the same harness still opens its
  // topic, sends the intro into the topic and the 10.4 deep-link card.
  const r2 = await h.orch.spawn("42", spec("live", join(h.root, "proj"), { task: "do Y" }));
  check("off-mode still opens a topic named with status", h.topicCreations() === 1 && h.topics[0] === "🟢 live" && r2.conv === "42:101", JSON.stringify([h.topics, r2.conv]));
  check("off-mode binds the session to the topic", h.st.get("42:101")?.sessionID === "ses_2" && h.st.findChatBySession("ses_2") === "42:101");
  check("off-mode sends the intro into the topic", h.introConvs.join(",") === "42:101", JSON.stringify(h.introConvs));
  const card = h.sent.find((s) => s.conv === "42" && s.kb);
  check("off-mode sends the 10.4 deep-link card to the chat", !!card && card.kb.inline_keyboard[0][0].url === "https://t.me/mock_bot/101", JSON.stringify(card));
  check(
    "bg spawn with a live worker's name is rejected",
    await throws(() => h.orch.spawn("42", spec("live", join(h.root, "proj"), { task: "do Z", background: true })), /Đã có worker|already exists/),
  );
}

// ── background writer in a shared repo gets its own worktree ───────────────
{
  const h = makeHarness("wt", "always", true);
  const r = await h.orch.spawn("42", spec("wt-bg", h.repo, { task: "do W", background: true }));
  check("bg writer gets its own worktree", !!r.worker.worktree?.branch && r.worker.repoRoot === h.repo, JSON.stringify(r.worker.worktree));
  const state = h.st.get(r.conv);
  check("bg conv state points at the worktree dir", !!state?.directory && state.directory !== h.repo && existsSync(state.directory), String(state?.directory));
  check("bg worktree spawn created no topic", h.topicCreations() === 0 && h.sent.length === 0);
  check("bg worktree worker is listed by name (findWorker)", h.st.findWorker("42", "wt-bg")?.[0] === r.conv);
}

// ── confirm mode (R4): the approval card goes to the chat, spec keeps the flag ─
{
  const h = makeHarness("confirm", "auto", false);
  const tools = (h.orch as any).toolsFor("42") as any[];
  const spawnTool = tools.find((t) => t.name === "spawn_worker");
  check("spawn_worker declares a boolean background input", (spawnTool.inputSchema as any).properties?.background?.type === "boolean", JSON.stringify((spawnTool.inputSchema as any).properties));
  const out = String(await spawnTool.run({ name: "bg2", directory: join(h.root, "proj"), task: "do Z", background: true }));
  check("confirm mode: bg spawn waits for the user's approval", /PENDING/.test(out) && h.sessions() === 0, out);
  check("confirm mode: no topic created while pending", h.topicCreations() === 0);
  const appr = h.approvals();
  check("approval record keeps background:true for the later spawn", appr.length === 1 && appr[0].kind === "spawn" && appr[0].spawn?.background === true, JSON.stringify(appr));
  check("approval card is sent to the chat (not a topic)", h.sent.some((s) => s.conv === "42" && s.kb), JSON.stringify(h.sent.map((s) => s.conv)));
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
