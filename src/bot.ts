import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { Telegram, Update, CallbackQuery } from "./telegram.js";
import { OpenCodeCtl } from "./opencode.js";
import { StateManager, ChatState } from "./state.js";
import { Config } from "./config.js";
import { esc, stripTags, chunk, trunc, mdToHtmlChunks } from "./format.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "./fsbrowser.js";
import { log, warn, error } from "./logger.js";

/** Agents shown to the user (the rest are internal OpenCode roles). */
const AGENT_WHITELIST = ["build", "general", "explore", "plan"];

/** Directory buttons shown per page in the folder browser. */
const BROWSE_PAGE_SIZE = 12;
/** Directory buttons per row in the folder browser. */
const BROWSE_COLUMNS = 2;

/**
 * Preamble prepended to the FIRST prompt of each session so the agent knows it is
 * headless (driven via Telegram) and should ask decisions through the `question`
 * tool — which we relay to the user as Telegram buttons — one question at a time.
 */
const QUESTIONS_PREAMBLE =
  "[System note: You are running headless, driven through Telegram — the user has no terminal. " +
  "When you need a decision or input from the user, ask with the `question` tool using clear " +
  "multiple-choice options, ONE question at a time; the user answers via Telegram buttons. " +
  "Prefer asking over guessing when genuinely ambiguous.]";

