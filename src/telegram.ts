import { exec as execCb } from "node:child_process";
import { createWriteStream, unlinkSync } from "node:fs";
import { log, warn, error } from "./logger.js";
import { ConvKey, parseConv } from "./conv.js";
import {
  DnsHealConfig,
  HealState,
  DNS_HEAL_CMD,
  DNS_PROBE_CMD,
  freshHealState,
  recordNetworkFailure,
  recordSuccess,
  shouldHeal,
  startHeal,
  finishHeal,
  probeShowsStaleDns,
} from "./dns-heal.js";

export type Message = {
  message_id?: number;
  text?: string;
  chat: { id: number; type?: string; is_forum?: boolean };
  from?: { id: number; first_name?: string; username?: string };
  /** Forum topic the message belongs to (only meaningful when is_topic_message). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string };
  /** Caption on media (photo/sticker/video/voice/document); counts as text. */
  caption?: string;
  sticker?: { file_id?: string; type?: string };
  photo?: Record<string, unknown>[];
  video?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  document?: Record<string, unknown>;
  animation?: Record<string, unknown>;
  video_note?: Record<string, unknown>;
};

export type CallbackQuery = {
  id: string;
  data?: string;
  from?: { id: number; first_name?: string; username?: string };
  message?: { chat: { id: number }; message_id: number; message_thread_id?: number; is_topic_message?: boolean };
};

/** A single reaction on a message (the emoji-relevant subset of the Bot API). */
export type MessageReaction = { type: string; emoji?: string };

/**
 * A user changed their reaction on a message (the `message_reaction` update).
 * It carries chat.id + message_id ONLY — no topic info — so resolving WHICH
 * conversation the message belongs to requires the bot-maintained message
 * index (see state.ts msgIndex). Requires the bot to be admin and
 * "message_reaction" in allowed_updates. The bot's OWN setReactions produce
 * no such update (no echo loop).
 */
export type MessageReactionUpdated = {
  chat: { id: number };
  message_id: number;
  user?: { id: number; first_name?: string; username?: string };
  date: number;
  old_reaction: MessageReaction[];
  new_reaction: MessageReaction[];
};

/**
 * Emitted when the user taps the native stop button on a live streaming draft
 * (Bot API 10.1+ `sendMessageDraft` with `can_stop`). `message_thread_id` is
 * present only when the draft was sent into a forum topic.
 */
export type MessageGenerationStopped = {
  chat: { id: number };
  message_thread_id?: number;
  draft_id: number;
};

export type Update = {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: CallbackQuery;
  stopped_message_generation?: MessageGenerationStopped;
  message_reaction?: MessageReactionUpdated;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a shell command and capture its exit code + combined output. Never throws:
 * a missing command or timeout resolves to a non-zero code.
 */
function execCapture(cmd: string, timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execCb(cmd, { timeout: timeoutMs, maxBuffer: 1_048_576 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as any).code === "number" ? (err as any).code : -1;
      res({ code, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    });
  });
}

/**
 * Options for {@link Telegram.poll}. All optional — existing call sites keep working.
 */
export interface PollOptions {
  /**
   * Called once per DNS-heal incident, after the heal command finishes, so the
   * caller can inform the user. Best-effort: a rejection is logged, never thrown.
   */
  onDnsHeal?: (info: { failures: number; healNumber: number }) => void | Promise<void>;
}

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
 * Methods that address a forum topic directly and therefore surface a deleted
 * topic as "message thread not found". We only TRUST this error from these
 * (approach (a) of the review: a whitelist). Any other method returning the
 * same description (a rare, unrelated reason) must NOT trigger a purge —
 * purging destroys the session and worktree and cannot be undone, so a
 * false positive costs the user a whole session. Missing a real deletion is
 * the safe direction: the orphan is still cleaned by /prune.
 */
const THREAD_TARGETING_METHODS = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendMessageDraft",
  "sendChatAction",
  "editMessageText",
  "deleteMessage",
  "createForumTopic",
  "openForumTopic",
  "closeForumTopic",
  "deleteForumTopic",
  "answerCallbackQuery",
]);

