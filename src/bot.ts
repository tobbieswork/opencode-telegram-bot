import { isAbsolute, resolve, dirname, join } from "node:path";
import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes, randomInt } from "node:crypto";
import { Telegram, Update, CallbackQuery, Message, MessageGenerationStopped, MessageReactionUpdated } from "./telegram.js";
import { OpenCodeCtl, newMessageID, assistantText, ModelInfo, SessionBrief } from "./opencode.js";
import { StateManager, ChatState, MsgPurpose, MACHINE_STATE_KEY } from "./state.js";
import { ConvKey, convKey, chatOf, parseConv } from "./conv.js";
import { Orchestrator } from "./orchestrator.js";
import { ScheduleStore, Scheduler } from "./scheduler.js";
import { Schedule, SchedSpec, formatSchedule, nextRunAfter, parseScheduleSpec } from "./schedule.js";
import { Config } from "./config.js";
import { esc, stripTags, chunk, trunc, mdToHtmlChunks, formatTurnFailure } from "./format.js";
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
import { myCommands } from "./commands.js";
import { dropNotes, prepareNotes, BUSY_REPLY_TEXT, NOTE_BUTTON_LABEL, NOTE_CB_PREFIX, noteCallbackData, BusyNoteStore } from "./notes.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "./fsbrowser.js";
import { log, warn, error } from "./logger.js";
import { AGENT_WHITELIST, QUESTIONS_PREAMBLE, NOTES_KEY } from "./shared.js";
import type { Btn, Keyboard } from "./shared.js";
import { cmdAgents, cmdAgent, handleAgentCallback } from "./commands/agents.js";
import { cmdSchedule, handleScheduleCallback } from "./commands/schedule.js";
import { cmdHelp, cmdStatus, cmdContext, cmdUsage, cmdHistory, cmdNote, handleNoteCallback } from "./commands/meta.js";

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

