import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { Telegram, Update, CallbackQuery, Message, MessageGenerationStopped, MessageReactionUpdated } from "./telegram.js";
import { OpenCodeCtl, assistantText, ModelInfo } from "./opencode.js";
import { StateManager, ChatState, MsgPurpose, MACHINE_STATE_KEY, UserPrefsStore, Lang } from "./state.js";
import { ConvKey, convKey, chatOf, isBackgroundConv, parseConv } from "./conv.js";
import { answerExpired, defineCallback, dispatchCallback, oneArg, registerCallback } from "./callbacks.js";
import { Orchestrator, BUSY, apCb, killCb, wtCb, boardGroup, boardReason } from "./orchestrator.js";
import { handlePruneCallback, pruneCb } from "./orchestrator/purge.js";
import { closeFinishedTopicsAtStartup, deleteOrphanTopicsAtStartup } from "./orchestrator/topics.js";
import { ScheduleStore, Scheduler } from "./scheduler.js";
import { isUserAllowed } from "./schedule.js";
import { Config } from "./config.js";
import { esc, stripTags, chunk, trunc, mdToHtmlChunks, formatTurnFailure, isOverflowError } from "./format.js";
import { backCloseRow, confirmKeyboard, singleButton } from "./ui/keyboards.js";
import { errorLine, okLine, raw, statusLine, titledList, warnLine } from "./ui/text.js";
import { tr, STRINGS } from "./i18n.js";
import {
  extractMedia,
  buildPromptText,
  sanitizeFileName,
  downloadToFile,
  humanBytes,
  ensureUploadDir,
  type UploadMedia,
} from "./uploads.js";
import { richMarkdownChunks } from "./rich.js";
import { redactSecrets } from "./redact.js";
import { extractTrailingChoices, extractOptionsMarker, choiceCallback, choiceKeyboard, registry } from "./choices.js";
import { scheduleForRegistration, reminderBudgetExhausted, nextScheduleAfterReminder, clampTimerDelay, stalePromptIds } from "./reminders.js";
import { onPermissionAsked, onPermissionResolved, handlePermissionCallback } from "./commands/permission.js";
import {
  cmdNew,
  handleNewConfirmCallback,
  cmdList,
  cmdUse,
  handleUseCallback,
  stopTaskFor,
  cmdStop,
  cmdClear,
  cmdHistory,
} from "./commands/session.js";
import { cmdDir, cmdBrowse, handleBrowseCallback } from "./commands/browse.js";
import type { BrowseState } from "./commands/browse.js";
import { handleBusyCallback, handleContinueCallback, prepareNotesTurn } from "./commands/notes.js";
import type { PermissionPrompt } from "./commands/ctx.js";
import {
  classifyAction,
  pickAddedReaction,
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
} from "./reactions.js";
import { continuePrompt, continueButtonLabel, shouldOfferContinue, continueCallback, continueCallbackData, parseContinueData, alreadyOfferedContinue } from "./continue.js";
import { GhPrLike, PrSnapshot, PrState, diffSnapshots, renderEvent, updatePrSnapshot } from "./pr-watch.js";
import { parseProcUptime, shouldRemindAboutReboot, formatUptimeHuman, msPerDay, SAFE_REBOOT_BIN, rebootTokenFile, buildTokenLine, rebootCallback, rebootGoData, isRebootConfirmFresh } from "./uptime.js";
import { toolActivityLabel, activityDoneLine } from "./activity.js";
import { DraftState, DraftAction, onTextDelta, onToolStart, isDmConv, EDIT_BUDGET } from "./stream.js";
import { cmdCb, myCommands } from "./commands.js";
import { dropNotes, prepareNotes, NOTE_CB_PREFIX, BusyNoteStore, noteCb } from "./notes.js";
import { QueueStore } from "./queue.js";
import { buildBusyReply, busyCb, busyKeyboard, queueFullReply, parseBusyCallback } from "./busy.js";
import type { BusyReply } from "./busy.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "./fsbrowser.js";
import { log, warn, error } from "./logger.js";
import { audit } from "./audit.js";
import { advisorHealth } from "./advisor/advisor-client.js";
import { buildProbes, dirSize, diskDevice, freeSpace, smartHealth, type HealthSources } from "./health-probes.js";
import { collectHealth } from "./health.js";
import { DashboardServer, type DashboardHealth, type DashboardSpec, type DashboardState, type DashboardWorker } from "./dashboard.js";
import { CARRYOVER_KEY } from "./shared.js";
import type { Btn, Keyboard } from "./shared.js";
import { cmdAgents, cmdAgent, handleAgentCallback, agentCb } from "./commands/agents.js";
import {
  cmdModels,
  cmdModel,
  cmdMode,
  cmdVariants,
  cmdVariantSet,
  handleModelCallback,
  handleModeCallback,
  handleVariantCallback,
  applyMode,
  resolveModel as resolveModelFree,
  applyModelAndVariant as applyModelAndVariantFree,
} from "./commands/model.js";
import { cmdReboot, handleRebootCallback, cmdStatus, cmdContext, cmdUsage } from "./commands/admin.js";
import { cmdSchedule, handleScheduleCallback, schCb } from "./commands/schedule.js";
import { Advisor } from "./advisor/advisor.js";
import { cmdHelp, cmdHealth, cmdNote, cmdRotation, handleNoteCallback, cmdLang, cmdStyle } from "./commands/meta.js";
import { cmdSpec, handleSpecCallback, scanSpecs, specAutoContinue, specCb, specrunCb, specblockedCb, specrunokCb, specrerunCb, speccancelCb, spcaccCb, spcautoCb, spcredoCb, spcredocancelCb, spcstopCb, spcprCb, spcreadyCb, spccleanCb } from "./commands/spec.js";
import { trackPending as trackPendingFree, drainInflight as drainInflightFree, notifyQueuedNotRunning as notifyQueuedNotRunningFree, runPrompt as runPromptFree, runPromptTask as runPromptTaskFree, drainQueue as drainQueueFree, stopCurrent as stopCurrentFree } from "./commands/prompt-runner.js";
import {
  clampWatchInterval,
  createWatch,
  mapSessionOutcome,
  onEditFailedFlood,
  onEditSucceeded,
  onWatchEvent,
  renderWatch,
  watchHistory,
  watchInactiveReason,
  watchKeyboard,
  watchNoSession,
  watchRegistry,
  watchTickDecision,
  WATCH_IDLE_FREEZE_MS,
  WATCH_POLL_GAP_MS,
  type WatchEvent,
  type WatchState,
  watchCb,
} from "./watch.js";
import { cmdBtw } from "./btw.js";
import { cmdAsk } from "./ask.js";
import { reviewPrompt, reviewUsage } from "./review.js";
import { decide, callbackFor, parseCallback, computeFilesNew, registry as nsRegistry, nsCb } from "./nextsteps.js";
import { gitFingerprint } from "./gitstate.js";
import type { NextStepFacts } from "./nextsteps.js";
import { managerFloorFromMessages, runRotationHandoff, rotationGate } from "./rotation.js";
import {
  rotationHealthPath,
  writeRotationHealth,
  readRotationHealth,
  buildRotationSnapshot,
  appendRotationHistory,
  dayKey,
  upsertFloorTrend,
} from "./rotation-health.js";
import type { RotationHealthSnapshot } from "./rotation-health.js";

/**
 * A worker report longer than this many chars is sent as a `.md` file attachment
 * (with a short caption) instead of a wall of text. Short reports keep the
 * normal message path.
 */
const LONG_CONTENT_THRESHOLD = 1500;
/** Telegram's hard cap on a document caption, chars. */
const DOCUMENT_CAPTION_MAX = 1024;

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
const MODES: Record<string, { agent: string; hint: string; hintEn: string }> = {
  build: { agent: "build", hint: "mặc định — viết & sửa code theo permission", hintEn: "default — writes & edits code per permissions" },
  plan: { agent: "plan", hint: "chỉ phân tích & lên kế hoạch — không sửa code", hintEn: "analysis & planning only — no code edits" },
  general: { agent: "general", hint: "đa dụng: research, multi-step, chạy song song", hintEn: "general purpose: research, multi-step, parallel" },
  explore: { agent: "explore", hint: "duyệt codebase nhanh (tìm file/keyword)", hintEn: "fast codebase scan (find files/keywords)" },
};

/**
 * The `mode:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `mode:<id|info|close>` (id = a MODES key).
 */
const modeCb = oneArg("mode");

/**
 * The `mdl:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `mdl:sel:<i>` / `mdl:pg:<n>` / `mdl:noop` / `mdl:close`.
 */
const modelCb = defineCallback<{ op: string; arg?: string }>({
  prefix: "mdl",
  encode: (a) => (a.arg === undefined ? `mdl:${a.op}` : `mdl:${a.op}:${a.arg}`),
  decode: (rest) => {
    const parts = rest.split(":");
    if (parts[0] === "") return null;
    const arg = parts.slice(1).join(":");
    return { op: parts[0], arg: arg === "" ? undefined : arg };
  },
});

/**
 * The `variant:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `variant:<id|close>` (id = a model variant name).
 */
const variantCb = oneArg("variant");

/**
 * The `rot:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `rot:cf` / `rot:cx` (confirm / cancel a manager rotation).
 */
const rotCb = defineCallback<{ op: "cf" | "cx" }>({
  prefix: "rot",
  encode: (a) => `rot:${a.op}`,
  decode: (rest) => (rest === "cf" || rest === "cx" ? { op: rest } : null),
});

/**
 * The `perm:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `perm:<requestID>:<once|always|reject>`. The requestID is split
 * at the LAST colon, so an id containing ":" still round-trips (the legacy
 * split only took the first segment).
 */
const permCb = defineCallback<{ requestID: string; decision: "once" | "always" | "reject" }>({
  prefix: "perm",
  encode: (a) => `perm:${a.requestID}:${a.decision}`,
  decode: (rest) => {
    const i = rest.lastIndexOf(":");
    if (i <= 0) return null;
    const decision = rest.slice(i + 1);
    if (decision !== "once" && decision !== "always" && decision !== "reject") return null;
    return { requestID: rest.slice(0, i), decision };
  },
});

/**
 * The `nw:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `nw:<op>` (op = clear/keep/cancel — the bare /new card).
 */
const nwCb = oneArg("nw");

/**
 * The `use:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `use:<id|ls|close>` (id = an OpenCode session id).
 */
const useCb = oneArg("use");

/**
 * The `fq:` callback def (docs/sdd/callback-registry.md — T4 migration).
 * Wire form: `fq:<formId>:<op>` (op = x / c / o<i>; formId = the OpenCode
 * server-generated form id — split at the LAST colon, a strict superset of
 * the legacy first-segment parse).
 */
const formCb = defineCallback<{ formID: string; op: string }>({
  prefix: "fq",
  encode: (a) => `fq:${a.formID}:${a.op}`,
  decode: (rest) => {
    const i = rest.lastIndexOf(":");
    if (i <= 0) return null;
    return { formID: rest.slice(0, i), op: rest.slice(i + 1) };
  },
});

/**
 * The `bs:` callback def (docs/sdd/callback-registry.md — T5 migration).
 * Wire form: `bs:<op>[:<n>]` — op = nav/up/pg/hid/open/list/setdir/
 * setsess/close/noop; nav:<idx> (folder index) and pg:<n> (page) carry a
 * numeric arg, the rest are bare. Same shape as modelCb (mdl:).
 */
export const bsCallback = defineCallback<{ op: string; arg?: string }>({
  prefix: "bs",
  encode: (a) => (a.arg === undefined ? `bs:${a.op}` : `bs:${a.op}:${a.arg}`),
  decode: (rest) => {
    const parts = rest.split(":");
    if (parts[0] === "") return null;
    const arg = parts.slice(1).join(":");
    return { op: parts[0], arg: arg === "" ? undefined : arg };
  },
});

/**
 * The "ww:" callback def (docs/sdd/callback-registry.md — T6 migration).
 * Wire form: the fixed "ww:go" — the only value the Working-line watch
 * button has ever carried, so decode is strict (a foreign value is
 * malformed, not "some other op").
 */
export const wwCb = oneArg("ww");

