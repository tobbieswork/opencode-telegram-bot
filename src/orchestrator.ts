import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Telegram, CallbackQuery, TOPIC_COLORS } from "./telegram.js";
import { OpenCodeCtl } from "./opencode.js";
import { StateManager, ChatState, WorkerInfo, WorkerStatus } from "./state.js";
import { Config } from "./config.js";
import { ConvKey, chatOf, convKey, parseConv } from "./conv.js";
import { McpBridge, BridgeTool } from "./mcp-bridge.js";
import { addWorktree, diffSummary, gitRoot, mergeWorktree, removeWorktree } from "./worktree.js";
import { listDirs } from "./fsbrowser.js";
import { esc, trunc, timeAgo, stripTags } from "./format.js";
import { log, warn } from "./logger.js";

type Btn = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Btn[][] };

/** What the orchestrator needs from the Bot (kept narrow on purpose). */
export interface Host {
  tg: Telegram;
  oc: OpenCodeCtl;
  st: StateManager;
  cfg: Config;
  sendHtml(conv: ConvKey, html: string, opts?: { reply_markup?: Keyboard }): Promise<void>;
  applyModelAndVariant(sessionID: string, state: ChatState): Promise<void>;
  startTyping(conv: ConvKey): void;
}

export const MANAGER_AGENT = "tg-manager";
const BRIDGE_NAME = "tg-bridge";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const BUSY: WorkerStatus[] = ["running", "waiting"];
const ICON: Record<WorkerStatus, string> = {
  idle: "💤",
  running: "🟢",
  waiting: "🟡",
  done: "✅",
  failed: "❌",
  stopped: "⏹",
};
/** Manager-initiated dispatches allowed between two user messages (loop/cost guard). */
const DISPATCH_BUDGET = 12;
/** Worker reports arriving within this window reach the Manager as one message. */
const REPORT_DEBOUNCE_MS = 4000;

const workerPreamble = (name: string) =>
  `[System note: You are worker "${name}", one of several agents working in parallel. You are driven ` +
  "through Telegram — the user has no terminal. When you need a decision, ask with the `question` tool " +
  "(clear multiple-choice options, ONE question at a time). When you finish, END your final message with " +
  "a short summary (max ~10 lines): what you did, files changed, how to verify, and anything blocking.]";

const MANAGER_PROMPT = (maxWorkers: number) => `---
description: Telegram manager — splits work across parallel worker sessions
mode: primary
permissions:
  - action: execute
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---
You are the Manager. The user talks to you from Telegram (usually in Vietnamese — always reply in the
user's language). You do NOT edit files or run commands yourself. You get work done by delegating it to
workers: each worker is a separate OpenCode coding session with its own Telegram topic, running in a
directory you choose.

## Tools
Call these directly as native tools (never through \`execute\`):
- tg-bridge_list_directories — the project folders workers may run in (browse one level at a time).
- tg-bridge_list_workers — every worker with its status, directory and last result.
- tg-bridge_spawn_worker — create a worker and give it its first task.
- tg-bridge_send_to_worker — give an existing worker a follow-up instruction.
- tg-bridge_get_worker_result — read a worker's latest full reply.
- tg-bridge_stop_worker — interrupt a worker.

## How to work
1. Understand the request. If something important is ambiguous, ask ONE question with the \`question\` tool.
2. Pick the directory. Use list_directories; never guess paths.
3. Split the work into independent tasks that can run in parallel. A worker does NOT see this
   conversation, so each task must be self-contained: goal, relevant context, constraints, and what
   "done" means.
4. Choose the agent: "build" to change code, "plan" for analysis/design only, "explore" for quick
   read-only lookups. Set writes=false for tasks that must not change files.
5. Spawn the workers (short kebab-case names like "api-auth", "write-tests"). At most ${maxWorkers} may be busy at once.
6. If a tool answers that the request is waiting for the user's approval, tell the user in one line and
   stop. Do not call it again — you will be told the decision.

Messages that start with "[Bot event]" come from the bot, not the user: worker reports and approval
decisions. For those: summarise for the user in a few lines (worker name + outcome), then decide the next
step — a follow-up with send_to_worker, a new worker, or telling the user the work is done. Do not start
new work the user did not ask for. If nothing needs the user's attention, reply with one short line.

Workers' permission requests and questions go to the user in each worker's topic; you never answer them.
Keep every reply short and concrete. Refer to workers by name.
`;

interface SpawnSpec {
  name: string;
  directory: string;
  task?: string;
  agent?: string;
  writes?: boolean;
  spawnedBy: "user" | "manager";
}

/** A Manager action waiting for the user's ✅ (confirm mode). */
interface Approval {
  id: string;
  chat: ConvKey;
  kind: "spawn" | "send";
  spawn?: SpawnSpec;
  send?: { name: string; message: string };
}

/**
 * Multi-session layer on top of Bot: worker sessions in forum topics, the
 * Manager agent in the chat's top level, the MCP tool bridge the Manager uses
 * to steer workers, the confirm-before-dispatch cards, and git worktree
 * isolation for parallel writers.
 */
