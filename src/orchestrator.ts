import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Telegram, CallbackQuery, TOPIC_COLORS } from "./telegram.js";
import { OpenCodeCtl, userText } from "./opencode.js";
import { StateManager, ChatState, WorkerInfo, WorkerStatus, UserPrefsStore, Lang } from "./state.js";
import { tr } from "./i18n.js";
import { Config } from "./config.js";
import { ConvKey, chatOf, convKey, parseConv } from "./conv.js";
import { McpBridge, BridgeTool, makeRunScriptTool } from "./mcp-bridge.js";
import { addWorktree, diffSummary, gitBoundary, gitRoot, gitStatusBrief, mergeWorktree, removeWorktree } from "./worktree.js";
import { listDirs } from "./fsbrowser.js";
import { spawnRequestBody } from "./reactions.js";
import { buildHandoffPrompt, followUpsFromMessages, respawnName, respawnNotice, shouldRespawnWorker } from "./recovery.js";
import { scriptInstruction } from "./sandbox/scriptPreamble.js";
import { topicDeepLink } from "./shared.js";
import { ICON, esc, trunc, timeAgo, stripTags, mdToHtmlChunks } from "./format.js";
import { log, warn } from "./logger.js";
import { audit } from "./audit.js";
import { BusyNoteStore } from "./notes.js";
import { QueueStore } from "./queue.js";
import { buildBusyReply, busyKeyboard, queueFullReply } from "./busy.js";
import type { BusyReply } from "./busy.js";
import { queueReport } from "./orchestrator/report.js";
import { purgeConv, cmdPrune, handlePruneCallback } from "./orchestrator/purge.js";
import { onTopicDeleted, reapPendingTopicDeletes } from "./orchestrator/topics.js";
import { workerIntroHtml, approvalLines } from "./orchestrator/templates.js";
import { applyLanguagePin, detectTaskLang } from "./language.js";
import { applySuggestPin } from "./suggest.js";
import { applyStylePin } from "./style.js";
import type { Schedule } from "./schedule.js";
import type { Advisor } from "./advisor/advisor.js";
import { AGENTS, agentLabel, resolveAgent } from "./advisor/agents.js";
import { decide, callbackFor, computeFilesNew, registry as nsRegistry } from "./nextsteps.js";
import type { NextStepFacts } from "./nextsteps.js";
import { gitFingerprint } from "./gitstate.js";

type Btn = { text: string; callback_data?: string; url?: string };
type Keyboard = { inline_keyboard: Btn[][] };

/** What the orchestrator needs from the Bot (kept narrow on purpose). */
export interface Host {
  tg: Telegram;
  oc: OpenCodeCtl;
  st: StateManager;
  cfg: Config;
  /** Shared retention for the busy-reply "Thêm vào note" button (owned by the Bot). */
  busyNotes: BusyNoteStore;
  /** Shared queue for messages sent while a turn runs (owned by the Bot; docs/sdd/queue-and-steer.md). */
  queue: QueueStore;
  /** Advisor (topic + Claude/Gemini session on the advisor machine). Present only when enabled. */
  advisor?: Advisor;
  /** Per-user preferences (language). Optional so legacy test-mock Hosts still type-check; the real Bot always sets it. */
  userPrefs?: UserPrefsStore;
  sendHtml(conv: ConvKey, html: string, opts?: { reply_markup?: Keyboard }): Promise<void>;
  /**
   * S4 (next-step buttons): a message in this conv now carries the conv's
   * next-step row — the Review button appended to the worktree card, or one
   * short line. The Bot remembers its id (N3.7 dismiss) and, for a card, the
   * keyboard it reverts to when the row is removed (the card's own buttons).
   */
  noteNextStepMessage?: (conv: ConvKey, messageId: number, residual?: Keyboard) => void;
  applyModelAndVariant(sessionID: string, state: ChatState): Promise<void>;
  startTyping(conv: ConvKey): void;
  /** Show the "⏳ Đang xử lý…" line for a manager turn (the manager uses promptManager, not runPrompt). */
  startWorking(conv: ConvKey, lang?: Lang): void;
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
}

export const MANAGER_AGENT = "tg-manager";
const BRIDGE_NAME = "tg-bridge";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** Worker statuses that count as "busy" (running or waiting on the user). Exported for the S5 board rule (src/bot.ts). */
export const BUSY: WorkerStatus[] = ["running", "waiting"];
/** Manager-initiated dispatches allowed between two user messages (loop/cost guard). */
const DISPATCH_BUDGET = 12;

const workerPreamble = (name: string, agent?: string, lang?: Lang) =>
  `[System note: You are worker "${name}", one of several agents working in parallel. You are driven ` +
  "through Telegram — the user has no terminal. When you need a decision, ask with the `question` tool " +
  "(clear multiple-choice options, ONE question at a time). When you finish, END your final message with " +
  "a short summary (max ~10 lines): what you did, files changed, how to verify, and anything blocking. " +
  "Keep single-turn tool output bounded: locate with search/grep first, then read only the relevant slice " +
  "(offset/limit) — never dump whole large files or full logs; stage big output to a file and report a " +
  "one-line summary + path. Prefer small, targeted reads over broad ones.]" +
  // Zero-Context-Workers: build workers additionally get the language-neutral
  // script-mode capability note (last section, before the task).
  (agent === "build" ? "\n\n" + scriptInstruction(lang ?? "en") : "");

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

