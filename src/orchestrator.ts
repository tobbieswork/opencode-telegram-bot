import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Telegram, CallbackQuery, TOPIC_COLORS } from "./telegram.js";
import { OpenCodeCtl, userText, newMessageID } from "./opencode.js";
import { StateManager, ChatState, WorkerInfo, WorkerStatus } from "./state.js";
import { Config } from "./config.js";
import { ConvKey, chatOf, convKey, parseConv } from "./conv.js";
import { McpBridge, BridgeTool } from "./mcp-bridge.js";
import { addWorktree, diffSummary, gitRoot, gitStatusBrief, mergeWorktree, removeWorktree } from "./worktree.js";
import { listDirs } from "./fsbrowser.js";
import { selectPruneable, selectFinishedWorkers, WorkerConv } from "./prune.js";
import { spawnRequestBody } from "./reactions.js";
import { buildHandoffPrompt, followUpsFromMessages, respawnName, respawnNotice, shouldRespawnWorker } from "./recovery.js";
import { esc, trunc, timeAgo, stripTags } from "./format.js";
import { log, warn } from "./logger.js";
import { BUSY_REPLY_TEXT, NOTE_BUTTON_LABEL, noteCallbackData, BusyNoteStore } from "./notes.js";
import type { Schedule } from "./schedule.js";
import type { ScheduledExecution, ScheduledRun } from "./scheduled-run.js";
import type { SessionTopic, SessionTopics } from "./session-topics.js";
import type { SessionActivityLog, ActivitySource } from "./session-activity.js";

type Btn = { text: string; callback_data: string; url?: never } | { text: string; url: string; callback_data?: never };
type Keyboard = { inline_keyboard: Btn[][] };

