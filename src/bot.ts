import { isAbsolute, resolve, dirname, join } from "node:path";
import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes, randomInt } from "node:crypto";
import { Telegram, Update, CallbackQuery, Message, MessageGenerationStopped, MessageReactionUpdated, topicMessageUrl } from "./telegram.js";
import { OpenCodeCtl, newMessageID, assistantText, ModelInfo, SessionBrief } from "./opencode.js";
import { StateManager, ChatState, MsgPurpose, MACHINE_STATE_KEY } from "./state.js";
import { ConvKey, convKey, chatOf, parseConv } from "./conv.js";
import { Orchestrator } from "./orchestrator.js";
import { ScheduleStore } from "./scheduler.js";
import { ScheduledRuns } from "./scheduled-run.js";
import { SessionTopics, TITLE_POLICY_LABELS, type SessionTopic, type TopicTitlePreview } from "./session-topics.js";
import { SessionDashboard, dashboardPage, DASHBOARD_FILTERS, DASHBOARD_WORK_LABELS, DASHBOARD_PHASE_LABELS, type DashboardFilter } from "./session-dashboard.js";
import { SessionActivityLog, ACTIVITY_SOURCE_LABELS } from "./session-activity.js";
import { buildSessionSummary } from "./session-summary.js";
import { ResumeConfirmations, type ResumeConfirmation } from "./session-resume.js";
import { Notifications, type Notice, type NoticeKind } from "./notifications.js";
import { Schedule, SchedSpec, formatSchedule, nextRunAfter, parseScheduleSpec } from "./schedule.js";
import { Config } from "./config.js";
import { esc, stripTags, chunk, trunc, mdToHtmlChunks, fmtNum, timeAgo, formatTurnFailure, topicTitle } from "./format.js";
import { richMarkdownChunks } from "./rich.js";
import { scheduleForRegistration, reminderBudgetExhausted, nextScheduleAfterReminder, clampTimerDelay, stalePromptIds } from "./reminders.js";
import {
  classifyAction,
  decideSpawn,
  decideApprove,
  indexKey,
  reactedKey,
  alreadyReacted,
  pruneIndex,
  pruneReacted,
  REACT_INDEX_CAP,
  REACTED_CAP,
  REACT_TEXT_MAX,
  REACTION_CELEBRATE,
  REACTION_FAIL,
} from "./reactions.js";
import { CONTINUE_PROMPT, CONTINUE_BUTTON_LABEL, shouldOfferContinue, continueCallbackData, parseContinueData, alreadyOfferedContinue } from "./continue.js";
import { PrSnapshot, PrState, diffSnapshots, renderEvent } from "./pr-watch.js";
import { parseProcUptime, shouldRemindAboutReboot, formatUptimeHuman, msPerDay, SAFE_REBOOT_BIN, rebootTokenFile, buildTokenLine, rebootGoData, isRebootConfirmFresh } from "./uptime.js";
import { toolActivityLabel, activityDoneLine } from "./activity.js";
import { DraftState, DraftAction, onTextDelta, onToolStart, isDmConv, EDIT_BUDGET } from "./stream.js";
import { myCommands, helpText, commandGrid, commandScope } from "./commands.js";
import { UsageRow, formatUsageReport } from "./usage.js";
import { appendNote, dropNotes, noteEntryText, prepareNotes, showNotes, BUSY_REPLY_TEXT, NOTE_BUTTON_LABEL, NOTE_CB_PREFIX, noteCallbackData, parseNoteCallback, BusyNoteStore } from "./notes.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "./fsbrowser.js";
import { log, warn, error } from "./logger.js";

/** Agents shown to the user (the rest are internal OpenCode roles). */
const AGENT_WHITELIST = ["build", "general", "explore", "plan"];

/** The message carries media (sticker/photo/video/voice/…) — used to acknowledge non-text input. */
function hasNonTextContent(m: Message): boolean {
  return Boolean(m.sticker || m.photo || m.video || m.voice || m.audio || m.document || m.animation);
}

/**
 * User-facing "modes" — a small, curated set of operating styles the user can
 * flip between with one command. A mode is just a friendlier label for an
 * OpenCode agent (the thing that actually changes behaviour), so `/mode` is a
 * higher-level front-end over `/agent` for the two workflows people switch
 * between most: planning vs building. The current mode is derived from the
 * session's agent, so /agent and /mode can never disagree.
 */
const MODES: Record<string, { agent: string; hint: string }> = {
  build: { agent: "build", hint: "mặc định — viết & sửa code theo permission" },
  plan: { agent: "plan", hint: "chỉ phân tích & lên kế hoạch — không sửa code" },
  general: { agent: "general", hint: "đa dụng: research, multi-step, chạy song song" },
  explore: { agent: "explore", hint: "duyệt codebase nhanh (tìm file/keyword)" },
};

/** Directory buttons shown per page in the folder browser. */
const BROWSE_PAGE_SIZE = 12;
/** Directory buttons per row in the folder browser. */
const BROWSE_COLUMNS = 2;
/** Models shown per page in the /model button picker. */
const MODEL_PAGE_SIZE = 10;

/**
 * Preamble prepended to the FIRST prompt of each session so the agent knows it is
 * headless (driven via Telegram) and should ask decisions through the `question`
 * tool — which we relay to the user as Telegram buttons — one question at a time.
 */
const QUESTIONS_PREAMBLE =
  "[System note: You are running headless, driven through Telegram — the user has no terminal. " +
  "When you need a decision or input from the user, ask with the `question` tool using clear " +
  "multiple-choice options, ONE question at a time; the user answers via Telegram buttons. " +
  "Prefer asking over guessing when genuinely ambiguous.]";

/** Key under which the per-session language instruction is stored (namespaced `api/<key>`). */
const LANGUAGE_INSTRUCTION_KEY = "tgbot.language";
/** Instruction-entry key for /note scratchpad notes (see src/notes.ts). */
const NOTES_KEY = "tgbot.notes";
/** Instruction key for /new --keep carry-over (recent-thread summary injected into the fresh session). */
const CARRYOVER_KEY = "tgbot.carryover";
/** Injected per-session so the model keeps the user's language and does not leak CJK. */
const LANGUAGE_INSTRUCTION =
  "Always reply in the SAME language the user wrote in, throughout the entire answer. Do NOT " +
  "switch to or mix in any other language (e.g. Chinese, English) within the same reply — this " +
  "includes code comments, labels, and short phrases.";