Workers' permission requests and questions are relayed to the main channel (the manager chat); you never
answer them — the user clicks the buttons there. Their worker topics keep running as usual.
Keep every reply short and concrete. Refer to workers by name.
`;

interface SpawnSpec {
  name: string;
  directory: string;
  task?: string;
  agent?: string;
  writes?: boolean;
  spawnedBy: "user" | "manager" | "schedule";
  /** Language for user-facing validation errors (default "vi"). */
  lang?: Lang;
  /**
   * When `false`, skip git worktree isolation entirely and run the worker in the
   * given directory as-is. Used for overflow respawns, which must stay in the
   * SAME worktree/directory as the dead worker (a fresh worktree cut from HEAD
   * would lose its uncommitted work).
   */
  isolate?: boolean;
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
 *
 * Members that are `public` without being API (h/prunePending/reports/reportTimers/
 * pendingTopicDelete/purging/workersOf/clearConvMemory) exist only for the modules in
 * src/orchestrator/*, which take the Orchestrator as their first argument. Don't use
 * them elsewhere.
 */
export class Orchestrator {
  private bridge?: McpBridge;
  private approvals = new Map<string, Approval>();
  /** Pending /prune confirmations: id → which convs to delete when the user taps "Xoá". */
  prunePending = new Map<string, { chat: ConvKey; convs: ConvKey[] }>();
  reports = new Map<ConvKey, string[]>();
  reportTimers = new Map<ConvKey, ReturnType<typeof setTimeout>>();
  /** Remaining Manager dispatches per chat until the user speaks again. */
  private budget = new Map<ConvKey, number>();
  /** Anti-hang timer of each schedule worker's CURRENT run (one per conv; see runScheduled). */
  private schedTimers = new Map<ConvKey, ReturnType<typeof setTimeout>>();
  /** `chat|worker-name` of scheduled runs between the busy check and "running" (closes the check→set await gap). */
  private schedStarting = new Set<string>();
  /** Worker convs whose turn-end we are already processing. */
  private finishing = new Set<ConvKey>();
  /**
   * S4 (next-step buttons, N2.3): the session modified-files set at the moment
   * "review" was last OFFERED in each worker topic; a path that appears in a
   * later report is "new" and can re-fire the rule. Same pattern as the Bot's
   * plain-conversation map. In-memory: a restart resets it.
   */
  private workerReviewFiles = new Map<ConvKey, Set<string>>();
  /**
   * Convs whose Telegram topic was deleted while a worker was still
   * running/waiting: the work is left alone, but the conv must be purged the
   * moment the worker ends (Telegram sends no further event — topic deletion
   * is only OBSERVED via send failures, which stop once the worker is done
   * and sends nothing more). See onTopicDeleted / onWorkerFinished.
   */
  pendingTopicDelete = new Set<ConvKey>();
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
  purging = new Set<ConvKey>();
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
  /**
   * Names being spawned right now, per chat. Spawning awaits several calls
   * (git, Telegram, OpenCode) before the worker is saved; reserving the name
   * synchronously first makes concurrent spawns see each other, so neither the
   * name check nor the busy limit can be raced past.
   */
  private reserved = new Map<ConvKey, Set<string>>();
  private healTimer?: ReturnType<typeof setInterval>;

  constructor(public h: Host) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /** On every (re)connect to OpenCode: re-register the bridge for chats with a Manager (it is runtime-only). */
  async onConnect(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (s.manager) await this.ensureManagerTooling(chatOf(conv)).catch((e) => warn("manager tooling:", e?.message));
    }
    await this.healWorkers();
    // After healWorkers has settled any stuck "running" workers to their real
    // status, re-purge convs whose topic was deleted but whose purge didn't
    // finish before the crash/restart (persisted topicDeletedPending marker).
    await reapPendingTopicDeletes(this);
    if (!this.healTimer) {
      // Events can also be lost while connected (a dropped frame, a server
      // hiccup); a slow sweep keeps a missed turn-end from pinning a worker
      // as busy forever. It also re-registers the tg-bridge when OpenCode
      // drops the runtime-only MCP entry without a disconnect (see healBridge).
      this.healTimer = setInterval(() => {
        void this.healWorkers().catch((e) => warn("heal workers:", e?.message));
        void this.healBridge().catch((e) => warn("heal bridge:", e?.message));
      }, 60_000);
      (this.healTimer as any).unref?.();
    }
  }

  /**
   * Re-register the Manager's tg-bridge when it is no longer connected.
   * The registration is runtime-only (never written to any config file) and
   * OpenCode drops such entries when it reloads a session's project context
   * WITHOUT dropping the bot's connection — in that case onConnect does not
   * fire, and the Manager silently loses its tg-bridge_* tools until the next
   * bot restart. A status check every sweep catches that; a failing
   * mcpStatus (client not ready) is skipped, not re-registered.
   */
  async healBridge(): Promise<void> {
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (!s.manager) continue;
      const chat = chatOf(conv);
      const st = await this.h.oc.mcpStatus(this.managerDir(chat), BRIDGE_NAME).catch(() => undefined);
      if (!st || st.status === "connected") continue;
      log(`[chat ${chat}] tg-bridge ${st.status} — re-registering`);
      await this.ensureManagerTooling(chat).catch((e) => warn("bridge heal:", e?.message));
    }
  }

  /** True when at least one chat has the Manager on (the bridge only matters then). Read by /health. */
  hasManager(): boolean {
    return Object.values(this.h.st.all()).some((s) => s.manager);
  }

  /**
   * Read-only twin of healBridge for /health: report whether each Manager
   * chat's tg-bridge is connected, without re-registering anything.
   */
  async bridgeHealth(): Promise<{ ok: boolean; detail?: string }> {
    const bad: string[] = [];
    for (const [conv, s] of Object.entries(this.h.st.all())) {
      if (!s.manager) continue;
      const st = await this.h.oc.mcpStatus(this.managerDir(chatOf(conv)), BRIDGE_NAME).catch((e) => ({ status: `unreachable (${(e as Error).message})` }));
      if (st.status !== "connected") bad.push(`${chatOf(conv)}: ${st.status}`);
    }
    return bad.length ? { ok: false, detail: `tg-bridge ${bad.join(", ")}` } : { ok: true };
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
      const state = await this.h.oc.sessionState(s.sessionID).catch(() => undefined);
      if (!state || state.busy) continue;
      const status: WorkerStatus = state.outcome === "succeeded" ? "done" : state.outcome === "failed" ? "failed" : "stopped";
      log(`[chat ${chatOf(conv)}] worker ${w.name} ended while unobserved — ${status}`);
      await this.onWorkerFinished(conv, status);
    }
  }

  private async ensureBridge(): Promise<McpBridge> {
    if (this.bridge) return this.bridge;
    const b = new McpBridge((route) => (this.bridgeChats.has(route) ? this.toolsFor(route) : undefined), BRIDGE_NAME);
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
    this.bridgeChats.add(chat);
    await this.h.oc.addRemoteMcp(dir, BRIDGE_NAME, b.url(chat), { Authorization: `Bearer ${b.token}` });
    // Connecting is asynchronous on the server; give it a moment, then insist.
    let st = { status: "pending" } as { status: string; error?: string };
    for (let i = 0; i < 10 && st.status !== "connected" && st.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      st = await this.h.oc.mcpStatus(dir, BRIDGE_NAME);
    }
    if (st.status !== "connected") throw new Error(`Bridge tool not connected (${st.status}${st.error ? `: ${st.error}` : ""}).`);
    return dir;
  }

  isManagerConv(conv: ConvKey): boolean {
    return !!this.h.st.peek(conv)?.manager;
  }

  /**
   * The conversation owner's language preference (default "vi"). The orchestrator
   * has no message uid, so it resolves the uid from the conv's last driver
   * (state.createdBy, set by the Bot on each user message) and looks up the
   * per-user preference. Used to localize user-facing cards.
   */
  private langOf(conv: ConvKey): Lang {
    // Degrade to vi if no pref store is wired (defensive: a spawn must never crash here).
    return this.h.userPrefs?.getLang(this.h.st.peek(conv)?.createdBy ?? "") ?? "vi";
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
        await cmdPrune(this, conv, arg);
        return true;
      default:
        return false;
    }
  }

  private async cmdSpawn(conv: ConvKey, arg: string): Promise<void> {
    const [name, ...rest] = arg.split(/\s+/).filter(Boolean);
    if (!name) {
      const lang = this.langOf(conv);
      await this.h.sendHtml(
        conv,
        tr(
          lang,
          "Usage: <code>/spawn &lt;tên&gt; [thư mục]</code>\nTạo một topic mới với session riêng. Ví dụ: <code>/spawn api-fix ~/Code/app</code>",
          "Usage: <code>/spawn &lt;name&gt; [dir]</code>\nCreates a new topic with its own session. E.g.: <code>/spawn api-fix ~/Code/app</code>",
        ),
      );
      return;
    }
    const lang = this.langOf(conv);
    const top = this.h.st.get(chatOf(conv));
    const dir = rest.join(" ") || this.h.st.get(conv).directory || top.directory || this.h.cfg.opencodeDirectory;
    try {
      const r = await this.spawn(chatOf(conv), { name, directory: dir, spawnedBy: "user", writes: true });
      await this.h.sendHtml(conv, tr(lang, `🧩 Đã tạo worker <b>${esc(name)}</b> — mở topic “${esc(this.topicName(r.worker))}” để làm việc.`, `🧩 Worker <b>${esc(name)}</b> created — open topic “${esc(this.topicName(r.worker))}” to work.`));
    } catch (e) {
      await this.h.sendHtml(conv, `❌ ${esc((e as Error).message)}`);
    }
  }

  /** Public (S5): the /board render is reused by the next-step "board" button tap (read-only, no agent turn). */
  async cmdBoard(conv: ConvKey): Promise<void> {
    const top = this.h.st.get(chatOf(conv));
    const workers = this.workersOf(conv);
    const head = `📋 <b>Workers (${workers.length})</b> · manager: ${top.manager ? "on" : "off"} · auto: ${top.auto ? "on" : "off"}`;
    if (!workers.length) {
      const lang = this.h.userPrefs?.getLang(top.createdBy ?? "") ?? "vi";
      await this.h.sendHtml(conv, `${head}\n\n${tr(lang, "Chưa có worker. Tạo bằng <code>/spawn &lt;tên&gt; [thư mục]</code> hoặc bật /manager.", "No workers yet. Create one with <code>/spawn &lt;name&gt; [dir]</code> or turn on /manager.")}`);
      return;
    }
    const lines = workers
      .sort(([, a], [, b]) => (b.worker!.updatedAt ?? 0) - (a.worker!.updatedAt ?? 0))
      .map(([, s]) => {
        const w = s.worker!;
        const where = w.worktree ? `🌿 <code>${esc(w.worktree.branch)}</code>` : `<code>${esc(trunc(s.directory ?? "", 40))}</code>`;
        return `${ICON[w.status]} <b>${esc(w.name)}</b> · ${esc(s.agent ?? "build")} · ${timeAgo(w.updatedAt)}\n    ${where}`;
      });
    const lang = this.h.userPrefs?.getLang(top.createdBy ?? "") ?? "vi";
    await this.h.sendHtml(conv, `${head}\n\n${lines.join("\n")}\n\n<i>${tr(lang, "/kill &lt;tên&gt; để dừng · /stopall dừng tất cả", "/kill &lt;name&gt; to stop · /stopall stops all")}</i>`);
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
    await this.showKillPicker(conv, name ? tr(this.langOf(conv), `❌ Không có worker <code>${esc(name)}</code>`, `❌ No worker <code>${esc(name)}</code>`) : undefined);
  }

  /** The /kill picker card: one stop-button per worker + a hint line. */
  private async showKillPicker(conv: ConvKey, errorNote?: string): Promise<void> {
    const lang = this.langOf(conv);
    const workers = this.workersOf(conv).map(([, s]) => s.worker!);
    if (!workers.length) {
      await this.h.sendHtml(conv, tr(lang, "Không có worker nào — /spawn để tạo.", "No workers — /spawn to create one."));
      return;
    }
    const rows: Btn[][] = workers.map((w) => [{ text: `${ICON[w.status]} ${w.name}`, callback_data: `kill:${w.name}` }]);
    rows.push([{ text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: "kill:close" }]);
    await this.h.sendHtml(
      conv,
      [errorNote ?? tr(lang, "❓ <b>/kill</b> cần tên worker", "❓ <b>/kill</b> needs a worker name"), tr(lang, "Bấm để dừng worker:", "Tap to stop a worker:"), tr(lang, "Hoặc gửi: <code>/kill &lt;tên&gt;</code>", "Or send: <code>/kill &lt;name&gt;</code>")].join("\n"),
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  /**
   * Handle a tap on the /kill picker (data = `kill:<name|close>`). Public because
   * it is dispatched from Bot.handleCallback, like the other orchestrator callbacks.
   */
  async handleKillCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const lang = this.h.userPrefs?.getLang(cb.from?.id ?? "") ?? "vi";
    const name = (cb.data ?? "").slice("kill:".length);
    if (name === "close") {
      await this.h.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.h.tg.deleteMessage(conv, messageId).catch(() => {});
      return;
    }
    const found = this.h.st.findWorker(chatOf(conv), name);
    if (!found) {
      await this.h.tg.answerCallbackQuery(cb.id, tr(lang, "Worker không còn tồn tại.", "The worker no longer exists."));
      if (messageId) await this.h.tg.editMessageText(conv, messageId, tr(lang, "⌛ Worker không còn tồn tại — /board để xem lại.", "⌛ The worker no longer exists — /board to refresh."), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    await this.h.tg.answerCallbackQuery(cb.id, tr(lang, `Dừng ${name}`, `Stopping ${name}`));
    const msg = await this.stopWorker(found[0], true);
    if (messageId) await this.h.tg.editMessageText(conv, messageId, msg).catch(() => {});
  }

  private async cmdStopAll(conv: ConvKey): Promise<void> {
    const busy = this.workersOf(conv).filter(([, s]) => BUSY.includes(s.worker!.status));
    for (const [k] of busy) await this.stopWorker(k, false);
    const lang = this.langOf(conv);
    await this.h.sendHtml(conv, busy.length ? tr(lang, `⏹ Đã dừng ${busy.length} worker.`, `⏹ Stopped ${busy.length} worker(s).`) : tr(lang, "Không có worker nào đang chạy.", "No workers running."));
  }

  private async cmdManager(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    const lang = this.h.userPrefs?.getLang(this.h.st.peek(chat)?.createdBy ?? "") ?? "vi";
    if (conv !== chat) {
      await this.h.sendHtml(conv, tr(lang, "ℹ️ Bật Manager ở khung chat chính (General), không phải trong topic.", "ℹ️ Turn the Manager on in the main chat (General), not in a topic."));
      return;
    }
    const want = arg.trim().toLowerCase();
    const top = this.h.st.get(chat);
    if (want === "off") {
      if (!top.manager) return void (await this.h.sendHtml(conv, tr(lang, "Manager đang tắt.", "The Manager is already off.")));
      if (top.sessionID) await this.h.oc.interrupt(top.sessionID).catch(() => {});
      this.dropManagerTurn(conv, "interrupted"); // manager session dropped — late terminal event can't clear the flag (Q4: interrupted → no drain)
      this.bridgeChats.delete(chat);
      this.h.st.set(chat, { manager: false, sessionID: undefined, agent: undefined, directory: undefined, guided: false });
      await this.h.sendHtml(conv, tr(lang, "🧭 Đã tắt Manager. Chat chính quay lại làm việc như một session bình thường; các worker vẫn giữ nguyên.", "🧭 Manager off. The main chat works as a normal session again; the workers are kept as-is."));
      return;
    }
    if (want !== "on" && want !== "") {
      await this.h.sendHtml(conv, "Usage: <code>/manager on|off</code>");
      return;
    }
    if (top.manager && top.sessionID) {
      await this.h.sendHtml(
        conv,
        tr(lang, `🧭 Manager đang bật (session <code>${esc(top.sessionID)}</code>). Cứ nhắn yêu cầu ở đây. <code>/manager off</code> để tắt.`, `🧭 Manager is on (session <code>${esc(top.sessionID)}</code>). Just ask here. <code>/manager off</code> to turn it off.`),
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
          tr(lang, "🧭 <b>Manager đã bật.</b>", "🧭 <b>Manager is on.</b>"),
          tr(lang, "Nhắn yêu cầu ở đây — Manager sẽ chia việc và giao cho các worker, mỗi worker một topic riêng.", "Ask here — the Manager splits the work and assigns it to workers, each with its own topic."),
          tr(lang, `Chế độ duyệt: <b>${top.auto ? "auto (tự giao việc)" : "hỏi trước khi giao việc"}</b> — đổi bằng /auto on|off.`, `Approval mode: <b>${top.auto ? "auto (assigns on its own)" : "asks before assigning"}</b> — change with /auto on|off.`),
          tr(lang, "Xin quyền / câu hỏi của worker sẽ hiện ở kênh chính (nơi này) — bạn bấm nút trả lời ngay tại đây.", "Worker permission requests / questions show up in the main channel (here) — tap a button to answer."),
        ].join("\n"),
      );
    } catch (e) {
      await this.h.sendHtml(conv, tr(lang, `❌ Không bật được Manager: ${esc((e as Error).message)}`, `❌ Can't turn on the Manager: ${esc((e as Error).message)}`));
    }
  }

  private async cmdAuto(conv: ConvKey, arg: string): Promise<void> {
    const chat = chatOf(conv);
    const lang = this.langOf(conv);
    const want = arg.trim().toLowerCase();
    if (want === "on" || want === "off") this.h.st.set(chat, { auto: want === "on" });
    const on = !!this.h.st.get(chat).auto;
    await this.h.sendHtml(
      conv,
      on
        ? tr(lang, "⚡ Auto: <b>on</b> — Manager tự tạo worker và giao việc, chỉ báo lại kết quả. Xin quyền của worker vẫn hỏi bạn.", "⚡ Auto: <b>on</b> — the Manager spawns workers and assigns tasks on its own, reporting only results. Worker permission requests still ask you.")
        : tr(lang, "🛂 Auto: <b>off</b> — Manager phải chờ bạn bấm ✅ trước khi tạo worker hoặc giao việc.", "🛂 Auto: <b>off</b> — the Manager waits for your ✅ tap before spawning workers or assigning tasks."),
    );
  }

  private async cmdWorktree(conv: ConvKey): Promise<void> {
    const w = this.h.st.peek(conv)?.worker;
    const lang = this.langOf(conv);
    if (!w?.worktree) {
      await this.h.sendHtml(conv, tr(lang, "ℹ️ Topic này không chạy trong git worktree riêng.", "ℹ️ This topic is not running in a dedicated git worktree."));
      return;
    }
    await this.h.sendHtml(conv, this.worktreeText(w, lang), { reply_markup: this.worktreeKeyboard(w, lang) });
  }

  // ── workers ───────────────────────────────────────────────────────────────
  workersOf(conv: ConvKey): [ConvKey, ChatState][] {
    return this.h.st.convsOfChat(conv).filter(([, s]) => s.worker);
  }

  private topicName(w: WorkerInfo): string {
    return `${ICON[w.status]} ${w.name}`;
  }

  /** Resolve and vet a directory a worker may run in: real path, existing dir, under the browse roots, not the Manager's. */
  private vetDirectory(dir: string, lang: Lang = "vi"): string {
    const expanded = dir.startsWith("~") ? join(process.env.HOME ?? "", dir.slice(1)) : dir;
    const abs = isAbsolute(expanded) ? expanded : resolve(this.h.cfg.opencodeDirectory, expanded);
    let real: string;
    try {
      real = realpathSync(abs);
      if (!statSync(real).isDirectory()) throw new Error();
    } catch {
      throw new Error(tr(lang, `Không tìm thấy thư mục: ${abs}`, `Directory not found: ${abs}`));
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
      throw new Error(tr(lang, `Thư mục nằm ngoài vùng cho phép (OPENCODE_TG_BROWSE_ROOTS): ${real}`, `Directory is outside the allowed roots (OPENCODE_TG_BROWSE_ROOTS): ${real}`));
    }
    if (under(this.h.cfg.managerDir)) throw new Error("Cannot run a worker inside the Manager directory.");
    return real;
  }

  /** Create a worker: vet inputs, isolate if needed, open its topic and session, and start its task. */
  async spawn(chat: ConvKey, spec: SpawnSpec): Promise<{ conv: ConvKey; worker: WorkerInfo }> {
    const lang: Lang = spec.lang ?? "vi";
    const name = spec.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(tr(lang, `Tên worker không hợp lệ "${spec.name}" — dùng a-z, 0-9, dấu gạch ngang, tối đa 24 ký tự.`, `Invalid worker name "${spec.name}" — use a-z, 0-9, hyphens, max 24 chars.`));
    const pending = this.reserved.get(chat) ?? new Set<string>();
    if (this.h.st.findWorker(chat, name) || pending.has(name)) throw new Error(tr(lang, `Đã có worker tên "${name}". Hãy chọn tên khác.`, `A worker named "${name}" already exists. Pick another name.`));
    // Only spawns that will start working (have a task) take a busy slot.
    if (spec.task) this.assertCapacity(chat, undefined, lang);
    pending.add(name);
    this.reserved.set(chat, pending);
    try {
      const res = await this.spawnReserved(chat, name, spec);
      const ws = this.h.st.get(res.conv);
      audit({ action: "spawn", userId: this.h.st.peek(chat)?.createdBy, chatId: chat, session: ws.sessionID, dir: ws.directory, outcome: "ok", text: `${name}${spec.spawnedBy ? ` (by ${spec.spawnedBy})` : ""}: ${spec.task ?? ""}` });
      return res;
    } catch (e) {
      audit({ action: "spawn", userId: this.h.st.peek(chat)?.createdBy, chatId: chat, dir: spec.directory, outcome: `error: ${(e as Error).message}`, text: `${name}: ${spec.task ?? ""}` });
      throw e;
    } finally {
      pending.delete(name);
      if (!pending.size) this.reserved.delete(chat);
    }
  }

  /** Busy workers of a chat, counting spawns in flight. */
  private busyCount(chat: ConvKey, except?: ConvKey): number {
    const busy = this.workersOf(chat).filter(([k, s]) => k !== except && BUSY.includes(s.worker!.status)).length;
    return busy + (this.reserved.get(chatOf(chat))?.size ?? 0);
  }

  private assertCapacity(chat: ConvKey, except?: ConvKey, lang: Lang = "vi"): void {
    const busy = this.busyCount(chat, except);
    if (busy >= this.h.cfg.maxWorkers) {
      throw new Error(tr(lang, `Đã có ${busy} worker đang chạy (tối đa ${this.h.cfg.maxWorkers}). Chờ bớt hoặc /kill bớt.`, `${busy} worker(s) already running (max ${this.h.cfg.maxWorkers}). Wait for some to finish or /kill one.`));
    }
  }

  private async spawnReserved(chat: ConvKey, name: string, spec: SpawnSpec): Promise<{ conv: ConvKey; worker: WorkerInfo }> {
    let directory = this.vetDirectory(spec.directory, spec.lang ?? "vi");
    const agent = spec.agent && ["build", "plan", "explore", "general"].includes(spec.agent) ? spec.agent : "build";
    const writes = spec.writes ?? agent === "build";

    // Isolation: a writer that would share a repo checkout with another busy
    // writer gets its own worktree + branch instead. A respawn (isolate === false)
    // skips this entirely — it must reuse the dead worker's directory/worktree as-is.
    let worktree: WorkerInfo["worktree"];
    let repoRoot: string | undefined;
    if (spec.isolate !== false && writes && this.h.cfg.worktreeMode !== "off") {
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
      // Review rule (S4): baseline working-tree fingerprint, taken now that
      // the directory is final. Only for writing workers with the feature on —
      // off mode makes no git call at all (byte-identical).
      fpBase: this.h.cfg.nextSteps && writes ? await gitFingerprint(directory) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    let threadId: number;
    try {
      threadId = await this.h.tg.createForumTopic(chatId, this.topicName(worker), TOPIC_COLORS[name.length % TOPIC_COLORS.length]);
    } catch (e) {
      if (worktree && repoRoot) await removeWorktree(repoRoot, worktree).catch(() => {});
      throw new Error(
        tr(
          this.langOf(chat),
          `Không tạo được topic (${(e as Error).message}). Cần bật chế độ topic: chat riêng với bot có topic mode, ` +
            "hoặc supergroup bật Topics và bot là admin có quyền “Manage topics”.",
          `Could not create a topic (${(e as Error).message}). Topic mode is required: a private chat with the bot that has topic mode, ` +
            "or a supergroup with Topics enabled where the bot is an admin with “Manage topics” permission.",
        ),
      );
    }
    const conv = convKey(chatId, threadId);
    const top = this.h.st.get(chat);
    let sessionID: string;
    try {
      sessionID = await this.h.oc.createSession(directory, {
        title: `tg:${name}`,
        agent,
        metadata: { tgWorker: name, tgChat: chat },
      });
    } catch (e) {
      // Nothing was saved yet: undo the topic and worktree so a retry with the
      // same name works and nothing is left orphaned.
      await this.h.tg.deleteForumTopic(conv).catch(() => this.h.tg.editForumTopic(conv, `❌ ${name}`).catch(() => {}));
      if (worktree && repoRoot) await removeWorktree(repoRoot, worktree).catch(() => {});
      throw e;
    }
    // Worker topic welcome, localized to the conv owner's language. Sent before
    // the record is persisted so its message id can ride on the worker (anchor
    // for the manager board's switch_to_topic jump buttons).
    const introId = await this.h
      .tg.sendMessageId(
        conv,
        workerIntroHtml(this.langOf(chat), {
          name,
          agent,
          directory,
          spawnedBy: spec.spawnedBy,
          task: spec.task,
          worktree: worktree ? { branch: worktree.branch, base: worktree.base } : undefined,
        }),
      )
      .catch(() => -1);
    if (introId > 0) worker.introMessageId = introId;

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
    // Workers mirror the task language: an English task pins the session to
    // English (the model otherwise drifts to Vietnamese here); a Vietnamese
    // task needs no pin — it is the model's natural default.
    await applyLanguagePin(this.h.oc, this.h.st, conv, sessionID, detectTaskLang(spec.task ?? ""));
    log(`[chat ${chat}] spawned worker ${name} (${agent}) in ${directory}`);

    // Deep-link button so the user can jump from the main topic into the worker's topic.
    // Bot API 10.4: supergroups use `t.me/c/<id>/<thread>`; private chats with
    // topics use `t.me/<bot_username>/<thread>` (opens only for that chat's
    // owner). No link for either (unknown username, other chat type) → skip.
    const topicLink = await topicDeepLink(chatId, threadId, await this.h.tg.botUsername());
    if (topicLink) {
      await this.h
        .sendHtml(
          convKey(chatId),
          tr(this.langOf(chat), `🧩 <b>Worker ${esc(name)}</b> — bấm để mở topic`, `🧩 <b>Worker ${esc(name)}</b> — tap to open the topic`),
          { reply_markup: { inline_keyboard: [[{ text: tr(this.langOf(chat), "🔎 Mở topic", "🔎 Open topic"), url: topicLink }]] } },
        )
        .catch(() => {});
    }

    if (spec.task) {
      await this.h.oc.prompt(sessionID, `${workerPreamble(name, agent, this.langOf(chat))}\n\n${spec.task}`);
      this.h.startTyping(conv);
    }
    return { conv, worker };
  }

  /** Follow-up instruction to an existing worker (non-blocking). */
  private async sendToWorker(conv: ConvKey, message: string): Promise<void> {
    const lang = this.langOf(conv);
    const s = this.h.st.get(conv);
    if (!s.sessionID || !s.worker) throw new Error(tr(lang, "Worker không còn session.", "The worker has no session."));
    if (s.worker.status === "stopped") throw new Error(tr(lang, `Worker "${s.worker.name}" đã bị dừng.`, `Worker "${s.worker.name}" was stopped.`));
    // Checked here, not only in the tool, so an approval tapped later can't
    // start a second turn on a busy worker or exceed the busy limit.
    if (BUSY.includes(s.worker.status)) throw new Error(tr(lang, `Worker "${s.worker.name}" đang ${s.worker.status}; chờ nó xong đã.`, `Worker "${s.worker.name}" is ${s.worker.status}; wait for it to finish.`));
    this.assertCapacity(chatOf(conv), conv, lang);
    // Show the instruction in the topic as rendered Telegram HTML (bold/headers/code
    // actually render), mirroring how manager replies are converted (stripTags +
    // mdToHtmlChunks). The worker's OpenCode session below still gets the original
    // Markdown — only the topic display is converted.
    const header = "📨 <b>Manager:</b>";
    const chunks = mdToHtmlChunks(trunc(stripTags(message), 1500), this.h.cfg.replyMaxLen - header.length - 1);
    await this.h.sendHtml(conv, chunks.length ? `${header}\n${chunks[0]}` : header).catch(() => {});
    for (let i = 1; i < chunks.length; i++) await this.h.sendHtml(conv, chunks[i]).catch(() => {});
    await this.h.oc.prompt(s.sessionID, message);
    this.setStatus(conv, "running");
    this.h.startTyping(conv);
  }

  private async stopWorker(conv: ConvKey, close: boolean): Promise<string> {
    const s = this.h.st.get(conv);
    const w = s.worker!;
    // Mark first: the interrupt fires session.execution.interrupted while the
    // call is still in flight, and that must not read as a normal finish (it
    // would be reported to the Manager, which might restart the work).
    this.setStatus(conv, "stopped");
    if (s.sessionID) await this.h.oc.interrupt(s.sessionID).catch(() => {});
    if (close) await this.h.tg.closeForumTopic(conv);
    const lang = this.langOf(conv);
    return `${tr(lang, "⏹ Đã dừng worker", "⏹ Stopped worker")} <b>${esc(w.name)}</b>.${w.worktree ? tr(lang, " Worktree vẫn giữ — dùng /wt trong topic để xem diff / merge / xoá.", " Worktree kept — use /wt in the topic to view diff / merge / delete.") : ""}`;
  }

  /** Is a worker of this name under the chat currently running/waiting? (scheduler's busy/skip check) */
  workerBusyByName(chat: ConvKey, name: string): boolean {
    const found = this.h.st.findWorker(chat, name);
    return !!found && BUSY.includes(found[1].worker!.status);
  }

  /**
   * Run a schedule once — the real dispatch behind the scheduler's `dispatch`
   * dependency. Finds (or creates) the schedule's worker topic, applies the
   * ≤1-live-session policy, prompts it, and arms an anti-hang timeout.
   */
  async runScheduled(chat: ConvKey, sch: Schedule): Promise<void> {
    const name = "sch-" + sch.id;
    // One run at a time per schedule, for EVERY entry point (tick, /schedule run,
    // ▶▶ button): a second run would retire the session the first is still using.
    const startKey = `${chat}|${name}`;
    if (this.schedStarting.has(startKey) || this.workerBusyByName(chat, name)) {
      throw new Error(`lịch #${sch.id} đang chạy — chờ nó xong hoặc /kill trước.`);
    }
    this.schedStarting.add(startKey);
    try {
      await this.runScheduledInner(chat, sch, name);
    } finally {
      this.schedStarting.delete(startKey);
    }
  }

  private async runScheduledInner(chat: ConvKey, sch: Schedule, name: string): Promise<void> {
    let conv: ConvKey;
    let justSpawned: boolean;
    const existing = this.h.st.findWorker(chat, name);
    if (existing) {
      conv = existing[0];
      justSpawned = false;
    } else {
      // First run: create the worker with NO task → it starts idle and takes
      // no busy slot. If spawn throws (e.g. topic unsupported) let it throw —
      // the scheduler's tick catches it and records the schedule error.
      conv = (await this.spawn(chat, { name, directory: sch.dir, agent: sch.agent, spawnedBy: "schedule" })).conv;
      justSpawned = true;
    }
    const state = this.h.st.get(conv);
    let sessionID: string;
    if (justSpawned) {
      // First run: reuse the session spawn() already created (a second create
      // would orphan a session).
      sessionID = state.sessionID!;
    } else {
      // Repeat run: fresh session, created BEFORE retiring the old one so a
      // failed create never drops the previous session (≤1 live session).
      sessionID = await this.h.oc.createSession(sch.dir, {
        title: "tg:" + name,
        agent: sch.agent,
        metadata: { tgWorker: name, tgChat: chat },
      });
      if (state.sessionID) await this.h.oc.removeSession(state.sessionID).catch(() => {});
    }
    // Bind the session to this conv so relay + permission/form route here.
    this.h.st.set(conv, { sessionID, guided: true, lastRelayedTime: 1 });
    await this.h.applyModelAndVariant(sessionID, this.h.st.get(conv));
    this.setStatus(conv, "running");
    await this.h.oc.prompt(sessionID, workerPreamble(name, sch.agent, this.langOf(chat)) + "\n\n" + sch.prompt);
    this.h.startTyping(conv);
    // Anti-hang timeout: if still BUSY when it fires, stop it and report once.
    // Tied to THIS run: the timer is cancelled when the worker leaves BUSY (setStatus)
    // and ignored if a newer run replaced it, so it can never stop a later run.
    this.clearSchedTimer(conv);
    const timer = setTimeout(() => {
      if (this.schedTimers.get(conv) !== timer) return;
      this.schedTimers.delete(conv);
      void (async () => {
        const cur = this.h.st.peek(conv);
        if (cur?.worker && BUSY.includes(cur.worker.status)) {
          await this.stopWorker(conv, false).catch(() => {});
          await this.h.tg.sendMessage(conv, tr(this.langOf(conv), `⏱ Quá hạn — đã dừng lịch ${name}`, `⏱ Timed out — stopped schedule ${name}`)).catch(() => {});
        }
      })();
    }, this.h.cfg.scheduleTimeoutMs);
    timer.unref?.();
    this.schedTimers.set(conv, timer);
  }

  private clearSchedTimer(conv: ConvKey): void {
    const t = this.schedTimers.get(conv);
    if (t) clearTimeout(t);
    this.schedTimers.delete(conv);
  }

  /**
   * Reaction UX (👍): the user approved a worker's DONE report — fully retire
   * the worker conv: delete its topic, its git worktree, its OpenCode session,
   * and its state. Reuses the exact /prune cleanup path (deleteForumTopic +
   * purgeConv) instead of reimplementing it. NEVER touches a busy worker —
   * the caller checks via decideApprove first (and this double-checks).
   */
  async approveWorkerReport(conv: ConvKey): Promise<{ ok: boolean; busy: boolean; name?: string }> {
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
    queueReport(this, chatOf(conv), `User rejected the report of worker ${name} (👎). Ask or decide next step.`);
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
    queueReport(this, chatOf(conv), spawnRequestBody(conv, text));
  }

  private setStatus(conv: ConvKey, status: WorkerStatus, lastResult?: string): void {
    const s = this.h.st.peek(conv);
    if (!s?.worker) return;
    const changed = s.worker.status !== status;
    const worker: WorkerInfo = { ...s.worker, status, updatedAt: Date.now(), ...(lastResult !== undefined ? { lastResult } : {}) };
    this.h.st.set(conv, { worker });
    if (!BUSY.includes(status)) this.clearSchedTimer(conv); // the run this timer guarded is over
    if (changed) void this.h.tg.editForumTopic(conv, this.topicName(worker)).catch((e) => warn("editForumTopic:", e?.message));
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
      else this.dropManagerTurn(conv, type === "session.execution.succeeded" ? "succeeded" : "failed"); // Q4: only a succeeded manager turn drains its queue
      return;
    }
    if (!s.worker) return;
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
      const s = this.h.st.peek(conv);
      const w = s?.worker;
      if (!w) return; // state already retired (e.g. by a concurrent purge)
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
      this.setStatus(conv, status, tail);
      // Context-overflow recovery: a worker that died because it outgrew the
      // model's context is respawned in a FRESH session in the SAME directory
      // (same worktree), handed its original task + git evidence. Bounded to one
      // respawn per original task; off via cfg.recoverOverflow.
      let respawnedAs: string | undefined;
      if (
        status === "failed" &&
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
      if (status === "done") {
        // S4 (next-step buttons): a writing worker that finished done with new
        // changes gets a Review row — appended to the worktree card (no extra
        // message) or on one short line when there is no worktree.
        const lang = this.langOf(chatOf(conv));
        const reviewRow = await this.workerReviewRow(conv, s, w, lang);
        if (w.worktree) {
          const kb = this.worktreeKeyboard(w, lang);
          if (reviewRow) kb.inline_keyboard.push(reviewRow);
          // The card is short (no chunking): send via sendMessageId so the id
          // can be remembered for the N3.7 dismiss.
          const cardId = await this.h.tg.sendMessageId(conv, this.worktreeText(w, lang), { reply_markup: kb }).catch(() => -1);
          // Removing the row (tap/dismiss) must keep the card's own buttons.
          if (reviewRow) this.h.noteNextStepMessage?.(conv, cardId, this.worktreeKeyboard(w, lang));
        } else if (reviewRow) {
          const lineId = await this.h
            .tg.sendMessageId(
              conv,
              tr(lang, "✅ Xong — xem lại thay đổi của worker:", "✅ Done — review the worker's changes:"),
              { reply_markup: { inline_keyboard: [reviewRow] } },
            )
            .catch(() => -1);
          this.h.noteNextStepMessage?.(conv, lineId);
        }
      }
      if (this.h.st.peek(chatOf(conv))?.manager) {
        queueReport(
          this,
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
      if (this.h.cfg.autoClose && (status === "done" || status === "failed") && !respawnedAs) {
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
    // Fresh boundary re-read NOW (branch / uncommitted / last commit / recent
    // files) — the replacement's current "where we are".
    const boundary = await gitBoundary(s.directory).catch(() => "");
    const name2 = respawnName(w.name);
    // The full handoff prompt: the usual worker preamble (headless contract) +
    // the five handoff sections.
    const task = `${workerPreamble(name2, s.agent, this.langOf(chatOf(conv)))}\n\n${buildHandoffPrompt({
      originalTask: w.task ?? "",
      followUps,
      lastWorkerText: tail,
      directory: s.directory,
      worktree: w.worktree ? { branch: w.worktree.branch, base: w.worktree.base } : undefined,
      gitEvidence,
      gitBoundary: boundary,
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
      await this.h.sendHtml(conv, tr(this.langOf(conv), `⚠️ Không tự tạo worker thay thế được: ${esc((e as Error).message)}`, `⚠️ Couldn't auto-create a replacement worker: ${esc((e as Error).message)}`)).catch(() => {});
      return undefined;
    }
    // Attach lineage + carry the worktree/repoRoot so /wt (diff/merge/remove)
    // keeps operating on the correct branch in the new topic — and the
    // fingerprint baseline, so the predecessor's unreviewed changes stay
    // reviewable by the replacement.
    this.h.st.set(r.conv, {
      worker: { ...this.h.st.get(r.conv).worker!, worktree: w.worktree, repoRoot: w.repoRoot, respawnedFrom: w.name, fpBase: w.fpBase },
    });
    return name2;
  }

  // ── Manager ───────────────────────────────────────────────────────────────
  /** A user message for the Manager: admit it without blocking; the reply is relayed when the turn ends. */
  async promptManager(conv: ConvKey, text: string, messageId?: number, lang?: Lang): Promise<void> {
    const s = this.h.st.get(conv);
    if (!s.sessionID) {
      await this.cmdManager(conv, "on");
      if (!this.h.st.get(conv).sessionID) return;
    }
    // A turn is already running (this user's previous message, or a bot event
    // such as a worker report): block and notify, matching normal chats.
    if (this.managerBusy.has(conv)) {
      // Busy reply per config.busyMode (ask / queue / off — see src/busy.ts),
      // same behaviour as the regular chat. In "queue" mode the message is
      // auto-enqueued on arrival; the Steer-now button targets this Manager
      // session (Q2.5: only the Manager's turn, workers are separate sessions).
      const busyLang = lang ?? "vi";
      let reply: BusyReply;
      if (this.h.cfg.busyMode === "queue" && messageId != null) {
        const createdBy = this.h.st.peek(conv)?.createdBy;
        const r = this.h.queue.push(conv, { text, senderId: createdBy != null ? String(createdBy) : undefined });
        if (r.ok) audit({ action: "queue_add", chatId: conv, userId: createdBy != null ? String(createdBy) : undefined, meta: { messageId, textLen: text.length, queuedCount: r.position, manager: true } });
        reply = r.ok
          ? buildBusyReply({ lang: busyLang, mode: "queue", messageId, queuedCount: r.position })
          : queueFullReply({ lang: busyLang, messageId });
      } else {
        reply = buildBusyReply({ lang: busyLang, mode: this.h.cfg.busyMode, messageId, canSteer: true });
      }
      const kb = busyKeyboard(reply.buttons);
      await this.h.tg.sendMessage(conv, reply.text, kb ? { reply_markup: kb } : undefined);
      if (messageId != null) this.h.busyNotes.push(conv, messageId, text);
      return;
    }

    this.managerBusy.add(conv); // mark before the await so a 2nd message can't slip through
    this.budget.set(conv, DISPATCH_BUDGET); // the user spoke: refill the dispatch budget
    // Per-user language preference: pin the Manager session to English when the
    // user chose "en" ("vi"/unset clears it). Idempotent, self-tracked per session.
    await applyLanguagePin(this.h.oc, this.h.st, conv, this.h.st.get(conv).sessionID!, lang);
    // Quick replies (R2): pin the [OPTIONS] instruction on the Manager session when enabled.
    await applySuggestPin(this.h.oc, this.h.st, conv, this.h.st.get(conv).sessionID!, this.h.cfg.suggest);
    // Per-user output style: pin the style instruction on the Manager session when set ("default" = no pin).
    await applyStylePin(this.h.oc, this.h.st, conv, this.h.st.get(conv).sessionID!, this.h.userPrefs?.getStyle(this.h.st.peek(conv)?.createdBy ?? "") ?? "default");
    await this.h.prepareNotes?.(conv, this.h.st.get(conv).sessionID!); // /note: surface pending notes this turn
    try {
      await this.h.oc.prompt(this.h.st.get(conv).sessionID!, text);
    } catch (e) {
      this.dropManagerTurn(conv, "interrupted"); // the prompt was never accepted — don't stay busy forever (Q4: interrupted → no drain)
      throw e;
    }
    const ms = this.h.st.get(conv);
    audit({ action: "prompt_manager", userId: ms.createdBy, chatId: conv, session: ms.sessionID, dir: ms.directory, outcome: "accepted", text });
    this.h.startTyping(conv);
    this.h.startWorking(conv, lang); // "⏳ Đang xử lý…" for the manager turn (event-stream-driven, not runPrompt)
  }

  /** Drop the Manager busy flag (used by /stop so a stuck flag can't wedge the chat). */
  clearManagerBusy(conv: ConvKey): void {
    this.dropManagerTurn(conv);
  }

  /** True while at least one manager turn is in flight (used by the Bot's shutdown drain). */
  get managerInflight(): boolean {
    return this.managerBusy.size > 0;
  }

  /** True while THIS conv's manager turn is in flight (per-conversation: the rotation
   *  gate uses this so another conv's manager turn can't block it). */
  isManagerBusy(conv: ConvKey): boolean {
    return this.managerBusy.has(conv);
  }

  /**
   * Clear a conv's manager busy flag AND its note-button retention together — one
   * logical turn end. Keeping them in one place guarantees the retention window
   * (busy reply → turn end) always closes with the busy flag, so a tap after the
   * turn ends (or on /stop, /new, /clear, manager off, or purge) is "not found".
   */
  private dropManagerTurn(conv: ConvKey, outcome: "succeeded" | "failed" | "interrupted" = "interrupted"): void {
    this.managerBusy.delete(conv);
    this.h.busyNotes.clear(conv);
    // Q4: only a SUCCEEDED manager turn runs the next queued message (a failed
    // or interrupted turn holds it — mirrors the plain-session drain). Fire-and-
    // forget through promptManager (manager semantics: no inflight controller).
    if (outcome === "succeeded") this.drainManagerQueue(conv);
  }

  /**
   * Q4 — run the head of a manager conv's queue as a fresh manager turn: one
   * item per turn-end (no self-recursion). Uses promptManager (NOT runPrompt) so
   * manager semantics are kept: no inflight AbortController, fire-and-forget. A
   * busy manager makes promptManager reply "Đang chạy…" instead of starting a
   * second turn, so it is race-safe.
   */
  private drainManagerQueue(conv: ConvKey): void {
    const item = this.h.queue.shift(conv);
    if (!item) return; // nothing queued
    audit({ action: "queue_run", chatId: conv, userId: item.senderId, meta: { senderId: item.senderId, waitedMs: Date.now() - item.at, manager: true } });
    void this.promptManager(conv, item.text, undefined, this.langOf(conv));
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
    const lines = approvalLines(this.langOf(a.chat), a);
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
      await handlePruneCallback(this, cb, conv, messageId);
      return true;
    }
    return false;
  }

  /** Delegates to ./orchestrator/purge.ts (kept as a method: tests call it directly). */
  private async purgeConv(conv: ConvKey): Promise<boolean> { return purgeConv(this, conv); }

  /** Drop this orchestrator's in-memory per-conv tracking (budget, timers, busy flags). */
  clearConvMemory(conv: ConvKey): void {
    this.budget.delete(conv);
    this.clearSchedTimer(conv);
    this.finishing.delete(conv);
    this.dropManagerTurn(conv, "interrupted"); // Q4: session retiring — don't drain its queue
    this.reports.delete(conv);
    const t = this.reportTimers.get(conv);
    if (t) {
      clearTimeout(t);
      this.reportTimers.delete(conv);
    }
  }

  /** Delegates to ./orchestrator/topics.ts (kept as a method: tests call it directly). */
  async onTopicDeleted(conv: ConvKey): Promise<void> { return onTopicDeleted(this, conv); }

  /** Delegates to ./orchestrator/topics.ts (kept as a method: tests call it directly). */
  async reapPendingTopicDeletes(): Promise<void> { return reapPendingTopicDeletes(this); }

  private async handleApprovalCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const lang = this.h.userPrefs?.getLang(cb.from?.id ?? "") ?? "vi";
    const [, id, op] = (cb.data ?? "").split(":");
    const a = this.approvals.get(id);
    if (!a || a.chat !== chatOf(conv)) {
      await this.h.tg.answerCallbackQuery(cb.id, tr(lang, "Yêu cầu này đã hết hạn.", "This request has expired."));
      if (messageId) await this.h.tg.editMessageText(conv, messageId, tr(lang, "⌛ Yêu cầu này đã hết hạn (bot đã khởi động lại hoặc đã xử lý).", "⌛ This request has expired (the bot restarted or already handled it)."), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    this.approvals.delete(id);
    await this.h.tg.answerCallbackQuery(cb.id);
    const what = a.kind === "spawn" ? tr(lang, `tạo worker ${a.spawn?.name}`, `create worker ${a.spawn?.name}`) : tr(lang, `gửi việc cho ${a.send?.name}`, `assign work to ${a.send?.name}`);
    const auditText = a.kind === "spawn" ? `spawn ${a.spawn?.name}: ${a.spawn?.task ?? ""}` : `send ${a.send?.name}: ${a.send?.message ?? ""}`;
    if (op === "no") {
      audit({ action: "dispatch_reject", userId: cb.from?.id, chatId: a.chat, outcome: "rejected", text: auditText });
      if (messageId) await this.h.tg.editMessageText(conv, messageId, tr(lang, `❌ Đã huỷ: ${esc(what)}.`, `❌ Cancelled: ${esc(what)}.`)).catch(() => {});
      queueReport(this, a.chat, `[approval #${id}] REJECTED by the user: ${what}. Do not retry it; ask the user what to do instead if needed.`);
      return;
    }
    if (op === "auto") this.h.st.set(a.chat, { auto: true });
    try {
      const result = await this.execApproved(a);
      audit({ action: "dispatch_approve", userId: cb.from?.id, chatId: a.chat, outcome: op === "auto" ? "ok+auto_on" : "ok", text: auditText });
      if (messageId) {
        await this.h.tg
          .editMessageText(conv, messageId, tr(lang, `✅ Đã duyệt: ${esc(what)}.${op === "auto" ? "\n⚡ Auto đã bật — các lần sau không hỏi nữa (/auto off để tắt)." : ""}`, `✅ Approved: ${esc(what)}.${op === "auto" ? "\n⚡ Auto mode on — no more prompts (/auto off to disable)." : ""}`))
          .catch(() => {});
      }
      queueReport(this, a.chat, `[approval #${id}] APPROVED by the user: ${result}.${op === "auto" ? " Auto mode is now on." : ""}`);
    } catch (e) {
      const msg = (e as Error).message;
      audit({ action: "dispatch_approve", userId: cb.from?.id, chatId: a.chat, outcome: `error: ${msg}`, text: auditText });
      if (messageId) await this.h.tg.editMessageText(conv, messageId, tr(lang, `⚠️ Duyệt nhưng thất bại: ${esc(msg)}`, `⚠️ Approved but failed: ${esc(msg)}`)).catch(() => {});
      queueReport(this, a.chat, `[approval #${id}] approved but FAILED: ${msg}`);
    }
  }

  // ── worktree actions ──────────────────────────────────────────────────────
  private worktreeText(w: WorkerInfo, lang: Lang = "vi"): string {
    return [
      tr(lang, `🌿 <b>Worktree của ${esc(w.name)}</b>`, `🌿 <b>Worktree of ${esc(w.name)}</b>`),
      tr(lang, `nhánh <code>${esc(w.worktree?.branch ?? "")}</code> → base <code>${esc(w.worktree?.base ?? "")}</code>`, `branch <code>${esc(w.worktree?.branch ?? "")}</code> → base <code>${esc(w.worktree?.base ?? "")}</code>`),
      tr(lang, "Xem diff, merge về nhánh gốc, hoặc xoá worktree.", "View the diff, merge back to the base branch, or delete the worktree."),
    ].join("\n");
  }

  /**
   * S4 (docs/sdd/next-step-buttons.md, N2): the Review row for a worker that
   * just finished done — or undefined when no rule fires. Fires only for a
   * WRITING worker (N2.2); the engine (decide) applies the rest. The one
   * getSessionReport call happens only after those cheap gates.
   *
   * Fingerprint-first (same semantics as the plain-session row, PR #142): when
   * both the spawn-time baseline (w.fpBase) and a fresh working-tree
   * fingerprint are available, "new changes" means the two differ — which sees
   * files created or rewritten through the shell, invisible to the session
   * report. When either is missing (feature off at spawn, not a git repo, git
   * failed, too many changed paths), fall back to the report and count only a
   * file it lists that was not offered before. An empty report is never
   * treated as "changed".
   */
  private async workerReviewRow(conv: ConvKey, s: ChatState, w: WorkerInfo, lang: Lang): Promise<Btn[] | undefined> {
    // N4.1: off → identical to today (no decide, no getSessionReport call).
    if (!this.h.cfg.nextSteps) return undefined;
    // N2.2: read-only workers (plan/explore/general, writes=false) never get a Review.
    if (w.writes !== true || !s.sessionID) return undefined;
    let files: string[];
    try {
      files = (await this.h.oc.getSessionReport(s.sessionID)).modifiedFiles;
    } catch {
      return undefined; // report unavailable → no offer (never block the worker-done relay)
    }
    const seen = this.workerReviewFiles.get(conv);
    // Fingerprint-first: compare the spawn-time baseline against the working
    // tree now. The report above is the fallback when a fingerprint is missing,
    // and it still defines the offered-file set.
    const fpAfter = s.directory ? await gitFingerprint(s.directory) : undefined;
    const filesNew = computeFilesNew({ before: w.fpBase, after: fpAfter, reportFiles: files, seen });
    if (!filesNew) return undefined;
    const now = Date.now();
    const facts: NextStepFacts = {
      kind: "worker",
      outcome: "succeeded",
      interrupted: false,
      agent: s.agent ?? "build",
      elapsedMs: 0, // the worker review row has no minimum-length gate (that's the plain row's)
      worker: { writes: true, hasWorktree: !!w.worktree },
      busyWorkers: 0,
      filesNew,
      overflow: false,
      hasChoices: false,
      // The worktree card is NOT a next-step keyboard: the Review row is
      // appended to it (worker with a worktree) or sent as a short line (without).
      hasOtherKeyboard: false,
    };
    const suggestion = decide(facts, { nextSteps: this.h.cfg.nextSteps, minSecs: this.h.cfg.nextMinSecs }, now).find((x) => x.rule === "review");
    if (!suggestion) return undefined;
    const id = nsRegistry.set({ conv, sessionID: s.sessionID, rule: "review", now });
    // N2.3: this offer now defines the last-offered set for this worker topic.
    this.workerReviewFiles.set(conv, new Set(files));
    // The baseline rolls forward with the offer: what was just offered is no
    // longer "new" for the next turn. Read the CURRENT state first — setStatus
    // already replaced `w` in the store (status/lastResult) before this row.
    if (fpAfter !== undefined) {
      const cur = this.h.st.peek(conv)?.worker;
      this.h.st.set(conv, { worker: { ...(cur ?? w), fpBase: fpAfter } });
    }
    // N4.3: shown event for the worker review button.
    audit({ action: "nextstep_shown", chatId: conv, session: s.sessionID, userId: s.createdBy, meta: { rule: "review" } });
    return [{ text: suggestion.label(lang), callback_data: callbackFor(id, 0) }];
  }

  private worktreeKeyboard(w: WorkerInfo, lang: Lang = "vi"): Keyboard {
    return {
      inline_keyboard: [
        [
          { text: "📄 Diff", callback_data: `wt:${w.name}:diff` },
          { text: "🔀 Merge", callback_data: `wt:${w.name}:merge` },
        ],
        [{ text: tr(lang, "🗑 Xoá worktree", "🗑 Delete worktree"), callback_data: `wt:${w.name}:rm` }],
      ],
    };
  }

  private async handleWorktreeCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const lang = this.h.userPrefs?.getLang(cb.from?.id ?? "") ?? "vi";
    const [, name, op] = (cb.data ?? "").split(":");
    const found = this.h.st.findWorker(conv, name);
    const w = found?.[1].worker;
    if (!found || !w?.worktree || !w.repoRoot) {
      await this.h.tg.answerCallbackQuery(cb.id, tr(lang, "Worktree không còn.", "The worktree no longer exists."));
      return;
    }
    const wt = w.worktree;
    if (BUSY.includes(w.status) && op !== "diff") {
      await this.h.tg.answerCallbackQuery(cb.id, tr(lang, "Worker đang chạy — /kill hoặc chờ xong rồi thử lại.", "The worker is running — /kill or wait for it to finish and try again."));
      return;
    }
    await this.h.tg.answerCallbackQuery(cb.id);
    try {
      if (op === "diff") {
        await this.h.sendHtml(conv, `${tr(lang, `📄 <b>Diff ${esc(wt.branch)}</b> so với`, `📄 <b>Diff ${esc(wt.branch)}</b> vs`)} <code>${esc(wt.base)}</code>\n<pre>${esc(await diffSummary(wt))}</pre>`);
      } else if (op === "merge") {
        await this.h.sendHtml(conv, `🔀 ${esc(await mergeWorktree(w.repoRoot, wt, w.name, lang))}`);
      } else if (op === "rm") {
        // Uncommitted work is COMMITTED to the worker branch first (not lost) —
        // only the worktree directory is removed; an unmerged branch is kept.
        // So the user loses nothing here, which the warning must say correctly.
        await this.h.sendHtml(conv, tr(lang, "⚠️ Xoá worktree sẽ <b>commit các thay đổi chưa commit vào nhánh</b> của worker rồi xoá thư mục worktree (nhánh chưa merge vẫn được giữ — không mất gì). Chắc chắn?", "⚠️ Deleting the worktree will <b>commit uncommitted changes to the worker branch</b>, then remove the worktree directory (the unmerged branch is kept — nothing lost). Sure?"), {
          reply_markup: { inline_keyboard: [[{ text: tr(lang, "🗑 Xoá thật", "🗑 Delete for real"), callback_data: `wt:${w.name}:rmok` }, { text: tr(lang, "Thôi", "No, keep"), callback_data: `wt:${w.name}:keep` }]] },
        });
      } else if (op === "rmok") {
        let msg: string;
        try {
          msg = await removeWorktree(w.repoRoot, wt, lang);
        } catch (e) {
          // The preservation commit or the worktree removal failed. This path had
          // no commit step before, so a failure here is new — surface it clearly.
          // (The generic catch below shows it as ❌.)
          throw new Error(`${tr(lang, "Xoá worktree thất bại:", "Deleting the worktree failed:")} ${(e as Error).message.split("\n")[0]}`);
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
    const tools: BridgeTool[] = [
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
          await this.h.sendHtml(conv, "⏹ " + tr(this.langOf(conv), "Manager đã dừng worker này.", "The Manager stopped this worker.")).catch(() => {});
          return `Stopped "${this.h.st.get(conv).worker!.name}".`;
        },
      },
      // Zero-context sandbox: runs a script and returns only its final result.
      // The bridge has no per-session scoping, so it is offered to every caller
      // of this route (the sandbox guards keep it safe).
      makeRunScriptTool(),
    ];
    if (this.h.advisor) {
      const adv = this.h.advisor;
      const cap = this.h.cfg.advisorMaxTurnsPerSession;
      tools.push(
        {
          name: "list_advisor_threads",
          description:
            "List open advisor threads in this chat: id, agent, title, turns used. Pass an id to consult(threadId=...) to continue it.",
          inputSchema: { type: "object", properties: {} },
          run: async () => {
            const ts = adv.listThreads(chat);
            if (!ts.length) return "No open advisor threads.";
            return ts
              .map((t) => `- id ${parseConv(t.conv).threadId} · ${agentLabel(t.agent)} · ${t.title} · ${t.turns}/${cap} turns · ${timeAgo(t.lastActive)}`)
              .join("\n");
          },
        },
        {
          name: "consult",
          description:
            "Ask a different model (Claude or Gemini, on the advisor machine) for a second opinion — a hard design decision, a risky assumption, or a plan review. " +
            "It advises only and does NOT run code, so put any relevant context (code snippets, constraints, prior decisions) in `context`. " +
            "It opens a topic the user can also join. To continue a previous thread pass its `threadId` (from list_advisor_threads); omit for a fresh one. " +
            `\`agent\` picks the model for a NEW thread (default ${agentLabel(this.h.cfg.advisorDefaultAgent)}); a continued thread keeps its own.`,
          inputSchema: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question or decision you want a second opinion on" },
              context: { type: "string", description: "Relevant context: code snippets, constraints, prior decisions" },
              threadId: { type: "number", description: "Continue an existing advisor thread (id from list_advisor_threads)" },
              agent: {
                type: "string",
                enum: Object.values(AGENTS).flatMap((x) => [x.id, ...x.aliases]),
                description: "Model for a new thread: claude, or gemini (alias agy)",
              },
            },
            required: ["question"],
          },
          run: async (a) => {
            const question = String(a.question ?? "").trim();
            if (!question) throw new Error("question is required");
            const context = a.context ? String(a.context) : undefined;
            const agent = a.agent !== undefined ? resolveAgent(String(a.agent)) : undefined;
            if (a.agent !== undefined && !agent) throw new Error(`Unknown agent "${String(a.agent)}" — use claude or gemini.`);
            if (a.threadId !== undefined) {
              const want = Number(a.threadId);
              const conv = this.h.st.convsOfChat(chat).find(([c]) => parseConv(c).threadId === want && this.h.st.peek(c)?.advisor)?.[0];
              if (!conv) throw new Error(`No advisor thread with id ${want}. Call list_advisor_threads.`);
              const { answer, capped } = await adv.followUp(conv, question);
              const tid = parseConv(conv).threadId;
              return `${answer.answer}\n\n[advisor thread id ${tid}${capped ? " — CAP REACHED: start a new thread (no threadId) for the next question" : ""}]`;
            }
            const r = await adv.startThread({ chat, title: question.replace(/\s+/g, " ").slice(0, 60), message: question, context, agent });
            return `${r.answer.answer}\n\n[advisor thread id ${r.threadId} — pass it as threadId to continue this thread]`;
          },
        },
      );
    }
    return tools;
  }
}
