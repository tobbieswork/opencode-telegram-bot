import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { Telegram, Update, CallbackQuery } from "./telegram.js";
import { OpenCodeCtl, newMessageID, assistantText } from "./opencode.js";
import { StateManager, ChatState } from "./state.js";
import { ConvKey, convKey, chatOf } from "./conv.js";
import { Orchestrator } from "./orchestrator.js";
import { Config } from "./config.js";
import { esc, stripTags, chunk, trunc, mdToHtmlChunks, fmtNum, timeAgo, formatTurnFailure } from "./format.js";
import { firstReminderAt, reminderBudgetExhausted, nextScheduleAfterReminder } from "./reminders.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "./fsbrowser.js";
import { log, warn, error } from "./logger.js";

/** Agents shown to the user (the rest are internal OpenCode roles). */
const AGENT_WHITELIST = ["build", "general", "explore", "plan"];

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

type Btn = { text: string; callback_data: string };
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
  /** Sessions from which we already stripped the language instruction this process (when the toggle is off), so we don't call removeInstruction every prompt. */
  private languageRemoved = new Set<string>();

  /** Worker topics + the Manager agent (multi-session layer). */
  private orch: Orchestrator;

  constructor(
    private tg: Telegram,
    private oc: OpenCodeCtl,
    private st: StateManager,
    private cfg: Config,
  ) {
    this.orch = new Orchestrator({
      tg,
      oc,
      st,
      cfg,
      sendHtml: (conv, html, opts) => this.sendHtml(conv, html, opts),
      applyModelAndVariant: (sid, state) => this.applyModelAndVariant(sid, state),
      startTyping: (conv) => this.startTyping(conv),
    });
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
      const forms = await this.oc.listForms(s.sessionID).catch(() => [] as any[]);
      for (const f of forms) if (f?.id && !this.questionForms.has(f.id)) await this.onFormCreated({ ...f, sessionID: s.sessionID });
      const perms = await this.oc.listPermissions(s.sessionID).catch(() => [] as any[]);
      for (const p of perms) if (p?.id && !this.permissionPrompts.has(p.id)) await this.onPermissionAsked({ ...p, sessionID: s.sessionID });
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
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    const msg = u.message ?? u.edited_message;
    if (!msg || !msg.text) return;
    const conv = this.convOf(msg);
    const uid = msg.from?.id as number | undefined;
    const text = (msg.text as string).trim();
    if (!text) return;
    if (!this.allowed(uid)) {
      log(`Denied message from uid=${uid} chat=${conv}`);
      await this.tg
        .sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.")
        .catch(() => {});
      return;
    }
    const state = this.st.get(conv);
    if (!state.directory) {
      // A topic the user opened by hand starts where the chat's main session works
      // (unless that is the Manager, whose folder is not a project).
      const top = this.st.peek(chatOf(conv));
      state.directory = top && !top.manager && top.directory ? top.directory : this.cfg.opencodeDirectory;
    }

    if (text.startsWith("/")) await this.handleCommand(conv, text, state);
    else if (await this.handleFormText(conv, text)) return;
    else if (state.manager) await this.orch.promptManager(conv, text);
    else await this.runPrompt(conv, text, state);
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
  /** Send a long model reply: render its Markdown as Telegram HTML, then chunk. */
  private async sendReply(conv: ConvKey, text: string): Promise<void> {
    const clean = stripTags(text ?? "");
    if (!clean) return;
    for (const c of mdToHtmlChunks(clean, this.cfg.replyMaxLen)) await this.tg.sendMessage(conv, c);
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
  private startPromptReminder(conv: ConvKey, promptId: string, kind: "form" | "permission", text: string, keyboard?: unknown): void {
    if (!this.cfg.remind) return;
    const now = Date.now();
    const pp = { kind, text, keyboard, firstShownAt: now, remindersSent: 0, nextReminderAt: firstReminderAt(this.cfg.remindBaseMs, now) };
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
    const delay = Math.max(0, pp.nextReminderAt - Date.now()); // overdue → fire soon
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
    const max = this.cfg.remindMax;
    const sent = pp.remindersSent + 1;
    // Re-send the ORIGINAL prompt + buttons so the user can just tap to answer.
    await this.sendHtml(
      conv,
      `⏰ <i>Nhắc (${sent}/${max}): câu hỏi/quyền này vẫn đang chờ bạn trả lời — hoặc gõ /stop để bỏ.</i>\n\n${pp.text}`,
      { reply_markup: pp.keyboard as Keyboard | undefined },
    ).catch(() => {});
    if (reminderBudgetExhausted(sent, max)) {
      this.cancelReminder(conv, promptId); // budget exhausted: stop nudging; prompt stays pending
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

  private async handleCommand(conv: ConvKey, raw: string, state: ChatState): Promise<void> {
    const [rawCmd, ...rest] = raw.split(/\s+/);
    // In groups, commands may arrive as /cmd@BotName.
    const cmd = rawCmd.replace(/@\w+$/, "");
    const arg = rest.join(" ").trim();
    if (await this.orch.handleCommand(conv, cmd.toLowerCase(), arg)) return;
    switch (cmd.toLowerCase()) {
      case "/start":
      case "/help":
        return this.cmdHelp(conv);
      case "/new":
        return this.cmdNew(conv, state);
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
      case "/variant":
        return this.cmdVariants(conv, arg, state);
      case "/stop":
        return this.cmdStop(conv, state);
      case "/status":
        return this.cmdStatus(conv, state);
      case "/context":
      case "/ctx":
        return this.cmdContext(conv, state);
      case "/history":
        return this.cmdHistory(conv, state);
      case "/clear":
        return this.cmdClear(conv, state);
      default:
        return this.tg.sendMessage(conv, `Unknown command: ${esc(cmd)}\nSend /help`);
    }
  }

  // ── the long-running prompt ──────────────────────────────────────────────
  private async runPrompt(conv: ConvKey, text: string, state: ChatState): Promise<void> {
    if (this.inflight.has(conv)) {
      await this.tg.sendMessage(conv, "⏳ Still working on the previous message. Send /stop to interrupt.");
      return;
    }
    // Keep the "typing…" indicator alive for the whole turn (until the reply is sent).
    this.startTyping(conv);
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
        this.languageRemoved.add(sid);
        await this.oc.removeInstruction(sid, LANGUAGE_INSTRUCTION_KEY).catch(() => {});
        if (state.guidedLanguageSession === sid) this.st.set(conv, { guidedLanguageSession: undefined });
      }
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
      void this.runPromptTask(conv, sid, promptText, ac).catch((e) => error("prompt task:", e?.message));
    } catch (e) {
      this.stopTyping(conv); // don't leave "typing…" running if the prompt never started
      throw e;
    }
  }

  private async runPromptTask(conv: ConvKey, sid: string, text: string, ac: AbortController): Promise<void> {
    // One id for this user message, reused by the reconnect retry below: the
    // server dedupes on it, so the retry waits on the same turn instead of
    // running the instruction a second time.
    const messageID = newMessageID();
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
      // A failed turn produced no useful reply — surface the real reason (often
      // context overflow, fixable with /clear) instead of an opaque "failed · Xs".
      if (res.outcome === "failed" && !res.interrupted) {
        if (res.reply) {
          await this.sendReply(conv, res.reply);
          if (res.replyTime) this.st.set(conv, { lastRelayedTime: res.replyTime });
        }
        await this.sendHtml(conv, formatTurnFailure(res.error, res.elapsedMs));
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
      error("prompt error:", (e as Error)?.message);
      const msg = isTransportError(e)
        ? "⚠️ Không thể nối tới OpenCode (service có thể đang restart / chưa chạy). Hẵng thử lại sau, hoặc kiểm tra `opencode service status`."
        : `❌ Error: ${esc((e as Error).message)}`;
      await this.tg.sendMessage(conv, msg).catch(() => {});
    } finally {
      this.inflight.delete(conv);
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
   * Stop waiting on the conversation's running turn. With `interrupt`, also
   * interrupt that turn on the server — otherwise switching away (/new, /clear,
   * opening another session) left the old session running and spending tokens.
   */
  private async stopCurrent(conv: ConvKey, interrupt = false): Promise<void> {
    this.stopTyping(conv);
    const ac = this.inflight.get(conv);
    if (ac) ac.abort();
    const sid = this.st.peek(conv)?.sessionID;
    if (ac && interrupt && sid) await this.oc.interrupt(sid).catch((e) => warn("interrupt:", e?.message));
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
  private async cmdHelp(conv: ConvKey): Promise<void> {
    const txt = [
      "<b>OpenCode Remote</b> — drive your OpenCode agent from Telegram.",
      "",
      "Just send me a message and I'll run it in OpenCode and reply with the result.",
      "",
      "<b>Sessions</b>",
      "/new — start a fresh session in the current directory",
      "/ls — list recent sessions",
      "/use &lt;id&gt; — switch to a session",
      "/dir [path] — show / set the working directory",
      "/browse [path] — duyệt thư mục bằng nút bấm và mở OpenCode tại đó",
      "",
        "<b>Mode &amp; model/agent</b>",
        "/mode — chọn mode bằng nút: build / plan / general / explore",
        "/models — list models · /model &lt;id&gt; — set model",
        "/variants — list/set reasoning variant (default xhigh)",
       "",
      "<b>Câu hỏi (questions)</b>",
      "Khi OpenCode cần hỏi bạn, chọn đáp án bằng nút bấm hoặc tự gõ.",
      "",
       "<b>Nhiều session (topic) &amp; Manager</b>",
       "/spawn &lt;tên&gt; [dir] — tạo worker: topic + session riêng",
       "/board — trạng thái mọi worker · /kill [tên] — dừng worker · /stopall",
       "/manager on|off — Manager nhận việc ở chat chính và giao cho worker",
       "/auto on|off — Manager tự giao việc hay chờ bạn duyệt",
       "/wt — trong topic worker: diff / merge / xoá git worktree",
       "",
       "<b>Control</b>",
        "/stop — interrupt the running task",
        "/context — photo of the current session (usage + files touched)",
        "/history — show recent messages",
       "/status — what I'm connected to",
       "/clear — reset this chat's state",
       "",
       "Bấm một nút bên dưới để chạy lệnh ngay:",
     ].join("\n");
    await this.sendHtml(conv, txt, { reply_markup: this.commandMenu() });
  }

  /** The tappable command list shown under /help — one button per command. */
  private commandMenu(): Keyboard {
    const b = (text: string, cmd: string): Btn => ({ text, callback_data: cmd });
    return {
      inline_keyboard: [
        [b("🆕 Session mới", "cmd:new"), b("📄 Sessions", "cmd:ls")],
        [b("📍 Thư mục", "cmd:dir"), b("📁 Duyệt", "cmd:browse")],
        [b("🎛 Mode", "cmd:mode"), b("🤖 Models", "cmd:models")],
        [b("🎚 Variants", "cmd:variants"), b("📊 Trạng thái", "cmd:status")],
        [b("📋 Context", "cmd:context"), b("📜 Lịch sử", "cmd:history")],
        [b("⏹ Dừng", "cmd:stop"), b("🧹 Xoá state", "cmd:clear")],
        [b("📖 Help", "cmd:help")],
      ],
    };
  }

  private async cmdNew(conv: ConvKey, state: ChatState): Promise<void> {
    await this.stopCurrent(conv, true);
    this.cancelAllReminders(conv); // abandoning the current session's pending prompts
    const dir = state.directory || this.cfg.opencodeDirectory;
    const sessionID = await this.oc.createSession(dir);
    await this.applyModelAndVariant(sessionID, state);
    if (state.agent) await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
    this.st.set(conv, { sessionID, directory: dir });
    await this.tg.sendMessage(conv, `🆕 New session <code>${sessionID}</code>\ndir: <code>${esc(dir)}</code>`);
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

  private async cmdUse(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.tg.sendMessage(conv, "Usage: /use <session-id>");
    this.st.set(conv, { sessionID: arg });
    this.cancelAllReminders(conv); // switching sessions abandons the old pending prompts
    void state;
    await this.tg.sendMessage(conv, `✅ Now using session <code>${esc(arg)}</code>`);
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
    if (await this.orch.handleCallback(cb, conv, messageId)) return;
    if (data.startsWith("cmd:")) {
      await this.runCommandButton(cb, conv, data.slice(4));
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
          await this.cmdAgents(conv);
          break;
        case "stop":
          await this.cmdStop(conv, state);
          break;
        case "status":
          await this.cmdStatus(conv, state);
          break;
        case "context":
          await this.cmdContext(conv, state);
          break;
        case "history":
          await this.cmdHistory(conv, state);
          break;
        case "clear":
          await this.cmdClear(conv, state);
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

  private async cmdModel(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.cmdModels(conv);
    const models = await this.oc.listModels();
    const m = models.find((x) => x.id === arg || `${x.providerID}/${x.id}` === arg);
    if (!m) return this.tg.sendMessage(conv, `❌ Unknown model: <code>${esc(arg)}</code>. See /models.`);
    this.st.set(conv, { model: { id: m.id, providerID: m.providerID } });
    if (state.sessionID) {
      await this.applyModelAndVariant(state.sessionID, this.st.get(conv));
      await this.tg.sendMessage(conv, `✅ Model → <code>${esc(m.id)}</code> (applied to current session)`);
    } else {
      await this.tg.sendMessage(conv, `✅ Model → <code>${esc(m.id)}</code> (applies on /new)`);
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

  private async cmdAgent(conv: ConvKey, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.cmdAgents(conv);
    const agents = await this.oc.listAgents();
    if (!agents.some((a) => a.id === arg)) return this.tg.sendMessage(conv, `❌ Unknown agent: <code>${esc(arg)}</code>. See /agents.`);
    this.st.set(conv, { agent: arg });
    if (state.sessionID) {
      await this.oc.setAgent(state.sessionID, arg).catch((e) => error("setAgent:", e?.message));
      await this.tg.sendMessage(conv, `✅ Agent → <code>${esc(arg)}</code> (applied to current session)`);
    } else {
      await this.tg.sendMessage(conv, `✅ Agent → <code>${esc(arg)}</code> (applies on /new)`);
    }
  }

  /** The current mode, derived from the session's agent (a curated label). */
  private currentMode(state: ChatState): string | undefined {
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
      text: `<b>Chọn mode</b> — ${curLabel}\n<i>bấm để đổi · mode hiện tại đánh dấu ▶️</i>`,
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

  /**
   * List or set the model's reasoning "variant" (e.g. xhigh / high / medium / low).
   * No arg → show available variants + current. With arg → set it (persisted for
   * this chat, applied to the current session if one is open).
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
    this.st.set(conv, { variant: want });
    if (state.sessionID) {
      await this.applyModelAndVariant(state.sessionID, this.st.get(conv));
      await this.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (applied to current session)`);
    } else {
      await this.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (applies on /new)`);
    }
  }

  private async cmdStop(conv: ConvKey, state: ChatState): Promise<void> {
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
        void this.sweepUnrelayedReplies(conv, "turn ended out-of-band", t === "session.execution.succeeded");
      }
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
    const messageId = await this.tg.sendMessageId(conv, v.text, { reply_markup: v.keyboard }).catch(() => -1);
    qf.messageId = messageId;
    // Start nudging if the user doesn't answer (exponential backoff; keyed by form id).
    this.startPromptReminder(conv, formID, "form", v.text, v.keyboard);
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
      let nextText = "";
      if (messageId) {
        const v = this.renderQuestion(qf);
        nextText = v.text;
        await this.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
      }
      // Keep nudging about the NEXT field of the same form (same form id).
      if (nextText) this.startPromptReminder(conv, qf.formId, "form", nextText);
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
    const messageId = await this.tg.sendMessageId(conv, lines.join("\n"), { reply_markup: kb }).catch(() => -1);
    if (messageId > 0) {
      this.permissionPrompts.set(requestID, { requestID, sessionID, conv, messageId });
      // Start nudging if unanswered — but ONLY when the card was actually sent.
      // A failed send (messageId = -1) would leave a reminder re-sending a card
      // whose buttons are no longer valid (dead buttons).
      this.startPromptReminder(conv, requestID, "permission", lines.join("\n"), kb);
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
