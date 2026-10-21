import { log, warn, error } from "./logger.js";

export type Message = {
  text?: string;
  chat: { id: number };
  from?: { id: number; first_name?: string; username?: string };
};

export type CallbackQuery = {
  id: string;
  data?: string;
  from?: { id: number; first_name?: string; username?: string };
  message?: { chat: { id: number }; message_id: number };
};

export type Update = {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: CallbackQuery;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.api("getMe");
  }

  /** Fire-and-forget typing indicator. */
  sendChatAction(chatId: number, action = "typing"): void {
    void this.api("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  async sendMessage(chatId: number, text: string, opts: Record<string, unknown> = {}): Promise<void> {
    await this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
  }

  /** Like sendMessage but resolves to the Telegram message_id (for editing later). */
  async sendMessageId(chatId: number, text: string, opts: Record<string, unknown> = {}): Promise<number> {
    const res = await this.api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
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
    chatId: number,
    messageId: number,
    text: string,
    opts: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.api("editMessageText", {
        chat_id: chatId,
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

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.api("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      // Already gone.
    }
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
