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
import type { OpenCodeCtl } from "../opencode.js";
import type { StateManager, UserPrefsStore, Lang } from "../state.js";
import type { BusyNoteStore } from "../notes.js";
import type { QueueStore } from "../queue.js";
import type { Orchestrator } from "../orchestrator.js";
import type { ConvKey } from "../conv.js";
import type { Keyboard } from "../shared.js";

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
}
