import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { ConvKey, chatOf } from "./conv.js";

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
  /** time.created of the last assistant reply already relayed to Telegram (drives orphan recovery). */
  lastRelayedTime?: number;
  /** Present when this conversation is a worker topic. */
  worker?: WorkerInfo;
  /** True when this conversation's session is the Manager agent. */
  manager?: boolean;
  /** Manager dispatch without asking (top-level conversation only). */
  auto?: boolean;
}

export type StateMap = Record<string, ChatState>;

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