/** What the orchestrator needs from the Bot (kept narrow on purpose). */
export interface Host {
  tg: Telegram;
  oc: OpenCodeCtl;
  st: StateManager;
  cfg: Config;
  topics?: SessionTopics;
  activity?: SessionActivityLog;
  stopTopicWork?: (conv: ConvKey) => Promise<boolean>;
  /** Shared retention for the busy-reply "Thêm vào note" button (owned by the Bot). */
  busyNotes: BusyNoteStore;
  sendHtml(conv: ConvKey, html: string, opts?: { reply_markup?: Keyboard }): Promise<void>;
  applyModelAndVariant(sessionID: string, state: ChatState): Promise<void>;
  startTyping(conv: ConvKey): void;
  /** Show the "⏳ Đang xử lý…" line for a manager turn (the manager uses promptManager, not runPrompt). */
  startWorking(conv: ConvKey): void;
  /** Remove the "⏳ Đang xử lý…" line for a manager turn (at turn end). */
  stopWorking(conv: ConvKey): void;
  /**
   * Start of a user-initiated manager turn: surface /note scratchpad notes into
   * the session's instruction entries (or retire last turn's). Best-effort.
   */
  prepareNotes?(conv: ConvKey, sid: string): Promise<void>;
  /**
   * A conv's Telegram topic is going away (deleted in the UI): fully stop any
   * in-flight turn for it (typing, activity, inflight abort + server interrupt)
   * and cancel its reminder nudges, so nothing keeps firing for a conversation
   * that no longer exists. Awaited before the conv is purged so the turn is
   * actually halted first.
   */
  onTopicGone?: (conv: ConvKey) => void | Promise<void>;
  /**
   * Test seam: override the worktree removal (defaults to the real git
   * removeWorktree). Lets the concurrency test count real purges deterministically.
   */
  removeWorktree?: (repoRoot: string, wt: { root: string; branch: string }) => Promise<string>;
  scheduledStop?: (conv: ConvKey) => Promise<boolean>;
  onScheduledFinished?: (conv: ConvKey) => Promise<void>;
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

Đồng bộ tên chủ đề theo tiêu đề OpenCode là chức năng của bot, không cần công cụ quản lý hay worker.
Hướng dẫn người dùng về General, mở /sessions, bấm “Đồng bộ tên chủ đề”, xem trước và xác nhận bật cho nhóm.
Không hứa rằng mở lại phiên quản lý sẽ tự bật chức năng đó. Nếu công cụ báo phiên quản lý chưa mở,
hướng dẫn người dùng về General và bấm “Mở phiên quản lý”; không tự gửi lại yêu cầu đã thất bại.

## How to work
1. Understand the request. If something important is ambiguous, ask ONE question with the \`question\` tool.
2. Pick the directory. Use list_directories; never guess paths.
3. Split the work into independent tasks that can run in parallel. A worker does NOT see this
   conversation, so each task must be self-contained: goal, relevant context, constraints, and what
   "done" means.
4. Choose the agent: "build" to change code, "plan" for analysis/design only, "explore" for quick
   read-only lookups. Set writes=false for tasks that must not change files.
5. Spawn the workers (short kebab-case names like "api-auth", "write-tests"). At most ${maxWorkers} may be busy at once.
    When the user asks to open a topic for an existing work session (they name a session id like ses_...),
    pass that session as "session_id" — the worker then gets its own Telegram topic
    bound to that session instead of a fresh one. Give it a task right away when there is one.
    Phiên quản lý có chủ đề riêng và không được chuyển thành worker. Mở phiên quản lý bằng nút trong General.
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
  spawnedBy: "user" | "manager" | "schedule";
  /**
   * When `false`, skip git worktree isolation entirely and run the worker in the
   * given directory as-is. Used for overflow respawns, which must stay in the
   * SAME worktree/directory as the dead worker (a fresh worktree cut from HEAD
   * would lose its uncommitted work).
   */
  isolate?: boolean;
  scheduledRunID?: string;
  /**
   * Bind the worker to an EXISTING OpenCode session instead of creating a new
   * one. Used when the user asks to open a worker topic for a session that
   * already exists (they name a `ses_…` id, or it's the Manager's own session):
   * the topic gets created and the worker is wired to that session, no fresh
   * OpenCode session is spawned.
   */
  sessionID?: string;
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
  /** Pending /prune confirmations: id → which convs to delete when the user taps "Xoá". */
  private prunePending = new Map<string, { chat: ConvKey; convs: ConvKey[] }>();
  private reports = new Map<ConvKey, string[]>();
  private reportTimers = new Map<ConvKey, ReturnType<typeof setTimeout>>();
  /** Remaining Manager dispatches per chat until the user speaks again. */
  private budget = new Map<ConvKey, number>();
  /** Worker convs whose turn-end we are already processing. */
  private finishing = new Set<ConvKey>();
  /**
   * Convs whose Telegram topic was deleted while a worker was still
   * running/waiting: the work is left alone, but the conv must be purged the
   * moment the worker ends (Telegram sends no further event — topic deletion
   * is only OBSERVED via send failures, which stop once the worker is done
   * and sends nothing more). See onTopicDeleted / onWorkerFinished.
   */
  private pendingTopicDelete = new Set<ConvKey>();
  /**
   * Convs whose purge is IN FLIGHT right now (see purgeConv). A dead topic
   * fires onTopicDeleted from several failing sends at once (the typing loop,
   * an edit, a report), and /prune's deleteForumTopic failure can fire
   * onTopicDeleted mid-loop — without this guard, those concurrent purges for
   * the same conv race on the worktree (git index.lock, noisy logs, a wrong
   * /prune count). Guarded per-conv so only one purge does the git work at a
   * time; cleared again once it finishes (on BOTH success and failure) so a
   * later send-failure or /prune can retry a failed purge.
   */
  private purging = new Set<ConvKey>();
  /**
   * Manager convs whose turn is currently running (a user prompt or a bot event
   * like a worker report). Set synchronously in promptManager so two rapid user
   * messages can't both get through; cleared by the session.execution.* terminal
   * event in onExecution. This restores the "⏳ still working" block for the
   * Manager chat, which the fire-and-forget prompt path otherwise skips.
   */
  private managerBusy = new Set<ConvKey>();
  /**
   * Chats whose bridge route is open. Opened BEFORE the bridge is registered:
   * OpenCode connects (initialize + tools/list) the moment it is added and marks
   * the server failed for good if that first call is refused.
   */
  private bridgeChats = new Set<ConvKey>();
  /** Xếp hàng thao tác mở/tắt của cùng nhóm để không tạo trùng phiên quản lý. */
  private managerOperations = new Map<ConvKey, Promise<void>>();
  /**
   * Names being spawned right now, per chat. Spawning awaits several calls
   * (git, Telegram, OpenCode) before the worker is saved; reserving the name
   * synchronously first makes concurrent spawns see each other, so neither the
   * name check nor the busy limit can be raced past.
   */
  private reserved = new Map<ConvKey, Set<string>>();
  private starting = new Map<ConvKey, Set<string>>();
  private scheduledSlots = new Map<string, { chat: ConvKey; name: string; conv?: ConvKey }>();
  private healTimer?: ReturnType<typeof setInterval>;
  private legacyScheduledNotices = new Set<string>();

  constructor(private h: Host) {}

  shutdown(): void {
    if (this.healTimer) clearInterval(this.healTimer);
    this.healTimer = undefined;
    for (const timer of this.reportTimers.values()) clearTimeout(timer);
    this.reportTimers.clear();
    this.bridge?.close();
    this.bridge = undefined;
  }

  private managerEntry(chat: ConvKey): [ConvKey, ChatState] | undefined {
    if (!this.h.topics?.enabled(chat)) {
      const state = this.h.st.peek(chat);
      return state?.manager ? [chat, state] : undefined;
    }
    return this.h.st.convsOfChat(chat).find(([conv, state]) => state.manager && this.h.topics?.canPrompt(conv));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /** On every (re)connect to OpenCode: re-register the bridge for chats with a Manager (it is runtime-only). */
  async onConnect(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (s.manager && s.sessionID) {
        const directory = this.h.topics?.forTopic(conv)?.directory ?? s.directory;
        await this.ensureManagerTooling(chatOf(conv), directory).catch((e) => warn("manager tooling:", e?.message));
      }
    }
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (s.worker?.spawnedBy !== "schedule" || !BUSY.includes(s.worker.status) || !s.sessionID ||
        this.ownsScheduledConv(conv) || this.legacyScheduledNotices.has(s.sessionID)) continue;
      await this.h.sendHtml(conv, "⚠️ Lượt chạy lịch từ phiên bản cũ chưa có deadline khôi phục được. Tiếp tục theo dõi và tính slot; không tự dừng hoặc cấp thời hạn mới. Dùng /stop nếu cần dừng.").catch(() => {});
      this.legacyScheduledNotices.add(s.sessionID);
    }
    await this.healWorkers();
    // After healWorkers has settled any stuck "running" workers to their real
    // status, re-purge convs whose topic was deleted but whose purge didn't
    // finish before the crash/restart (persisted topicDeletedPending marker).
    await this.reapPendingTopicDeletes();
    if (!this.healTimer) {
      // Events can also be lost while connected (a dropped frame, a server
      // hiccup); a slow sweep keeps a missed turn-end from pinning a worker
      // as busy forever.
      this.healTimer = setInterval(() => void this.healWorkers().catch((e) => warn("heal workers:", e?.message)), 60_000);
      (this.healTimer as any).unref?.();
    }
  }

  /**
   * Worker status only moves on live events, so after a restart or a dropped
   * stream a worker can look busy long after its turn ended. Ask the server
   * for the truth and settle any busy worker whose session is actually idle.
   */
  async healWorkers(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      const w = s.worker;
      if (!w || !s.sessionID || !BUSY.includes(w.status)) continue;
      if (this.ownsScheduledConv(conv)) continue;
      const state = await this.h.oc.sessionState(s.sessionID).catch(() => undefined);
      if (!state || state.busy) continue;
      const status: WorkerStatus = state.outcome === "succeeded" ? "done" : state.outcome === "failed" ? "failed" : "stopped";
      log(`[chat ${chatOf(conv)}] worker ${w.name} ended while unobserved — ${status}`);
      await this.onWorkerFinished(conv, status);
    }
  }

  /**
   * Startup sweep for deferred topic-delete purges that didn't finish before a
   * crash/restart. The in-memory `pendingTopicDelete` flag is lost on restart,
   * but the persisted `topicDeletedPending` marker survives in state.json. For
   * each such conv:
   *  - worker no longer running/waiting (or no worker) → purge it now;
   *  - worker still running/waiting → re-arm the in-memory deferral so the
   *    (post-restart) turn-end triggers the purge via onWorkerFinished.
   * Runs AFTER healWorkers, so a worker that only LOOKS busy (its terminal
   * event was lost) has already been settled to done/failed/stopped and is
   * purged here rather than re-armed.
   */
  async reapPendingTopicDeletes(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (!s.topicDeletedPending) continue;
      const w = s.worker;
      if (w && (w.status === "running" || w.status === "waiting")) {
        // Still live after the restart: re-arm so its turn-end purges it.
        this.pendingTopicDelete.add(conv);
        log(`reapPendingTopicDeletes (${conv}): worker ${w.name} still running — re-arming deferred purge`);
        continue;
      }
      const ok = await this.purgeConv(conv);
      if (ok) log(`reapPendingTopicDeletes (${conv}): purged topic-deleted conv after restart`);
      else warn(`reapPendingTopicDeletes (${conv}): purge failed — retry next startup or via /prune`);
    }
  }

  /**
   * Retroactive auto-close at startup: a worker that finished before auto-close
   * existed (or while the service was down/restarting) never got its topic
   * closed and now sits open forever. Close the topic of every finished worker
   * (done/failed/stopped); closing an already-closed topic is a no-op, so this
   * is safe to re-run on every restart. Best-effort — it never fails startup.
   * Returns the number of topics attempted.
   */
  async closeFinishedTopicsAtStartup(): Promise<number> {
    if (!this.h.cfg.autoClose) return 0;
    try {
      const items: WorkerConv[] = [];
      for (const [conv, s] of Object.entries(this.h.st.all())) {
        if (s.worker && !this.h.topics?.enabled(conv)) items.push({ conv, status: s.worker.status });
      }
      const targets = selectFinishedWorkers(items);
      for (const conv of targets) await this.h.tg.closeForumTopic(conv).catch(() => {});
      if (targets.length) log(`startup: retroactively closed ${targets.length} finished worker topics`);
      return targets.length;
    } catch (e) {
      warn("startup topic close:", e instanceof Error ? e.message : String(e));
      return 0;
    }
  }

  private async ensureBridge(): Promise<McpBridge> {
    if (this.bridge) return this.bridge;
    const b = new McpBridge((route) => (this.bridgeChats.has(route) ? this.toolsFor(route).map((tool) => ({ ...tool,
      run: async (input) => {
        if (this.h.topics?.enabled(route) && !this.managerEntry(route)) {
          throw new Error("Phiên quản lý chưa mở hoặc chưa xác minh được. Về General và bấm “Mở phiên quản lý”. Không tự gửi lại yêu cầu. Để đồng bộ tên chủ đề, dùng nút trong /sessions; không cần phiên quản lý.");
        }
        return tool.run(input);
      } })) : undefined), BRIDGE_NAME);
    await b.listen(this.h.cfg.bridgePort);
    this.bridge = b;
    return b;
  }

  private managerDir(chat: ConvKey): string {
    return join(this.h.cfg.managerDir, chat);
  }

  /** Write the Manager agent into its own directory and register the bridge for that directory only. */
  private async ensureManagerTooling(chat: ConvKey, dir = this.managerDir(chat)): Promise<string> {
    mkdirSync(join(dir, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "agents", `${MANAGER_AGENT}.md`), MANAGER_PROMPT(this.h.cfg.maxWorkers));
    const b = await this.ensureBridge();
    this.bridgeChats.add(chat);
    await this.h.oc.addRemoteMcp(dir, BRIDGE_NAME, b.url(chat), { Authorization: `Bearer ${b.token}` });
    // Connecting is asynchronous on the server; give it a moment, then insist.
    let st = { status: "pending" } as { status: string; error?: string };
    for (let i = 0; i < 10 && st.status !== "connected" && st.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      st = await this.h.oc.mcpStatus(dir, BRIDGE_NAME);
    }
    if (st.status !== "connected") throw new Error(`Bridge tool chưa kết nối được (${st.status}${st.error ? `: ${st.error}` : ""}).`);
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
      case "/prune":
        await this.cmdPrune(conv, arg);
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
    const head = `📋 <b>Workers (${workers.length})</b> · manager: ${this.managerEntry(chatOf(conv)) ? "on" : "off"} · auto: ${top.auto ? "on" : "off"}`;
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

  /**
   * `/kill [tên]` — stop a worker. Without a valid target (and not inside a
   * worker's own topic) the user gets a button picker of the chat's workers.
   */
  private async cmdKill(conv: ConvKey, arg: string): Promise<void> {
    const name = arg.trim();
    const target = name ? this.h.st.findWorker(conv, name)?.[0] : this.h.st.peek(conv)?.worker ? conv : undefined;
    if (target) {
      const msg = await this.stopWorker(target, true);
      await this.h.sendHtml(conv, msg);
      return;
    }
    await this.showKillPicker(conv, name ? `❌ Không có worker <code>${esc(name)}</code>` : undefined);
  }

  /** The /kill picker card: one stop-button per worker + a hint line. */
  private async showKillPicker(conv: ConvKey, errorNote?: string): Promise<void> {
    const workers = this.workersOf(conv).map(([, s]) => s.worker!);
    if (!workers.length) {
      await this.h.sendHtml(conv, "Không có worker nào — /spawn để tạo.");
      return;
    }
    const rows: Btn[][] = workers.map((w) => [{ text: `${ICON[w.status]} ${w.name}`, callback_data: `kill:${w.name}` }]);
    rows.push([{ text: "❌ Đóng", callback_data: "kill:close" }]);
    await this.h.sendHtml(
      conv,
      [errorNote ?? "❓ <b>/kill</b> cần tên worker", "Bấm để dừng worker:", "Hoặc gửi: <code>/kill &lt;tên&gt;</code>"].join("\n"),
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  /**
   * Handle a tap on the /kill picker (data = `kill:<name|close>`). Public because
   * it is dispatched from Bot.handleCallback, like the other orchestrator callbacks.
   */
  async handleKillCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const name = (cb.data ?? "").slice("kill:".length);
    if (name === "close") {
      await this.h.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.h.tg.deleteMessage(conv, messageId).catch(() => {});
      return;
    }
    const found = this.h.st.findWorker(chatOf(conv), name);
    if (!found) {
      await this.h.tg.answerCallbackQuery(cb.id, "Worker không còn tồn tại.");
      if (messageId) await this.h.tg.editMessageText(conv, messageId, "⌛ Worker không còn tồn tại — /board để xem lại.").catch(() => {});
      return;
    }
    await this.h.tg.answerCallbackQuery(cb.id, `Dừng ${name}`);
    const msg = await this.stopWorker(found[0], true);
    if (messageId) await this.h.tg.editMessageText(conv, messageId, msg).catch(() => {});
  }

  private async cmdStopAll(conv: ConvKey): Promise<void> {
    const busy = this.workersOf(conv).filter(([, s]) => BUSY.includes(s.worker!.status));
    for (const [k] of busy) await this.stopWorker(k, false);
    await this.h.sendHtml(conv, busy.length ? `⏹ Đã gửi yêu cầu dừng ${busy.length} worker; lượt chạy lịch giữ slot đến khi xác nhận kết thúc.` : "Không có worker nào đang chạy.");
  }

  private async cmdManager(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    if (conv !== chat) {
      await this.h.sendHtml(conv, "ℹ️ Bật Manager ở khung chat chính (General), không phải trong topic.");
      return;
    }
    const want = arg.trim().toLowerCase();
    const top = this.h.st.get(chat);
    if (this.h.topics?.enabled(chat)) {
      if (want === "") { await this.showManagerEntry(chat); return; }
      if (!["on", "off"].includes(want)) { await this.h.sendHtml(conv, "Dùng <code>/manager on|off</code> trong General."); return; }
      const task = (this.managerOperations.get(chat) ?? Promise.resolve()).catch(() => {}).then(() => this.manageTopicManager(chat, want));
      this.managerOperations.set(chat, task);
      try { await task; }
      finally { if (this.managerOperations.get(chat) === task) this.managerOperations.delete(chat); }
      return;
    }
    if (want === "off") {
      if (!top.manager) return void (await this.h.sendHtml(conv, "Manager đang tắt."));
      if (top.sessionID) await this.h.oc.interrupt(top.sessionID).catch(() => {});
      this.dropManagerTurn(conv); // the manager's session is being dropped — a late terminal event can't clear the flag
      this.bridgeChats.delete(chat);
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

  async showManagerEntry(chat: ConvKey): Promise<void> {
    await this.h.sendHtml(chat, [
      "General chỉ dùng để quản lý. Gửi yêu cầu làm việc trong chủ đề của phiên tương ứng.",
      "Bấm nút bên dưới để mở phiên quản lý: bot dùng lại phiên hiện có, khôi phục phiên đã đóng hoặc tạo khi chưa có.",
      "Bot không tự gửi lại yêu cầu bạn vừa nhắn. Để đồng bộ tên chủ đề theo tiêu đề OpenCode, dùng nút trong /sessions; không cần mở phiên quản lý.",
    ].join("\n"), { reply_markup: { inline_keyboard: [[{ text: "Mở phiên quản lý", callback_data: "mgr:open" }]] } });
  }

  private async manageTopicManager(chat: ConvKey, want: string): Promise<void> {
    const topics = this.h.topics!;
    try {
      const managers = this.h.st.convsOfChat(chat).filter(([, state]) => state.manager && state.sessionID);
      const links = topics.list(chat).filter((link) => link.operationID === `manager:${chat}` || managers.some(([, state]) =>
        link.sessionID === state.sessionID || link.operationID === `attach:${state.sessionID}`));
      if (links.length > 1 || managers.length > 1) throw new Error("Có nhiều liên kết phiên quản lý. Kiểm tra bằng /sessions; không tự chọn hay tạo phiên thay thế.");
      const link = links[0];
      if (link && managers.some(([, state]) => state.sessionID !== link.sessionID)) {
        throw new Error("Liên kết phiên quản lý xung đột. Kiểm tra bằng /sessions; không tạo phiên thay thế.");
      }
      if (want === "off") {
        if (!link) {
          await this.h.sendHtml(chat, "Chưa có chủ đề quản lý để đóng. Phiên cũ, nếu có, được giữ nguyên.");
          return;
        }
        const closed = await topics.close(chat, link.id);
        if (closed.phase === "closed") this.bridgeChats.delete(chat);
        await this.h.sendHtml(chat, `Phiên quản lý: ${esc(closed.phase)}. Phiên và lịch sử được giữ nguyên.`,
          { reply_markup: { inline_keyboard: [[{ text: "Mở phiên quản lý", callback_data: "mgr:open" }]] } });
        return;
      }
      let opened: SessionTopic;
      if (link) {
        if (!["open", "closed"].includes(link.phase)) {
          throw new Error(`Phiên quản lý đang ở trạng thái ${link.phase}. Kiểm tra bằng /sessions hoặc /sync; không tạo phiên thay thế.`);
        }
        await this.ensureManagerTooling(chat, link.directory);
        opened = await topics.open(chat, link.id);
      } else if (managers.length) {
        const [from, state] = managers[0];
        const owners = Object.entries(this.h.st.all()).filter(([, value]) => value.sessionID === state.sessionID);
        if (owners.length !== 1) throw new Error("Phiên quản lý có nhiều nơi sở hữu. Kiểm tra liên kết trước khi chuyển; không tạo phiên thay thế.");
        const session = await this.h.oc.topicSession(state.sessionID!);
        if (session.id !== state.sessionID) throw new Error("Danh tính phiên quản lý không khớp. Giữ nguyên dữ liệu để kiểm tra.");
        if (this.managerBusy.has(from) || session.busy || !session.terminal) {
          throw new Error("Phiên quản lý cũ đang chạy hoặc chưa xác nhận kết thúc. Hãy chờ rồi bấm lại; bot không dừng hay chuyển phiên đang chạy.");
        }
        if (session.archived) throw new Error("Phiên quản lý cũ đã lưu trữ. Mở lại trong OpenCode trước khi chuyển sang chủ đề; không tạo phiên thay thế.");
        await this.ensureManagerTooling(chat, session.directory);
        opened = await topics.attach(chat, session.id);
        opened = await topics.open(chat, opened.id);
      } else {
        if (this.h.st.convsOfChat(chat).some(([, state]) => state.manager)) {
          throw new Error("Dữ liệu phiên quản lý cũ thiếu mã phiên. Kiểm tra trạng thái đã lưu; không tạo phiên thay thế.");
        }
        const dir = await this.ensureManagerTooling(chat);
        const top = this.h.st.get(chat);
        opened = await topics.create({ chat, directory: dir, title: "Quản lý", operationID: `manager:${chat}`,
          agent: MANAGER_AGENT, metadata: { tgRole: "manager" },
          state: { manager: true, guided: true, model: top.model, variant: top.variant } });
      }
      if (opened.phase !== "open" || !opened.conv || this.managerEntry(chat)?.[0] !== opened.conv) {
        throw new Error(`Chưa xác nhận mở phiên quản lý (${opened.phase}). Kiểm tra bằng /sessions hoặc /sync. Phiên và lịch sử được giữ nguyên.`);
      }
      const { chatId, threadId } = parseConv(opened.conv);
      await this.h.sendHtml(chat, "Phiên quản lý đã mở. Vào chủ đề bên dưới để gửi yêu cầu; các phê duyệt vẫn ở General. Bot không tự gửi lại yêu cầu cũ.",
        { reply_markup: { inline_keyboard: [[{ text: "Vào chủ đề quản lý", url: `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${threadId}` }]] } });
    } catch (error) {
      await this.h.sendHtml(chat, `Chưa mở được phiên quản lý: ${esc((error as Error).message)}`,
        { reply_markup: { inline_keyboard: [[{ text: "Mở phiên quản lý", callback_data: "mgr:open" }]] } });
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

  /**
   * `/prune [số_ngày]` — offer to delete finished worker topics that haven't
   * been touched for N days (default 7). The user confirms with a button
   * before anything is deleted; the list card stays valid until tapped.
   */
  private async cmdPrune(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    if (conv !== chat) {
      await this.h.sendHtml(conv, "ℹ️ Dùng /prune ở khung chat chính (General), không phải trong topic.");
      return;
    }
    const n = parseInt(arg, 10);
    const days = Number.isInteger(n) && n > 0 ? n : 7;
    const now = Date.now();
    const items = this.workersOf(chat).filter(([key]) => !this.h.topics?.forTopic(key))
      .map(([k, s]) => ({ conv: k, status: s.worker!.status, updatedAt: s.worker!.updatedAt }));
    const convs = selectPruneable(items, now, days * 86_400_000);
    if (!convs.length) {
      await this.h.sendHtml(conv, "Không có topic worker cũ nào để dọn.");
      return;
    }
    const id = randomBytes(5).toString("hex");
    this.prunePending.set(id, { chat, convs });
    const lines = [`🧹 <b>Dọn ${convs.length} topic</b> cũ hơn ${days} ngày:`];
    for (const k of convs) {
      const w = this.h.st.peek(k)?.worker;
      if (!w) continue;
      lines.push(`${ICON[w.status]} <b>${esc(w.name)}</b> · ${w.status} · ${timeAgo(w.updatedAt)}`);
    }
    lines.push("", "<i>Bấm Xoá để xoá topic + state + session (không ảnh hưởng worker đang chạy).</i>");
    await this.h.sendHtml(conv, lines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "🗑 Xoá", callback_data: `prune:${id}` }]] },
    });
  }

  // ── workers ───────────────────────────────────────────────────────────────
  private workersOf(conv: ConvKey): [ConvKey, ChatState][] {
    return this.h.st.convsOfChat(conv).filter(([, s]) => s.worker);
  }

  private topicName(w: WorkerInfo): string {
    return `${ICON[w.status]} ${w.name}`;
  }

  private async dispatchObserved(conv: ConvKey, sessionID: string, text: string, source: ActivitySource, originalText = text): Promise<string> {
    const messageID = newMessageID();
    try { this.h.activity?.begin(conv, { sessionID, inputID: messageID, text: originalText, source }); }
    catch (error) { warn("Không lưu được bản ghi hoạt động:", (error as Error).message); }
    return this.h.oc.prompt(sessionID, text, { messageID });
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
    chat = chatOf(chat);
    const name = spec.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(`Tên worker không hợp lệ "${spec.name}" — dùng a-z, 0-9, dấu gạch ngang, tối đa 24 ký tự.`);
    const pending = this.reserved.get(chat) ?? new Set<string>();
    if (this.h.st.findWorker(chat, name) || pending.has(name)) throw new Error(`Đã có worker tên "${name}". Hãy chọn tên khác.`);
    // Only spawns that will start working (have a task) take a busy slot.
    if (spec.task) this.assertCapacity(chat);
    if (spec.spawnedBy !== "schedule" && [...this.scheduledSlots.values()].some((slot) => slot.chat === chat && slot.name === name)) {
      throw new Error("Tên worker đang được giữ cho một lượt chạy lịch.");
    }
    pending.add(name);
    this.reserved.set(chat, pending);
    if (spec.task) {
      const starts = this.starting.get(chat) ?? new Set<string>();
      starts.add(name);
      this.starting.set(chat, starts);
    }
    try {
      return await this.spawnReserved(chat, name, spec);
    } finally {
      pending.delete(name);
      if (!pending.size) this.reserved.delete(chat);
      this.starting.get(chat)?.delete(name);
      if (!this.starting.get(chat)?.size) this.starting.delete(chat);
    }
  }

  /** Busy workers of a chat, counting spawns in flight. */
  private busyCount(chat: ConvKey, except?: ConvKey): number {
    chat = chatOf(chat);
    const slots = [...this.scheduledSlots.values()].filter((slot) => slot.chat === chat);
    const starts = this.starting.get(chat);
    const busy = this.workersOf(chat).filter(([k, s]) => k !== except && BUSY.includes(s.worker!.status) &&
      !starts?.has(s.worker!.name) && !slots.some((slot) => slot.name === s.worker!.name)).length;
    return busy + (starts?.size ?? 0) + slots.length;
  }

  private assertCapacity(chat: ConvKey, except?: ConvKey): void {
    const busy = this.busyCount(chat, except);
    if (busy >= this.h.cfg.maxWorkers) {
      throw new Error(`Đã có ${busy} worker đang chạy (tối đa ${this.h.cfg.maxWorkers}). Chờ bớt hoặc /kill bớt.`);
    }
  }

  private async spawnReserved(chat: ConvKey, name: string, spec: SpawnSpec): Promise<{ conv: ConvKey; worker: WorkerInfo }> {
    let directory = this.vetDirectory(spec.directory);
    const agent = spec.agent && ["build", "plan", "explore", "general"].includes(spec.agent) ? spec.agent : "build";
    const writes = spec.writes ?? agent === "build";

    // Isolation: a writer that would share a repo checkout with another busy
    // writer gets its own worktree + branch instead. A respawn (isolate === false)
    // skips this entirely — it must reuse the dead worker's directory/worktree as-is.
    // A spawn bound to an existing session (sessionID) also skips isolation: the
    // session already lives somewhere and must not be moved into a worktree.
    let worktree: WorkerInfo["worktree"];
    let repoRoot: string | undefined;
    if (spec.isolate !== false && !spec.sessionID && writes && this.h.cfg.worktreeMode !== "off") {
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
    if (this.h.topics?.enabled(chat)) {
      const top = this.h.st.get(chat);
      const link = spec.sessionID ? await this.h.topics.attach(chat, spec.sessionID) :
        await this.h.topics.create({ chat, directory, title: name, agent,
          operationID: spec.scheduledRunID ? `scheduled:${spec.scheduledRunID}` : undefined,
          metadata: { tgWorker: name, ...(spec.scheduledRunID ? { tgScheduledRun: spec.scheduledRunID } : {}) },
          state: { model: top.model, variant: top.variant, guided: true, worker } });
      if (!link.conv || !link.sessionID || link.phase !== "open") throw new Error("Worker topic is not ready; inspect it in General.");
      const bound = this.h.st.get(link.conv);
      if (bound.manager) throw new Error("The Manager session already has its own topic; it cannot become a worker.");
      if (spec.sessionID && bound.worker && BUSY.includes(bound.worker.status)) throw new Error("The existing session is busy.");
      if (!bound.worker) this.h.st.setRequired(link.conv, { worker });
      await this.h.sendHtml(link.conv, `Worker <b>${esc(bound.worker?.name ?? name)}</b> · ${esc(agent)}\n<code>${esc(directory)}</code>`).catch(() => {});
      if (spec.task) {
        this.setStatus(link.conv, "running");
        await this.dispatchObserved(link.conv, link.sessionID, `${workerPreamble(name)}\n\n${spec.task}`, spec.spawnedBy === "schedule" ? "schedule" : spec.spawnedBy === "manager" ? "manager" : "topic", spec.task);
        this.h.startTyping(link.conv);
      }
      return { conv: link.conv, worker: this.h.st.get(link.conv).worker! };
    }
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
    // Bind to an existing session when the spawn asks for one (a worker topic
    // opened for a session that already exists); otherwise create a fresh one.
    let sessionID: string;
    let createdSession = false;
    try {
      if (spec.sessionID) {
        sessionID = spec.sessionID;
        createdSession = false;
      } else {
        createdSession = true;
        sessionID = await this.h.oc.createSession(directory, {
          title: `tg:${name}`,
          agent,
          metadata: { tgWorker: name, tgChat: chat, ...(spec.scheduledRunID ? { tgScheduledRun: spec.scheduledRunID } : {}) },
        });
      }
    } catch (e) {
      // Nothing was saved yet (or the session was reused, so there is nothing to
      // orphan): undo the topic so a retry with the same name works and nothing
      // is left orphaned.
      await this.h.tg.deleteForumTopic(conv).catch(() => this.h.tg.editForumTopic(conv, `❌ ${name}`).catch(() => {}));
      if (createdSession && worktree && repoRoot) await removeWorktree(repoRoot, worktree).catch(() => {});
      throw e;
    }
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
      await this.dispatchObserved(conv, sessionID, `${workerPreamble(name)}\n\n${spec.task}`, spec.spawnedBy === "schedule" ? "schedule" : spec.spawnedBy === "manager" ? "manager" : "topic", spec.task);
      this.h.startTyping(conv);
    }
    return { conv, worker };
  }

  /** Follow-up instruction to an existing worker (non-blocking). */
  private async sendToWorker(conv: ConvKey, message: string): Promise<void> {
    const s = this.h.st.get(conv);
    if (!s.sessionID || !s.worker) throw new Error("Worker không còn session.");
    if (s.worker.status === "stopped") throw new Error(`Worker "${s.worker.name}" đã bị dừng.`);
    // Checked here, not only in the tool, so an approval tapped later can't
    // start a second turn on a busy worker or exceed the busy limit.
    if (BUSY.includes(s.worker.status)) throw new Error(`Worker "${s.worker.name}" đang ${s.worker.status}; chờ nó xong đã.`);
    const release = this.beginWorkerTurn(conv);
    try {
      await this.h.sendHtml(conv, `📨 <b>Manager:</b> ${esc(trunc(message, 1500))}`).catch(() => {});
      await this.dispatchObserved(conv, s.sessionID, message, "manager");
      this.h.startTyping(conv);
    } finally { release?.(); }
  }

  beginWorkerTurn(conv: ConvKey): (() => void) | undefined {
    if (this.h.topics?.enabled(conv) && !this.h.topics.canPrompt(conv)) throw new Error("Session/topic is not open; reconcile it from General.");
    if (this.ownsScheduledConv(conv)) throw new Error("Worker đang thuộc một lượt chạy lịch chưa kết thúc; chờ xác nhận hoặc dùng /stop.");
    const w = this.topicWorker(conv);
    if (!w) return undefined;
    const chat = chatOf(conv);
    if (BUSY.includes(w.status) || this.starting.get(chat)?.has(w.name)) throw new Error("Worker đang bận; chờ lượt hiện tại kết thúc.");
    this.assertCapacity(chat, conv);
    const starts = this.starting.get(chat) ?? new Set<string>();
    starts.add(w.name);
    this.starting.set(chat, starts);
    this.setStatus(conv, "running");
    return () => {
      starts.delete(w.name);
      if (!starts.size) this.starting.delete(chat);
    };
  }

  private topicWorker(conv: ConvKey): WorkerInfo | undefined {
    const state = this.h.st.peek(conv);
    if (state?.worker) return state.worker;
    const link = this.h.topics?.forTopic(conv);
    if (!link || !state || state.manager) return undefined;
    const now = Date.now();
    const worker: WorkerInfo = { name: `session-${link.id.slice(0, 12)}`, status: "idle", spawnedBy: "user", createdAt: now, updatedAt: now };
    this.h.st.setRequired(conv, { worker });
    return worker;
  }

  private async stopWorker(conv: ConvKey, close: boolean): Promise<string> {
    if (this.h.topics?.forTopic(conv)) {
      const confirmed = await this.h.stopTopicWork?.(conv);
      if (confirmed) this.setStatus(conv, "stopped");
      return confirmed ? "Work stopped. Its session and topic remain open." : "Stop is not confirmed; the worker keeps its capacity slot.";
    }
    if (this.h.scheduledStop && await this.h.scheduledStop(conv)) {
      return "⏹ Đã ghi nhận yêu cầu dừng lượt chạy lịch; đang xác minh execution, chưa nhả slot khi chưa xác nhận kết thúc.";
    }
    const s = this.h.st.get(conv);
    const w = s.worker!;
    // Mark first: the interrupt fires session.execution.interrupted while the
    // call is still in flight, and that must not read as a normal finish (it
    // would be reported to the Manager, which might restart the work).
    this.setStatus(conv, "stopped");
    if (s.sessionID) await this.h.oc.interrupt(s.sessionID).catch(() => {});
    if (close) await this.h.tg.closeForumTopic(conv);
    return `⏹ Đã dừng worker <b>${esc(w.name)}</b>.${w.worktree ? " Worktree vẫn giữ — dùng /wt trong topic để xem diff / merge / xoá." : ""}`;
  }

  /** Is a worker of this name under the chat currently running/waiting? (scheduler's busy/skip check) */
  workerBusyByName(chat: ConvKey, name: string): boolean {
    const found = this.h.st.findWorker(chat, name);
    return !!found && BUSY.includes(found[1].worker!.status);
  }

  ownsScheduledConv(conv: ConvKey): boolean {
    const worker = this.h.st.peek(conv)?.worker;
    return [...this.scheduledSlots.values()].some((slot) => slot.conv === conv || (worker && slot.chat === chatOf(conv) && slot.name === worker.name));
  }

  scheduledExecution(): ScheduledExecution {
    return {
      matches: (run, conv) => {
        const w = this.h.st.peek(conv)?.worker;
        return this.scheduledSlots.get(run.id)?.conv === conv ||
          (chatOf(conv) === chatOf(run.schedule.conv) && w?.name === this.scheduledWorkerName(run.schedule, run.id));
      },
      ready: (sch) => this.h.oc.scheduledReady(this.h.st.findWorker(sch.conv, "sch-" + sch.id)?.[1].sessionID, this.vetDirectory(sch.dir)),
      claim: (sch, id) => {
        const name = this.scheduledWorkerName(sch, id);
        if (this.workerBusyByName(sch.conv, name)) throw new Error("Worker đang bận.");
        if ([...this.scheduledSlots.values()].some((slot) => slot.chat === chatOf(sch.conv) && slot.name === name)) {
          throw new Error("Lượt trước vẫn đang hoàn tất cleanup.");
        }
        this.assertCapacity(chatOf(sch.conv));
        this.scheduledSlots.set(id, { chat: chatOf(sch.conv), name });
      },
      restore: (run) => { this.scheduledSlots.set(run.id, { chat: chatOf(run.schedule.conv),
        name: (run.binding && this.h.st.peek(run.binding.conv)?.worker?.name) || this.scheduledWorkerName(run.schedule, run.id), conv: run.binding?.conv }); },
      release: (run) => { this.scheduledSlots.delete(run.id); },
      prepare: (run) => this.prepareScheduled(run),
      submit: async (run) => {
        if (this.h.st.peek(run.binding!.conv)?.sessionID !== run.binding!.sessionID) throw new Error("Session không còn thuộc lượt chạy.");
        this.setStatus(run.binding!.conv, "running");
        try { this.h.activity?.begin(run.binding!.conv, { sessionID: run.binding!.sessionID, inputID: run.messageID, text: run.schedule.prompt, source: "schedule" }); }
        catch (error) { warn("Không lưu được bản ghi lượt lịch:", (error as Error).message); }
        await this.h.oc.submitScheduled(run, workerPreamble("sch-" + run.schedule.id) + "\n\n" + run.schedule.prompt);
        this.h.startTyping(run.binding!.conv);
      },
      inspect: (run) => this.h.oc.observeScheduled(run),
      stop: (run, observation) => this.h.oc.scheduledObserver().stop(run, observation),
      settled: async (run) => {
        const b = run.binding;
        if (!b || this.h.st.peek(b.conv)?.sessionID !== b.sessionID) return;
        const status = run.phase === "succeeded" ? "done" : run.phase === "failed" ? "failed" : "stopped";
        await this.onWorkerFinished(b.conv, status, undefined, b.sessionID);
        if (this.h.st.peek(b.conv)?.sessionID === b.sessionID) await this.h.onScheduledFinished?.(b.conv);
      },
    };
  }

  private scheduledWorkerName(schedule: Schedule, runID: string): string {
    return this.h.topics?.enabled(schedule.conv) ? `sch-${schedule.id.slice(0, 8)}-${runID.slice(0, 8)}` : `sch-${schedule.id}`;
  }

  private async prepareScheduled(run: ScheduledRun) {
    const sch = run.schedule;
    const name = this.scheduledWorkerName(sch, run.id);
    this.vetDirectory(sch.dir);
    if (this.h.topics?.enabled(sch.conv)) {
      const spawned = await this.spawn(chatOf(sch.conv), { name, directory: sch.dir, agent: sch.agent,
        spawnedBy: "schedule", scheduledRunID: run.id });
      const sid = this.h.st.get(spawned.conv).sessionID!;
      this.scheduledSlots.get(run.id)!.conv = spawned.conv;
      return this.h.oc.scheduledBinding(run, spawned.conv, sid);
    }
    let existing = this.h.st.findWorker(sch.conv, name);
    let sid: string;
    if (!existing) {
      const spawned = await this.spawn(sch.conv, { name, directory: sch.dir, agent: sch.agent, spawnedBy: "schedule", scheduledRunID: run.id });
      existing = [spawned.conv, this.h.st.get(spawned.conv)];
      sid = existing[1].sessionID!;
    } else {
      sid = await this.h.oc.createSession(sch.dir, { title: "tg:" + name, agent: sch.agent,
        metadata: { tgWorker: name, tgChat: chatOf(sch.conv), tgScheduledRun: run.id } });
      try {
        if (existing[1].sessionID) await this.h.oc.retireScheduledSession(existing[1].sessionID);
      } catch (e) {
        await this.h.oc.removeSession(sid).catch(() => {});
        throw e;
      }
    }
    const [conv, state] = existing;
    this.scheduledSlots.get(run.id)!.conv = conv;
    try {
      this.h.st.setRequired(conv, { sessionID: sid, directory: sch.dir, agent: sch.agent, guided: true, lastRelayedTime: 1,
        worker: { ...state.worker!, task: sch.prompt, status: "running", updatedAt: Date.now() } });
      await this.h.applyModelAndVariant(sid, this.h.st.get(conv));
      return await this.h.oc.scheduledBinding(run, conv, sid);
    } catch (e) {
      if (this.h.st.peek(conv)?.sessionID === sid) this.setStatus(conv, "failed");
      throw e;
    }
  }

  /**
   * Reaction UX (👍): the user approved a worker's DONE report — fully retire
   * the worker conv: delete its topic, its git worktree, its OpenCode session,
   * and its state. Reuses the exact /prune cleanup path (deleteForumTopic +
   * purgeConv) instead of reimplementing it. NEVER touches a busy worker —
   * the caller checks via decideApprove first (and this double-checks).
   */
  async approveWorkerReport(conv: ConvKey): Promise<{ ok: boolean; busy: boolean; name?: string }> {
    if (this.h.topics?.forTopic(conv)) return { ok: false, busy: false, name: this.h.st.peek(conv)?.worker?.name };
    const s = this.h.st.peek(conv);
    const w = s?.worker;
    if (!w) return { ok: true, busy: false }; // already retired — nothing to clean
    if (w.status === "running" || w.status === "waiting") return { ok: false, busy: true, name: w.name };
    try {
      await this.h.tg.deleteForumTopic(conv);
    } catch (e) {
      warn("deleteForumTopic (approve):", (e as Error)?.message ?? e);
    }
    const ok = await this.purgeConv(conv);
    return { ok, busy: false, name: w.name };
  }

  /**
   * Reaction UX (👎): the user rejected a worker's DONE report — relay it to
   * the MANAGER session with the exact mechanism the worker-finish relay uses
   * (queueReport's debounce → notifyManager's "[Bot event]" prompt). Does NOT
   * touch the worker conv. A no-op when the chat has no Manager session.
   */
  rejectWorkerReport(conv: ConvKey): void {
    const name = this.h.st.peek(conv)?.worker?.name ?? "?";
    this.queueReport(chatOf(conv), `User rejected the report of worker ${name} (👎). Ask or decide next step.`);
  }

  /**
   * Reaction UX (🔥): the user wants a WORKER for a message — relay its text to
   * the MANAGER session (the same queueReport → notifyManager "[Bot event]"
   * path as worker reports and 👎 rejects). The Manager crafts a self-contained
   * task and spawns the worker itself: it has the full conversation context a
   * mechanical relay would lack, and picks the name, directory and agent.
   * A no-op when the chat has no Manager session (the caller checks
   * isManagerConv first and tells the user).
   */
  relaySpawnRequest(conv: ConvKey, text: string): void {
    this.queueReport(chatOf(conv), spawnRequestBody(conv, text));
  }

  private setStatus(conv: ConvKey, status: WorkerStatus, lastResult?: string): void {
    const s = this.h.st.peek(conv);
    if (!s?.worker) return;
    const changed = s.worker.status !== status;
    const worker: WorkerInfo = { ...s.worker, status, updatedAt: Date.now(), ...(lastResult !== undefined ? { lastResult } : {}) };
    this.h.st.set(conv, { worker });
    if (changed && !this.h.topics?.enabled(conv)) void this.h.tg.editForumTopic(conv, this.topicName(worker)).catch((e) => warn("editForumTopic:", e?.message));
  }

  // ── OpenCode lifecycle hooks (called by Bot.onOpenCodeEvent) ───────────────
  onExecution(conv: ConvKey, type: string, error?: string): void {
    const s = this.h.st.peek(conv);
    if (!s) return;
    // Manager turns are fire-and-forget (no inflight AbortController), so their
    // busy state is tracked here from the execution lifecycle. This keeps the
    // "⏳ still working" block in promptManager accurate, and also covers
    // out-of-band executions (worker reports, background tasks) that prompt the
    // Manager without going through promptManager.
    //
    // ACCEPTED RISKS (not fixed — documented):
    //  (a) If the terminal execution event is LOST (e.g. the SSE stream
    //      reconnects and drops the frame), managerBusy is never cleared and the
    //      Manager chat stays "⏳ still working" until the user sends /stop.
    //      (healWorkers only settles WORKERS, not manager flags — a manager has
    //      no session-state to query for its busy-ness.)
    //  (b) A LATE event from an older turn can clear the flag of a NEWER turn:
    //      the flag is a bare Set with no turn id, so an out-of-order
    //      succeeded/failed/interrupted from a previous execution unconditionally
    //      deletes the flag even if a new execution already set it. Rare in
    //      practice (turns are mostly serialized per conv) but not guarded.
    if (s.manager && !s.worker) {
      if (type === "session.execution.started") this.managerBusy.add(conv);
      else this.dropManagerTurn(conv); // succeeded / failed / interrupted
      return;
    }
    const worker = this.topicWorker(conv);
    if (!worker) return;
    if (this.ownsScheduledConv(conv)) return;
    if (type === "session.execution.started") {
      if (worker.status !== "waiting") this.setStatus(conv, "running");
      return;
    }
    const status: WorkerStatus =
      type === "session.execution.succeeded" ? "done" : type === "session.execution.failed" ? "failed" : "stopped";
    void this.onWorkerFinished(conv, status, error);
  }

  /** A worker is blocked on the user (permission ask / question). */
  onWaiting(conv: ConvKey): void {
    if (this.topicWorker(conv)) this.setStatus(conv, "waiting");
  }

  /** The user answered — the worker resumes. */
  onResumed(conv: ConvKey): void {
    if (this.h.st.peek(conv)?.worker?.status === "waiting") this.setStatus(conv, "running");
  }

  private async onWorkerFinished(conv: ConvKey, status: WorkerStatus, error?: string, expectedSession?: string): Promise<void> {
    if (this.finishing.has(conv)) return;
    this.finishing.add(conv);
    try {
      const s = this.h.st.peek(conv);
      const w = s?.worker;
      if (!w) return; // state already retired (e.g. by a concurrent purge)
      if (expectedSession && s?.sessionID !== expectedSession) return;
      // Topic deleted in the UI while the worker was running: the detection only
      // fires on sends, and a finished worker sends nothing more — this is the
      // moment to retire the conv (see onTopicDeleted).
      //
      // Drop the flag ONLY when the purge succeeds. If purgeConv returns false
      // (worktree removal failed), the worker has already ended and will send
      // nothing more, so nothing would re-trigger the purge — keep the in-memory
      // flag AND the persisted `topicDeletedPending` marker (set in onTopicDeleted)
      // so a later /prune, a later send-failure, or the next startup sweep can
      // still retry. (The marker lives in the state entry, which the failed purge
      // deliberately kept.)
      if (this.pendingTopicDelete.has(conv)) {
        const ok = await this.purgeConv(conv);
        if (ok) {
          this.pendingTopicDelete.delete(conv);
        } else {
          warn(`onWorkerFinished (${conv}): deferred topic-delete purge failed — keeping it for retry (/prune, next send-failure, or startup sweep)`);
        }
        return;
      }
      if (w.status === "stopped") return; // stopped by the user: no report, nothing to restart
      // The final message can land a moment after the event. Only this turn's
      // reply counts (after the newest user message), never the previous one.
      let reply: { text: string; time: number } | undefined;
      for (let i = 0; i < 4 && !reply; i++) {
        reply = s.sessionID ? await this.h.oc.latestReply(s.sessionID, 0, { lastTurn: true }) : undefined;
        if (!reply) await new Promise((r) => setTimeout(r, 400));
      }
      const tail = reply ? stripTags(reply.text).trim().slice(-1500) : error ? `error: ${error}` : "(no text reply)";
      if (expectedSession && this.h.st.peek(conv)?.sessionID !== expectedSession) return;
      this.setStatus(conv, status, tail);
      const managed = this.h.topics?.forTopic(conv);
      if (managed && managed.phase !== "open") return;
      // Context-overflow recovery: a worker that died because it outgrew the
      // model's context is respawned in a FRESH session in the SAME directory
      // (same worktree), handed its original task + git evidence. Bounded to one
      // respawn per original task; off via cfg.recoverOverflow.
      let respawnedAs: string | undefined;
      if (
        status === "failed" &&
        w.spawnedBy !== "schedule" &&
        shouldRespawnWorker({
          status,
          error,
          respawnedFrom: w.respawnedFrom,
          hasTask: !!w.task,
          enabled: this.h.cfg.recoverOverflow,
        })
      ) {
        respawnedAs = await this.respawnOverflow(conv, w, tail, error);
      }
      if (w.worktree && status === "done") {
        await this.h.sendHtml(conv, this.worktreeText(w), { reply_markup: this.worktreeKeyboard(w) }).catch(() => {});
      }
      if (this.managerEntry(chatOf(conv))) {
        this.queueReport(
          chatOf(conv),
          respawnedAs
            ? `[worker ${w.name}] FAILED (context overflow) → respawned as ${respawnedAs} — continuing in the same worktree; the new worker will report on its own.`
            : `[worker ${w.name}] ${status.toUpperCase()}\n${tail}`,
        );
      }
      // Close the topic once the worker is finished (done/failed) so the forum
      // doesn't fill with dead topics. The user reopens it just by messaging in
      // it. A worker respawned for overflow stays OPEN (❌) so the user can read
      // why it died and follow the new one; /prune cleans it up later.
      if (this.h.cfg.autoClose && !this.h.topics?.enabled(conv) && (status === "done" || status === "failed") && !respawnedAs) {
        void this.h.tg.closeForumTopic(conv).catch(() => {});
      }
    } finally {
      this.finishing.delete(conv);
    }
  }

  /**
   * Spawn a replacement for a worker that died from context overflow: a FRESH
   * session in the SAME directory (same worktree, so all on-disk work carries
   * over), handed the original task + follow-ups + git evidence. Returns the new
   * worker's name, or undefined when it couldn't be spawned (the dead worker then
   * simply stays ❌ — the safe, pre-existing behavior).
   */
  private async respawnOverflow(conv: ConvKey, w: WorkerInfo, tail: string, error?: string): Promise<string | undefined> {
    const s = this.h.st.get(conv);
    if (!s.directory) return undefined; // nowhere to place the replacement
    // Follow-ups: the user messages of the dead session (manager + direct). Read
    // the WHOLE session and sort by time: a session that overflowed has far more
    // than 50 messages, and in a truncated list the oldest message is not the
    // spawn prompt (a real follow-up would be dropped instead).
    let followUps: string[] = [];
    if (s.sessionID) {
      const msgs = ((await this.h.oc.listMessages(s.sessionID).catch(() => [] as any[])) as any[]) ?? [];
      followUps = followUpsFromMessages(msgs, userText);
    }
    // Git evidence: diffSummary for a worktree worker, gitStatusBrief otherwise.
    const gitEvidence = w.worktree
      ? await diffSummary(w.worktree).catch(() => "")
      : await gitStatusBrief(s.directory);
    const name2 = respawnName(w.name);
    // The full handoff prompt: the usual worker preamble (headless contract) +
    // the five handoff sections.
    const task = `${workerPreamble(name2)}\n\n${buildHandoffPrompt({
      originalTask: w.task ?? "",
      followUps,
      lastWorkerText: tail,
      directory: s.directory,
      worktree: w.worktree ? { branch: w.worktree.branch, base: w.worktree.base } : undefined,
      gitEvidence,
      error,
    })}`;
    // The single user-facing notice in the dead topic (sent before we try to spawn).
    await this.h.sendHtml(conv, respawnNotice(w.name, name2)).catch(() => {});
    let r: { conv: ConvKey; worker: WorkerInfo };
    try {
      r = await this.spawn(chatOf(conv), {
        name: name2,
        directory: s.directory,
        task,
        agent: s.agent,
        writes: w.writes,
        spawnedBy: w.spawnedBy, // the replacement keeps the dead worker's origin (user vs manager)
        isolate: false, // reuse the dead worker's directory/worktree as-is
      });
    } catch (e) {
      await this.h.sendHtml(conv, `⚠️ Không tự tạo worker thay thế được: ${esc((e as Error).message)}`).catch(() => {});
      return undefined;
    }
    // Attach lineage + carry the worktree/repoRoot so /wt (diff/merge/remove)
    // keeps operating on the correct branch in the new topic.
    this.h.st.set(r.conv, {
      worker: { ...this.h.st.get(r.conv).worker!, worktree: w.worktree, repoRoot: w.repoRoot, respawnedFrom: w.name },
    });
    return name2;
  }

  // ── Manager ───────────────────────────────────────────────────────────────
  /** A user message for the Manager: admit it without blocking; the reply is relayed when the turn ends. */
  async promptManager(conv: ConvKey, text: string, messageId?: number): Promise<void> {
    if (this.h.topics?.enabled(conv) && !this.h.topics.canPrompt(conv)) throw new Error("Manager topic is not open; manage it from General.");
    const s = this.h.st.get(conv);
    if (!s.sessionID) {
      await this.cmdManager(conv, "on");
      if (!this.h.st.get(conv).sessionID) return;
    }
    // A turn is already running (this user's previous message, or a bot event
    // such as a worker report): block and notify, matching normal chats.
    if (this.managerBusy.has(conv)) {
      if (messageId != null) {
        // Offer the same one-tap "save as note" as the regular busy reply: the
        // button's callback data carries the user message's id and its text is
        // retained, so the tap appends it to /note (handled in Bot.handleNoteCallback).
        const kb: Keyboard = { inline_keyboard: [[{ text: NOTE_BUTTON_LABEL, callback_data: noteCallbackData(messageId) }]] };
        await this.h.tg.sendMessage(conv, BUSY_REPLY_TEXT, { reply_markup: kb });
        this.h.busyNotes.push(conv, messageId, text);
      } else {
        await this.h.tg.sendMessage(conv, BUSY_REPLY_TEXT);
      }
      return;
    }
    this.managerBusy.add(conv); // mark before the await so a 2nd message can't slip through
    this.budget.set(chatOf(conv), DISPATCH_BUDGET); // the user spoke: refill the dispatch budget
    await this.h.prepareNotes?.(conv, this.h.st.get(conv).sessionID!); // /note: surface pending notes this turn
    try {
      await this.dispatchObserved(conv, this.h.st.get(conv).sessionID!, text, "manager");
    } catch (e) {
      this.dropManagerTurn(conv); // the prompt was never accepted — don't stay busy forever
      throw e;
    }
    this.h.startTyping(conv);
    this.h.startWorking(conv); // "⏳ Đang xử lý…" for the manager turn (event-stream-driven, not runPrompt)
  }

  /** Drop the Manager busy flag (used by /stop so a stuck flag can't wedge the chat). */
  clearManagerBusy(conv: ConvKey): void {
    this.dropManagerTurn(conv);
  }

  /**
   * Clear a conv's manager busy flag AND its note-button retention together — one
   * logical turn end. Keeping them in one place guarantees the retention window
   * (busy reply → turn end) always closes with the busy flag, so a tap after the
   * turn ends (or on /stop, /new, /clear, manager off, or purge) is "not found".
   */
  private dropManagerTurn(conv: ConvKey): void {
    this.managerBusy.delete(conv);
    this.h.busyNotes.clear(conv);
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
    const entry = this.managerEntry(chat);
    const sid = entry?.[1].sessionID;
    if (!sid || !body) return;
    await this.dispatchObserved(entry![0], sid, `[Bot event — not from the user]\n${body}`, "report", body);
    this.h.startTyping(entry![0]);
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
    // Random, not a counter: a counter restarts after a bot restart, and an old
    // card's button would then approve a different, unseen request.
    const id = randomBytes(5).toString("hex");
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
  /** Returns true when the button was one of ours (`ap:` approvals, `wt:` worktree actions, `prune:` deletes). */
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
    if (data.startsWith("prune:")) {
      await this.handlePruneCallback(cb, conv, messageId);
      return true;
    }
    return false;
  }

  /**
   * Fully retire a conversation: remove its git worktree (if any), its OpenCode
   * session, and its state entry. Idempotent — safe when the state is already
   * gone. The worktree is removed before the state is cleared (removal reads the
   * state); uncommitted work is committed to the worker branch first, and an
   * unmerged branch is kept (removeWorktree). A worktree still referenced by
   * ANOTHER conv (e.g. the respawn replacement after an overflow) is NOT removed.
   * Returns false when the worktree could not be removed — the state is then
   * KEPT so /prune can retry, instead of orphaning the worktree and branch.
   * Shared by the /prune confirm and the deleted-topic detection.
   *
   * Concurrency-safe: guarded per-conv (this.purging) so the several concurrent
   * calls a dead topic produces (see the `purging` field) collapse to ONE real
   * purge — the in-flight one does the git work, the others return false
   * immediately instead of racing on index.lock. The guard is cleared once the
   * in-flight purge FINISHES (on both success and failure) so a later
   * send-failure or /prune can still retry a purge that failed.
   */
  private async purgeConv(conv: ConvKey): Promise<boolean> {
    if (this.h.topics?.forTopic(conv)) return false;
    if (this.purging.has(conv)) return false; // an in-flight purge owns this conv
    this.purging.add(conv);
    try {
      const s = this.h.st.peek(conv);
      if (!s) return true; // already gone
      const w = s.worker;
      if (w?.worktree && w.repoRoot) {
        // A replacement worker (overflow respawn) may share this worktree in a new
        // topic — removing it would delete the directory from under the new worker.
        const shared = Object.entries(this.h.st.all()).some(
          ([k, os]) => k !== conv && os?.worker?.worktree?.root === w.worktree!.root,
        );
        if (shared) {
          warn(`purgeConv (${conv}): worktree shared with another conv — keeping it`);
        } else {
          try {
            await (this.h.removeWorktree ?? removeWorktree)(w.repoRoot, w.worktree);
          } catch (e) {
            warn(`removeWorktree (${w.name}) failed — state kept for /prune retry:`, (e as Error)?.message ?? e);
            return false;
          }
        }
      }
      if (s.sessionID) await this.h.oc.removeSession(s.sessionID).catch(() => {});
      this.clearConvMemory(conv);
      this.h.st.clear(conv);
      return true;
    } finally {
      // Always clear the guard: on success the state is gone (a later call sees
      // !s → true); on failure the state is kept and a later send-failure or
      // /prune must be allowed to RETRY (so don't leave the flag behind).
      this.purging.delete(conv);
    }
  }

  /** Drop this orchestrator's in-memory per-conv tracking (budget, timers, busy flags). */
  private clearConvMemory(conv: ConvKey): void {
    this.budget.delete(conv);
    this.finishing.delete(conv);
    this.dropManagerTurn(conv);
    this.reports.delete(conv);
    const t = this.reportTimers.get(conv);
    if (t) {
      clearTimeout(t);
      this.reportTimers.delete(conv);
    }
  }

  /**
   * The user deleted a forum topic in the Telegram UI. Telegram sends NO event
   * for this (Bot API 10.3 has no forum_topic_deleted update — verified against
   * the docs and live): we observe it when a send into the topic fails with
   * "message thread not found" (Telegram.api → onThreadNotFound). Retire the
   * conversation. A worker still running/waiting is left alone for in-flight
   * work and gets purged when it ends (pendingTopicDelete).
   *
   * ACCEPTED LIMITATION (not a bug): a topic deleted while the conv is IDLE is
   * not detected until the next send into it fails or the user runs /prune.
   * Telegram gives us no idle signal for a deleted topic, so there is nothing
   * to react to until we actually try to send.
   */
  async onTopicDeleted(conv: ConvKey): Promise<void> {
    if (this.h.topics?.forTopic(conv)) { this.h.topics.topicGone(conv); return; }
    if (!String(conv).includes(":")) {
      // Defensive: topic deletion is observed from a topic send, so this can't
      // be a top-level chat — but if it ever is, never retire the main chat.
      warn(`onTopicDeleted: refusing to retire top-level conv ${conv}`);
      return;
    }
    const s = this.h.st.peek(conv);
    if (!s) return; // already gone (repeated send failures are idempotent)
    const w = s.worker;
    if (w && (w.status === "running" || w.status === "waiting")) {
      // Deferred: let the running worker finish — that is the whole point of
      // pendingTopicDelete. Do NOT call onTopicGone here: it stops the in-flight
      // turn (typing/abort/interrupt), which would kill a worker we want to run
      // to completion. Persist a marker so a restart still knows to purge this
      // conv (the in-memory flag is lost on restart); it is cleared when the
      // eventual purge succeeds (purgeConv clears the whole entry).
      this.pendingTopicDelete.add(conv);
      this.h.st.set(conv, { topicDeletedPending: true });
      log(`topic deleted for running worker ${w.name} (${conv}) — purging when the worker ends`);
      return;
    }
    // Purge now: the topic is gone and nothing is running in it. First stop any
    // lingering bot-side turn for a normal/manager topic (a turn can still be
    // live here — typing, inflight, activity — and would keep failing sends),
    // then retire state/session/worktree.
    await this.h.onTopicGone?.(conv);
    log(`topic deleted for ${conv} — retiring (worker=${w?.name ?? "none"}, session=${s.sessionID ?? "none"}, worktree=${w?.worktree?.branch ?? "none"})`);
    const ok = await this.purgeConv(conv);
    // Purge failed (worktree removal error) → keep a persisted marker so a
    // restart can retry. Only if the state still exists (a concurrent purge may
    // have already cleared it — never resurrect a purged conv as a bare marker).
    if (!ok && this.h.st.peek(conv)) this.h.st.set(conv, { topicDeletedPending: true });
  }

  /**
   * The user confirmed a /prune: delete each listed topic (best-effort, count
   * failures), retire its OpenCode session, its git worktree, and its state
   * entry (purgeConv). A worker that started running again since the list was
   * shown is skipped; a conv whose worktree couldn't be removed is kept for retry.
   */
  private async handlePruneCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const id = (cb.data ?? "").split(":")[1];
    const p = this.prunePending.get(id);
    if (!p || p.chat !== chatOf(conv)) {
      await this.h.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã hết hạn.");
      if (messageId) await this.h.tg.editMessageText(conv, messageId, "⌛ Yêu cầu này đã hết hạn (bot đã khởi động lại hoặc đã xử lý).").catch(() => {});
      return;
    }
    this.prunePending.delete(id);
    let ok = 0;
    let skipped = 0;
    for (const k of p.convs) {
      if (this.h.topics?.forTopic(k)) { skipped++; continue; }
      const s = this.h.st.peek(k);
      const w = s?.worker;
      // It may have started a new turn since the list was shown — never delete a busy worker.
      if (w && (w.status === "running" || w.status === "waiting")) {
        skipped++;
        continue;
      }
      try {
        await this.h.tg.deleteForumTopic(k);
      } catch (e) {
        warn("deleteForumTopic:", (e as Error)?.message);
      }
      if (await this.purgeConv(k)) ok++; // worktree + session + state (keeps state on worktree failure)
      else skipped++;
    }
    await this.h.tg.answerCallbackQuery(cb.id);
    const msg = `🧹 Đã xoá ${ok}/${p.convs.length} topic${skipped ? ` · bỏ qua ${skipped} (đang chạy hoặc chưa xoá được worktree)` : ""}.`;
    if (messageId) await this.h.tg.editMessageText(conv, messageId, msg).catch(() => {});
    else await this.h.sendHtml(conv, msg).catch(() => {});
  }

  private async handleApprovalCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const [, id, op] = (cb.data ?? "").split(":");
    const a = this.approvals.get(id);
    if (!a || a.chat !== chatOf(conv)) {
      await this.h.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã hết hạn.");
      if (messageId) await this.h.tg.editMessageText(conv, messageId, "⌛ Yêu cầu này đã hết hạn (bot đã khởi động lại hoặc đã xử lý).").catch(() => {});
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
    if (found && this.h.topics?.forTopic(found[0]) && ["rm", "rmok"].includes(op)) {
      await this.h.tg.answerCallbackQuery(cb.id, "A managed topic keeps its session and worktree. Close it in General; cleanup is separate.");
      return;
    }
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
        // Uncommitted work is COMMITTED to the worker branch first (not lost) —
        // only the worktree directory is removed; an unmerged branch is kept.
        // So the user loses nothing here, which the warning must say correctly.
        await this.h.sendHtml(conv, "⚠️ Xoá worktree sẽ <b>commit các thay đổi chưa commit vào nhánh</b> của worker rồi xoá thư mục worktree (nhánh chưa merge vẫn được giữ — không mất gì). Chắc chắn?", {
          reply_markup: { inline_keyboard: [[{ text: "🗑 Xoá thật", callback_data: `wt:${w.name}:rmok` }, { text: "Thôi", callback_data: `wt:${w.name}:keep` }]] },
        });
      } else if (op === "rmok") {
        let msg: string;
        try {
          msg = await removeWorktree(w.repoRoot, wt);
        } catch (e) {
          // The preservation commit or the worktree removal failed. This path had
          // no commit step before, so a failure here is new — surface it clearly.
          // (The generic catch below shows it as ❌.)
          throw new Error(`Xoá worktree thất bại: ${(e as Error).message.split("\n")[0]}`);
        }
        // The session lives in the deleted folder: retire it, and point the
        // topic back at the same subfolder of the main checkout so a new
        // message there starts a fresh session that works.
        const sub = relative(wt.root, found[1].directory ?? wt.root);
        this.h.st.set(found[0], {
          sessionID: undefined,
          directory: join(w.repoRoot, sub),
          worker: { ...w, worktree: undefined, status: "stopped", updatedAt: Date.now() },
        });
        void this.h.tg.editForumTopic(found[0], `${ICON.stopped} ${w.name}`).catch(() => {});
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
            task: { type: "string", description: "Complete instructions: goal, context, constraints, definition of done. Required unless `session_id` names an existing session to open a topic for." },
            agent: { type: "string", enum: ["build", "plan", "explore"], description: "build = edit code (default); plan = analysis only; explore = quick read-only lookup" },
            writes: { type: "boolean", description: "Whether the task may change files (default true for build)" },
            session_id: { type: "string", description: "Optional existing OpenCode session (ses_…) to bind this worker to instead of creating a new one. The worker then gets its own Telegram topic for that session — no fresh session is spawned." },
          },
          required: ["name", "directory"],
        },
        run: async (a) => {
          const spec: SpawnSpec = {
            name: String(a.name ?? ""),
            directory: this.vetDirectory(String(a.directory ?? "")),
            task: String(a.task ?? ""),
            agent: a.agent,
            writes: a.writes,
            spawnedBy: "manager",
            sessionID: a.session_id ? String(a.session_id) : undefined,
          };
          if (!spec.task && !spec.sessionID) throw new Error("task is required (or pass session_id to open a topic for an existing session).");
          if (this.h.st.findWorker(chat, spec.name.trim().toLowerCase())) throw new Error(`A worker named "${spec.name}" already exists — use send_to_worker or pick another name.`);
          this.takeBudget(chat);
          if (!auto()) {
            const id = await this.requestApproval({ chat, kind: "spawn", spawn: spec });
            return `PENDING: waiting for the user's approval (request #${id}). Do not call this again; you will get a [Bot event] with the decision.`;
          }
          const r = await this.spawn(chat, spec);
          const done = spec.task
            ? `You will get a [Bot event] when it finishes.`
            : `No task was given — send the task to this worker with send_to_worker when ready.`;
          return `Worker "${r.worker.name}" started in ${this.h.st.get(r.conv).directory}${r.worker.worktree ? ` (own worktree, branch ${r.worker.worktree.branch})` : ""}. ${done}`;
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
