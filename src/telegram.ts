import { log, warn, error } from "./logger.js";
import { ConvKey, parseConv } from "./conv.js";

export type Message = {
  message_id?: number;
  text?: string;
  chat: { id: number; type?: string; is_forum?: boolean };
  from?: { id: number; first_name?: string; username?: string };
  /** Forum topic the message belongs to (only meaningful when is_topic_message). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string };
};

export type CallbackQuery = {
  id: string;
  data?: string;
  from?: { id: number; first_name?: string; username?: string };
  message?: { chat: { id: number }; message_id: number; message_thread_id?: number; is_topic_message?: boolean };
};

export type Update = {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: CallbackQuery;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where to send: a conversation key (`chat` or `chat:topic`) or a bare chat id.
 * Expands to `chat_id` plus `message_thread_id` when it names a topic.
 */
function dest(to: ConvKey | number): { chat_id: number; message_thread_id?: number } {
  const { chatId, threadId } = parseConv(to);
  return threadId ? { chat_id: chatId, message_thread_id: threadId } : { chat_id: chatId };
}

/** Topic icon colors Telegram accepts for createForumTopic. */
export const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

/**
 * Minimal Telegram Bot API client using long polling over global fetch.
 * No framework dependency — the whole transport is visible in this file.
 */
export class Telegram {
  private offset = 0;
  private stopped = false;
  private abort = new AbortController();

  constructor(private token: string) {}

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async api<T = unknown>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
      throw new Error(`Network error calling ${method}: ${(e as Error).message}`);
    }
    const json: any = await res.json().catch(() => null);
    if (!json?.ok) {
      const err: any = new Error(`Telegram ${method} failed: ${json?.description ?? `HTTP ${res.status}`}`);
      err.code = json?.error_code ?? res.status;
      err.retryAfter = json?.parameters?.retry_after;
      throw err;
    }
    return json.result as T;
  }

  /** `has_topics_enabled` tells whether this bot has topic mode in private chats. */
  getMe(): Promise<{ id: number; username?: string; first_name?: string; has_topics_enabled?: boolean }> {
    return this.api("getMe");
  }

  /** Fire-and-forget typing indicator. */
  sendChatAction(to: ConvKey | number, action = "typing"): void {
    void this.api("sendChatAction", { ...dest(to), action }).catch(() => {});
  }

  async sendMessage(to: ConvKey | number, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    await this.api("sendMessage", {
      ...dest(to),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
  }

  /** Like sendMessage but resolves to the Telegram message_id (for editing later). */
  async sendMessageId(to: ConvKey | number, text: string, opts: Record<string, unknown> = {}): Promise<number> {
    const res = await this.api<{ message_id: number }>("sendMessage", {
      ...dest(to),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
    return res?.message_id ?? -1;
  }

  /**
   * Rewrite a message in place — used to keep the folder browser in a single
   * message instead of spamming the chat.
   */
  async editMessageText(
    to: ConvKey | number,
    messageId: number,
    text: string,
    opts: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.api("editMessageText", {
        chat_id: parseConv(to).chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...opts,
      });
    } catch (e) {
      // 400 = "message is not modified" (nothing changed) — harmless.
      if ((e as any)?.code === 400) return;
      throw e;
    }
  }

  /** Stop the client's button-spinner; `text` shows a short toast. */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.api("answerCallbackQuery", { callback_query_id: id, text });
    } catch {
      // Expired/duplicate callback — nothing to answer.
    }
  }

  async deleteMessage(to: ConvKey | number, messageId: number): Promise<void> {
    try {
      await this.api("deleteMessage", { chat_id: parseConv(to).chatId, message_id: messageId });
    } catch {
      // Already gone.
    }
  }

  // ── forum topics (supergroups, and private chats with topic mode) ──────────
  /** Create a topic; resolves to its message_thread_id. */
  async createForumTopic(chatId: number, name: string, iconColor?: number): Promise<number> {
    const res = await this.api<{ message_thread_id: number }>("createForumTopic", {
      chat_id: chatId,
      name: name.slice(0, 128),
      ...(iconColor ? { icon_color: iconColor } : {}),
    });
    return res.message_thread_id;
  }

  /** Rename a topic (used to show worker status as a title prefix). Best-effort. */
  async editForumTopic(to: ConvKey, name: string): Promise<void> {
    const { chatId, threadId } = parseConv(to);
    if (!threadId) return;
    try {
      await this.api("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) });
    } catch (e) {
      // 400 TOPIC_NOT_MODIFIED (same name) is harmless.
      if ((e as any)?.code !== 400) throw e;
    }
  }

  /** Close a topic. Only supergroups support this; private chats just keep it open. */
  async closeForumTopic(to: ConvKey): Promise<void> {
    const { chatId, threadId } = parseConv(to);
    if (!threadId) return;
    await this.api("closeForumTopic", { chat_id: chatId, message_thread_id: threadId }).catch(() => {});
  }

  async deleteForumTopic(to: ConvKey): Promise<void> {
    const { chatId, threadId } = parseConv(to);
    if (!threadId) return;
    await this.api("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  /**
   * Long-polling loop. Each update is handed to `handler`; the handler is
   * awaited so it should return quickly for long-running work (spawn it,
   * don't block here). Retries with backoff on transient errors, honors 429.
   */
  async poll(handler: (u: Update) => Promise<void> | void): Promise<void> {
    log("Telegram polling started");
    while (!this.stopped) {
      let updates: Update[] = [];
      try {
        updates =
          (await this.api<Update[]>("getUpdates", {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
          }, this.abort.signal)) ?? [];
      } catch (e) {
        if (this.stopped) break;
        const err = e as any;
        if (err?.name === "AbortError") break;
        if (err?.code === 401) {
          error("Telegram returned 401 - bad bot token. Stopping.");
          this.stopped = true;
          break;
        }
        if (err?.code === 429) {
          const wait = Number(err.retryAfter ?? 3);
          warn(`Telegram 429 (rate limit), backing off ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        warn("Telegram poll error:", err?.message ?? e);
        await sleep(2000);
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try {
          await handler(u);
        } catch (e) {
          error("Update handler error:", (e as Error)?.message ?? e);
        }
      }
    }
    log("Telegram polling stopped");
  }
}
