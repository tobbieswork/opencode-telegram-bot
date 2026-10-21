import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ModelRef {
  id: string;
  providerID: string;
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
}

export type StateMap = Record<string, ChatState>;

/**
 * Tiny JSON-backed store mapping chatId -> per-chat OpenCode state.
 * Survives restarts so a bot restart reattaches to the same session/dir/model.
 */
export class StateManager {
  private data: StateMap = {};

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8")) as StateMap;
      } catch {
        this.data = {};
      }
    }
  }

  get(chatId: string | number): ChatState {
    const k = String(chatId);
    if (!this.data[k]) this.data[k] = {};
    return this.data[k];
  }

  set(chatId: string | number, patch: ChatState): void {
    Object.assign(this.get(chatId), patch);
    this.save();
  }

  clear(chatId: string | number): void {
    delete this.data[String(chatId)];
    this.save();
  }

  /** Find the chat that currently owns a given session (used to route form events). */
  findChatBySession(sessionID: string): string | undefined {
    for (const [chatId, s] of Object.entries(this.data)) {
      if (s.sessionID === sessionID) return chatId;
    }
    return undefined;
  }

  /** All chat states (used by the startup orphan-recovery sweep). */
  all(): StateMap {
    return this.data;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* best-effort persistence */
    }
  }
}