export class Orchestrator {
  private bridge?: McpBridge;
  private approvals = new Map<string, Approval>();
  private approvalSeq = 0;
  private reports = new Map<ConvKey, string[]>();
  private reportTimers = new Map<ConvKey, ReturnType<typeof setTimeout>>();
  /** Remaining Manager dispatches per chat until the user speaks again. */
  private budget = new Map<ConvKey, number>();
  /** Worker convs whose turn-end we are already processing. */
  private finishing = new Set<ConvKey>();

  constructor(private h: Host) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /** On every (re)connect to OpenCode: re-register the bridge for chats with a Manager (it is runtime-only). */
  async onConnect(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (s.manager) await this.ensureManagerTooling(chatOf(conv)).catch((e) => warn("manager tooling:", e?.message));
    }
  }

  private async ensureBridge(): Promise<McpBridge> {
    if (this.bridge) return this.bridge;
    const b = new McpBridge((route) => (this.h.st.peek(route)?.manager ? this.toolsFor(route) : undefined), BRIDGE_NAME);
    await b.listen(this.h.cfg.bridgePort);
    this.bridge = b;
    return b;
  }

  private managerDir(chat: ConvKey): string {
    return join(this.h.cfg.managerDir, chat);
  }

  /** Write the Manager agent into its own directory and register the bridge for that directory only. */
  private async ensureManagerTooling(chat: ConvKey): Promise<string> {
    const dir = this.managerDir(chat);
    mkdirSync(join(dir, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "agents", `${MANAGER_AGENT}.md`), MANAGER_PROMPT(this.h.cfg.maxWorkers));
    const b = await this.ensureBridge();
    await this.h.oc.addRemoteMcp(dir, BRIDGE_NAME, b.url(chat), { Authorization: `Bearer ${b.token}` });
    return dir;
  }

  isManagerConv(conv: ConvKey): boolean {
    return !!this.h.st.peek(conv)?.manager;
  }

  // ── commands ──────────────────────────────────────────────────────────────
  /** Returns true when the command was one of ours. */
  async handleCommand(conv: ConvKey, cmd: string, arg: string): Promise<boolean> {
    switch (cmd) {
      case "/spawn":
        await this.cmdSpawn(conv, arg);
        return true;
      case "/board":
      case "/workers":
        await this.cmdBoard(conv);
        return true;
      case "/kill":
        await this.cmdKill(conv, arg);
        return true;
      case "/stopall":
        await this.cmdStopAll(conv);
        return true;
      case "/manager":
        await this.cmdManager(conv, arg);
        return true;
      case "/auto":
        await this.cmdAuto(conv, arg);
        return true;
      case "/wt":
        await this.cmdWorktree(conv);
        return true;
      default:
        return false;
    }
  }

  private async cmdSpawn(conv: ConvKey, arg: string): Promise<void> {
    const [name, ...rest] = arg.split(/\s+/).filter(Boolean);
    if (!name) {
      await this.h.sendHtml(
        conv,
        "Usage: <code>/spawn &lt;tên&gt; [thư mục]</code>\nTạo một topic mới với session riêng. Ví dụ: <code>/spawn api-fix ~/Code/app</code>",
      );
      return;
    }
    const top = this.h.st.get(chatOf(conv));
    const dir = rest.join(" ") || this.h.st.get(conv).directory || top.directory || this.h.cfg.opencodeDirectory;
    try {
      const r = await this.spawn(chatOf(conv), { name, directory: dir, spawnedBy: "user", writes: true });
      await this.h.sendHtml(conv, `🧩 Đã tạo worker <b>${esc(name)}</b> — mở topic “${esc(this.topicName(r.worker))}” để làm việc.`);
    } catch (e) {
      await this.h.sendHtml(conv, `❌ ${esc((e as Error).message)}`);
    }
  }

  private async cmdBoard(conv: ConvKey): Promise<void> {
    const top = this.h.st.get(chatOf(conv));
    const workers = this.workersOf(conv);
    const head = `📋 <b>Workers (${workers.length})</b> · manager: ${top.manager ? "on" : "off"} · auto: ${top.auto ? "on" : "off"}`;
    if (!workers.length) {
      await this.h.sendHtml(conv, `${head}\n\nChưa có worker. Tạo bằng <code>/spawn &lt;tên&gt; [thư mục]</code> hoặc bật /manager.`);
      return;
    }
    const lines = workers
      .sort(([, a], [, b]) => (b.worker!.updatedAt ?? 0) - (a.worker!.updatedAt ?? 0))
      .map(([, s]) => {
        const w = s.worker!;
        const where = w.worktree ? `🌿 <code>${esc(w.worktree.branch)}</code>` : `<code>${esc(trunc(s.directory ?? "", 40))}</code>`;
        return `${ICON[w.status]} <b>${esc(w.name)}</b> · ${esc(s.agent ?? "build")} · ${timeAgo(w.updatedAt)}\n    ${where}`;
      });
    await this.h.sendHtml(conv, `${head}\n\n${lines.join("\n")}\n\n<i>/kill &lt;tên&gt; để dừng · /stopall dừng tất cả</i>`);
  }

  private async cmdKill(conv: ConvKey, arg: string): Promise<void> {
    const target = arg ? this.h.st.findWorker(conv, arg.trim())?.[0] : this.h.st.peek(conv)?.worker ? conv : undefined;
    if (!target) {
      await this.h.sendHtml(conv, arg ? `❌ Không có worker <code>${esc(arg)}</code>.` : "Usage: <code>/kill &lt;tên&gt;</code> (hoặc gõ /kill trong topic của worker)");
      return;
    }
    const msg = await this.stopWorker(target, true);
    await this.h.sendHtml(conv, msg);
  }

  private async cmdStopAll(conv: ConvKey): Promise<void> {
    const busy = this.workersOf(conv).filter(([, s]) => BUSY.includes(s.worker!.status));
    for (const [k] of busy) await this.stopWorker(k, false);
    await this.h.sendHtml(conv, busy.length ? `⏹ Đã dừng ${busy.length} worker.` : "Không có worker nào đang chạy.");
  }

  private async cmdManager(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    if (conv !== chat) {
      await this.h.sendHtml(conv, "ℹ️ Bật Manager ở khung chat chính (General), không phải trong topic.");
      return;
    }
    const want = arg.trim().toLowerCase();
    const top = this.h.st.get(chat);
    if (want === "off") {
      if (!top.manager) return void (await this.h.sendHtml(conv, "Manager đang tắt."));
      if (top.sessionID) await this.h.oc.interrupt(top.sessionID).catch(() => {});
      this.h.st.set(chat, { manager: false, sessionID: undefined, agent: undefined, directory: undefined, guided: false });
      await this.h.sendHtml(conv, "🧭 Đã tắt Manager. Chat chính quay lại làm việc như một session bình thường; các worker vẫn giữ nguyên.");
      return;
    }
    if (want !== "on" && want !== "") {
      await this.h.sendHtml(conv, "Usage: <code>/manager on|off</code>");
      return;
    }
    if (top.manager && top.sessionID) {
      await this.h.sendHtml(
        conv,
        `🧭 Manager đang bật (session <code>${esc(top.sessionID)}</code>). Cứ nhắn yêu cầu ở đây. <code>/manager off</code> để tắt.`,
      );
      return;
    }
    try {
      const dir = await this.ensureManagerTooling(chat);
      const sessionID = await this.h.oc.createSession(dir, { title: "tg:manager", agent: MANAGER_AGENT, metadata: { tgRole: "manager" } });
      this.h.st.set(chat, { manager: true, sessionID, directory: dir, agent: MANAGER_AGENT, lastRelayedTime: 1, guided: true });
      await this.h.applyModelAndVariant(sessionID, this.h.st.get(chat));
      await this.h.sendHtml(
        conv,
        [
          "🧭 <b>Manager đã bật.</b>",
          "Nhắn yêu cầu ở đây — Manager sẽ chia việc và giao cho các worker, mỗi worker một topic riêng.",
          `Chế độ duyệt: <b>${top.auto ? "auto (tự giao việc)" : "hỏi trước khi giao việc"}</b> — đổi bằng /auto on|off.`,
          "Xin quyền / câu hỏi của worker sẽ hiện trong topic của worker đó.",
        ].join("\n"),
      );
    } catch (e) {
      await this.h.sendHtml(conv, `❌ Không bật được Manager: ${esc((e as Error).message)}`);
    }
  }

  private async cmdAuto(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    const want = arg.trim().toLowerCase();
    if (want === "on" || want === "off") this.h.st.set(chat, { auto: want === "on" });
    const on = !!this.h.st.get(chat).auto;
    await this.h.sendHtml(
      conv,
      on
        ? "⚡ Auto: <b>on</b> — Manager tự tạo worker và giao việc, chỉ báo lại kết quả. Xin quyền của worker vẫn hỏi bạn."
        : "🛂 Auto: <b>off</b> — Manager phải chờ bạn bấm ✅ trước khi tạo worker hoặc giao việc.",
    );
  }

  private async cmdWorktree(conv: ConvKey): Promise<void> {
    const w = this.h.st.peek(conv)?.worker;
    if (!w?.worktree) {
      await this.h.sendHtml(conv, "ℹ️ Topic này không chạy trong git worktree riêng.");
      return;
    }
    await this.h.sendHtml(conv, this.worktreeText(w), { reply_markup: this.worktreeKeyboard(w) });
  }

  // ── workers ───────────────────────────────────────────────────────────────
  private workersOf(conv: ConvKey): [ConvKey, ChatState][] {
    return this.h.st.convsOfChat(conv).filter(([, s]) => s.worker);
  }

  private topicName(w: WorkerInfo): string {
    return `${ICON[w.status]} ${w.name}`;
  }

  /** Resolve and vet a directory a worker may run in: real path, existing dir, under the browse roots, not the Manager's. */
  private vetDirectory(dir: string): string {
    const expanded = dir.startsWith("~") ? join(process.env.HOME ?? "", dir.slice(1)) : dir;
    const abs = isAbsolute(expanded) ? expanded : resolve(this.h.cfg.opencodeDirectory, expanded);
    let real: string;
    try {
      real = realpathSync(abs);
      if (!statSync(real).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Không tìm thấy thư mục: ${abs}`);
    }
    const under = (root: string) => {
      let r: string;
      try {
        r = realpathSync(root);
      } catch {
        return false;
      }
      return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
    };
    // Symlinks are resolved first, so a link inside a root can't lead outside it.
    if (!this.h.cfg.browseRoots.some(under)) {
      throw new Error(`Thư mục nằm ngoài vùng cho phép (OPENCODE_TG_BROWSE_ROOTS): ${real}`);
    }
    if (under(this.h.cfg.managerDir)) throw new Error("Không thể chạy worker trong thư mục của Manager.");
    return real;
  }

  /** Create a worker: vet inputs, isolate if needed, open its topic and session, and start its task. */
  async spawn(chat: ConvKey, spec: SpawnSpec): Promise<{ conv: ConvKey; worker: WorkerInfo }> {
    const name = spec.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(`Tên worker không hợp lệ "${spec.name}" — dùng a-z, 0-9, dấu gạch ngang, tối đa 24 ký tự.`);
    if (this.h.st.findWorker(chat, name)) throw new Error(`Đã có worker tên "${name}". Hãy chọn tên khác.`);
    const busy = this.workersOf(chat).filter(([, s]) => BUSY.includes(s.worker!.status)).length;
    if (busy >= this.h.cfg.maxWorkers) throw new Error(`Đã có ${busy} worker đang chạy (tối đa ${this.h.cfg.maxWorkers}). Chờ bớt hoặc /kill bớt.`);

    let directory = this.vetDirectory(spec.directory);
    const agent = spec.agent && ["build", "plan", "explore", "general"].includes(spec.agent) ? spec.agent : "build";
    const writes = spec.writes ?? agent === "build";

    // Isolation: a writer that would share a repo checkout with another busy
    // writer gets its own worktree + branch instead.
    let worktree: WorkerInfo["worktree"];
    let repoRoot: string | undefined;
    if (writes && this.h.cfg.worktreeMode !== "off") {
      repoRoot = await gitRoot(directory);
      if (repoRoot) {
        const shared = this.workersOf(chat).some(
          ([, s]) => BUSY.includes(s.worker!.status) && s.worker!.writes && !s.worker!.worktree && s.worker!.repoRoot === repoRoot,
        );
        if (this.h.cfg.worktreeMode === "always" || shared) {
          const wt = await addWorktree(repoRoot, directory, name);
          worktree = { root: wt.root, branch: wt.branch, base: wt.base };
          directory = wt.directory;
        }
      }
    }

    const { chatId } = parseConv(chat);
    const now = Date.now();
    const worker: WorkerInfo = {
      name,
      status: spec.task ? "running" : "idle",
      task: spec.task,
      spawnedBy: spec.spawnedBy,
      writes,
      worktree,
      repoRoot,
      createdAt: now,
      updatedAt: now,
    };
    let threadId: number;
    try {
      threadId = await this.h.tg.createForumTopic(chatId, this.topicName(worker), TOPIC_COLORS[name.length % TOPIC_COLORS.length]);
    } catch (e) {
      if (worktree && repoRoot) await removeWorktree(repoRoot, worktree).catch(() => {});
      throw new Error(
        `Không tạo được topic (${(e as Error).message}). Cần bật chế độ topic: chat riêng với bot có topic mode, ` +
          "hoặc supergroup bật Topics và bot là admin có quyền “Manage topics”.",
      );
    }
    const conv = convKey(chatId, threadId);
    const top = this.h.st.get(chat);
    const sessionID = await this.h.oc.createSession(directory, {
      title: `tg:${name}`,
      agent,
      metadata: { tgWorker: name, tgChat: chat },
    });
    // Workers inherit the chat's model/variant choice (the Manager's own agent aside).
    this.h.st.set(conv, {
      sessionID,
      directory,
      agent,
      model: top.manager ? undefined : top.model,
      variant: top.manager ? undefined : top.variant,
      guided: true,
      lastRelayedTime: 1, // relay every reply of this fresh session
      worker,
    });
    await this.h.applyModelAndVariant(sessionID, this.h.st.get(conv));
    log(`[chat ${chat}] spawned worker ${name} (${agent}) in ${directory}`);

    const intro = [
      `🧩 <b>Worker ${esc(name)}</b> · ${esc(agent)}${spec.spawnedBy === "manager" ? " · giao bởi Manager" : ""}`,
      `📁 <code>${esc(directory)}</code>`,
    ];
    if (worktree) intro.push(`🌿 worktree riêng, nhánh <code>${esc(worktree.branch)}</code> (từ <code>${esc(worktree.base)}</code>)`);
    if (spec.task) intro.push("", `📝 <b>Nhiệm vụ</b>\n${esc(trunc(spec.task, 1500))}`);
    else intro.push("", "Nhắn tin trong topic này để làm việc với worker.");
    await this.h.sendHtml(conv, intro.join("\n")).catch(() => {});

    if (spec.task) {
      await this.h.oc.prompt(sessionID, `${workerPreamble(name)}\n\n${spec.task}`);
      this.h.startTyping(conv);
    }
    return { conv, worker };
  }

  /** Follow-up instruction to an existing worker (non-blocking). */
  private async sendToWorker(conv: ConvKey, message: string): Promise<void> {
    const s = this.h.st.get(conv);
    if (!s.sessionID || !s.worker) throw new Error("Worker không còn session.");
    if (s.worker.status === "stopped") throw new Error(`Worker "${s.worker.name}" đã bị dừng.`);
    await this.h.sendHtml(conv, `📨 <b>Manager:</b> ${esc(trunc(message, 1500))}`).catch(() => {});
    await this.h.oc.prompt(s.sessionID, message);
    this.setStatus(conv, "running");
    this.h.startTyping(conv);
  }

  private async stopWorker(conv: ConvKey, close: boolean): Promise<string> {
    const s = this.h.st.get(conv);
    const w = s.worker!;
    if (s.sessionID) await this.h.oc.interrupt(s.sessionID).catch(() => {});
    this.setStatus(conv, "stopped");
    if (close) await this.h.tg.closeForumTopic(conv);
    return `⏹ Đã dừng worker <b>${esc(w.name)}</b>.${w.worktree ? " Worktree vẫn giữ — dùng /wt trong topic để xem diff / merge / xoá." : ""}`;
  }

  private setStatus(conv: ConvKey, status: WorkerStatus, lastResult?: string): void {
    const s = this.h.st.peek(conv);
    if (!s?.worker) return;
    const changed = s.worker.status !== status;
    const worker: WorkerInfo = { ...s.worker, status, updatedAt: Date.now(), ...(lastResult !== undefined ? { lastResult } : {}) };
    this.h.st.set(conv, { worker });
    if (changed) void this.h.tg.editForumTopic(conv, this.topicName(worker)).catch((e) => warn("editForumTopic:", e?.message));
  }

  // ── OpenCode lifecycle hooks (called by Bot.onOpenCodeEvent) ───────────────
  onExecution(conv: ConvKey, type: string, error?: string): void {
    const s = this.h.st.peek(conv);
    if (!s?.worker) return;
    if (type === "session.execution.started") {
      if (s.worker.status !== "waiting") this.setStatus(conv, "running");
      return;
    }
    const status: WorkerStatus =
      type === "session.execution.succeeded" ? "done" : type === "session.execution.failed" ? "failed" : "stopped";
    void this.onWorkerFinished(conv, status, error);
  }

  /** A worker is blocked on the user (permission ask / question). */
  onWaiting(conv: ConvKey): void {
    if (this.h.st.peek(conv)?.worker) this.setStatus(conv, "waiting");
  }

  /** The user answered — the worker resumes. */
  onResumed(conv: ConvKey): void {
    if (this.h.st.peek(conv)?.worker?.status === "waiting") this.setStatus(conv, "running");
  }

  private async onWorkerFinished(conv: ConvKey, status: WorkerStatus, error?: string): Promise<void> {
    if (this.finishing.has(conv)) return;
    this.finishing.add(conv);
    try {
      const s = this.h.st.get(conv);
      const w = s.worker!;
      if (w.status === "stopped" && status !== "done") return; // /kill already settled it
      // The final message can land a moment after the event.
      let reply: { text: string; time: number } | undefined;
      for (let i = 0; i < 4 && !reply; i++) {
        reply = s.sessionID ? await this.h.oc.latestReply(s.sessionID) : undefined;
        if (!reply) await new Promise((r) => setTimeout(r, 400));
      }
      const tail = reply ? stripTags(reply.text).trim().slice(-1500) : error ? `error: ${error}` : "(no text reply)";
      this.setStatus(conv, status, tail);
      if (w.worktree && status === "done") {
        await this.h.sendHtml(conv, this.worktreeText(w), { reply_markup: this.worktreeKeyboard(w) }).catch(() => {});
      }
      if (this.h.st.peek(chatOf(conv))?.manager) {
        this.queueReport(chatOf(conv), `[worker ${w.name}] ${status.toUpperCase()}\n${tail}`);
      }
    } finally {
      this.finishing.delete(conv);
    }
  }

  // ── Manager ───────────────────────────────────────────────────────────────
  /** A user message for the Manager: admit it without blocking; the reply is relayed when the turn ends. */
  async promptManager(conv: ConvKey, text: string): Promise<void> {
    const s = this.h.st.get(conv);
    if (!s.sessionID) {
      await this.cmdManager(conv, "on");
      if (!this.h.st.get(conv).sessionID) return;
    }
    this.budget.set(conv, DISPATCH_BUDGET); // the user spoke: refill the dispatch budget
    await this.h.oc.prompt(this.h.st.get(conv).sessionID!, text);
    this.h.startTyping(conv);
  }

  /** Batch worker reports and feed them to the Manager as one "[Bot event]" message. */
  private queueReport(chat: ConvKey, report: string): void {
    const list = this.reports.get(chat) ?? [];
    list.push(report);
    this.reports.set(chat, list);
    if (this.reportTimers.has(chat)) return;
    const t = setTimeout(() => {
      this.reportTimers.delete(chat);
      const batch = this.reports.get(chat) ?? [];
      this.reports.delete(chat);
      void this.notifyManager(chat, batch.join("\n\n")).catch((e) => warn("notify manager:", e?.message));
    }, REPORT_DEBOUNCE_MS);
    (t as any).unref?.();
    this.reportTimers.set(chat, t);
  }

  private async notifyManager(chat: ConvKey, body: string): Promise<void> {
    const sid = this.h.st.peek(chat)?.manager ? this.h.st.peek(chat)?.sessionID : undefined;
    if (!sid || !body) return;
    await this.h.oc.prompt(sid, `[Bot event — not from the user]\n${body}`);
    this.h.startTyping(chat);
  }

  /** Spend one unit of the chat's dispatch budget, or refuse. */
  private takeBudget(chat: ConvKey): void {
    const left = this.budget.get(chat) ?? DISPATCH_BUDGET;
    if (left <= 0) {
      throw new Error(
        `Dispatch budget exhausted (${DISPATCH_BUDGET} dispatches since the user's last message). ` +
          "Stop and ask the user before dispatching more work.",
      );
    }
    this.budget.set(chat, left - 1);
  }

  // ── approvals (confirm mode) ──────────────────────────────────────────────
  private async requestApproval(a: Omit<Approval, "id">): Promise<string> {
    const id = String(++this.approvalSeq);
    this.approvals.set(id, { ...a, id });
    const lines = ["🛂 <b>Manager muốn giao việc</b>"];
    if (a.kind === "spawn" && a.spawn) {
      const sp = a.spawn;
      lines.push(
        `Worker mới: <b>${esc(sp.name)}</b> · ${esc(sp.agent ?? "build")}${sp.writes === false ? " · chỉ đọc" : ""}`,
        `📁 <code>${esc(sp.directory)}</code>`,
        "",
        esc(trunc(sp.task ?? "", 1500)),
      );
    } else if (a.send) {
      lines.push(`Gửi tới worker <b>${esc(a.send.name)}</b>:`, "", esc(trunc(a.send.message, 1500)));
    }
    await this.h.sendHtml(a.chat, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Giao", callback_data: `ap:${id}:ok` },
            { text: "❌ Huỷ", callback_data: `ap:${id}:no` },
          ],
          [{ text: "⚡ Giao + bật auto", callback_data: `ap:${id}:auto` }],
        ],
      },
    });
    return id;
  }

  private async execApproved(a: Approval): Promise<string> {
    if (a.kind === "spawn" && a.spawn) {
      const r = await this.spawn(a.chat, a.spawn);
      return `worker ${r.worker.name} started`;
    }
    if (a.send) {
      const target = this.h.st.findWorker(a.chat, a.send.name);
      if (!target) throw new Error(`no worker named ${a.send.name}`);
      await this.sendToWorker(target[0], a.send.message);
      return `message delivered to ${a.send.name}`;
    }
    return "nothing to do";
  }

  // ── callbacks ─────────────────────────────────────────────────────────────
  /** Returns true when the button was one of ours (`ap:` approvals, `wt:` worktree actions). */
  async handleCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<boolean> {
    const data = cb.data ?? "";
    if (data.startsWith("ap:")) {
      await this.handleApprovalCallback(cb, conv, messageId);
      return true;
    }
    if (data.startsWith("wt:")) {
      await this.handleWorktreeCallback(cb, conv, messageId);
      return true;
    }
    return false;
  }

  private async handleApprovalCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const [, id, op] = (cb.data ?? "").split(":");
    const a = this.approvals.get(id);
    if (!a) {
      await this.h.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã hết hạn.");
      return;
    }
    this.approvals.delete(id);
    await this.h.tg.answerCallbackQuery(cb.id);
    const what = a.kind === "spawn" ? `tạo worker ${a.spawn?.name}` : `gửi việc cho ${a.send?.name}`;
    if (op === "no") {
      if (messageId) await this.h.tg.editMessageText(conv, messageId, `❌ Đã huỷ: ${esc(what)}.`).catch(() => {});
      this.queueReport(a.chat, `[approval #${id}] REJECTED by the user: ${what}. Do not retry it; ask the user what to do instead if needed.`);
      return;
    }
    if (op === "auto") this.h.st.set(a.chat, { auto: true });
    try {
      const result = await this.execApproved(a);
      if (messageId) {
        await this.h.tg
          .editMessageText(conv, messageId, `✅ Đã duyệt: ${esc(what)}.${op === "auto" ? "\n⚡ Auto đã bật — các lần sau không hỏi nữa (/auto off để tắt)." : ""}`)
          .catch(() => {});
      }
      this.queueReport(a.chat, `[approval #${id}] APPROVED by the user: ${result}.${op === "auto" ? " Auto mode is now on." : ""}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (messageId) await this.h.tg.editMessageText(conv, messageId, `⚠️ Duyệt nhưng thất bại: ${esc(msg)}`).catch(() => {});
      this.queueReport(a.chat, `[approval #${id}] approved but FAILED: ${msg}`);
    }
  }

  // ── worktree actions ──────────────────────────────────────────────────────
  private worktreeText(w: WorkerInfo): string {
    return [
      `🌿 <b>Worktree của ${esc(w.name)}</b>`,
      `nhánh <code>${esc(w.worktree?.branch ?? "")}</code> → base <code>${esc(w.worktree?.base ?? "")}</code>`,
      "Xem diff, merge về nhánh gốc, hoặc xoá worktree.",
    ].join("\n");
  }

  private worktreeKeyboard(w: WorkerInfo): Keyboard {
    return {
      inline_keyboard: [
        [
          { text: "📄 Diff", callback_data: `wt:${w.name}:diff` },
          { text: "🔀 Merge", callback_data: `wt:${w.name}:merge` },
        ],
        [{ text: "🗑 Xoá worktree", callback_data: `wt:${w.name}:rm` }],
      ],
    };
  }

  private async handleWorktreeCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const [, name, op] = (cb.data ?? "").split(":");
    const found = this.h.st.findWorker(conv, name);
    const w = found?.[1].worker;
    if (!found || !w?.worktree || !w.repoRoot) {
      await this.h.tg.answerCallbackQuery(cb.id, "Worktree không còn.");
      return;
    }
    const wt = w.worktree;
    if (BUSY.includes(w.status) && op !== "diff") {
      await this.h.tg.answerCallbackQuery(cb.id, "Worker đang chạy — /kill hoặc chờ xong rồi thử lại.");
      return;
    }
    await this.h.tg.answerCallbackQuery(cb.id);
    try {
      if (op === "diff") {
        await this.h.sendHtml(conv, `📄 <b>Diff ${esc(wt.branch)}</b> so với <code>${esc(wt.base)}</code>\n<pre>${esc(await diffSummary(wt))}</pre>`);
      } else if (op === "merge") {
        await this.h.sendHtml(conv, `🔀 ${esc(await mergeWorktree(w.repoRoot, wt, w.name))}`);
      } else if (op === "rm") {
        await this.h.sendHtml(conv, "⚠️ Xoá worktree sẽ <b>mất các thay đổi chưa merge</b> trong thư mục đó (nhánh chưa merge vẫn được giữ). Chắc chắn?", {
          reply_markup: { inline_keyboard: [[{ text: "🗑 Xoá thật", callback_data: `wt:${w.name}:rmok` }, { text: "Thôi", callback_data: `wt:${w.name}:keep` }]] },
        });
      } else if (op === "rmok") {
        const msg = await removeWorktree(w.repoRoot, wt);
        this.h.st.set(found[0], { worker: { ...w, worktree: undefined, updatedAt: Date.now() } });
        if (messageId) await this.h.tg.editMessageText(conv, messageId, `🗑 ${esc(msg)}`).catch(() => {});
      } else if (op === "keep" && messageId) {
        await this.h.tg.deleteMessage(conv, messageId);
      }
    } catch (e) {
      await this.h.sendHtml(conv, `❌ ${esc((e as Error).message)}`);
    }
  }

  // ── bridge tools (what the Manager can call) ──────────────────────────────
  private toolsFor(chat: ConvKey): BridgeTool[] {
    const auto = () => !!this.h.st.peek(chat)?.auto;
    const workerConv = (name: string): ConvKey => {
      const w = this.h.st.findWorker(chat, String(name ?? "").trim().toLowerCase());
      if (!w) throw new Error(`No worker named "${name}". Call list_workers.`);
      return w[0];
    };
    const relRoot = (p: string) => {
      const r = this.h.cfg.browseRoots.find((root) => p === root || p.startsWith(root + sep));
      return r ? `${p} (root ${r}${p === r ? "" : ", rel " + relative(r, p)})` : p;
    };
    return [
      {
        name: "list_directories",
        description:
          "List folders workers may run in. Without `path`, lists the allowed roots. With `path`, lists its subfolders " +
          "(one level), marking git repositories.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute folder to list" } } },
        run: async ({ path }) => {
          if (!path) return `Allowed roots:\n${this.h.cfg.browseRoots.map((r) => `- ${r}`).join("\n")}`;
          const dir = this.vetDirectory(String(path));
          const items = await listDirs(dir, false);
          const lines = await Promise.all(
            items.slice(0, 80).map(async (it) => `- ${it.path}${(await gitRoot(it.path)) === it.path ? "  [git]" : ""}`),
          );
          return `${relRoot(dir)}\n${lines.join("\n") || "(no subfolders)"}${items.length > 80 ? `\n… ${items.length - 80} more` : ""}`;
        },
      },
      {
        name: "list_workers",
        description: "List every worker of this chat: name, status, agent, directory, last result (short).",
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          const ws = this.workersOf(chat);
          if (!ws.length) return "No workers yet.";
          const busy = ws.filter(([, s]) => BUSY.includes(s.worker!.status)).length;
          return (
            `${ws.length} workers (${busy} busy, max ${this.h.cfg.maxWorkers}). Approval mode: ${auto() ? "auto" : "confirm"}.\n` +
            ws
              .map(([, s]) => {
                const w = s.worker!;
                return [
                  `## ${w.name} — ${w.status} (${s.agent ?? "build"}, ${w.writes ? "writes" : "read-only"})`,
                  `dir: ${s.directory}${w.worktree ? ` (worktree branch ${w.worktree.branch})` : ""}`,
                  w.lastResult ? `last result: ${trunc(w.lastResult, 400)}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
              })
              .join("\n\n")
          );
        },
      },
      {
        name: "spawn_worker",
        description:
          "Create a new worker (its own OpenCode session + Telegram topic) and start it on a task. The task must be " +
          "self-contained: the worker does not see this conversation. In confirm mode the user must approve first.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short kebab-case name, unique in this chat (a-z, 0-9, -; max 24)" },
            directory: { type: "string", description: "Absolute folder to work in (see list_directories)" },
            task: { type: "string", description: "Complete instructions: goal, context, constraints, definition of done" },
            agent: { type: "string", enum: ["build", "plan", "explore"], description: "build = edit code (default); plan = analysis only; explore = quick read-only lookup" },
            writes: { type: "boolean", description: "Whether the task may change files (default true for build)" },
          },
          required: ["name", "directory", "task"],
        },
        run: async (a) => {
          const spec: SpawnSpec = {
            name: String(a.name ?? ""),
            directory: this.vetDirectory(String(a.directory ?? "")),
            task: String(a.task ?? ""),
            agent: a.agent,
            writes: a.writes,
            spawnedBy: "manager",
          };
          if (!spec.task) throw new Error("task is required");
          if (this.h.st.findWorker(chat, spec.name.trim().toLowerCase())) throw new Error(`A worker named "${spec.name}" already exists — use send_to_worker or pick another name.`);
          this.takeBudget(chat);
          if (!auto()) {
            const id = await this.requestApproval({ chat, kind: "spawn", spawn: spec });
            return `PENDING: waiting for the user's approval (request #${id}). Do not call this again; you will get a [Bot event] with the decision.`;
          }
          const r = await this.spawn(chat, spec);
          return `Worker "${r.worker.name}" started in ${this.h.st.get(r.conv).directory}${r.worker.worktree ? ` (own worktree, branch ${r.worker.worktree.branch})` : ""}. You will get a [Bot event] when it finishes.`;
        },
      },
      {
        name: "send_to_worker",
        description: "Send a follow-up instruction to an existing worker (it keeps its own context). In confirm mode the user must approve first.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, message: { type: "string" } },
          required: ["name", "message"],
        },
        run: async (a) => {
          const conv = workerConv(a.name);
          const message = String(a.message ?? "");
          if (!message) throw new Error("message is required");
          const w = this.h.st.get(conv).worker!;
          if (BUSY.includes(w.status)) throw new Error(`Worker "${w.name}" is ${w.status}; wait for its report first.`);
          this.takeBudget(chat);
          if (!auto()) {
            const id = await this.requestApproval({ chat, kind: "send", send: { name: w.name, message } });
            return `PENDING: waiting for the user's approval (request #${id}). Do not call this again; you will get a [Bot event] with the decision.`;
          }
          await this.sendToWorker(conv, message);
          return `Sent to "${w.name}". You will get a [Bot event] when it finishes.`;
        },
      },
      {
        name: "get_worker_result",
        description: "Read a worker's latest full reply (up to ~6000 characters).",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        run: async (a) => {
          const s = this.h.st.get(workerConv(a.name));
          const r = s.sessionID ? await this.h.oc.latestReply(s.sessionID) : undefined;
          return r ? `${s.worker!.name} (${s.worker!.status}):\n${trunc(stripTags(r.text), 6000)}` : `${s.worker!.name} has no reply yet (${s.worker!.status}).`;
        },
      },
      {
        name: "stop_worker",
        description: "Interrupt a worker's current turn and mark it stopped.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        run: async (a) => {
          const conv = workerConv(a.name);
          await this.stopWorker(conv, false);
          await this.h.sendHtml(conv, "⏹ Manager đã dừng worker này.").catch(() => {});
          return `Stopped "${this.h.st.get(conv).worker!.name}".`;
        },
      },
    ];
  }
}