/** Key under which the per-session language instruction is stored (namespaced `api/<key>`). */
const LANGUAGE_INSTRUCTION_KEY = "tgbot.language";
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
  public inflight = new Map<ConvKey, AbortController>();
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
  public busyNotes = new BusyNoteStore();
  /** Open /model button pickers, one per conv (in-memory; dead buttons after a restart are handled). */
  private modelPickers = new Map<ConvKey, { models: ModelInfo[]; page: number }>();
  /** The user's most recent top-level chat, for proactive notices (e.g. DNS heal). */
  private lastActiveConv?: ConvKey;
  /** Reaction UX: index keys already logged as "not indexed", so a reaction storm doesn't spam the log. */
  private missingIdxLogged = new Set<string>();

  /** Worker topics + the Manager agent (multi-session layer). */
  public orch: Orchestrator;
  /** Schedules, in their own file (data/schedules.json) — /clear must never touch them. */
  public scheduleStore: ScheduleStore;
  /** /schedule tick engine — only constructed/started when cfg.schedule is on. */
  private scheduler?: Scheduler;

  constructor(
    public tg: Telegram,
    public oc: OpenCodeCtl,
    public st: StateManager,
    public cfg: Config,
  ) {
    // Same data dir as state.json (derived from cfg.stateFile); a SEPARATE file
    // on purpose so /clear and the per-chat sweeps can't wipe schedules.
    this.scheduleStore = new ScheduleStore(
      join(dirname(this.cfg.stateFile), "schedules.json"),
      this.cfg.maxSchedules,
    );
    this.orch = new Orchestrator({
      tg,
      oc,
      st,
      cfg,
      busyNotes: this.busyNotes,
      sendHtml: (conv, html, opts) => this.sendHtml(conv, html, opts),
      applyModelAndVariant: (sid, state) => this.applyModelAndVariant(sid, state),
      prepareNotes: (conv, sid) => this.prepareNotesTurn(conv, sid),
      startTyping: (conv) => this.startTyping(conv),
      startWorking: (conv) => this.startWorking(conv),
      stopWorking: (conv) => this.stopWorking(conv),
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
  }

  /** Begin relaying OpenCode question forms to Telegram. Called once from index.ts. */
  start(): void {
    this.oc.subscribeEvents(
      (ev) => this.onOpenCodeEvent(ev),
      (e) => warn("event stream:", e?.message ?? e),
      () => {
        void this.orch.onConnect().catch((e) => warn("orchestrator:", e?.message));
        void this.reconcile().catch((e) => warn("reconcile:", e?.message));
      },
    );
    // Resume any pending-prompt reminder nudges that were scheduled before a restart.
    this.resumePromptReminders();
    // Start the /schedule tick engine alongside the reminder re-arm (both are
    // startup "re-arm" concerns). Guarded on the cfg.schedule toggle.
    if (this.cfg.schedule) {
      this.scheduler = new Scheduler({
        now: () => Date.now(),
        store: this.scheduleStore,
        dispatch: (sch) => this.orch.runScheduled(sch.conv, sch),
        isBusy: (sch) => this.orch.workerBusyByName(sch.conv, "sch-" + sch.id),
        isAllowed: (uid) => this.cfg.allowedUserIds.includes(uid),
        notify: (conv, text) => this.tg.sendMessage(conv, text),
        tickMs: 30_000,
        graceMs: this.cfg.scheduleGraceMs,
      });
      this.scheduler.start();
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
    this.scheduler?.stop();
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
    return convKey(m.chat.id, m.is_topic_message ? m.message_thread_id : undefined);
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
    // Remember the user's top-level chat so proactive notices (e.g. DNS heal)
    // have a destination even mid-polling-failure.
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

    if (text.startsWith("/")) await this.handleCommand(conv, text, state, uid);
    else {
      // (The "🤔 thinking" body-react on the user's message was removed 2026-10-27:
      // the working indicator now covers "the bot is working" on new prompts.)
      if (await this.handleFormText(conv, text)) return;
      else if (state.manager) await this.orch.promptManager(conv, text, msg.message_id);
      else await this.runPrompt(conv, text, state, msg.message_id);
    }
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
  public async sendHtml(conv: ConvKey, html: string, opts: { reply_markup?: Keyboard } = {}): Promise<void> {
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
    if (!this.cfg.react) return;
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
    if (!this.cfg.remind) return;
    const prev = this.st.get(conv).pendingPrompts?.[promptId];
    const sched = scheduleForRegistration(prev, kind, this.cfg.remindBaseMs, Date.now());
    const pp = { kind, text, keyboard, messageId: messageId ?? prev?.messageId, ...sched };
    this.st.set(conv, { pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: pp } });
    this.armReminderTimer(conv, promptId);
  }

  /** (Re)arm the one-shot reminder timer for one prompt from its persisted schedule. */
  private armReminderTimer(conv: ConvKey, promptId: string): void {
    const key = this.reminderKey(conv, promptId);
    const existing = this.reminders.get(key);
    if (existing) clearTimeout(existing);
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
    if (await this.orch.handleCommand(conv, cmd.toLowerCase(), arg)) return;
    switch (cmd.toLowerCase()) {
      case "/start":
      case "/help":
        return cmdHelp(this, conv);
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
        return cmdAgents(this, conv);
      case "/agent":
        return cmdAgent(this, conv, arg, state);
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
        return cmdStatus(this, conv, state);
      case "/context":
      case "/ctx":
        return cmdContext(this, conv, state);
      case "/usage":
        return cmdUsage(this, conv, arg);
      case "/history":
        return cmdHistory(this, conv, state);
      case "/clear":
        return this.cmdClear(conv, state);
      case "/note":
        return cmdNote(this, conv, arg);
      case "/schedule":
        return cmdSchedule(this, conv, arg, state, uid);
      default:
        return this.tg.sendMessage(conv, `Unknown command: ${esc(cmd)}\nSend /help`);
    }
  }

  // ── the long-running prompt ──────────────────────────────────────────────
  private async runPrompt(conv: ConvKey, text: string, state: ChatState, userMsgId?: number): Promise<void> {
    // A closed worker topic reopens itself when the user speaks in it
    // (openForumTopic is a no-op on an already-open topic, so safe every time).
    if (state.worker) void this.tg.openForumTopic(conv).catch(() => {});
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
      return;
    }
    // Keep the "typing…" indicator alive for the whole turn (until the reply is sent).
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
      await this.prepareNotesTurn(conv, sid);
      // Inject the "ask via question tool" preamble once per session so the agent
      // knows it is headless and should surface decisions as answerable questions.
      let promptText = text;
      if (this.cfg.guideQuestions && !state.guided) {
        promptText = QUESTIONS_PREAMBLE + "\n\n" + text;
        this.st.set(conv, { guided: true });
      }
      const ac = new AbortController();
      this.inflight.set(conv, ac);
      log(`[chat ${conv}] prompt on ${sid} (${text.length} chars)`);
      // Fire-and-forget: don't block the polling loop; /stop aborts `ac`.
      void this.runPromptTask(conv, sid, promptText, ac, userMsgId).catch((e) => error("prompt task:", e?.message));
    } catch (e) {
      this.stopTyping(conv); // don't leave "typing…" running if the prompt never started
      throw e;
    }
  }

  private async runPromptTask(conv: ConvKey, sid: string, text: string, ac: AbortController, userMsgId?: number): Promise<void> {
    // One id for this user message, reused by the reconnect retry below: the
    // server dedupes on it, so the retry waits on the same turn instead of
    // running the instruction a second time.
    const messageID = newMessageID();
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
        if (!ac.signal.aborted && isTransportError(e)) {
          warn("prompt failed (transport) — reconnecting to OpenCode and retrying…");
          await this.oc.reconnect();
          res = await run();
        } else {
          throw e;
        }
      }
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
      this.inflight.delete(conv);
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
    const conv = convKey(ev.chat.id, ev.message_thread_id);
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
      await handleNoteCallback(this, cb, conv, messageId);
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
      await handleAgentCallback(this, cb, conv, messageId);
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
      await handleScheduleCallback(this, cb, conv, messageId);
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
          await cmdAgents(this, conv);
          break;
        case "stop":
          await this.cmdStop(conv, state);
          break;
        case "reboot":
          await this.cmdReboot(conv);
          break;
        case "status":
          await cmdStatus(this, conv, state);
          break;
        case "context":
          await cmdContext(this, conv, state);
          break;
        case "usage":
          await cmdUsage(this, conv);
          break;
        case "history":
          await cmdHistory(this, conv, state);
          break;
        case "clear":
          await this.cmdClear(conv, state);
          break;
        case "schedule":
          await cmdSchedule(this, conv, "", state, cb.from?.id);
          break;
        case "help":
          await cmdHelp(this, conv);
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
    const footer = "\n\nSet with /model <id>";
    // Show EVERY model, packed into ≤max-char pages on line boundaries so each
    // message is valid HTML with balanced tags (no mid-tag cuts → no 400s).
    const units = [
      `<b>Models (${models.length})</b>`,
      ...models.map((m) => `${cur === m.id ? "▶️ " : ""}<code>${m.id}</code>${m.name ? ` — ${esc(m.name)}` : ""}`),
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
    const sid = this.st.get(conv).sessionID;
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

  /** The current mode, derived from the session's agent (a curated label). */
  public currentMode(state: ChatState): string | undefined {
    return Object.entries(MODES).find(([, m]) => m.agent === state.agent)?.[0];
  }

  /** Switch the chat's mode (agent): persist it and apply to the open session. */
  private async applyMode(conv: ConvKey, state: ChatState, agent: string): Promise<void> {
    this.st.set(conv, { agent });
    if (state.sessionID) {
      await this.oc.setAgent(state.sessionID, agent).catch((e) => error("setAgent:", e?.message));
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
    const applied = state.sessionID ? "applied" : "applies on /new";
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
    const sid = this.st.get(conv).sessionID;
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
    await this.stopCurrent(conv);
    this.cancelAllReminders(conv);
    if (state.sessionID) await this.oc.interrupt(state.sessionID).catch(() => {});
    await this.tg.sendMessage(conv, "⏹️ Interrupted.");
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
  private onOpenCodeEvent(ev: any): void {
    const t = ev?.type;
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
  private async onFormCreated(form: any): Promise<void> {
    const sessionID = form.sessionID as string;
    const formID = form.id as string;
    if (this.questionForms.has(formID)) return;
    const conv = this.st.findChatBySession(sessionID);
    if (!conv) {
      warn(`form.created for session ${sessionID} with no mapped chat — ignoring`);
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
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x` }]);
    } else {
      (f.options ?? []).forEach((opt, i) => {
        rows.push([{ text: `▪️ ${trunc(opt.label, 60)}`, callback_data: `fq:${fd}:o${i}` }]);
      });
      if (f.custom || !f.options?.length || f.type === "string") {
        rows.push([{ text: "✍️ Gõ tự do…", callback_data: `fq:${fd}:c` }]);
      }
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x` }]);
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
    if (!qf) {
      await this.tg.answerCallbackQuery(cb.id, "Phiên hỏi đã kết thúc.");
      return;
    }
    try {
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
  private async onPermissionAsked(d: any): Promise<void> {
    const requestID = d.id as string;
    const sessionID = d.sessionID as string;
    if (this.permissionPrompts.has(requestID)) return;
    const conv = this.st.findChatBySession(sessionID);
    if (!conv) {
      warn(`permission.asked for session ${sessionID} with no mapped chat — ignoring`);
      return;
    }
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
    const prevId = this.st.get(conv).pendingPrompts?.[requestID]?.messageId;
    let messageId = prevId ? await this.editCardInPlace(conv, prevId, lines.join("\n"), kb) : -1;
    if (messageId < 0) messageId = await this.tg.sendMessageId(conv, lines.join("\n"), { reply_markup: kb }).catch(() => -1);
    if (messageId > 0) {
      this.permissionPrompts.set(requestID, { requestID, sessionID, conv, messageId });
      // Start nudging if unanswered — but ONLY when the card was actually sent.
      // A failed send (messageId = -1) would leave a reminder re-sending a card
      // whose buttons are no longer valid (dead buttons).
      this.startPromptReminder(conv, requestID, "permission", lines.join("\n"), kb, messageId);
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
    if (!p) {
      await this.tg.answerCallbackQuery(cb.id, "Yêu cầu quyền này đã hết hạn.");
      return;
    }
    const labels: Record<string, string> = {
      once: "✅ Đã duyệt (1 lần).",
      always: "♾️ Đã duyệt luôn — quyền này được lưu, không hỏi lại.",
      reject: "❌ Đã từ chối.",
    };
    try {
      if (!labels[decision]) throw new Error("Lựa chọn không hợp lệ.");
      await this.oc.replyPermission(p.sessionID, p.requestID, decision as "once" | "always" | "reject");
      this.permissionPrompts.delete(requestID);
      this.cancelReminder(conv, requestID); // answered → stop nudging
      await this.tg.answerCallbackQuery(cb.id);
      if (messageId) await this.tg.editMessageText(conv, messageId, labels[decision]).catch(() => {});
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (/not found|permission/i.test(msg)) {
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
