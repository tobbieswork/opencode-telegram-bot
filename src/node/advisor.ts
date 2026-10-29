/**
 * Claude advisor threads — the hub side of the "Claude as a second opinion"
 * feature. Each thread is ONE forum topic bound to ONE Claude session on the
 * Mac (reached over Tailscale). Unlike a worker, a thread has NO OpenCode
 * session: the "session" is the Claude CLI session on the Mac, resumed with
 * `--resume`. It is pure advice — it answers questions, it does not run code.
 *
 * Lifecycle:
 *   startThread()  → create a topic, run a fresh `claude -p`, show the answer
 *   followUp()     → resume the session (`--resume`) with a new question
 *   forget()       → ask the Mac to drop the session (called on /prune)
 *
 * A per-session turn cap (cfg.advisorMaxTurnsPerSession) bounds how long one
 * thread can be resumed — each resume re-reads the whole Claude context, so a
 * long session costs more per turn. When the cap is hit the next follow-up is
 * refused and a new thread is opened instead.
 */
import { convKey, parseConv, type ConvKey } from "../conv.js";
import type { StateManager } from "../state.js";
import type { Telegram } from "../telegram.js";
import type { Config } from "../config.js";
import { TOPIC_COLORS as COLORS } from "../telegram.js";
import { esc } from "../format.js";
import { log } from "../logger.js";
import { AdvisorError, type AdvisorAnswer, type AdvisorEndpoint } from "./advisor-client.js";
import { askClaude, forgetClaude } from "./advisor-client.js";

/** A client to the Mac advisor daemon — injectable so tests can fake it. */
export interface AdvisorClient {
  ask(req: { sessionId?: string; message: string; context?: string }): Promise<AdvisorAnswer>;
  forget(sessionId: string): Promise<void>;
}

/** The narrow slice of the bot the advisor needs. */
export interface AdvisorHost {
  tg: Pick<Telegram, "createForumTopic" | "deleteForumTopic" | "closeForumTopic" | "openForumTopic">;
  st: StateManager;
  cfg: Config;
  sendHtml(conv: ConvKey, html: string): Promise<void>;
  startTyping?(conv: ConvKey): void;
}

export interface ThreadSummary {
  conv: ConvKey;
  title: string;
  turns: number;
  lastActive: number;
  sessionId: string;
}

export class Advisor {
  private client: AdvisorClient;

  constructor(
    private h: AdvisorHost,
    ep: AdvisorEndpoint,
    client?: AdvisorClient,
  ) {
    // Default client wraps the HTTP client with the configured endpoint.
    this.client =
      client ?? {
        ask: (r) => askClaude(ep, r),
        forget: (sid) => forgetClaude(ep, sid),
      };
  }

  private cap(): number {
    return this.h.cfg.advisorMaxTurnsPerSession;
  }

  private topicName(title: string): string {
    const t = title.replace(/\s+/g, " ").trim();
    return `🧠 Claude: ${t.length > 40 ? t.slice(0, 40).trimEnd() + "…" : t}`;
  }

  /** Open a new advisor thread: topic + a fresh Claude session + first answer. */
  async startThread(opts: {
    chat: ConvKey;
    title: string;
    message: string;
    context?: string;
  }): Promise<{ conv: ConvKey; threadId: number; answer: AdvisorAnswer }> {
    const { chatId } = parseConv(opts.chat);
    let threadId: number;
    try {
      threadId = await this.h.tg.createForumTopic(chatId, this.topicName(opts.title), COLORS[3]);
    } catch (e) {
      throw new Error(`Không tạo được topic cố vấn (${(e as Error).message}). Cần supergroup bật Topics và bot là admin.`);
    }
    const conv = convKey(chatId, threadId);
    const now = Date.now();
    this.h.st.set(conv, { advisor: { title: opts.title, sessionId: "", turns: 0, lastActive: now, createdAt: now } });
    this.h.startTyping?.(conv);
    try {
      const answer = await this.client.ask({ message: opts.message, context: opts.context });
      const st = this.h.st.get(conv);
      st.advisor = {
        title: opts.title,
        sessionId: answer.sessionId,
        turns: 1,
        lastActive: Date.now(),
        createdAt: now,
      };
      this.h.st.set(conv, st);
      await this.h.sendHtml(
        conv,
        `<b>${esc(this.topicName(opts.title))}</b>\n\n📝 ${esc(opts.message)}\n\n${esc(answer.answer)}`,
      );
      return { conv, threadId, answer };
    } catch (e) {
      // Nothing useful was produced: undo the topic so a retry is clean.
      await this.h.tg.deleteForumTopic(conv).catch(() => {});
      this.h.st.clear(conv);
      throw e;
    }
  }

  /** A follow-up question in an existing thread (resumes the Claude session). */
  async followUp(conv: ConvKey, message: string): Promise<{ answer: AdvisorAnswer; capped: boolean }> {
    const st = this.h.st.get(conv);
    const adv = st.advisor;
    if (!adv) throw new Error("Topic này không phải thread cố vấn Claude.");
    if (adv.turns >= this.cap()) {
      const html =
        `⛔ Đã đủ ${this.cap()} lượt trong thread này — Claude sẽ không nhớ các câu trước nữa.\n` +
        "Mở thread mới để bắt đầu lại (Manager gọi <code>consult</code> không truyền <code>threadId</code>, hoặc dùng /ask).";
      await this.h.sendHtml(conv, html).catch(() => {});
      return {
        answer: {
          answer: html,
          status: "done",
          sessionId: adv.sessionId,
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
          incomplete: false,
        },
        capped: true,
      };
    }
    this.h.startTyping?.(conv);
    let answer: AdvisorAnswer;
    try {
      answer = await this.client.ask({ sessionId: adv.sessionId, message });
    } catch (e) {
      // An offline Mac / daemon error should not leave the user hanging: report
      // the reason and keep the thread (the user can retry).
      const msg = e instanceof AdvisorError ? e.message : String(e);
      await this.h.sendHtml(conv, `⚠️ Không hỏi được Claude: ${esc(msg)}`).catch(() => {});
      throw e;
    }
    const next = {
      ...adv,
      sessionId: answer.sessionId || adv.sessionId,
      turns: adv.turns + 1,
      lastActive: Date.now(),
    };
    this.h.st.set(conv, { ...st, advisor: next });
    await this.h.sendHtml(conv, esc(answer.answer)).catch(() => {});
    return { answer, capped: false };
  }

  /** Ask the Mac to forget the thread's Claude session. Does NOT delete the topic. */
  async forget(conv: ConvKey): Promise<void> {
    const adv = this.h.st.peek(conv)?.advisor;
    if (!adv?.sessionId) return;
    try {
      await this.client.forget(adv.sessionId);
    } catch (e) {
      log(`advisor forget failed for ${conv}: ${(e as Error).message}`);
    }
  }

  /** Every open advisor thread of a chat (its top level plus all its topics). */
  listThreads(chat: ConvKey): ThreadSummary[] {
    return this.h.st
      .convsOfChat(chat)
      .filter(([, s]) => s.advisor)
      .map(([conv, s]) => ({
        conv,
        title: s.advisor!.title,
        turns: s.advisor!.turns,
        lastActive: s.advisor!.lastActive,
        sessionId: s.advisor!.sessionId,
      }))
      .sort((a, b) => b.lastActive - a.lastActive);
  }
}
