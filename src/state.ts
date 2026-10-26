import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { ConvKey, chatOf } from "./conv.js";
import type { PrSnapshot } from "./pr-watch.js";

export interface ModelRef {
  id: string;
  providerID: string;
}

export type WorkerStatus = "idle" | "running" | "waiting" | "done" | "failed" | "stopped";

/** A worker: one session bound to its own forum topic. */
export interface WorkerInfo {
  /** Short slug used in the topic title and by the Manager to address it. */
  name: string;
  status: WorkerStatus;
  /** The task it was spawned with (Manager-spawned workers). */
  task?: string;
  spawnedBy: "user" | "manager";
  /** Whether the task may edit files (decides worktree isolation). */
  writes?: boolean;
  /** Git repo root of its directory (main checkout), when in a repo. */
  repoRoot?: string;
  /** Set when the worker runs in its own git worktree (root dir, branch, and the base it merges back to). */
  worktree?: { root: string; branch: string; base: string };
  createdAt: number;
  updatedAt: number;
  /** Short tail of the last reply, fed back to the Manager. */
  lastResult?: string;
  /**
   * Set when this worker was AUTO-RESPAWNED after its predecessor died from
   * context overflow — the predecessor's name. Persisted (survives a restart) so
   * the one-respawn-per-task budget is never exceeded, and shown for lineage.
   */
  respawnedFrom?: string;
}

/**
 * A pending question-form or permission the user hasn't answered yet, with the
 * bookkeeping for the exponential-backoff reminder nudges (see cfg.remind*). The
 * actual prompt lives in OpenCode; this is only the bot's reminder schedule. It
 * is persisted so a bot restart resumes nudging where it left off. One entry per
 * pending prompt (keyed by the form/permission id in ChatState.pendingPrompts),
 * so a conv's form and permission don't overwrite each other.
 */
export interface PendingPrompt {
  kind: "form" | "permission";
  /** Rendered question/permission body (Telegram HTML), re-sent on each reminder. */
  text: string;
  /** Inline keyboard for the prompt, so a reminder can re-offer the answer buttons. */
  keyboard?: unknown;
  /** When the prompt was first shown (ms epoch). */
  firstShownAt: number;
  /** How many reminders have been sent so far. */
  remindersSent: number;
  /** When the next reminder is due (ms epoch). */
  nextReminderAt: number;
}

export interface ChatState {
  sessionID?: string;
  directory?: string;
  model?: ModelRef;
  agent?: string;
  /** Reasoning variant for the current model (e.g. "xhigh"); falls back to cfg.defaultVariant. */
  variant?: string;
  /** Set once this session has received the "ask via question tool" preamble. */
  guided?: boolean;
  /**
   * The sessionID the "stay in the user's language" instruction was applied to.
   * Stored per-session (not a boolean) so a brand-new session after /new, /use,
   * setsess, or plan→build gets the instruction re-applied on its first prompt.
   */
  guidedLanguageSession?: string;
  /**
   * Pending form/permission prompts awaiting the user's answer, keyed by the
   * prompt id (form id / permission request id). Each carries its reminder
   * schedule, so a conv may hold several at once without them overwriting.
   */
  pendingPrompts?: Record<string, PendingPrompt>;
  /** time.created of the last assistant reply already relayed to Telegram (drives orphan recovery). */
  lastRelayedTime?: number;
  /**
   * The turn id (prompt message id) we last offered the "⏯ Chạy tiếp" button
   * for in this conv, so the same failed turn never gets the button twice. A
   * fresh turn has a fresh id, so it self-invalidates — no explicit clearing
   * needed on /new, /use, or /stop.
   */
  continueOfferedTurn?: string;
  /**
   * Scratchpad note written via /note while the agent is busy (see src/notes.ts).
   * Injected into the model's system context on the next user turn, retired on
   * the turn after that. notesStage: "pending" = not yet shown, "shown" = the
   * model has seen it on the previous turn.
   */
  notes?: string;
  notesStage?: "pending" | "shown";
  /** Present when this conversation is a worker topic. */
  worker?: WorkerInfo;
  /**
   * True when this conversation's Telegram topic was deleted in the UI and its
   * purge is still pending — the worker was running/waiting so the purge was
   * deferred (see Orchestrator.onTopicDeleted / pendingTopicDelete), or a purge
   * attempt failed. PERSISTED (survives a restart): the in-memory
   * `pendingTopicDelete` flag is lost on restart, so this marker is what the
   * startup sweep (Orchestrator.reapPendingTopicDeletes) uses to re-purge the
   * conv. Cleared automatically when the purge succeeds (purgeConv clears the
   * whole entry). Not a live state — it only means "purge this when safe".
   */
  topicDeletedPending?: boolean;
  /** True when this conversation's session is the Manager agent. */
  manager?: boolean;
  /** Manager dispatch without asking (top-level conversation only). */
  auto?: boolean;
  /**
   * MACHINE-WIDE (only ever written on the reserved MACHINE_STATE_KEY entry):
   * when we last sent the reboot reminder, in epoch ms. Drives the snooze
   * interval so a /stop-able reminder doesn't re-fire every check while the
   * box keeps running.
   */
  lastRebootReminderMs?: number;
  /**
   * MACHINE-WIDE (only ever written on the reserved MACHINE_STATE_KEY entry):
   * the PR watcher's last snapshot, keyed by PR number. Persists across
   * restarts so the watcher doesn't re-announce every already-seen PR/comment
   * after a bot restart (it diffs against this to know what is NEW).
   */
  prWatchSnapshot?: Record<number, PrSnapshot>;
}