/** True when an error is a network-level "Transport: fetch failed" blip. */
function isTransportError(e: any): boolean {
  if (!e) return false;
  if (e.reason === "Transport" || e.cause?.reason === "Transport") return true;
  const msg = `${e.cause?.message ?? ""} ${e.message ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|EPROTO|ETIMEDOUT|EAI_AGAIN|socket hang up|network .*unreachable|UND_ERR_[A-Z]+/i.test(
    msg,
  );
}

type Btn = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Btn[][] };

/** In-memory state of the folder browser, one per chat. */
interface BrowseState {
  path: string;
  showHidden: boolean;
  items: DirItem[];
  page: number;
  view: "list" | "choose" | "done";
  /** One-off message shown above the listing (e.g. a clamped path). */
  note?: string;
  /** Set when the directory could not be read. */
  error?: string;
  /** Result of the last "open this folder" action. */
  result?: string;
  /** True once a session was started from this folder. */
  opened: boolean;
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
  chatId: number;
  messageId?: number;
  fields: QField[];
  index: number;
  answers: Record<string, any>;
  /** Set (to the field index) while waiting for the user to type a custom answer. */
  waitingCustom?: number;
}

/**
 * Glue between Telegram and OpenCode. Owns per-chat state and the in-flight
 * prompt task, so a running prompt never blocks the polling loop and /stop
 * can interrupt it.
 */
export class Bot {
  private inflight = new Map<number, AbortController>();
  private browsers = new Map<number, BrowseState>();
  private questionForms = new Map<string, QuestionFormState>();

  constructor(
    private tg: Telegram,
    private oc: OpenCodeCtl,
    private st: StateManager,
    private cfg: Config,
  ) {}

  /** Begin relaying OpenCode question forms to Telegram. Called once from index.ts. */
  start(): void {
    this.oc.subscribeEvents((ev) => this.onOpenCodeEvent(ev), (e) => warn("event stream:", e?.message ?? e));
  }

  private allowed(uid?: number): boolean {
    if (this.cfg.allowAny) return true;
    return uid !== undefined && this.cfg.allowedUserIds.includes(uid);
  }

  async handle(u: Update): Promise<void> {
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    const msg = u.message ?? u.edited_message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id as number;
    const uid = msg.from?.id as number | undefined;
    const text = (msg.text as string).trim();
    if (!text) return;
    if (!this.allowed(uid)) {
      log(`Denied message from uid=${uid} chat=${chatId}`);
      await this.tg
        .sendMessage(chatId, "⛔ <b>Not authorized.</b> You are not on the allowlist.")
        .catch(() => {});
      return;
    }
    const state = this.st.get(chatId);
    if (!state.directory) state.directory = this.cfg.opencodeDirectory;

    if (text.startsWith("/")) await this.handleCommand(chatId, text, state);
    else if (await this.handleFormText(chatId, text)) return;
    else await this.runPrompt(chatId, text, state);
  }

  // ── send helpers ─────────────────────────────────────────────────────────
  /** Send short, already-formatted HTML (commands, status). */
  private async sendHtml(chatId: number, html: string): Promise<void> {
    for (const c of chunk(html, this.cfg.replyMaxLen)) await this.tg.sendMessage(chatId, c);
  }
  /** Send a long model reply: render its Markdown as Telegram HTML, then chunk. */
  private async sendReply(chatId: number, text: string): Promise<void> {
    const clean = stripTags(text ?? "");
    if (!clean) return;
    for (const c of mdToHtmlChunks(clean, this.cfg.replyMaxLen)) await this.tg.sendMessage(chatId, c);
  }

  // ── command dispatch ─────────────────────────────────────────────────────
  private async handleCommand(chatId: number, raw: string, state: ChatState): Promise<void> {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "/start":
      case "/help":
        return this.cmdHelp(chatId);
      case "/new":
        return this.cmdNew(chatId, state);
      case "/ls":
      case "/sessions":
        return this.cmdList(chatId);
      case "/use":
        return this.cmdUse(chatId, arg, state);
      case "/dir":
        return this.cmdDir(chatId, arg, state);
      case "/browse":
      case "/b":
        return this.cmdBrowse(chatId, arg, state);
      case "/models":
        return this.cmdModels(chatId);
      case "/model":
        return this.cmdModel(chatId, arg, state);
      case "/agents":
        return this.cmdAgents(chatId);
      case "/agent":
        return this.cmdAgent(chatId, arg, state);
      case "/stop":
        return this.cmdStop(chatId, state);
      case "/status":
        return this.cmdStatus(chatId, state);
      case "/history":
        return this.cmdHistory(chatId, state);
      case "/clear":
        return this.cmdClear(chatId, state);
      default:
        return this.tg.sendMessage(chatId, `Unknown command: ${esc(cmd)}\nSend /help`);
    }
  }

  // ── the long-running prompt ──────────────────────────────────────────────
  private async runPrompt(chatId: number, text: string, state: ChatState): Promise<void> {
    if (this.inflight.has(chatId)) {
      await this.tg.sendMessage(chatId, "⏳ Still working on the previous message. Send /stop to interrupt.");
      return;
    }
    let sid = state.sessionID;
    if (!sid) {
      this.tg.sendChatAction(chatId, "typing");
      sid = await this.oc.createSession(state.directory || this.cfg.opencodeDirectory);
      if (state.model) await this.oc.setModel(sid, state.model).catch((e) => warn("setModel:", e?.message));
      if (state.agent) await this.oc.setAgent(sid, state.agent).catch((e) => warn("setAgent:", e?.message));
      this.st.set(chatId, { sessionID: sid });
    }
    // Inject the "ask via question tool" preamble once per session so the agent
    // knows it is headless and should surface decisions as answerable questions.
    let promptText = text;
    if (this.cfg.guideQuestions && !state.guided) {
      promptText = QUESTIONS_PREAMBLE + "\n\n" + text;
      this.st.set(chatId, { guided: true });
    }
    const ac = new AbortController();
    this.inflight.set(chatId, ac);
    this.tg.sendChatAction(chatId, "typing");
    log(`[chat ${chatId}] prompt on ${sid} (${text.length} chars)`);
    // Fire-and-forget: don't block the polling loop; /stop aborts `ac`.
    void this.runPromptTask(chatId, sid, promptText, ac).catch((e) => error("prompt task:", e?.message));
  }

  private async runPromptTask(chatId: number, sid: string, text: string, ac: AbortController): Promise<void> {
    const run = () => this.oc.promptAndWait(sid, text, { signal: ac.signal });
    try {
      let res;
      try {
        res = await run();
      } catch (e) {
        // A persistent "Transport: fetch failed" usually means the OpenCode
        // service restarted on a new port (stale URL). Re-discover and retry
        // once; the retry rides out the reconnect.
        if (!ac.signal.aborted && isTransportError(e)) {
          warn("prompt failed (transport) — reconnecting to OpenCode and retrying…");
          await this.oc.reconnect();
          res = await run();
        } else {
          throw e;
        }
      }
      const reply = res.reply || (res.interrupted ? "(interrupted — no text produced yet)" : "(no text reply)");
      await this.sendReply(chatId, reply);
      // A quiet italic footer. The <i> tags are meant to render (HTML mode), so
      // we do NOT escape the whole string — only the server-supplied outcome text.
      const meta = `<i>${esc(res.outcome ?? "")} · ${(res.elapsedMs / 1000).toFixed(1)}s${res.interrupted ? " · stopped" : ""}</i>`;
      await this.tg.sendMessage(chatId, meta).catch(() => {});
    } catch (e) {
      error("prompt error:", (e as Error)?.message);
      const msg = isTransportError(e)
        ? "⚠️ Không thể nối tới OpenCode (service có thể đang restart / chưa chạy). Hẵng thử lại sau, hoặc kiểm tra `opencode service status`."
        : `❌ Error: ${esc((e as Error).message)}`;
      await this.tg.sendMessage(chatId, msg).catch(() => {});
    } finally {
      this.inflight.delete(chatId);
    }
  }

  private async stopCurrent(chatId: number): Promise<void> {
    const ac = this.inflight.get(chatId);
    if (ac) ac.abort();
  }

  // ── commands ─────────────────────────────────────────────────────────────
  private async cmdHelp(chatId: number): Promise<void> {
    const txt = [
      "<b>OpenCode Remote</b> — drive your OpenCode agent from Telegram.",
      "",
      "Just send me a message and I'll run it in OpenCode and reply with the result.",
      "",
      "<b>Sessions</b>",
      "/new — start a fresh session in the current directory",
      "/ls — list recent sessions",
      "/use &lt;id&gt; — switch to a session",
      "/dir [path] — show / set the working directory",
      "/browse [path] — duyệt thư mục bằng nút bấm và mở OpenCode tại đó",
      "",
      "<b>Model &amp; agent</b>",
      "/models — list models · /model &lt;id&gt; — set model",
      "/agents — list agents · /agent &lt;id&gt; — set agent",
      "",
      "<b>Câu hỏi (questions)</b>",
      "Khi OpenCode cần hỏi bạn, chọn đáp án bằng nút bấm hoặc tự gõ.",
      "",
      "<b>Control</b>",
      "/stop — interrupt the running task",
      "/history — show recent messages",
      "/status — what I'm connected to",
      "/clear — reset this chat's state",
    ].join("\n");
    await this.sendHtml(chatId, txt);
  }

  private async cmdNew(chatId: number, state: ChatState): Promise<void> {
    await this.stopCurrent(chatId);
    const dir = state.directory || this.cfg.opencodeDirectory;
    this.tg.sendChatAction(chatId, "typing");
    const sessionID = await this.oc.createSession(dir);
    if (state.model) await this.oc.setModel(sessionID, state.model).catch((e) => warn("setModel:", e?.message));
    if (state.agent) await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
    this.st.set(chatId, { sessionID, directory: dir });
    await this.tg.sendMessage(chatId, `🆕 New session <code>${sessionID}</code>\ndir: <code>${esc(dir)}</code>`);
  }

  private async cmdList(chatId: number): Promise<void> {
    const sessions = await this.oc.listSessions();
    if (!sessions.length) return this.tg.sendMessage(chatId, "No sessions yet. Send /new.");
    const cur = this.st.get(chatId).sessionID;
    const lines = sessions
      .slice(0, 15)
      .map((s) => `${s.id === cur ? "▶️ " : ""}<code>${s.id}</code>${s.title ? " — " + esc(s.title) : ""}`);
    const active = cur ? `\n\nCurrent: <code>${cur}</code>` : "\n\nNo current session — send /new";
    await this.sendHtml(chatId, `<b>Sessions (${sessions.length})</b>\n${lines.join("\n")}${active}`);
  }

  private async cmdUse(chatId: number, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.tg.sendMessage(chatId, "Usage: /use <session-id>");
    this.st.set(chatId, { sessionID: arg });
    void state;
    await this.tg.sendMessage(chatId, `✅ Now using session <code>${esc(arg)}</code>`);
  }

  private async cmdDir(chatId: number, arg: string, state: ChatState): Promise<void> {
    if (!arg) {
      return this.tg.sendMessage(chatId, `📁 Current directory:\n<code>${esc(state.directory || this.cfg.opencodeDirectory)}</code>`);
    }
    const p = isAbsolute(arg) ? arg : resolve(this.cfg.opencodeDirectory, arg);
    if (!existsSync(p)) return this.tg.sendMessage(chatId, `❌ No such directory: <code>${esc(p)}</code>`);
    this.st.set(chatId, { directory: p });
    await this.tg.sendMessage(
      chatId,
      `📁 Directory set to <code>${esc(p)}</code>\n(used for the next /new)\nTip: /browse to pick a folder with buttons.`,
    );
  }

  // ── folder browser ───────────────────────────────────────────────────────
  /**
   * Open the folder browser at `arg` (or the chat's current directory). The
   * browser lives in a single message: every button tap edits that message
   * instead of posting new ones, so the chat stays readable.
   */
  private async cmdBrowse(chatId: number, arg: string, state: ChatState): Promise<void> {
    const roots = this.cfg.browseRoots;
    if (!roots.length) return this.tg.sendMessage(chatId, "❌ Không có thư mục nào được phép duyệt.");
    const requested = arg
      ? resolve(this.cfg.opencodeDirectory, arg)
      : state.directory || this.cfg.opencodeDirectory;
    let path = resolve(requested);
    let note: string | undefined;
    if (!isUnderRoot(path, roots)) {
      const owner = roots.find((r) => isUnderRoot(path, [r]));
      path = owner ?? roots[0];
      note = `⚠️ <code>${esc(requested)}</code> nằm ngoài vùng được duyệt — đã mở tại <code>${esc(path)}</code>.`;
    }
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return this.tg.sendMessage(chatId, `❌ Không phải thư mục: <code>${esc(path)}</code>`);

    const b: BrowseState = { path, showHidden: false, items: [], page: 0, view: "list", opened: false, note };
    await this.reloadBrowse(b);
    this.browsers.set(chatId, b);
    const v = this.renderBrowse(b);
    await this.tg.sendMessage(chatId, v.text, { reply_markup: v.keyboard });
  }

  /** Re-read the current directory and keep the page index in range. */
  private async reloadBrowse(b: BrowseState): Promise<void> {
    try {
      b.items = await listDirs(b.path, b.showHidden);
      b.error = undefined;
    } catch (e) {
      b.items = [];
      b.error = `⚠️ Không đọc được thư mục: ${esc((e as Error).message)}`;
    }
    const maxPage = Math.max(0, Math.ceil(b.items.length / BROWSE_PAGE_SIZE) - 1);
    if (b.page > maxPage) b.page = maxPage;
  }

  /** Build the text + inline keyboard for the current browser view. */
  private renderBrowse(b: BrowseState): { text: string; keyboard: Keyboard } {
    if (b.view === "choose") {
      return {
        text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, "", "<b>Chọn cách mở thư mục này:</b>"].join("\n"),
        keyboard: {
          inline_keyboard: [
            [{ text: "📁 Chỉ đặt thư mục", callback_data: "bs:setdir" }],
            [{ text: "🚀 Đặt + mở session mới", callback_data: "bs:setsess" }],
            [
              { text: "↩️ Quay lại", callback_data: "bs:list" },
              { text: "❌ Đóng", callback_data: "bs:close" },
            ],
          ],
        },
      };
    }

    if (b.view === "done") {
      const rows: Btn[][] = [];
      if (!b.opened) rows.push([{ text: "🚀 Mở session mới tại đây", callback_data: "bs:setsess" }]);
      rows.push([{ text: "📂 Duyệt tiếp", callback_data: "bs:list" }]);
      rows.push([{ text: "❌ Đóng", callback_data: "bs:close" }]);
      return { text: b.result ?? "✅ Xong", keyboard: { inline_keyboard: rows } };
    }

    // list view
    const pageCount = Math.max(1, Math.ceil(b.items.length / BROWSE_PAGE_SIZE));
    const start = b.page * BROWSE_PAGE_SIZE;
    const slice = b.items.slice(start, start + BROWSE_PAGE_SIZE);
    const rows: Btn[][] = [];
    for (let i = 0; i < slice.length; i += BROWSE_COLUMNS) {
      rows.push(
        slice.slice(i, i + BROWSE_COLUMNS).map((it, j) => ({
          text: `📂 ${trunc(it.name, 18)}`,
          callback_data: `bs:nav:${start + i + j}`,
        })),
      );
    }

    const nav: Btn[] = [];
    if (parentWithin(b.path, this.cfg.browseRoots)) {
      nav.push({ text: "⬆️ Lên", callback_data: "bs:up" });
    }
    nav.push({ text: b.showHidden ? "🙈 Ẩn file ẩn" : "👁 Hiện file ẩn", callback_data: "bs:hid" });
    nav.push({ text: "✅ Mở tại đây", callback_data: "bs:open" });
    rows.push(nav);

    if (pageCount > 1) {
      rows.push([
        { text: "◀️", callback_data: `bs:pg:${b.page - 1}` },
        { text: `${b.page + 1}/${pageCount}`, callback_data: "bs:noop" },
        { text: "▶️", callback_data: `bs:pg:${b.page + 1}` },
      ]);
    }
    rows.push([{ text: "❌ Đóng", callback_data: "bs:close" }]);

    const meta: string[] = [];
    if (b.note) meta.push(b.note);
    if (b.error) meta.push(b.error);
    meta.push(
      `<i>${b.items.length} thư mục con${pageCount > 1 ? ` · trang ${b.page + 1}/${pageCount}` : ""}</i>`,
    );
    meta.push("Chạm một thư mục để vào · ✅ để mở OpenCode tại đây");
    return {
      text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, ...meta].join("\n"),
      keyboard: { inline_keyboard: rows },
    };
  }

  /** Handle a button tap on the browser message. */
  private async handleCallback(cb: CallbackQuery): Promise<void> {
    if (!this.allowed(cb.from?.id)) {
      await this.tg.answerCallbackQuery(cb.id, "⛔ Không được phép");
      return;
    }
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;
    const data = cb.data ?? "";
    if (!chatId) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    if (data.startsWith("fq:")) {
      await this.handleFormCallback(cb, chatId, messageId);
      return;
    }
    if (!data.startsWith("bs:")) {
      await this.tg.answerCallbackQuery(cb.id);
      return;
    }
    const b = this.browsers.get(chatId);
    if (!b) {
      await this.tg.answerCallbackQuery(cb.id, "Phiên duyệt đã đóng — gửi /browse");
      return;
    }

    const [, action, arg] = data.split(":");
    let close = false;
    try {
      switch (action) {
        case "nav": {
          const item = b.items[Number(arg)];
          if (!item) throw new Error("Mục không còn tồn tại — gửi /browse để tải lại.");
          b.path = item.path;
          b.page = 0;
          b.view = "list";
          b.note = undefined;
          await this.reloadBrowse(b);
          break;
        }
        case "up": {
          const parent = parentWithin(b.path, this.cfg.browseRoots);
          if (parent) {
            b.path = parent;
            b.page = 0;
            b.view = "list";
            await this.reloadBrowse(b);
          }
          break;
        }
        case "pg": {
          b.page = Math.max(0, Number(arg) || 0);
          break;
        }
        case "hid": {
          b.showHidden = !b.showHidden;
          b.page = 0;
          await this.reloadBrowse(b);
          break;
        }
        case "open": {
          b.view = "choose";
          break;
        }
        case "list": {
          b.view = "list";
          break;
        }
        case "setdir": {
          this.st.set(chatId, { directory: b.path });
          b.view = "done";
          b.opened = false;
          b.result = [
            `✅ Đã đặt thư mục làm việc:\n<code>${esc(b.path)}</code>`,
            "",
            "Session mới sẽ chạy ở đây. Gõ /new hoặc bấm “🚀 Mở session mới tại đây”.",
          ].join("\n");
          break;
        }
        case "setsess": {
          const state = this.st.get(chatId);
          await this.stopCurrent(chatId);
          const sessionID = await this.oc.createSession(b.path);
          if (state.model) {
            await this.oc.setModel(sessionID, state.model).catch((e) => warn("setModel:", e?.message));
          }
          if (state.agent) {
            await this.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
          }
          this.st.set(chatId, { sessionID, directory: b.path });
          b.view = "done";
          b.opened = true;
          b.result = [
            `🚀 Đã mở session <code>${esc(sessionID)}</code>`,
            `📁 <code>${esc(b.path)}</code>`,
            "",
            "Gửi tin nhắn để bắt đầu làm việc.",
          ].join("\n");
          break;
        }
        case "close": {
          close = true;
          break;
        }
        default:
          break; // "noop" and anything unknown
      }
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
      return;
    }

    await this.tg.answerCallbackQuery(cb.id);
    if (close) {
      this.browsers.delete(chatId);
      if (messageId) await this.tg.deleteMessage(chatId, messageId);
      return;
    }
    if (!messageId) return;
    const v = this.renderBrowse(b);
    await this.tg.editMessageText(chatId, messageId, v.text, { reply_markup: v.keyboard });
  }

  private async cmdModels(chatId: number): Promise<void> {
    const models = await this.oc.listModels();
    const cur = this.st.get(chatId).model?.id;
    const lines = models
      .slice(0, 25)
      .map((m) => `${cur === m.id ? "▶️ " : ""}<code>${m.id}</code>${m.name ? ` — ${esc(m.name)}` : ""}`);
    await this.sendHtml(chatId, `<b>Models (${models.length})</b> — first 25 shown.\n${lines.join("\n")}\n\nSet with /model &lt;id&gt;`);
  }

  private async cmdModel(chatId: number, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.cmdModels(chatId);
    const models = await this.oc.listModels();
    const m = models.find((x) => x.id === arg || `${x.providerID}/${x.id}` === arg);
    if (!m) return this.tg.sendMessage(chatId, `❌ Unknown model: <code>${esc(arg)}</code>. See /models.`);
    this.st.set(chatId, { model: { id: m.id, providerID: m.providerID } });
    if (state.sessionID) {
      await this.oc.setModel(state.sessionID, { id: m.id, providerID: m.providerID }).catch((e) =>
        error("setModel:", e?.message),
      );
      await this.tg.sendMessage(chatId, `✅ Model → <code>${esc(m.id)}</code> (applied to current session)`);
    } else {
      await this.tg.sendMessage(chatId, `✅ Model → <code>${esc(m.id)}</code> (applies on /new)`);
    }
  }

  private async cmdAgents(chatId: number): Promise<void> {
    const agents = await this.oc.listAgents();
    const cur = this.st.get(chatId).agent;
    const lines = agents
      .filter((a) => AGENT_WHITELIST.includes(a.id))
      .map((a) => `${cur === a.id ? "▶️ " : ""}<code>${a.id}</code>${a.description ? ` — ${esc(trunc(a.description, 44))}` : ""}`);
    await this.sendHtml(chatId, `<b>Agents</b>\n${lines.join("\n")}\n\nSet with /agent &lt;id&gt;`);
  }

  private async cmdAgent(chatId: number, arg: string, state: ChatState): Promise<void> {
    if (!arg) return this.cmdAgents(chatId);
    const agents = await this.oc.listAgents();
    if (!agents.some((a) => a.id === arg)) return this.tg.sendMessage(chatId, `❌ Unknown agent: <code>${esc(arg)}</code>. See /agents.`);
    this.st.set(chatId, { agent: arg });
    if (state.sessionID) {
      await this.oc.setAgent(state.sessionID, arg).catch((e) => error("setAgent:", e?.message));
      await this.tg.sendMessage(chatId, `✅ Agent → <code>${esc(arg)}</code> (applied to current session)`);
    } else {
      await this.tg.sendMessage(chatId, `✅ Agent → <code>${esc(arg)}</code> (applies on /new)`);
    }
  }

  private async cmdStop(chatId: number, state: ChatState): Promise<void> {
    await this.stopCurrent(chatId);
    if (state.sessionID) await this.oc.interrupt(state.sessionID).catch(() => {});
    await this.tg.sendMessage(chatId, "⏹️ Interrupted.");
  }

  private async cmdStatus(chatId: number, state: ChatState): Promise<void> {
    const info = await this.oc.serverInfo().catch(() => null);
    const busy = this.inflight.has(chatId);
    const lines = [
      `<b>OpenCode</b>${info?.version ? " v" + info.version : ""}`,
      `url: <code>${esc((info?.urls ?? [info?.url]).filter(Boolean).join(", ") || "?")}</code>`,
      `dir: <code>${esc(state.directory || this.cfg.opencodeDirectory)}</code>`,
      `session: ${state.sessionID ? `<code>${state.sessionID}</code>` : "none"}`,
      `model: ${state.model ? `<code>${state.model.id}</code>` : "default"}`,
      `agent: ${state.agent ? `<code>${state.agent}</code>` : "default"}`,
      `state: ${busy ? "⏳ busy" : "🟢 idle"}`,
    ];
    await this.sendHtml(chatId, lines.join("\n"));
  }

  private async cmdHistory(chatId: number, state: ChatState): Promise<void> {
    if (!state.sessionID) return this.tg.sendMessage(chatId, "No current session. Send /new.");
    const msgs = await this.oc.listMessages(state.sessionID).catch(() => [] as any[]);
    const sorted = [...msgs].sort((a: any, b: any) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    const recent = sorted.slice(-6);
    const lines = recent.map((m) => {
      if (m.type === "user") return "👤 " + esc(trunc(stripTags(m.text ?? ""), 300));
      if (m.type === "assistant") {
        const t = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
        return "🤖 " + esc(trunc(stripTags(t), 400));
      }
      return "· " + m.type;
    });
    await this.sendHtml(chatId, `<b>Recent messages</b>\n${lines.join("\n")}`);
  }

  private async cmdClear(chatId: number, state: ChatState): Promise<void> {
    await this.stopCurrent(chatId);
    void state;
    this.st.clear(chatId);
    for (const [formId, qf] of this.questionForms) {
      if (qf.chatId === chatId) this.questionForms.delete(formId);
    }
    await this.tg.sendMessage(chatId, "🧹 State cleared. Next message starts a fresh session.");
  }

  // ── question forms (the agent's `question` tool) ──────────────────────────
  /** Entry point for every OpenCode event; only question forms interest us. */
  private onOpenCodeEvent(ev: any): void {
    const t = ev?.type;
    if (t === "form.created") {
      const form = ev?.data?.form;
      if (form?.id && form?.sessionID) void this.onFormCreated(form);
    } else if (t === "form.replied" || t === "form.cancelled") {
      const formID = ev?.data?.id;
      if (formID) void this.onFormResolved(formID, t);
    }
  }

  /** A new question form appeared — relay its first field to the owning chat. */
  private async onFormCreated(form: any): Promise<void> {
    const sessionID = form.sessionID as string;
    const formID = form.id as string;
    if (this.questionForms.has(formID)) return;
    const chatKey = this.st.findChatBySession(sessionID);
    if (!chatKey) {
      warn(`form.created for session ${sessionID} with no mapped chat — ignoring`);
      return;
    }
    const chatId = Number(chatKey);
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
      await this.tg
        .sendMessage(chatId, "❓ OpenCode đang hỏi (không có lựa chọn) — xem /history để biết chi tiết.")
        .catch(() => {});
      return;
    }
    const qf: QuestionFormState = { formId: formID, sessionID, chatId, fields, index: 0, answers: {} };
    this.questionForms.set(formID, qf);
    const v = this.renderQuestion(qf);
    const messageId = await this.tg.sendMessageId(chatId, v.text, { reply_markup: v.keyboard }).catch(() => -1);
    qf.messageId = messageId;
  }

  /** A form was answered/cancelled out-of-band (e.g. in the TUI) — clean up. */
  private async onFormResolved(formID: string, type: string): Promise<void> {
    const qf = this.questionForms.get(formID);
    if (!qf) return;
    this.questionForms.delete(formID);
    if (qf.messageId) {
      const msg =
        type === "form.cancelled"
          ? "ℹ️ Câu hỏi đã được huỷ bởi OpenCode."
          : "ℹ️ Câu hỏi đã được trả lời (nơi khác).";
      await this.tg.editMessageText(qf.chatId, qf.messageId, msg).catch(() => {});
    }
  }

  /** Build the text + inline keyboard for the current field of a question form. */
  private renderQuestion(qf: QuestionFormState): { text: string; keyboard: Keyboard } {
    const f = qf.fields[qf.index];
    const total = qf.fields.length;
    const n = qf.index + 1;
    const lines: string[] = [];
    lines.push(`❓ <b>Câu ${n}/${total}</b>${f.title ? " · " + esc(f.title) : ""}`);
    if (f.description) lines.push(esc(f.description));
    if (qf.waitingCustom !== undefined) {
      lines.push("", "✍️ <i>Gõ câu trả lời của bạn trong tin nhắn kế tiếp (bấm Huỷ để bỏ qua).</i>");
    } else if (f.options?.length) {
      lines.push("", "Chạm một đáp án, hoặc tự gõ đáp án của bạn:");
    } else {
      lines.push("", "Gõ câu trả lời của bạn:");
    }

    const rows: Btn[][] = [];
    const fd = qf.formId;
    if (qf.waitingCustom !== undefined) {
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x` }]);
    } else {
      (f.options ?? []).forEach((opt, i) => {
        rows.push([{ text: `▪️ ${trunc(opt.label, 60)}`, callback_data: `fq:${fd}:o${i}` }]);
      });
      if (f.custom || !f.options?.length || f.type === "string") {
        rows.push([{ text: "✍️ Gõ tự do…", callback_data: `fq:${fd}:c` }]);
      }
      rows.push([{ text: "❌ Huỷ", callback_data: `fq:${fd}:x` }]);
    }
    return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
  }

  /** Handle a tap on a question-form button (data = `fq:<formId>:<op>`). */
  private async handleFormCallback(cb: CallbackQuery, chatId: number, messageId?: number): Promise<void> {
    const data = cb.data ?? "";
    const parts = data.split(":");
    const formID = parts[1];
    const op = parts[2] ?? "";
    const qf = this.questionForms.get(formID);
    if (!qf) {
      await this.tg.answerCallbackQuery(cb.id, "Phiên hỏi đã kết thúc.");
      return;
    }
    try {
      if (op === "x") {
        await this.oc.cancelForm(qf.sessionID, qf.formId, "Cancelled by user via Telegram.");
        this.questionForms.delete(formID);
        await this.tg.answerCallbackQuery(cb.id);
        if (messageId) await this.tg.editMessageText(chatId, messageId, "❌ Đã huỷ câu hỏi.").catch(() => {});
        return;
      }
      if (op === "c") {
        qf.waitingCustom = qf.index;
        await this.tg.answerCallbackQuery(cb.id);
        if (messageId) {
          const v = this.renderQuestion(qf);
          await this.tg.editMessageText(chatId, messageId, v.text, { reply_markup: v.keyboard });
        }
        return;
      }
      if (op.startsWith("o")) {
        const idx = Number(op.slice(1));
        const f = qf.fields[qf.index];
        const opt = f.options?.[idx];
        if (!opt) throw new Error("Đáp án không hợp lệ — vui lòng thử lại.");
        qf.answers[f.key] = opt.value;
        await this.tg.answerCallbackQuery(cb.id);
        await this.advanceOrSubmit(qf, chatId, messageId);
        return;
      }
      await this.tg.answerCallbackQuery(cb.id);
    } catch (e) {
      await this.tg.answerCallbackQuery(cb.id, `⚠️ ${(e as Error).message}`);
    }
  }

  /** After recording an answer: show the next field, or submit if all answered. */
  private async advanceOrSubmit(qf: QuestionFormState, chatId: number, messageId?: number): Promise<void> {
    qf.waitingCustom = undefined;
    if (qf.index + 1 < qf.fields.length) {
      qf.index += 1;
      if (messageId) {
        const v = this.renderQuestion(qf);
        await this.tg.editMessageText(chatId, messageId, v.text, { reply_markup: v.keyboard });
      }
      return;
    }
    // All fields answered — submit the full answer to OpenCode.
    await this.oc.replyForm(qf.sessionID, qf.formId, qf.answers);
    this.questionForms.delete(qf.formId);
    if (messageId) {
      const summary = Object.entries(qf.answers)
        .map(([k, v]) => `• ${esc(trunc(String(v), 80))}`)
        .join("\n");
      await this.tg
        .editMessageText(chatId, messageId, `✅ Đã gửi câu trả lời cho OpenCode.${summary ? "\n" + summary : ""}`)
        .catch(() => {});
    }
  }

  /**
   * If a question form in this chat is waiting for a typed (custom) answer,
   * consume this text as that answer. Returns true if the text was consumed.
   */
  private async handleFormText(chatId: number, text: string): Promise<boolean> {
    for (const qf of this.questionForms.values()) {
      if (qf.chatId === chatId && qf.waitingCustom !== undefined) {
        const f = qf.fields[qf.index];
        qf.answers[f.key] = text;
        await this.advanceOrSubmit(qf, chatId, qf.messageId);
        return true;
      }
    }
    return false;
  }
}