/**
 * Minimal Telegram Bot API client using long polling over global fetch.
 * No framework dependency — the whole transport is visible in this file.
 */
export class Telegram {
  private offset = 0;
  private stopped = false;
  private abort = new AbortController();
  private healState: HealState | null = null;
  private onDnsHeal?: PollOptions["onDnsHeal"];

  /**
   * A forum topic the user deleted in the Telegram UI. Telegram has NO event
   * for this (Bot API 10.3 has no `forum_topic_deleted` update and no deleted
   * service message — verified against core.telegram.org docs + live probe),
   * so a dead topic can only be observed the moment a send to it fails with
   * "message thread not found". Set this and the api() layer fires it with the
   * topic's chat + thread id before rethrowing, so the caller can retire the
   * conversation (state, session, worktree) instead of leaking it forever.
   */
  onThreadNotFound?: (chatId: number, threadId: number) => void;

  /**
   * Fired for every `message_reaction` update (a user changed a reaction on
   * a message). Mirrors the onThreadNotFound dispatch: the poll loop calls it
   * directly instead of routing it through the generic message handler, which
   * has no conv to enqueue it under (the update carries no message/topic).
   * May be async; the poll loop awaits it and never lets it break polling.
   */
  onMessageReaction?: (ev: MessageReactionUpdated) => void | Promise<void>;