export type StateMap = Record<string, ChatState>;

/**
 * Reserved state key holding MACHINE-WIDE (not per-conversation) bookkeeping.
 * It is deliberately not a real conversation: chatOf("__machine__") matches no
 * chat, so it is invisible to per-chat sweeps (convsOfChat, the orphan sweep),
 * and it has no sessionID, so the session index skips it.
 */
export const MACHINE_STATE_KEY = "__machine__";

/**
 * Tiny JSON-backed store mapping a conversation (chat or chat:topic) to its
 * OpenCode state. Survives restarts so a bot restart reattaches to the same
 * session/dir/model. Writes are atomic (temp file + rename) so a crash mid-write
 * can't leave a truncated file behind.
 */
export class StateManager {
  private data: StateMap = {};
  /** sessionID -> conversation, kept in sync on every write. */
  private bySession = new Map<string, ConvKey>();

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8")) as StateMap;
      } catch {
        this.data = {};
      }
    }
    this.reindex();
  }

  get(key: ConvKey | number): ChatState {
    const k = String(key);
    if (!this.data[k]) this.data[k] = {};
    return this.data[k];
  }

  /** Read without creating an entry. */
  peek(key: ConvKey | number): ChatState | undefined {
    return this.data[String(key)];
  }

  set(key: ConvKey | number, patch: ChatState): void {
    Object.assign(this.get(key), patch);
    this.reindex();
    this.save();
  }

  clear(key: ConvKey | number): void {
    delete this.data[String(key)];
    this.reindex();
    this.save();
  }

  /** Find the conversation that currently owns a given session (routes OpenCode events). */
  findChatBySession(sessionID: string): ConvKey | undefined {
    return this.bySession.get(sessionID);
  }

  /** All conversations (used by the startup orphan-recovery sweep). */
  all(): StateMap {
    return this.data;
  }

  /** Every conversation of one chat (its top level plus all its topics). */
  convsOfChat(key: ConvKey | number): [ConvKey, ChatState][] {
    const chat = chatOf(String(key));
    return Object.entries(this.data).filter(([k]) => chatOf(k) === chat);
  }

  /** The worker topic of a chat with this name, if any. */
  findWorker(key: ConvKey | number, name: string): [ConvKey, ChatState] | undefined {
    return this.convsOfChat(key).find(([, s]) => s.worker?.name === name);
  }

  private reindex(): void {
    this.bySession.clear();
    for (const [k, s] of Object.entries(this.data)) {
      // First writer wins, like the old linear scan did.
      if (s.sessionID && !this.bySession.has(s.sessionID)) this.bySession.set(s.sessionID, k);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* best-effort persistence */
    }
  }
}