/** True when an error is a network-level "Transport: fetch failed" blip. */
function isTransportError(e: any): boolean {
  if (!e) return false;
  if (e.reason === "Transport" || e.cause?.reason === "Transport") return true;
  const msg = `${e.cause?.message ?? ""} ${e.message ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|EPROTO|ETIMEDOUT|EAI_AGAIN|socket hang up|network .*unreachable|UND_ERR_[A-Z]+/i.test(
    msg,
  );
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
  /**
   * Chat where the card is relayed and answered (the worker's main channel,
   * `chatOf(conv)` — identical when the worker already sits in the main chat).
   */
  relayConv: ConvKey;
  messageId?: number;
  fields: QField[];
  index: number;
  answers: Record<string, any>;
  /** Set (to the field index) while waiting for the user to type a custom answer. */
  waitingCustom?: number;
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
 * One live /watch card (docs/sdd/watch.md, task W3): the pure WatchState
 * (src/watch.ts) plus the bot-side record — where the card lives, when the
 * watch started, and the fallback-poll / freeze bookkeeping.
 */
interface WatchLive {
  /** The 4-char watchRegistry key (the button callback data). */
  id: string;
  conv: ConvKey;
  sessionID: string;
  cardMsgId: number;
  /** Group conversations never edit faster than 5 s (W2.3). */
  isGroup: boolean;
  /** The pure core state (reducer/render live there). */
  state: WatchState;
  /** When the watch started, ms — the W3.5 lifetime cap runs from here. */
  createdAt: number;
  /** When the last session event arrived, ms (W2.5 gap + W3.4 idle check). */
  lastEventAt: number;
  /** W2.5: the sessionState fallback poll is active. */
  polling: boolean;
  /** The card is frozen — no more edits (W3.1/W3.4/W3.5; "Watch again" starts a new card). */
  frozen: boolean;
  /** A watch_end audit line was already written — later stops (Close, /watch
   *  again, shutdown) clean up without a second line (W6.3). */
  ended?: boolean;
  /** Serializes the async folds (the turn-start prompt fetch, the polls) per conv. */
  chain: Promise<void>;
}

/** watch_end reasons (W6.3). */
export type WatchStopReason = "done" | "idle" | "timeout" | "closed" | "replaced" | "session-changed" | "edit-failed" | "shutdown";

/**
 * Decide whether a typed message should be consumed as the answer to a question
 * form, split out so it can be unit-tested without a bot or Telegram.
 *
 * The form must be in "typed answer" mode (`waitingCustom` set). Where the
 * message lands matters:
 *  - the worker's own topic (`qf.conv`): the user is clearly talking to the
 *    worker, so the text is always consumed;
 *  - the shared main channel (`qf.relayConv`, where the card is relayed): the
 *    text is consumed ONLY when the user replied to the question card
 *    (`replyToMessageId === qf.messageId`), so a prompt meant for the manager
 *    is not hijacked as the worker's answer;
 *  - anywhere else: never.
 */
export function formAcceptsTypedAnswer(
  qf: { conv: ConvKey; relayConv: ConvKey; messageId?: number; waitingCustom?: number },
  conv: ConvKey,
  replyToMessageId?: number,
): boolean {
  if (qf.waitingCustom === undefined) return false;
  // The worker's own topic: the user is clearly talking to the worker.
  if (qf.conv === conv) return true;
  // The shared main channel: the user opted into a typed answer, so the next
  // plain message is consumed for the worker even without replying to the card
  // (trade-off: a manager prompt typed meanwhile goes to the worker — the form
  // can be dismissed with ❌ Huỷ). A missing card id (send failed) still refuses.
  if (qf.relayConv === conv) return qf.messageId !== undefined;
  return false;
}

/**
 * Glue between Telegram and OpenCode. Owns per-chat state and the in-flight
 * prompt task, so a running prompt never blocks the polling loop and /stop
 * can interrupt it.
 *
 * Members that are `public` without being API (tg/oc/st/cfg/orch/scheduleStore/
 * inflight/busyNotes/sendHtml/currentMode/startTyping/runPromptTask) exist only for
 * the handler modules in src/commands/*, which take the Bot as their first
 * argument. Don't use them elsewhere.
 */
/** Human age for the /queue list: "45s" / "2m" / "1h 3m" (spec Q3.2). */
export function formatQueueAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? h + "h " + rem + "m" : h + "h";
}

export class Bot {
  public inflight = new Map<ConvKey, AbortController>();
  /** Convs with a /btw side question running (one at a time per conv). */
  public btwRunning = new Set<ConvKey>();
  /**
   * Quick-replies auto-hide: the one still-active (untapped) choices keyboard
   * per conv — the message id that carries it + its registry id. A fresh
   * choices reply retires the previous one (retireActiveChoice); an accepted
   * tap clears it so its ✓ history is never clobbered. In-memory, like the
   * choice registry: a restart drops it and stale keyboards answer
   * "expired" exactly as before.
   */
  private activeChoice = new Map<ConvKey, { messageId: number; regId: string }>();
  public browsers = new Map<ConvKey, BrowseState>();
  public questionForms = new Map<string, QuestionFormState>();
  public permissionPrompts = new Map<string, PermissionPrompt>();
  /** Repeating "typing…" timers, one per chat, so the indicator lasts until the reply is sent. */
  private typing = new Map<ConvKey, ReturnType<typeof setInterval>>();
  /** Chats whose unrelayed-reply sweep is currently running (prevents a double relay). */
  private sweeping = new Set<ConvKey>();
  /**
   * Fire-and-forget reply work a graceful shutdown must wait for (see
   * drainInflight): the unrelayed-reply sweeps that carry a finished turn's
   * final send. Each promise deletes itself once settled.
   */
  public pendingSends = new Set<Promise<void>>();
  /** True while the shutdown drain is running: preview pushes pause so the "restarting" notice stays. */
  public draining = false;
  /**
   * Pending-prompt reminder timers, keyed by `${conv}::${promptId}` (one per
   * pending form/permission, so a conv's form and permission don't share a slot).
   * Exponential backoff — see cfg.remind*.
   */
  private reminders = new Map<string, ReturnType<typeof setTimeout>>();
  private uptimeTimer?: ReturnType<typeof setInterval>;
  private prWatchTimer?: ReturnType<typeof setInterval>;
  /** Health signals (read by /health): last good pr-watch tick, its latest error, last good uptime check. */
  private prWatchLastOkAt?: number;
  private prWatchLastError?: string;
  private uptimeLastOkAt?: number;
  private rotationTimer?: ReturnType<typeof setInterval>;
  /** True while a PR-watch tick is running, so a slow tick can't overlap the next. */
  private prWatchBusy = false;
  /** Re-entrancy guard for the 10-min rotation tick, keyed by conv (mirrors prWatchBusy). */
  private rotationTickInFlight = new Set<ConvKey>();
  /** A reboot is already armed (token minted, timer pending) — ignores a double-tap on "Xác nhận". Owned by the admin feature (commands/admin.ts). */
  public rebootArmed = false;
  /** Sessions from which we already stripped the language instruction this process (when the toggle is off), so we don't call removeInstruction every prompt. */
  public languageRemoved = new Set<string>();
  /** The self-editing "agent is doing…" line per conv: message id + current label. */
  private activity = new Map<ConvKey, { msgId: number; label: string; toolStart: number }>();
  /** The "⏳ Đang xử lý…" line per conv (General top-level only): msgId once sent + the elapsed-time timer. */
  private working = new Map<ConvKey, { msgId?: number; startedAt: number; timer?: ReturnType<typeof setInterval>; base: string; watchKb?: Record<string, unknown> }>();
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
  public drafts = new Map<
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
  public turnGen = new Map<ConvKey, number>();

  // ── /watch live card (docs/sdd/watch.md, task W3) ─────────────────────────
  /** One live watch per conversation (W1.5: at most one per conv). */
  private watches = new Map<ConvKey, WatchLive>();
  /**
   * Tool-call id → name per conv (the name arrives on `session.tool.input.started`,
   * the label is needed on `session.tool.called` — mirrors onToolEvent, W0 F1).
   */
  /** Per conv: tool id → name + running label + start time (the done line). */
  private watchToolNames = new Map<ConvKey, Map<string, { name: string; label: string; at: number }>>();
  /** 5 s ticker: the W2.5 fallback poll + the W3.4/W3.5 freeze checks. */
  private watchTimer?: ReturnType<typeof setInterval>;
  /** Re-entrancy guard for the watch ticker (a slow sessionState call can't overlap the next tick). */
  private watchTickBusy = false;

  /**
   * Retention for the "📝 Thêm vào note" busy-reply button: user messages that
   * arrived while the agent was busy, keyed by conv (capped, oldest dropped),
   * cleared when the turn ends or on /stop so a stale tap is "not found". One
   * shared instance — handed to the Orchestrator so the Manager's busy reply
   * retains into the same store and taps are handled identically.
   */
   public busyNotes = new BusyNoteStore();
  /**
   * Per-conv queue of messages that arrived while a turn was running (docs/sdd/
   * queue-and-steer.md, Q1): auto-enqueued when busy mode is "queue", or added
   * by a tap on the busy reply's Queue button; drained at turn end (phase 3).
   * Shared with the Orchestrator so the Manager's queue is the same store.
   */
  public queue = new QueueStore();
  /**
   * S3 next-step buttons (docs/sdd/next-step-buttons.md): the footer message
   * id per conv that carries the turn's next-step keyboard. N3.1 drops it on
   * tap; N3.7 drops it when the user sends their next message. In-memory.
   */
  public nextStepFooters = new Map<ConvKey, number>();
  /**
   * S3 next-step buttons (N2.3): the session modified-files set at the moment
   * "review" was last OFFERED in this conv; a path that appears in a later
   * report is "new" and can re-fire the rule. In-memory: a restart resets it.
   */
  private nextStepReviewFiles = new Map<ConvKey, Set<string>>();
  /**
   * S4 next-step buttons (workers with a worktree): when the Review row is
   * appended to the worktree card, this is the card's own keyboard
   * (Diff/Merge/Delete) the message reverts to when the next-step row is
   * removed (N3.1 tap / N3.7 dismiss), so the pre-existing buttons survive.
   * In-memory.
   */
  // Keyed by messageId, NOT conv: a tap on a stale row must restore ITS OWN message's
  // residual, not the newest row's (the conv key let a stale tap restore the wrong row).
  private nextStepResiduals = new Map<number, Keyboard>();
  /**
   * How long a report's temp `.md` file stays on disk after it is sent, before
   * it is unlinked — long enough for Telegram to finish uploading it. 60s
   * default; tests shorten it. (A per-file setTimeout, unref'd.)
   */
  public reportFileCleanupMs = 60_000;
  /** Open /model button pickers, one per conv (in-memory; dead buttons after a restart are handled). Owned by the model feature (commands/model.ts). */
  public modelPickers = new Map<ConvKey, { models: ModelInfo[]; page: number }>();
  /** The user's most recent top-level chat, for proactive notices (e.g. DNS heal). */
  private lastActiveConv?: ConvKey;
  /** Reaction UX: index keys already logged as "not indexed", so a reaction storm doesn't spam the log. */
  private missingIdxLogged = new Set<string>();
  /**
   * Upload dedupe by file_id: an edited_message (the user edited a caption)
   * re-sends the SAME file, so a hit reuses the saved path — no re-download,
   * no second "Đã lưu". In-memory, capped at 200 (oldest evicted). After a
   * restart the same file_id is re-downloaded once (harmless; the name gets a
   * -1 suffix on collision).
   */
  private uploadedFiles = new Map<string, { path: string; name: string; size?: number }>();

  /** Worker topics + the Manager agent (multi-session layer). */
  public orch: Orchestrator;
  /** Schedules, in their own file (data/schedules.json) — /clear must never touch them. */
  public scheduleStore: ScheduleStore;
  /** Per-user preferences (data/users.json) — language, etc. */
  public userPrefs: UserPrefsStore;
  /** /schedule tick engine — only constructed/started when cfg.schedule is on. */
  private scheduler?: Scheduler;
  /** Read-only web dashboard (Login with Telegram, OIDC). Off unless cfg.dashboardPort is set. */
  private dashboard?: DashboardServer;
  /** Claude advisor (topic + Claude session on the Mac) — present only when enabled. */
  public advisor?: Advisor;

  constructor(
    public tg: Telegram,
    public oc: OpenCodeCtl,
    public st: StateManager,
    public cfg: Config,
    /** The bot own numeric Telegram id (from getMe) - the OIDC client id for the dashboard. */
    public botId?: number,
  ) {
    // Same data dir as state.json (derived from cfg.stateFile); a SEPARATE file
    // on purpose so /clear and the per-chat sweeps can't wipe schedules.
    this.scheduleStore = new ScheduleStore(
      join(dirname(this.cfg.stateFile), "schedules.json"),
      this.cfg.maxSchedules,
    );
    this.userPrefs = new UserPrefsStore(join(dirname(this.cfg.stateFile), "users.json"));
    if (this.cfg.advisor) {
      this.advisor = new Advisor(
        { tg, st, cfg, userPrefs: this.userPrefs, sendHtml: (c, h) => this.sendHtml(c, h), startTyping: (c) => this.startTyping(c), stopTyping: (c) => this.stopTyping(c) },
        { url: this.cfg.advisorUrl, token: this.cfg.advisorToken },
      );
    }
    this.orch = new Orchestrator({
      tg,
      oc,
      st,
      cfg,
      bot: this,
      busyNotes: this.busyNotes,
      queue: this.queue,
      advisor: this.advisor,
      userPrefs: this.userPrefs,
      sendHtml: (conv, html, opts) => this.sendHtml(conv, html, opts),
      onSpecCheckpoint: (wc, st) => {
        void specAutoContinue(this, wc, st);
      },
      noteNextStepMessage: (conv, id, residual) => this.noteNextStepMessage(conv, id, residual),
      applyModelAndVariant: (sid, state) => this.applyModelAndVariant(sid, state),
      prepareNotes: (conv, sid) => prepareNotesTurn(this, conv, sid),
      startTyping: (conv) => this.startTyping(conv),
      startWorking: (conv, lang) => this.startWorking(conv, lang),
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
        isAllowed: (uid) => isUserAllowed(this.cfg, uid),
        notify: (conv, text) => this.tg.sendMessage(conv, text),
        langOf: (conv) => this.userPrefs.getLang(this.st.peek(chatOf(conv))?.createdBy ?? ""),
        tickMs: 30_000,
        graceMs: this.cfg.scheduleGraceMs,
      });
      this.scheduler.start();
    }
    // Close topics left open by workers that finished before auto-close existed
    // (or while the service was down). Fire-and-forget; never fails startup.
    void closeFinishedTopicsAtStartup(this.orch).catch((e) => warn("startup topic close:", e?.message));
    // One-shot maintenance hook: delete orphaned topics listed in OPENCODE_TG_DELETE_TOPICS
    // (entries still tracked in state are skipped — it can never delete a live topic).
    void deleteOrphanTopicsAtStartup(this.orch).catch((e) => warn("startup topic delete:", e?.message));
    // Register the Telegram /command autocomplete menu (cosmetic, best-effort).
    this.registerCommands();
    // Nudge the user to reboot the machine when uptime passes the threshold
    // (kernel updates only apply after a reboot). Runs once now, then every 6 hours.
    this.startUptimeMonitor();
    // Post one line per new PR event (merged / comment / CI / review) on the
    // watched GitHub repo. Default OFF; see cfg.prWatch*.
    this.startPrWatchMonitor();
    // Rotate the Manager's session to a fresh one when its context floor drifts
    // high (see src/rotation.ts). Runs every 10 min; no-op until a manager conv
    // crosses a threshold.
    this.startRotationMonitor();
    // Read-only web dashboard (Login with Telegram, OIDC). Off unless OPENCODE_TG_DASHBOARD_PORT is set.
    if (this.cfg.dashboardPort > 0) this.startDashboard();
  }

  /** Stop the /schedule tick engine (called from index.ts during shutdown). */
  stopScheduler(): void {
    this.scheduler?.stop();
  }

  /** Start the read-only web dashboard. Only called when cfg.dashboardPort is set. */
  private startDashboard(): void {
    if (!this.cfg.dashboardPublicUrl || !this.cfg.dashboardClientSecret) {
      warn("dashboard: OPENCODE_TG_DASHBOARD_PUBLIC_URL or OPENCODE_TG_DASHBOARD_CLIENT_SECRET missing - login stays broken until both are set (BotFather, Login Widget)");
    }
    this.dashboard = new DashboardServer({
      port: this.cfg.dashboardPort,
      clientId: this.cfg.dashboardClientId || this.botId || 0,
      clientSecret: this.cfg.dashboardClientSecret,
      publicUrl: this.cfg.dashboardPublicUrl,
      allowedUserIds: this.cfg.allowedUserIds,
      allowAny: this.cfg.allowAny,
      snapshot: () => this.dashboardSnapshot(),
    });
    void this.dashboard
      .listen()
      .then((port) => log("dashboard: http://127.0.0.1:" + port + " (public: " + this.cfg.dashboardPublicUrl + ")"))
      .catch((e) => warn("dashboard:", (e as Error)?.message));
  }

  /** Close the dashboard HTTP server (called from index.ts during shutdown). */
  stopDashboard(): void {
    if (this.dashboard) {
      void this.dashboard.close().catch((e) => warn("dashboard close:", (e as Error)?.message));
      this.dashboard = undefined;
    }
  }

  /** Read-only snapshot for the web dashboard: the same data /board and /spec render. */
  async dashboardSnapshot(): Promise<DashboardState> {
    const now = Date.now();
    const workers: DashboardWorker[] = [];
    for (const [key, cs] of Object.entries(this.st.all())) {
      const w = cs.worker;
      if (!w) continue;
      workers.push({
        name: w.name,
        status: w.status,
        group: boardGroup(w),
        reason: boardReason(w, "en"),
        agent: cs.agent,
        branch: w.worktree?.branch,
        directory: cs.directory,
        chat: Number(chatOf(key as ConvKey)),
        updatedAt: w.updatedAt,
        spec: w.specRun ? { spec: w.specRun.spec, task: w.specRun.task, auto: w.specRun.auto } : undefined,
        lastResult: w.lastResult?.slice(-300),
      });
    }
    workers.sort((a, b) => b.updatedAt - a.updatedAt);
    // docs/sdd of the repo this bot runs from (data/state.json sits in <root>/data).
    const sdd = join(dirname(dirname(this.cfg.stateFile)), "docs", "sdd");
    const specs: DashboardSpec[] = scanSpecs(sdd).map((e) =>
      "error" in e
        ? { name: e.name, title: e.title, done: 0, total: 0, error: e.error.message }
        : { name: e.name, title: e.title, done: e.done, total: e.total },
    );
    const lines = await collectHealth(buildProbes(this.healthSources(), () => now), now);
    const health: DashboardHealth[] = lines.map((l) => ({ id: l.id, status: l.status, detail: l.detail, lastOkAt: l.lastOkAt }));
    return { workers, specs, health, now };
  }

  /**
   * Plain facts about each background subsystem, for /health. Reads state the
   * subsystems already keep; nothing here starts work or changes anything.
   */
  healthSources(): HealthSources {
    const dns = this.tg.dnsHealStatus();
    return {
      opencode: async () => {
        const info = await this.oc.serverInfo();
        return { version: info?.version };
      },
      bridge: { enabled: this.orch.hasManager(), check: () => this.orch.bridgeHealth() },
      scheduler: { enabled: !!this.scheduler, lastTickAt: this.scheduler?.lastTickAt ?? 0, tickMs: this.scheduler?.intervalMs ?? 30_000 },
      prWatch: { enabled: this.cfg.prWatch && !!this.cfg.prWatchRepo, intervalMs: this.cfg.prWatchIntervalMs, lastOkAt: this.prWatchLastOkAt, lastError: this.prWatchLastError },
      advisor: { enabled: !!this.advisor, ping: () => advisorHealth({ url: this.cfg.advisorUrl, token: this.cfg.advisorToken }) },
      uptime: { enabled: this.cfg.uptimeMonitor, lastOkAt: this.uptimeLastOkAt },
      dnsHeal: {
        enabled: this.cfg.dnsHeal && this.cfg.dnsStaleIp !== "",
        consecutiveFailures: dns.consecutiveFailures,
        minFailures: this.cfg.dnsHealMinFailures,
        healCount: dns.healCount,
        lastPollOkAt: dns.lastPollOkAt,
      },
      disk: {
        warnFreeBytes: this.cfg.diskWarnFreeBytes,
        facts: async () => {
          const opencodeDir = join(homedir(), ".opencode");
          const dataDir = dirname(this.cfg.stateFile);
          const [opencodeBytes, dataBytes, freeBytes] = await Promise.all([
            dirSize(opencodeDir),
            dirSize(dataDir),
            freeSpace(dataDir),
          ]);
          const device = diskDevice(dataDir);
          const smart = device ? await smartHealth(device) : null;
          return { opencodeBytes, dataBytes, freeBytes, smart };
        },
      },
    };
  }

  /**
   * S2.6: a read-only probe of whether the OpenCode service is responding,
   * for the blocked-task Run flow. Best-effort: tries the cached client first,
   * and if that fails, re-discovers the service once and retries. Never throws
   * (the caller gets {ok:false, checkable:true}); a missing client (not yet
   * connected) reports checkable:false.
   */
  async specProbeService(): Promise<{ ok: boolean; checkable: boolean }> {
    try {
      await this.oc.serverInfo();
      return { ok: true, checkable: true };
    } catch {
      // The stored client may be stale (service restarted on a new port).
      // Re-discover once and retry before declaring it unreachable.
      try {
        await this.oc.reconnect();
        await this.oc.serverInfo();
        return { ok: true, checkable: true };
      } catch {
        return { ok: false, checkable: true };
      }
    }
  }

  /** Register fire-and-forget reply work so a shutdown drain waits for it. */
  private trackPending(p: Promise<void>): void {
    return trackPendingFree(this, p);
  }

  /**
   * Graceful-shutdown drain (called from index.ts between tg.stop() and
   * the OpenCode teardown): wait until no turn is in flight (an inflight runPrompt or a
   * manager turn) and no fire-and-forget reply (pendingSends — the unrelayed-
   * reply sweeps that carry a finished turn's final send) remains, or until
   * the cap elapses. The OpenCode service + event stream stay alive for the
   * duration: a manager turn's terminal event arrives over the stream, and the
   * final send itself only needs Telegram (it re-reads the stored reply).
   *
   * While waiting, every active stream preview is edited ONCE to a
   * "restarting" notice (best-effort and time-bounded — a hung Telegram call
   * can never block the exit) so no partial preview is left frozen.
   *
   * @returns true when everything settled before the cap.
   */
  drainInflight(opts: { timeoutMs: number }): Promise<boolean> {
    return drainInflightFree(this, opts);
  }

  /**
   * Q1.8 — while the shutdown drain is running, queued turns must NOT start.
   * Tell every chat that still holds queued messages that they will not run, so
   * nothing is dropped silently. Fire-and-forget: Telegram is still reachable
   * during the drain (the final sends only need Telegram), and the process exits
   * right after drainInflightCore returns.
   */
  public notifyQueuedNotRunning(): void {
    return notifyQueuedNotRunningFree(this);
  }

  /** Registry delegate — the browse handler lives in commands/browse.ts. */
  public handleBrowseCallback(cb: CallbackQuery, conv: ConvKey, answer: (t?: string) => void, messageId?: number): Promise<void> {
    return handleBrowseCallback(this, cb, conv, messageId, answer);
  }

  /** Registry delegate — the continue handler lives in commands/notes.ts. */
  public handleContinueCallback(cb: CallbackQuery, conv: ConvKey, answer: (t?: string) => void, messageId?: number): Promise<void> {
    return handleContinueCallback(this, cb, conv, messageId, answer);
  }

  /** Registry delegate — the reboot handler lives in commands/admin.ts. */
  public handleRebootCallback(cb: CallbackQuery, conv: ConvKey, answer: (t?: string) => void, messageId?: number): Promise<void> {
    return handleRebootCallback(this, cb, conv, messageId, answer);
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
    this.uptimeLastOkAt = Date.now();
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
    const lang = this.userPrefs.getLang(chat);
    const kb: Keyboard = confirmKeyboard(
      lang,
      { text: tr(lang, "🔄 Reboot máy ngay", "🔄 Reboot now"), data: rebootCallback.encode({ op: "ask" }) },
      { text: tr(lang, "🔕 Nhắc lại sau", "🔕 Remind me later"), data: rebootCallback.encode({ op: "snooze" }) },
    );
    const text =
      statusLine(lang, raw(tr(lang, `Máy đã chạy liên tục <b>${formatUptimeHuman(uptimeSec, lang)}</b>. `, `The box has been up for <b>${formatUptimeHuman(uptimeSec, lang)}</b>. `))) +
      tr(lang, `Kernel security updates chỉ áp dụng sau reboot — nên reboot định kỳ ~${this.cfg.uptimeThresholdDays} ngày. `, `Kernel security updates only apply after a reboot — reboot regularly, ~${this.cfg.uptimeThresholdDays} days. `) +
      tr(lang, "Bấm nút để reboot (xác nhận 2 bước) hoặc chọn nhắc lại sau.", "Tap a button to reboot (2-step confirm) or choose to be reminded later.");
    await this.tg.sendMessage(chat, text, { reply_markup: kb }).catch((e) => warn("uptime reminder:", e?.message ?? e));
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
      for (const p of perms ?? []) if (p?.id && !this.permissionPrompts.has(p.id)) await onPermissionAsked(this, { ...p, sessionID: s.sessionID });
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
    // I6 (B2.4): a background worker's raw assistant text is never relayed —
    // its result reaches the chat via the done card/row (I4) and the [Bot
    // event] to the Manager, so the raw-text sweep is a no-op for a bg conv.
    if (isBackgroundConv(conv)) return;
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
      if (succeeded) {
        await this.maybeOfferPlanToBuild(conv);
        // S5 (next-step buttons): a Manager turn that just ended while workers
        // are still busy gets the one-line "board" offer (engine rule board).
        await this.maybeOfferManagerBoard(conv);
      }
    } catch (e) {
      warn("sweepUnrelayedReplies:", (e as Error)?.message);
    } finally {
      this.sweeping.delete(conv);
    }
  }

  private allowed(uid?: number): boolean {
    return isUserAllowed(this.cfg, uid);
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
    // A caption-less sticker acts as its own emoji (Bot API 7.0+ `sticker.emoji`), so the
    // agent answers it as if the user typed that emoji. A caption (if any) wins over the
    // emoji; a sticker with no usable `emoji` field still falls to the noteNonText note.
    const text = (msg.text ?? msg.caption ?? msg.sticker?.emoji ?? "").trim();
    // document/photo upload (gate OPENCODE_TG_UPLOADS, default OFF): save the
    // file and append its path to the prompt. Gate OFF → media is null →
    // byte-identical to the old paths below. A caption starting with "/" is a
    // command: the file is dropped and the caption dispatches exactly like
    // today (logged).
    const media = this.cfg.uploads ? extractMedia(msg) : null;
    if (media) {
      if (text.startsWith("/")) {
        log(`Media with command caption from uid=${uid} chat=${conv} — file dropped, caption dispatched as command`);
      } else {
        await this.handleMediaMessage(conv, uid, msg, text, media);
        return;
      }
    }
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
    // N3.7 (next-step buttons): the user's next message dismisses the
    // previous turn's next-step keyboard (best effort, in-memory footer id).
    this.dismissNextStepKeyboard(conv);
    // Reaction UX: index every user message so a reaction on it can be
    // resolved (the update carries no topic info) — and give the user a quick
    // "got it" 🤔 when a real prompt (not a command) starts a turn.
    if (msg.message_id) this.indexUserMessage(conv, msg.message_id, text);
    const state = this.st.get(conv);
    // Record the conv owner (last driver) so the orchestrator can resolve the
    // language for user-facing cards, and resolve this message's lang for the
    // LLM instruction injection (per the user's /lang preference, default vi).
    if (uid != null) this.st.set(conv, { createdBy: uid });
    const lang = this.userPrefs.getLang(uid ?? "");
    if (!state.directory && !state.advisor) {
      // A topic the user opened by hand starts where the chat's main session works
      // (unless that is the Manager, whose folder is not a project).
      const top = this.st.peek(chatOf(conv));
      state.directory = top && !top.manager && top.directory ? top.directory : this.cfg.opencodeDirectory;
    }

    // S6 (S3.5): while a redo-note request is pending for this conv, the
    // user's next plain text IS the note (commands pass through; non-text
    // messages never reach this point — they return above).
    if (await this.orch.tryConsumeRedoNote(conv, text)) return;
    if (text.startsWith("/")) await this.handleCommand(conv, text, state, uid);
    else if (state.advisor && this.advisor) {
      // An advisor thread: the user's message is a follow-up question (resumes
      // the agent session). No OpenCode session is involved. A turn can take
      // minutes, and updates are handled one at a time — so it runs off the
      // update loop, tracked so a shutdown drain still waits for it. Errors were
      // already shown in the topic.
      this.trackPending(this.advisor.followUp(conv, text).then(() => {}, (e) => warn("advisor follow-up:", (e as Error)?.message)));
    }
    else {
      // (The "🤔 thinking" body-react on the user's message was removed 2026-10-27:
      // the working indicator now covers "the bot is working" on new prompts.)
      if (await this.handleFormText(conv, text, msg.reply_to_message?.message_id)) return;
      else if (state.manager) await this.orch.promptManager(conv, text, msg.message_id, lang);
      else await this.runPrompt(conv, text, state, msg.message_id, lang);
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
      // Snapshot update is pure logic (src/pr-watch.ts): open PRs are always
      // refetched; closed PRs are refetched on first sight — and again when we
      // last saw them OPEN, so a merge between ticks still diffs (#154).
      const { next, comments, reviews } = await updatePrSnapshot(prev, open, closed, Date.now(), (pr) => this.prWatchDetails(pr));
      const details = { comments, reviews };

      const firstRun = Object.keys(prev).length === 0;
      const events = firstRun ? [] : diffSnapshots(prev, next, details);
      if (!firstRun) log(`pr-watch: ${events.length} event(s) in tick`);
      const conv = this.lastActiveConv ?? (this.cfg.allowedUserIds[0] ? String(this.cfg.allowedUserIds[0]) : undefined);
      if (conv) {
        const lang = this.userPrefs.getLang(this.st.peek(chatOf(conv))?.createdBy ?? "");
        for (const ev of events) {
          try {
            await this.tg.sendMessage(conv, renderEvent(ev, repo, lang));
          } catch (sendErr) {
            // Send failed -> do NOT persist the new snapshot: the next tick
            // must re-diff and re-announce this event (#155 A3). Log, don't
            // swallow.
            warn("pr-watch: notification send failed, snapshot not saved (will retry next tick):", (sendErr as Error).message);
            this.prWatchLastError = (sendErr as Error).message;
            return;
          }
        }
      }
      this.st.set(MACHINE_STATE_KEY, { prWatchSnapshot: next });
      this.prWatchLastOkAt = Date.now();
      this.prWatchLastError = undefined;
    } catch (e) {
      warn("pr-watch tick:", (e as Error).message);
      this.prWatchLastError = (e as Error).message;
    } finally {
      this.prWatchBusy = false;
    }
  }

  /** Fresh detail for one PR: snapshot fields + the comment/review rows the diff needs. */
  private async prWatchDetails(pr: GhPrLike): Promise<{
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
  /**
   * Send content to the user. If it is long (> LONG_CONTENT_THRESHOLD chars),
   * write it to a temp `.md` file and send it as a document attachment with a
   * 2-line caption; if short, send it as a normal HTML message. If the document
   * send fails, fall back to the HTML path so a long report is never lost. The
   * temp file is unlinked after `reportFileCleanupMs` (giving Telegram time to
   * upload). Only the worker DONE relay uses this — conversational replies keep
   * the existing message path untouched. The `.md` body is an egress channel the
   * message-layer secret guard (redactSecrets in Telegram) never sees, so the
   * file is written redacted: a token leaked into a worker report must not land
   * on disk or reach Telegram in the attachment.
   */
  private async sendContentSmart(conv: ConvKey, content: string, title?: string): Promise<void> {
    if (content.length <= LONG_CONTENT_THRESHOLD) {
      await this.sendHtml(conv, content);
      return;
    }
    const file = join(tmpdir(), `report-${Date.now()}.md`);
    let sent = false;
    try {
      await writeFile(file, redactSecrets(content), "utf8");
      await this.tg.sendDocument(conv, file, this.reportCaption(content, title));
      sent = true;
    } catch (e) {
      warn(`sendContentSmart: sendDocument failed (${(e as Error)?.message ?? e}) — falling back to HTML`);
    }
    // Give Telegram time to upload before unlinking; unlink immediately if we fell back.
    const t = setTimeout(() => {
      unlink(file).catch(() => {});
    }, sent ? this.reportFileCleanupMs : 0);
    t.unref?.();
    if (!sent) await this.sendHtml(conv, content);
  }

  /**
   * Build a document caption (capped at Telegram's DOCUMENT_CAPTION_MAX): the
   * `title` if given, else the first two lines of the content, plus an
   * attachment marker. The head is HTML-escaped (it may hold code with <>&)
   * while the marker stays live HTML.
   */
  private reportCaption(content: string, title?: string): string {
    const head = esc((title ?? content.split("\n").slice(0, 2).join("\n")).trim());
    return `${head}\n📎 <i>(full report attached)</i>`.
      slice(0, DOCUMENT_CAPTION_MAX);
  }

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
  public async sendReply(conv: ConvKey, text: string): Promise<void> {
    const clean = stripTags(text ?? "");
    if (!clean) return;
    // Pattern B (deterministic, model-agnostic): if the reply ENDS with a short
    // sequentially-marked choice list, drop that list from the body and attach
    // an inline keyboard mirroring it. The keyboard rides the LAST chunk only.
    // Detection returns null when unsure → kb undefined → the reply is sent
    // exactly as before (never broken).
    // Quick replies (R3, R1.5): a model-written [OPTIONS: …] marker (only when
    // OPENCODE_TG_SUGGEST is on) takes precedence over the lettered list below.
    // Its options are never truncated (the label must equal the sent text; R1.3
    // caps each at 56). No marker / flag off → the lettered-list path, as before.
    const marker = this.cfg.suggest ? extractOptionsMarker(clean) : null;
    const ch = marker ? null : extractTrailingChoices(clean);
    const opts: string[] | undefined = marker ? marker.options : ch?.options;
    let choiceRegId: string | undefined;
    let kb: Keyboard | undefined;
    if (opts && opts.length > 0) {
      choiceRegId = registry.put(conv, this.st.peek(conv)?.sessionID, opts);
      kb = choiceKeyboard(choiceRegId, opts, marker !== null);
    }
    const body = marker ? marker.body : ch ? ch.body : clean;
    const worker = this.st.peek(conv)?.worker;
    const purpose: MsgPurpose = worker ? "worker-done" : "reply";
    // R5.2: audit the quick-replies outcome for eligible replies (flag on, not
    // a worker topic, the instruction actually applied to this session).
    // "shown" = buttons rendered; "none" = an eligible reply carried no marker
    // (model compliance can be measured as 1 − none/shown).
    if (this.cfg.suggest && !worker) {
      const s0 = this.st.peek(conv);
      if (s0?.sessionID && s0.suggestSession === s0.sessionID) {
        audit(
          marker && opts && opts.length > 0
            ? { action: "suggest_shown", chatId: conv, userId: s0.createdBy, meta: { count: opts.length } }
            : { action: "suggest_none", chatId: conv, userId: s0.createdBy },
        );
      }
    }
    // Worker DONE relay: a LONG report becomes a `.md` file attachment (the
    // main case — research, design docs, test summaries). A short report, or
    // any conversational (manager) reply, keeps the existing message path.
    if (purpose === "worker-done" && clean.length > LONG_CONTENT_THRESHOLD) {
      await this.sendContentSmart(conv, clean);
      return;
    }
    // Body language (feature C): celebrate ONLY the report of a worker that
    // has already settled to "done" (the settle races the relay; when the
    // status isn't done yet this is simply skipped — best-effort by design).
    const celebrate = worker?.status === "done";
    let lastId = -1;
    if (this.cfg.richReplies) {
      const chunks = richMarkdownChunks(body);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const last = i === chunks.length - 1;
        try {
          lastId = await this.tg.sendRich(conv, c, last && kb ? { reply_markup: kb } : {});
        } catch (e) {
          // Per-message graceful fallback: retry THIS chunk through the existing
          // HTML path (mdToHtmlChunks + sendMessage) so a rich parse/method error
          // costs only this message, never a lost reply. The keyboard (if any) rides
          // the very last HTML chunk of the very last rich chunk.
          warn(`sendRich failed (${(e as Error)?.message ?? e}) — falling back to HTML for one chunk`);
          const htmlChunks = mdToHtmlChunks(c, this.cfg.replyMaxLen);
          for (let j = 0; j < htmlChunks.length; j++) {
            const hLast = last && j === htmlChunks.length - 1;
            await this.tg.sendMessage(conv, htmlChunks[j], hLast && kb ? { reply_markup: kb } : {});
          }
          lastId = -1;
        }
        this.indexSent(conv, lastId, c, purpose);
      }
      if (kb && choiceRegId) await this.retireActiveChoice(conv, lastId, choiceRegId);
      this.celebrateWorkerDone(conv, lastId, celebrate);
      return;
    }
    const chunks = mdToHtmlChunks(body, this.cfg.replyMaxLen);
    for (let i = 0; i < chunks.length; i++) {
      lastId = await this.tg.sendMessageId(conv, chunks[i], i === chunks.length - 1 && kb ? { reply_markup: kb } : {});
      this.indexSent(conv, lastId, chunks[i], purpose);
    }
    if (kb && choiceRegId) await this.retireActiveChoice(conv, lastId, choiceRegId);
    this.celebrateWorkerDone(conv, lastId, celebrate);
  }

  /**
   * Quick-replies auto-hide: retire the conv's previous still-active choices
   * keyboard, then record the fresh one. Removing the record first means a
   * tap racing the edit answers "expired" rather than firing a stale prompt;
   * the markup edit is best-effort (a failed edit never breaks the reply).
   * Records the new keyboard only when we captured its message id (the
   * richReplies→HTML fallback path does not).
   */
  private async retireActiveChoice(conv: ConvKey, newMsgId: number, newRegId: string | undefined): Promise<void> {
    const prev = this.activeChoice.get(conv);
    if (prev) {
      registry.delete(prev.regId);
      await this.tg.editMessageReplyMarkup(conv, prev.messageId, {}).catch(() => {});
    }
    if (newRegId && Number.isInteger(newMsgId) && newMsgId > 0) {
      this.activeChoice.set(conv, { messageId: newMsgId, regId: newRegId });
    } else {
      this.activeChoice.delete(conv);
    }
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
  public bodyReact(conv: ConvKey, messageId: number | undefined, emoji: string): void {
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
   * The UPDATE itself is diffed first: only an emoji present in new_reaction
   * but absent from old_reaction acts (pickAddedReaction) — a removal or
   * reorder is ignored entirely, with no dedupe marker written. Deliberately
   * cheap up front: dedup + mark happen synchronously, before any await, so
   * concurrent/duplicated updates can't double-trigger.
   */
  private async onMessageReaction(ev: MessageReactionUpdated): Promise<void> {
    if (!this.cfg.react) return;
    const added = pickAddedReaction(ev.new_reaction, ev.old_reaction);
    if (!added) return; // removal / reorder / unmapped emoji: no add, no side effects
    const chatId = ev.chat.id;
    const messageId = ev.message_id;
    const m = this.st.peek(MACHINE_STATE_KEY) ?? {};
    if (alreadyReacted(m.reacted, chatId, messageId, added)) return; // fired once, ever
    this.markReacted(chatId, messageId, added);
    const entry = m.msgIndex?.[indexKey(chatId, messageId)];
    if (!entry) {
      const key = indexKey(chatId, messageId);
      if (!this.missingIdxLogged.has(key)) {
        this.missingIdxLogged.add(key);
        log(`reaction ${added} on unindexed message ${key} — ignoring (sent before the reaction UX, or pruned)`);
      }
      return;
    }
    const action = classifyAction(added);
    if (!action) return; // defensive: pickAddedReaction only returns mapped emojis
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
      const lang = this.userPrefs.getLang(this.st.peek(chatOf(entry.conv))?.createdBy ?? "");
      await this.tg
        .sendMessage(entry.conv, tr(lang, "👌 Tôi đã nhận rồi — không spawn worker trùng. Muốn tách worker: 🔥 vào tin của tôi.", "👌 Already got it — no duplicate worker. To split off a worker: 🔥 my message."))
        .catch(() => {});
      return;
    }
    const text = entry.text.trim();
    if (text.length < 8) return; // too short to be a task
    const chat = chatOf(entry.conv);
    if (!this.orch.isManagerConv(chat)) {
      const lang = this.userPrefs.getLang(this.st.peek(chat)?.createdBy ?? "");
      await this.tg.sendMessage(chat, warnLine(lang, raw(tr(lang, "🔥 cần Manager đang bật (/manager on) để soạn task cho worker.", "🔥 needs the Manager on (/manager on) to draft the worker task.")))).catch(() => {});
      return;
    }
    const lang2 = this.userPrefs.getLang(this.st.peek(chat)?.createdBy ?? "");
    await this.tg.sendMessage(chat, tr(lang2, "📝 Đã nhận — Manager sẽ soạn task và spawn worker trong giây lát…", "📝 Got it — the Manager will draft the task and spawn a worker in a moment…")).catch(() => {});
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
    const lang = this.userPrefs.getLang(this.st.peek(chat)?.createdBy ?? "");
    if (decision === "busy") {
      await this.tg.sendMessage(chat, statusLine(lang, raw(tr(lang, "worker vẫn đang chạy", "the worker is still running")))).catch(() => {});
      return;
    }
    if (decision === "invalid") return;
    const res = await this.orch.approveWorkerReport(workerConv);
    if (res.busy) {
      await this.tg.sendMessage(chat, statusLine(lang, raw(tr(lang, "worker vẫn đang chạy", "the worker is still running")))).catch(() => {});
      return;
    }
    if (!res.ok) {
      await this.tg.sendMessage(chat, warnLine(lang, raw(tr(lang, "Chưa dọn xong worker (worktree chưa xoá được — thử /prune sau).", "Worker not fully cleaned up (worktree couldn't be deleted — try /prune later.")))).catch(() => {});
      return;
    }
    await this.tg.sendMessage(chat, okLine(lang, raw(tr(lang, `${esc(res.name ?? "worker")} approved — dọn xong.`, `${esc(res.name ?? "worker")} approved — cleaned up.`)))).catch(() => {});
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

  /**
   * A document/photo from an allowlisted user (gate OPENCODE_TG_UPLOADS): save
   * it under data/uploads/<convSafe>/, then dispatch caption + file line (or
   * the default instruction when there is no caption). Runs BEFORE the
   * busy/in-flight check (that happens inside runPrompt/promptManager), so the
   * file is saved even when the conv is busy — the busy note then carries the
   * file line. Strangers never trigger a download (allowed() first, no reply).
   */
  private async handleMediaMessage(
    conv: ConvKey,
    uid: number | undefined,
    msg: Message,
    text: string,
    media: UploadMedia,
  ): Promise<void> {
    if (!this.allowed(uid)) {
      log(`Denied media from uid=${uid} chat=${conv}`);
      return;
    }
    const state = this.st.get(conv);
    if (state.advisor) {
      // Advisor threads are context-only (no filesystem) — keep the current decline.
      await this.noteNonText(conv, msg);
      return;
    }
    if (media.fileSize && media.fileSize > this.cfg.uploadMaxBytes) {
      await this.tg
        .sendMessage(
          conv,
          warnLine(this.userPrefs.getLang(uid ?? ""), raw(`File quá lớn: ${humanBytes(media.fileSize)} (giới hạn ${Math.round(this.cfg.uploadMaxBytes / (1024 * 1024))}MB).`)),
        )
        .catch(() => {});
      return;
    }
    // Same pre-dispatch bookkeeping as the plain-text path.
    this.lastActiveConv = chatOf(conv);
    if (!state.directory) {
      const top = this.st.peek(chatOf(conv));
      state.directory = top && !top.manager && top.directory ? top.directory : this.cfg.opencodeDirectory;
    }
    // Dedupe by file_id (edited_message re-sends the same file): hit → reuse
    // the saved path, no re-download and no second "Đã lưu".
    let saved = this.uploadedFiles.get(media.fileId);
    if (!saved) {
      const dir = ensureUploadDir(dirname(this.cfg.stateFile), conv);
      const name = sanitizeFileName(media.fileName, media.kind, Date.now(), (p) => existsSync(join(dir, p)));
      const absPath = join(dir, name);
      try {
        const { bytes } = await downloadToFile(this.tg, media, absPath, {
          maxBytes: this.cfg.uploadMaxBytes,
          timeoutMs: 30_000,
        });
        saved = { path: absPath, name, size: bytes };
        if (this.uploadedFiles.size >= 200) {
          const oldest = this.uploadedFiles.keys().next().value;
          if (oldest !== undefined) this.uploadedFiles.delete(oldest);
        }
        this.uploadedFiles.set(media.fileId, saved);
        await this.tg.sendMessage(conv, tr(this.userPrefs.getLang(uid ?? ""), `📎 Đã lưu ${esc(name)} (${humanBytes(bytes)}).`, `📎 Saved ${esc(name)} (${humanBytes(bytes)}).`)).catch(() => {});
      } catch (e) {
        warn(`upload from uid=${uid} chat=${conv} failed: ${(e as Error)?.message ?? e}`);
        await this.tg.sendMessage(conv, warnLine(this.userPrefs.getLang(uid ?? ""), raw(tr(this.userPrefs.getLang(uid ?? ""), "Không tải được file — thử lại sau.", "Couldn't download the file — try again later.")))).catch(() => {});
        return;
      }
    }
    const text2 = buildPromptText(text || undefined, { absPath: saved.path, name: saved.name, size: saved.size });
    if (msg.message_id) this.indexUserMessage(conv, msg.message_id, text2);
    // Dispatch — identical to the plain-text path (the busy check happens
    // inside, AFTER the file is already saved).
    if (uid != null) this.st.set(conv, { createdBy: uid });
    const lang = this.userPrefs.getLang(uid ?? "");
    if (await this.handleFormText(conv, text2, msg.reply_to_message?.message_id)) return;
    else if (state.manager) await this.orch.promptManager(conv, text2, msg.message_id, lang);
    else await this.runPrompt(conv, text2, state, msg.message_id, lang);
  }

  /** A media message with no text/caption — acknowledge it; the bot reads text only. */
  private async noteNonText(conv: ConvKey, msg: Message): Promise<void> {
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    const note = msg.sticker
      ? tr(lang, "🫣 Tôi chỉ đọc được văn bản — hãy gõ nội dung, hoặc gửi ảnh kèm caption.", "🫣 I can only read text — type the content, or send a photo with a caption.")
      : msg.voice
        ? tr(lang, "🎤 Tôi chưa nghe được voice — xin gửi nội dung dạng văn bản.", "🎤 I can't listen to voice yet — please send it as text.")
        : msg.photo
          ? tr(lang, "📷 Tôi chưa xem được ảnh — hãy gửi kèm caption để tôi xử lý.", "📷 I can't view images yet — please add a caption so I can process it.")
          : tr(lang, "📎 Tôi mới chỉ xử lý được tin nhắn văn bản (và caption của media).", "📎 I can only handle text messages (and media captions) for now.");
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
    const lang = this.userPrefs.getLang(this.st.peek(chatOf(conv))?.createdBy ?? "");
    void this.tg.sendMessage(conv, tr(lang, "🔧 Bot tự sửa DNS (VPN) — polling có thể gián đoạn vài giây.", "🔧 Bot self-healed DNS (VPN) — polling may be interrupted for a few seconds.")).catch(() => {});
  }

  // ── typing indicator ─────────────────────────────────────────────────────────
  /**
   * Keep "typing…" showing for as long as the turn runs. Telegram's indicator
   * expires after ~5s, so we re-arm it on a timer until the reply is sent (stopTyping).
   */
  public startTyping(conv: ConvKey): void {
    this.stopTyping(conv);
    this.tg.sendChatAction(conv, "typing");
    const t = setInterval(() => this.tg.sendChatAction(conv, "typing"), 4000);
    (t as any).unref?.();
    this.typing.set(conv, t);
  }
  /** Stop the repeating typing indicator for a chat (no-op if not running). */
  public stopTyping(conv: ConvKey): void {
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
  public startWorking(conv: ConvKey, lang?: Lang): void {
    if (!this.cfg.working || isDmConv(conv)) return; // manager turns in groups/topics; DMs show native typing fine
    if (this.working.has(conv)) return;
    log(`⏳ working indicator shown for ${conv}`);
    const startedAt = Date.now();
    const base = tr(lang ?? "vi", STRINGS.working_indicator.vi, STRINGS.working_indicator.en);
    // "👁 Watch" button: shown ONLY while /watch is active. Tapping it (ww:go)
    // opens the live watch card for this conversation (handleWorkingWatchButton
    // → startWatch). When watchActive is false no keyboard is sent at all, so
    // the Working line stays byte-identical to off-mode and the ww: branch is
    // unreachable (the button is never rendered).
    const watchKb: Record<string, unknown> | undefined = this.cfg.watchActive
      ? singleButton({ text: tr(lang ?? "vi", STRINGS.working_watch_button.vi, STRINGS.working_watch_button.en), data: "ww:go" })
      : undefined;
    this.working.set(conv, { msgId: undefined, startedAt, timer: undefined, base, watchKb }); // sync marker (race-safe)
    void this.tg
      .sendMessageId(conv, base, watchKb ? { reply_markup: watchKb } : undefined)
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
          // The 10s elapsed edit PRESERVES the Watch button (the same keyboard).
          void this.tg.editMessageText(conv, id, `${e.base} · ${secs}s`, e.watchKb ? { reply_markup: e.watchKb } : undefined).catch(() => {});
        }, 10000);
        (e.timer as any).unref?.();
      })
      .catch(() => this.working.delete(conv));
  }

  /** Remove the "⏳ Đang xử lý…" line (idempotent) — when the reply stream starts or the turn ends. */
  public stopWorking(conv: ConvKey): void {
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
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    await this.tg.editMessageText(conv, cur.msgId, activityDoneLine(cur.label, ok, secs, lang)).catch(() => {});
  }

  /** Remove the activity line when the turn ends (idempotent). */
  public clearActivity(conv: ConvKey): void {
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
      const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
      void this.showActivity(conv, toolActivityLabel(name ?? "tool", d?.input, lang));
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
    if (!w || this.draining || w.gen !== this.turnGen.get(conv) || w.previewMsgId === 0 || Date.now() < w.nextEditAt) return;
    const text = action.text || tr(this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? ""), "✍️ Đang xử lý…", "✍️ Working…");
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
  public async dropPreview(conv: ConvKey): Promise<void> {
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
  public startPromptReminder(conv: ConvKey, promptId: string, kind: "form" | "permission", text: string, keyboard?: unknown, messageId?: number, relayConv?: ConvKey): void {
    if (!this.cfg.remind) return;
    const prev = this.st.get(conv).pendingPrompts?.[promptId];
    const sched = scheduleForRegistration(prev, kind, this.cfg.remindBaseMs, Date.now());
    // The SCHEDULE stays under the owning conv (reconcile's stale-prune is
    // per-conv/per-session); `relayConv` only records where the CARD lives.
    const pp = { kind, text, keyboard, messageId: messageId ?? prev?.messageId, relayConv: relayConv ?? prev?.relayConv, ...sched };
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
  public cancelReminder(conv: ConvKey, promptId: string): void {
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
  public cancelAllReminders(conv: ConvKey): void {
    for (const id of Object.keys(this.st.get(conv).pendingPrompts ?? {})) this.cancelReminder(conv, id);
  }

  /**
   * Find which conv holds a pending prompt by its id. Needed to cancel a
   * reminder even after a restart, when the in-memory form/permission maps are
   * empty but the schedule is still persisted in state.
   */
  public findPromptConv(promptId: string): ConvKey | undefined {
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
    // The card may live in the main channel (relayConv) while the schedule is
    // persisted under the owning conv — nudge the card where it actually is.
    const target = pp.relayConv ?? conv;
    const max = this.cfg.remindMax;
    const sent = pp.remindersSent + 1;
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    // Nudge by EDITING the original card in place (⏰ count line on top) — one
    // prompt = one message, never a duplicate per nudge. Falls back to a fresh
    // message only when the original is gone (deleted by the user, too old).
    const text = tr(lang, `⏰ <i>Nhắc (${sent}/${max}): câu hỏi/quyền này vẫn đang chờ bạn trả lời — hoặc gõ /stop để bỏ.</i>`, `⏰ <i>Reminder (${sent}/${max}): this question/permission is still waiting for you — or type /stop to dismiss.</i>`) + "\n\n" + pp.text;
    const edited = pp.messageId
      ? await this.editCardInPlace(target, pp.messageId, text, pp.keyboard as Keyboard | undefined)
      : -1;
    if (edited < 0) {
      const freshId = await this.tg
        .sendMessageId(target, text, { reply_markup: pp.keyboard as Keyboard | undefined })
        .catch(() => -1);
      if (freshId > 0) {
        this.st.set(conv, {
          pendingPrompts: { ...this.st.get(conv).pendingPrompts, [promptId]: { ...pp, messageId: freshId } },
        });
        // Keep the in-memory permission entry's messageId in step with the card
        // that is actually visible, so a later "answered elsewhere" edit or the
        // budget-exhausted auto-deny lands on the right message. (Forms don't
        // store a messageId in memory, so permissions only.)
        if (pp.kind === "permission") {
          const perm = this.permissionPrompts.get(promptId);
          if (perm) this.permissionPrompts.set(promptId, { ...perm, messageId: freshId });
        }
      }
    }
    if (reminderBudgetExhausted(sent, max)) {
      // Permission ask: DENY instead of STALL. An unanswered permission on an
      // unattended worker would hang the session forever — Claude Code shipped
      // the same pattern in 2.1.319 (permissions.denyInsteadOfPrompting:
      // "replaces a stalled prompt with a denial" for unattended runs).
      // Question forms are NOT auto-answered: only a permission can be safely
      // rejected on timeout.
      if (pp.kind === "permission") {
        const perm = this.permissionPrompts.get(promptId);
        if (perm) {
          // Delete BEFORE replying: the resulting permission.replied event must
          // take onPermissionResolved's "already gone" path, not re-edit the card.
          this.permissionPrompts.delete(promptId);
          this.cancelReminder(conv, promptId); // also drops the persisted schedule
          await this.oc.replyPermission(perm.sessionID, perm.requestID, "reject").catch((e) =>
            warn(`auto-reject of permission ${promptId} failed: ${(e as Error)?.message}`),
          );
          if (perm.messageId) {
            await this.tg
              .editMessageText(
                perm.relayConv,
                perm.messageId,
                tr(lang, `⏱️ Hết ${max} lượt nhắc — bot đã TỰ TỪ CHỐI quyền này để không treo session.`, `⏱️ After ${max} reminders — the bot AUTO-DENIED this permission so the session doesn't hang.`),
              )
              .catch(() => {});
          }
          return;
        }
        // Settled while the reminder was in flight (button tap / TUI) → fall
        // through to the spent-bookkeeping below (a no-op if the entry is gone).
      }
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
        return cmdHelp(this, conv, this.userPrefs.getLang(uid ?? ""));
      case "/new":
        return cmdNew(this, conv);
      case "/ls":
      case "/sessions":
        return cmdList(this, conv);
      case "/use":
        return cmdUse(this, conv, arg, state);
      case "/dir":
        return cmdDir(this, conv, arg, state);
      case "/browse":
      case "/b":
        return cmdBrowse(this, conv, arg, state);
      case "/models":
        return cmdModels(this, conv);
      case "/model":
        return cmdModel(this, conv, arg, state);
      case "/agents":
        return cmdAgents(this, conv);
      case "/agent":
        return cmdAgent(this, conv, arg, state);
      case "/modes":
      case "/mode":
        return cmdMode(this, conv, arg, state);
      case "/variants":
        return cmdVariants(this, conv, arg, state);
      case "/variant":
        return cmdVariantSet(this, conv, arg, state);
      case "/stop":
        return cmdStop(this, conv, state);
      case "/reboot":
        return cmdReboot(this, conv);
      case "/status":
        return cmdStatus(this, conv, state);
      case "/health":
        return cmdHealth(this, conv, uid);
      case "/context":
      case "/ctx":
        return cmdContext(this, conv, state);
      case "/usage":
        return cmdUsage(this, conv, arg);
      case "/history":
        return cmdHistory(this, conv, state);
      case "/watch":
      case "/live":
        return this.cmdWatch(conv, state, uid);
      case "/rotation":
        return cmdRotation(this, conv);
      case "/clear":
        return cmdClear(this, conv, state);
      case "/queue":
        return this.cmdQueue(conv, arg);
      case "/note":
        return cmdNote(this, conv, arg);
      case "/btw":
        return cmdBtw(this, conv, state, arg);
      case "/ask":
        // An agent turn can take minutes: never hold the update loop on it
        // (cmdAsk reports its own errors).
        this.trackPending(cmdAsk(this, conv, arg));
        return;
      case "/review": {
        // The Manager's folder is not a project: a review needs a worker topic / plain session.
        const lang = this.userPrefs.getLang(uid ?? "");
        if (state.manager) return this.tg.sendMessage(conv, tr(lang, "🔍 Manager không có repo để review — dùng /review trong topic worker, hoặc /manager off.", "🔍 The Manager has no repo to review — use /review in a worker topic, or /manager off."));
        const prompt = reviewPrompt(arg, lang);
        if (prompt === null) return this.sendHtml(conv, reviewUsage(lang));
        await this.runPrompt(conv, prompt, state, undefined, lang);
        return;
      }
      case "/schedule":
        return cmdSchedule(this, conv, arg, state, uid);
      case "/lang":
        return cmdLang(this, conv, arg, uid);
      case "/style":
        return cmdStyle(this, conv, arg, uid);
      case "/spec":
        return cmdSpec(this, conv, uid);
      default:
        return this.tg.sendMessage(conv, `Unknown command: ${esc(cmd)}\nSend /help`);
    }
  }

  /**
   * `/watch` (alias `/live`) — a live card that follows the conversation's
   * session (docs/sdd/watch.md, task W2). Availability is gated by
   * cfg.watchActive (watch on AND stream off, W6.1): when inactive, reply with
   * the reason (W6.8) and post nothing; when active but with no session, say so
   * (W1.2); otherwise hand off to the W3 integration stub.
   */
  private async cmdWatch(conv: ConvKey, state: ChatState, uid?: number): Promise<void> {
    const lang = this.userPrefs.getLang(uid ?? "");
    // W6.8: only available while watchActive; otherwise explain why, post nothing.
    if (!this.cfg.watchActive) {
      await this.tg.sendMessage(conv, watchInactiveReason(lang, this.cfg.watch, this.cfg.stream));
      return;
    }
    // W1.2: no session → say so, post nothing.
    if (!state.sessionID) {
      await this.tg.sendMessage(conv, watchNoSession(lang));
      return;
    }
    return this.startWatch(conv, state, uid);
  }

  /**
   * Post the conversation's /watch card and start updating it (task W3).
   * W2 wires the command to this single point: cmdWatch gates on watchActive
   * (W6.8) and on the session existing (W1.2), so when cfg.watchActive is
   * false no watch code ever runs and off-mode is byte-identical to before.
   * The card is ONE message edited in place (editMessageTextStrict, W5.2);
   * events for the session reach it via feedWatch from onOpenCodeEvent.
   */
  private async startWatch(conv: ConvKey, state: ChatState, uid?: number): Promise<void> {
    const lang = this.userPrefs.getLang(uid ?? "");
    const sessionID = state.sessionID;
    if (!sessionID) return; // the caller (cmdWatch) already replied (W1.2)
    // W1.5: at most one watch per conversation — a second /watch closes the
    // first (its card is deleted) and starts a new one.
    this.stopWatch(conv, "replaced", { deleteCard: true });
    // W2.3: the group floor lives in the clamp (>= 5000 ms there).
    const isGroup = !isDmConv(conv);
    const intervalMs = clampWatchInterval(this.cfg.watchIntervalMs, isGroup);
    // The idle-card snapshot + the prompt line (W1.4): the same list /history reads.
    const msgs = await this.oc.listMessages(sessionID).catch(() => [] as any[]);
    const { history, prompt } = watchHistory(msgs);
    // A turn already in flight at post time (started elsewhere)? The card goes
    // straight to "working"; its start is not exposed, so elapsed runs from now.
    const { busy } = await this.oc.sessionState(sessionID).catch(() => ({ busy: false }));
    const now = Date.now();
    const s = createWatch({ sessionID, lang, now, intervalMs, history, prompt, turn: busy ? { startedAt: now } : undefined });
    const id = watchRegistry.newId();
    const status = s.phase === "working" ? "working" : "idle";
    const cardMsgId = await this.tg
      .sendMessageId(conv, renderWatch(s, lang, now), { reply_markup: watchKeyboard(id, status, lang) })
      .catch((e) => {
        warn("watch: failed to post card:", (e as Error).message ?? e);
        return -1;
      });
    if (cardMsgId <= 0) return;
    watchRegistry.put(id, { conv, sessionID, cardMsgId, createdAt: now });
    this.watches.set(conv, {
      id,
      conv,
      sessionID,
      cardMsgId,
      isGroup,
      state: s,
      createdAt: now,
      lastEventAt: now,
      polling: false,
      frozen: false,
      chain: Promise.resolve(),
    });
    this.startWatchTicker();
    audit({ action: "watch_start", chatId: conv, session: sessionID, userId: uid, meta: { intervalMs, isGroup } });
  }

  /**
   * One OpenCode session event → the conv's /watch card (task W3, W2.1-W2.5).
   * No-op when /watch is inactive (W6.1: no watch code runs when watchActive
   * is false) or the session has no watch. The event is folded into the pure
   * WatchState (src/watch.ts); any emitted edit goes out via pushWatchEdit.
   */
  private feedWatch(t: string, d: any): void {
    if (!this.cfg.watchActive) return;
    const conv = d?.sessionID ? this.st.findChatBySession(d.sessionID) : undefined;
    if (!conv) return;
    const w = this.watches.get(conv);
    if (!w || w.frozen || d.sessionID !== w.sessionID) return;
    const now = Date.now();
    w.lastEventAt = now;
    w.polling = false; // an event arrived — the W2.5 fallback poll is over

    // The tool NAME arrives on tool.input.started; the label needs it on
    // tool.called (mirrors onToolEvent — W0 finding F1).
    if (t === "session.tool.input.started") {
      const id = typeof d?.id === "string" ? d.id : undefined;
      if (id && typeof d?.name === "string" && d.name) {
        let m = this.watchToolNames.get(conv);
        if (!m) {
          m = new Map();
          this.watchToolNames.set(conv, m);
        }
        m.set(id, { name: d.name, label: "", at: now });
      }
      return;
    }

    let ev: WatchEvent | undefined;
    let wantPrompt = false;
    if (t === "session.execution.started") {
      ev = { kind: "turn-start", now };
      wantPrompt = true; // the prompt line follows the newest turn (even out-of-band ones)
    } else if (t === "session.text.delta") {
      ev = { kind: "text-delta", now, text: String(d?.delta ?? "") };
    } else if (t === "session.tool.called" || t === "session.tool.success" || t === "session.tool.failed") {
      // Same label as the activity line: the running form on called, the done
      // line (verb swap + elapsed) on success/failed — mirroring
      // onToolEvent → showActivity/finishActivity. The card's OWN language:
      // the label renders inside the card, which is one language (the watcher's).
      const id = typeof d?.id === "string" ? d.id : undefined;
      const rec = id ? this.watchToolNames.get(conv)?.get(id) : undefined;
      let label = "";
      if (t === "session.tool.called") {
        label = toolActivityLabel(rec?.name ?? "tool", d?.input, w.state.lang);
        if (id) {
          let m = this.watchToolNames.get(conv);
          if (!m) {
            m = new Map();
            this.watchToolNames.set(conv, m);
          }
          m.set(id, { name: rec?.name ?? "tool", label, at: rec?.at ?? now });
        }
      } else {
        label = rec?.label
          ? activityDoneLine(rec.label, t === "session.tool.success", (now - rec.at) / 1000, w.state.lang)
          : "";
        if (id) this.watchToolNames.get(conv)?.delete(id); // finished — drop the row
      }
      ev = { kind: "tool-step", now, label };
    } else if (t === "session.execution.succeeded") {
      ev = { kind: "turn-end", now, outcome: "done" };
    } else if (t === "session.execution.failed") {
      ev = { kind: "turn-end", now, outcome: "failed", error: d?.error?.message ?? (typeof d?.error === "string" ? d.error : undefined) };
    } else if (t === "session.execution.interrupted") {
      ev = { kind: "turn-end", now, outcome: "stopped" };
    }
    if (!ev) return;

    // Serialize the folds per conv: the async prompt fetch must not overtake
    // the events that arrive behind it.
    const apply = async (): Promise<void> => {
      let e = ev!;
      if (wantPrompt) {
        try {
          const p = watchHistory(await this.oc.listMessages(d.sessionID).catch(() => [] as any[])).prompt;
          if (p && e.kind === "turn-start") e = { ...e, prompt: p }; // only turn-start carries a prompt
        } catch {
          // the fetch failed — keep the previous prompt
        }
      }
      const r = onWatchEvent(w.state, e);
      w.state = r.state;
      if (!r.edit) return;
      if (r.edit.reason === "final") {
        // W3.1: ONE final edit (outcome + duration, never the answer), then
        // freeze. The watch is over regardless of whether the edit lands — a
        // vanished card is already stopped as "edit-failed" inside
        // pushWatchEdit, and the record check below then stays false.
        w.frozen = true;
        w.polling = false;
      }
      await this.pushWatchEdit(w, r.edit);
      if (r.edit.reason === "final" && this.watches.get(conv) === w) this.auditWatchEnd(w, "done");
    };
    w.chain = w.chain.then(apply).catch((e) => warn("watch event:", (e as Error).message ?? e));
  }

  /**
   * Edit the card in place. editMessageTextStrict (W5.2) surfaces a vanished
   * card instead of hiding it as a no-op; flood control takes the core's
   * backoff (W2.4, as the streaming preview does); a gone card stops the
   * watch quietly. Returns false when the edit did not go out.
   */
  private async pushWatchEdit(w: WatchLive, edit: { text: string; reason: "update" | "final" }): Promise<boolean> {
    // The frozen row (Close + Watch again) is on the final edit and every
    // freeze; a live working card carries the Stop task row (W4.2, wired in W4).
    const status = w.frozen || edit.reason === "final" ? "frozen" : w.state.phase === "working" ? "working" : "idle";
    try {
      await this.tg.editMessageTextStrict(w.conv, w.cardMsgId, edit.text, { reply_markup: watchKeyboard(w.id, status, w.state.lang) });
      w.state = onEditSucceeded(w.state, edit.text, Date.now());
      return true;
    } catch (e: any) {
      if (e?.code === 429 || e?.retryAfter != null) {
        w.state = onEditFailedFlood(w.state, Number(e?.retryAfter ?? 1), Date.now());
        return false;
      }
      if (/message is not modified/i.test(String(e?.message))) return true; // card is there and matches
      if (e?.code === 404 || /message to edit not found/i.test(String(e?.message))) {
        this.stopWatch(w.conv, "edit-failed"); // W5.2: stop quietly
        return false;
      }
      warn(`watch edit failed (${w.conv}):`, e?.message ?? e);
      return false;
    }
  }

  /**
   * Freeze the card the same way the turn end does (W3.4/W3.5): stop updating
   * and swap the row to the frozen one (Close + Watch again, W3.3). The record
   * stays (frozen) so the buttons keep working; the card's text is re-rendered
   * as-is (the edit carries the new row).
   */
  private async freezeWatch(w: WatchLive, reason: "idle" | "timeout"): Promise<void> {
    if (w.frozen || this.watches.get(w.conv) !== w) return;
    w.frozen = true;
    w.polling = false;
    const now = Date.now();
    await this.pushWatchEdit(w, { text: renderWatch(w.state, w.state.lang, now), reason: "final" });
    // The watch is over regardless of the edit's fate (a vanished card is
    // already stopped as "edit-failed" inside pushWatchEdit, so the record
    // check below stays false there).
    if (this.watches.get(w.conv) === w) this.auditWatchEnd(w, reason);
  }

  /**
   * Stop the conv's watch (W5.1): drop the record + registry entry (+ the card
   * when asked) and write the watch_end audit line (W6.3). Safe to call when
   * there is no watch (off-mode, or an already-stopped one).
   */
  public stopWatch(conv: ConvKey, reason: WatchStopReason, opts?: { deleteCard?: boolean }): void {
    const w = this.watches.get(conv);
    if (!w) return;
    this.watches.delete(conv);
    this.watchToolNames.delete(conv);
    watchRegistry.delete(w.id);
    if (opts?.deleteCard) void this.tg.deleteMessage(conv, w.cardMsgId).catch(() => {});
    // A frozen watch already wrote its watch_end (done/idle/timeout) — the
    // later Close / second /watch / shutdown is cleanup only (W6.3).
    if (!w.ended) this.auditWatchEnd(w, reason);
  }

  /** One watch_end audit line (W6.3). */
  private auditWatchEnd(w: WatchLive, reason: WatchStopReason): void {
    audit({ action: "watch_end", chatId: w.conv, session: w.state.sessionID, meta: { reason, durationMs: Date.now() - w.createdAt } });
    w.ended = true;
  }

  /**
   * W5.1: stop every watch on bot shutdown. Telegram is already stopped by the
   * time drainInflight runs, so this is in-memory cleanup + audit only — the
   * cards stay where they are; after a restart their buttons answer "expired"
   * (the registry is in-memory, W4.4).
   */
  stopAllWatches(): void {
    for (const conv of [...this.watches.keys()]) this.stopWatch(conv, "shutdown");
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  /** The 5 s watch ticker — lazy: started only while /watch is active. */
  private startWatchTicker(): void {
    if (this.watchTimer || !this.cfg.watchActive) return;
    this.watchTimer = setInterval(() => {
      void this.watchTick().catch((e) => warn("watch tick:", (e as Error).message ?? e));
    }, 5_000);
    this.watchTimer.unref?.();
  }

  /**
   * One 5 s tick (task W3):
   *   - W3.5: a watch older than cfg.watchMaxMin freezes (reason "timeout").
   *   - W3.4: an idle card with 60 s of inactivity freezes (reason "idle").
   *   - W2.5: while a turn is running and no event arrived for 10 s, read
   *     sessionState every tick until events resume — the ephemeral text
   *     deltas lost in a stream reconnect are the gap this covers (W0 F1).
   */
  private async watchTick(): Promise<void> {
    if (this.watchTickBusy) return;
    this.watchTickBusy = true;
    try {
      const now = Date.now();
      for (const w of [...this.watches.values()]) {
        if (w.frozen || this.watches.get(w.conv) !== w) continue;
        // W3.5 (timeout) > W3.4 (idle) > W2.5 (poll) — the order is the core's.
        const action = watchTickDecision({
          phase: w.state.phase,
          createdAt: w.createdAt,
          lastEventAt: w.lastEventAt,
          now,
          maxMs: this.cfg.watchMaxMin * 60_000,
          idleMs: WATCH_IDLE_FREEZE_MS,
          pollGapMs: WATCH_POLL_GAP_MS,
          polling: w.polling,
        });
        if (action === "timeout") {
          await this.freezeWatch(w, "timeout");
          continue;
        }
        if (action === "idle") {
          // W3.4: nothing for 60 s while idle → freeze the card the same way.
          await this.freezeWatch(w, "idle");
          continue;
        }
        if (action === "none") continue;
        w.polling = true; // W2.5: the fallback poll (armed after a 10 s gap)
        let busy = true;
        let outcome: string | undefined;
        try {
          ({ busy, outcome } = await this.oc.sessionState(w.sessionID));
        } catch {
          busy = true; // a failed read is not evidence of an end
        }
        w.lastEventAt = now; // we just checked in — the gap restarts
        if (!busy) {
          // The turn ended without a visible terminal event.
          const r = onWatchEvent(w.state, { kind: "turn-end", now, outcome: mapSessionOutcome(outcome) });
          w.state = r.state;
          w.polling = false;
          w.frozen = true; // turn-end froze the state (or it already was)
          if (r.edit) await this.pushWatchEdit(w, r.edit);
          if (this.watches.get(w.conv) === w) this.auditWatchEnd(w, "done");
          continue;
        }
        // Still busy: an elapsed-time tick (the header advances) — reusing the
        // core's throttle + change detection via an empty text delta.
        if (w.state.phase !== "working") {
          // We missed the execution.started (stream gap) — recover the turn.
          const r = onWatchEvent(w.state, { kind: "turn-start", now });
          w.state = r.state;
          if (r.edit) await this.pushWatchEdit(w, r.edit);
        } else {
          const r = onWatchEvent(w.state, { kind: "text-delta", now, text: "" });
          w.state = r.state;
          if (r.edit) await this.pushWatchEdit(w, r.edit);
        }
      }
    } finally {
      this.watchTickBusy = false;
    }
  }

  /**
   * The "👁 Watch" button (ww:go) on the "⏳ Working…" line: open the live
   * watch card for this conversation. No agent turn. Mirrors cmdWatch's gating
   * exactly — answer "inactive" when watchActive is false, "no session" when
   * there's no current session, otherwise hand off to startWatch (which is
   * safe against double-invocation: it closes any prior watch card first).
   */
  public async handleWorkingWatchButton(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void = (toast) => { void this.tg.answerCallbackQuery(cb.id, toast).catch(() => {}); }): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    // Same gate as /watch (cmdWatch): only available while watchActive.
    if (!this.cfg.watchActive) {
      await answer(tr(lang, STRINGS.working_watch_inactive.vi, STRINGS.working_watch_inactive.en));
      return;
    }
    // No current session → say so (same wording style as cmdWatch's watchNoSession).
    const state = this.st.peek(conv);
    if (!state?.sessionID) {
      await answer(tr(lang, STRINGS.working_watch_no_session.vi, STRINGS.working_watch_no_session.en));
      return;
    }
    await answer();
    await this.startWatch(conv, state, cb.from?.id);
  }

  /**
   * The /watch card buttons: `w:<id>:c` Close, `w:<id>:r` Watch again,
   * `w:<id>:s` Stop task (task W4 — the row is already rendered by
   * watchKeyboard; the handler is a TODO stub so W4 fills it without rework).
   * W4.3: the tap is bound to the session the card was created for — a tap on
   * a card whose conversation has moved to another session is refused, and an
   * unknown id (a restart dropped the registry) answers "expired" (W4.4).
   */
  public async handleWatchCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void = (toast) => { void this.tg.answerCallbackQuery(cb.id, toast).catch(() => {}); }): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    const [, id, action] = (cb.data ?? "").split(":");
    const rec = watchRegistry.get(id);
    if (!rec || rec.conv !== conv) {
      await answer(tr(lang, "Hết hiệu lực.", "Expired."));
      return;
    }
    const cur = this.st.peek(conv)?.sessionID;
    if (cur && cur !== rec.sessionID) {
      // W4.3: the conversation moved to another session — refuse, do nothing.
      await answer(tr(lang, "Phiên đã đổi — bấm này hết hiệu lực.", "The conversation moved to another session — this tap is refused."));
      return;
    }
    if (action === "c") {
      // Close (W4.1): stop updating and delete the card; the agent is untouched.
      this.stopWatch(conv, "closed", { deleteCard: true });
      await answer();
      return;
    }
    if (action === "r") {
      // Watch again (W3.3): behaves as a new /watch on the current session.
      const state = this.st.get(conv);
      if (!state.sessionID) {
        await answer(tr(lang, "Chưa có phiên hiện tại.", "No current session."));
        return;
      }
      await answer();
      await this.startWatch(conv, state, cb.from?.id);
      return;
    }
    if (action === "s") {
      // Stop task (W4.2): does exactly what /stop does (stopTaskFor), then the
      // card shows "Stopped" and freezes. The row is rendered only while a
      // turn is running (watchKeyboard's "working" status); a tap that lands
      // after the turn is over — e.g. the double-tap race, where the first
      // tapper already stopped it (spec §4) — finds nothing to stop:
      // "not running", no state change.
      const w = this.watches.get(conv);
      if (!w || w.frozen || w.state.phase !== "working") {
        await answer(tr(lang, "Không có tác vụ nào đang chạy.", "Nothing is running."));
        return;
      }
      // Claim the stop synchronously, BEFORE any await: the state is already
      // "stopped" when the first await yields, so a second tap (serialized
      // behind this one on the conv queue) sees the card frozen and answers
      // "not running", and the server's execution.interrupted event (folded by
      // feedWatch) finds the state frozen — no double final edit, no double
      // audit. The end is audited as watch_stop_task (W6.3); the record stays
      // for Close / Watch again, which write the watch_end reason later.
      const now = Date.now();
      const r = onWatchEvent(w.state, { kind: "turn-end", now, outcome: "stopped" });
      w.state = r.state;
      w.frozen = true;
      w.polling = false;
      await answer();
      await stopTaskFor(this, conv, rec.sessionID);
      audit({ action: "watch_stop_task", chatId: conv, session: rec.sessionID, userId: cb.from?.id });
      if (r.edit) await this.pushWatchEdit(w, r.edit); // the ONE final "Stopped" edit (W4.2)
      return;
    }
    await answer();
  }

  // ── the long-running prompt ──────────────────────────────────────────────
  public runPrompt(conv: ConvKey, text: string, state: ChatState, userMsgId?: number, lang?: Lang): Promise<{ busy: boolean }> {
    return runPromptFree(this, conv, text, state, userMsgId, lang);
  }

  public runPromptTask(conv: ConvKey, sid: string, text: string, ac: AbortController, userMsgId?: number, lang?: Lang): Promise<void> {
    return runPromptTaskFree(this, conv, sid, text, ac, userMsgId, lang);
  }

  /**
   * Run the head of a conv's queue as a normal prompt — one item per call, only
   * when not draining (Q1.8). Race-safe: it goes through runPrompt's `inflight`
   * guard, so a user message that raced in and won the turn makes runPrompt
   * report `busy`, and the item is put back (Q1.11). One item per turn-end, and
   * the queue is finite + capped at 3, so this can never infinite-loop.
   */
  public drainQueue(conv: ConvKey): void {
    return drainQueueFree(this, conv);
  }

  /**
   * After a successful turn that ENDED in plan mode, offer the one-tap
   * plan-to-build handoff: switch to the build agent and execute the plan that
   * is already in the session context. Offered on every successful plan turn
   * (not just once), and skipped while the agent is mid-question.
   */
  public async maybeOfferPlanToBuild(conv: ConvKey): Promise<void> {
    const st = this.st.get(conv);
    if (st.agent !== "plan") return;
    if ([...this.questionForms.values()].some((q) => q.conv === conv)) return;
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    const kb: Keyboard = singleButton({ text: tr(lang, "🔨 Sang build & thực thi", "🔨 Switch to build & execute"), data: pbCallback.encode({ op: "go" }) });
    await this.tg
      .sendMessage(conv, tr(lang, "📐 <b>Kế hoạch đã sẵn sàng</b> — bấm để chuyển sang build và thực thi.", "📐 <b>Plan is ready</b> — tap to switch to build and execute."), { reply_markup: kb })
      .catch(() => {});
  }

  /**
   * Working-tree fingerprint to take before a plain build-agent turn, for the
   * next-step Review rule (computeFilesNew). Undefined when the feature is off,
   * the conv is not a plain session on the build agent, the folder is not a git
   * repo, or git is slow (capped at 1.5 s so it can never hold up the prompt).
   */
  public async nextStepSnapshot(conv: ConvKey): Promise<string | undefined> {
    if (!this.cfg.nextSteps) return undefined;
    const state = this.st.peek(conv);
    if (!state || state.worker || state.manager || state.advisor) return undefined;
    if ((state.agent ?? "build") !== "build") return undefined;
    const cap = new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 1500).unref?.());
    return Promise.race([gitFingerprint(state.directory || this.cfg.opencodeDirectory), cap]);
  }

  /**
   * S3 — rule-based next-step buttons for PLAIN sessions (docs/sdd/
   * next-step-buttons.md). Builds the facts the bot already holds, runs the
   * engine, and returns the footer keyboard — or undefined when nothing
   * applies (N1.2: nothing at all when no rule fires). Only the "review"
   * rule is rendered in S3 (workers S4, manager/failures S5). The
   * getSessionReport call (N2.3 filesNew) happens only after the cheap gates
   * pass, never on every turn.
   */
  public async buildNextStepKeyboard(
    conv: ConvKey,
    sessionID: string,
    info: {
      outcome: "succeeded" | "failed" | "interrupted";
      interrupted: boolean;
      reply?: string;
      elapsedMs: number;
      error?: { type?: string; message?: string };
      lang: Lang;
      /** Working-tree fingerprint taken before the turn (see nextStepSnapshot). */
      fpBefore?: string;
    },
  ): Promise<Keyboard | undefined> {
    // N4.1: off → identical to today (no decide, no getSessionReport call).
    if (!this.cfg.nextSteps) return undefined;
    const state = this.st.peek(conv);
    // S3 scope: plain conversations only (worker/manager/advisor land in S4/S5).
    if (!state || state.worker || state.manager || state.advisor) return undefined;
    // N1.5: never under a result a queued message is about to supersede.
    if (this.queue.size(conv) > 0) return undefined;
    // Effective agent: an explicit /mode|/agent choice, else the OpenCode
    // service default, which is "build" (verified live: the agent list labels
    // Build "The default agent") — a fresh plain conv therefore runs on build.
    const agent = state.agent ?? "build";
    const now = Date.now();
    // Cheap gates (N2, plain "review" row) before the one getSessionReport call.
    const reviewGate =
      info.outcome === "succeeded" &&
      !info.interrupted &&
      agent === "build" &&
      info.elapsedMs >= this.cfg.nextMinSecs * 1000;
    let filesNew = false;
    let reportFiles: string[] = [];
    if (reviewGate) {
      // N2.3 (amended): did the turn change the working tree? Compare the git
      // fingerprints from before and after; this sees files made through the
      // shell, which the session report misses. Only when a fingerprint is
      // missing (not a git repo, git failed) fall back to the report, and then
      // only a file it lists that was not offered before counts.
      const fpAfter = info.fpBefore !== undefined ? await gitFingerprint(state.directory || this.cfg.opencodeDirectory) : undefined;
      if (info.fpBefore === undefined || fpAfter === undefined) {
        try {
          reportFiles = (await this.oc.getSessionReport(sessionID)).modifiedFiles;
        } catch {
          reportFiles = []; // report unavailable → no new files (never block the turn end)
        }
      }
      filesNew = computeFilesNew({ before: info.fpBefore, after: fpAfter, reportFiles, seen: this.nextStepReviewFiles.get(conv) });
    }
    const facts: NextStepFacts = {
      kind: "plain",
      outcome: info.outcome,
      interrupted: info.interrupted,
      agent,
      elapsedMs: info.elapsedMs,
      busyWorkers: 0, // S3: no worker accounting yet (the "board" rule is S5)
      filesNew,
      // Same error-string shape classifyFailure uses in formatTurnFailure.
      overflow: isOverflowError(`${info.error?.type ?? ""}\n${info.error?.message ?? ""}`),
      // N1.3: the reply ends in a choice list → sendReply already attached a ch: keyboard.
      hasChoices: info.reply ? extractTrailingChoices(stripTags(info.reply)) !== null : false,
      // N1.3: a plan turn ends with the "Switch to build" card (same gates as
      // maybeOfferPlanToBuild, which sends it right after this footer).
      hasOtherKeyboard:
        agent === "plan" &&
        !info.interrupted &&
        !!info.reply &&
        ![...this.questionForms.values()].some((q) => q.conv === conv),
    };
    const suggestions = decide(facts, { nextSteps: this.cfg.nextSteps, minSecs: this.cfg.nextMinSecs }, now);
    if (suggestions.length === 0) return undefined;
    const row: Btn[] = [];
    for (const s of suggestions) {
      if (s.rule !== "review") continue; // S4/S5 rules are not rendered yet
      const id = nsRegistry.set({ conv, sessionID, rule: s.rule, now });
      row.push({ text: s.label(info.lang), callback_data: callbackFor(id, row.length) });
      // N4.3: every shown button is in the audit log with its rule id, so tap
      // rates can be measured (scripts/nextstep-tap-rate.ts).
      audit({ action: "nextstep_shown", chatId: conv, session: sessionID, userId: state.createdBy, meta: { rule: s.rule } });
    }
    if (row.length === 0) return undefined;
    // N2.3: this offer now defines the "last-offered" file set for the conv.
    if (reviewGate) this.nextStepReviewFiles.set(conv, new Set(reportFiles));
    return { inline_keyboard: [row] };
  }

  /**
   * S5 (next-step buttons, failures): the next-step keyboard for a GENUINE
   * failure message — today only the "new-keep" rule can fire (a context
   * overflow). N1.4/N1.5 are structural here: this path only runs for
   * user-driven turns (runPromptTask), never advisor or scheduled runs
   * (scheduled runs are WORKER runs that never go through runPromptTask),
   * and a queued message still pending suppresses the offer (N1.5).
   *
   * The Continue button is NOT passed as hasOtherKeyboard: N2 wants new-keep
   * on every overflow failure, and a genuine failure ALWAYS also earns
   * Continue — treating it as a blocking keyboard would make the rule dead
   * code. The two rows ride the same failure message.
   */
  public async buildNextStepFailureKeyboard(
    conv: ConvKey,
    sessionID: string,
    info: { outcome: "failed"; interrupted: boolean; elapsedMs: number; error?: { type?: string; message?: string }; lang: Lang },
  ): Promise<Keyboard | undefined> {
    // N4.1: off → identical to today (no decide call).
    if (!this.cfg.nextSteps) return undefined;
    const state = this.st.peek(conv);
    // Manager and advisor turns never run through runPromptTask; guard anyway.
    if (!state || state.manager || state.advisor) return undefined;
    // N1.5: never under a result a queued message is about to supersede.
    if (this.queue.size(conv) > 0) return undefined;
    const now = Date.now();
    const facts: NextStepFacts = {
      kind: state.worker ? "worker" : "plain",
      outcome: info.outcome,
      interrupted: info.interrupted,
      agent: state.agent ?? "build",
      elapsedMs: info.elapsedMs,
      busyWorkers: 0,
      filesNew: false,
      // Same error-string shape classifyFailure uses in formatTurnFailure.
      overflow: isOverflowError(`${info.error?.type ?? ""}\n${info.error?.message ?? ""}`),
      hasChoices: false, // the failure message is fixed text (formatTurnFailure)
      hasOtherKeyboard: false, // see the method doc: Continue does not suppress new-keep
    };
    const suggestions = decide(facts, { nextSteps: this.cfg.nextSteps, minSecs: this.cfg.nextMinSecs }, now);
    const row: Btn[] = [];
    for (const s of suggestions) {
      if (s.rule !== "new-keep") continue;
      const id = nsRegistry.set({ conv, sessionID, rule: s.rule, now });
      row.push({ text: s.label(info.lang), callback_data: callbackFor(id, row.length) });
      // N4.3: same shown event for the failure-path button.
      audit({ action: "nextstep_shown", chatId: conv, session: sessionID, userId: state.createdBy, meta: { rule: s.rule } });
    }
    if (row.length === 0) return undefined;
    return { inline_keyboard: [row] };
  }

  /**
   * S5 (next-step buttons, manager): after a Manager turn ended, one short
   * line with a "📋 Board" button when at least one of the chat's workers is
   * still running or waiting (engine rule board; "Board only when workers are
   * still busy"). N1.4 is structural: scheduled runs are WORKER runs
   * (spawnedBy:"schedule"), never Manager turns, and advisor threads never
   * run here (manager convs only). N1.5: a queued message about to start the
   * next manager turn suppresses the offer.
   */
  private async maybeOfferManagerBoard(conv: ConvKey): Promise<void> {
    // N4.1: off → identical to today (no decide call).
    if (!this.cfg.nextSteps) return;
    const st = this.st.peek(conv);
    if (!st?.manager || st.worker || st.advisor) return;
    // N1.5: never under a result a queued message is about to supersede.
    if (this.queue.size(conv) > 0) return;
    const busyWorkers = this.orch.workersOf(chatOf(conv)).filter(([, ws]) => BUSY.includes(ws.worker!.status)).length;
    if (busyWorkers === 0 || !st.sessionID) return;
    const lang = this.userPrefs.getLang(st.createdBy ?? "");
    const now = Date.now();
    const facts: NextStepFacts = {
      kind: "manager",
      outcome: "succeeded",
      interrupted: false,
      agent: st.agent ?? "manager",
      elapsedMs: 0, // no minimum-length gate for the board rule
      busyWorkers,
      filesNew: false,
      overflow: false,
      hasChoices: false,
      hasOtherKeyboard: false,
    };
    const suggestion = decide(facts, { nextSteps: this.cfg.nextSteps, minSecs: this.cfg.nextMinSecs }, now).find((x) => x.rule === "board");
    if (!suggestion) return;
    // Per-worker topic-jump buttons (switch_to_topic): one row per BUSY worker
    // that has an intro message to jump to. Workers spawned before the intro
    // anchor existed are skipped; if none is anchored, send nothing at all.
    const anchored = this.orch
      .workersOf(chatOf(conv))
      // B3.3: a background worker has no topic to jump to — never a jump row.
      .filter(([k, ws]) => !isBackgroundConv(k) && BUSY.includes(ws.worker!.status) && (ws.worker!.introMessageId ?? 0) > 0)
      .slice(0, this.cfg.maxWorkers)
      .map(([, ws]) => ws.worker!);
    if (anchored.length === 0) return;
    const rows: Btn[][] = anchored.map((w) => {
      const statusWord = w.status === "waiting" ? tr(lang, "chờ duyệt", "waiting") : tr(lang, "đang chạy", "running");
      return [{ text: `📋 ${w.name} · ${statusWord}`, switch_to_topic: { message_id: w.introMessageId! } }];
    });
    // N4.3: shown event for the board line. No nsRegistry entry: the buttons
    // carry switch_to_topic (no callback_data), so there is nothing to consume
    // on tap.
    audit({ action: "nextstep_shown", chatId: conv, session: st.sessionID, userId: st.createdBy, meta: { rule: "board", workers: anchored.length } });
    const lineId = await this.tg
      .sendMessageId(conv, tr(lang, `⚡ ${anchored.length} worker đang chạy:`, `⚡ ${anchored.length} worker(s) running:`), { reply_markup: { inline_keyboard: rows } })
      .catch(() => -1);
    // N3.7: the line reverts to no buttons when the user speaks again.
    if (lineId > 0) this.noteNextStepMessage(conv, lineId);
  }

  /**
   * Decide whether to offer the "⏯ Chạy tiếp" button for a turn that just ended
   * in this conv, and if so record the anti-spam marker and return its keyboard.
   * Returns undefined (no button) when it is not a genuine failure, when we have
   * already offered one for this same turn, or when the callback data would
   * exceed Telegram's limit. Pure decision + encoding live in src/continue.ts.
   */
  public offerContinueKeyboard(
    conv: ConvKey,
    sessionID: string,
    turnId: string,
    outcome: string | undefined,
    interrupted: boolean,
    lang: Lang = "vi",
  ): Keyboard | undefined {
    if (!shouldOfferContinue({ outcome, interrupted })) return undefined;
    const data = continueCallbackData(sessionID);
    if (!data) return undefined; // too long to ship — omit the button
    if (alreadyOfferedContinue(this.st.peek(conv)?.continueOfferedTurn, turnId)) return undefined;
    this.st.set(conv, { continueOfferedTurn: turnId });
    return singleButton({ text: continueButtonLabel(lang), data });
  }

  /**
   * Stop waiting on the conversation's running turn. With `interrupt`, also
   * interrupt that turn on the server — otherwise switching away (/new, /clear,
   * opening another session) left the old session running and spending tokens.
   */
  public stopCurrent(conv: ConvKey, interrupt = false): Promise<void> {
    return stopCurrentFree(this, conv, interrupt);
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

  // Shared model primitives (bodies in commands/model.ts) — kept on Bot as
  // thin delegates until their last caller (prompt-runner, T6) moves, so
  // session/rotation/browse/prompt-runner can call them through BotCtx.
  public resolveModel(state: ChatState, sessionID?: string) {
    return resolveModelFree(this, state, sessionID);
  }
  public applyModelAndVariant(sessionID: string, state: ChatState) {
    return applyModelAndVariantFree(this, sessionID, state);
  }

  // ── commands ─────────────────────────────────────────────────────────────
  // The autocomplete menu, the /help card, and the button grid are all
  // rendered from the shared catalog (src/commands.ts) so they cannot drift
  // apart (drift cost us two follow-up fixes: /agents, /reboot).

  /**
   * Register the Telegram /command menu (autocomplete) — cosmetic, best-effort.
   * The menu is bot-global (no per-user variant), so it renders in the first
   * explicitly-set user language; /lang re-registers it on change.
   */
  private registerCommands(): void {
    const lang = this.userPrefs.anyExplicitLang() ?? "vi";
    void this.tg.setMyCommands(myCommands(lang)).catch((e) => warn("setMyCommands:", e?.message));
  }

  /**
   * M1 — the manager session's FLOOR: the MIN sent-context (input + cache.read)
   * across its assistant messages from the last 24h. 0 when there are none (a
   * fresh session). Drives the auto-rotation trigger and the /status floor line.
   * Never throws — a read failure reports null (the caller decides: the
   * rotation tick skips the gate and writes a "not measured" snapshot; display
   * paths coalesce to 0).
   *
   * NOTE: the service caps `limit` at 200 — 700 was rejected by the schema and
   * silently produced floor=0 on every tick (root-caused 2026-11-01).
   */
  async managerFloor(sessionID: string, now = Date.now()): Promise<number | null> {
    let msgs: any[];
    try {
      msgs = await this.oc.listMessages(sessionID, 200);
    } catch (e) {
      warn("managerFloor listMessages:", (e as Error)?.message ?? e);
      return null;
    }
    // Healthy read, no messages = a fresh session (no floor yet — 0, not null).
    if (msgs.length === 0) return 0;
    return managerFloorFromMessages(msgs, now);
  }

  /**
   * M2 — the handoff pass on the OLD manager session: prompt it to save its
   * persistent state (memory + notes) and return a ≤300-word handoff brief.
   * Never throws — a failed/interrupted pass just returns "" (the rotation can
   * still proceed on memory + notes alone).
   */
  async rotateHandoff(sessionID: string, dir: string): Promise<string> {
    return runRotationHandoff(sessionID, dir, {
      prompt: async (sid, text) => ({ reply: (await this.oc.promptAndWait(sid, text)).reply ?? "" }),
    });
  }

  /**
   * M3 — start the rotation sweep: every 10 min, measure each manager conv's
   * floor and apply the two-tier trigger. No-op until a manager conv crosses a
   * threshold. Unref'd (the process is long-lived; shutdown is guarded by
   * `this.draining` inside the tick). See src/rotation.ts.
   */
  private startRotationMonitor(): void {
    this.rotationTimer = setInterval(() => {
      for (const [conv, state] of Object.entries(this.st.all())) {
        if (state.manager && state.sessionID) {
          void this.checkManagerRotation(conv).catch((e) => warn("manager rotation:", e?.message));
        }
      }
    }, 10 * 60_000);
    this.rotationTimer.unref?.();
  }

  /**
   * M3 — one rotation tick for a manager conv: measure the floor, run the
   * two-tier gate, act on it. Auto → rotate now + notify; confirm → offer a
   * one-time confirm button (throttled); defer/idle → nothing this tick.
   */
  private async checkManagerRotation(conv: ConvKey): Promise<void> {
    if (this.draining) return;
    const state = this.st.peek(conv);
    if (!state?.manager || !state.sessionID) return;
    // Re-entrancy guard: an auto-rotation tick can run longer than the 10-min
    // interval (doManagerRotation does an LLM handoff + session creation), so
    // skip if this conv's previous tick is still in flight (mirrors prWatchBusy).
    if (this.rotationTickInFlight.has(conv)) return;
    this.rotationTickInFlight.add(conv);
    try {
      const floor = await this.managerFloor(state.sessionID);
      // Part 1 (rotation tracking): record this tick's floor into the 7-day trend
      // (daily min/max) and refresh the machine-wide durability snapshot. Best-
      // effort — a tracking failure must never break the rotation gate below. A
      // FAILED measurement (null) writes a "not measured" snapshot and skips the
      // trend upsert (a 0 must not pollute the 7-day trend) and the gate.
      try {
        if (floor !== null) {
          this.st.set(conv, { floorTrend: upsertFloorTrend(this.st.peek(conv)?.floorTrend, dayKey(Date.now()), floor / 1000) });
        }
        this.writeRotationSnapshot(conv, floor === null ? null : floor / 1000);
      } catch (e) {
        warn("rotation tracking:", (e as Error)?.message);
      }
      if (floor === null) return; // measurement failed — no gate decision this tick
      const floorK = floor / 1000;
      const action = rotationGate({
        floorK,
        // Busy = an in-band turn (inflight) OR an OUT-OF-BAND manager turn (a
        // schedule task / background wake on the manager session) tracked in
        // orch.managerBusy. Per-conv, NOT the global managerInflight the shutdown
        // drain uses: another conv's manager turn must not block this one's rotation.
        // Omitting it could rotate mid-turn and interrupt it.
        busy: this.inflight.has(conv) || this.orch.isManagerBusy(conv),
        nowMs: Date.now(),
        lastRotationMs: state.lastRotationMs,
        lastRotationPromptMs: state.lastRotationPromptMs,
        autoFloorK: this.cfg.rotationAutoFloorK,
        confirmFloorK: this.cfg.rotationConfirmFloorK,
        minIntervalMs: this.cfg.rotationMinIntervalMs,
        confirmRepromptMs: this.cfg.rotationConfirmRepromptMs,
      });
      if (action === "auto") {
        await this.doManagerRotation(conv, "auto", floorK);
      } else if (action === "confirm") {
        // Throttle the re-prompt (the gate already checked, but stamp here so a
        // confirm is never re-offered more often than the interval, even if the
        // floor is still high on the very next tick).
        this.st.set(conv, { lastRotationPromptMs: Date.now() });
        await this.sendRotationConfirm(conv, floorK);
      }
    } finally {
      this.rotationTickInFlight.delete(conv);
    }
  }

  /**
   * M3 — actually rotate the manager: hand off (M2 — save memory + notes, get a
   * brief), create a fresh session, inject the brief as carry-over, update
   * state, notify. Never throws (a failure is reported, the old session kept).
   */
  private async doManagerRotation(conv: ConvKey, mode: "auto" | "confirm", floorK: number): Promise<void> {
    const state = this.st.get(conv);
    const oldSID = state.sessionID;
    if (!oldSID) return;
    const dir = state.directory || this.cfg.opencodeDirectory;
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    const how = tr(lang, mode === "auto" ? "tự động (nền đã cao)" : "theo yêu cầu của bạn", mode === "auto" ? "auto (floor is high)" : "at your request");
    await this.tg.sendMessage(conv, tr(lang, `🔄 Đang xoay phiên Manager (nền ~${Math.round(floorK)}K, ${how}) — tóm tắt + tạo phiên mới…`, `🔄 Rotating the Manager session (floor ~${Math.round(floorK)}K, ${how}) — summarizing + creating a new one…`));
    try {
      const brief = await this.rotateHandoff(oldSID, dir);
      await this.stopCurrent(conv, true);
      this.cancelAllReminders(conv);
      const sessionID = await this.oc.createSession(dir);
      await this.applyModelAndVariant(sessionID, state);
      if (state.agent) await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("rotation setAgent:", e?.message));
      if (brief) {
        await this.oc
          .setInstruction(
            sessionID,
            CARRYOVER_KEY,
            tr(
              lang,
              `Bạn đang tiếp tục từ một phiên Manager đã bị xoay (nền cũ ~${Math.round(floorK)}K). Brief bàn giao từ phiên cũ:\n${brief}\nTiếp tục từ đây — memory + notes đã giữ các thực tế quan trọng.`,
              `You are continuing from a rotated Manager session (old floor ~${Math.round(floorK)}K). Handover brief from the previous session:\n${brief}\nContinue from here — memory + notes hold the key facts.`,
            ),
          )
          .catch((e) => warn("rotation brief:", (e as Error).message));
      }
      const now = Date.now();
      // Part 1 (rotation tracking): record this SUCCESSFUL attempt + the fresh
      // session's (best-effort) post-rotation floor. A brand-new session has no
      // assistant messages yet, so its floor reads 0 — the honest value.
      const newFloorK = Math.round(((await this.managerFloor(sessionID)) ?? 0) / 1000);
      const cur = this.st.get(conv);
      const nextHistory = appendRotationHistory(cur.rotationHistory, { at: now, floorK: Math.round(floorK), tier: mode, outcome: "success", newFloorK });
      this.st.set(conv, {
        sessionID,
        directory: dir,
        lastRotationMs: now,
        lastRotationSID: oldSID,
        lastRotationFloor: Math.round(floorK),
        lastRotationPromptMs: undefined,
        rotationHistory: nextHistory,
      });
      await this.tg.sendMessage(
        conv,
        okLine(lang, raw(tr(lang, `Đã xoay Manager → session mới <code>${esc(sessionID)}</code>\nDir: <code>${esc(dir)}</code>\n${brief ? `📝 Brief: ${brief.split(/\s+/).length} từ` : "📝 (phiên cũ trống)"}`, `Manager rotated → new session <code>${esc(sessionID)}</code>\nDir: <code>${esc(dir)}</code>\n${brief ? `📝 Brief: ${brief.split(/\s+/).length} words` : "📝 (old session empty)"}`))),
      );
      log(`manager rotation (${mode}) conv=${conv} ${oldSID} → ${sessionID} floor=${Math.round(floorK)}K brief=${brief ? brief.length : 0}ch`);
      // Refresh the snapshot so it reflects the rotation just performed (the
      // pre-action snapshot written by checkManagerRotation is now stale).
      this.writeRotationSnapshot(conv, newFloorK);
    } catch (e) {
      warn("manager rotation failed (old session kept):", (e as Error)?.message ?? e);
      // Part 1 (rotation tracking): record the FAILED attempt so /rotation and
      // the durability check see it (lastOutcome=fail → "unbounded" verdict).
      // The old session is kept, so its floor is still ~floorK.
      try {
        const cur = this.st.get(conv);
        this.st.set(conv, { rotationHistory: appendRotationHistory(cur.rotationHistory, { at: Date.now(), floorK: Math.round(floorK), tier: mode, outcome: "fail" }) });
        this.writeRotationSnapshot(conv, Math.round(floorK));
      } catch (e2) {
        warn("rotation tracking (fail):", (e2 as Error)?.message);
      }
      await this.tg.sendMessage(conv, warnLine(lang, raw(tr(lang, "Xoay phiên Manager thất bại — phiên cũ vẫn giữ nguyên.", "Manager rotation failed — the old session is kept as-is.")))).catch(() => {});
    }
  }

  /**
   * Part 1 (rotation tracking) — refresh the machine-wide rotation health
   * snapshot for a manager conv (data/rotation-health.json). Best-effort: the
   * caller wraps in try/catch. `floorK` is the manager's CURRENT floor (K)
   * (null when not measured). Reads the conv's trend + history from state.
   */
  private writeRotationSnapshot(conv: ConvKey, floorK: number | null): void {
    const state = this.st.peek(conv);
    if (!state) return;
    const hist = state.rotationHistory ?? [];
    const last = hist[hist.length - 1];
    const snap = buildRotationSnapshot({
      now: Date.now(),
      currentFloorK: floorK === null ? null : Math.round(floorK),
      floorTrend: state.floorTrend ?? [],
      rotationHistory: hist,
      lastRotationAt: last ? last.at : state.lastRotationMs ?? null,
      lastRotationOutcome: last ? last.outcome : null,
      autoK: this.cfg.rotationAutoFloorK,
      confirmK: this.cfg.rotationConfirmFloorK,
    });
    writeRotationHealth(rotationHealthPath(this.cfg.stateFile), snap);
  }

  /**
   * Part 1 (rotation tracking) — the machine-wide rotation health snapshot for
   * the /rotation command. Reads the on-disk file if present; otherwise builds
   * one live from the first manager conv's state (so /rotation works even in
   * the first 10 minutes, before the first tick has written the file — the
   * current floor reads null in that fallback). Read-only, no REST calls.
   */
  public rotationHealthSnapshot(): RotationHealthSnapshot | null {
    const onDisk = readRotationHealth(rotationHealthPath(this.cfg.stateFile));
    if (onDisk) return onDisk;
    const state = Object.values(this.st.all()).find((s) => s.manager && s.sessionID);
    if (!state) return null;
    const hist = state.rotationHistory ?? [];
    const last = hist[hist.length - 1];
    return buildRotationSnapshot({
      now: Date.now(),
      currentFloorK: null,
      floorTrend: state.floorTrend ?? [],
      rotationHistory: hist,
      lastRotationAt: last ? last.at : state.lastRotationMs ?? null,
      lastRotationOutcome: last ? last.outcome : null,
      autoK: this.cfg.rotationAutoFloorK,
      confirmK: this.cfg.rotationConfirmFloorK,
    });
  }

  /** M3 — the one-time confirm (two-tier, L1): offer rotate / keep-old buttons. */
  private async sendRotationConfirm(conv: ConvKey, floorK: number): Promise<void> {
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    await this.tg.sendMessage(
      conv,
      tr(lang, `🧹 Session Manager đang gần hết chỗ trống — nền (sau summarization) đã lên ~${Math.round(floorK)}K.\n\nĐề xuất: xoay sang phiên mới, giữ lại <b>memory + notes</b> cộng thêm một brief ngắn. Muốn xoay ngay?`, `🧹 The Manager session is running low on room — the floor (after summarization) is now ~${Math.round(floorK)}K.\n\nSuggestion: rotate to a fresh session, keeping <b>memory + notes</b> plus a short brief. Rotate now?`),
      {
        reply_markup: {
          inline_keyboard: [[{ text: tr(lang, "🔄 Xoay ngay", "🔄 Rotate now"), callback_data: rotCb.encode({ op: "cf" }) }, { text: tr(lang, "↩️ Giữ phiên cũ", "↩️ Keep old session"), callback_data: rotCb.encode({ op: "cx" }) }]],
        },
      },
    );
  }

  /** M3 — rot:cf / rot:cx — confirm or cancel a manager rotation offer. */
  public async handleRotationCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    const op = (cb.data ?? "").split(":")[1];
    if (op === "cx") {
      answer(tr(lang, "↩️ Đã huỷ", "↩️ Cancelled"));
      if (messageId) {
        await this.tg
          .editMessageText(conv, messageId, tr(lang, "↩️ Đã huỷ — phiên Manager giữ nguyên.", "↩️ Cancelled — the Manager session is kept as-is."), { reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      return;
    }
    if (op !== "cf") return;
    const sid = this.st.peek(conv)?.sessionID;
    if (!sid) {
      answer(tr(lang, "Không có session để xoay", "No session to rotate"));
      return;
    }
    answer(tr(lang, "🔄 Đang xoay…", "🔄 Rotating…"));
    const floor = (await this.managerFloor(sid)) ?? 0;
    await this.doManagerRotation(conv, "confirm", floor / 1000);
  }


  // ── Thin registry bridges: the typed dispatch calls these Bot methods, which
  //    delegate to the split-out feature modules (the logic lives in the module,
  //    not here). Keeping them as Bot methods gives the registry one uniform call
  //    shape and keeps the routing tests' bot-method overrides intercepting. ──
  public async handlePermissionCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handlePermissionCallback(this, cb, conv, messageId, answer);
  }
  public async handleNewConfirmCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleNewConfirmCallback(this, cb, conv, messageId, answer);
  }
  public async handleUseCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleUseCallback(this, cb, conv, messageId, answer);
  }
  public async handleBusyCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleBusyCallback(this, cb, conv, messageId, answer);
  }
  public async handleModeCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleModeCallback(this, cb, conv, messageId, answer);
  }
  public async handleVariantCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleVariantCallback(this, cb, conv, messageId, answer);
  }
  public async handleModelCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    return handleModelCallback(this, cb, conv, messageId, answer);
  }


  /** Handle any inline-button tap: every prefix is served by the typed registry (C2.1). */
  private async handleCallback(cb: CallbackQuery): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    if (!this.allowed(cb.from?.id)) {
      await this.tg.answerCallbackQuery(cb.id, tr(lang, "⛔ Không được phép", "⛔ Not allowed"));
      return;
    }
    const conv = cb.message ? this.convOf(cb.message) : undefined;
    const messageId = cb.message?.message_id;
    const data = cb.data ?? "";
    if (!conv) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    // Every button tap is served by the typed registry (C2.1): the two gates
    // above (allow-list, no-conv) are the single C2.3 spot, and all 35
    // prefixes are registered (C1.2), so a registered tap never falls
    // through. The legacy startsWith chain is gone (docs/sdd/callback-
    // registry.md, T6).
    if (await dispatchCallback({ bot: this, conv, messageId, lang }, cb)) return;
    // C2.2: the prefix was never registered (or the data has no colon) — a
    // stale or mistyped button. Toast it (warned once) instead of vanishing.
    await answerExpired(this, cb, lang, data);
  }

  /** Run a bot command from an inline button (the /help menu). */
  public async runCommandButton(cb: CallbackQuery, conv: ConvKey, name: string, answer: (toast?: string) => void): Promise<void> {
    const state = this.st.get(conv);
    try {
      switch (name) {
        case "new":
          await cmdNew(this, conv);
          break;
        case "ls":
          await cmdList(this, conv);
          break;
        case "dir":
          await cmdDir(this, conv, "", state);
          break;
        case "browse":
          await cmdBrowse(this, conv, "", state);
          break;
        case "mode":
          await cmdMode(this, conv, "", state);
          break;
        case "models":
          await cmdModels(this, conv);
          break;
        case "variants":
          await cmdVariants(this, conv, "", state);
          break;
        case "agents":
          await cmdAgents(this, conv);
          break;
        case "stop":
          await cmdStop(this, conv, state);
          break;
        case "reboot":
          await cmdReboot(this, conv);
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
        case "rotation":
          await cmdRotation(this, conv);
          break;
        case "history":
          await cmdHistory(this, conv, state);
          break;
        case "clear":
          await cmdClear(this, conv, state);
          break;
        case "schedule":
          await cmdSchedule(this, conv, "", state, cb.from?.id);
          break;
        case "help":
          await cmdHelp(this, conv, this.userPrefs.getLang(cb.from?.id ?? ""));
          break;
        default:
          await this.tg.sendMessage(conv, tr(this.userPrefs.getLang(cb.from?.id ?? ""), "❓ Lệnh không rõ.", "❓ Unknown command."));
      }
    } finally {
      // Answer last so the tap spinner shows while the command runs.
      answer();
    }
  }

  /** Handle a tap on the plan-to-build button (data = `pb:go`). */
  public async handlePlanToBuildCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    const state = this.st.get(conv);
    if (this.inflight.has(conv)) {
    answer(tr(lang, "Đang chạy task — hãy thử lại sau.", "A task is running — try again later."));
      return;
    }
    if (!state.sessionID) {
      answer(tr(lang, "Chưa có session — hãy gửi một tin nhắn trước.", "No session yet — send a message first."));
      return;
    }
    await applyMode(this, conv, state, "build");
    answer("Mode → build");
    await this.tg.sendMessage(conv, tr(lang, "Đã chuyển sang <b>build</b> — bắt đầu thực thi kế hoạch.", "Switched to <b>build</b> — starting to execute the plan.")).catch(() => {});
    const prompt = tr(lang,
      "Đã chuyển sang chế độ build. Hãy thực thi kế hoạch vừa được lập trong cuộc hội thoại này: bắt đầu từ bước 1, làm tuần tự, và dừng lại để hỏi nếu thiếu thông tin quan trọng. Nếu không có kế hoạch nào chưa thực thi, chỉ cần xác nhận đã sẵn sàng.",
      "Switched to build mode. Execute the plan just made in this conversation: start at step 1, work sequentially, and stop to ask if important information is missing. If there is no unexecuted plan, just confirm you are ready.",
    );
    const ac = new AbortController();
    this.inflight.set(conv, ac);
    void this.runPromptTask(conv, state.sessionID, prompt, ac).catch((e) => error("prompt task:", e?.message));
  }

  /**
   * Handle a tap on a trailing choice-list button (data = `ch:<id>:<i>`).
   *
   * The chosen option is relayed to the session "as if typed" — a fresh user
   * turn via `oc.prompt`. The session is idle at this point (the reply that
   * produced the buttons already finished its turn), so the turn runs clean and
   * the `session.execution.*` event loop relays the model's reply back to this
   * conv (attaching buttons again, recursively, if that reply also ends in a
   * choice list). The keyboard is one-shot: it is dropped immediately so a
   * re-tap or a stale button (e.g. after a /new) can never fire a second turn.
   */
  public async handleChoiceCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    // R3.3: the inert "chosen" button (replaces the keyboard after an accepted
    // tap) — re-tapping it does nothing; it only shows what was sent.
    if ((cb.data ?? "") === "ch:inert") {
      answer();
      return;
    }
    const parts = (cb.data ?? "").split(":");
    const id = parts[1];
    const idx = Number(parts[2] ?? "");
    const rec = id ? registry.get(id) : undefined;
    const state = this.st.peek(conv);
    // R3.4: unknown id (the registry is in-memory — it outlived a restart) or
    // TTL-expired → "expired".
    if (!rec) {
      answer(tr(lang, "Nút này đã hết hạn.", "This button has expired."));
      return;
    }
    const choice = rec.options[idx];
    // R3.4: bound to the session it was created for — the conv's session
    // changed (a /new / /use / Manager rotation) → "no longer applies".
    if (!rec.sessionID || choice === undefined || !state || (state.sessionID && state.sessionID !== rec.sessionID)) {
      registry.delete(id);
      answer(tr(lang, "Nút này không còn áp dụng.", "This button is no longer applicable."));
      return;
    }
    // R3.2: a turn is running → refuse, KEEP the buttons, send nothing. (This
    // changes today's behaviour, where a tap silently steered into the running
    // turn; R5.1 extends the refusal to the existing lettered-list buttons.)
    if (state.manager ? this.orch.managerInflight : this.inflight.has(conv)) {
    answer(tr(lang, "Đang chạy task — hãy thử lại sau.", "A task is running — try again later."));
      return;
    }
    // Consume BEFORE any await so a double-tap can never double-fire (R3.4).
    registry.delete(id);
    // Auto-hide bookkeeping: this keyboard is no longer an active, untapped
    // choices set (it becomes the inert ✓ below), so drop the conv's pointer —
    // a later reply must not clobber the ✓ history.
    if (this.activeChoice.get(conv)?.regId === id) this.activeChoice.delete(conv);
    // R3.1: a tap is a typed message — the same entry point as a typed message
    // (runPrompt for plain sessions, promptManager for the Manager), so it is
    // audited, shows the typing indicator, gets the turn footer + next-step
    // buttons, and refills the Manager's dispatch budget. Called synchronously
    // — its busy guard runs in this same tick, so the R3.2 check above holds.
    // Fire-and-forget: the callback must be answered promptly, and the reply is
    // relayed by the event loop when the turn ends.
    audit({ action: "suggest_tap", chatId: conv, userId: state.createdBy, meta: { idx, count: rec.options.length, manager: !!state.manager } });
    const turn = state.manager
      ? this.orch.promptManager(conv, choice, messageId, lang)
      : this.runPrompt(conv, choice, state, messageId, lang);
    void turn.catch(async (e) => {
      warn("choice prompt:", (e as Error)?.message);
    answer(errorLine(lang, tr(lang, "Không thể xử lý — thử nhập lại.", "Couldn't process that — try typing it again.")));
    });
    answer();
    // R3.3: replace the keyboard with a single inert button showing the chosen
    // text + a check mark, so the chat shows what was sent.
    if (messageId) {
      const label = "✓ " + (choice.length > 60 ? choice.slice(0, 60) : choice);
      await this.tg
        .editMessageReplyMarkup(conv, messageId, { reply_markup: { inline_keyboard: [[{ text: label, callback_data: choiceCallback.encode({ kind: "inert" }) }]] } })
        .catch(() => {});
    }
  }

  /**
   * Handle a tap on a rule-based next-step button (data = "ns:<id>:<k>").
   * The N3 checks run in order: parse → registry (N3.6: expired, not silent)
   * → session binding (N3.2) → rule → busy (N3.3: refuse and KEEP the button)
   * → one-shot (N3.1) → action. Actions: "review" — the same read-only prompt
   * as /review; "board" — the read-only /board render (S5, no agent turn);
   * "new-keep" — the /new confirm card (S5, asks before doing anything).
   * N3.4: fixed text, the label says what happens. N3.5 is the shared
   * allow-list gate at the top of handleCallback (this.allowed).
   */
  public async handleNextStepCallback(cb: CallbackQuery, conv: ConvKey, messageId?: number, answer: (toast?: string) => void = (toast) => { void this.tg.answerCallbackQuery(cb.id, toast).catch(() => {}); }): Promise<void> {
    const lang = this.userPrefs.getLang(cb.from?.id ?? "");
    const parsed = parseCallback(cb.data ?? "");
    if (!parsed) {
      await answer();
      return;
    }
    const rec = nsRegistry.get(parsed.id, Date.now());
    if (!rec) {
      // N3.6: unknown id — outlived a bot restart (the registry is in-memory) or expired.
      await answer(tr(lang, "Nút này đã hết hạn.", "This button has expired."));
      return;
    }
    // N3.2: the tap is bound to the session the button was created for.
    const state = this.st.peek(conv);
    if (!state?.sessionID || state.sessionID !== rec.sessionID) {
      await answer(tr(lang, "Nút này không còn áp dụng cho phiên hiện tại.", "This button no longer applies to the current session."));
      return;
    }
    // N3.3: a turn is running → refuse and KEEP the button (no markup edit).
    // (Manager turns have no inflight entry — fire-and-forget — but the board
    // action is read-only, so a busy Manager never blocks a /board tap.)
    if (this.inflight.has(conv)) {
    await answer(tr(lang, "Đang chạy task — hãy thử lại sau.", "A task is running — try again later."));
      return;
    }
    if (rec.rule === "review" && state.manager) {
      // The /review guard: the Manager has no repo (stale button after /manager on).
      await answer(tr(lang, "🔍 Manager không có repo để review.", "🔍 The Manager has no repo to review."));
      return;
    }
    // N3.1: one-shot — drop the next-step row and consume the record BEFORE
    // the action so a re-tap can never fire twice. A row appended to the
    // worktree card (S4) reverts the card to its own buttons; a failure
    // message (S5) reverts to its Continue row; everything else reverts to
    // no buttons.
    if (messageId) {
      const residual = this.nextStepResiduals.get(messageId) ?? { inline_keyboard: [] };
      await this.tg.editMessageReplyMarkup(conv, messageId, { reply_markup: residual }).catch(() => {});
      this.nextStepFooters.delete(conv);
      this.nextStepResiduals.delete(messageId);
    }
    nsRegistry.delete(parsed.id);
    // N4.3: an accepted tap (all N3 checks passed, action about to run) is in
    // the audit log with its rule id, so tap rates can be measured.
    audit({ action: "nextstep_tap", chatId: conv, session: rec.sessionID, userId: cb.from?.id, outcome: "ok", meta: { rule: rec.rule } });
    if (rec.rule === "review") {
      const prompt = reviewPrompt("", lang);
      if (!prompt) {
        await answer();
        return;
      }
      await answer();
      await this.runPrompt(conv, prompt, state, undefined, lang);
      return;
    }
    if (rec.rule === "board") {
      // S5: /board is read-only (no agent turn) — safe even mid-manager-turn.
      await answer();
      await this.orch.cmdBoard(conv).catch((e) => warn("nextstep board tap:", (e as Error)?.message));
      return;
    }
    // "new-keep": open the /new confirm card (nw: flow) — it asks before
    // doing anything (N3.4: the label says what happens).
    await this.tg.answerCallbackQuery(cb.id);
    await cmdNew(this, conv);
  }

  /**
   * S4 (next-step buttons, workers): a message in this conv now carries the
   * conv's next-step row — the Review button appended to the worktree card,
   * or one short line. Remember its id so N3.7 can dismiss it, and (for a
   * card) the keyboard it reverts to: the card's own Diff/Merge/Delete rows.
   */
  public noteNextStepMessage(conv: ConvKey, messageId: number, residual?: Keyboard): void {
    if (messageId <= 0) return;
    // The footer stays keyed by conv (N3.7 dismisses this conv's newest row); the residual
    // is keyed by messageId so a tap on a stale row restores ITS OWN row, not the newest.
    // Cleanup happens on tap / dismiss — never drop a still-live row's residual here.
    this.nextStepFooters.set(conv, messageId);
    if (residual) this.nextStepResiduals.set(messageId, residual);
  }

  /** N3.7: drop the previous turn's next-step keyboard when the user speaks again (best effort). */
  private dismissNextStepKeyboard(conv: ConvKey): void {
    const id = this.nextStepFooters.get(conv);
    if (!id) return;
    this.nextStepFooters.delete(conv);
    // A worktree card keeps its own buttons (S4); a footer/line reverts to none.
    const residual = this.nextStepResiduals.get(id) ?? { inline_keyboard: [] };
    this.nextStepResiduals.delete(id);
    void this.tg.editMessageReplyMarkup(conv, id, { reply_markup: residual }).catch(() => {});
  }

  /**
   * /queue — list this conv's queued messages (position + truncated text + age)
   * or clear the queue. Permission is the shared allowlist gate in onMessage
   * (the same gate as /stop, /clear) — no per-command check here.
   */
  private async cmdQueue(conv: ConvKey, arg: string): Promise<void> {
    const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
    const sub = arg.trim().toLowerCase();
    if (sub === "clear") {
      const n = this.queue.clear(conv);
      await this.tg.sendMessage(
        conv,
        n > 0
          ? tr(lang, "🧹 Đã xoá " + n + " tin khỏi hàng chờ.", "🧹 Cleared " + n + " message(s) from the queue.")
          : tr(lang, "Hàng chờ đã trống.", "The queue is already empty."),
      );
      return;
    }
    const items = this.queue.list(conv);
    if (items.length === 0) {
      await this.tg.sendMessage(conv, tr(lang, "Không có tin nào trong hàng chờ.", "No messages in the queue."));
      return;
    }
    const lines = items.map((it, i) => "#" + (i + 1) + " · " + esc(trunc(it.text, 40)) + " · " + formatQueueAge(it.ageMs));
    await this.tg.sendMessage(conv, tr(lang, "📥 Hàng chờ (" + items.length + "):", "📥 Queue (" + items.length + "):") + "\n" + lines.join("\n"));
  }

  // ── question forms (the agent's `question` tool) ──────────────────────────
  /** Entry point for every OpenCode event; only question forms interest us. */
  private onOpenCodeEvent(ev: any): void {
    const t = ev?.type;
    // /watch (W3): fold session events into the conversation's live card.
    // A no-op when /watch is inactive (W6.1) or the session has no watch.
    if (typeof t === "string" && t.startsWith("session.")) this.feedWatch(t, ev?.data);
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
      if (d?.id && d?.sessionID) void onPermissionAsked(this, d);
    } else if (t === "permission.replied") {
      const d = ev?.data;
      const owner = d?.sessionID ? this.st.findChatBySession(d.sessionID) : this.permissionPrompts.get(d?.requestID)?.conv;
      if (owner) this.orch.onResumed(owner);
      if (d?.requestID) void onPermissionResolved(this, d.requestID, d.reply);
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
      if (conv) void (t === "session.shell.started" ? this.showActivity(conv, tr(this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? ""), "▶ Đang chạy shell…", "▶ Running shell…")) : this.finishActivity(conv, true));
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
        // Track the sweep so a shutdown drain waits for the final send it carries.
        this.trackPending(this.sweepUnrelayedReplies(conv, "turn ended out-of-band", t === "session.execution.succeeded"));
      }
    }
  }

  /**
   * Edit a card in place. "message is not modified" counts as success (the card
   * is still there and matches); any other failure returns -1 so the caller can
   * fall back to a fresh message. Returns the message id on success.
   */
  public async editCardInPlace(conv: ConvKey, messageId: number, text: string, kb?: Keyboard): Promise<number> {
    try {
      await this.tg.editMessageTextStrict(conv, messageId, text, { reply_markup: kb });
      return messageId;
    } catch (e) {
      if (/message is not modified/i.test(String((e as Error)?.message))) return messageId;
      return -1;
    }
  }

  /** A new question form appeared — relay its first field to the worker's main channel. */
  private async onFormCreated(form: any): Promise<void> {
    const sessionID = form.sessionID as string;
    const formID = form.id as string;
    if (this.questionForms.has(formID)) return;
    const conv = this.st.findChatBySession(sessionID);
    if (!conv) {
      warn(`form.created for session ${sessionID} with no mapped chat — ignoring`);
      return;
    }
    // Relay the card to the worker's main channel so the user answers it from
    // the manager chat; the worker's conv stays the prompt's owner (status +
    // reminder schedule).
    const relayConv = chatOf(conv);
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
      const lang = this.userPrefs.getLang(this.st.peek(conv)?.createdBy ?? "");
      await this.tg
        .sendMessage(relayConv, tr(lang, "❓ OpenCode đang hỏi (không có lựa chọn) — xem /history để biết chi tiết.", "❓ OpenCode is asking (no options) — see /history for details."))
        .catch(() => {});
      return;
    }
    const qf: QuestionFormState = { formId: formID, sessionID, conv, relayConv, fields, index: 0, answers: {} };
    this.orch.onWaiting(conv);
    this.questionForms.set(formID, qf);
    const v = this.renderQuestion(qf);
    // Re-registration after a restart (reconcile): the original card is usually
    // still in the chat — refresh it in place instead of posting a duplicate.
    const prevId = this.st.get(conv).pendingPrompts?.[formID]?.messageId;
    let messageId = prevId ? await this.editCardInPlace(relayConv, prevId, v.text, v.keyboard) : -1;
    if (messageId < 0) messageId = await this.tg.sendMessageId(relayConv, v.text, { reply_markup: v.keyboard }).catch(() => -1);
    qf.messageId = messageId;
    // Start nudging if the user doesn't answer (exponential backoff; keyed by form id)
    // — but ONLY when the card was actually sent, else a reminder would re-send
    // buttons that were never delivered.
    if (messageId > 0) this.startPromptReminder(conv, formID, "form", v.text, v.keyboard, messageId, relayConv);
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
      const lang = this.userPrefs.getLang(this.st.peek(qf.conv)?.createdBy ?? "");
      const msg =
        type === "form.cancelled"
          ? tr(lang, "ℹ️ Câu hỏi đã được huỷ bởi OpenCode.", "ℹ️ The question was cancelled by OpenCode.")
          : tr(lang, "ℹ️ Câu hỏi đã được trả lời (nơi khác).", "ℹ️ The question was answered elsewhere.");
      await this.tg.editMessageText(qf.relayConv, qf.messageId, msg).catch(() => {});
    }
  }

  /** Build the text + inline keyboard for the current field of a question form. */
  private renderQuestion(qf: QuestionFormState): { text: string; keyboard: Keyboard } {
    const lang = this.userPrefs.getLang(this.st.peek(qf.conv)?.createdBy ?? "");
    const f = qf.fields[qf.index];
    const total = qf.fields.length;
    const n = qf.index + 1;
    const lines: string[] = [];
    lines.push(tr(lang, `❓ <b>Câu ${n}/${total}</b>${f.title ? " · " + esc(f.title) : ""}`, `❓ <b>Question ${n}/${total}</b>${f.title ? " · " + esc(f.title) : ""}`));
    // The card lives in the shared main channel — name the worker that asks.
    const workerName = this.st.peek(qf.conv)?.worker?.name;
    if (workerName) lines.push(`<b>${tr(lang, "Worker", "Worker")}: ${esc(workerName)}</b>`);
    if (f.description) lines.push(esc(f.description));
    if (qf.waitingCustom !== undefined) {
      lines.push("", tr(lang, "✍️ <i>Gõ câu trả lời của bạn trong tin nhắn kế tiếp (bấm Huỷ để bỏ qua).</i>", "✍️ <i>Type your answer in the next message (tap Cancel to skip).</i>"));
    } else if (f.options?.length) {
      lines.push("", tr(lang, "Chạm một đáp án, hoặc tự gõ đáp án của bạn:", "Tap an option, or type your own answer:"));
    } else {
      lines.push("", tr(lang, "Gõ câu trả lời của bạn:", "Type your answer:"));
    }

    const rows: Btn[][] = [];
    const fd = qf.formId;
    if (qf.waitingCustom !== undefined) {
      rows.push([{ text: tr(lang, "❌ Huỷ", "❌ Cancel"), callback_data: formCb.encode({ formID: fd, op: "x" }) }]);
    } else {
      (f.options ?? []).forEach((opt, i) => {
        rows.push([{ text: `▪️ ${trunc(opt.label, 60)}`, callback_data: formCb.encode({ formID: fd, op: `o${i}` }) }]);
      });
      if (f.custom || !f.options?.length || f.type === "string") {
        rows.push([{ text: tr(lang, "✍️ Gõ tự do…", "✍️ Type freely…"), callback_data: formCb.encode({ formID: fd, op: "c" }) }]);
      }
      rows.push([{ text: tr(lang, "❌ Huỷ", "❌ Cancel"), callback_data: formCb.encode({ formID: fd, op: "x" }) }]);
    }
    return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
  }

  /** Handle a tap on a question-form button (data = `fq:<formId>:<op>`). */
  public async handleFormCallback(cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void, messageId?: number): Promise<void> {
    const data = cb.data ?? "";
    const parts = data.split(":");
    const formID = parts[1];
    const op = parts[2] ?? "";
    const qf = this.questionForms.get(formID);
    if (!qf) {
      answer(tr(this.userPrefs.getLang(cb.from?.id ?? ""), "Phiên hỏi đã kết thúc.", "The question session has ended."));
      return;
    }
    try {
      if (op === "x") {
        await this.oc.cancelForm(qf.sessionID, qf.formId, "Cancelled by user via Telegram.");
        this.questionForms.delete(formID);
        this.cancelReminder(qf.conv, formID); // the form is really cancelled → stop nudging (schedule lives under the worker conv)
    answer();
    if (messageId) await this.tg.editMessageText(conv, messageId, errorLine(this.userPrefs.getLang(cb.from?.id ?? ""), tr(this.userPrefs.getLang(cb.from?.id ?? ""), "Đã huỷ câu hỏi.", "Question cancelled."))).catch(() => {});
        return;
      }
      if (op === "c") {
        qf.waitingCustom = qf.index;
        answer();
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
        if (!opt) throw new Error(tr(this.userPrefs.getLang(cb.from?.id ?? ""), "Đáp án không hợp lệ — vui lòng thử lại.", "Invalid option — please try again."));
        qf.answers[f.key] = opt.value;
        answer();
        await this.advanceOrSubmit(qf, messageId);
        return;
      }
      answer();
    } catch (e) {
    answer(warnLine(this.userPrefs.getLang(cb.from?.id ?? ""), raw((e as Error).message)));
    }
  }

  /** After recording an answer: show the next field, or submit if all answered. */
  private async advanceOrSubmit(qf: QuestionFormState, messageId?: number): Promise<void> {
    qf.waitingCustom = undefined;
    // The card lives in the relay conv (main channel); the reminder schedule
    // lives under the worker conv — regardless of where the user answered.
    const cardConv = qf.relayConv ?? qf.conv;
    if (qf.index + 1 < qf.fields.length) {
      qf.index += 1;
      if (messageId) {
        const v = this.renderQuestion(qf);
        await this.tg.editMessageText(cardConv, messageId, v.text, { reply_markup: v.keyboard });
        // Keep nudging about the NEXT field of the same form (same form id), with
        // its buttons so the reminder is answerable — on the SAME card.
        this.startPromptReminder(qf.conv, qf.formId, "form", v.text, v.keyboard, messageId, qf.relayConv);
      } else {
        // Nothing was shown for the new field: don't keep nudging about the old one.
        this.cancelReminder(qf.conv, qf.formId);
      }
      return;
    }
    // All fields answered — submit the full answer to OpenCode.
    await this.oc.replyForm(qf.sessionID, qf.formId, qf.answers);
    this.questionForms.delete(qf.formId);
    this.cancelReminder(qf.conv, qf.formId); // form really submitted → stop nudging
    if (messageId) {
      const lang = this.userPrefs.getLang(this.st.peek(qf.conv)?.createdBy ?? "");
      // One line per field: "• <question> → <answer>" — the option label when
      // an option was tapped (lookup by value), the raw text for free answers.
      const lines = qf.fields.map((f, i) => {
        const q = f.title || f.description || tr(lang, `Câu ${i + 1}`, `Question ${i + 1}`);
        const raw = qf.answers[f.key];
        const a = f.options?.find((o) => o.value === raw)?.label ?? String(raw ?? "");
        return `• ${esc(trunc(q, 80))} → ${esc(trunc(a, 80))}`;
      });
      await this.tg
        .editMessageText(cardConv, messageId, okLine(lang, raw(tr(lang, "Đã gửi câu trả lời cho OpenCode.", "Answer sent to OpenCode.") + (lines.length ? "\n" + lines.join("\n") : ""))))
        .catch(() => {});
    }
  }

  /**
   * If a question form in this chat is waiting for a typed (custom) answer,
   * consume this text as that answer. Returns true if the text was consumed.
   *
   * `replyToMessageId` is `msg.reply_to_message?.message_id`: in the shared main
   * channel the text is only consumed when it is a reply to the question card
   * (see {@link formAcceptsTypedAnswer}); in the worker's own topic it is
   * consumed regardless.
   */
  private async handleFormText(conv: ConvKey, text: string, replyToMessageId?: number): Promise<boolean> {
    for (const qf of this.questionForms.values()) {
      if (!formAcceptsTypedAnswer(qf, conv, replyToMessageId)) continue;
      const f = qf.fields[qf.index];
      qf.answers[f.key] = text;
      await this.advanceOrSubmit(qf, qf.messageId);
      return true;
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback-registry (docs/sdd/callback-registry.md) — T3 pilot migration.
//
// All migrated prefixes (T3 pilot: pb, ch, cont, reboot; T4: mode, agent,
// variant, mdl, perm, rot, kill, prune, nw, use, fq, cmd, sch, wt, ap, q)
// are registered here at module load, and bot.ts is the ONLY place that
// imports this. The defs live with their producers. The handlers take an
// `answer` fn injected by the dispatcher's adapter, so every tap — registry
// path or legacy chain — is answered exactly once (C2.1) and a decode
// failure gets the C2.2 "expired" toast with no fall-through (C3.2).
//
// The `ch:`/`cont:`/`reboot:` branches of the legacy chain below are RETAINED
// for this pilot: they cover (a) `ch:` data whose id no longer matches the
// 4-char shape — which the new def cannot even decode — and (b) any data the
// dispatcher's decode rejects. Their handlers are the same functions the
// registry calls.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `pb:` callback def (docs/sdd/callback-registry.md — T3 pilot migration).
 * Wire form: the fixed "pb:go" — the only value this button has ever carried,
 * so decode is strict (a foreign value is malformed, not "some other op").
 */
export const pbCallback = defineCallback<{ op: "go" }>({
  prefix: "pb",
  encode: (a) => `pb:${a.op}`,
  decode: (rest) => (rest === "go" ? { op: "go" } : null),
});

/**
 * Register all migrated prefixes with their handlers (T3 + T4). Called once
 * at module load; scripts re-call it after `_clearCallbacksForTest()`.
 */
export function registerBotCallbacks(): void {
  registerCallback(pbCallback, (ctx, cb) => ctx.bot.handlePlanToBuildCallback(cb, ctx.conv, ctx.answer), "bot.ts (plan-to-build)");
  registerCallback(choiceCallback, (ctx, cb) => ctx.bot.handleChoiceCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "choices.ts (choice buttons)");
  registerCallback(continueCallback, (ctx, cb) => ctx.bot.handleContinueCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "continue.ts (continue button)");
  registerCallback(rebootCallback, (ctx, cb) => ctx.bot.handleRebootCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "uptime.ts (reboot flow)");
  // T4 group 2 — confirm / kill / prune prefixes.
  registerCallback(rotCb, (ctx, cb) => ctx.bot.handleRotationCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (manager rotation)");
  registerCallback(permCb, (ctx, cb) => ctx.bot.handlePermissionCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (permission prompts)");
  registerCallback(killCb, (ctx, cb) => ctx.bot.orch.handleKillCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "orchestrator.ts (kill picker)");
  registerCallback(pruneCb, (ctx, cb) => handlePruneCallback(ctx.bot.orch, cb, ctx.conv, ctx.answer, ctx.messageId), "purge.ts (prune confirm)");
  // T4 group 3 — the remaining prefixes.
  registerCallback(nwCb, (ctx, cb) => ctx.bot.handleNewConfirmCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (bare /new confirm)");
  registerCallback(useCb, (ctx, cb) => ctx.bot.handleUseCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (/use picker)");
  registerCallback(formCb, (ctx, cb) => ctx.bot.handleFormCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (question forms)");
  registerCallback(cmdCb, (ctx, cb, args) => ctx.bot.runCommandButton(cb, ctx.conv, args, ctx.answer), "commands.ts (command grid)");
  registerCallback(schCb, (ctx, cb) => handleScheduleCallback(ctx.bot, cb, ctx.conv, ctx.answer, ctx.messageId), "schedule.ts (schedules)");
  registerCallback(busyCb, (ctx, cb) => ctx.bot.handleBusyCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "busy.ts (queue/steer)");
  registerCallback(apCb, (ctx, cb) => ctx.bot.orch.handleApprovalCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "orchestrator.ts (approvals)");
  registerCallback(wtCb, (ctx, cb) => ctx.bot.orch.handleWorktreeCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "orchestrator.ts (worktrees)");
  // T4 group 1 — the picker prefixes.
  registerCallback(modeCb, (ctx, cb) => ctx.bot.handleModeCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (mode picker)");
  registerCallback(agentCb, (ctx, cb) => handleAgentCallback(ctx.bot, cb, ctx.conv, ctx.answer, ctx.messageId), "agents.ts (agent picker)");
  registerCallback(variantCb, (ctx, cb) => ctx.bot.handleVariantCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (variant picker)");
  registerCallback(modelCb, (ctx, cb) => ctx.bot.handleModelCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "bot.ts (model picker)");
  // T5 — the folder browser menu and its sub-actions.
  registerCallback(bsCallback, (ctx, cb) => ctx.bot.handleBrowseCallback(cb, ctx.conv, ctx.answer, ctx.messageId), "browse.ts (folder browser)");
  // T6 — the remaining 14 prefixes (watch, working-watch, next-steps, busy
  // note, and the spec family). Completing this makes the legacy startsWith
  // chain in handleCallback dead, so it is deleted. SPCAUTO is deliberately
  // left unregistered (no chain branch handled it either).
  registerCallback(watchCb, (ctx, cb) => ctx.bot.handleWatchCallback(cb, ctx.conv, ctx.answer), "watch.ts (watch card)");
  registerCallback(wwCb, (ctx, cb) => ctx.bot.handleWorkingWatchButton(cb, ctx.conv, ctx.answer), "bot.ts (working watch)");
  registerCallback(nsCb, (ctx, cb) => ctx.bot.handleNextStepCallback(cb, ctx.conv, ctx.messageId, ctx.answer), "nextsteps.ts (next steps)");
  registerCallback(noteCb, (ctx, cb) => handleNoteCallback(ctx.bot, cb, ctx.conv, ctx.messageId, ctx.answer), "notes.ts (busy note)");
  registerCallback(specCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec list/detail)");
  registerCallback(specrunCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec run)");
  registerCallback(specblockedCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec run-blocked)");
  registerCallback(specrunokCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec run-anyway)");
  registerCallback(specrerunCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec re-run anyway)");
  registerCallback(speccancelCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec re-run cancel)");
  registerCallback(spcaccCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec accept)");
  registerCallback(spcautoCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec auto)");
  registerCallback(spcredoCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec redo)");
  registerCallback(spcredocancelCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec redo cancel)");
  registerCallback(spcstopCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec stop)");
  registerCallback(spcprCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec PR flow)");
  registerCallback(spcreadyCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec PR ready)");
  registerCallback(spccleanCb, (ctx, cb) => handleSpecCallback(ctx.bot, cb, ctx.conv, ctx.answer), "commands/spec.ts (spec clean up)");
}

registerBotCallbacks();