  constructor(private token: string, private healCfg?: DnsHealConfig) {}

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
      // Network-level failure (undici `fetch failed`, ECONNRESET, …) — as opposed to
      // a Telegram HTTP error response, which means the network itself is working.
      const ne: any = new Error(`Network error calling ${method}: ${(e as Error).message}`);
      ne.network = true;
      throw ne;
    }
    const json: any = await res.json().catch(() => null);
    if (!json?.ok) {
      // A deleted forum topic: every send into it fails with this. The user
      // already made their choice in the UI — let the caller retire the conv.
      // Only trust the error from topic-targeting methods (whitelist) so an
      // unrelated "message thread not found" from another method can't purge a
      // conversation we can't undo the loss of.
      if (
        this.onThreadNotFound &&
        THREAD_TARGETING_METHODS.has(method) &&
        typeof (body as any)?.message_thread_id === "number" &&
        /message thread not found/i.test(json?.description ?? "")
      ) {
        try {
          this.onThreadNotFound((body as any).chat_id, (body as any).message_thread_id);
        } catch {
          /* the callback must never break the send path */
        }
      }
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

  /** Resolve a file_id (document/photo/…) to a short-lived path on Telegram's servers. */
  async getFile(fileId: string): Promise<{ file_path: string; file_size?: number }> {
    return this.api("getFile", { file_id: fileId });
  }

  /**
   * Stream a Bot API file (`https://api.telegram.org/file/bot<token>/<filePath>`,
   * a path from getFile) to disk. Guards: the body is aborted and the partial
   * file removed when it exceeds `maxBytes`; the whole transfer is capped at
   * `timeoutMs`. Returns the number of bytes actually written.
   */
  async downloadFile(
    filePath: string,
    dest: string,
    opts: { maxBytes: number; timeoutMs: number },
  ): Promise<number> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    const out = createWriteStream(dest, { mode: 0o644 });
    let bytes = 0;
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      for await (const chunk of res.body) {
        const c = chunk as Uint8Array;
        bytes += c.byteLength;
        if (bytes > opts.maxBytes) {
          ac.abort();
          throw new Error(`download aborted: exceeds ${opts.maxBytes} bytes`);
        }
        if (!out.write(c)) await new Promise<void>((r) => out.once("drain", r));
      }
      await new Promise<void>((resolveP, reject) => {
        out.once("error", reject);
        out.end(resolveP);
      });
      return bytes;
    } catch (e) {
      // A partial file is useless — remove it, then surface the error.
      try {
        unlinkSync(dest);
      } catch {
        /* may not exist yet */
      }
      throw e;
    } finally {
      clearTimeout(timer);
      out.destroy();
    }
  }

  /** Register the /command autocomplete menu shown while the user types "/". */
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    return this.api("setMyCommands", { commands });
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
   * Stream a LIVE preview of the in-progress reply (Bot API 10.1+
   * `sendMessageDraft`). The draft is EPHEMERAL (~30 s) and is wiped
   * automatically the moment ANY regular message is sent to the chat — so the
   * final reply clears it with no explicit "clear" call. Re-sending the same
   * draft_id animates in place; a new draft_id replaces without animation.
   * `text === ""` renders the client's "Thinking…" placeholder. `canStop` shows
   * the user a native stop button (→ `stopped_message_generation` update).
   *
   * Pure preview layer: best-effort, so EVERY error is swallowed (returns
   * false) and a failed preview can never break the event loop or the
   * final-reply path.
   */
  async sendMessageDraft(
    to: ConvKey | number,
    draftID: number,
    text: string,
    opts: { canStop?: boolean } = {},
  ): Promise<boolean> {
    try {
      await this.api("sendMessageDraft", {
        ...dest(to),
        draft_id: draftID,
        text,
        ...(opts.canStop ? { can_stop: true } : {}),
      });
      return true;
    } catch {
      // Best-effort preview: a deleted topic / rate limit / bad param must not
      // throw into the OpenCode event loop. (A "message thread not found" here
      // still fires onThreadNotFound via the api() layer before we swallow it.)
      return false;
    }
  }

  /**
   * Send a final model reply as a native rich message (Telegram Bot API 10.1+):
   * `markdown` is parsed server-side as GFM, so no manual HTML conversion and a
   * 32 768-char limit instead of 4 096. Mirrors sendMessage's dest() chat_id +
   * message_thread_id split; resolves to the Telegram message_id (like
   * sendMessageId) so the reaction UX can index the sent message.
   */
  async sendRich(to: ConvKey | number, markdown: string, opts: { reply_markup?: unknown } = {}): Promise<number> {
    const res = await this.api<{ message_id: number }>("sendRichMessage", {
      ...dest(to),
      rich_message: { markdown },
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
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

  /**
   * Same as editMessageText but SURFACES 400 errors (including "message to edit
   * not found" when the user deleted the card) so callers can tell a vanished
   * card from a no-op edit and fall back to a fresh message.
   */
  async editMessageTextStrict(
    to: ConvKey | number,
    messageId: number,
    text: string,
    opts: Record<string, unknown> = {},
  ): Promise<void> {
    await this.api("editMessageText", {
      chat_id: parseConv(to).chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
  }

  /**
   * Remove (or replace) an inline keyboard on a message, keeping its text — used
   * to take the "⏯ Chạy tiếp" button off a failure message after it is tapped,
   * so the one-shot button can't be clicked again or go stale after a /new.
   */
  async editMessageReplyMarkup(to: ConvKey | number, messageId: number, opts: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.api("editMessageReplyMarkup", {
        chat_id: parseConv(to).chatId,
        message_id: messageId,
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

  /** Reopen a closed topic. A no-op if it is already open, so it is safe to call often. */
  async openForumTopic(to: ConvKey): Promise<void> {
    const { chatId, threadId } = parseConv(to);
    if (!threadId) return;
    await this.api("openForumTopic", { chat_id: chatId, message_thread_id: threadId }).catch(() => {});
  }

  async deleteForumTopic(to: ConvKey): Promise<void> {
    const { chatId, threadId } = parseConv(to);
    if (!threadId) return;
    await this.api("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  /**
   * Set ONE emoji reaction on a message (works on the bot's own and the
   * user's messages, in topics). Fire-and-log: resolves false on any error
   * (bad emoji, rate limit, deleted message) and never throws — reactions
   * are cosmetic and must not break the paths that use them.
   */
  async setReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    try {
      await this.api("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
      return true;
    } catch (e) {
      log(`setReaction(${emoji}) chat=${chatId} msg=${messageId} failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /**
   * Long-polling loop. Each update is handed to `handler`; the handler is
   * awaited so it should return quickly for long-running work (spawn it,
   * don't block here). Retries with backoff on transient errors, honors 429.
   */
  async poll(handler: (u: Update) => Promise<void> | void, opts: PollOptions = {}): Promise<void> {
    log("Telegram polling started");
    if (this.healCfg) {
      this.healState = freshHealState();
      this.onDnsHeal = opts.onDnsHeal;
    }
    while (!this.stopped) {
      let updates: Update[] = [];
      try {
        updates =
          (await this.api<Update[]>("getUpdates", {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query", "stopped_message_generation", "message_reaction"],
          }, this.abort.signal)) ?? [];
        if (this.healState) recordSuccess(this.healState);
      } catch (e) {
        if (this.stopped) break;
        const err = e as any;
        if (err?.name === "AbortError") break;
        // Track network-level failures for the DNS self-heal (see src/dns-heal.ts).
        // A Telegram HTTP error (4xx/5xx, incl. 429) is a successful round-trip,
        // so it resets the failure streak instead.
        if (this.healCfg && this.healState) {
          const networkish = err?.network === true || /fetch failed/i.test(err?.message ?? "");
          if (networkish) {
            recordNetworkFailure(this.healState, Date.now());
            if (shouldHeal(this.healState, Date.now(), this.healCfg)) void this.runDnsHeal();
          } else {
            recordSuccess(this.healState);
          }
        }
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
          if (u.message_reaction) {
            // No message/conv to enqueue under — dispatch through the dedicated
            // callback instead (onMessageReaction), like onThreadNotFound.
            if (this.onMessageReaction) await this.onMessageReaction(u.message_reaction);
          } else {
            await handler(u);
          }
        } catch (e) {
          error("Update handler error:", (e as Error)?.message ?? e);
        }
      }
    }
    log("Telegram polling stopped");
  }

  /**
   * Restart systemd-resolved to drop a stale VPN DNS server (see src/dns-heal.ts).
   * Fire-and-forget: the polling loop keeps retrying while this runs. At most one
   * heal is ever in flight (HealState.healInFlight) and heals are rate-limited by
   * the cooldown, so it cannot storm. Never throws.
   */
  private async runDnsHeal(): Promise<void> {
    const st = this.healState;
    const cfg = this.healCfg;
    if (!st || !cfg) return;
    const failures = st.consecutiveFailures;
    startHeal(st, Date.now());
    let restarted = false;
    log(`DNS heal: ${failures} fetch failures in a row (heal check #${st.healCount})`);
    try {
      // Read-only probe first: restart ONLY if the stale VPN DNS is really still
      // configured. Without that proof this is an ordinary outage (Telegram or
      // the internet is down) and restarting systemd-resolved would not help.
      if ((await execCapture("command -v resolvectl")).code !== 0) {
        log("DNS heal: resolvectl not found — skipping (cannot verify stale DNS)");
        return;
      }
      const probe = await execCapture(DNS_PROBE_CMD);
      if (!probeShowsStaleDns(probe.out, cfg.staleIp)) {
        log("DNS heal: no stale VPN DNS detected — not restarting systemd-resolved");
        return;
      }
      log("DNS heal: stale VPN DNS still configured — restarting systemd-resolved");
      const res = await execCapture(DNS_HEAL_CMD);
      restarted = res.code === 0;
      log(`DNS heal: ${DNS_HEAL_CMD} → exit ${res.code}${res.code === 0 ? "" : ` (${(res.out.split("\n")[0] ?? "").slice(0, 200)})`}`);
    } catch (e) {
      log("DNS heal: command failed:", (e as Error)?.message ?? e);
    } finally {
      finishHeal(st, Date.now());
      // Surface ONE user notice per ACTUAL restart, after the heal finished so the
      // network has a chance to be back when the message is sent (best-effort).
      if (restarted && this.onDnsHeal) {
        try {
          void Promise.resolve(this.onDnsHeal({ failures, healNumber: st.healCount })).catch((e) =>
            warn("DNS heal notice failed:", (e as Error)?.message ?? e),
          );
        } catch (e) {
          warn("DNS heal notice failed:", (e as Error)?.message ?? e);
        }
      }
    }
  }
}
