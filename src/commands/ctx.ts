/**
 * Narrow interface for feature modules (docs/sdd/split-bot-ts.md, S2.2).
 *
 * A feature module receives the bot through `BotCtx` — only the subset of
 * `Bot` it actually touches (core services, its own state, and the shared
 * primitives it calls) — instead of the whole class. `Bot` satisfies `BotCtx`
 * structurally (every member is public on `Bot`), so no behaviour changes; a
 * test can pass a hand-built fake.
 *
 * Keep this minimal: add a member only when a module actually needs it.
 */
import type { Telegram } from "../telegram.js";
import type { OpenCodeCtl, ModelInfo } from "../opencode.js";
import type { StateManager, UserPrefsStore, Lang, ChatState } from "../state.js";
import type { Config } from "../config.js";
import type { RotationHealthSnapshot } from "../rotation-health.js";
import type { BusyNoteStore } from "../notes.js";
import type { QueueStore } from "../queue.js";
import type { Orchestrator } from "../orchestrator.js";
import type { ConvKey } from "../conv.js";
import type { Keyboard } from "../shared.js";
import type { WatchStopReason } from "../bot.js";
import type { BrowseState } from "./browse.js";

/** A pending OpenCode permission request relayed to Telegram (buttons to answer it). */
export interface PermissionPrompt {
  requestID: string;
  sessionID: string;
  conv: ConvKey;
  /** Chat where the card is relayed (the worker's main channel, `chatOf(conv)`). */
  relayConv: ConvKey;
  messageId: number;
}

/**
 * The subset of `Bot` that feature modules touch. `Bot` implements it
 * structurally; tests may pass a fake with just these members.
 */
export interface BotCtx {
  tg: Telegram;
  oc: OpenCodeCtl;
  st: StateManager;
  orch: Orchestrator;
  userPrefs: UserPrefsStore;
  /** In-memory pending permission prompts (owned by the permission feature). */
  permissionPrompts: Map<string, PermissionPrompt>;
  startPromptReminder(
    conv: ConvKey,
    promptId: string,
    kind: "form" | "permission",
    text: string,
    keyboard?: unknown,
    messageId?: number,
    relayConv?: ConvKey,
  ): void;
  cancelReminder(conv: ConvKey, promptId: string): void;
  findPromptConv(promptId: string): ConvKey | undefined;
  editCardInPlace(conv: ConvKey, messageId: number, text: string, kb?: Keyboard): Promise<number>;
  /** Retained busy messages per conv (owned by Bot, shared with the Orchestrator). */
  busyNotes: BusyNoteStore;
  /** Per-conv queue of messages added while a turn was running (owned by Bot, shared with the Orchestrator). */
  queue: QueueStore;
  /** In-flight prompt abort controllers per conv (owned by Bot; moves with prompt-runner, T6). */
  inflight: Map<ConvKey, AbortController>;
  startTyping(conv: ConvKey): void;
  runPromptTask(conv: ConvKey, sid: string, text: string, ac: AbortController, userMsgId?: number, lang?: Lang): Promise<void>;
  /** Live config (used by model/admin features for budgets, defaults, delays). */
  cfg: Config;
  /** Send a (chunked) HTML message; the keyboard rides the final chunk. */
  sendHtml(conv: ConvKey, html: string, opts?: { reply_markup?: Keyboard }): Promise<void>;
  /** Open /model button pickers (owned by the model feature). */
  modelPickers: Map<ConvKey, { models: ModelInfo[]; page: number }>;
  /** Reboot already armed (owned by the admin feature). */
  rebootArmed: boolean;
  /** Resolve the model ref to apply: explicit per-chat > config default > session's current model. */
  resolveModel(state: ChatState, sessionID?: string): Promise<{ id: string; providerID: string } | null>;
  /** Apply the chat's model + effective variant to a session (best-effort). */
  applyModelAndVariant(sessionID: string, state: ChatState): Promise<void>;
  /** The Manager's 24h context floor (rotation feature) — /status shows it. */
  managerFloor(sessionID: string, now?: number): Promise<number | null>;
  /** The rotation health snapshot (rotation feature) — /usage's footer. */
  rotationHealthSnapshot(): RotationHealthSnapshot | null;
  /** Stop the running turn (abort the inflight controller + clear the queue); with `interrupt` also interrupt on the server. */
  stopCurrent(conv: ConvKey, interrupt?: boolean): Promise<void>;
  /** Stop nudging all of the conv's pending prompts and drop their reminder schedules. */
  cancelAllReminders(conv: ConvKey): void;
  /** Stop the conv's /watch card (W5.1) — no-op when no watch is live. */
  stopWatch(conv: ConvKey, reason: WatchStopReason, opts?: { deleteCard?: boolean }): void;
  /** In-memory folder browsers, one per conv (owned by the browse feature). */
  browsers: Map<ConvKey, BrowseState>;
  /** In-flight question forms, keyed by form id (owned by the form subsystem; /clear drops its conv's). */
  questionForms: Map<string, { conv: ConvKey }>;
}