/** True when an error is a network-level "Transport: fetch failed" blip. */
function isTransportError(e: any): boolean {
  if (!e) return false;
  if (e.reason === "Transport" || e.cause?.reason === "Transport") return true;
  const msg = `${e.cause?.message ?? ""} ${e.message ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|EPROTO|ETIMEDOUT|EAI_AGAIN|socket hang up|network .*unreachable|UND_ERR_[A-Z]+/i.test(
    msg,
  );
}

type Btn = { text: string; callback_data: string; url?: never } | { text: string; url: string; callback_data?: never };
type Keyboard = { inline_keyboard: Btn[][] };

/** In-memory state of the folder browser, one per chat. */
interface BrowseState {
  path: string;
  showHidden: boolean;
  items: DirItem[];
  page: number;
  view: "list" | "choose" | "done";
  /** One-off message shown above the listing (e.g. a clamped path). */
  note?: string;
  /** Set when the directory could not be read. */
  error?: string;
  /** Result of the last "open this folder" action. */
  result?: string;
  /** True once a session was started from this folder. */
  opened: boolean;
}

/** A single visible field of a question form, as we relay it to Telegram. */
interface QField {
  key: string;
  title?: string;
  description?: string;
  type: string;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
  required?: boolean;
}

/**
 * In-flight question form. Fields are shown one at a time ("hỏi từng câu");
 * answers are collected and submitted to OpenCode all at once via `form.reply`.
 */
interface QuestionFormState {
  formId: string;
  sessionID: string;
  conv: ConvKey;
  messageId?: number;
  fields: QField[];
  index: number;
  answers: Record<string, any>;
  /** Set (to the field index) while waiting for the user to type a custom answer. */
  waitingCustom?: number;
}

/** A pending OpenCode permission request relayed to Telegram (buttons to answer it). */
interface PermissionPrompt {
  requestID: string;
  sessionID: string;
  conv: ConvKey;
  messageId: number;
}

/**
 * GitHub PR list item (the subset the watcher uses), from GET /pulls?...
 */
interface GhPr {
  number: number;
  state: "open" | "closed";
  title: string;
  updated_at: string;
  merged_at: string | null;
  head: { sha: string; ref: string };
}

/**
 * Glue between Telegram and OpenCode. Owns per-chat state and the in-flight
 * prompt task, so a running prompt never blocks the polling loop and /stop
 * can interrupt it.
 */
export class Bot {
  private inflight = new Map<ConvKey, AbortController>();
  private browsers = new Map<ConvKey, BrowseState>();
  private questionForms = new Map<string, QuestionFormState>();
  private permissionPrompts = new Map<string, PermissionPrompt>();
  /** Repeating "typing…" timers, one per chat, so the indicator lasts until the reply is sent. */
  private typing = new Map<ConvKey, ReturnType<typeof setInterval>>();
  /** Chats whose unrelayed-reply sweep is currently running (prevents a double relay). */
  private sweeping = new Set<ConvKey>();
  /**
   * Pending-prompt reminder timers, keyed by `${conv}::${promptId}` (one per
   * pending form/permission, so a conv's form and permission don't share a slot).
   * Exponential backoff — see cfg.remind*.
   */
  private reminders = new Map<string, ReturnType<typeof setTimeout>>();
  private uptimeTimer?: ReturnType<typeof setInterval>;
  private prWatchTimer?: ReturnType<typeof setInterval>;
  /** True while a PR-watch tick is running, so a slow tick can't overlap the next. */
  private prWatchBusy = false;
  /** A reboot is already armed (token minted, timer pending) — ignores a double-tap on "Xác nhận". */
  private rebootArmed = false;
  /** Sessions from which we already stripped the language instruction this process (when the toggle is off), so we don't call removeInstruction every prompt. */
  private languageRemoved = new Set<string>();
  /** The self-editing "agent is doing…" line per conv: message id + current label. */
  private activity = new Map<ConvKey, { msgId: number; label: string; toolStart: number }>();
  /** The "⏳ Đang xử lý…" line per conv (General top-level only): msgId once sent + the elapsed-time timer. */
  private working = new Map<ConvKey, { msgId?: number; startedAt: number; timer?: ReturnType<typeof setInterval> }>();
  /** Tool-call id → tool name per conv (learned from session.tool.input.started). */
  private toolNames = new Map<ConvKey, Map<string, string>>();
  /**
   * Live streaming-draft state per conv (Bot API 10.1+ sendMessageDraft).
   * One wrapper per conversation while a turn streams; the wrapper survives
   * the turn exit with its preview killed (previewMsgId = 0) so late deltas
   * of the same turn cannot resurrect a stray preview after the final reply.
   * The next turn starts clean (runPromptTask deletes the entry). Pure
   * preview — the final-reply path is independent.
   */
  private drafts = new Map<
    ConvKey,
    { state: DraftState | null; previewMsgId?: number; throttleMs: number; nextEditAt: number; budget: number; gen: number }
  >();

  /**
   * Per-conv turn generation, bumped at the start of every turn and again when
   * the preview is dropped (turn end / stop). A streaming wrapper only pushes
   * preview updates while its generation still matches — this is what kills
   * the race where a late delta of a finished turn would otherwise spawn a
   * stray preview message after the final reply.
   */
  private turnGen = new Map<ConvKey, number>();
  /**
   * Retention for the "📝 Thêm vào note" busy-reply button: user messages that
   * arrived while the agent was busy, keyed by conv (capped, oldest dropped),
   * cleared when the turn ends or on /stop so a stale tap is "not found". One
   * shared instance — handed to the Orchestrator so the Manager's busy reply
   * retains into the same store and taps are handled identically.
   */
  private busyNotes = new BusyNoteStore();
  /** Open /model button pickers, one per conv (in-memory; dead buttons after a restart are handled). */
  private modelPickers = new Map<ConvKey, { models: ModelInfo[]; page: number }>();
  /** The user's most recent top-level chat, for proactive notices (e.g. DNS heal). */
  private lastActiveConv?: ConvKey;
  /** Reaction UX: index keys already logged as "not indexed", so a reaction storm doesn't spam the log. */
  private missingIdxLogged = new Set<string>();

  /** Worker topics + the Manager agent (multi-session layer). */
  private orch: Orchestrator;
  /** Schedules, in their own file (data/schedules.json) — /clear must never touch them. */
  private scheduleStore: ScheduleStore;
  /** Khôi phục lượt cũ luôn chạy; cfg.schedule chỉ chặn nhận lượt mới. */
  private scheduler?: ScheduledRuns;
  private topics: SessionTopics;
  private dashboard: SessionDashboard;
  private sessionActivity: SessionActivityLog;
  private resumeConfirmations: ResumeConfirmations;
  private notifications: Notifications;
  private noticePreviews = new Map<string, { chat: ConvKey; user: number; revision: number; expires: number }>();
  private resumeInputs = new Map<string, { id: string; token: string; messageID: number; binding: string; marker: string; expires: number }>();
  private activityReads = new Map<ConvKey, Promise<void>>();
  private activityAgain = new Set<ConvKey>();
  private activityAborts = new Map<ConvKey, AbortController>();
  private activityStopped = false;
  private summaryCards = new Map<string, { chat: ConvKey; user: number; id: string; binding: string; marker: string; expires: number }>();
  private summaryRefreshes = new Map<string, { at: number; refreshedAt?: number; error?: string }>();
  private summaryLoads = new Map<string, Promise<{ at: number; refreshedAt?: number; error?: string }>>();
  private summaryAborts = new Set<AbortController>();
  private dashboardCards = new Map<string, { chat: ConvKey; user: number; expires: number; filter: DashboardFilter; page: number }>();
  private pendingCards = new Map<string, { chat: ConvKey; user: number; expires: number; linkID: string; sessionID: string; identity: string;
    items: Array<{ id: string; kind: "form" | "permission" }> }>();
  private topicTimer?: ReturnType<typeof setInterval>;
  private topicSync?: Promise<void>;
  private topicSyncAgain = false;
  private topicAnnouncements = new Map<string, string>();
  private titlePreviews = new Map<ConvKey, { token: string; user: number; expires: number; rows: TopicTitlePreview[]; stamp: string }>();
  private titleSettings = new Map<string, { chat: ConvKey; user: number; expires: number; id?: string; stamp: string; preview?: TopicTitlePreview; customName?: string }>();
  private titleInputs = new Map<string, { chat: ConvKey; id: string; token: string; expires: number; messageID: number; stamp: string }>();

  constructor(
    private tg: Telegram,
    private oc: OpenCodeCtl,
    private st: StateManager,
    private cfg: Config,
  ) {
    // Same data dir as state.json (derived from cfg.stateFile); a SEPARATE file
    // on purpose so /clear and the per-chat sweeps can't wipe schedules.
    this.scheduleStore = new ScheduleStore(
      join(dirname(this.cfg.stateFile), "schedules.json"),
      this.cfg.maxSchedules,
    );
    this.sessionActivity = new SessionActivityLog(st);
    this.resumeConfirmations = new ResumeConfirmations(st);
    this.notifications = new Notifications(st, { now: () => Date.now(), deliver: (chat, text, links) => tg.sendMessageId(chat, text,
      { reply_markup: { inline_keyboard: links.map(link => [link]) } }), edit: async (chat, id, text, links) => {
        await tg.editMessageText(chat, id, text, { reply_markup: { inline_keyboard: links.map(link => [link]) } });
      }, resolve: event => this.resolveNotice(event) });
    this.topics = new SessionTopics(st, {
      createSession: (input) => oc.createTopicSession(input),
      session: (id) => oc.topicSession(id),
      sessionTitle: (id) => oc.topicSessionTitle(id),
      renameTopic: (conv, title) => tg.editForumTopic(conv, title),
      createTopic: (chat, title) => tg.createForumTopic(Number(chat), title),
      archive: (id, archived) => oc.archiveSession(id, archived),
      closeTopic: (conv) => tg.closeForumTopic(conv),
      openTopic: (conv) => tg.openForumTopic(conv),
      configure: (id, state) => this.applyModelAndVariant(id, state),
      stop: async (link) => {
        if (!link.conv || !link.sessionID) return false;
        const scheduler = this.scheduler;
        const scheduled = scheduler?.owns(link.conv);
        if (scheduled && scheduler) {
          await scheduler.requestStop(link.conv);
          await scheduler.recover(true, link.sessionID);
          if (scheduler.owns(link.conv)) return false;
        }
        let snapshot = await oc.topicSession(link.sessionID);
        const matches = () => snapshot.id === link.sessionID && snapshot.projectID === link.identity?.projectID &&
          snapshot.source === link.identity.source && snapshot.createdAt === link.identity.createdAt;
        if (!matches()) return false;
        if (snapshot.busy || !snapshot.terminal) {
          if (scheduled) return false;
          await oc.interruptTopicSession(link.sessionID);
          snapshot = await oc.topicSession(link.sessionID);
        }
        if (!matches()) return false;
        if (snapshot.busy || !snapshot.terminal) return false;
        this.inflight.get(link.conv)?.abort();
        this.stopTyping(link.conv);
        this.stopWorking(link.conv);
        this.clearActivity(link.conv);
        void this.dropPreview(link.conv).catch(() => {});
        this.cancelAllReminders(link.conv);
        for (const [id, form] of this.questionForms) if (form.conv === link.conv && form.sessionID === link.sessionID) this.questionForms.delete(id);
        for (const [id, prompt] of this.permissionPrompts) if (prompt.conv === link.conv && prompt.sessionID === link.sessionID) this.permissionPrompts.delete(id);
        this.orch.clearManagerBusy(link.conv);
        const worker = this.st.peek(link.conv)?.worker;
        if (worker) this.st.set(link.conv, { worker: { ...worker, status: "stopped", updatedAt: Date.now() } });
        return true;
      },
    });
    this.dashboard = new SessionDashboard({ store: st, topics: this.topics,
      observe: (id, signal) => oc.dashboardObservation(id, signal), timeoutMs: 3000 });
    this.orch = new Orchestrator({
      tg,
      oc,
      st,
      cfg,
      topics: this.topics,
      activity: this.sessionActivity,
      stopTopicWork: (conv) => this.stopManagedTopic(conv),
      busyNotes: this.busyNotes,
      sendHtml: (conv, html, opts) => this.sendHtml(conv, html, opts),
      applyModelAndVariant: (sid, state) => this.applyModelAndVariant(sid, state),
      prepareNotes: (conv, sid) => this.prepareNotesTurn(conv, sid),
      startTyping: (conv) => this.startTyping(conv),
      startWorking: (conv) => this.startWorking(conv),
      stopWorking: (conv) => this.stopWorking(conv),
      scheduledStop: (conv) => this.scheduler?.requestStop(conv) ?? Promise.resolve(false),
      onScheduledFinished: async (conv) => {
        this.stopTyping(conv);
        this.clearActivity(conv);
        await this.dropPreview(conv);
        await this.sweepUnrelayedReplies(conv, "lượt chạy lịch đã kết thúc");
      },
      onTopicGone: async (conv) => {
        // The topic is gone and the conv is being purged NOW (not the deferred
        // running-worker case, where the worker is allowed to finish). Fully stop
        // any in-flight turn for a normal/manager topic — typing, the self-editing
        // activity line, the inflight AbortController, the manager-busy flag, and a
        // server-side interrupt — so nothing keeps sending into the dead topic and
        // re-failing. Then cancel its reminder nudges.
        await this.stopCurrent(conv, true);
        // stopCurrent's server interrupt requires an inflight AbortController —
        // manager turns are fire-and-forget and never have one, so interrupt
        // explicitly (no-op if the session is idle). Without this, deleting a
        // manager topic mid-turn leaves the server-side prompt running (tokens
        // burned) even though removeSession then retires the session.
        const sid = this.st.peek(conv)?.sessionID;
        if (sid) await this.oc.interrupt(sid).catch((e) => warn("interrupt:", e?.message));
        this.cancelAllReminders(conv);
      },
    });
    // A forum topic deleted in the UI sends no Telegram event (Bot API 10.3 has
    // none) — the only signal is a send into it failing with "message thread
    // not found". Retire the conversation (state/session/worktree) on first hit.
    this.tg.onThreadNotFound = (chatId, threadId) => {
      void this.orch.onTopicDeleted(convKey(chatId, threadId)).catch((e) => warn("onTopicDeleted:", (e as Error)?.message ?? e));
    };
    // Reaction UX (OPENCODE_TG_REACT): user reactions on indexed messages.
    this.tg.onMessageReaction = (ev) => this.onMessageReaction(ev);
    try {
      this.scheduler = new ScheduledRuns({
        now: () => Date.now(), store: this.scheduleStore, execution: this.orch.scheduledExecution(),
        enabled: () => this.cfg.schedule, isAllowed: (uid) => this.cfg.allowAny || this.cfg.allowedUserIds.includes(uid),
        notify: (conv, text) => this.tg.sendMessage(conv, text),
        timeoutMs: this.cfg.scheduleTimeoutMs, graceMs: this.cfg.scheduleGraceMs,
      });
    } catch {
      warn("Không đọc được dữ liệu lượt chạy; tạm chặn chạy lịch, giữ nguyên file để kiểm tra.");
    }
  }

  /** Begin relaying OpenCode question forms to Telegram. Called once from index.ts. */
  start(): void {
    this.activityStopped = false;
    this.oc.subscribeEvents(
      (ev) => this.onOpenCodeEvent(ev),
      (e) => warn("event stream:", e?.message ?? e),
      () => {
        this.topics.requestTitleSync(undefined, true);
        void this.reconcileTopics().catch(() => warn("Session/topic reconciliation failed."));
        void this.scheduler?.recover().catch((e) => warn("khôi phục lượt chạy:", e?.name));
        void this.orch.onConnect().catch((e) => warn("orchestrator:", e?.message));
        void this.reconcile().catch((e) => warn("reconcile:", e?.message));
      },
    );
    // Resume any pending-prompt reminder nudges that were scheduled before a restart.
    this.resumePromptReminders();
    // Deadline của lượt đã nhận vẫn phải được khôi phục khi công tắc lịch tắt.
    this.scheduler?.start();
    this.notifications.start();
    this.topics.requestTitleSync(undefined, true);
    void this.reconcileTopics().catch(() => warn("Session/topic reconciliation failed."));
    if (!this.topicTimer) {
      this.topicTimer = setInterval(() => {
        this.topics.requestTitleSync();
        void this.reconcileTopics().catch(() => warn("Session/topic reconciliation failed."));
      }, 60_000);
      this.topicTimer.unref?.();
    }
    // Close topics left open by workers that finished before auto-close existed
    // (or while the service was down). Fire-and-forget; never fails startup.
    void this.orch.closeFinishedTopicsAtStartup().catch((e) => warn("startup topic close:", e?.message));
    // Register the Telegram /command autocomplete menu (cosmetic, best-effort).
    this.registerCommands();
    // Nudge the user to reboot the machine when uptime passes the threshold
    // (kernel updates only apply after a reboot). Runs once now, then every 6 hours.
    this.startUptimeMonitor();
    // Post one line per new PR event (merged / comment / CI / review) on the
    // watched GitHub repo. Default OFF; see cfg.prWatch*.
    this.startPrWatchMonitor();
  }

  /** Stop the /schedule tick engine (called from index.ts during shutdown). */
  stopScheduler(): void {
    this.activityStopped = true;
    for (const controller of this.activityAborts.values()) controller.abort();
    this.activityAgain.clear();
    for (const controller of this.summaryAborts) controller.abort();
    this.summaryCards.clear();
    this.resumeInputs.clear();
    this.scheduler?.stop();
    this.notifications.stop();
    this.noticePreviews.clear();
    this.orch.shutdown();
    this.topics.stopTitleSync();
    this.titlePreviews.clear();
    this.titleSettings.clear();
    this.titleInputs.clear();
    this.dashboardCards.clear();
    this.pendingCards.clear();
    if (this.topicTimer) clearInterval(this.topicTimer);
    this.topicTimer = undefined;
  }

  // ── Uptime monitor + reboot ─────────────────────────────────────────────────
  /**
   * Kick off the machine-uptime watcher: check now, then re-check every 6 hours. The
   * box runs 24/7 for the bot, but kernel security updates only take effect
   * after a reboot, so once uptime passes the threshold we nudge the user to
   * reboot (with a two-step-confirmed button — see note #4's operational rule).
   */
  private startUptimeMonitor(): void {
    if (!this.cfg.uptimeMonitor) return;
    void this.checkUptimeAndRemind();
    this.uptimeTimer = setInterval(() => void this.checkUptimeAndRemind(), 6 * 3600 * 1000);
    this.uptimeTimer.unref?.();
  }

  /**
   * Read /proc/uptime and, if we've crossed the reboot threshold and haven't
   * reminded within the snooze interval, send the reminder with a reboot button.
   * Never throws: a read/parse/send failure just means no reminder this tick.
   */
  private async checkUptimeAndRemind(): Promise<void> {
    let uptimeSec: number | undefined;
    try {
      uptimeSec = parseProcUptime(readFileSync("/proc/uptime", "utf8"));
    } catch {
      return; // non-Linux / unreadable — silently skip (not fatal to the bot)
    }
    if (uptimeSec === undefined) return;
    const machine = this.st.peek(MACHINE_STATE_KEY) ?? {};
    const now = Date.now();
    const should = shouldRemindAboutReboot({
      uptimeSec,
      lastReminderMs: machine.lastRebootReminderMs,
      now,
      thresholdMs: msPerDay(this.cfg.uptimeThresholdDays),
      remindIntervalMs: msPerDay(this.cfg.uptimeRemindIntervalDays),
    });
    if (!should) return;
    // Record the reminder BEFORE sending so a send failure or a rapid second
    // tick can't double-fire; the snooze interval still re-arms it later.
    this.st.set(MACHINE_STATE_KEY, { lastRebootReminderMs: now });
    const chat = this.cfg.allowedUserIds[0];
    if (!chat) return;
    const kb: Keyboard = {
      inline_keyboard: [
        [
          { text: "🔄 Reboot máy ngay", callback_data: "reboot:ask" },
          { text: "🔕 Nhắc lại sau", callback_data: "reboot:snooze" },
        ],
      ],
    };
    const text =
      `⏳ Máy đã chạy liên tục <b>${formatUptimeHuman(uptimeSec)}</b>. ` +
      `Kernel security updates chỉ áp dụng sau reboot — nên reboot định kỳ ~${this.cfg.uptimeThresholdDays} ngày. ` +
      `Bấm nút để reboot (xác nhận 2 bước) hoặc chọn nhắc lại sau.`;
    await this.tg.sendMessage(chat, text, { reply_markup: kb }).catch((e) => warn("uptime reminder:", e?.message ?? e));
  }

  /** The two-step confirmation message + keyboard for an actual reboot. */
  private async sendRebootConfirm(conv: ConvKey): Promise<void> {
    const kb: Keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Xác nhận reboot", callback_data: rebootGoData(Date.now()) },
          { text: "❌ Huỷ", callback_data: "reboot:cancel" },
        ],
      ],
    };
    const secs = Math.round(this.cfg.rebootDelayMs / 1000);
    const text =
      `⚠️ <b>Chắc reboot máy không?</b>\n` +
      `Máy sẽ khởi động lại trong ~${secs} giây; bot + OpenCode sẽ tắt và tự chạy lại sau (linger). ` +
      `Bấm <b>Xác nhận</b> nếu bạn chắc chắn, hoặc <b>Huỷ</b>.`;
    await this.tg.sendMessage(conv, text, { reply_markup: kb });
  }

  /** /reboot — manually start the two-step reboot flow (no confirmation gate yet). */
  private async cmdReboot(conv: ConvKey): Promise<void> {
    await this.sendRebootConfirm(conv);
  }

  /**
   * Reboot callback flow (two explicit taps required — this reboots the box):
   *   reboot:ask     (from the uptime reminder) → show the confirmation
   *   reboot:go      (from the confirmation)   → confirm, then reboot after the delay
   *   reboot:cancel  → abort
   *   reboot:snooze  (from the uptime reminder)→ re-arm the snooze interval
   */
  private async handleRebootCallback(cb: CallbackQuery, conv: ConvKey, messageId: number | undefined): Promise<void> {
    const action = (cb.data ?? "").slice("reboot:".length).split(":")[0];
    if (action === "snooze") {
      this.st.set(MACHINE_STATE_KEY, { lastRebootReminderMs: Date.now() });
      await this.tg.answerCallbackQuery(cb.id, "OK, sẽ nhắc lại sau.");
      if (messageId !== undefined) await this.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
      return;
    }
    if (action === "ask") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId !== undefined) await this.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
      await this.sendRebootConfirm(conv);
      return;
    }
    if (action === "cancel") {
      await this.tg.answerCallbackQuery(cb.id, "Đã huỷ.");
      if (messageId !== undefined) await this.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
      return;
    }
    if (action === "go") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId !== undefined) await this.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
      if (!isRebootConfirmFresh(cb.data, Date.now())) {
        await this.tg.sendMessage(conv, "⌛ Xác nhận reboot đã hết hạn — gửi /reboot để xác nhận lại.").catch(() => {});
        return;
      }
      if (this.rebootArmed) return; // double-tap: one reboot is already pending
      if (!existsSync(SAFE_REBOOT_BIN)) {
        await this.tg.sendMessage(conv, "⚠️ Wrapper <b>safe-reboot</b> chưa được cài trên máy. Chạy khối sudo trong PR #11 trước.").catch(() => {});
        return;
      }
      this.rebootArmed = true;
      const secs = Math.round(this.cfg.rebootDelayMs / 1000);
      await this.tg.sendMessage(conv, `🔄 <b>Đang reboot máy trong ~${secs} giây…</b>\nBot sẽ tự chạy lại sau khi máy lên (linger).`).catch(() => {});
      // Fire after the delay so the message above gets delivered. The token is
      // minted INSIDE the timer, right before the wrapper runs: the wrapper
      // rejects tokens older than REBOOT_TOKEN_TTL_MS, and rebootDelayMs
      // (default 15 s) is longer than that, so minting it earlier would always
      // be refused as stale. A stray `systemctl reboot` is refused regardless.
      setTimeout(() => {
        const token = randomBytes(16).toString("hex");
        const tokenFile = rebootTokenFile(homedir());
        try {
          mkdirSync(dirname(tokenFile), { recursive: true });
          writeFileSync(tokenFile, buildTokenLine(token, Date.now()), { mode: 0o600 });
        } catch (e) {
          this.rebootArmed = false;
          error("reboot arm failed:", (e as Error)?.message ?? e);
          void this.tg.sendMessage(conv, "⚠️ Không tạo được token reboot — xem log bot.").catch(() => {});
          return;
        }
        execFile("sudo", ["-n", SAFE_REBOOT_BIN, token], (err) => {
          this.rebootArmed = false; // only reached if the box did NOT go down
          if (err) error("reboot denied/failed:", err.message);
        });
      }, this.cfg.rebootDelayMs).unref?.();
      return;
    }
    await this.tg.answerCallbackQuery(cb.id);
  }

  /**
   * The event stream has no replay, so on every (re)connect re-read what we
   * may have missed while disconnected: pending questions and permission asks
   * of every tracked session (re-surfaced as buttons), and replies of turns
   * that finished meanwhile. Idempotent — known forms/requests are skipped.
   */
  private async reconcile(): Promise<void> {
    // Let the fresh subscription settle so nothing falls between the reads and the stream.
    await new Promise((r) => setTimeout(r, 1000));
    for (const [conv, s] of Object.entries(this.st.all())) {
      if (!s.sessionID || this.st.findChatBySession(s.sessionID) !== conv) continue;
      // undefined = the listing failed (unknown), as opposed to [] = nothing pending.
      const forms = await this.oc.listForms(s.sessionID).catch(() => undefined);
      for (const f of forms ?? []) if (f?.id && !this.questionForms.has(f.id)) await this.onFormCreated({ ...f, sessionID: s.sessionID });
      const perms = await this.oc.listPermissions(s.sessionID).catch(() => undefined);
      for (const p of perms ?? []) if (p?.id && !this.permissionPrompts.has(p.id)) await this.onPermissionAsked({ ...p, sessionID: s.sessionID });
      // Reminders persisted before a restart for prompts answered/cancelled meanwhile.
      const stale = stalePromptIds(this.st.get(conv).pendingPrompts, {
        form: forms && new Set(forms.map((f: any) => f?.id)),
        permission: perms && new Set(perms.map((p: any) => p?.id)),
      });
      for (const id of stale) this.cancelReminder(conv, id);
      if (!this.inflight.has(conv)) await this.sweepUnrelayedReplies(conv, "missed while disconnected");
    }
  }

  /**
   * Recover a reply that OpenCode produced but we never relayed — typically
   * because the process restarted (or was killed, e.g. by a restart or crash)
   * while a turn was still in flight. On startup, sweep every chat we've been
   * tracking relays for (see sweepUnrelayedReplies).
   */
  async recoverOrphanedReplies(): Promise<void> {
    for (const conv of Object.keys(this.st.all())) {
      await this.sweepUnrelayedReplies(conv, "orphaned by a restart");
    }
  }

  /**
   * Relay the newest assistant reply that we haven't sent yet for one chat.
   * The cursor is lastRelayedTime, so this is idempotent and safe to call
   * often: it only acts on a strictly newer unrelayed text reply. Called at
   * startup (recoverOrphanedReplies) and whenever a turn ends out-of-band —
   * e.g. a background task waking the session after we stopped waiting on it
   * (that is the classic "bot went silent and never reported back" gap).
   */
  private async sweepUnrelayedReplies(conv: ConvKey, reason: string, succeeded?: boolean): Promise<void> {
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, this.st.peek(conv)?.sessionID ?? "")) return;
    if (this.sweeping.has(conv)) return; // a sweep for this chat is already running
    this.sweeping.add(conv);
    const st = this.st.get(conv);
    if (!st.sessionID || !st.lastRelayedTime) {
      this.sweeping.delete(conv);
      return;
    }
    try {
      // The final assistant message can land a few hundred ms after the
      // execution.* event (the same race promptAndWait re-checks for), so
      // retry a few times before concluding there is nothing to relay.
      // Every unrelayed text reply, oldest first: two turns can end between
      // sweeps (e.g. the Manager answering the user, then a worker report).
      let replies: { text: string; time: number }[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const msgs = (await this.oc.listMessages(st.sessionID, 50).catch(() => [] as any[])) as any[];
        replies = msgs
          .filter((m: any) => m?.type === "assistant" && (m.time?.created ?? 0) > (st.lastRelayedTime ?? 0))
          .map((m: any) => ({ text: assistantText(m), time: m.time?.created ?? 0 }))
          .filter((r) => r.text)
          .sort((a, b) => a.time - b.time)
          .slice(-3);
        if (replies.length) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!replies.length) return;
      for (const r of replies) {
        if (this.topics.enabled(conv) && !this.topics.canInteract(conv, st.sessionID)) return;
        await this.sendReply(conv, r.text);
        this.st.set(conv, { lastRelayedTime: r.time });
      }
      log(`[chat ${conv}] relayed ${replies.length} unrelayed repl${replies.length > 1 ? "ies" : "y"} (${reason})`);
      if (succeeded) await this.maybeOfferPlanToBuild(conv);
    } catch (e) {
      warn("sweepUnrelayedReplies:", (e as Error)?.message);
    } finally {
      this.sweeping.delete(conv);
    }
  }

  private allowed(uid?: number): boolean {
    if (this.cfg.allowAny) return true;
    return uid !== undefined && this.cfg.allowedUserIds.includes(uid);
  }

  /** Per-conversation tail of the update queue (see enqueue). */
  private queues = new Map<ConvKey, Promise<void>>();

  /**
   * Hand an update to `handle` without blocking the polling loop: updates of
   * the same conversation still run in order, but a slow command in one topic
   * (e.g. /models) no longer holds up every other topic.
   */
  enqueue(u: Update): void {
    const m = u.message ?? u.edited_message ?? u.callback_query?.message;
    const key = m ? this.convOf(m) : "_";
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.handle(u))
      .catch((e) => error("Update handler error:", (e as Error)?.message ?? e))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
  }

  /** The conversation a message belongs to: its forum topic if any, else the chat. */
  private convOf(m: { chat: { id: number }; message_thread_id?: number; is_topic_message?: boolean }): ConvKey {
    // message_thread_id is also set on plain reply threads; only topics count.
    const thread = m.chat.id < 0 && m.message_thread_id === 1 && this.topics.enabled(String(m.chat.id)) ? undefined : m.message_thread_id;
    return convKey(m.chat.id, m.is_topic_message ? thread : undefined);
  }

  async handle(u: Update): Promise<void> {
    // The user tapped the native stop button on a live streaming draft.
    if (u.stopped_message_generation) {
      await this.onStoppedMessageGeneration(u.stopped_message_generation);
      return;
    }
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    const msg = u.message ?? u.edited_message;
    if (!msg) return;
    const conv = this.convOf(msg);
    const uid = msg.from?.id as number | undefined;
    if (typeof msg.forum_topic_edited?.name === "string") {
      this.topics.observeTopicTitle(conv, msg.forum_topic_edited.name);
      return;
    }
    // A media caption counts as text: it goes through the same dispatch as a plain message.
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text) {
      // A media-only message (sticker/photo/voice/…): acknowledge instead of
      // dropping it silently. Strangers are still ignored, as before.
      if (hasNonTextContent(msg)) {
        if (this.allowed(uid)) await this.noteNonText(conv, msg);
        else log(`Denied media from uid=${uid} chat=${conv}`);
      }
      return;
    }
    if (!this.allowed(uid)) {
      log(`Denied message from uid=${uid} chat=${conv}`);
      await this.tg
        .sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.")
        .catch(() => {});
      return;
    }
    if (/^\/setup(?:@\w+)?$/i.test(text)) {
      const general = String(msg.chat.id);
      if (msg.chat.type !== "supergroup" || !msg.chat.is_forum || (conv !== general && msg.message_thread_id !== 1)) {
        await this.tg.sendMessage(conv, "Use /setup in General of a forum supergroup.");
      } else {
        try {
          await this.tg.assertForumManagement(msg.chat.id);
          if (this.inflight.has(general) || this.inflight.has(`${general}:1`)) throw new Error("Wait for the legacy turn and its delivery to settle before /setup.");
          const legacySIDs = new Set([this.st.peek(general)?.sessionID, this.st.peek(`${general}:1`)?.sessionID]);
          for (const oldSID of legacySIDs) if (oldSID) {
            const old = await this.oc.topicSession(oldSID);
            if (old.busy || !old.terminal) throw new Error("Finish or explicitly stop the legacy General session before /setup. No sessions have been moved or stopped.");
          }
          this.topics.enable(general);
          await this.tg.sendMessage(conv, "General now manages sessions. Use /new to create a session with its own topic, /sessions to manage them. Existing sessions are unchanged.");
          await this.orch.showManagerEntry(general);
        } catch (error) { await this.tg.sendMessage(conv, `Setup not confirmed: ${esc((error as Error).message)}`); }
      }
      return;
    }
    // Remember the user's top-level chat so proactive notices (e.g. DNS heal)
    // have a destination even mid-polling-failure.
    if (uid !== undefined && this.topics.enabled(conv) && conv === chatOf(conv)) {
      if (/^\/cancel(?:@\w+)?$/i.test(text) && (this.titleInputs.has(`${conv}:${uid}`) || this.resumeInputs.has(`${conv}:${uid}`))) {
        this.titleInputs.delete(`${conv}:${uid}`);
        this.resumeInputs.delete(`${conv}:${uid}`);
        await this.tg.sendMessage(conv, "Đã hủy các bản nhập của bạn; không gửi công việc hoặc đổi tên.");
        return;
      }
      if (await this.handleTitleInput(conv, uid, msg, text)) return;
      if (await this.handleResumeInput(conv, uid, msg, text)) return;
    }
    this.lastActiveConv = chatOf(conv);
    // Reaction UX: index every user message so a reaction on it can be
    // resolved (the update carries no topic info) — and give the user a quick
    // "got it" 🤔 when a real prompt (not a command) starts a turn.
    if (msg.message_id) this.indexUserMessage(conv, msg.message_id, text);
    const state = this.st.get(conv);
    if (!state.directory) {
      // A topic the user opened by hand starts where the chat's main session works
      // (unless that is the Manager, whose folder is not a project).
      const top = this.st.peek(chatOf(conv));
      state.directory = top && !top.manager && top.directory ? top.directory : this.cfg.opencodeDirectory;
    }

    if (text.startsWith("/")) {
      if (await this.handleTopicCommand(conv, text, `message:${msg.chat.id}:${msg.message_id ?? u.update_id}`, uid)) return;
      await this.handleCommand(conv, text, state, uid);
    }
    else {
      if (this.topics.enabled(conv) && (conv === chatOf(conv) || !this.topics.canPrompt(conv))) {
        if (conv === chatOf(conv)) await this.orch.showManagerEntry(conv);
        else await this.tg.sendMessage(conv, "Phiên này chưa mở. Về General và dùng /sessions để kiểm tra hoặc mở lại.");
        return;
      }
      // (The "🤔 thinking" body-react on the user's message was removed 2026-10-27:
      // the working indicator now covers "the bot is working" on new prompts.)
      if (await this.handleFormText(conv, text)) return;
      else if (state.manager) await this.orch.promptManager(conv, text, msg.message_id);
      else await this.runPrompt(conv, text, state, msg.message_id);
    }
  }

  private async handleTopicCommand(conv: ConvKey, raw: string, operationID?: string, userID?: number): Promise<boolean> {
    if (!this.topics.enabled(conv)) return false;
    const [name, ...args] = raw.split(/\s+/);
    const cmd = name.replace(/@\w+$/, "").toLowerCase();
    const arg = args.join(" ");
    if (conv !== chatOf(conv)) {
      if (commandScope(cmd) === "general") {
        await this.tg.sendMessage(conv, "Manage sessions in General; this topic stays bound to its original session.");
        return true;
      }
      if (!this.topics.canPrompt(conv) && !["/help", "/status", "/context", "/ctx", "/history", "/usage", "/stop"].includes(cmd)) {
        await this.tg.sendMessage(conv, "This session is not open. Reconcile or restore it from General.");
        return true;
      }
      return false;
    }
    try {
      if (["/stop", "/note", "/context", "/ctx", "/history", "/wt"].includes(cmd)) {
        await this.tg.sendMessage(conv, esc("General is for management. Use the session topic for work, or /kill <worker> here to stop a selected worker."));
        return true;
      }
      if (cmd === "/status") {
        const links = this.topics.list(conv);
        await this.tg.sendMessage(conv, `General manages ${links.length} session topics. No LLM session runs here. Use /sessions for per-session status.`);
        return true;
      }
      if (cmd === "/new") {
        if (arg.includes("--keep")) throw new Error("Use a separate session/topic; carry-over is not implicit.");
        const state = this.st.get(conv);
        const now = Date.now();
        const suffix = randomBytes(4).toString("hex");
        const link = await this.topics.create({ chat: conv, directory: state.directory || this.cfg.opencodeDirectory,
          title: arg.slice(0, 128) || `Session ${suffix}`, operationID, agent: state.agent || this.cfg.defaultAgent,
          state: { model: state.model, variant: state.variant,
            worker: { name: `session-${suffix}`, status: "idle", spawnedBy: "user", createdAt: now, updatedAt: now } } });
        await this.showTopicLink(conv, link);
        return true;
      }
      if (["/use", "/attach"].includes(cmd) && arg) {
        await this.showTopicLink(conv, await this.topics.attach(conv, arg));
        return true;
      }
      if (["/sessions", "/ls"].includes(cmd)) {
        if (userID === undefined) throw new Error("Chưa xác minh được người mở bảng điều khiển.");
        await this.showSessionDashboard(conv, userID);
        return true;
      }
      if (["/use", "/attach"].includes(cmd)) {
        await this.showSessionTopics(conv);
        return true;
      }
      if (["/close", "/restore"].includes(cmd)) {
        const link = this.topics.list(conv).find((item) => item.id === arg || item.sessionID === arg);
        if (!link) throw new Error("Choose a session with /sessions, or supply its link/session ID.");
        await this.showTopicLink(conv, cmd === "/close" ? await this.topics.close(conv, link.id) : await this.topics.restore(conv, link.id));
        return true;
      }
      if (cmd === "/sync") {
        await this.reconcileTopics();
        await this.tg.sendMessage(conv, "Session/topic states checked. Pending operations remain visible in /sessions.");
        return true;
      }
      if (cmd === "/clear") {
        await this.tg.sendMessage(conv, esc("General cannot clear session bindings. Use /close <session-id> to archive a session without deleting history."));
        return true;
      }
    } catch (error) {
      await this.tg.sendMessage(conv, esc((error as Error).message));
      return true;
    }
    return false;
  }

  private async showSessionTopics(conv: ConvKey, requestedPage = 0): Promise<void> {
    const directory = resolve(this.st.peek(conv)?.directory || this.cfg.opencodeDirectory);
    let sessions: SessionBrief[] = [];
    let failed = false;
    try { sessions = await this.oc.listSessions(); } catch { failed = true; }
    const linked = new Set(this.topics.list().map((link) => link.sessionID));
    const owners = new Map<string, ConvKey[]>();
    for (const [key, state] of Object.entries(this.st.all())) if (state.sessionID) {
      owners.set(state.sessionID, [...(owners.get(state.sessionID) ?? []), key]);
    }
    const byID = new Map(sessions.map((session) => [session.id, session]));
    const candidates = new Map<string, SessionBrief>();
    for (const [key, state] of this.st.convsOfChat(conv)) {
      if (!state.sessionID || linked.has(state.sessionID) || owners.get(state.sessionID)?.length !== 1) continue;
      const session = byID.get(state.sessionID);
      if (session?.archived || session?.parentID) continue;
      candidates.set(state.sessionID, { ...session, id: state.sessionID,
        title: session?.title || state.worker?.name || (parseConv(key).threadId && parseConv(key).threadId! > 1 ? "Phiên cũ trong chủ đề" : "Phiên cũ ở General") });
    }
    for (const session of [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))) {
      if (linked.has(session.id) || owners.has(session.id) || session.archived || session.parentID ||
        !session.directory || resolve(session.directory) !== directory) continue;
      candidates.set(session.id, session);
    }
    const choices = [...candidates.values()].filter((session) => Buffer.byteLength(`use:${session.id}`) <= 64);
    const pages = Math.max(1, Math.ceil(choices.length / 10));
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const visible = choices.slice(page * 10, (page + 1) * 10);
    const rows: Btn[][] = visible.map((session) => [{ text: `📎 ${trunc(session.title || "Phiên chưa đặt tên", 45)}`, callback_data: `use:${session.id}` }]);
    const navigation: Btn[] = [];
    if (page > 0) navigation.push({ text: "⬅️ Trang trước", callback_data: `st:list:${page - 1}` });
    if (page + 1 < pages) navigation.push({ text: "Trang sau ➡️", callback_data: `st:list:${page + 1}` });
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: "➕ Tạo phiên mới", callback_data: "cmd:new" }, { text: "🔄 Làm mới", callback_data: "st:list:0" }]);
    rows.push([{ text: "Mở phiên quản lý", callback_data: "mgr:open" }]);
    rows.push([{ text: "Đồng bộ tên chủ đề", callback_data: "st:title-preview:0" }]);
    rows.push([{ text: "Phiên đang quản lý", callback_data: "cmd:ls" }]);
    const text = ["<b>📂 Chọn phiên để gắn vào chủ đề</b>",
      `Thư mục đang chọn: <code>${esc(directory)}</code>`,
      failed ? "⚠️ Không tải được danh sách OpenCode. Vẫn hiển thị các phiên cũ đã lưu của nhóm; bấm Làm mới để thử lại." : "",
      choices.length ? `Trang ${page + 1}/${pages} · ${choices.length} phiên chưa gắn. Bấm tên phiên bên dưới, không cần nhập ID.` : "Chưa tìm thấy phiên cũ phù hợp. Bấm Tạo phiên mới để bắt đầu, không cần ID.",
      ...visible.map((session, index) => `${page * 10 + index + 1}. ${esc(trunc(session.title || "Phiên chưa đặt tên", 90))}`),
      "Chỉ hiện phiên cũ của nhóm này và phiên chưa thuộc chat nào trong thư mục đang chọn. Dùng /dir hoặc /browse để đổi thư mục.",
      "Bot chỉ kiểm tra và gắn khi bạn chọn; phiên đang chạy cần chờ kết thúc. Không tự tạo lại hay chuyển phiên của chat khác.",
    ].filter(Boolean).join("\n");
    await this.tg.sendMessage(conv, text, { reply_markup: { inline_keyboard: rows } });
  }

  private async showSessionDashboard(conv: ConvKey, user: number, token?: string, filter: DashboardFilter = "all", requestedPage = 0, force = false): Promise<void> {
    if (!token) {
      for (const [key, value] of this.dashboardCards) if (value.expires < Date.now()) this.dashboardCards.delete(key);
      while (this.dashboardCards.size >= 500) this.dashboardCards.delete(this.dashboardCards.keys().next().value!);
      token = randomBytes(6).toString("hex");
      this.dashboardCards.set(token, { chat: conv, user, expires: Date.now() + 10 * 60_000, filter, page: requestedPage });
    }
    const card = this.dashboardCards.get(token);
    if (!card || card.chat !== conv || card.user !== user || card.expires < Date.now()) {
      throw new Error("Thẻ đã hết hạn hoặc không thuộc bạn/nhóm này. Mở lại bằng /sessions.");
    }
    const prior = dashboardPage(await this.dashboard.read(conv), filter, requestedPage);
    const rows = await this.dashboard.read(conv, { refresh: true, force, ids: prior.rows.map(row => row.id) });
    const page = dashboardPage(rows, filter, prior.page);
    card.filter = filter;
    card.page = page.page;
    const keyboard: Btn[][] = page.rows.map(row => [{ text: trunc(row.title || "Phiên chưa đặt tên", 48), callback_data: `db:${token}:detail:${row.id}` }]);
    const filters = Object.entries(DASHBOARD_FILTERS).map(([key, label]) => ({ text: `${label} (${page.counts[key as DashboardFilter]})`, callback_data: `db:${token}:${key}:0` }));
    for (let index = 0; index < filters.length; index += 2) keyboard.push(filters.slice(index, index + 2));
    const navigation: Btn[] = [];
    if (page.page > 0) navigation.push({ text: "⬅️ Trang trước", callback_data: `db:${token}:${filter}:${page.page - 1}` });
    if (page.page + 1 < page.pages) navigation.push({ text: "Trang sau ➡️", callback_data: `db:${token}:${filter}:${page.page + 1}` });
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([{ text: "Làm mới", callback_data: `db:${token}:refresh:0` }, { text: "Gắn phiên có sẵn", callback_data: "st:list:0" }]);
    keyboard.push([{ text: "➕ Tạo phiên mới", callback_data: "cmd:new" }, { text: "Mở phiên quản lý", callback_data: "mgr:open" }]);
    keyboard.push([{ text: "Đồng bộ tên chủ đề", callback_data: "st:title-preview:0" }]);
    keyboard.push([{ text: "Thiết lập tên", callback_data: "tc:open:group" }]);
    const text = ["<b>Phiên đang quản lý</b>", `${DASHBOARD_FILTERS[filter]} · ${page.total} phiên · Trang ${page.page + 1}/${page.pages}`,
      ...page.rows.flatMap((row, index) => [
        `${page.page * 10 + index + 1}. <b>${esc(trunc(row.title, 48))}</b> · ${DASHBOARD_PHASE_LABELS[row.lifecycle]} · ${DASHBOARD_WORK_LABELS[row.work]}`,
        `<code>${esc(trunc(row.directory, 60))}</code> · ${row.checkedAt ? `Đã kiểm tra ${esc(timeAgo(row.checkedAt))}` : "Chưa kiểm tra"}${row.pending.length ? ` · ${row.pending.length} yêu cầu${row.pendingVerified ? "" : " cần đối chiếu"}` : ""}${row.titleError ? " · Lỗi đồng bộ tên" : ""}`,
      ]),
      !page.rows.length ? "Chưa có phiên phù hợp. Có thể làm mới, đổi bộ lọc, tạo mới hoặc gắn phiên có sẵn." : "Bấm tên phiên để xem chi tiết và đi tới chủ đề.",
      page.unverified ? `${page.unverified} phiên chưa xác minh đủ. Số đang chạy/chờ chỉ tính dữ liệu đã xác minh; làm mới từng trang khi cần.` : "Trạng thái là dữ liệu đã quan sát, không tự thay đổi vòng đời.",
    ].join("\n");
    await this.tg.sendMessage(conv, text, { reply_markup: { inline_keyboard: keyboard } });
  }

  private async showPendingActions(conv: ConvKey, user: number, id: string, requestedPage = 0): Promise<void> {
    const link = this.topics.get(id);
    if (!link || link.chat !== conv || !link.sessionID) throw new Error("Không tìm thấy phiên trong nhóm này.");
    if (link.phase !== "open" || !link.conv || !this.topics.canInteract(link.conv, link.sessionID)) {
      await this.tg.sendMessage(conv, "Phiên chưa mở hoặc cần kiểm tra; bot không tự mở lại để đọc/hiển thị câu hỏi.");
      return;
    }
    const row = (await this.dashboard.read(conv, { refresh: true, force: true, ids: [id] })).find(row => row.id === id);
    if (!row || row.lifecycle !== "open" || row.sessionID !== link.sessionID) throw new Error("Phiên đã đổi trạng thái trong lúc đọc; hãy mở lại danh sách.");
    const items = [...row.pending].sort((a, b) => Number(b.verified) - Number(a.verified) ||
      (a.firstShownAt ?? a.checkedAt ?? 0) - (b.firstShownAt ?? b.checkedAt ?? 0) || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    for (const [key, card] of this.pendingCards) if (card.expires < Date.now()) this.pendingCards.delete(key);
    while (this.pendingCards.size >= 500) this.pendingCards.delete(this.pendingCards.keys().next().value!);
    const token = randomBytes(6).toString("hex");
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.min(Math.max(0, requestedPage), pages - 1);
    const visible = items.slice(page * 10, page * 10 + 10);
    this.pendingCards.set(token, { chat: conv, user, expires: Date.now() + 10 * 60_000, linkID: id,
      sessionID: link.sessionID, identity: JSON.stringify(link.identity), items: visible.map(item => ({ id: item.id, kind: item.kind })) });
    const keyboard: Btn[][] = [];
    const lines = [`<b>Đang chờ bạn · ${esc(trunc(link.title, 70))}</b>`, `${items.length} yêu cầu đã biết · Trang ${page + 1}/${pages}${row.pendingVerified ? "" : " · Chưa xác minh đầy đủ"}`];
    visible.forEach((item, index) => {
      const label = item.kind === "form" ? "Câu hỏi" : "Yêu cầu cấp quyền";
      lines.push(`${index + 1}. ${label} · ${item.verified ? "Đã xác minh" : "Chưa xác minh"}${item.checkedAt ? ` · ${esc(timeAgo(item.checkedAt))}` : ""}${item.firstShownAt ? ` · xuất hiện ${esc(timeAgo(item.firstShownAt))}` : ""}`);
      if (item.messageId && item.messageId > 0) keyboard.push([{ text: item.kind === "form" ? "Đến câu hỏi" : "Đến yêu cầu cấp quyền", url: topicMessageUrl(link.conv!, item.messageId)! }]);
      else lines.push("Không có mã tin gốc; hãy mở chủ đề hoặc hiển thị lại thẻ.");
      if (item.verified) keyboard.push([{ text: `Hiển thị lại ${item.kind === "form" ? "câu hỏi" : "yêu cầu quyền"} ${index + 1}`, callback_data: `pa:relay:${token}:${index}` }]);
    });
    const navigation: Btn[] = [];
    if (page > 0) navigation.push({ text: "⬅️ Trang trước", callback_data: `pa:list:${id}:${page - 1}` });
    if (page + 1 < pages) navigation.push({ text: "Trang sau ➡️", callback_data: `pa:list:${id}:${page + 1}` });
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([{ text: "Mở chủ đề", url: topicMessageUrl(link.conv)! }, { text: "Làm mới", callback_data: `pa:list:${id}:${page}` }]);
    lines.push("Liên kết dùng mã tin đã lưu; nếu tin bị xóa, dùng Mở chủ đề hoặc Hiển thị lại. Không trả lời/cấp quyền từ General.");
    await this.tg.sendMessage(conv, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  }

  private async relayPendingAction(conv: ConvKey, user: number, token: string, index: number): Promise<void> {
    const card = this.pendingCards.get(token);
    const item = card?.items[index];
    if (!card || !item || card.chat !== conv || card.user !== user || card.expires < Date.now()) throw new Error("Thẻ đã hết hạn hoặc không thuộc bạn; mở lại yêu cầu đang chờ.");
    const valid = () => {
      const link = this.topics.get(card.linkID);
      if (!link || link.chat !== conv || link.sessionID !== card.sessionID || JSON.stringify(link.identity) !== card.identity ||
        !link.conv || !this.topics.canInteract(link.conv, card.sessionID)) throw new Error("Phiên đã đổi trạng thái; không hiển thị lại thẻ cũ.");
      return link;
    };
    valid();
    const live = item.kind === "form" ? await this.oc.listForms(card.sessionID, AbortSignal.timeout(3000)) :
      await this.oc.listPermissions(card.sessionID, AbortSignal.timeout(3000));
    const request = live.find(request => request.id === item.id);
    if (!request) throw new Error("Yêu cầu đã hết chờ. Làm mới danh sách để xem trạng thái mới.");
    valid();
    if (item.kind === "form") await this.onFormCreated({ ...request, sessionID: card.sessionID }, true);
    else await this.onPermissionAsked({ ...request, sessionID: card.sessionID }, true);
    const messageID = item.kind === "form" ? this.questionForms.get(item.id)?.messageId : this.permissionPrompts.get(item.id)?.messageId;
    if (!messageID || messageID < 1) throw new Error("Chưa xác nhận được việc hiển thị lại thẻ; không tạo yêu cầu mới.");
    await this.tg.sendMessage(conv, "Đã hiển thị lại thẻ trong đúng chủ đề. Không đặt lại số lần nhắc đã có.");
  }

  private async showTopicLink(conv: ConvKey, link: SessionTopic): Promise<void> {
    const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
    if (link.conv) {
      const { chatId, threadId } = parseConv(link.conv);
      rows.push([{ text: "Mở chủ đề", url: `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${threadId}` }]);
    }
    if (link.conv && link.identity && link.sessionID) rows.push([{ text: "Đóng phiên", callback_data: `st:close:${link.id}` },
      { text: "Mở lại phiên", callback_data: `st:restore:${link.id}` }]);
    if (!["open", "closed"].includes(link.phase)) rows.push([{ text: "Kiểm tra trạng thái", callback_data: `st:sync:${link.id}` }]);
    if (link.conv && link.sessionID && link.identity) rows.push([{ text: "Đồng bộ tên", callback_data: `st:title-sync:${link.id}` }]);
    if (link.conv && link.sessionID && link.identity) rows.push([{ text: "Thiết lập tên", callback_data: `tc:open:${link.id}` }]);
    if (link.conv && link.sessionID) rows.push([{ text: "Xem yêu cầu đang chờ", callback_data: `pa:list:${link.id}:0` }]);
    rows.push([{ text: "Xem tóm tắt", callback_data: `sum:show:${link.id}` }]);
    rows.push([{ text: "Quy tắc thông báo General", callback_data: "nt:rules" }]);
    const nameStatus = link.conv && link.sessionID && link.identity ? this.topics.titleStatus(conv, link.id) : undefined;
    const retryDate = nameStatus?.retryAt ? new Date(nameStatus.retryAt) : undefined;
    const titleLines = nameStatus ? [
      `Chế độ tên: ${TITLE_POLICY_LABELS[nameStatus.policy.mode]} · nhóm ${nameStatus.group.enabled ? "Bật" : "Tắt"}`,
      nameStatus.pending ? "Đang chờ xử lý tên." : "",
      nameStatus.pending && nameStatus.pendingName ? `Ý định tên đã lưu: ${esc(nameStatus.pendingName)}` : "",
      nameStatus.error ? `Lỗi tên đã lưu: ${esc(trunc(nameStatus.error, 160))}` : "",
      retryDate ? `Thử lại không sớm hơn: ${Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : "mốc chờ quá xa"}` : "",
    ].filter(Boolean) : [];
    const titleStatus = titleLines.length ? "\n" + titleLines.join("\n") : "";
    let activityText = "";
    if (link.conv) try {
      const activity = this.sessionActivity.read(link.conv);
      if (activity && activity.sessionID === link.sessionID) activityText = `\n\n<b>Yêu cầu gần nhất</b> · ${ACTIVITY_SOURCE_LABELS[activity.input.source]} · ${esc(timeAgo(activity.input.receivedAt))}\n${esc(trunc(activity.input.snippet, 480))}\n${activity.input.observed ? "Đã đối chiếu đầu vào" : "Bot đã nhận; chưa đối chiếu việc gửi"}${activity.uncertainty ? ` · ${esc(activity.uncertainty)}` : ""}${activity.result ? `\n<b>Đoạn phản hồi đã quan sát</b>\n${esc(trunc(activity.result.snippet, 700))}\nĐây là nội dung phản hồi, không phải bằng chứng đã kiểm thử.` : "\nChưa có kết quả đối chiếu đúng đầu vào."}`;
    } catch { activityText = "\nKhông đọc được bản ghi hoạt động; giữ nguyên để kiểm tra."; }
    await this.tg.sendMessage(conv, `<b>${esc(trunc(link.title, 160))}</b> · ${esc(link.phase)}\nSession: <code>${esc(link.sessionID ?? "unconfirmed")}</code>\nLink: <code>${esc(link.id)}</code>${link.step ? `\nStep: ${esc(link.step)}` : ""}${link.error ? `\n${esc(trunc(link.error, 280))}` : ""}${titleStatus}${activityText}`,
      { reply_markup: { inline_keyboard: rows } });
    this.topicAnnouncements.set(link.id, this.topicSignature(link));
    if (link.phase === "open") this.resumePromptReminders();
  }

  private topicSignature(link: SessionTopic): string { return `${link.phase}:${link.step ?? ""}:${link.error ?? ""}`; }

  private summaryBinding(link: SessionTopic): string {
    return JSON.stringify([link.id, link.sessionID, link.conv, link.directory,
      link.identity?.source, link.identity?.projectID, link.identity?.createdAt]);
  }

  private publishNotice(conv: ConvKey, kind: NoticeKind, reference: Notice["reference"], occurredAt: number, occurrence?: number): void {
    try {
      const link = this.topics.forTopic(conv);
      if (!link?.sessionID || !link.identity || this.st.peek(conv)?.sessionID !== link.sessionID) return;
      const pending = reference && this.st.peek(conv)?.pendingPrompts?.[reference.id];
      this.notifications.enqueue({ chat: link.chat, conv, linkID: link.id, sessionID: link.sessionID, binding: this.summaryBinding(link), kind,
        title: [...link.title].slice(0, 128).join(""), reference, occurrence, occurredAt,
        url: topicMessageUrl(conv, pending?.messageId) });
    } catch (error) { warn("Thông báo General:", (error as Error).message); }
  }

  private async resolveNotice(event: Notice): Promise<Notice | undefined> {
    const link = this.topics.get(event.linkID);
    if (!link || link.chat !== event.chat || link.conv !== event.conv || link.sessionID !== event.sessionID ||
      this.summaryBinding(link) !== event.binding || this.st.peek(event.conv)?.sessionID !== event.sessionID || !link.identity ||
      this.st.findChatBySession(event.sessionID) !== event.conv || Object.values(this.st.all()).filter(state => state.sessionID === event.sessionID).length !== 1) return;
    const info = await this.oc.topicSessionTitle(event.sessionID, AbortSignal.timeout(3000));
    if (info.id !== event.sessionID || info.source !== link.identity.source || info.projectID !== link.identity.projectID || info.createdAt !== link.identity.createdAt) return;
    if (["question", "permission", "reminder"].includes(event.kind)) {
      if (info.archived || !this.topics.canInteract(event.conv, event.sessionID) || !event.reference) return;
      const ids = event.reference.kind === "form" ? await this.oc.listForms(event.sessionID, AbortSignal.timeout(3000)) : await this.oc.listPermissions(event.sessionID, AbortSignal.timeout(3000));
      if (!ids.some(item => item.id === event.reference!.id)) return;
    }
    if (event.kind === "naming" && !link.titleSync?.error) return;
    const latest = this.topics.get(event.linkID);
    if (!latest || this.summaryBinding(latest) !== event.binding || latest.chat !== event.chat || this.st.peek(event.conv)?.sessionID !== event.sessionID) return;
    if (["question", "permission", "reminder"].includes(event.kind) && !this.topics.canInteract(event.conv, event.sessionID)) return;
    return { ...event, title: [...latest.title].slice(0, 128).join(""), url: topicMessageUrl(event.conv,
      event.reference && this.st.peek(event.conv)?.pendingPrompts?.[event.reference.id]?.messageId) };
  }

  private publishActivityOutcome(conv: ConvKey): void {
    const activity = this.sessionActivity.read(conv);
    const result = activity?.result;
    if (!activity || !result || result.inputID !== activity.input.id || !["succeeded", "failed", "interrupted"].includes(result.outcome ?? "")) return;
    this.publishNotice(conv, result.outcome === "failed" ? "blocked" : "completed", { kind: "input", id: activity.input.id }, result.createdAt ?? result.observedAt);
  }

  private async showNoticeSettings(conv: ConvKey, user: number, action: string, token?: string): Promise<void> {
    if (action === "preview") {
      for (const [key, value] of this.noticePreviews) if (value.expires < Date.now()) this.noticePreviews.delete(key);
      while (this.noticePreviews.size >= 500) this.noticePreviews.delete(this.noticePreviews.keys().next().value!);
      const id = randomBytes(6).toString("hex");
      this.noticePreviews.set(id, { chat: conv, user, revision: this.notifications.settings(conv).revision, expires: Date.now() + 10 * 60_000 });
      await this.tg.sendMessage(conv, this.notifications.rules(conv) + "\n\nBật sẽ thêm thông báo sự kiện mới tại General. Kết quả gộp 5 giây, tối đa 8 mục/tin; không sao chép phản hồi và không chạy mô hình. Giao tin chưa xác nhận không được gửi mới mù quáng.",
        { reply_markup: { inline_keyboard: [[{ text: "Xác nhận bật thông báo General", callback_data: `nt:enable:${id}` }, { text: "Hủy", callback_data: `nt:cancel:${id}` }]] } });
      return;
    }
    if (action === "enable" || action === "cancel") {
      const preview = token && this.noticePreviews.get(token);
      if (!preview || preview.chat !== conv || preview.user !== user || preview.expires < Date.now()) throw new Error("Bản xem trước không thuộc bạn/nhóm này hoặc hết hạn.");
      if (action === "enable") this.notifications.configure(conv, preview.revision, true);
      this.noticePreviews.delete(token!);
    } else if (action === "off") {
      if (token !== conv) throw new Error("Nút tắt không thuộc nhóm này.");
      this.notifications.configure(conv, this.notifications.settings(conv).revision, false);
    } else if (action === "repair") {
      if (token !== conv) throw new Error("Thao tác giao tin không thuộc nhóm này.");
      const count = this.notifications.repairKnown(conv);
      await this.tg.sendMessage(conv, `Đã xếp ${count} mục để kiểm tra/chỉnh sửa tin đã biết. Mục không có mã tin không được gửi mới; dùng bảng điều khiển để kiểm tra công việc.`);
    } else if (action !== "rules") throw new Error("Nút thông báo không hợp lệ.");
    const settings = this.notifications.settings(conv);
    const status = this.notifications.status(conv);
    await this.tg.sendMessage(conv, this.notifications.rules(conv) + `\nHàng đợi: ${status.pending} chờ · ${status.unknown + status.sending} chưa xác nhận · ${status.failed} bị từ chối.`,
      { reply_markup: { inline_keyboard: [[{ text: settings.enabled ? "Tắt thông báo General" : "Xem trước bật", callback_data: settings.enabled ? `nt:off:${conv}` : "nt:preview" }],
        ...(status.unknown ? [[{ text: "Kiểm tra/sửa tin đã biết", callback_data: `nt:repair:${conv}` }]] : []),
        [{ text: "Bảng điều khiển phiên", callback_data: "cmd:ls" }]] } });
  }

  private refreshSummary(conv: ConvKey, link: SessionTopic, bypassCache = false): Promise<{ at: number; refreshedAt?: number; error?: string }> {
    const key = this.summaryBinding(link);
    const existing = this.summaryLoads.get(key);
    if (existing) return existing;
    const cached = this.summaryRefreshes.get(key);
    if (!bypassCache && cached && Date.now() - cached.at < 5000) return Promise.resolve(cached);
    const task = (async () => {
      const errors: string[] = [];
      let refreshedAt: number | undefined;
      const history = (async () => {
        if (!link.conv || !link.sessionID || !link.identity || this.st.peek(link.conv)?.sessionID !== link.sessionID ||
          this.st.findChatBySession(link.sessionID) !== link.conv || Object.values(this.st.all()).filter(state => state.sessionID === link.sessionID).length !== 1) throw new Error("Liên kết chưa đủ hoặc xung đột; không đọc lịch sử nguồn.");
        const revision = this.sessionActivity.read(link.conv)?.revision;
        const controller = new AbortController();
        this.summaryAborts.add(controller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const snapshot = await Promise.race([this.oc.activitySnapshot(link.sessionID, controller.signal), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("Hết thời gian đọc tối đa 40 tin của phiên.")); }, 3000);
          })]);
          const latest = this.topics.get(link.id);
          if (this.activityStopped || controller.signal.aborted || !latest || this.summaryBinding(latest) !== key || latest.chat !== conv ||
            snapshot.info.id !== link.sessionID || snapshot.info.source !== link.identity.source || snapshot.info.projectID !== link.identity.projectID ||
            snapshot.info.createdAt !== link.identity.createdAt || snapshot.info.directory !== link.directory || this.st.peek(link.conv)?.sessionID !== link.sessionID) throw new Error("Danh tính, thư mục hoặc liên kết đổi trong lúc đọc; giữ bản đã biết.");
          if (this.sessionActivity.read(link.conv)?.revision !== revision) throw new Error("Có hoạt động mới trong lúc đọc; mở hoặc làm mới lại bản tóm tắt.");
          if (snapshot.messages.length && !snapshot.messages.some(message => message.type === "user")) throw new Error("Chưa tìm thấy ranh giới đầu vào trong 40 tin; không ghép kết quả bằng suy đoán.");
          this.sessionActivity.observe(link.conv, link.sessionID, revision, snapshot.messages);
          this.resumeConfirmations.observe(link.conv, snapshot.messages.filter(message => message.type === "user").map(message => message.id));
          refreshedAt = Date.now();
        } finally { if (timer) clearTimeout(timer); controller.abort(); this.summaryAborts.delete(controller); }
      })().catch(error => { errors.push((error as Error).message); });
      await Promise.all([history, this.dashboard.read(conv, { refresh: true, force: true, ids: [link.id] }).catch(error => { errors.push((error as Error).message); })]);
      const row = (await this.dashboard.read(conv)).find(row => row.id === link.id);
      if (row?.lifecycle === "open" && row.stale && row.reason) errors.push(row.reason);
      const result = { at: Date.now(), refreshedAt, error: errors.length ? errors.join("; ") : undefined };
      this.summaryRefreshes.delete(key);
      this.summaryRefreshes.set(key, result);
      while (this.summaryRefreshes.size > 1000) this.summaryRefreshes.delete(this.summaryRefreshes.keys().next().value!);
      return result;
    })().finally(() => this.summaryLoads.delete(key));
    this.summaryLoads.set(key, task);
    return task;
  }

  private async showSessionSummary(conv: ConvKey, user: number, id: string, refresh = false): Promise<void> {
    const link = this.topics.get(id);
    if (!link || link.chat !== conv) throw new Error("Phiên không thuộc nhóm này.");
    const binding = this.summaryBinding(link);
    if (refresh) await this.refreshSummary(conv, link);
    const row = (await this.dashboard.read(conv)).find(row => row.id === id);
    const latest = this.topics.get(id);
    if (!row || !latest || latest.chat !== conv || this.summaryBinding(latest) !== binding || row.sessionID !== latest.sessionID) throw new Error("Liên kết đã đổi; mở lại tóm tắt từ bảng điều khiển.");
    const refreshed = this.summaryRefreshes.get(binding);
    const summary = buildSessionSummary(conv, row, { now: Date.now(), refreshedAt: refreshed?.refreshedAt, refreshError: refreshed?.error });
    for (const [key, value] of this.summaryCards) if (value.expires < Date.now()) this.summaryCards.delete(key);
    while (this.summaryCards.size >= 500) this.summaryCards.delete(this.summaryCards.keys().next().value!);
    const token = randomBytes(6).toString("hex");
    this.summaryCards.set(token, { chat: conv, user, id, binding, marker: summary.marker, expires: Date.now() + 10 * 60_000 });
    const keyboard: Btn[][] = [];
    if (row.pending.length) keyboard.push([{ text: row.pending.some(item => item.verified) ? "Đến yêu cầu đang chờ" : "Kiểm tra yêu cầu đã lưu", callback_data: `pa:list:${id}:0` }]);
    if (latest.conv) keyboard.push([{ text: "Đến chủ đề", url: topicMessageUrl(latest.conv)! }]);
    keyboard.push([{ text: "Làm mới thông tin", callback_data: `sum:refresh:${token}` }]);
    if (latest.phase === "open") keyboard.push([{ text: "Chuẩn bị tiếp tục", callback_data: `sum:prepare:${token}` }]);
    if (latest.phase === "closed") keyboard.push([{ text: "Mở lại phiên", callback_data: `st:restore:${id}` }]);
    else if (latest.phase !== "open") keyboard.push([{ text: "Kiểm tra trạng thái", callback_data: `st:sync:${id}` }]);
    keyboard.push([{ text: "Bảng điều khiển phiên", callback_data: "cmd:ls" }]);
    await this.tg.sendMessage(conv, summary.text, { reply_markup: { inline_keyboard: keyboard } });
  }

  private async readyForResume(conv: ConvKey, id: string, ignoreToken?: string, reserved = false) {
    const link = this.topics.get(id);
    if (!link || link.chat !== conv || !link.conv || !link.sessionID || link.phase !== "open" || !this.topics.canPrompt(link.conv)) throw new Error("Phiên chưa mở/đủ quyền. Mở lại bằng luồng riêng rồi xem và chuẩn bị lại; không tự mở để chạy.");
    const binding = this.summaryBinding(link);
    if (!this.scheduler || this.scheduler.owns(link.conv) || this.orch.ownsScheduledConv(link.conv)) throw new Error("Quyền sở hữu lượt lịch chưa được giải phóng/xác minh; không dùng đường tiếp tục để vượt qua.");
    if (!reserved && this.inflight.has(link.conv)) throw new Error("Phiên đang có công việc; chưa thể chuẩn bị tiếp tục.");
    const refreshed = await this.refreshSummary(conv, link, true);
    if (refreshed.error || refreshed.refreshedAt === undefined) throw new Error(`Chưa xác minh đủ dữ liệu nguồn: ${refreshed.error ?? "thiếu mốc đọc"}`);
    const latest = this.topics.get(id);
    const row = (await this.dashboard.read(conv)).find(row => row.id === id);
    if (!latest || this.summaryBinding(latest) !== binding || latest.phase !== "open" || !this.topics.canPrompt(link.conv) || !row || row.stale ||
      !row.pendingVerified || row.pending.length || !["idle", "done", "failed", "stopped"].includes(row.work)) throw new Error("Phiên đang bận/chờ hoặc chưa xác minh kết thúc; xem lại tóm tắt, không gửi yêu cầu.");
    if (row.activityError || row.activity?.uncertainty || (row.activity && !row.activity.input.observed)) throw new Error("Đầu vào/kết quả trước chưa được đối chiếu. Kiểm tra tại chủ đề; không tự phát lại.");
    if (this.resumeConfirmations.unobserved(link.conv).some(item => item.token !== ignoreToken)) throw new Error("Có đầu vào đã dùng xác nhận nhưng chưa thấy ở nguồn. Làm mới/kiểm tra trước; không gửi lại hoặc đoán đã thất bại.");
    if (this.scheduler.owns(link.conv) || this.orch.ownsScheduledConv(link.conv)) throw new Error("Một lượt lịch vừa nhận quyền; chuẩn bị lại sau khi kết thúc đã được xác nhận.");
    return { link: latest, row, binding, marker: buildSessionSummary(conv, row, { now: Date.now() }).marker };
  }

  private async prepareResumeInput(conv: ConvKey, user: number, card: { id: string; marker: string; binding: string }): Promise<void> {
    const ready = await this.readyForResume(conv, card.id);
    if (ready.marker !== card.marker || ready.binding !== card.binding) {
      await this.showSessionSummary(conv, user, card.id);
      await this.tg.sendMessage(conv, "Mốc tóm tắt đã đổi; xem thông tin mới rồi bấm Chuẩn bị tiếp tục lại.");
      return;
    }
    for (const [key, value] of this.resumeInputs) if (value.expires < Date.now()) this.resumeInputs.delete(key);
    while (this.resumeInputs.size >= 100) this.resumeInputs.delete(this.resumeInputs.keys().next().value!);
    const token = randomBytes(6).toString("hex");
    const messageID = await this.tg.sendMessageId(conv, `<b>Nhập mục tiêu tiếp tục</b>\nPhiên: <code>${esc(ready.link.sessionID!)}</code>\nTrả lời trực tiếp tin này trong 10 phút bằng yêu cầu mới bạn muốn gửi. Không tự lấy lại yêu cầu cũ hay suy đoán bước tiếp theo. Sau đó còn bước xem trước/xác nhận.`,
      { reply_markup: { inline_keyboard: [[{ text: "Hủy nhập mục tiêu", callback_data: `resume:cancel-input:${token}` }]] } });
    if (!Number.isSafeInteger(messageID) || messageID <= 0) throw new Error("Chưa xác nhận được tin nhập mục tiêu; mở lại từ tóm tắt.");
    this.resumeInputs.set(`${conv}:${user}`, { id: card.id, token, messageID, marker: ready.marker, binding: ready.binding, expires: Date.now() + 10 * 60_000 });
  }

  private async handleResumeInput(conv: ConvKey, user: number, msg: Message, text: string): Promise<boolean> {
    const key = `${conv}:${user}`;
    const input = this.resumeInputs.get(key);
    if (!input || msg.reply_to_message?.message_id !== input.messageID || text.startsWith("/")) return false;
    this.resumeInputs.delete(key);
    try {
      if (input.expires < Date.now() || text.length > 1200) throw new Error("Bản nhập hết hạn hoặc mục tiêu dài quá 1200 ký tự; chuẩn bị lại.");
      const ready = await this.readyForResume(conv, input.id);
      if (ready.binding !== input.binding || ready.marker !== input.marker) throw new Error("Có hoạt động/mốc mới trong lúc nhập; xem lại tóm tắt và chuẩn bị lại.");
      const state = this.st.peek(ready.link.conv!)!;
      const payload = !state.manager && this.cfg.guideQuestions && !state.guided ? QUESTIONS_PREAMBLE + "\n\n" + text : text;
      if (payload.length + ready.link.directory.length > 3300) throw new Error("Nội dung và thư mục quá dài để xem trước đầy đủ; rút gọn mục tiêu hoặc dùng chủ đề làm việc.");
      const item = this.resumeConfirmations.prepare({ actor: user, chat: conv, conv: ready.link.conv!, sessionID: ready.link.sessionID!,
        directory: ready.link.directory, binding: ready.binding, marker: ready.marker, goal: text, payload, inputID: newMessageID() });
      await this.tg.sendMessage(conv, `<b>Xác nhận yêu cầu mới</b>\nPhiên: <code>${esc(item.sessionID)}</code>\nThư mục: <code>${esc(item.directory)}</code>\nMốc công việc: <code>${esc(item.marker)}</code>\n<b>Nội dung sẽ gửi</b>\n<pre>${esc(item.payload)}</pre>\nDùng cấu hình/hướng dẫn hiện tại của phiên. Nút chỉ dùng một lần trong 10 phút; không tự gửi lại khi kết quả gửi chưa rõ.`,
        { reply_markup: { inline_keyboard: [[{ text: "Xác nhận tiếp tục", callback_data: `resume:yes:${input.id}:${item.token}` },
          { text: "Hủy xác nhận", callback_data: `resume:no:${input.id}:${item.token}` }]] } });
    } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message),
      { reply_markup: { inline_keyboard: [[{ text: "Xem lại tóm tắt", callback_data: `sum:show:${input.id}` }]] } }); }
    return true;
  }

  private async handleResumeCallback(conv: ConvKey, cb: CallbackQuery): Promise<void> {
    const [, action, id, token] = (cb.data ?? "").split(":");
    const user = cb.from!.id;
    if (action === "cancel-input") {
      const key = `${conv}:${user}`;
      const input = this.resumeInputs.get(key);
      if (!input || input.token !== id) throw new Error("Không có bản nhập mục tiêu thuộc bạn trên thẻ này.");
      this.resumeInputs.delete(key);
      await this.tg.sendMessage(conv, "Đã hủy nhập mục tiêu; không gửi công việc.");
      return;
    }
    const link = this.topics.get(id);
    if (!link || link.chat !== conv || !link.conv) throw new Error("Xác nhận không thuộc nhóm/phiên này.");
    const item = this.resumeConfirmations.get(link.conv, token);
    if (!item || item.actor !== user || item.chat !== conv || item.state !== "ready") throw new Error("Xác nhận không thuộc bạn hoặc đã dùng; không gửi lại.");
    if (action === "no") {
      this.resumeConfirmations.cancelReady(link.conv, token, user);
      await this.tg.sendMessage(conv, "Đã hủy xác nhận; không gửi công việc.");
      return;
    }
    if (action !== "yes") throw new Error("Nút xác nhận không hợp lệ.");
    await this.dispatchResumeConfirmation(conv, user, id, item);
  }

  private async dispatchResumeConfirmation(conv: ConvKey, user: number, id: string, item: ResumeConfirmation, noticeConv = conv): Promise<void> {
    const link = this.topics.get(id);
    if (!link || link.chat !== conv || !link.conv || item.conv !== link.conv || item.sessionID !== link.sessionID) throw new Error("Xác nhận không còn thuộc liên kết hiện tại.");
    const token = item.token;
    const ready = await this.readyForResume(conv, id, token);
    if (!this.allowed(user)) throw new Error("Quyền người xác nhận đã thay đổi; không gửi yêu cầu.");
    const used = this.resumeConfirmations.consume(link.conv, token, user, ready.binding, ready.marker);
    let launched = false;
    const options = { inputID: undefined as string | undefined, payload: used.payload, onDispatch: () => { launched = true; }, beforeDispatch: async () => {
      const current = await this.readyForResume(conv, id, token, true);
      if (!this.allowed(user)) throw new Error("Quyền người xác nhận đã thay đổi trong lúc chuẩn bị.");
      if (current.binding !== used.binding || current.marker !== used.marker || current.link.sessionID !== used.sessionID || current.link.directory !== used.directory) throw new Error("Mốc hoặc danh tính đổi sau khi nhận; chưa gửi yêu cầu, cần chuẩn bị lại.");
      const inputID = newMessageID();
      this.resumeConfirmations.bindInput(link.conv!, token, inputID);
      options.inputID = inputID;
    } };
    try {
      const state = this.st.peek(link.conv)!;
      const accepted = state.manager ? await this.orch.promptManager(link.conv, used.goal, undefined, options) : await this.runPrompt(link.conv, used.goal, state, undefined, options);
      if (!accepted) { this.resumeConfirmations.notStarted(link.conv, token); await this.tg.sendMessage(noticeConv, "Bộ điều phối chưa nhận công việc; xác nhận đã dùng, hãy kiểm tra chủ đề rồi chuẩn bị mới khi phù hợp."); }
      else await this.tg.sendMessage(noticeConv, "Đã nhận qua bộ điều phối của đúng phiên. Kết quả sẽ về chủ đề; chưa xác nhận hoàn tất và không tự gửi lại nếu mất phản hồi.");
    } catch (error) {
      if (!launched) this.resumeConfirmations.notStarted(link.conv, token);
      await this.tg.sendMessage(noticeConv, `${launched ? "Kết quả gửi chưa xác nhận; không tự gửi lại." : "Chưa gửi đầu vào mới."} ${esc((error as Error).message)}`);
    }
  }

  private newTitleSettings(conv: ConvKey, user: number, id?: string, preview?: TopicTitlePreview, customName?: string): string {
    for (const [key, value] of this.titleSettings) if (value.expires < Date.now()) this.titleSettings.delete(key);
    while (this.titleSettings.size >= 500) this.titleSettings.delete(this.titleSettings.keys().next().value!);
    const token = randomBytes(6).toString("hex");
    this.titleSettings.set(token, { chat: conv, user, id, preview, customName, expires: Date.now() + 10 * 60_000,
      stamp: this.topics.titleScopeStamp(conv, id) });
    return token;
  }

  private async showTitleSettings(conv: ConvKey, user: number, id?: string): Promise<void> {
    const link = id ? this.topics.get(id) : undefined;
    if (id && (!link || link.chat !== conv)) throw new Error("Chủ đề không thuộc nhóm này.");
    const group = this.topics.titleGroupPolicy(conv);
    const token = this.newTitleSettings(conv, user, id);
    const lines = ["<b>Thiết lập tên</b>", `Tự đồng bộ toàn nhóm: <b>${group.enabled ? "Bật" : "Tắt"}</b>`];
    const keyboard: Btn[][] = [];
    if (id && link) {
      const status = this.topics.titleStatus(conv, id);
      const mode = TITLE_POLICY_LABELS[status.policy.mode];
      lines.push(`Chủ đề: <b>${esc(trunc(link.title, 160))}</b> · ${DASHBOARD_PHASE_LABELS[link.phase]}`, `Phiên: <code>${esc(link.sessionID!)}</code>`, `Chế độ: <b>${mode}</b>`,
        `Tên đã nhận xác nhận: ${esc(trunc(status.confirmedName, 160))}`,
        status.policy.customName ? `Tên riêng đã chọn qua bot: ${esc(status.policy.customName)}` : "",
        status.pending ? "Đang chờ xử lý tên theo chính sách hiện tại." : "Không có yêu cầu tự đổi tên đang chờ.");
      if (status.error) lines.push(`Lỗi gần nhất: ${esc(trunc(status.error, 200))}`);
      if (status.pending && status.pendingName) lines.push(`Ý định tên đã lưu: ${esc(status.pendingName)}`);
      if (status.retryAt) {
        const date = new Date(status.retryAt);
        lines.push(`Thử lại không sớm hơn: ${Number.isFinite(date.getTime()) ? date.toISOString() : "mốc chờ quá xa"}`);
      }
      keyboard.push([{ text: "Theo OpenCode · xem trước", callback_data: `tc:${token}:preview` },
        { text: "Giữ tên hiện tại", callback_data: `tc:${token}:keep` }]);
      keyboard.push([{ text: "Đặt tên riêng", callback_data: `tc:${token}:custom` }]);
      if (status.policy.mode === "custom") keyboard.push([{ text: "Xem trước áp dụng lại tên riêng", callback_data: `tc:${token}:custom-preview` }]);
      if ((group.enabled && status.policy.mode === "follow") || (status.policy.mode === "custom" && status.pending)) keyboard.push([{ text: "Thử xử lý tên đang chờ", callback_data: `tc:${token}:retry` }]);
      keyboard.push([{ text: "Thiết lập toàn nhóm", callback_data: "tc:open:group" }]);
    } else {
      lines.push("Tắt nhóm dừng tự đổi tên của mọi chủ đề. Bật lại có xem trước; ngoại lệ giữ tên/tên riêng không bị bỏ qua.");
      if (group.enabled || this.topics.list(conv).some(link => link.titleSync?.pending)) keyboard.push([{ text: group.enabled ? "Tắt tự đồng bộ toàn nhóm" : "Hủy việc đặt tên đang chờ", callback_data: `tc:${token}:off` }]);
      keyboard.push([{ text: group.enabled ? "Xem trước đồng bộ lại" : "Xem trước bật đồng bộ", callback_data: "st:title-preview:0" }]);
    }
    lines.push("Tên là bản bot đã lưu, không phải truy vấn lại mọi tên Telegram. Không đổi tiêu đề OpenCode, không dừng công việc hoặc mở lại chủ đề.");
    keyboard.push([{ text: "Bảng điều khiển phiên", callback_data: "cmd:ls" }]);
    await this.tg.sendMessage(conv, lines.filter(Boolean).join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  }

  private async showCustomTitlePreview(conv: ConvKey, user: number, id: string, name: string, stamp: string): Promise<void> {
    const preview = { ...await this.topics.previewOpenCodeTitle(conv, id), after: name };
    if (this.topics.titleScopeStamp(conv, id) !== stamp) throw new Error("Phiên hoặc chính sách đã đổi; nhập lại tên từ Thiết lập tên.");
    const token = this.newTitleSettings(conv, user, id, preview, name);
    const keyboard: Btn[][] = [];
    if (!preview.error) keyboard.push([{ text: "Xác nhận đặt tên riêng", callback_data: `tc:${token}:confirm` }]);
    else keyboard.push([{ text: "Thử xem trước lại", callback_data: `tc:${token}:custom-preview` }]);
    keyboard.push([{ text: "Hủy", callback_data: `tc:${token}:cancel` }]);
    await this.tg.sendMessage(conv, [`<b>Xem trước tên riêng</b>`, `${esc(trunc(preview.before, 160))} → ${esc(name)}`,
      `Phiên: <code>${esc(this.topics.get(id)!.sessionID!)}</code>`,
      preview.error ? esc(preview.error) : "Đây là yêu cầu đặt tên thủ công một lần, vẫn thực hiện khi tự đồng bộ nhóm tắt. Không đổi tiêu đề OpenCode.",
      "Lỗi sẽ giữ ý định và thử lại theo giới hạn; tắt nhóm hoặc chọn Giữ tên hiện tại để hủy việc chưa gửi. Chủ đề đóng chờ bạn mở lại, bot không tự mở.",
    ].join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  }

  private async handleTitleInput(conv: ConvKey, user: number, msg: Message, text: string): Promise<boolean> {
    const key = `${conv}:${user}`;
    const input = this.titleInputs.get(key);
    if (!input) return false;
    if (/^\/cancel(?:@\w+)?$/i.test(text)) {
      this.titleInputs.delete(key);
      await this.tg.sendMessage(conv, "Đã hủy nhập tên riêng; không đổi tên.");
      return true;
    }
    if (msg.reply_to_message?.message_id !== input.messageID || text.startsWith("/")) return false;
    this.titleInputs.delete(key);
    try {
      if (input.expires < Date.now() || this.topics.titleScopeStamp(conv, input.id) !== input.stamp) throw new Error("Yêu cầu nhập tên đã hết hạn hoặc phiên/chính sách đã đổi. Mở lại Thiết lập tên.");
      const name = topicTitle(text);
      if (!name) throw new Error("Tên riêng không được trống; mở lại Đặt tên riêng để nhập tên khác.");
      await this.showCustomTitlePreview(conv, user, input.id, name, input.stamp);
    } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message),
      { reply_markup: { inline_keyboard: [[{ text: "Thiết lập tên", callback_data: `tc:open:${input.id}` }]] } }); }
    return true;
  }

  private async handleTitleSettings(conv: ConvKey, cb: CallbackQuery): Promise<void> {
    const parts = (cb.data ?? "").split(":");
    if (parts.length !== 3) throw new Error("Dữ liệu nút không hợp lệ; mở lại Thiết lập tên.");
    const [, token, action] = parts;
    const user = cb.from!.id;
    if (token === "open") { await this.showTitleSettings(conv, user, action === "group" ? undefined : action); return; }
    if (action === "cancel-input") {
      const key = `${conv}:${user}`;
      const input = this.titleInputs.get(key);
      if (!input || input.token !== token) throw new Error("Không có yêu cầu nhập tên thuộc bạn trên thẻ này.");
      this.titleInputs.delete(key);
      await this.tg.sendMessage(conv, "Đã hủy nhập tên riêng; không đổi tên.");
      await this.showTitleSettings(conv, user, input.id);
      return;
    }
    const card = this.titleSettings.get(token);
    if (!card || card.chat !== conv || card.user !== user || card.expires < Date.now() || this.topics.titleScopeStamp(conv, card.id) !== card.stamp) {
      throw new Error("Thẻ đã hết hạn, chính sách đã đổi hoặc không thuộc bạn/nhóm này. Mở lại Thiết lập tên.");
    }
    if (card.preview && !["confirm", "cancel", ...(card.customName && card.preview.error ? ["custom-preview"] : [])].includes(action)) throw new Error("Dùng đúng nút xác nhận hoặc hủy của bản xem trước.");
    if (action === "off" && !card.id) {
      this.titleSettings.delete(token);
      this.topics.setTitleGroupSync(conv, false);
      this.titlePreviews.delete(conv);
      await this.tg.sendMessage(conv, "Đã tắt tự đồng bộ tên và hủy việc chưa gửi. Lời gọi Telegram đã gửi không thể rút lại; công việc OpenCode không bị dừng.");
    } else if (action === "keep" && card.id) {
      this.titleSettings.delete(token);
      this.topics.setTitlePolicy(conv, card.id, { mode: "keep" });
      this.titlePreviews.delete(conv);
    } else if (action === "custom" && card.id) {
      for (const [key, value] of this.titleInputs) if (value.expires < Date.now()) this.titleInputs.delete(key);
      while (this.titleInputs.size >= 100) this.titleInputs.delete(this.titleInputs.keys().next().value!);
      const inputToken = randomBytes(6).toString("hex");
      const messageID = await this.tg.sendMessageId(conv, `<b>Nhập tên riêng</b>\nPhiên: <code>${esc(this.topics.get(card.id)!.sessionID!)}</code>\nTrả lời trực tiếp tin nhắn này bằng tên mới trong 10 phút. Bot sẽ chuẩn hóa một dòng, tối đa 128 ký tự rồi cho xem trước; chưa đổi tên ngay.`,
        { reply_markup: { inline_keyboard: [[{ text: "Hủy nhập tên", callback_data: `tc:${inputToken}:cancel-input` }]] } });
      if (!Number.isSafeInteger(messageID) || messageID <= 0 || this.topics.titleScopeStamp(conv, card.id) !== card.stamp) throw new Error("Không xác nhận được tin nhập hoặc phạm vi đã đổi; mở lại Thiết lập tên.");
      this.titleInputs.set(`${conv}:${user}`, { chat: conv, id: card.id, token: inputToken, expires: Date.now() + 10 * 60_000, messageID, stamp: card.stamp });
      return;
    } else if (action === "custom-preview" && card.id) {
      const name = card.customName ?? this.topics.titlePolicy(conv, card.id).customName;
      if (!name) throw new Error("Chưa có tên riêng để áp dụng lại; dùng Đặt tên riêng.");
      await this.showCustomTitlePreview(conv, user, card.id, name, card.stamp);
      return;
    } else if (action === "preview" && card.id) {
      const preview = await this.topics.previewOpenCodeTitle(conv, card.id);
      if (this.topics.titleScopeStamp(conv, card.id) !== card.stamp) throw new Error("Chính sách hoặc phiên đã đổi trong lúc xem trước; mở lại Thiết lập tên.");
      const next = this.newTitleSettings(conv, user, card.id, preview);
      const keyboard: Btn[][] = [];
      if (!preview.error) keyboard.push([{ text: "Xác nhận theo OpenCode", callback_data: `tc:${next}:confirm` }]);
      keyboard.push([{ text: "Hủy", callback_data: `tc:${next}:cancel` }]);
      await this.tg.sendMessage(conv, [`<b>Xem trước tên chủ đề</b>`, `${esc(trunc(preview.before, 160))} → ${esc(preview.after ?? "giữ tên hiện tại vì tiêu đề phiên trống")}`,
        preview.error ? esc(preview.error) : "Xác nhận bỏ ngoại lệ giữ tên/tên riêng cho chủ đề này; khi xử lý bot đọc lại tiêu đề mới nhất.",
        this.topics.titleSyncEnabled(conv) ? "Chủ đề đóng chỉ đổi tên sau khi được mở lại bằng luồng quản lý." : "Nhóm đang tắt; xác nhận chỉ lưu lựa chọn, chưa tự đổi tên.",
      ].join("\n"), { reply_markup: { inline_keyboard: keyboard } });
      return;
    } else if (action === "confirm" && card.id && card.preview && !card.preview.error) {
      this.titleSettings.delete(token);
      const link = this.topics.get(card.id)!;
      if (card.customName) this.topics.queueCustomTitle(conv, card.id, card.customName, card.stamp);
      else this.topics.setTitlePolicy(conv, card.id, { mode: "follow" });
      this.titlePreviews.delete(conv);
      if (!card.customName) this.topics.requestTitleSync(link.sessionID, true, conv);
      await this.tg.sendMessage(conv, card.customName ? "Đã lưu yêu cầu tên riêng; đang chờ xử lý đúng chủ đề. Tên chỉ được xác nhận sau khi Telegram chấp nhận; không mở lại phiên hoặc gọi mô hình." : "Đã chọn Theo OpenCode. Tên sẽ được xử lý khi nhóm bật và chủ đề mở; không tự mở lại hoặc gửi yêu cầu mô hình.");
    } else if (action === "retry" && card.id && (this.topics.followsOpenCode(conv, card.id) || this.topics.titleStatus(conv, card.id).pending)) {
      const result = await this.topics.syncTitle(conv, card.id, true);
      await this.tg.sendMessage(conv, ["synced", "unchanged"].includes(result.status) ? "Đã xác nhận đồng bộ tên." : "Chưa đồng bộ xong; giữ thời gian chờ, quyền và vòng đời hiện tại.");
    } else if (action === "cancel") this.titleSettings.delete(token);
    else throw new Error("Thao tác không phù hợp với chính sách hiện tại; không tự bật nhóm hoặc bỏ ngoại lệ.");
    await this.showTitleSettings(conv, user, card.id);
  }

  private async showTitlePreview(conv: ConvKey, user: number, token?: string, requestedPage = 0): Promise<void> {
    let preview = this.titlePreviews.get(conv);
    if (!token) {
      const stamp = this.topics.titleScopeStamp(conv);
      const rows = await this.topics.previewTitles(conv);
      if (this.topics.titleScopeStamp(conv) !== stamp) throw new Error("Chính sách hoặc liên kết đã đổi trong lúc xem trước; mở lại bằng /sessions.");
      preview = { token: randomBytes(8).toString("hex"), user, expires: Date.now() + 10 * 60_000,
        rows, stamp };
      this.titlePreviews.set(conv, preview);
    }
    if (!preview || preview.token !== (token ?? preview.token) || preview.user !== user || preview.expires < Date.now()) {
      throw new Error("Bản xem trước đã hết hạn hoặc không thuộc bạn. Mở lại bằng nút Đồng bộ tên chủ đề trong /sessions.");
    }
    const pages = Math.max(1, Math.ceil(preview.rows.length / 10));
    const page = Math.min(Math.max(0, requestedPage), pages - 1);
    const text = ["<b>Xem trước đồng bộ tên chủ đề</b>",
      "Tên bot đã lưu → tiêu đề OpenCode. Telegram không cung cấp cách đọc lại tên mọi chủ đề; tên đã sửa tay có thể khác bản lưu.",
      ...preview.rows.slice(page * 10, page * 10 + 10).map(row => `${esc(trunc(row.before, 100))} → ${esc(trunc(row.after ?? "giữ tên hiện tại", 100))}${row.error ? ` · ${esc(trunc(row.error, 100))}` : row.reason ? ` · ${esc(row.reason)}` : row.deferred ? " · hoãn đến khi phiên/chủ đề mở" : ""}`),
      `Trang ${page + 1}/${pages} · ${preview.rows.length} chủ đề.`,
      "Xác nhận bật cho nhóm và các chủ đề tạo sau này. Chỉ chủ đề chọn Theo OpenCode được ghi đè; ngoại lệ giữ tên/tên riêng được giữ nguyên.",
      "Chỉ đổi tên, không dừng công việc hay mở lại chủ đề đã đóng. Khi thực hiện bot đọc lại tiêu đề mới nhất.",
    ].join("\n");
    const rows: Btn[][] = [];
    const nav: Btn[] = [];
    if (page > 0) nav.push({ text: "⬅️ Trang trước", callback_data: `st:title-page:${preview.token}:${page - 1}` });
    if (page + 1 < pages) nav.push({ text: "Trang sau ➡️", callback_data: `st:title-page:${preview.token}:${page + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: this.topics.titleSyncEnabled(conv) ? "Đồng bộ lại tên trong nhóm" : "Bật đồng bộ tên cho nhóm", callback_data: `st:title-enable:${preview.token}` }]);
    rows.push([{ text: "Hủy", callback_data: `st:title-cancel:${preview.token}` }]);
    rows.push([{ text: "Thiết lập tên", callback_data: "tc:open:group" }]);
    await this.tg.sendMessage(conv, text, { reply_markup: { inline_keyboard: rows } });
  }

  private reconcileTopics(): Promise<void> {
    if (this.topicSync) { this.topicSyncAgain = true; return this.topicSync; }
    this.topicSync = (async () => {
      do {
        this.topicSyncAgain = false;
        for (const link of this.topics.list()) if (!this.topicAnnouncements.has(link.id)) this.topicAnnouncements.set(link.id, this.topicSignature(link));
        await this.topics.reconcile();
        this.topics.requestTitleSync();
        this.resumePromptReminders();
        for (const link of this.topics.list()) {
          if (this.topicAnnouncements.get(link.id) !== this.topicSignature(link)) await this.showTopicLink(link.chat, link);
          if (link.conv && link.titleSync?.error) this.publishNotice(link.conv, "naming", { kind: "operation", id: `name:${this.topics.titlePolicyStamp(link.chat, link.id)}` }, Date.now());
        }
      } while (this.topicSyncAgain);
    })().finally(() => { this.topicSync = undefined; });
    return this.topicSync;
  }

  private settingsSession(conv: ConvKey): string | undefined {
    return this.topics.enabled(conv) && conv === chatOf(conv) ? undefined : this.st.peek(conv)?.sessionID;
  }

  private async stopManagedTopic(conv: ConvKey): Promise<boolean> {
    const link = this.topics.forTopic(conv);
    if (!link || !await this.topics.stop(link.chat, link.id)) return false;
    this.inflight.get(conv)?.abort();
    this.stopTyping(conv);
    this.stopWorking(conv);
    this.clearActivity(conv);
    this.cancelAllReminders(conv);
    this.orch.clearManagerBusy(conv);
    await this.dropPreview(conv);
    const worker = this.st.peek(conv)?.worker;
    if (worker) this.st.set(conv, { worker: { ...worker, status: "stopped", updatedAt: Date.now() } });
    return true;
  }

  // ── PR watcher (watched GitHub repo → one line per new event) ─────────────
  /**
   * Kick off the PR watcher: the first tick builds a SILENT baseline (it
   * saves state but emits nothing — enabling the watcher must not replay the
   * repo's whole history into the chat), then re-checks on the configured
   * interval and posts one line per genuinely new event.
   */
  private startPrWatchMonitor(): void {
    if (!this.cfg.prWatch || !this.cfg.prWatchRepo) return;
    void this.prWatchTick();
    this.prWatchTimer = setInterval(() => void this.prWatchTick(), this.cfg.prWatchIntervalMs);
    this.prWatchTimer.unref?.();
  }

  /** One gh REST call for the watched repo (array form, no shell). */
  private ghApi<T = any>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      execFile(
        "gh",
        ["api", `repos/${this.cfg.prWatchRepo}/${path}`],
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`gh api ${path}: ${stderr?.trim() || err.message}`));
          try {
            resolve(JSON.parse(stdout) as T);
          } catch (e) {
            reject(e as Error);
          }
        },
      );
    });
  }

  /**
   * One watcher tick: list open + recently-closed PRs, refresh detail (review
   * comments / reviews / CI) for every open PR and for closed PRs we have not
   * seen yet, diff against the stored snapshot, and post the new events.
   * Never throws into the poll loop — any failure just skips this tick.
   */
  private async prWatchTick(): Promise<void> {
    if (!this.cfg.prWatch || !this.cfg.prWatchRepo || this.prWatchBusy) return;
    this.prWatchBusy = true;
    try {
      const repo = this.cfg.prWatchRepo;
      const [open, closed] = await Promise.all([
        this.ghApi<GhPr[]>("pulls?state=open&per_page=30&sort=created&direction=desc"),
        this.ghApi<GhPr[]>("pulls?state=closed&per_page=30&sort=updated&direction=desc"),
      ]);
      const prev = (this.st.peek(MACHINE_STATE_KEY)?.prWatchSnapshot ?? {}) as PrState;
      const now = Date.now();
      const dayMs = 24 * 3600 * 1000;
      const next: PrState = {};
      const details: { comments: Record<number, { id: number; user: string; body: string }[]>; reviews: Record<number, { id: number; user: string; state: string }[]> } =
        { comments: {}, reviews: {} };

      // Open PRs: details can always change (comments, reviews, CI) → refetch.
      for (const pr of open) {
        const d = await this.prWatchDetails(pr);
        next[pr.number] = d.snapshot;
        details.comments[pr.number] = d.comments;
        details.reviews[pr.number] = d.reviews;
      }
      // Closed PRs updated within the last 24 h: the first time we see one we
      // fetch details (its merge event + final CI fire once); afterwards we
      // keep the stored entry as-is so it is never re-announced.
      for (const pr of closed) {
        if (now - Date.parse(pr.updated_at) > dayMs) continue;
        if (prev[pr.number]) {
          next[pr.number] = prev[pr.number];
          continue;
        }
        const d = await this.prWatchDetails(pr);
        next[pr.number] = d.snapshot;
        details.comments[pr.number] = d.comments;
        details.reviews[pr.number] = d.reviews;
      }
      // Carry merged-but-unseen entries a little longer (state hygiene, 7 days)
      // so a restart within that window cannot re-announce an old merge.
      const weekMs = 7 * dayMs;
      for (const [n, s] of Object.entries(prev)) {
        const num = Number(n);
        if (!(num in next) && s.mergedAt && now - Date.parse(s.mergedAt) < weekMs) next[num] = s;
      }

      const firstRun = Object.keys(prev).length === 0;
      const events = firstRun ? [] : diffSnapshots(prev, next, details);
      if (!firstRun) log(`pr-watch: ${events.length} event(s) in tick`);
      const conv = this.lastActiveConv ?? (this.cfg.allowedUserIds[0] ? String(this.cfg.allowedUserIds[0]) : undefined);
      if (conv) for (const ev of events) await this.tg.sendMessage(conv, renderEvent(ev, repo)).catch(() => {});
      this.st.set(MACHINE_STATE_KEY, { prWatchSnapshot: next });
    } catch (e) {
      warn("pr-watch tick:", (e as Error).message);
    } finally {
      this.prWatchBusy = false;
    }
  }

  /** Fresh detail for one PR: snapshot fields + the comment/review rows the diff needs. */
  private async prWatchDetails(pr: GhPr): Promise<{
    snapshot: PrSnapshot;
    comments: { id: number; user: string; body: string }[];
    reviews: { id: number; user: string; state: string }[];
  }> {
    const [comments, reviews, checks] = await Promise.all([
      this.ghApi<Array<{ id: number; user: { login: string }; body: string }>>(`pulls/${pr.number}/comments?per_page=100`),
      this.ghApi<Array<{ id: number; user: { login: string }; state: string }>>(`pulls/${pr.number}/reviews?per_page=30`),
      this.ghApi<{ check_runs: Array<{ name: string; conclusion: string | null }> }>(`commits/${pr.head.sha}/check-runs?per_page=20`),
    ]);
    const conclusions = checks.check_runs.map((c) => c.conclusion);
    const terminal = conclusions.filter((c): c is string => !!c);
    const ciConclusion = terminal.length === 0
      ? null
      : conclusions.includes("failure")
        ? "failure"
        : conclusions.includes("cancelled")
          ? "cancelled"
          : terminal.every((c) => c === "success")
            ? "success"
            : null;
    return {
      snapshot: {
        number: pr.number,
        state: pr.state === "closed" ? "closed" : "open",
        headSha: pr.head.sha,
        title: pr.title,
        updated: pr.updated_at,
        mergedAt: pr.merged_at,
        maxCommentId: comments.reduce((m, c) => Math.max(m, c.id), 0),
        maxReviewId: reviews.reduce((m, r) => Math.max(m, r.id), 0),
        ciSha: pr.head.sha,
        ciName: checks.check_runs[0]?.name ?? null,
        ciConclusion,
      },
      comments: comments.map((c) => ({ id: c.id, user: c.user.login, body: c.body })),
      reviews: reviews.map((r) => ({ id: r.id, user: r.user.login, state: r.state })),
    };
  }

  // ── send helpers ─────────────────────────────────────────────────────────
  /** Send short, already-formatted HTML (commands, status). */
  private async sendHtml(conv: ConvKey, html: string, opts: { reply_markup?: Keyboard } = {}): Promise<void> {
    const chunks = chunk(html, this.cfg.replyMaxLen);
    // The keyboard (if any) rides on the final chunk.
    for (let i = 0; i < chunks.length; i++) {
      await this.tg.sendMessage(conv, chunks[i], i === chunks.length - 1 ? opts : {});
    }
  }
  /** Send a long model reply.
   * With `richReplies` on, send the raw Markdown as native rich (server-side
   * GFM, ~32 768-char limit) — one message unless it is a rare >30k tail — and
   * fall back to HTML per-message on error. Otherwise hand-render Markdown as
   * Telegram HTML (4 096-char limit). The quiet meta footer is a separate
   * message (see runPrompt) and is unaffected here.
   *
   * Reaction UX: every chunk's message_id is indexed (purpose "reply", or
   * "worker-done" when the conv is a worker topic) so a reaction on it can be
   * resolved; a worker that has just finished gets a 🎉 on its report.
   */
  private async sendReply(conv: ConvKey, text: string): Promise<void> {
    const clean = stripTags(text ?? "");
    if (!clean) return;
    const worker = this.st.peek(conv)?.worker;
    const purpose: MsgPurpose = worker ? "worker-done" : "reply";
    // Body language (feature C): celebrate ONLY the report of a worker that
    // has already settled to "done" (the settle races the relay; when the
    // status isn't done yet this is simply skipped — best-effort by design).
    const celebrate = worker?.status === "done";
    let lastId = -1;
    if (this.cfg.richReplies) {
      for (const c of richMarkdownChunks(clean)) {
        try {
          lastId = await this.tg.sendRich(conv, c);
        } catch (e) {
          // Per-message graceful fallback: retry THIS chunk through the existing
          // HTML path (mdToHtmlChunks + sendMessage) so a rich parse/method error
          // costs only this message, never a lost reply.
          warn(`sendRich failed (${(e as Error)?.message ?? e}) — falling back to HTML for one chunk`);
          for (const h of mdToHtmlChunks(c, this.cfg.replyMaxLen)) await this.tg.sendMessage(conv, h);
          lastId = -1;
        }
        this.indexSent(conv, lastId, c, purpose);
      }
      this.celebrateWorkerDone(conv, lastId, celebrate);
      return;
    }
    for (const c of mdToHtmlChunks(clean, this.cfg.replyMaxLen)) {
      lastId = await this.tg.sendMessageId(conv, c);
      this.indexSent(conv, lastId, c, purpose);
    }
    this.celebrateWorkerDone(conv, lastId, celebrate);
  }

  /**
   * Reaction UX: index a message we just sent, so a user reaction on it can be
   * resolved to a conv/purpose. No-op when the flag is off or the send yielded
   * no message id. Prunes on every write (the cap keeps state.json small).
   */
  private indexSent(conv: ConvKey, messageId: number, text: string, purpose: MsgPurpose): void {
    if (!this.cfg.react || !Number.isInteger(messageId) || messageId < 0) return;
    const { chatId } = parseConv(conv);
    const m = this.st.peek(MACHINE_STATE_KEY) ?? {};
    const idx = {
      ...(m.msgIndex ?? {}),
      [indexKey(chatId, messageId)]: {
        conv,
        purpose,
        ...(purpose === "worker-done" ? { workerConv: conv } : {}),
        text: text.slice(0, REACT_TEXT_MAX),
        ts: Date.now(),
      },
    };
    this.st.set(MACHINE_STATE_KEY, { msgIndex: pruneIndex(idx, REACT_INDEX_CAP) });
  }

  /** Reaction UX: index an incoming user message (see indexSent). */
  private indexUserMessage(conv: ConvKey, messageId: number, text: string): void {
    if (!this.cfg.react || !text) return;
    const { chatId } = parseConv(conv);
    const m = this.st.peek(MACHINE_STATE_KEY) ?? {};
    const idx = {
      ...(m.msgIndex ?? {}),
      [indexKey(chatId, messageId)]: { conv, purpose: "user-msg" as MsgPurpose, text: text.slice(0, REACT_TEXT_MAX), ts: Date.now() },
    };
    this.st.set(MACHINE_STATE_KEY, { msgIndex: pruneIndex(idx, REACT_INDEX_CAP) });
  }

  /**
   * Reaction UX: mark (message,emoji) as fired, BEFORE any async action, so a
   * doubled update or a second tap of the same emoji can't trigger twice.
   */
  private markReacted(chatId: number, messageId: number, emoji: string): void {
    const m = this.st.peek(MACHINE_STATE_KEY) ?? {};
    const reacted: Record<string, true> = { ...(m.reacted ?? {}), [reactedKey(chatId, messageId, emoji)]: true };
    this.st.set(MACHINE_STATE_KEY, { reacted: pruneReacted(reacted, REACTED_CAP) });
  }

  /**
   * Body language (feature C): the bot reacts to a message. Best-effort — a
   * failure is logged and never affects the turn (setReaction never throws).
   */
  private bodyReact(conv: ConvKey, messageId: number | undefined, emoji: string): void {
    if (!this.cfg.react || !messageId) return;
    const { chatId } = parseConv(conv);
    void this.tg.setReaction(chatId, messageId, emoji).then((ok) => {
      if (!ok) log(`body reaction ${emoji} missed on ${conv} msg ${messageId}`);
    });
  }

  /** Body language (feature C): 🎉 on a worker's DONE report, just sent. */
  private celebrateWorkerDone(conv: ConvKey, messageId: number, celebrate: boolean): void {
    if (!celebrate) return;
    this.bodyReact(conv, messageId, REACTION_CELEBRATE);
  }

  /**
   * Reaction UX: a user reaction landed. Resolves the (message,emoji) pair
   * against the persisted index and fires the mapped action at most once.
   * Deliberately cheap up front: dedup + mark happen synchronously, before
   * any await, so concurrent/duplicated updates can't double-trigger.
   */
  private async onMessageReaction(ev: MessageReactionUpdated): Promise<void> {
    if (!this.cfg.react || !this.allowed(ev.user?.id)) return;
    if (this.topics.enabled(String(ev.chat.id))) {
      await this.tg.sendMessage(String(ev.chat.id), "Use General commands/buttons to manage sessions. Reactions never close, delete or create managed sessions.");
      return;
    }
    const emoji = ev.new_reaction?.[0];
    if (!emoji || emoji.type !== "emoji" || !emoji.emoji) return; // only emoji reactions act
    const chatId = ev.chat.id;
    const messageId = ev.message_id;
    const m = this.st.peek(MACHINE_STATE_KEY) ?? {};
    if (alreadyReacted(m.reacted, chatId, messageId, emoji.emoji)) return; // fired once, ever
    this.markReacted(chatId, messageId, emoji.emoji);
    const entry = m.msgIndex?.[indexKey(chatId, messageId)];
    if (!entry) {
      const key = indexKey(chatId, messageId);
      if (!this.missingIdxLogged.has(key)) {
        this.missingIdxLogged.add(key);
        log(`reaction ${emoji.emoji} on unindexed message ${key} — ignoring (sent before the reaction UX, or pruned)`);
      }
      return;
    }
    const action = classifyAction(emoji.emoji);
    if (!action) return; // any other emoji: no-op
    try {
      if (action === "spawn") await this.reactSpawn(entry);
      else if (action === "approve") await this.reactApprove(entry);
      else await this.reactReject(entry);
    } catch (e) {
      error(`reaction ${action} failed:`, (e as Error)?.message ?? e);
    }
  }

  /**
   * 🔥 on an indexed message (any conv, bot or user text): ask the MANAGER to
   * spawn a worker for it. The Manager gets the message text as a "[Bot event]"
   * (the same queueReport → notifyManager path as worker reports / 👎 rejects)
   * and crafts the task itself — it has the full conversation context a worker
   * would lack, and picks the name, directory and agent. One short ack line
   * lands in the conversation; the Manager reports the spawn back.
   *
   * Guard: a 🔥 on a USER message is never a spawn (decideSpawn →
   * "already-processed") — that message already went through a turn, so
   * spawning a worker from it would duplicate in-flight work. The bot just
   * confirms it already got it.
   */
  private async reactSpawn(entry: { conv: string; purpose: MsgPurpose; text: string }): Promise<void> {
    if (decideSpawn(entry.purpose) === "already-processed") {
      await this.tg
        .sendMessage(entry.conv, "👌 Tôi đã nhận rồi — không spawn worker trùng. Muốn tách worker: 🔥 vào tin của tôi.")
        .catch(() => {});
      return;
    }
    const text = entry.text.trim();
    if (text.length < 8) return; // too short to be a task
    const chat = chatOf(entry.conv);
    if (!this.orch.isManagerConv(chat)) {
      await this.tg.sendMessage(chat, "⚠️ 🔥 cần Manager đang bật (/manager on) để soạn task cho worker.").catch(() => {});
      return;
    }
    await this.tg.sendMessage(chat, "📝 Đã nhận — Manager sẽ soạn task và spawn worker trong giây lát…").catch(() => {});
    this.orch.relaySpawnRequest(entry.conv, text);
  }

  /**
   * 👍: valid only on a worker's DONE report. If that worker is still busy we
   * just say so; otherwise the existing purge path retires the worker conv
   * (topic + worktree + session + state) and one line confirms it in General.
   */
  private async reactApprove(entry: { purpose: MsgPurpose; conv: string; workerConv?: string }): Promise<void> {
    if (entry.purpose !== "worker-done") return; // approved something else: no-op
    const workerConv = (entry.workerConv ?? entry.conv) as ConvKey;
    const w = this.st.peek(workerConv)?.worker;
    const decision = decideApprove(entry.purpose, w ? w.status === "running" || w.status === "waiting" : false);
    const chat = chatOf(workerConv);
    if (decision === "busy") {
      await this.tg.sendMessage(chat, "⏳ worker vẫn đang chạy").catch(() => {});
      return;
    }
    if (decision === "invalid") return;
    const res = await this.orch.approveWorkerReport(workerConv);
    if (res.busy) {
      await this.tg.sendMessage(chat, "⏳ worker vẫn đang chạy").catch(() => {});
      return;
    }
    if (!res.ok) {
      await this.tg.sendMessage(chat, "⚠️ Chưa dọn xong worker (worktree chưa xoá được — thử /prune sau).").catch(() => {});
      return;
    }
    await this.tg.sendMessage(chat, `✅ ${esc(res.name ?? "worker")} approved — dọn xong.`).catch(() => {});
  }

  /**
   * 👎: valid only on a worker's DONE report — relay it to the Manager session
   * (the same "[Bot event]" path the worker-finish relay uses). Never touches
   * the worker conv itself.
   */
  private reactReject(entry: { purpose: MsgPurpose; conv: string; workerConv?: string }): void {
    if (entry.purpose !== "worker-done") return;
    const workerConv = (entry.workerConv ?? entry.conv) as ConvKey;
    this.orch.rejectWorkerReport(workerConv);
  }

  /** A media message with no text/caption — acknowledge it; the bot reads text only. */
  private async noteNonText(conv: ConvKey, msg: Message): Promise<void> {
    const note = msg.sticker
      ? "🫣 Tôi chỉ đọc được văn bản — hãy gõ nội dung, hoặc gửi ảnh kèm caption."
      : msg.voice
        ? "🎤 Tôi chưa nghe được voice — xin gửi nội dung dạng văn bản."
        : msg.photo
          ? "📷 Tôi chưa xem được ảnh — hãy gửi kèm caption để tôi xử lý."
          : "📎 Tôi mới chỉ xử lý được tin nhắn văn bản (và caption của media).";
    await this.tg.sendMessage(conv, note).catch(() => {});
  }

  /**
   * One short user notice per DNS self-heal incident (called from the Telegram
   * poll loop after the heal command finishes). Sent to the user's last active
   * top-level chat, falling back to their private chat (user id == chat id in a
   * 1:1). Best-effort: the network may still be down, so the send may fail.
   */
  notifyDnsHeal(): void {
    const conv = this.lastActiveConv ?? (this.cfg.allowedUserIds[0] ? String(this.cfg.allowedUserIds[0]) : undefined);
    if (!conv) return;
    log(`DNS heal: notifying user in ${conv}`);
    void this.tg.sendMessage(conv, "🔧 Bot tự sửa DNS (VPN) — polling có thể gián đoạn vài giây.").catch(() => {});
  }

  // ── typing indicator ─────────────────────────────────────────────────────────
  /**
   * Keep "typing…" showing for as long as the turn runs. Telegram's indicator
   * expires after ~5s, so we re-arm it on a timer until the reply is sent (stopTyping).
   */
  private startTyping(conv: ConvKey): void {
    this.stopTyping(conv);
    this.tg.sendChatAction(conv, "typing");
    const t = setInterval(() => this.tg.sendChatAction(conv, "typing"), 4000);
    (t as any).unref?.();
    this.typing.set(conv, t);
  }
  /** Stop the repeating typing indicator for a chat (no-op if not running). */
  private stopTyping(conv: ConvKey): void {
    const t = this.typing.get(conv);
    if (t) clearInterval(t);
    this.typing.delete(conv);
  }

  // ── "⏳ Đang xử lý…" working indicator (General top-level only) ─────────────
  /**
   * Telegram's native "typing…" doesn't render in a forum group's General
   * top-level pane, leaving a blank gap from turn start until the first
   * text/tool event (when the streaming preview appears). Post a "⏳ Đang xử lý…"
   * line to fill it; it shows elapsed time and is removed by stopWorking. No-op
   * for DMs (native typing renders fine there). Manager turns only — runPromptTask
   * is manager-only, so worker topics never reach here.
   */
  private startWorking(conv: ConvKey): void {
    if (!this.cfg.working || isDmConv(conv)) return; // manager turns in groups/topics; DMs show native typing fine
    if (this.working.has(conv)) return;
    log(`⏳ working indicator shown for ${conv}`);
    const startedAt = Date.now();
    this.working.set(conv, { msgId: undefined, startedAt, timer: undefined }); // sync marker (race-safe)
    void this.tg
      .sendMessageId(conv, "⏳ Đang xử lý…")
      .then((id) => {
        const e = this.working.get(conv);
        if (id <= 0) {
          this.working.delete(conv);
          return;
        }
        if (!e) return void this.tg.deleteMessage(conv, id).catch(() => {}); // turn ended before the send: delete the orphan
        e.msgId = id;
        e.timer = setInterval(() => {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          void this.tg.editMessageText(conv, id, `⏳ Đang xử lý… · ${secs}s`).catch(() => {});
        }, 10000);
        (e.timer as any).unref?.();
      })
      .catch(() => this.working.delete(conv));
  }

  /** Remove the "⏳ Đang xử lý…" line (idempotent) — when the reply stream starts or the turn ends. */
  private stopWorking(conv: ConvKey): void {
    const e = this.working.get(conv);
    if (!e) return;
    this.working.delete(conv);
    if (e.timer) clearInterval(e.timer);
    if (!e.msgId) return;
    const msgId = e.msgId;
    const shownMs = Date.now() - e.startedAt;
    log(`⏳ working indicator stopping for ${conv} (shown ${Math.round(shownMs / 1000)}s)`);
    // Keep the line visible for a minimum of ~1.5s so a fast reply (first event
    // before the line even lands, or within a second) doesn't make it a
    // sub-second flash the user never notices.
    const remaining = 1500 - shownMs;
    if (remaining <= 0) {
      void this.tg.deleteMessage(conv, msgId).catch(() => {});
    } else {
      const t = setTimeout(() => void this.tg.deleteMessage(conv, msgId).catch(() => {}), remaining);
      (t as any).unref?.();
    }
  }

  // ── live tool activity (one self-editing line per conv) ─────────────────────
  /** Show (or update) the "agent is doing…" line for a conv. */
  private async showActivity(conv: ConvKey, label: string): Promise<void> {
    if (!this.cfg.activity) return;
    const cur = this.activity.get(conv);
    if (cur) {
      this.activity.set(conv, { ...cur, label, toolStart: Date.now() });
      await this.tg.editMessageText(conv, cur.msgId, label).catch(() => {});
    } else {
      const msgId = await this.tg.sendMessageId(conv, label).catch(() => -1);
      if (msgId > 0) this.activity.set(conv, { msgId, label, toolStart: Date.now() });
    }
  }

  /** Mark the current tool done (✅/❌ + elapsed) on the activity line. */
  private async finishActivity(conv: ConvKey, ok: boolean): Promise<void> {
    const cur = this.activity.get(conv);
    if (!cur) return;
    const secs = (Date.now() - cur.toolStart) / 1000;
    await this.tg.editMessageText(conv, cur.msgId, activityDoneLine(cur.label, ok, secs)).catch(() => {});
  }

  /** Remove the activity line when the turn ends (idempotent). */
  private clearActivity(conv: ConvKey): void {
    const cur = this.activity.get(conv);
    this.activity.delete(conv);
    this.toolNames.delete(conv);
    if (cur) void this.tg.deleteMessage(conv, cur.msgId).catch(() => {});
  }

  /** One OpenCode tool event → update the activity line (no-op when disabled). */
  private onToolEvent(t: string, d: any): void {
    if (!this.cfg.activity) return;
    const conv = d?.sessionID ? this.st.findChatBySession(d.sessionID) : undefined;
    if (!conv) return;
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, d.sessionID)) return;
    const id = typeof d?.id === "string" ? d.id : undefined;
    const names = this.toolNames.get(conv);
    if (t === "session.tool.input.started") {
      if (id && typeof d?.name === "string" && d.name) {
        if (!names) this.toolNames.set(conv, new Map([[id, d.name]]));
        else names.set(id, d.name);
      }
      return;
    }
    const name = id ? names?.get(id) : undefined;
    if (name === "question") return; // the question card already shows this
    if (t === "session.tool.called") {
      void this.showActivity(conv, toolActivityLabel(name ?? "tool", d?.input));
    } else {
      void this.finishActivity(conv, t === "session.tool.success");
      if (id) names?.delete(id);
    }
  }

  // ── live streaming draft (Bot API 10.1+ sendMessageDraft; pure preview) ─────
  /**
   * One OpenCode `session.text.delta` → advance the conv's live streaming draft.
   * The segment key is `assistantMessageID` + `ordinal`: OpenCode gives each
   * text part a fresh id and a new part begins after every tool call, so the
   * draft resets per segment (no text carried over from the previous part).
   * No-op when streaming is disabled (the caller gates on cfg.stream).
   */
  private onDraftTextDelta(d: any): void {
    const conv = d?.sessionID ? this.st.findChatBySession(d.sessionID) : undefined;
    if (!conv) return;
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, d.sessionID)) return;
    const w = this.streamFor(conv);
    const segKey = `${d?.assistantMessageID ?? ""}:${d?.ordinal ?? 0}`;
    const r = onTextDelta(w.state, segKey, String(d?.delta ?? ""), Date.now(), w.throttleMs, w.budget);
    w.state = r.state;
    if (r.action) void this.pushPreview(conv, r.action);
  }

  /**
   * One OpenCode tool start → flash the conv's live draft to the "Thinking…"
   * placeholder. No-op when there is no visible draft text yet. No-op when
   * streaming is disabled (the caller gates on cfg.stream).
   */
  private onDraftToolStart(d: any): void {
    const conv = d?.sessionID ? this.st.findChatBySession(d.sessionID) : undefined;
    if (!conv) return;
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, d.sessionID)) return;
    const w = this.streamFor(conv);
    const r = onToolStart(w.state, Date.now(), w.throttleMs);
    if (r.state) w.state = r.state;
    if (r.action) void this.pushPreview(conv, r.action);
  }

  /** Lazily create the conv's streaming wrapper (fresh per turn). */
  private streamFor(conv: ConvKey): {
    state: DraftState | null;
    previewMsgId?: number;
    throttleMs: number;
    nextEditAt: number;
    budget: number;
    gen: number;
  } {
    let w = this.drafts.get(conv);
    if (!w) {
      const dm = isDmConv(conv);
      w = {
        state: null,
        previewMsgId: undefined,
        throttleMs: dm ? 1500 : 3000,
        nextEditAt: 0,
        budget: dm ? Infinity : EDIT_BUDGET,
        gen: this.turnGen.get(conv) ?? 0,
      };
      this.drafts.set(conv, w);
    }
    return w;
  }

  /**
   * Deliver one preview update through the transport for this conversation:
   * ephemeral `sendMessageDraft` in a 1:1 chat (native stop button), and a
   * self-editing PLAIN-TEXT message in a group (drafts are rejected there with
   * TEXTDRAFT_PEER_INVALID; plain text because a half-streamed reply is not
   * valid HTML/Markdown mid-flight). Best-effort: any failure only slows or
   * stops the preview, never the turn.
   */
  private async pushPreview(
    conv: ConvKey,
    action: { draftID: number; text: string },
  ): Promise<void> {
    const w = this.drafts.get(conv);
    if (!w || w.gen !== this.turnGen.get(conv) || w.previewMsgId === 0 || Date.now() < w.nextEditAt) return;
    const text = action.text || "✍️ Đang xử lý…";
    try {
      if (isDmConv(conv)) {
        // 1:1: ephemeral draft ("" renders the client's "Thinking…" placeholder).
        const ok = await this.tg.sendMessageDraft(conv, action.draftID, action.text, { canStop: true });
        if (!ok) w.nextEditAt = Date.now() + 2000;
        return;
      }
      if (w.previewMsgId === undefined) {
        this.stopWorking(conv); // the streamed reply takes over — drop the "⏳ Đang xử lý…" line
        const id = await this.tg.sendMessageId(conv, text, { parse_mode: undefined });
        w.previewMsgId = id > 0 ? id : 0;
      } else {
        await this.tg.editMessageText(conv, w.previewMsgId, text, { parse_mode: undefined });
      }
    } catch (e: any) {
      // Flood control → honor retry_after; anything else → brief pause. In
      // both cases the throttle adapts upward (3s → 6s → 10s cap) so a long
      // turn can never storm the chat's edit rate limit.
      const ra = Number(e?.retryAfter ?? 0);
      w.nextEditAt = Date.now() + (ra > 0 ? ra * 1000 : 1000);
      if (e?.code === 404) w.previewMsgId = 0; // deleted under us — stop editing
      w.throttleMs = Math.min(w.throttleMs * 2, 10000);
    }
  }

  /**
   * Kill the conv's preview before the final reply lands: delete the
   * self-editing message (group transport) and mark the wrapper dead so late
   * deltas of this turn cannot spawn a stray preview after the final message.
   * The wrapper is removed at the start of the NEXT turn (runPromptTask).
   */
  private async dropPreview(conv: ConvKey): Promise<void> {
    const w = this.drafts.get(conv);
    // Bump the generation FIRST so even a concurrent in-flight pushPreview
    // result cannot re-arm the preview after this point.
    this.turnGen.set(conv, (this.turnGen.get(conv) ?? 0) + 1);
    if (!w) return;
    if (w.previewMsgId && w.previewMsgId !== 0) await this.tg.deleteMessage(conv, w.previewMsgId).catch(() => {});
    w.previewMsgId = 0;
  }

  // ── command dispatch ─────────────────────────────────────────────────────
  // ── pending-prompt reminders (exponential backoff) ──────────────────────────
  /** Timer key: scope a reminder to a conv + prompt id so a conv's form and
   *  permission (or several prompts) each keep their own schedule. */
  private reminderKey(conv: ConvKey, promptId: string): string {
    return `${conv}::${promptId}`;
  }

  /**
   * (Re)start the reminder nudges for one pending form/permission. Exponential
   * backoff: the 1st reminder fires after `remindBaseMs`, each later one farther
   * out (`base * factor^n`) — deliberately NOT a fixed interval.
   */
  private startPromptReminder(conv: ConvKey, promptId: string, kind: "form" | "permission", text: string, keyboard?: unknown, messageId?: number): void {
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, this.st.peek(conv)?.sessionID ?? "")) return;
    const prev = this.st.get(conv).pendingPrompts?.[promptId];
    const sched = scheduleForRegistration(prev, kind, this.cfg.remindBaseMs, Date.now());
    const pp = { kind, text, keyboard, messageId: messageId ?? prev?.messageId, ...sched };
    this.st.set(conv, { pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: pp } });
    if (this.cfg.remind) this.armReminderTimer(conv, promptId);
  }

  /** (Re)arm the one-shot reminder timer for one prompt from its persisted schedule. */
  private armReminderTimer(conv: ConvKey, promptId: string): void {
    const key = this.reminderKey(conv, promptId);
    const existing = this.reminders.get(key);
    if (existing) clearTimeout(existing);
    if (!this.cfg.remind) { this.reminders.delete(key); return; }
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, this.st.peek(conv)?.sessionID ?? "")) { this.reminders.delete(key); return; }
    const pp = this.st.get(conv).pendingPrompts?.[promptId];
    if (!pp) return;
    if (reminderBudgetExhausted(pp.remindersSent, this.cfg.remindMax)) return; // spent: stays persisted, no more nudges
    const delay = clampTimerDelay(Math.max(0, pp.nextReminderAt - Date.now())); // overdue → fire soon
    this.reminders.set(key, setTimeout(() => void this.fireReminder(conv, promptId), delay));
  }

  /** Stop nudging one prompt and forget its schedule (the prompt stays pending). */
  private cancelReminder(conv: ConvKey, promptId: string): void {
    const key = this.reminderKey(conv, promptId);
    const t = this.reminders.get(key);
    if (t) clearTimeout(t);
    this.reminders.delete(key);
    const prompts = this.st.get(conv).pendingPrompts;
    if (prompts && promptId in prompts) {
      const next = { ...prompts };
      delete next[promptId];
      this.st.set(conv, { pendingPrompts: next });
    }
  }

  /** Stop nudging ALL pending prompts of a conv (used by /new, /use, /stop, /clear). */
  private cancelAllReminders(conv: ConvKey): void {
    for (const id of Object.keys(this.st.get(conv).pendingPrompts ?? {})) this.cancelReminder(conv, id);
  }

  /**
   * Find which conv holds a pending prompt by its id. Needed to cancel a
   * reminder even after a restart, when the in-memory form/permission maps are
   * empty but the schedule is still persisted in state.
   */
  private findPromptConv(promptId: string): ConvKey | undefined {
    for (const conv of Object.keys(this.st.all())) {
      if (this.st.get(conv).pendingPrompts?.[promptId]) return conv;
    }
    return undefined;
  }

  /** On startup, re-arm reminder timers for any persisted pending prompts. */
  private resumePromptReminders(): void {
    if (!this.cfg.remind) return;
    for (const conv of Object.keys(this.st.all())) {
      for (const id of Object.keys(this.st.get(conv).pendingPrompts ?? {})) this.armReminderTimer(conv, id);
    }
  }

  /**
   * Fire one reminder: re-send the prompt (with its buttons), then back off
   * further until the budget is exhausted. Re-reads state AFTER the await so a
   * prompt that was cancelled/answered/overwritten in the meantime is not
   * nudged, and a different prompt isn't mistaken for this one.
   */
  private async fireReminder(conv: ConvKey, promptId: string): Promise<void> {
    this.reminders.delete(this.reminderKey(conv, promptId));
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, this.st.peek(conv)?.sessionID ?? "")) return;
    const pp = this.st.get(conv).pendingPrompts?.[promptId];
    if (!pp) return; // cancelled/answered in the meantime
    // The live prompt must be tracked in memory. After a restart an overdue timer
    // can fire before reconcile() has re-read OpenCode; re-sending then could show
    // a card with dead buttons. Do NOT forget the schedule here: reconcile() either
    // re-registers a still-pending prompt (scheduleForRegistration keeps this
    // schedule and re-arms it) or drops a settled one as stale.
    const live = pp.kind === "form" ? this.questionForms.has(promptId) : this.permissionPrompts.has(promptId);
    if (!live) return;
    const max = this.cfg.remindMax;
    const sent = pp.remindersSent + 1;
    // Nudge by EDITING the original card in place (⏰ count line on top) — one
    // prompt = one message, never a duplicate per nudge. Falls back to a fresh
    // message only when the original is gone (deleted by the user, too old).
    const text = `⏰ <i>Nhắc (${sent}/${max}): câu hỏi/quyền này vẫn đang chờ bạn trả lời — hoặc gõ /stop để bỏ.</i>\n\n${pp.text}`;
    const edited = pp.messageId
      ? await this.editCardInPlace(conv, pp.messageId, text, pp.keyboard as Keyboard | undefined)
      : -1;
    if (edited < 0) {
      const freshId = await this.tg
        .sendMessageId(conv, text, { reply_markup: pp.keyboard as Keyboard | undefined })
        .catch(() => -1);
      if (freshId > 0) {
        this.st.set(conv, {
          pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: { ...pp, messageId: freshId } },
        });
      }
    }
    if (reminderBudgetExhausted(sent, max)) {
      // Budget exhausted: stop nudging (the prompt stays pending). Keep the entry
      // with the spent count so a restart doesn't hand it a fresh budget.
      const spent = this.st.get(conv).pendingPrompts?.[promptId];
      if (spent && spent.firstShownAt === pp.firstShownAt) {
        this.st.set(conv, { pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: { ...spent, remindersSent: sent } } });
      }
      return;
    }
    // Re-read AFTER the await: only advance the schedule if this is STILL the
    // same pending prompt (not cancelled, answered, or overwritten meanwhile).
    const cur = this.st.get(conv).pendingPrompts?.[promptId];
    const advance = nextScheduleAfterReminder(pp, cur, this.cfg.remindBaseMs, this.cfg.remindFactor, Date.now());
    if (advance && cur) {
      this.st.set(conv, { pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: { ...cur, ...advance } } });
      this.armReminderTimer(conv, promptId);
    }
  }

  private async handleCommand(conv: ConvKey, raw: string, state: ChatState, uid?: number): Promise<void> {
    const [rawCmd, ...rest] = raw.split(/\s+/);
    // In groups, commands may arrive as /cmd@BotName.
    const cmd = rawCmd.replace(/@\w+$/, "");
    const arg = rest.join(" ").trim();
    if (this.scheduler?.owns(conv) && ["/new", "/use", "/clear", "/dir", "/browse", "/b"].includes(cmd.toLowerCase())) {
      await this.tg.sendMessage(conv, "⏳ Lượt chạy lịch chưa xác nhận kết thúc. Dùng /stop và chờ xác nhận trước khi đổi session hoặc thư mục.");
      return;
    }
    if (await this.orch.handleCommand(conv, cmd.toLowerCase(), arg)) return;
    switch (cmd.toLowerCase()) {
      case "/start":
      case "/help":
        return this.cmdHelp(conv);
      case "/new":
        return this.cmdNew(conv, state, /--keep\b/i.test(arg));
      case "/ls":
      case "/sessions":
        return this.cmdList(conv);
      case "/use":
        return this.cmdUse(conv, arg, state);
      case "/dir":
        return this.cmdDir(conv, arg, state);
      case "/browse":
      case "/b":
        return this.cmdBrowse(conv, arg, state);
      case "/models":
        return this.cmdModels(conv);
      case "/model":
        return this.cmdModel(conv, arg, state);
      case "/agents":
        return this.cmdAgents(conv);
      case "/agent":
        return this.cmdAgent(conv, arg, state);
      case "/modes":
      case "/mode":
        return this.cmdMode(conv, arg, state);
      case "/variants":
        return this.cmdVariants(conv, arg, state);
      case "/variant":
        return this.cmdVariantSet(conv, arg, state);
      case "/stop":
        return this.cmdStop(conv, state);
      case "/reboot":
        return this.cmdReboot(conv);
      case "/status":
        return this.cmdStatus(conv, state);
      case "/context":
      case "/ctx":
        return this.cmdContext(conv, state);
      case "/usage":
        return this.cmdUsage(conv, arg);
      case "/history":
        return this.cmdHistory(conv, state);
      case "/clear":
        return this.cmdClear(conv, state);
      case "/note":
        return this.cmdNote(conv, arg);
      case "/schedule":
        return this.cmdSchedule(conv, arg, state, uid);
      default:
        return this.tg.sendMessage(conv, `Unknown command: ${esc(cmd)}\nSend /help`);
    }
  }

  // ── the long-running prompt ──────────────────────────────────────────────
  private async runPrompt(conv: ConvKey, text: string, state: ChatState, userMsgId?: number,
    options?: { inputID?: string; payload: string; onDispatch(): void; beforeDispatch(): Promise<void> }): Promise<boolean> {
    // A closed worker topic reopens itself when the user speaks in it
    // (openForumTopic is a no-op on an already-open topic, so safe every time).
    if (state.worker && !this.topics.enabled(conv)) void this.tg.openForumTopic(conv).catch(() => {});
    if (this.inflight.has(conv)) {
      if (userMsgId != null) {
        // Offer a one-tap "save as note" for this dropped message: the button's
        // callback data carries the user message's id and its text is retained,
        // so the tap can append it to /note (see handleNoteCallback).
        const kb: Keyboard = { inline_keyboard: [[{ text: NOTE_BUTTON_LABEL, callback_data: noteCallbackData(userMsgId) }]] };
        await this.tg.sendMessage(conv, BUSY_REPLY_TEXT, { reply_markup: kb });
        this.busyNotes.push(conv, userMsgId, text);
      } else {
        await this.tg.sendMessage(conv, BUSY_REPLY_TEXT);
      }
      return false;
    }
    // Keep the "typing…" indicator alive for the whole turn (until the reply is sent).
    let releaseWorker: (() => void) | undefined;
    try { releaseWorker = this.orch.beginWorkerTurn(conv); }
    catch (e) { await this.tg.sendMessage(conv, esc((e as Error).message)); return false; }
    const ac = new AbortController();
    this.inflight.set(conv, ac);
    this.startTyping(conv);
    this.startWorking(conv); // "⏳ Đang xử lý…" — General top-level only (native typing doesn't render there)
    try {
      let sid = state.sessionID;
      if (!sid) {
        sid = await this.oc.createSession(state.directory || this.cfg.opencodeDirectory);
        await this.applyModelAndVariant(sid, state);
        if (state.agent) await this.oc.setAgent(sid, state.agent).catch((e) => warn("setAgent:", e?.message));
        this.st.set(conv, { sessionID: sid });
      }
      // "Stay in the user's language" is a per-session INSTRUCTION (OpenCode
      // injects `api/*` entries into the system context), not prepended text —
      // cleaner and it doesn't grow the user-turn context. Tracked per SESSION
      // (guidedLanguageSession), so a brand-new session after /new, /use, setsess,
      // or plan→build gets it re-applied on its first prompt.
      if (this.cfg.guideLanguage) {
        if (state.guidedLanguageSession !== sid) {
          try {
            await this.oc.setInstruction(sid, LANGUAGE_INSTRUCTION_KEY, LANGUAGE_INSTRUCTION);
            // Record on success only — a failure is retried on the next prompt.
            this.st.set(conv, { guidedLanguageSession: sid });
          } catch (e) {
            warn("setInstruction:", (e as Error)?.message);
          }
        }
      } else if (!this.languageRemoved.has(sid)) {
        // Toggle off: strip any instruction a previous (enabled) run left on this
        // session (idempotent; remembered per process so we don't call it every
        // prompt). Clear the applied-marker so re-enabling re-applies it.
        try {
          await this.oc.removeInstruction(sid, LANGUAGE_INSTRUCTION_KEY);
          this.languageRemoved.add(sid); // success only — a failure is retried on the next prompt
        } catch (e) {
          warn("removeInstruction:", (e as Error)?.message);
        }
        if (state.guidedLanguageSession === sid) this.st.set(conv, { guidedLanguageSession: undefined });
      }
      // Scratchpad notes (/note): retire last turn's notes or surface pending ones.
      if (ac.signal.aborted) throw new Error("Yêu cầu đã bị dừng trong lúc chuẩn bị; chưa gửi đầu vào mới.");
      await this.prepareNotesTurn(conv, sid);
      // Inject the "ask via question tool" preamble once per session so the agent
      // knows it is headless and should surface decisions as answerable questions.
      let promptText = text;
      const needsGuide = this.cfg.guideQuestions && !state.guided;
      if (needsGuide) {
        promptText = QUESTIONS_PREAMBLE + "\n\n" + text;
      }
      if (options && promptText !== options.payload) throw new Error("Nội dung chỉ dẫn đã đổi; cần chuẩn bị lại trước khi gửi.");
      await options?.beforeDispatch();
      if (options && !options.inputID) throw new Error("Chưa ghi được mã đầu vào; không gửi yêu cầu.");
      if (ac.signal.aborted) throw new Error("Yêu cầu đã bị dừng trong lúc chuẩn bị; chưa gửi đầu vào mới.");
      if (needsGuide) this.st.set(conv, { guided: true });
      log(`[chat ${conv}] prompt on ${sid} (${text.length} chars)`);
      options?.onDispatch();
      // Fire-and-forget: don't block the polling loop; /stop aborts `ac`.
      void this.runPromptTask(conv, sid, promptText, ac, userMsgId, text, options?.inputID).catch((e) => error("prompt task:", e?.message)).finally(() => releaseWorker?.());
      return true;
    } catch (e) {
      this.stopTyping(conv); // don't leave "typing…" running if the prompt never started
      if (this.inflight.get(conv) === ac) this.inflight.delete(conv);
      releaseWorker?.();
      throw e;
    }
  }

  private async runPromptTask(conv: ConvKey, sid: string, text: string, ac: AbortController, userMsgId?: number, originalText = text, suppliedMessageID?: string): Promise<void> {
    // One id for this user message, reused by the reconnect retry below: the
    // server dedupes on it, so the retry waits on the same turn instead of
    // running the instruction a second time.
    const messageID = suppliedMessageID ?? newMessageID();
    this.recordSessionActivity(() => this.sessionActivity.begin(conv, { sessionID: sid, inputID: messageID, text: originalText, source: "topic" }));
    // Bump the turn generation: invalidates any preview state from a previous
    // turn (its wrapper may still linger to absorb late deltas) and starts the
    // streaming wrapper for this turn fresh.
    this.turnGen.set(conv, (this.turnGen.get(conv) ?? 0) + 1);
    this.drafts.delete(conv);
    const run = () => this.oc.promptAndWait(sid, text, { signal: ac.signal, messageID });
    try {
      let res;
      try {
        res = await run();
      } catch (e) {
        // A persistent "Transport: fetch failed" usually means the OpenCode
        // service restarted on a new port (stale URL). Re-discover and retry
        // once; the retry rides out the reconnect.
        if (!suppliedMessageID && !ac.signal.aborted && isTransportError(e)) {
          warn("prompt failed (transport) — reconnecting to OpenCode and retrying…");
          await this.oc.reconnect();
          res = await run();
        } else {
          throw e;
        }
      }
      if (this.topics.enabled(conv) && ac.signal.aborted) return;
      if (res.replyID && res.replyInputID === messageID) this.recordSessionActivity(() => this.sessionActivity.complete(conv,
        { sessionID: sid, inputID: messageID, messageID: res.replyID!, text: res.reply, outcome: res.replyOutcome, createdAt: res.replyTime }));
      else this.recordSessionActivity(() => this.sessionActivity.uncertain(conv, sid, messageID, "Chưa đối chiếu được phản hồi với đúng đầu vào."));
      if (res.replyInputID === messageID) this.recordSessionActivity(() => this.resumeConfirmations.observe(conv, [messageID]));
      this.recordSessionActivity(() => this.publishActivityOutcome(conv));
      this.stopTyping(conv);
      // Drop the live preview before the final message lands (group transport
      // keeps a real, self-editing message that must not outlive the reply).
      await this.dropPreview(conv);
      // A failed turn produced no useful reply — surface the real reason (often
      // context overflow, fixable with /clear) instead of an opaque "failed · Xs".
      if (res.outcome === "failed" && !res.interrupted) {
        if (res.reply) {
          await this.sendReply(conv, res.reply);
          if (res.replyTime) this.st.set(conv, { lastRelayedTime: res.replyTime });
        }
        // A genuine failure (not a user /stop): attach a one-tap "⏯ Chạy tiếp"
        // button to the failure message so the user can resume the same session.
        const kb = this.offerContinueKeyboard(conv, sid, messageID, res.outcome, res.interrupted);
        await this.sendHtml(conv, formatTurnFailure(res.error, res.elapsedMs), kb ? { reply_markup: kb } : {});
        // Body language (feature C): the bot dislikes the turn that failed.
        this.bodyReact(conv, userMsgId, REACTION_FAIL);
        return;
      }
      const reply = res.reply || (res.interrupted ? "(interrupted — no text produced yet)" : "(no text reply)");
      await this.sendReply(conv, reply);
      // Remember the newest reply we've relayed so a restart can recover any that
      // were produced but never sent (see recoverOrphanedReplies).
      if (res.replyTime) this.st.set(conv, { lastRelayedTime: res.replyTime });
      // A quiet italic footer. The <i> tags are meant to render (HTML mode), so
      // we do NOT escape the whole string — only the server-supplied outcome text.
      const meta = `<i>${esc(res.outcome ?? "")} · ${(res.elapsedMs / 1000).toFixed(1)}s${res.interrupted ? " · stopped" : ""}</i>`;
      await this.tg.sendMessage(conv, meta).catch(() => {});
      if (!res.interrupted && res.reply) await this.maybeOfferPlanToBuild(conv);
    } catch (e) {
      if (this.topics.enabled(conv) && ac.signal.aborted) return;
      this.recordSessionActivity(() => this.sessionActivity.uncertain(conv, sid, messageID, "Kết quả gửi hoặc thực thi chưa được đối chiếu."));
      this.stopTyping(conv);
      await this.dropPreview(conv);
      error("prompt error:", (e as Error)?.message);
      const msg = isTransportError(e)
        ? "⚠️ Không thể nối tới OpenCode (service có thể đang restart / chưa chạy). Hẵng thử lại sau, hoặc kiểm tra `opencode service status`."
        : `❌ Error: ${esc((e as Error).message)}`;
      await this.tg.sendMessage(conv, msg).catch(() => {});
      // Body language (feature C): the bot dislikes the turn that failed.
      this.bodyReact(conv, userMsgId, REACTION_FAIL);
    } finally {
      this.clearActivity(conv);
      this.stopWorking(conv); // safety net: drop the "⏳ Đang xử lý…" line if it never reached the stream
      // NOTE: do NOT delete the streaming wrapper here — it must stay (killed
      // by the generation bump in dropPreview) so late deltas of this turn
      // cannot spawn a stray preview after the final message. The NEXT turn
      // removes it (see the turnGen bump at the top of runPromptTask).
      if (this.inflight.get(conv) === ac) this.inflight.delete(conv);
      this.busyNotes.clear(conv); // the turn ended: the note-button retention window is over
    }
  }

  /**
   * After a successful turn that ENDED in plan mode, offer the one-tap
   * plan-to-build handoff: switch to the build agent and execute the plan that
   * is already in the session context. Offered on every successful plan turn
   * (not just once), and skipped while the agent is mid-question.
   */
  private async maybeOfferPlanToBuild(conv: ConvKey): Promise<void> {
    const st = this.st.get(conv);
    if (st.agent !== "plan") return;
    if ([...this.questionForms.values()].some((q) => q.conv === conv)) return;
    const kb: Keyboard = {
      inline_keyboard: [[{ text: "🔨 Sang build & thực thi", callback_data: "pb:go" }]],
    };
    await this.tg
      .sendMessage(conv, "📐 <b>Kế hoạch đã sẵn sàng</b> — bấm để chuyển sang build và thực thi.", { reply_markup: kb })
      .catch(() => {});
  }

  /**
   * Decide whether to offer the "⏯ Chạy tiếp" button for a turn that just ended
   * in this conv, and if so record the anti-spam marker and return its keyboard.
   * Returns undefined (no button) when it is not a genuine failure, when we have
   * already offered one for this same turn, or when the callback data would
   * exceed Telegram's limit. Pure decision + encoding live in src/continue.ts.
   */
  private offerContinueKeyboard(
    conv: ConvKey,
    sessionID: string,
    turnId: string,
    outcome: string | undefined,
    interrupted: boolean,
  ): Keyboard | undefined {
    if (!shouldOfferContinue({ outcome, interrupted })) return undefined;
    const data = continueCallbackData(sessionID);
    if (!data) return undefined; // too long to ship — omit the button
    if (alreadyOfferedContinue(this.st.peek(conv)?.continueOfferedTurn, turnId)) return undefined;
    this.st.set(conv, { continueOfferedTurn: turnId });
    return { inline_keyboard: [[{ text: CONTINUE_BUTTON_LABEL, callback_data: data }]] };
  }

  /**
   * Stop waiting on the conversation's running turn. With `interrupt`, also
   * interrupt that turn on the server — otherwise switching away (/new, /clear,
   * opening another session) left the old session running and spending tokens.
   */
  private async stopCurrent(conv: ConvKey, interrupt = false): Promise<void> {
    this.stopTyping(conv);
    this.clearActivity(conv);
    this.busyNotes.clear(conv); // /stop (and /new, /clear) end the turn: drop the note-button retention
    await this.dropPreview(conv); // stopping a turn drops its live preview (and kills late deltas)
    this.orch.clearManagerBusy(conv); // /new, /clear, /stop all drop the manager's session — never let a late terminal event wedge the flag
    const ac = this.inflight.get(conv);
    if (ac) ac.abort();
    const sid = this.st.peek(conv)?.sessionID;
    if (ac && interrupt && sid) await this.oc.interrupt(sid).catch((e) => warn("interrupt:", e?.message));
  }

  /**
   * The user tapped the native stop button on a live streaming draft
   * (Bot API 10.1+ `stopped_message_generation`). Map the event to its
   * conversation, drop the draft state, and interrupt the turn using the SAME
   * logic /stop uses: abort the in-flight controller (if any) PLUS an explicit
   * server-side interrupt — the fallback that also stops fire-and-forget
   * manager turns, which have no in-flight controller. No reply message: the
   * user already knows (they tapped stop).
   */
  private async onStoppedMessageGeneration(ev: MessageGenerationStopped): Promise<void> {
    const conv = this.convOf({ ...ev, is_topic_message: Boolean(ev.message_thread_id) });
    if (this.topics.enabled(conv)) {
      if (this.topics.forTopic(conv)) await this.stopManagedTopic(conv);
      return;
    }
    if (await this.scheduler?.requestStop(conv)) return;
    this.drafts.delete(conv);
    await this.stopCurrent(conv);
    this.cancelAllReminders(conv);
    const sid = this.st.peek(conv)?.sessionID;
    if (sid) await this.oc.interrupt(sid).catch(() => {});
  }

  // ── model + variant helpers ─────────────────────────────────────────────────────
  /** Resolve the model ref to use: explicit per-chat > config default > session's current model. */
  private async resolveModel(state: ChatState, sessionID?: string): Promise<{ id: string; providerID: string } | null> {
    if (state.model) return state.model;
    if (this.cfg.defaultModel) return this.cfg.defaultModel;
    if (sessionID) {
      const s = await this.oc.getSession(sessionID).catch(() => null);
      if (s?.model?.id && s?.model?.providerID) return { id: s.model.id, providerID: s.model.providerID };
    }
    return null;
  }

  /** Apply the chat's model + effective variant to a session (best-effort, non-fatal). */
  private async applyModelAndVariant(sessionID: string, state: ChatState): Promise<void> {
    const model = await this.resolveModel(state, sessionID);
    if (!model) return;
    const variant = state.variant ?? this.cfg.defaultVariant;
    await this.oc.setModel(sessionID, { ...model, variant }).catch((e) => warn("applyModelAndVariant:", e?.message));
  }

  // ── commands ─────────────────────────────────────────────────────────────
  // The autocomplete menu, the /help card, and the button grid are all
  // rendered from the shared catalog (src/commands.ts) so they cannot drift
  // apart (drift cost us two follow-up fixes: /agents, /reboot).
  private async cmdHelp(conv: ConvKey): Promise<void> {
    const scope = this.topics.enabled(conv) ? conv === chatOf(conv) ? "general" : "topic" : undefined;
    await this.sendHtml(conv, helpText(scope), { reply_markup: commandGrid(scope) });
  }

  /** Register the Telegram /command menu (autocomplete) — cosmetic, best-effort. */
  private registerCommands(): void {
    void this.tg.setMyCommands(myCommands()).catch((e) => warn("setMyCommands:", e?.message));
  }

  private async cmdNew(conv: ConvKey, state: ChatState, keep = false): Promise<void> {
    // --keep: capture a short handoff summary of the CURRENT session before
    // replacing it, then inject it into the fresh session's context so the new
    // session continues with the recent thread (decisions, in-progress work)
    // instead of starting cold. Rules (project-memory) persist by default;
    // the recent conversation is what --keep carries over.
    const oldSID = state.sessionID;
    let carryover = "";
    if (keep && oldSID) {
      await this.tg.sendMessage(conv, "🔁 Đang tóm tắt session cũ để giữ mạch…");
      carryover = await this.summarizeForHandoff(oldSID);
    }
    await this.stopCurrent(conv, true);
    this.cancelAllReminders(conv); // abandoning the current session's pending prompts
    const dir = state.directory || this.cfg.opencodeDirectory;
    const sessionID = await this.oc.createSession(dir);
    await this.applyModelAndVariant(sessionID, state);
    if (state.agent) await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
    if (carryover) {
      // Inject the carry-over as a system-context instruction (no turn consumed),
      // so the fresh session "remembers" the recent thread for its whole life.
      await this.oc
        .setInstruction(
          sessionID,
          CARRYOVER_KEY,
          `You are continuing from a previous session. Carry-over context (recent decisions, in-progress work, open threads):\n${carryover}\nContinue from here, picking up where the previous session left off.`,
        )
        .catch((e) => warn("carryover instruction:", (e as Error).message));
    }
    this.st.set(conv, { sessionID, directory: dir, ...dropNotes() }); // a fresh session must not inherit pending notes
    await this.tg.sendMessage(
      conv,
      `🆕 New session <code>${sessionID}</code>\ndir: <code>${esc(dir)}</code>${keep ? `\n🔁 carry-over: ${carryover ? "✓" : "(session cũ trống)"}` : ""}`,
    );
  }

  /**
   * Ask the (soon-to-be-replaced) session for a concise handoff summary of the
   * recent thread. Runs as one hidden turn in that session; the reply stays in
   * the (abandoned) session, so it never reaches the user's chat.
   */
  private async summarizeForHandoff(sessionID: string): Promise<string> {
    try {
      const r = await this.oc.promptAndWait(
        sessionID,
        "Summarize the recent conversation for handoff to a fresh session: key decisions, in-progress work, important facts, and open threads. Be concise (≤ 300 words). Do NOT summarize this summarization request itself.",
      );
      const t = (r.reply ?? "").trim();
      return t.length > 4000 ? `${t.slice(0, 4000)}…` : t;
    } catch (e) {
      warn("handoff summary:", (e as Error).message);
      return "";
    }
  }

  /**
   * `/note [text]` — jot down information while the agent is busy. Without a
   * text, show the pending notes. The note reaches the model through an
   * instruction entry at the start of the next user-initiated turn and retires
   * on the turn after that (see src/notes.ts).
   */
  private async cmdNote(conv: ConvKey, arg: string): Promise<void> {
    const text = arg.trim();
    if (!text) {
      const pending = showNotes(this.st.get(conv));
      await this.tg.sendMessage(conv, pending ? `📝 Ghi chú đang chờ:\n${esc(pending)}` : "Chưa có ghi chú nào. Dùng: /note (nội dung)");
      return;
    }
    const cur = this.st.get(conv);
    const next = appendNote(cur, text, Date.now());
    this.st.set(conv, next);
    const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
    if (sid) {
      // Best-effort immediate PUT so the note is in context by the time the next
      // turn starts; prepareNotesTurn re-puts at turn start anyway (self-healing).
      await this.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!)).catch((e) => warn("note put:", (e as Error).message));
    }
    await this.tg.sendMessage(conv, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.");
  }

  /**
   * "📝 Thêm vào note" button on a busy reply: append the user message that was
   * dropped (the agent was busy) to the scratchpad notes, so the agent sees it on
   * the next turn. The text is looked up in the in-memory retention map by the
   * user message's Telegram id (carried in the callback data); if the turn has
   * already ended (or the bot restarted) the entry is gone → "not found".
   */
  private async handleNoteCallback(cb: CallbackQuery, conv: ConvKey, messageId: number | undefined): Promise<void> {
    const id = parseNoteCallback(cb.data);
    if (id == null) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    // Consume the entry NOW (before any await) so a double-tap can't append twice.
    const text = this.busyNotes.take(conv, id);
    if (text == null) {
      await this.tg.answerCallbackQuery(cb.id, "Không tìm thấy nội dung tin nhắn đó.");
      return;
    }
    // Save via the SAME path as cmdNote: append + persist + best-effort PUT.
    const cur = this.st.get(conv);
    const next = appendNote(cur, text, Date.now());
    this.st.set(conv, next);
    const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
    if (sid) {
      await this.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!)).catch((e) => warn("note put:", (e as Error).message));
    }
    await this.tg.answerCallbackQuery(cb.id, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.");
    // Remove the button: edit the busy message back to plain text (empty keyboard).
    // Best-effort — the message may be too old or deleted; ignore gracefully.
    if (messageId != null) {
      await this.tg
        .editMessageText(conv, messageId, BUSY_REPLY_TEXT, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
  }

  /**
   * Start of a user-initiated turn: retire notes already shown last turn, or make
   * pending notes visible in this turn's system context. Never throws — a notes
   * failure must not break the turn.
   */
  private async prepareNotesTurn(conv: ConvKey, sid: string): Promise<void> {
    try {
      const prep = prepareNotes(this.st.get(conv));
      if (prep.put || prep.remove) this.st.set(conv, prep.state);
      if (prep.put) await this.oc.setInstruction(sid, NOTES_KEY, prep.put);
      else if (prep.remove) await this.oc.removeInstruction(sid, NOTES_KEY);
    } catch (e) {
      warn("notes turn prep:", (e as Error).message);
    }
  }

  private async cmdList(conv: ConvKey): Promise<void> {
    const sessions = await this.oc.listSessions();
    if (!sessions.length) return this.tg.sendMessage(conv, "No sessions yet. Send /new.");
    const cur = this.st.get(conv).sessionID;
    const lines = sessions
      .slice(0, 15)
      .map((s) => `${s.id === cur ? "▶️ " : ""}<code>${s.id}</code>${s.title ? " — " + esc(s.title) : ""}`);
    const active = cur ? `\n\nCurrent: <code>${cur}</code>` : "\n\nNo current session — send /new";
    await this.sendHtml(conv, `<b>Sessions (${sessions.length})</b>\n${lines.join("\n")}${active}`);
  }

  /**
   * `/use [session-id]` — switch to a session. Without a valid argument the
   * user gets a button picker of the 10 newest sessions instead of a usage line.
   */
  private async cmdUse(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    void state;
    let sessions: SessionBrief[] | undefined;
    try {
      sessions = await this.oc.listSessions();
    } catch (e) {
      warn("listSessions:", (e as Error).message);
    }
    if (!arg) {
      if (!sessions) return this.tg.sendMessage(conv, "⚠️ Không liệt kê được session — kiểm tra OpenCode rồi thử lại.");
      if (!sessions.length) return this.tg.sendMessage(conv, "Chưa có session — gửi /new để tạo.");
      return this.sendUsePicker(conv, sessions, undefined);
    }
    // Unknown id (and the listing succeeded) → show the picker too; a failed
    // listing keeps the old behaviour of trusting the typed id.
    if (sessions && !sessions.some((s) => s.id === arg)) {
      return this.sendUsePicker(conv, sessions, `❌ Không có session <code>${esc(arg)}</code>`);
    }
    this.applyUseState(conv, arg);
    await this.tg.sendMessage(conv, `✅ Now using session <code>${esc(arg)}</code>`);
  }

  /** Apply the /use switch: remember the session and drop its predecessor's pending prompts. */
  private applyUseState(conv: ConvKey, sessionID: string): void {
    this.st.set(conv, { sessionID });
    this.cancelAllReminders(conv); // switching sessions abandons the old pending prompts
  }

  /** The /use picker card: newest 10 sessions as buttons + a "type it instead" hint. */
  private sendUsePicker(conv: ConvKey, sessions: SessionBrief[], errorNote?: string): Promise<void> {
    const cur = this.st.get(conv).sessionID;
    const newest = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 10);
    const rows: Btn[][] = newest.map((s) => [
      { text: `${s.id === cur ? "▶️ " : ""}${s.title ? trunc(s.title, 40) : trunc(s.id, 14)}`, callback_data: `use:${s.id}` },
    ]);
    rows.push([
      { text: "📄 Xem tất cả", callback_data: "use:ls" },
      { text: "❌ Đóng", callback_data: "use:close" },
    ]);
    return this.tg.sendMessage(
      conv,
      [errorNote ?? "❓ <b>/use</b> cần session-id", "Bấm để chọn session (mới nhất trước):", "Hoặc gửi: <code>/use &lt;session-id&gt;</code>"].join("\n"),
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  /** Handle a tap on the /use picker (data = `use:<id|ls|close>`). */
  private async handleUseCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const id = (cb.data ?? "").slice("use:".length);
    if (id === "close" || id === "ls") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.deleteMessage(conv, messageId).catch(() => {});
      if (id === "ls") await this.cmdList(conv);
      return;
    }
    this.applyUseState(conv, id);
    await this.tg.answerCallbackQuery(cb.id, `Dùng ${trunc(id, 30)}`);
    if (messageId) await this.tg.editMessageText(conv, messageId, `✅ Đang dùng session <code>${esc(id)}</code>`).catch(() => {});
  }

  private async cmdDir(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    if (!arg) {
      return this.tg.sendMessage(conv, `📁 Current directory:\n<code>${esc(state.directory || this.cfg.opencodeDirectory)}</code>`);
    }
    const p = isAbsolute(arg) ? arg : resolve(this.cfg.opencodeDirectory, arg);
    if (!existsSync(p)) return this.tg.sendMessage(conv, `❌ No such directory: <code>${esc(p)}</code>`);
    this.st.set(conv, { directory: p });
    await this.tg.sendMessage(
      conv,
      `📁 Directory set to <code>${esc(p)}</code>\n(used for the next /new)\nTip: /browse to pick a folder with buttons.`,
    );
  }

  // ── folder browser ───────────────────────────────────────────────────────
  /**
   * Open the folder browser at `arg` (or the chat's current directory). The
   * browser lives in a single message: every button tap edits that message
   * instead of posting new ones, so the chat stays readable.
   */
  private async cmdBrowse(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    const roots = this.cfg.browseRoots;
    if (!roots.length) return this.tg.sendMessage(conv, "❌ Không có thư mục nào được phép duyệt.");
    const requested = arg
      ? resolve(this.cfg.opencodeDirectory, arg)
      : state.directory || this.cfg.opencodeDirectory;
    let path = resolve(requested);
    let note: string | undefined;
    if (!isUnderRoot(path, roots)) {
      const owner = roots.find((r) => isUnderRoot(path, [r]));
      path = owner ?? roots[0];
      note = `⚠️ <code>${esc(requested)}</code> nằm ngoài vùng được duyệt — đã mở tại <code>${esc(path)}</code>.`;
    }
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return this.tg.sendMessage(conv, `❌ Không phải thư mục: <code>${esc(path)}</code>`);

    const b: BrowseState = { path, showHidden: false, items: [], page: 0, view: "list", opened: false, note };
    await this.reloadBrowse(b);
    this.browsers.set(conv, b);
    const v = this.renderBrowse(b);
    await this.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
  }

  /** Re-read the current directory and keep the page index in range. */
  private async reloadBrowse(b: BrowseState): Promise<void> {
    try {
      b.items = await listDirs(b.path, b.showHidden);
      b.error = undefined;
    } catch (e) {
      b.items = [];
      b.error = `⚠️ Không đọc được thư mục: ${esc((e as Error).message)}`;
    }
    const maxPage = Math.max(0, Math.ceil(b.items.length / BROWSE_PAGE_SIZE) - 1);
    if (b.page > maxPage) b.page = maxPage;
  }

  /** Build the text + inline keyboard for the current browser view. */
  private renderBrowse(b: BrowseState): { text: string; keyboard: Keyboard } {
    if (b.view === "choose") {
      return {
        text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, "", "<b>Chọn cách mở thư mục này:</b>"].join("\n"),
        keyboard: {
          inline_keyboard: [
            [{ text: "📁 Chỉ đặt thư mục", callback_data: "bs:setdir" }],
            [{ text: "🚀 Đặt + mở session mới", callback_data: "bs:setsess" }],
            [
              { text: "↩️ Quay lại", callback_data: "bs:list" },
              { text: "❌ Đóng", callback_data: "bs:close" },
            ],
          ],
        },
      };
    }

    if (b.view === "done") {
      const rows: Btn[][] = [];
      if (!b.opened) rows.push([{ text: "🚀 Mở session mới tại đây", callback_data: "bs:setsess" }]);
      rows.push([{ text: "📂 Duyệt tiếp", callback_data: "bs:list" }]);
      rows.push([{ text: "❌ Đóng", callback_data: "bs:close" }]);
      return { text: b.result ?? "✅ Xong", keyboard: { inline_keyboard: rows } };
    }

    // list view
    const pageCount = Math.max(1, Math.ceil(b.items.length / BROWSE_PAGE_SIZE));
    const start = b.page * BROWSE_PAGE_SIZE;
    const slice = b.items.slice(start, start + BROWSE_PAGE_SIZE);
    const rows: Btn[][] = [];
    for (let i = 0; i < slice.length; i += BROWSE_COLUMNS) {
      rows.push(
        slice.slice(i, i + BROWSE_COLUMNS).map((it, j) => ({
          text: `📂 ${trunc(it.name, 18)}`,
          callback_data: `bs:nav:${start + i + j}`,
        })),
      );
    }

    const nav: Btn[] = [];
    if (parentWithin(b.path, this.cfg.browseRoots)) {
      nav.push({ text: "⬆️ Lên", callback_data: "bs:up" });
    }
    nav.push({ text: b.showHidden ? "🙈 Ẩn file ẩn" : "👁 Hiện file ẩn", callback_data: "bs:hid" });
    nav.push({ text: "✅ Mở tại đây", callback_data: "bs:open" });
    rows.push(nav);

    if (pageCount > 1) {
      rows.push([
        { text: "◀️", callback_data: `bs:pg:${b.page - 1}` },
        { text: `${b.page + 1}/${pageCount}`, callback_data: "bs:noop" },
        { text: "▶️", callback_data: `bs:pg:${b.page + 1}` },
      ]);
    }
    rows.push([{ text: "❌ Đóng", callback_data: "bs:close" }]);

    const meta: string[] = [];
    if (b.note) meta.push(b.note);
    if (b.error) meta.push(b.error);
    meta.push(
      `<i>${b.items.length} thư mục con${pageCount > 1 ? ` · trang ${b.page + 1}/${pageCount}` : ""}</i>`,
    );
    meta.push("Chạm một thư mục để vào · ✅ để mở OpenCode tại đây");
    return {
      text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, ...meta].join("\n"),
      keyboard: { inline_keyboard: rows },
    };
  }

  /** Handle a button tap on the browser message. */
  private async handleCallback(cb: CallbackQuery): Promise<void> {
    if (!this.allowed(cb.from?.id)) {
      await this.tg.answerCallbackQuery(cb.id, "⛔ Không được phép");
      return;
    }
    const conv = cb.message ? this.convOf(cb.message) : undefined;
    const messageId = cb.message?.message_id;
    const data = cb.data ?? "";
    if (!conv) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    if (this.topics.enabled(conv)) {
      if (data === "mgr:open") {
        if (conv !== chatOf(conv)) {
          await this.tg.answerCallbackQuery(cb.id, "Mở phiên quản lý trong General.");
          return;
        }
        await this.tg.answerCallbackQuery(cb.id);
        await this.orch.handleCommand(conv, "/manager", "on");
        return;
      }
      if (data.startsWith("tc:")) {
        if (conv !== chatOf(conv)) { await this.tg.answerCallbackQuery(cb.id, "Thiết lập tên trong General."); return; }
        await this.tg.answerCallbackQuery(cb.id);
        try { await this.handleTitleSettings(conv, cb); }
        catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message),
          { reply_markup: { inline_keyboard: [[{ text: "Thiết lập tên", callback_data: "tc:open:group" }]] } }); }
        return;
      }
      if (data.startsWith("sum:")) {
        if (conv !== chatOf(conv)) { await this.tg.answerCallbackQuery(cb.id, "Xem tóm tắt trong General."); return; }
        await this.tg.answerCallbackQuery(cb.id);
        try {
          const [, action, value] = data.split(":");
          if (action === "show") await this.showSessionSummary(conv, cb.from!.id, value);
          else if (action === "refresh" || action === "prepare") {
            const card = this.summaryCards.get(value);
            const link = card && this.topics.get(card.id);
            if (!card || card.chat !== conv || card.user !== cb.from!.id || card.expires < Date.now() || !link || this.summaryBinding(link) !== card.binding) throw new Error("Thẻ tóm tắt hết hạn hoặc không thuộc bạn/nhóm/phiên này.");
            if (action === "prepare") await this.prepareResumeInput(conv, cb.from!.id, card);
            else await this.showSessionSummary(conv, cb.from!.id, card.id, true);
          } else throw new Error("Nút tóm tắt không hợp lệ.");
        } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
        return;
      }
      if (data.startsWith("nt:")) {
        await this.tg.answerCallbackQuery(cb.id);
        if (conv !== chatOf(conv)) { await this.tg.sendMessage(conv, "Xem thiết lập thông báo trong General."); return; }
        try { const [, action, token] = data.split(":"); await this.showNoticeSettings(conv, cb.from!.id, action, token); }
        catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
        return;
      }
      if (data.startsWith("resume:")) {
        if (conv !== chatOf(conv)) { await this.tg.answerCallbackQuery(cb.id, "Xác nhận tiếp tục trong General."); return; }
        await this.tg.answerCallbackQuery(cb.id);
        try { await this.handleResumeCallback(conv, cb); }
        catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
        return;
      }
      if (data.startsWith("pa:")) {
        if (conv !== chatOf(conv)) { await this.tg.answerCallbackQuery(cb.id, "Mở danh sách đang chờ trong General."); return; }
        await this.tg.answerCallbackQuery(cb.id);
        const [, action, target, value] = data.split(":");
        try {
          if (!/^(?:0|[1-9]\d{0,5})$/.test(value ?? "")) throw new Error("Trang hoặc yêu cầu không hợp lệ.");
          if (action === "list") await this.showPendingActions(conv, cb.from!.id, target, Number(value));
          else if (action === "relay") await this.relayPendingAction(conv, cb.from!.id, target, Number(value));
          else throw new Error("Thao tác không hợp lệ.");
        } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
        return;
      }
      if (data.startsWith("db:")) {
        if (conv !== chatOf(conv)) { await this.tg.answerCallbackQuery(cb.id, "Dùng bảng điều khiển trong General."); return; }
        await this.tg.answerCallbackQuery(cb.id);
        const [, token, action, value] = data.split(":");
        try {
          const card = this.dashboardCards.get(token);
          if (!card || card.chat !== conv || card.user !== cb.from?.id || card.expires < Date.now()) {
            throw new Error("Thẻ đã hết hạn hoặc không thuộc bạn/nhóm này. Mở lại bằng /sessions.");
          }
          if (action === "detail") {
            const link = this.topics.get(value);
            if (!link || link.chat !== conv) throw new Error("Phiên không còn thuộc nhóm này. Mở lại /sessions.");
            await this.showTopicLink(conv, link);
          } else if (action === "refresh") await this.showSessionDashboard(conv, cb.from!.id, token, card.filter, card.page, true);
          else {
            if (!Object.hasOwn(DASHBOARD_FILTERS, action) || !/^(?:0|[1-9]\d{0,5})$/.test(value ?? "")) throw new Error("Bộ lọc hoặc trang không hợp lệ.");
            await this.showSessionDashboard(conv, cb.from!.id, token, action as DashboardFilter, Number(value));
          }
        } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
        return;
      }
      if (conv === chatOf(conv) && (/^(?:pb:|cont:|fq:|perm:)/.test(data) || data.startsWith(NOTE_CB_PREFIX))) {
        await this.tg.answerCallbackQuery(cb.id, "Work and questions belong in the session topic, not General.");
        return;
      }
      if (data.startsWith("cmd:") && await this.handleTopicCommand(conv, `/${data.slice(4)}`, `button:${conv}:${messageId}:${data}`, cb.from?.id)) {
        await this.tg.answerCallbackQuery(cb.id);
        return;
      }
      if (data.startsWith("st:")) {
        if (conv !== chatOf(conv)) {
          await this.tg.answerCallbackQuery(cb.id, "Manage sessions in General.");
          return;
        }
         const [, action, id, page] = data.split(":");
         try {
          if (action.startsWith("title-")) {
            await this.tg.answerCallbackQuery(cb.id);
            if (action === "title-preview") await this.showTitlePreview(conv, cb.from!.id);
            else if (action === "title-page") {
              if (!/^(?:0|[1-9]\d{0,5})$/.test(page ?? "")) throw new Error("Trang không hợp lệ.");
              await this.showTitlePreview(conv, cb.from!.id, id, Number(page));
            } else if (action === "title-sync") {
              if (this.topics.get(id)?.chat !== conv) throw new Error("Chủ đề không thuộc nhóm này.");
              if (!this.topics.followsOpenCode(conv, id)) await this.showTitleSettings(conv, cb.from!.id, id);
              else {
                const result = await this.topics.syncTitle(conv, id, true);
                await this.tg.sendMessage(conv, result.status === "synced" || result.status === "unchanged" ? "Đã đồng bộ tên chủ đề." : "Tên chưa được đồng bộ; đang chờ mở phiên, kiểm tra hoặc thử lại. Công việc hiện tại không bị dừng.");
                await this.showTopicLink(conv, this.topics.get(id)!);
              }
            } else if (action === "title-enable" || action === "title-cancel") {
              const preview = this.titlePreviews.get(conv);
              if (!preview || preview.token !== id || preview.user !== cb.from!.id || preview.expires < Date.now() || preview.stamp !== this.topics.titleScopeStamp(conv)) {
                throw new Error("Bản xem trước đã hết hạn hoặc không thuộc bạn. Mở lại bằng /sessions.");
              }
              this.titlePreviews.delete(conv);
              if (action === "title-enable") {
                this.topics.enableTitleSync(conv);
                this.topics.requestTitleSync(undefined, true, conv);
                await this.tg.sendMessage(conv, "Đã bật đồng bộ tên theo OpenCode cho nhóm này. Các tên đang được xử lý; chủ đề đã đóng sẽ chờ đến khi mở lại. Không cần mở phiên quản lý.");
              } else await this.tg.sendMessage(conv, "Đã hủy; không thay đổi chính sách đồng bộ tên.");
            }
            return;
          }
          if (action === "list") {
            if (!/^(?:0|[1-9]\d{0,5})$/.test(id ?? "")) throw new Error("Trang không hợp lệ. Dùng /sessions để mở lại danh sách.");
            await this.showSessionTopics(conv, Number(id));
            await this.tg.answerCallbackQuery(cb.id);
            return;
          }
          if (action === "sync") {
            if (this.topics.get(id)?.chat !== conv) throw new Error("This operation belongs to another General.");
            await this.reconcileTopics();
            await this.showTopicLink(conv, this.topics.get(id)!);
            await this.tg.answerCallbackQuery(cb.id);
            return;
          }
          const link = action === "close" ? await this.topics.close(conv, id) :
            action === "restore" ? await this.topics.restore(conv, id) : undefined;
          if (link) await this.showTopicLink(conv, link);
          await this.tg.answerCallbackQuery(cb.id);
         } catch (error) {
           if (action.startsWith("title-")) await this.tg.sendMessage(conv, esc((error as Error).message),
             { reply_markup: { inline_keyboard: [[{ text: "Xem trước đồng bộ tên", callback_data: "st:title-preview:0" }]] } });
           else await this.tg.answerCallbackQuery(cb.id, (error as Error).message.slice(0, 180));
         }
        return;
      }
      if (data.startsWith("use:") && data !== "use:close") {
        await this.handleTopicCommand(conv, data === "use:ls" ? "/sessions" : `/use ${data.slice(4)}`, undefined, cb.from?.id);
        await this.tg.answerCallbackQuery(cb.id);
        return;
      }
      if (conv !== chatOf(conv) && /^(?:bs:|ap:|prune:|kill:|sch:|reboot:|wt:.*:rm$)/.test(data)) {
        await this.tg.answerCallbackQuery(cb.id, "Manage sessions and topics in General.");
        return;
      }
      const link = this.topics.forTopic(conv);
      if (conv !== chatOf(conv) && !this.topics.canPrompt(conv) && !/^(?:cmd:(?:help|status)|mode:(?:close|info))$/.test(data)) {
        await this.tg.answerCallbackQuery(cb.id, "This session is not open. Use General to reconcile or restore it.");
        return;
      }
    }
    if (this.scheduler?.owns(conv) && /^(use:|pb:|cont:|bs:|cmd:(?:new|clear|browse)$)/.test(data)) {
      await this.tg.answerCallbackQuery(cb.id, "Lượt chạy lịch chưa kết thúc; dùng /stop rồi chờ xác nhận.");
      return;
    }
    if (data.startsWith("fq:")) {
      await this.handleFormCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("mode:")) {
      await this.handleModeCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("perm:")) {
      await this.handlePermissionCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("pb:")) {
      await this.handlePlanToBuildCallback(cb, conv);
      return;
    }
    if (data.startsWith("cont:")) {
      await this.handleContinueCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith(NOTE_CB_PREFIX)) {
      await this.handleNoteCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("reboot:")) {
      await this.handleRebootCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("use:")) {
      await this.handleUseCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("agent:")) {
      await this.handleAgentCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("variant:")) {
      await this.handleVariantCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("mdl:")) {
      await this.handleModelCallback(cb, conv, messageId);
      return;
    }
    if (data.startsWith("kill:")) return this.orch.handleKillCallback(cb, conv, messageId);
    if (await this.orch.handleCallback(cb, conv, messageId)) return;
    if (data.startsWith("cmd:")) {
      await this.runCommandButton(cb, conv, data.slice(4));
      return;
    }
    if (data.startsWith("sch:")) {
      await this.handleScheduleCallback(cb, conv, messageId);
      return;
    }
    if (!data.startsWith("bs:")) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    const b = this.browsers.get(conv);
    if (!b) {
      await this.tg.answerCallbackQuery(cb.id, "Phiên duyệt đã đóng — gửi /browse");
      return;
    }

    const [, action, arg] = data.split(":");
    let close = false;
    try {
      switch (action) {
        case "nav": {
          const item = b.items[Number(arg)];
          if (!item) throw new Error("Mục không còn tồn tại — gửi /browse để tải lại.");
          b.path = item.path;
          b.page = 0;
          b.view = "list";
          b.note = undefined;
          await this.reloadBrowse(b);
          break;
        }
        case "up": {
          const parent = parentWithin(b.path, this.cfg.browseRoots);
          if (parent) {
            b.path = parent;
            b.page = 0;
            b.view = "list";
            await this.reloadBrowse(b);
          }
          break;
        }
        case "pg": {
          b.page = Math.max(0, Number(arg) || 0);
          break;
        }
        case "hid": {
          b.showHidden = !b.showHidden;
          b.page = 0;
          await this.reloadBrowse(b);
          break;
        }
        case "open": {
          b.view = "choose";
          break;
        }
        case "list": {
          b.view = "list";
          break;
        }
        case "setdir": {
          this.st.set(conv, { directory: b.path });
          b.view = "done";
          b.opened = false;
          b.result = [
            `✅ Đã đặt thư mục làm việc:\n<code>${esc(b.path)}</code>`,
            "",
            "Session mới sẽ chạy ở đây. Gõ /new hoặc bấm “🚀 Mở session mới tại đây”.",
          ].join("\n");
          break;
        }
        case "setsess": {
          if (this.topics.enabled(conv)) {
            this.st.set(conv, { directory: b.path });
            await this.handleTopicCommand(conv, "/new", `browser:${conv}:${messageId}`);
            b.view = "done";
            b.opened = true;
            b.result = "Session creation is managed in General; use the session card to open its topic.";
            break;
          }
          const state = this.st.get(conv);
          await this.stopCurrent(conv, true);
          const sessionID = await this.oc.createSession(b.path);
          await this.applyModelAndVariant(sessionID, state);
          if (state.agent) {
            await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
          }
          this.st.set(conv, { sessionID, directory: b.path });
          b.view = "done";
          b.opened = true;
          b.result = [
            `🚀 Đã mở session <code>${esc(sessionID)}</code>`,
            `📁 <code>${esc(b.path)}</code>`,
            "",
            "Gửi tin nhắn để bắt đầu làm việc.",
          ].join("\n");
          break;
        }
        case "close": {
          close = true;
          break;
        }
        default:
          break; // "noop" and anything unknown
      }
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
      return;
    }

    await this.tg.answerCallbackQuery(cb.id);
    if (close) {
      this.browsers.delete(conv);
      if (messageId) await this.tg.deleteMessage(conv, messageId);
      return;
    }
    if (!messageId) return;
    const v = this.renderBrowse(b);
    await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
  }

  /** Run a bot command from an inline button (the /help menu). */
  private async runCommandButton(cb: CallbackQuery, conv: ConvKey, name: string): Promise<void> {
    const state = this.st.get(conv);
    try {
      switch (name) {
        case "new":
          await this.cmdNew(conv, state);
          break;
        case "ls":
          await this.cmdList(conv);
          break;
        case "dir":
          await this.cmdDir(conv, "", state);
          break;
        case "browse":
          await this.cmdBrowse(conv, "", state);
          break;
        case "mode":
          await this.cmdMode(conv, "", state);
          break;
        case "models":
          await this.cmdModels(conv);
          break;
        case "variants":
          await this.cmdVariants(conv, "", state);
          break;
        case "agents":
          await this.cmdAgents(conv);
          break;
        case "stop":
          await this.cmdStop(conv, state);
          break;
        case "reboot":
          await this.cmdReboot(conv);
          break;
        case "status":
          await this.cmdStatus(conv, state);
          break;
        case "context":
          await this.cmdContext(conv, state);
          break;
        case "usage":
          await this.cmdUsage(conv);
          break;
        case "history":
          await this.cmdHistory(conv, state);
          break;
        case "clear":
          await this.cmdClear(conv, state);
          break;
        case "schedule":
          await this.cmdSchedule(conv, "", state, cb.from?.id);
          break;
        case "help":
          await this.cmdHelp(conv);
          break;
        default:
          await this.tg.sendMessage(conv, "❓ Lệnh không rõ.");
      }
    } finally {
      // Answer last so the tap spinner shows while the command runs.
      await this.tg.answerCallbackQuery(cb.id).catch(() => {});
    }
  }

  private async cmdModels(conv: ConvKey): Promise<void> {
    const models = await this.oc.listModels();
    const cur = this.st.get(conv).model?.id;
    const max = this.cfg.replyMaxLen;
    const footer = esc("\n\nSet with /model <id>");
    // Show EVERY model, packed into ≤max-char pages on line boundaries so each
    // message is valid HTML with balanced tags (no mid-tag cuts → no 400s).
    const units = [
      `<b>Models (${models.length})</b>`,
      ...models.map((m) => `${cur === m.id ? "▶️ " : ""}<code>${esc(m.id)}</code>${m.name ? ` — ${esc(m.name)}` : ""}`),
    ];
    const pages: string[] = [];
    let page = "";
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const final = i === units.length - 1;
      const budget = max - (final ? footer.length : 0);
      if (page && (page + "\n" + unit).length > budget) {
        pages.push(page);
        page = unit;
      } else {
        page = page ? page + "\n" + unit : unit;
      }
    }
    if (page) pages.push(page + footer);
    for (const p of pages) await this.tg.sendMessage(conv, p);
  }

  /**
   * `/model [id]` — set the model. Without a valid argument the user gets a
   * paged button picker (10 models/page) instead of the text list.
   */
  private async cmdModel(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    void state;
    let models: ModelInfo[];
    try {
      models = await this.oc.listModels();
    } catch (e) {
      return this.tg.sendMessage(conv, `⚠️ Không liệt kê được model: ${(e as Error).message}`);
    }
    if (!arg) return this.showModelPicker(conv, models, 0, undefined);
    const m = models.find((x) => x.id === arg || `${x.providerID}/${x.id}` === arg);
    if (!m) return this.showModelPicker(conv, models, 0, `❌ Unknown model: <code>${esc(arg)}</code>`);
    await this.applyModelPick(conv, m);
    await this.tg.sendMessage(conv, `✅ Model → <code>${esc(m.id)}</code> (${this.st.get(conv).sessionID ? "applied to current session" : "applies on /new"})`);
  }

  /** Apply the model choice (shared by the typed command and the picker buttons). */
  private async applyModelPick(conv: ConvKey, m: ModelInfo): Promise<void> {
    this.st.set(conv, { model: { id: m.id, providerID: m.providerID } });
    const sid = this.settingsSession(conv);
    if (sid) await this.applyModelAndVariant(sid, this.st.get(conv));
  }

  /** The text + keyboard for one page of the /model picker. */
  private renderModelPage(models: ModelInfo[], page: number, errorNote?: string, curId?: string): { text: string; keyboard: Keyboard } {
    const pageCount = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
    const p = Math.max(0, Math.min(page, pageCount - 1));
    const slice = models.slice(p * MODEL_PAGE_SIZE, (p + 1) * MODEL_PAGE_SIZE);
    const rows: Btn[][] = [];
    for (let i = 0; i < slice.length; i += 2) {
      rows.push(
        slice.slice(i, i + 2).map((m, j) => ({
          text: `${curId === m.id ? "▶️ " : ""}${trunc(m.id, 28)}`,
          callback_data: `mdl:sel:${p * MODEL_PAGE_SIZE + i + j}`,
        })),
      );
    }
    if (pageCount > 1) {
      const nav: Btn[] = [];
      if (p > 0) nav.push({ text: "⬅️", callback_data: `mdl:pg:${p - 1}` });
      nav.push({ text: `${p + 1}/${pageCount}`, callback_data: "mdl:noop" });
      if (p < pageCount - 1) nav.push({ text: "➡️", callback_data: `mdl:pg:${p + 1}` });
      rows.push(nav);
    }
    rows.push([{ text: "❌ Đóng", callback_data: "mdl:close" }]);
    return {
      text: [errorNote ?? "❓ <b>/model</b> cần tên model", `<i>trang ${p + 1}/${pageCount} · Hoặc gửi: <code>/model &lt;id&gt;</code></i>`].join("\n"),
      keyboard: { inline_keyboard: rows },
    };
  }

  /** Open the model picker (or re-show it after a bad argument) and remember the model list. */
  private async showModelPicker(conv: ConvKey, models: ModelInfo[], page: number, errorNote?: string): Promise<void> {
    const pageCount = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
    const p = Math.max(0, Math.min(page, pageCount - 1));
    this.modelPickers.set(conv, { models, page: p });
    const v = this.renderModelPage(models, p, errorNote, this.st.get(conv).model?.id);
    await this.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
  }

  /** Handle a tap on the /model picker (data = `mdl:sel:<i>` / `mdl:pg:<n>` / `mdl:close` / `mdl:noop`). */
  private async handleModelCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const [, op, arg] = (cb.data ?? "").split(":");
    if (op === "close") {
      this.modelPickers.delete(conv);
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.deleteMessage(conv, messageId).catch(() => {});
      return;
    }
    const mp = this.modelPickers.get(conv);
    if (!mp) {
      await this.tg.answerCallbackQuery(cb.id, "Danh sách model đã đóng — gửi /model để mở lại.");
      return;
    }
    try {
      if (op === "sel") {
        const m = mp.models[Number(arg)];
        if (!m) throw new Error("Model không còn trong danh sách — gửi /model để mở lại.");
        await this.applyModelPick(conv, m);
        this.modelPickers.delete(conv);
        await this.tg.answerCallbackQuery(cb.id, `Model → ${trunc(m.id, 40)}`);
        if (messageId) await this.tg.editMessageText(conv, messageId, `✅ Model → <code>${esc(m.id)}</code> (${this.st.get(conv).sessionID ? "applied" : "applies on /new"})`).catch(() => {});
        return;
      }
      if (op === "pg") {
        await this.tg.answerCallbackQuery(cb.id);
        if (!messageId) return;
        const v = this.renderModelPage(mp.models, Number(arg) || 0, undefined, this.st.get(conv).model?.id);
        this.modelPickers.set(conv, { ...mp, page: Math.max(0, Math.min(Number(arg) || 0, Math.ceil(mp.models.length / MODEL_PAGE_SIZE) - 1)) });
        await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard }).catch(() => {});
        return;
      }
      // "noop" or unknown
      await this.tg.answerCallbackQuery(cb.id);
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
    }
  }

  private async cmdAgents(conv: ConvKey): Promise<void> {
    const agents = await this.oc.listAgents();
    const cur = this.st.get(conv).agent;
    const lines = agents
      .filter((a) => AGENT_WHITELIST.includes(a.id))
      .map((a) => `${cur === a.id ? "▶️ " : ""}<code>${a.id}</code>${a.description ? ` — ${esc(trunc(a.description, 44))}` : ""}`);
    await this.sendHtml(conv, `<b>Agents</b>\n${lines.join("\n")}\n\nSet with /agent &lt;id&gt;`);
  }

  /**
   * `/agent [id]` — set the agent. Without a valid argument the user gets a
   * button picker of the whitelisted agents instead of the text list.
   */
  private async cmdAgent(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    void state;
    let agents: { id: string }[] | undefined;
    try {
      agents = await this.oc.listAgents();
    } catch (e) {
      warn("listAgents:", (e as Error).message);
    }
    if (!arg) return this.sendAgentPicker(conv, undefined);
    // Unknown id (and the listing succeeded) → show the picker too; a failed
    // listing keeps the old behaviour of trusting the typed id.
    if (agents && !agents.some((a) => a.id === arg)) return this.sendAgentPicker(conv, `❌ Unknown agent: <code>${esc(arg)}</code>`);
    const how = await this.applyAgent(conv, arg);
    await this.tg.sendMessage(conv, `✅ Agent → <code>${esc(arg)}</code> (${how === "applied" ? "applied to current session" : "applies on /new"})`);
  }

  /** Apply the agent switch (shared by the typed command and the picker buttons). */
  private async applyAgent(conv: ConvKey, agent: string): Promise<"applied" | "applies on /new"> {
    this.st.set(conv, { agent });
    const sid = this.settingsSession(conv);
    if (sid) {
      await this.oc.setAgent(sid, agent).catch((e) => error("setAgent:", e?.message));
      return "applied";
    }
    return "applies on /new";
  }

  /** The /agent picker card: one button per whitelisted agent + a hint line. */
  private sendAgentPicker(conv: ConvKey, errorNote?: string): Promise<void> {
    const cur = this.st.get(conv).agent;
    const rows: Btn[][] = [];
    for (let i = 0; i < AGENT_WHITELIST.length; i += 2) {
      rows.push(
        AGENT_WHITELIST.slice(i, i + 2).map((id) => ({ text: `${cur === id ? "▶️ " : ""}${id}`, callback_data: `agent:${id}` })),
      );
    }
    rows.push([{ text: "❌ Đóng", callback_data: "agent:close" }]);
    return this.tg.sendMessage(
      conv,
      [errorNote ?? "❓ <b>/agent</b> cần tên agent", "Hoặc gửi: <code>/agent &lt;id&gt;</code>"].join("\n"),
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  /** Handle a tap on the /agent picker (data = `agent:<id|close>`). */
  private async handleAgentCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const id = (cb.data ?? "").slice("agent:".length);
    if (id === "close") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.deleteMessage(conv, messageId).catch(() => {});
      return;
    }
    try {
      const how = await this.applyAgent(conv, id);
      await this.tg.answerCallbackQuery(cb.id, `Agent → ${id}`);
      if (messageId) await this.tg.editMessageText(conv, messageId, `✅ Agent → <code>${esc(id)}</code> (${how})`).catch(() => {});
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
    }
  }

  /** The current mode, derived from the session's agent (a curated label). */
  private currentMode(state: ChatState): string | undefined {
    return Object.entries(MODES).find(([, m]) => m.agent === state.agent)?.[0];
  }

  /** Switch the chat's mode (agent): persist it and apply to the open session. */
  private async applyMode(conv: ConvKey, state: ChatState, agent: string): Promise<void> {
    this.st.set(conv, { agent });
    const sid = this.settingsSession(conv);
    if (sid) {
      await this.oc.setAgent(sid, agent).catch((e) => error("setAgent:", e?.message));
    }
  }

  /** Build the inline "pick a mode" message: a short header + one button per mode. */
  private renderModePicker(state: ChatState): { text: string; keyboard: Keyboard } {
    const cur = this.currentMode(state);
    const entries = Object.entries(MODES);
    const rows: Btn[][] = [];
    for (let i = 0; i < entries.length; i += 2) {
      const row: Btn[] = [];
      for (let j = i; j < Math.min(i + 2, entries.length); j++) {
        const [id] = entries[j];
        row.push({ text: `${cur === id ? "▶️ " : ""}${id}`, callback_data: `mode:${id}` });
      }
      rows.push(row);
    }
    rows.push([
      { text: "❓ Vai trò", callback_data: "mode:info" },
      { text: "❌ Đóng", callback_data: "mode:close" },
    ]);
    const curLabel = cur ? `<b>${esc(cur)}</b>` : "<i>chưa chọn</i>";
    return {
      text: `<b>Chọn mode</b> — ${curLabel}\n<i>bấm để đổi · mode hiện tại đánh dấu ▶️</i>\nHoặc gửi: <code>/mode &lt;id&gt;</code>`,
      keyboard: { inline_keyboard: rows },
    };
  }

  /**
   * Show the mode picker (inline buttons), or switch straight to `/mode <name>`.
   * A mode is a friendly front-end over the agent; the current mode is derived
   * from the session's agent, so /agent and /mode can never disagree.
   */
  private async cmdMode(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    const want = arg.trim().toLowerCase();
    if (!want) {
      const v = this.renderModePicker(state);
      await this.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
      return;
    }
    const m = MODES[want];
    if (!m) {
      const v = this.renderModePicker(state);
      await this.tg.sendMessage(conv, `❌ Unknown mode: <code>${esc(want)}</code>`, { reply_markup: v.keyboard });
      return;
    }
    await this.applyMode(conv, state, m.agent);
    const applied = this.settingsSession(conv) ? "applied" : "applies on /new";
    const v = this.renderModePicker(state);
    await this.tg.sendMessage(conv, `✅ Mode → <b>${esc(want)}</b> (${applied})`, { reply_markup: v.keyboard });
  }

  /** Handle a tap on the mode picker (switch in place, or close the picker). */
  private async handleModeCallback(cb: CallbackQuery, conv: ConvKey, messageId: number | undefined): Promise<void> {
    const id = (cb.data ?? "").split(":")[1];
    if (id === "close") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.deleteMessage(conv, messageId);
      return;
    }
    if (id === "info") {
      await this.tg.answerCallbackQuery(cb.id);
      const lines = Object.entries(MODES).map(([mid, m]) => `• <code>${esc(mid)}</code> — ${esc(m.hint)}`);
      await this.tg.sendMessage(conv, `📖 <b>Vai trò các mode</b>\n${lines.join("\n")}`);
      return;
    }
    const m = MODES[id];
    if (!m) {
      await this.tg.answerCallbackQuery(cb.id, `❌ Unknown mode: ${esc(id)}`);
      return;
    }
    const state = this.st.get(conv);
    const wasCurrent = this.currentMode(state) === id;
    try {
      await this.applyMode(conv, state, m.agent);
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
      return;
    }
    await this.tg.answerCallbackQuery(cb.id, `Mode → ${id}`);
    if (messageId && !wasCurrent) {
      const v = this.renderModePicker(state);
      await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
    }
  }

  /** Handle a tap on the plan-to-build button (data = `pb:go`). */
  private async handlePlanToBuildCallback(cb: CallbackQuery, conv: ConvKey): Promise<void> {
    const state = this.st.get(conv);
    if (this.inflight.has(conv)) {
      await this.tg.answerCallbackQuery(cb.id, "Đang chạy task — hẵng thử lại sau.");
      return;
    }
    if (!state.sessionID) {
      await this.tg.answerCallbackQuery(cb.id, "Chưa có session — hãy gửi một tin nhắn trước.");
      return;
    }
    await this.applyMode(conv, state, "build");
    await this.tg.answerCallbackQuery(cb.id, "Mode → build");
    await this.tg.sendMessage(conv, "Đã chuyển sang <b>build</b> — bắt đầu thực thi kế hoạch.").catch(() => {});
    const prompt =
      "Đã chuyển sang chế độ build. Hãy thực thi kế hoạch vừa được lập trong cuộc hội thoại này: bắt đầu từ bước 1, làm tuần tự, và dừng lại để hỏi nếu thiếu thông tin quan trọng. Nếu không có kế hoạch nào chưa thực thi, chỉ cần xác nhận đã sẵn sàng.";
    if (this.topics.enabled(conv)) { await this.runPrompt(conv, prompt, state); return; }
    const ac = new AbortController();
    this.inflight.set(conv, ac);
    void this.runPromptTask(conv, state.sessionID, prompt, ac).catch((e) => error("prompt task:", e?.message));
  }

  /** Handle a tap on the "⏯ Chạy tiếp" button (data = `cont:<sessionID>`). */
  private async handleContinueCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const target = parseContinueData(cb.data);
    // The button is one-shot: drop it immediately so a re-tap (or a stale button
    // left over after a /new) can never fire a second continue.
    if (messageId) {
      await this.tg
        .editMessageReplyMarkup(conv, messageId, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
    const state = this.st.peek(conv);
    // Reject malformed data, or a conv whose session is no longer the one that
    // failed (a /new or /use replaced it) — continuing would hit the wrong session.
    if (!target || !state?.sessionID || state.sessionID !== target) {
      await this.tg.answerCallbackQuery(cb.id, "Nút này không còn áp dụng cho phiên hiện tại.");
      return;
    }
    if (this.inflight.has(conv)) {
      await this.tg.answerCallbackQuery(cb.id, "Đang chạy task — hẵng thử lại sau.");
      return;
    }
    if (this.topics.enabled(conv)) {
      await this.tg.answerCallbackQuery(cb.id, "Đang kiểm tra điều kiện chạy tiếp…");
      try {
        const link = this.topics.forTopic(conv);
        if (!link || !cb.from) throw new Error("Không xác định được liên kết/người xác nhận.");
        const ready = await this.readyForResume(chatOf(conv), link.id);
        const turn = this.st.peek(conv)?.continueOfferedTurn;
        if (!turn || ready.row.activity?.input.id !== turn || ready.row.work !== "failed") throw new Error("Nút lỗi cũ không còn áp dụng cho mốc hiện tại; xem tóm tắt để chuẩn bị yêu cầu mới.");
        const payload = !state.manager && this.cfg.guideQuestions && !state.guided ? QUESTIONS_PREAMBLE + "\n\n" + CONTINUE_PROMPT : CONTINUE_PROMPT;
        const item = this.resumeConfirmations.prepare({ actor: cb.from.id, chat: chatOf(conv), conv, sessionID: target, directory: link.directory,
          binding: ready.binding, marker: ready.marker, goal: CONTINUE_PROMPT, payload, inputID: newMessageID(), failureTurn: turn });
        await this.dispatchResumeConfirmation(chatOf(conv), cb.from.id, link.id, item, conv);
      } catch (error) { await this.tg.sendMessage(conv, esc((error as Error).message)); }
      return;
    }
    await this.tg.answerCallbackQuery(cb.id, "⏯ Đang chạy tiếp…");
    this.startTyping(conv);
    const ac = new AbortController();
    this.inflight.set(conv, ac);
    void this.runPromptTask(conv, target, CONTINUE_PROMPT, ac).catch((e) => error("prompt task:", e?.message));
  }

  /**
   * `/variants [id]` — list (no arg) or set the reasoning "variant" as a plain
   * text message. The button-pick version lives in cmdVariantSet (/variant).
   */
  private async cmdVariants(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    const want = arg.trim().toLowerCase();
    const model = await this.resolveModel(state, state.sessionID);
    const variants = model ? await this.oc.getVariants(model) : [];
    const cur = state.variant ?? this.cfg.defaultVariant;

    if (!want) {
      const lines = variants.length
        ? variants.map((v) => `${v === cur ? "▶️ " : ""}<code>${esc(v)}</code>`).join("\n")
        : "<i>(no variants reported for this model)</i>";
      const modelLabel = model ? ` — <code>${esc(model.id)}</code>` : " — <i>no model set</i>";
      await this.sendHtml(
        conv,
        `<b>Variants</b>${modelLabel}\n${lines}\n\n<i>current: ${esc(cur)}</i>\nSet with /variants &lt;id&gt;`,
      );
      return;
    }
    if (!model) {
      return this.tg.sendMessage(conv, "❌ No model set. Use /model first, then set a variant.");
    }
    if (variants.length && !variants.includes(want)) {
      return this.tg.sendMessage(
        conv,
        `❌ Unknown variant <code>${esc(want)}</code>. Available: ${esc(variants.join(", "))}`,
      );
    }
    const how = await this.applyVariant(conv, want);
    await this.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (${how})`);
  }

  /**
   * `/variant [id]` — set the reasoning variant, with a button picker when the
   * argument is missing (or unknown). Models without variants keep the plain
   * text answer (delegated to cmdVariants).
   */
  private async cmdVariantSet(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    const want = arg.trim().toLowerCase();
    let model: { id: string; providerID: string } | null = null;
    let variants: string[] = [];
    try {
      model = await this.resolveModel(state, state.sessionID);
      if (model) variants = await this.oc.getVariants(model);
    } catch (e) {
      warn("variant lookup:", (e as Error).message);
    }
    // No model, or the model reports no variants: keep the existing text output.
    if (!model || !variants.length) return this.cmdVariants(conv, arg, state);
    const cur = state.variant ?? this.cfg.defaultVariant;
    if (!want) return this.sendVariantPicker(conv, variants, cur, undefined);
    if (!variants.includes(want)) return this.sendVariantPicker(conv, variants, cur, `❌ Unknown variant <code>${esc(want)}</code>`);
    const how = await this.applyVariant(conv, want);
    await this.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (${how})`);
  }

  /** Apply the variant choice (shared by /variants, /variant and the picker buttons). */
  private async applyVariant(conv: ConvKey, want: string): Promise<"applied to current session" | "applies on /new"> {
    this.st.set(conv, { variant: want });
    const sid = this.settingsSession(conv);
    if (sid) {
      await this.applyModelAndVariant(sid, this.st.get(conv));
      return "applied to current session";
    }
    return "applies on /new";
  }

  /** The /variant picker card: one button per variant + a hint line. */
  private sendVariantPicker(conv: ConvKey, variants: string[], cur: string, errorNote?: string): Promise<void> {
    const rows: Btn[][] = [];
    for (let i = 0; i < variants.length; i += 2) {
      rows.push(
        variants.slice(i, i + 2).map((v) => ({ text: `${v === cur ? "▶️ " : ""}${v}`, callback_data: `variant:${v}` })),
      );
    }
    rows.push([{ text: "❌ Đóng", callback_data: "variant:close" }]);
    return this.tg.sendMessage(
      conv,
      [errorNote ?? "❓ <b>/variant</b> cần tên variant", "Hoặc gửi: <code>/variant &lt;id&gt;</code>"].join("\n"),
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  /** Handle a tap on the /variant picker (data = `variant:<id|close>`). */
  private async handleVariantCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const id = (cb.data ?? "").slice("variant:".length);
    if (id === "close") {
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.deleteMessage(conv, messageId).catch(() => {});
      return;
    }
    try {
      const how = await this.applyVariant(conv, id);
      await this.tg.answerCallbackQuery(cb.id, `Variant → ${id}`);
      if (messageId) await this.tg.editMessageText(conv, messageId, `✅ Variant → <code>${esc(id)}</code> (${how})`).catch(() => {});
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
    }
  }

  private async cmdStop(conv: ConvKey, state: ChatState): Promise<void> {
    if (this.topics.forTopic(conv)) {
      await this.tg.sendMessage(conv, await this.stopManagedTopic(conv) ?
        "Work stopped. The session and topic remain open." : "Stop is not confirmed; waiting for evidence, capacity remains reserved.");
      return;
    }
    if (await this.scheduler?.requestStop(conv)) return;
    await this.stopCurrent(conv);
    this.cancelAllReminders(conv);
    if (state.sessionID) await this.oc.interrupt(state.sessionID).catch(() => {});
    await this.tg.sendMessage(conv, "⏹️ Interrupted.");
  }

  private async cmdStatus(conv: ConvKey, state: ChatState): Promise<void> {
    const info = await this.oc.serverInfo().catch(() => null);
    const busy = this.inflight.has(conv);
    const mode = this.currentMode(state);
    // Explicitly set model wins; otherwise observe what the session actually
    // runs on (server-resolved default) from the newest assistant message.
    const live = state.sessionID ? await this.oc.getSessionModel(state.sessionID).catch(() => undefined) : undefined;
    const model = state.model ?? live;
    const modelLabel = model ? (model.providerID && model.providerID !== "?" ? `${model.providerID}/${model.id}` : model.id) : null;
    const lines = [
      `<b>OpenCode</b>${info?.version ? " v" + info.version : ""}`,
      `url: <code>${esc((info?.urls ?? [info?.url]).filter(Boolean).join(", ") || "?")}</code>`,
      `dir: <code>${esc(state.directory || this.cfg.opencodeDirectory)}</code>`,
      `session: ${state.sessionID ? `<code>${state.sessionID}</code>` : "none"}`,
      `model: ${modelLabel ? `<code>${esc(modelLabel)}</code>` : "default"}`,
      `variant: <code>${esc(state.variant ?? this.cfg.defaultVariant)}</code>`,
      `mode: ${mode ? `<code>${esc(mode)}</code>` : "—"}`,
      `agent: ${state.agent ? `<code>${state.agent}</code>` : "default"}`,
      `state: ${busy ? "⏳ busy" : "🟢 idle"}`,
    ];
    await this.sendHtml(conv, lines.join("\n"));
  }

  /**
   * `/context` — a photo of the current session: what it is, how much it has
   * used, and what it most recently touched. Distinct from /status (connection
   * + settings) and /history (recent message text).
   */
  private async cmdContext(conv: ConvKey, state: ChatState): Promise<void> {
    if (!state.sessionID) return this.tg.sendMessage(conv, "No current session. Send /new.");
    let r;
    try {
      r = await this.oc.getSessionReport(state.sessionID);
    } catch (e) {
      return this.tg.sendMessage(conv, `⚠️ Could not read the session: ${(e as Error).message}`);
    }
    const base = r.directory || state.directory || this.cfg.opencodeDirectory;
    const rel = (p: string) => (base && p.startsWith(base) ? p.slice(base.length).replace(/^\//, "") : p);

    const lines: string[] = [];
    lines.push(`📋 <b>Session</b> — ${esc(trunc(r.title || "(no title)", 60))}`);
    lines.push(`id: <code>${esc(r.id)}</code>`);
    if (r.directory) lines.push(`📁 <code>${esc(r.directory)}</code>`);

    const live = await this.oc.getSessionModel(state.sessionID).catch(() => undefined);
    const model = state.model ?? live;
    const modelLabel = model ? (model.providerID && model.providerID !== "?" ? `${model.providerID}/${model.id}` : model.id) : null;
    lines.push(
      `🤖 model: ${modelLabel ? `<code>${esc(modelLabel)}</code>` : "default"} · agent: ${r.agent ? `<code>${esc(r.agent)}</code>` : "default"}`,
    );

    const t = r.tokens;
    if (t) lines.push(`📦 tokens: in ${fmtNum(t.input)} / out ${fmtNum(t.output)} / reasoning ${fmtNum(t.reasoning)} · cache ${fmtNum(t.cache)}`);
    if (typeof r.cost === "number" && r.cost > 0) lines.push(`💰 cost: $${r.cost.toFixed(4)}`);
    lines.push(`💬 ${r.messageCount} messages`);
    if (r.created) lines.push(`🕐 started ${timeAgo(r.created)}`);

    if (r.modifiedFiles.length) {
      const files = r.modifiedFiles.map((f) => `<code>${esc(rel(f))}</code>`).join(", ");
      lines.push(`📝 files: ${files}`);
    }
    if (r.lastUserPrompt) {
      // The first prompt is sent with the headless preamble prepended; strip it
      // so the "last" line shows what the user actually typed.
      const last = r.lastUserPrompt.startsWith(QUESTIONS_PREAMBLE)
        ? r.lastUserPrompt.slice(QUESTIONS_PREAMBLE.length).replace(/^\s+\n+/, "").replace(/\n+$/, "")
        : r.lastUserPrompt;
      if (last.trim()) lines.push(`👤 last: “${esc(trunc(stripTags(last), 120))}”`);
    }
    await this.sendHtml(conv, lines.join("\n"));
  }

  /**
   * /usage — context pressure across every session this bot tracks (manager,
   * workers, regular chats): current context vs the model's window, plus the
   * cumulative totals. The answer to "which session is about to overflow?"
   *
   * REST budget: exactly 2 calls per UNIQUE session — session.get (cumulative
   * tokens) and one message.list (model + current context). Convs that share a
   * session (reattach) are deduped by session id BEFORE any call is made, and
   * the calls run through a small worker pool so many tracked sessions can't
   * fan out into an unbounded burst. (maxRows can't be applied before the
   * fetch: the rows are sorted BY context pressure, which only exists after
   * the calls — so the cap still applies post-fetch, but the fetch itself is
   * already bounded by dedup + pool + the small number of tracked sessions.)
   */
  private async cmdUsage(conv: ConvKey, arg = ""): Promise<void> {
    const all = /\s--all\b/.test(arg);
    const models = await this.oc.listModels().catch(() => [] as ModelInfo[]);
    const entries = Object.entries(this.st.all()).filter(
      ([k, s]) => typeof s.sessionID === "string" && k !== MACHINE_STATE_KEY,
    );
    // Several convs can point at one session (reattach): dedup BEFORE calling
    // the API so a shared session costs one fetch, not one per conv.
    const bySid = new Map<string, string>();
    for (const [key, s] of entries) {
      const sid = s.sessionID as string;
      if (bySid.has(sid)) continue;
      const [chatId, topicId] = key.split(":");
      const label = s.worker?.name ?? (s.manager ? "manager" : topicId ? `#topic ${topicId}` : chatId);
      bySid.set(sid, label);
    }
    const sids = [...bySid.keys()];
    const rows: UsageRow[] = new Array(sids.length);
    let next = 0;
    const fetchRow = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= sids.length) return;
        const sid = sids[i];
        const [sess, info] = await Promise.all([
          this.oc.getSession(sid).catch(() => null),
          this.oc.latestAssistantInfo(sid).catch(() => undefined),
        ]);
        const model = info?.model;
        rows[i] = {
          label: bySid.get(sid)!,
          id: sid,
          current: info?.context,
          limit: model
            ? (models.find((m) => m.id === model.id && m.providerID === model.providerID) ??
               models.find((m) => m.id === model.id))?.contextLimit
            : undefined,
           cumInput: (sess as any)?.tokens?.input ?? 0,
           cumOutput: (sess as any)?.tokens?.output ?? 0,
           // Liveness signal (session.time.updated) — already fetched above, zero extra calls.
           updated: typeof (sess as any)?.time?.updated === "number" ? (sess as any).time.updated : undefined,
         };
      }
    };
    // At most 4 sessions in flight, regardless of how many are tracked.
    await Promise.all(Array.from({ length: Math.min(4, sids.length) }, () => fetchRow()));
    await this.sendHtml(conv, formatUsageReport(rows, esc, { warnPct: this.cfg.usageWarnPct, maxRows: this.cfg.usageMaxRows, activeHours: this.cfg.usageActiveHours, all }).join("\n"));
  }

  private async cmdHistory(conv: ConvKey, state: ChatState): Promise<void> {
    if (!state.sessionID) return this.tg.sendMessage(conv, "No current session. Send /new.");
    const msgs = await this.oc.listMessages(state.sessionID).catch(() => [] as any[]);
    const sorted = [...msgs].sort((a: any, b: any) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    const recent = sorted.slice(-6);
    const lines = recent.map((m) => {
      if (m.type === "user") return "👤 " + esc(trunc(stripTags(m.text ?? ""), 300));
      if (m.type === "assistant") {
        const t = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
        return "🤖 " + esc(trunc(stripTags(t), 400));
      }
      return "· " + m.type;
    });
    await this.sendHtml(conv, `<b>Recent messages</b>\n${lines.join("\n")}`);
  }

  // ── /schedule ────────────────────────────────────────────────────────────
  // Schedules live in a SEPARATE file (data/schedules.json), never in
  // state.json: /clear and the per-chat sweeps must not touch them. The
  // Scheduler (src/scheduler.ts) ticks that file; this is only the command
  // surface. v1 scope: scheduled runs do read/analyze + report only — the
  // worker's permission cards still go to the user, nothing is auto-approved.

  /** A fresh 4-char base36 id (fits callback_data) that doesn't collide yet. */
  private newScheduleId(): string {
    const existing = new Set(this.scheduleStore.load().map((s) => s.id));
    for (let i = 0; i < 16; i++) {
      const id = randomInt(36 ** 4).toString(36).padStart(4, "0");
      if (!existing.has(id)) return id;
    }
    return Date.now().toString(36).slice(-4).padStart(4, "0");
  }

  /** Re-check a schedule's creator against the allowlist (it can change after creation). */
  private creatorAllowed(sch: Schedule): boolean {
    if (this.cfg.allowAny) return true;
    return this.cfg.allowedUserIds.includes(sch.createdBy);
  }

  /** The list view: one line + one button row per schedule (⏸/▶ · ▶▶ · 🗑). */
  private scheduleListMarkup(mine: Schedule[]): { html: string; kb: Keyboard } {
    const fmtNext = (ms: number) =>
      new Date(ms).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
    const lines = mine.map((s) => {
      const paused = s.enabled ? "" : "⏸ ";
      const status = s.lastStatus ? ` · ${s.lastStatus}` : "";
      const next = s.enabled ? ` · lần tới: ${fmtNext(s.nextRunAt)}` : "";
      return `${paused}${formatSchedule(s)}${status}${next}`;
    });
    const rows = mine.map((s) => [
      { text: s.enabled ? "⏸" : "▶", callback_data: `sch:${s.enabled ? "p" : "r"}:${s.id}` },
      { text: "▶▶", callback_data: `sch:run:${s.id}` },
      { text: "🗑", callback_data: `sch:d:${s.id}` },
    ]);
    return { html: `<b>⏰ Lịch (${mine.length})</b>\n${lines.join("\n")}`, kb: { inline_keyboard: rows } };
  }

  /** The /schedule usage card, HTML-escaped (sendMessage is parse_mode HTML). */
  private scheduleUsageText(): string {
    const usage =
      "Đặt lịch: /schedule <spec> <prompt> [dir=<đường dẫn> agent=<tên>]\n" +
      "spec: daily|weekdays HH:MM · weekly mon..sun HH:MM · every <N>h · once YYYY-MM-DD HH:MM\n" +
      `vd: /schedule daily 08:00 Review commit 24h qua dir=${this.cfg.opencodeDirectory}\n\n` +
      "Quản lý: /schedule help · pause|resume|run|rm <id>\n" +
      "Lưu ý: phải có dir= (thư mục ngoài data/manager) — lịch không chạy trong thư mục Manager. Agent mặc định: build.";
    return esc(usage);
  }

  private async cmdSchedule(conv: ConvKey, arg: string, state: ChatState, uid?: number): Promise<void> {
    // Top-level safety net: no /schedule input may drop without a reply — an
    // unexpected throw (e.g. statSync on a vanishing dir) must never be silent.
    try {
      await this.cmdScheduleInner(conv, arg, state, uid);
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      try {
        await this.tg.sendMessage(conv, `❌ Lỗi: ${m}`);
      } catch {
        /* swallow — last resort */
      }
    }
  }

  private async cmdScheduleInner(conv: ConvKey, arg: string, state: ChatState, uid?: number): Promise<void> {
    // No arg → list this conv's schedules with control buttons.
    if (!arg) {
      const mine = this.scheduleStore.load().filter((s) => s.conv === conv);
      if (!mine.length) {
        await this.tg.sendMessage(conv, "⏰ Chưa có lịch nào cho chat này.\n\n" + this.scheduleUsageText());
        return;
      }
      const v = this.scheduleListMarkup(mine);
      await this.sendHtml(conv, v.html, { reply_markup: v.kb });
      return;
    }

    // Subcommands: pause|resume|run|rm <id>
    const [sub, ...rest] = arg.split(/\s+/);
    const subLc = sub.toLowerCase();
    if (subLc === "help" || subLc === "--help" || subLc === "-h") {
      await this.tg.sendMessage(conv, "⏰ Cách dùng /schedule\n\n" + this.scheduleUsageText());
      return;
    }
    if (["pause", "resume", "run", "rm", "del", "delete"].includes(subLc)) {
      const id = (rest.join(" ").trim().split(/\s+/)[0] ?? "").replace(/^#/, "").toLowerCase();
      if (!/^[a-z0-9]{4}$/.test(id)) {
        await this.tg.sendMessage(conv, "⏰ Id không hợp lệ — 4 ký tự a-z/0-9. Danh sách: /schedule");
        return;
      }
      if (subLc === "run") return this.scheduleRun(conv, id);
      const op: "pause" | "resume" | "rm" = subLc === "pause" ? "pause" : subLc === "resume" ? "resume" : "rm";
      return this.scheduleMutate(conv, id, op);
    }

    // Add: /schedule <spec> <prompt> [dir=<path> agent=<name>]
    if (uid === undefined) {
      await this.tg.sendMessage(conv, "⛔ Không xác định được người dùng.");
      return;
    }
    let spec: SchedSpec;
    let prompt: string;
    try {
      ({ spec, prompt } = parseScheduleSpec(arg, Date.now()));
    } catch (e) {
      await this.tg.sendMessage(conv, `❌ ${(e as Error).message.replace(/^schedule:\s*/, "")}`);
      return;
    }
    if (!prompt) {
      await this.tg.sendMessage(conv, "❌ Thiếu prompt — ví dụ: /schedule daily 08:00 Review commit 24h qua");
      return;
    }
    // Option tokens — parseScheduleSpec strips them from the prompt itself.
    let dir = state.directory || this.cfg.opencodeDirectory;
    let agent = "build";
    for (const t of arg.trim().split(/\s+/)) {
      if (/^dir=/i.test(t)) dir = t.slice(4);
      else if (/^agent=/i.test(t)) agent = t.slice(6).toLowerCase();
    }
    if (!AGENT_WHITELIST.includes(agent)) {
      await this.tg.sendMessage(conv, `❌ Agent không hợp lệ — chọn: ${AGENT_WHITELIST.join(", ")}`);
      return;
    }
    if (!isAbsolute(dir)) dir = resolve(this.cfg.opencodeDirectory, dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      await this.tg.sendMessage(conv, `❌ Không tìm thấy thư mục: <code>${esc(dir)}</code>`);
      return;
    }
    if (this.cfg.browseRoots.length && !isUnderRoot(dir, this.cfg.browseRoots)) {
      await this.tg.sendMessage(conv, `❌ Thư mục ngoài vùng cho phép (OPENCODE_TG_BROWSE_ROOTS): <code>${esc(dir)}</code>`);
      return;
    }
    if (this.scheduleStore.load().length >= this.cfg.maxSchedules) {
      await this.tg.sendMessage(conv, `❌ Đã đủ ${this.cfg.maxSchedules} lịch (giới hạn). Xoá bớt trước khi thêm.`);
      return;
    }
    const now = Date.now();
    const sch: Schedule = {
      id: this.newScheduleId(),
      conv,
      prompt,
      spec,
      tz: this.cfg.scheduleTz,
      dir,
      agent,
      nextRunAt: nextRunAfter(spec, now, this.cfg.scheduleTz),
      createdBy: uid,
      enabled: true,
      createdAt: now,
    };
    // Spawn the (idle) worker topic FIRST: if the chat can't host a topic the
    // schedule would be useless, so on failure nothing is kept. The error
    // message already carries the topic guidance (orchestrator.spawn).
    try {
      await this.orch.spawn(conv, { name: "sch-" + sch.id, directory: dir, agent, spawnedBy: "schedule" });
    } catch (e) {
      const m = (e as Error).message;
      const hint = m.includes("thư mục của Manager")
        ? `\n→ Thêm dir= (thư mục ngoài data/manager). VD: dir=${this.cfg.opencodeDirectory}`
        : "";
      await this.tg.sendMessage(conv, `❌ ${m}${hint}`);
      return;
    }
    try {
      this.scheduleStore.add(sch);
    } catch (e) {
      await this.tg.sendMessage(conv, `❌ ${(e as Error).message}`);
      return;
    }
    await this.tg.sendMessage(
      conv,
      `⏰ Đã tạo lịch <b>#${sch.id}</b> — ${formatSchedule(sch)}\nlần tới: ${new Date(sch.nextRunAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}\n📁 <code>${esc(dir)}</code> · agent: ${agent}`,
    );
  }

  /** pause/resume/rm — the creator must still be on the allowlist. */
  private async scheduleMutate(conv: ConvKey, id: string, op: "pause" | "resume" | "rm"): Promise<void> {
    const sch = this.scheduleStore.get(id);
    if (!sch || sch.conv !== conv) {
      await this.tg.sendMessage(conv, `⏰ Không tìm thấy lịch #${id} của chat này.`);
      return;
    }
    if (!this.creatorAllowed(sch)) {
      await this.tg.sendMessage(conv, `⛔ Người tạo lịch #${id} không còn trong allowlist — không thể thao tác.`);
      return;
    }
    if (op === "rm") {
      this.scheduleStore.remove(id);
      await this.tg.sendMessage(conv, `🗑 Đã xoá lịch #${id}. Topic + lịch sử vẫn giữ — /prune để dọn topic.`);
      return;
    }
    const updated = this.scheduleStore.set(id, { enabled: op === "resume" });
    if (!updated) {
      await this.tg.sendMessage(conv, `⏰ Không tìm thấy lịch #${id}.`);
      return;
    }
    await this.tg.sendMessage(conv, op === "resume" ? `▶ Đã bật lại lịch #${id}.` : `⏸ Đã tạm dừng lịch #${id}.`);
  }

  /** Run a schedule now (manual trigger). */
  private async scheduleRun(conv: ConvKey, id: string): Promise<void> {
    const sch = this.scheduleStore.get(id);
    if (!sch || sch.conv !== conv) {
      await this.tg.sendMessage(conv, `⏰ Không tìm thấy lịch #${id} của chat này.`);
      return;
    }
    if (!this.creatorAllowed(sch)) {
      await this.tg.sendMessage(conv, `⛔ Người tạo lịch #${id} không còn trong allowlist — không thể chạy.`);
      return;
    }
    try {
      const result = await this.scheduler?.run(id, "manual", conv);
      await this.tg.sendMessage(conv, result?.accepted
        ? `▶▶ ${esc(result.reason ?? `Đã nhận chạy lịch #${id}; kết quả sẽ hiện trong topic sch-${id}.`)}`
        : `⛔ ${esc(result?.reason ?? "Chạy lịch đang bị chặn vì dữ liệu lượt chạy chưa đọc được.")}`);
    } catch (e) {
      await this.tg.sendMessage(conv, `❌ Lịch #${id} không chạy được: ${(e as Error).message}`);
    }
  }

  /** Schedule button taps: sch:p/sch:r (pause/resume) · sch:run · sch:d/sch:dy (rm, 2-step) · sch:ls (re-list). */
  private async handleScheduleCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const [, op, id] = (cb.data ?? "").split(":");
    // Re-list after a confirm/cancel — no schedule id involved.
    if (op === "ls") {
      await this.tg.answerCallbackQuery(cb.id);
      if (!messageId) return;
      const mine = this.scheduleStore.load().filter((s) => s.conv === conv);
      const v = mine.length
        ? this.scheduleListMarkup(mine)
        : { html: "⏰ Không còn lịch nào.", kb: { inline_keyboard: [] } };
      await this.tg.editMessageText(conv, messageId, v.html, { reply_markup: v.kb }).catch(() => {});
      return;
    }
    if (!/^[a-z0-9]{4}$/.test(id ?? "")) {
      await this.tg.answerCallbackQuery(cb.id, "⏰ Id không hợp lệ");
      return;
    }
    const sch = this.scheduleStore.get(id);
    if (!sch || sch.conv !== conv) {
      await this.tg.answerCallbackQuery(cb.id, "⏰ Không tìm thấy lịch này của chat");
      return;
    }
    if (!this.creatorAllowed(sch)) {
      await this.tg.answerCallbackQuery(cb.id, "⛔ Người tạo không còn trong allowlist");
      return;
    }
    switch (op) {
      case "p":
      case "r": {
        const enable = op === "r";
        this.scheduleStore.set(id, { enabled: enable });
        await this.tg.answerCallbackQuery(cb.id, enable ? `▶ Đã bật lại #${id}` : `⏸ Đã dừng #${id}`);
        if (messageId) {
          const mine = this.scheduleStore.load().filter((s) => s.conv === conv);
          const v = mine.length
            ? this.scheduleListMarkup(mine)
            : { html: "⏰ Không còn lịch nào.", kb: { inline_keyboard: [] } };
          await this.tg.editMessageText(conv, messageId, v.html, { reply_markup: v.kb }).catch(() => {});
        }
        return;
      }
      case "run": {
        await this.tg.answerCallbackQuery(cb.id, `▶▶ Đang chạy #${id}…`);
        await this.scheduleRun(conv, id);
        return;
      }
      case "d": {
        // Destructive — two-step confirm (like /reboot).
        await this.tg.answerCallbackQuery(cb.id);
        if (!messageId) return;
        const kb: Keyboard = {
          inline_keyboard: [
            [
              { text: `🗑 Xoá #${id}`, callback_data: `sch:dy:${id}` },
              { text: "↩️ Quay lại", callback_data: "sch:ls" },
            ],
          ],
        };
        await this.tg
          .editMessageText(conv, messageId, `⚠️ Xoá lịch <b>#${id}</b> (${formatSchedule(sch)})? Topic + lịch sử vẫn giữ.`, { reply_markup: kb })
          .catch(() => {});
        return;
      }
      case "dy": {
        this.scheduleStore.remove(id);
        await this.tg.answerCallbackQuery(cb.id, `🗑 Đã xoá #${id}`);
        if (messageId) {
          await this.tg
            .editMessageText(conv, messageId, `🗑 Đã xoá lịch <b>#${id}</b>. Dọn topic mồ côi bằng /prune.`, { reply_markup: { inline_keyboard: [] } })
            .catch(() => {});
        }
        return;
      }
      default:
        await this.tg.answerCallbackQuery(cb.id);
    }
  }

  private async cmdClear(conv: ConvKey, state: ChatState): Promise<void> {
    await this.stopCurrent(conv, true);
    this.cancelAllReminders(conv); // stop nudging + clear schedules before wiping state
    void state;
    this.st.clear(conv);
    for (const [formId, qf] of this.questionForms) {
      if (qf.conv === conv) this.questionForms.delete(formId);
    }
    await this.tg.sendMessage(conv, "🧹 State cleared. Next message starts a fresh session.");
  }

  // ── question forms (the agent's `question` tool) ──────────────────────────
  /** Entry point for every OpenCode event; only question forms interest us. */
  private recordSessionActivity(record: () => unknown): void {
    if (this.activityStopped) return;
    try { record(); } catch (error) { warn("Không lưu được bản ghi hoạt động:", (error as Error).message); }
  }

  private observeSessionActivity(conv: ConvKey): Promise<void> {
    const existing = this.activityReads.get(conv);
    if (existing) { this.activityAgain.add(conv); return existing; }
    const task = (async () => {
      for (let attempt = 0; attempt < 2 && !this.activityStopped; attempt++) {
        this.activityAgain.delete(conv);
        const sid = this.st.peek(conv)?.sessionID;
        if (!sid) return;
        const link = this.topics.forTopic(conv);
        if (this.topics.enabled(conv) && !this.topics.canInteract(conv, sid)) return;
        const revision = this.sessionActivity.read(conv)?.revision;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        this.activityAborts.set(conv, controller);
        try {
          const snapshot = await this.oc.activitySnapshot(sid, controller.signal);
          if (this.activityStopped || controller.signal.aborted || this.st.peek(conv)?.sessionID !== sid) return;
          if (link && (snapshot.info.id !== sid || snapshot.info.source !== link.identity?.source ||
            snapshot.info.projectID !== link.identity?.projectID || snapshot.info.createdAt !== link.identity?.createdAt ||
            this.topics.forTopic(conv)?.id !== link.id || JSON.stringify(this.topics.forTopic(conv)?.identity) !== JSON.stringify(link.identity) ||
            !this.topics.canInteract(conv, sid))) throw new Error("Danh tính phiên đổi trong lúc đọc hoạt động.");
          this.sessionActivity.observe(conv, sid, revision, snapshot.messages);
          this.resumeConfirmations.observe(conv, snapshot.messages.filter(message => message.type === "user").map(message => message.id));
          this.recordSessionActivity(() => this.publishActivityOutcome(conv));
        } finally { clearTimeout(timer); this.activityAborts.delete(conv); }
        if (!this.activityAgain.has(conv)) break;
      }
    })().finally(() => { this.activityReads.delete(conv); this.activityAgain.delete(conv); });
    this.activityReads.set(conv, task);
    return task;
  }

  private onOpenCodeEvent(ev: any): void {
    const t = ev?.type;
    if (["session.inbox.delivered", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(t)) {
      const conv = ev?.data?.sessionID ? this.st.findChatBySession(ev.data.sessionID) : undefined;
      if (conv) void this.observeSessionActivity(conv).catch(error => warn("Không đối chiếu được hoạt động phiên:", error?.message));
    }
    if (t === "session.renamed" && typeof ev?.data?.sessionID === "string") {
      this.topics.requestTitleSync(ev.data.sessionID);
      return;
    }
    if (["session.archived", "session.unarchived", "session.deleted"].includes(t)) {
      if (this.topics.list().some((link) => link.sessionID === ev?.data?.sessionID)) void this.reconcileTopics().catch(() => warn("Session/topic lifecycle event could not be reconciled."));
      return;
    }
    if (typeof t === "string" && t.startsWith("session.execution.")) {
      void this.scheduler?.recover(false, ev?.data?.sessionID).catch((e) => warn("khôi phục lượt chạy:", e?.name));
    }
    if (t === "form.created") {
      const form = ev?.data?.form;
      if (form?.id && form?.sessionID) void this.onFormCreated(form);
    } else if (t === "form.replied" || t === "form.cancelled") {
      const formID = ev?.data?.id;
      const owner = this.questionForms.get(formID)?.conv;
      if (owner) this.orch.onResumed(owner);
      if (formID) void this.onFormResolved(formID, t);
    } else if (t === "permission.asked") {
      const d = ev?.data;
      if (d?.id && d?.sessionID) void this.onPermissionAsked(d);
    } else if (t === "permission.replied") {
      const d = ev?.data;
      const owner = d?.sessionID ? this.st.findChatBySession(d.sessionID) : this.permissionPrompts.get(d?.requestID)?.conv;
      if (owner) this.orch.onResumed(owner);
      if (d?.requestID) void this.onPermissionResolved(d.requestID, d.reply);
    } else if (
      t === "session.tool.input.started" ||
      t === "session.tool.called" ||
      t === "session.tool.success" ||
      t === "session.tool.failed"
    ) {
      this.onToolEvent(t, ev?.data);
      // Live draft: flash to "Thinking…" when a tool starts (streaming only).
      if (this.cfg.stream && t === "session.tool.input.started") this.onDraftToolStart(ev?.data);
    } else if (t === "session.text.delta") {
      // Live draft: stream the token into the conv's ephemeral preview.
      if (this.cfg.stream) this.onDraftTextDelta(ev?.data);
    } else if (t === "session.shell.started" || t === "session.shell.ended") {
      const conv = ev?.data?.sessionID ? this.st.findChatBySession(ev.data.sessionID) : undefined;
      if (conv) void (t === "session.shell.started" ? this.showActivity(conv, "▶ Đang chạy shell…") : this.finishActivity(conv, true));
    } else if (
      t === "session.execution.started" ||
      t === "session.execution.succeeded" ||
      t === "session.execution.failed" ||
      t === "session.execution.interrupted"
    ) {
      // Execution lifecycle. While we own the turn (a prompt is in flight) the
      // prompt path manages typing and the relay itself, so only act for
      // out-of-band executions — e.g. a background task waking the session.
      // That keeps Telegram in sync: typing while the session is busy, and the
      // reply relayed as soon as the turn ends.
      const conv = ev?.data?.sessionID ? this.st.findChatBySession(ev.data.sessionID) : undefined;
      if (!conv) return;
      this.orch.onExecution(conv, t, ev?.data?.error?.message ?? (typeof ev?.data?.error === "string" ? ev.data.error : undefined));
      if (this.inflight.has(conv)) return;
      if (t === "session.execution.started") {
        this.startTyping(conv);
      } else {
        this.stopTyping(conv);
        this.stopWorking(conv); // manager turn ended (fire-and-forget, not inflight) — remove the "⏳"
        this.clearActivity(conv);
        void this.sweepUnrelayedReplies(conv, "turn ended out-of-band", t === "session.execution.succeeded");
      }
    }
  }

  /**
   * Edit a card in place. "message is not modified" counts as success (the card
   * is still there and matches); any other failure returns -1 so the caller can
   * fall back to a fresh message. Returns the message id on success.
   */
  private async editCardInPlace(conv: ConvKey, messageId: number, text: string, kb?: Keyboard): Promise<number> {
    try {
      await this.tg.editMessageTextStrict(conv, messageId, text, { reply_markup: kb });
      return messageId;
    } catch (e) {
      if (/message is not modified/i.test(String((e as Error)?.message))) return messageId;
      return -1;
    }
  }

  /** A new question form appeared — relay its first field to the owning chat. */
  private async onFormCreated(form: any, resurface = false): Promise<void> {
    const sessionID = form.sessionID as string;
    const formID = form.id as string;
    const existing = this.questionForms.get(formID);
    if (existing && !resurface) return;
    const conv = this.st.findChatBySession(sessionID);
    if (!conv) {
      warn(`form.created for session ${sessionID} with no mapped chat — ignoring`);
      return;
    }
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, sessionID)) return;
    if (existing) {
      if (existing.conv !== conv || existing.sessionID !== sessionID) return;
      const view = this.renderQuestion(existing);
      let messageId = existing.messageId ? await this.editCardInPlace(conv, existing.messageId, view.text, view.keyboard) : -1;
      if (messageId < 0) messageId = await this.tg.sendMessageId(conv, view.text, { reply_markup: view.keyboard }).catch(() => -1);
      existing.messageId = messageId;
      if (messageId > 0) this.startPromptReminder(conv, formID, "form", view.text, view.keyboard, messageId);
      return;
    }
    const fields: QField[] = (form.fields ?? [])
      .filter((f: any) => !f.hidden)
      .map((f: any) => ({
        key: f.key,
        title: f.title,
        description: f.description,
        type: f.type,
        options: f.options,
        custom: f.custom,
        required: f.required,
      }));
    if (!fields.length) {
      await this.tg
        .sendMessage(conv, "❓ OpenCode đang hỏi (không có lựa chọn) — xem /history để biết chi tiết.")
        .catch(() => {});
      return;
    }
    const qf: QuestionFormState = { formId: formID, sessionID, conv, fields, index: 0, answers: {} };
    this.orch.onWaiting(conv);
    this.questionForms.set(formID, qf);
    const v = this.renderQuestion(qf);
    // Re-registration after a restart (reconcile): the original card is usually
    // still in the chat — refresh it in place instead of posting a duplicate.
    const prevId = this.st.get(conv).pendingPrompts?.[formID]?.messageId;
    let messageId = prevId ? await this.editCardInPlace(conv, prevId, v.text, v.keyboard) : -1;
    if (messageId < 0) messageId = await this.tg.sendMessageId(conv, v.text, { reply_markup: v.keyboard }).catch(() => -1);
    qf.messageId = messageId;
    // Start nudging if the user doesn't answer (exponential backoff; keyed by form id)
    // — but ONLY when the card was actually sent, else a reminder would re-send
    // buttons that were never delivered.
    if (messageId > 0) this.startPromptReminder(conv, formID, "form", v.text, v.keyboard, messageId);
    if (!resurface && messageId > 0) this.publishNotice(conv, "question", { kind: "form", id: formID }, this.st.peek(conv)?.pendingPrompts?.[formID]?.firstShownAt ?? Date.now());
  }

  /** A form was answered/cancelled out-of-band (e.g. in the TUI) — clean up. */
  private async onFormResolved(formID: string, type: string): Promise<void> {
    const qf = this.questionForms.get(formID);
    if (!qf) {
      // After a restart the in-memory map is empty, but a reminder for this form
      // may still be persisted — cancel it (find its conv) before bailing.
      const rc = this.findPromptConv(formID);
      if (rc) this.cancelReminder(rc, formID);
      return;
    }
    this.questionForms.delete(formID);
    this.cancelReminder(qf.conv, formID);
    if (qf.messageId) {
      const msg =
        type === "form.cancelled"
          ? "ℹ️ Câu hỏi đã được huỷ bởi OpenCode."
          : "ℹ️ Câu hỏi đã được trả lời (nơi khác).";
      await this.tg.editMessageText(qf.conv, qf.messageId, msg).catch(() => {});
    }
  }

  /** Build the text + inline keyboard for the current field of a question form. */
  private renderQuestion(qf: QuestionFormState): { text: string; keyboard: Keyboard } {
    const f = qf.fields[qf.index];
    const total = qf.fields.length;
    const n = qf.index + 1;
    const lines: string[] = [];
    lines.push(`❓ <b>Câu ${n}/${total}</b>${f.title ? " · " + esc(f.title) : ""}`);
    if (f.description) lines.push(esc(f.description));
    if (qf.waitingCustom !== undefined) {
      lines.push("", "✍️ <i>Gõ câu trả lời của bạn trong tin nhắn kế tiếp (bấm Huỷ để bỏ qua).</i>");
    } else if (f.options?.length) {
      lines.push("", "Chạm một đáp án, hoặc tự gõ đáp án của bạn:");
    } else {
      lines.push("", "Gõ câu trả lời của bạn:");
    }

    const rows: Btn[][] = [];
    const fd = qf.formId;
    if (qf.waitingCustom !== undefined) {
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x:${qf.index}` }]);
    } else {
      (f.options ?? []).forEach((opt, i) => {
        rows.push([{ text: `▪️ ${trunc(opt.label, 60)}`, callback_data: `fq:${fd}:o${i}:${qf.index}` }]);
      });
      if (f.custom || !f.options?.length || f.type === "string") {
        rows.push([{ text: "✍️ Gõ tự do…", callback_data: `fq:${fd}:c:${qf.index}` }]);
      }
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x:${qf.index}` }]);
    }
    return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
  }

  /** Handle a tap on a question-form button (data = `fq:<formId>:<op>`). */
  private async handleFormCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const data = cb.data ?? "";
    const parts = data.split(":");
    const formID = parts[1];
    const op = parts[2] ?? "";
    const qf = this.questionForms.get(formID);
    if (!qf || qf.conv !== conv || this.st.peek(conv)?.sessionID !== qf.sessionID || parts[3] !== String(qf.index)) {
      await this.tg.answerCallbackQuery(cb.id, "Phiên hỏi đã kết thúc.");
      return;
    }
    try {
      const live = await this.oc.listForms(qf.sessionID, AbortSignal.timeout(3000));
      if (!live.some(form => form.id === formID) || this.questionForms.get(formID) !== qf || parts[3] !== String(qf.index)) {
        if (!live.some(form => form.id === formID)) await this.onFormResolved(formID, "form.submitted");
        await this.tg.answerCallbackQuery(cb.id, "Câu hỏi hoặc lựa chọn đã hết hạn; mở thẻ mới nhất.");
        return;
      }
      if (op === "x") {
        await this.oc.cancelForm(qf.sessionID, qf.formId, "Cancelled by user via Telegram.");
        this.questionForms.delete(formID);
        this.cancelReminder(conv, formID); // the form is really cancelled → stop nudging
        await this.tg.answerCallbackQuery(cb.id);
        if (messageId) await this.tg.editMessageText(conv, messageId, "❌ Đã huỷ câu hỏi.").catch(() => {});
        return;
      }
      if (op === "c") {
        qf.waitingCustom = qf.index;
        await this.tg.answerCallbackQuery(cb.id);
        if (messageId) {
          const v = this.renderQuestion(qf);
          await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
        }
        return;
      }
      if (op.startsWith("o")) {
        const idx = Number(op.slice(1));
        const f = qf.fields[qf.index];
        const opt = f.options?.[idx];
        if (!opt) throw new Error("Đáp án không hợp lệ — vui lòng thử lại.");
        qf.answers[f.key] = opt.value;
        await this.tg.answerCallbackQuery(cb.id);
        await this.advanceOrSubmit(qf, conv, messageId);
        return;
      }
      await this.tg.answerCallbackQuery(cb.id);
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
    }
  }

  /** After recording an answer: show the next field, or submit if all answered. */
  private async advanceOrSubmit(qf: QuestionFormState, conv: ConvKey, messageId?: number): Promise<void> {
    qf.waitingCustom = undefined;
    if (qf.index + 1 < qf.fields.length) {
      qf.index += 1;
      if (messageId) {
        const v = this.renderQuestion(qf);
        await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
        // Keep nudging about the NEXT field of the same form (same form id), with
        // its buttons so the reminder is answerable — on the SAME card.
        this.startPromptReminder(conv, qf.formId, "form", v.text, v.keyboard, messageId);
      } else {
        // Nothing was shown for the new field: don't keep nudging about the old one.
        this.cancelReminder(conv, qf.formId);
      }
      return;
    }
    // All fields answered — submit the full answer to OpenCode.
    await this.oc.replyForm(qf.sessionID, qf.formId, qf.answers);
    this.questionForms.delete(qf.formId);
    this.cancelReminder(conv, qf.formId); // form really submitted → stop nudging
    if (messageId) {
      const summary = Object.entries(qf.answers)
        .map(([k, v]) => `• ${esc(trunc(String(v), 80))}`)
        .join("\n");
      await this.tg
        .editMessageText(conv, messageId, `✅ Đã gửi câu trả lời cho OpenCode.${summary ? "\n" + summary : ""}`)
        .catch(() => {});
    }
  }

  /**
   * If a question form in this chat is waiting for a typed (custom) answer,
   * consume this text as that answer. Returns true if the text was consumed.
   */
  private async handleFormText(conv: ConvKey, text: string): Promise<boolean> {
    for (const qf of this.questionForms.values()) {
      if (qf.conv === conv && qf.waitingCustom !== undefined) {
        const live = await this.oc.listForms(qf.sessionID, AbortSignal.timeout(3000));
        if (this.st.peek(conv)?.sessionID !== qf.sessionID || this.questionForms.get(qf.formId) !== qf || !live.some(form => form.id === qf.formId)) {
          await this.tg.sendMessage(conv, "Câu hỏi đã đổi hoặc hết chờ; không gửi câu trả lời cũ.");
          return true;
        }
        const f = qf.fields[qf.index];
        qf.answers[f.key] = text;
        await this.advanceOrSubmit(qf, conv, qf.messageId);
        return true;
      }
    }
    return false;
  }

  // ── permission prompts (OpenCode tool permission asks) ────────────────────
  /** A permission request is pending — relay it to the owning chat as buttons. */
  private async onPermissionAsked(d: any, resurface = false): Promise<void> {
    const requestID = d.id as string;
    const sessionID = d.sessionID as string;
    const existing = this.permissionPrompts.get(requestID);
    if (existing && !resurface) return;
    const conv = this.st.findChatBySession(sessionID);
    if (!conv) {
      warn(`permission.asked for session ${sessionID} with no mapped chat — ignoring`);
      return;
    }
    if (this.topics.enabled(conv) && !this.topics.canInteract(conv, sessionID)) return;
    if (existing && (existing.conv !== conv || existing.sessionID !== sessionID)) return;
    this.orch.onWaiting(conv);
    const lines: string[] = ["🔐 <b>OpenCode xin quyền</b>"];
    lines.push(`action: <code>${esc(d.action ?? "?")}</code>`);
    for (const r of (d.resources ?? []) as string[]) {
      lines.push(`resource: <code>${esc(trunc(r, 150))}</code>`);
    }
    if (d.message) lines.push(esc(trunc(String(d.message), 300)));
    lines.push("", "<i>Bấm để trả lời — hoặc xử lý trong terminal TUI (bot tự cập nhật).</i>");
    const kb: Keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Duyệt 1 lần", callback_data: `perm:${requestID}:once` },
          { text: "♾️ Duyệt luôn", callback_data: `perm:${requestID}:always` },
        ],
        [{ text: "❌ Từ chối", callback_data: `perm:${requestID}:reject` }],
      ],
    };
    // Re-registration after a restart (reconcile): refresh the original card in
    // place instead of posting a duplicate permission prompt.
    const prevId = existing?.messageId ?? this.st.get(conv).pendingPrompts?.[requestID]?.messageId;
    let messageId = prevId ? await this.editCardInPlace(conv, prevId, lines.join("\n"), kb) : -1;
    if (messageId < 0) messageId = await this.tg.sendMessageId(conv, lines.join("\n"), { reply_markup: kb }).catch(() => -1);
    if (messageId > 0) {
      this.permissionPrompts.set(requestID, { requestID, sessionID, conv, messageId });
      // Start nudging if unanswered — but ONLY when the card was actually sent.
      // A failed send (messageId = -1) would leave a reminder re-sending a card
      // whose buttons are no longer valid (dead buttons).
      this.startPromptReminder(conv, requestID, "permission", lines.join("\n"), kb, messageId);
      if (!resurface) this.publishNotice(conv, "permission", { kind: "permission", id: requestID }, this.st.peek(conv)?.pendingPrompts?.[requestID]?.firstShownAt ?? Date.now());
    }
  }

  /** The request was answered elsewhere (e.g. the TUI) — settle the Telegram card. */
  private async onPermissionResolved(requestID: string, reply: string): Promise<void> {
    const p = this.permissionPrompts.get(requestID);
    if (!p) {
      // After a restart the in-memory map is empty, but a reminder may still be
      // persisted — cancel it (find its conv) before bailing.
      const rc = this.findPromptConv(requestID);
      if (rc) this.cancelReminder(rc, requestID);
      return;
    }
    this.permissionPrompts.delete(requestID);
    this.cancelReminder(p.conv, requestID);
    const label = reply === "reject" ? "từ chối" : reply === "always" ? "duyệt luôn" : "duyệt";
    if (p.messageId) {
      await this.tg
        .editMessageText(p.conv, p.messageId, `ℹ️ Quyền đã được ${label} ở nơi khác.`)
        .catch(() => {});
    }
  }

  /** Handle a tap on a permission button (data = `perm:<requestID>:<once|always|reject>`). */
  private async handlePermissionCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
    const parts = (cb.data ?? "").split(":");
    const requestID = parts[1];
    const decision = parts[2];
    const p = this.permissionPrompts.get(requestID);
    if (!p || p.conv !== conv || this.st.peek(conv)?.sessionID !== p.sessionID) {
      await this.tg.answerCallbackQuery(cb.id, "Yêu cầu quyền này đã hết hạn.");
      return;
    }
    const labels: Record<string, string> = {
      once: "✅ Đã duyệt (1 lần).",
      always: "♾️ Đã duyệt luôn — quyền này được lưu, không hỏi lại.",
      reject: "❌ Đã từ chối.",
    };
    try {
      if (!Object.hasOwn(labels, decision)) throw new Error("Lựa chọn không hợp lệ.");
      const live = await this.oc.listPermissions(p.sessionID, AbortSignal.timeout(3000));
      if (!live.some(permission => permission.id === requestID) || this.permissionPrompts.get(requestID) !== p) {
        if (!live.some(permission => permission.id === requestID)) await this.onPermissionResolved(requestID, "resolved");
        await this.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã hết chờ; không gửi quyết định cũ.");
        return;
      }
      await this.oc.replyPermission(p.sessionID, p.requestID, decision as "once" | "always" | "reject");
      this.permissionPrompts.delete(requestID);
      this.cancelReminder(conv, requestID); // answered → stop nudging
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.editMessageText(conv, messageId, labels[decision]).catch(() => {});
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (/not[ _-]?found/i.test(msg)) {
        this.permissionPrompts.delete(requestID);
        this.cancelReminder(conv, requestID); // answered elsewhere → stop nudging
        await this.tg.answerCallbackQuery(cb.id, "Yêu cầu này đã được xử lý ở nơi khác.");
        if (messageId) {
          await this.tg.editMessageText(conv, messageId, "ℹ️ Quyền đã được xử lý ở nơi khác.").catch(() => {});
        }
        return;
      }
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${msg.slice(0, 100)}`);
    }
  }
}
