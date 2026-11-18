/**
 * Folder browser feature: `/dir`, `/browse` and the `bs:` callback menu
 * (nav / up / pg / hid / open / list / setdir / setsess / close / noop).
 * The browser lives in a single message per chat: every button tap edits
 * that message instead of posting new ones, so the chat stays readable.
 * Moved out of bot.ts (docs/sdd/split-bot-ts.md, T5). The feature talks to
 * the bot only through the narrow `BotCtx` interface; `Bot` satisfies it
 * structurally so behaviour is unchanged.
 */
import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { ChatState, Lang } from "../state.js";
import { DirItem, isUnderRoot, listDirs, parentWithin, shortPath } from "../fsbrowser.js";
import { esc, trunc } from "../format.js";
import { tr } from "../i18n.js";
import { warn } from "../logger.js";
import type { Btn, Keyboard } from "../shared.js";

/** Directories shown per page in the browser list. */
const BROWSE_PAGE_SIZE = 12;
/** Directory buttons per row. */
const BROWSE_COLUMNS = 2;

/** In-memory state of the folder browser, one per chat. */
export interface BrowseState {
  path: string;
  showHidden: boolean;
  items: DirItem[];
  page: number;
  view: "list" | "choose" | "done";
  /** Language for the rendered labels (captured when the browser opened). */
  lang: Lang;
  /** One-off message shown above the listing (e.g. a clamped path). */
  note?: string;
  /** Set when the directory could not be read. */
  error?: string;
  /** Result of the last "open this folder" action. */
  result?: string;
  /** True once a session was started from this folder. */
  opened: boolean;
}

/** `/dir [path]` — show or set the chat's working directory. */
export async function cmdDir(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  if (!arg) {
    return ctx.tg.sendMessage(conv, `📁 Current directory:\n<code>${esc(state.directory || ctx.cfg.opencodeDirectory)}</code>`);
  }
  const p = isAbsolute(arg) ? arg : resolve(ctx.cfg.opencodeDirectory, arg);
  if (!existsSync(p)) return ctx.tg.sendMessage(conv, `❌ No such directory: <code>${esc(p)}</code>`);
  ctx.st.set(conv, { directory: p });
  await ctx.tg.sendMessage(
    conv,
    `📁 Directory set to <code>${esc(p)}</code>\n(used for the next /new)\nTip: /browse to pick a folder with buttons.`,
  );
}

/**
 * `/browse [path]` — open the folder browser at `arg` (or the chat's current
 * directory), clamped to the allowed roots (cfg.browseRoots).
 */
export async function cmdBrowse(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const roots = ctx.cfg.browseRoots;
  if (!roots.length) return ctx.tg.sendMessage(conv, tr(lang, "❌ Không có thư mục nào được phép duyệt.", "❌ No directories are allowed to browse."));
  const requested = arg
    ? resolve(ctx.cfg.opencodeDirectory, arg)
    : state.directory || ctx.cfg.opencodeDirectory;
  let path = resolve(requested);
  let note: string | undefined;
  if (!isUnderRoot(path, roots)) {
    const owner = roots.find((r) => isUnderRoot(path, [r]));
    path = owner ?? roots[0];
    note = tr(lang, `⚠️ <code>${esc(requested)}</code> nằm ngoài vùng được duyệt — đã mở tại <code>${esc(path)}</code>.`, `⚠️ <code>${esc(requested)}</code> is outside the allowed roots — opened at <code>${esc(path)}</code> instead.`);
  }
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return ctx.tg.sendMessage(conv, tr(lang, `❌ Không phải thư mục: <code>${esc(path)}</code>`, `❌ Not a directory: <code>${esc(path)}</code>`));

  const b: BrowseState = { path, showHidden: false, items: [], page: 0, view: "list", opened: false, note, lang };
  await reloadBrowse(ctx, b);
  ctx.browsers.set(conv, b);
  const v = renderBrowse(ctx, b);
  await ctx.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
}

/** Re-read the current directory and keep the page index in range. */
export async function reloadBrowse(ctx: BotCtx, b: BrowseState): Promise<void> {
  try {
    b.items = await listDirs(b.path, b.showHidden);
    b.error = undefined;
  } catch (e) {
    b.items = [];
    b.error = tr(b.lang, `⚠️ Không đọc được thư mục: ${esc((e as Error).message)}`, `⚠️ Couldn't read the directory: ${esc((e as Error).message)}`);
  }
  const maxPage = Math.max(0, Math.ceil(b.items.length / BROWSE_PAGE_SIZE) - 1);
  if (b.page > maxPage) b.page = maxPage;
}

/** Build the text + inline keyboard for the current browser view. */
export function renderBrowse(ctx: BotCtx, b: BrowseState): { text: string; keyboard: Keyboard } {
  if (b.view === "choose") {
    return {
      text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, "", tr(b.lang, "<b>Chọn cách mở thư mục này:</b>", "<b>Choose how to open this folder:</b>")].join("\n"),
      keyboard: {
        inline_keyboard: [
          [{ text: tr(b.lang, "📁 Chỉ đặt thư mục", "📁 Set directory only"), callback_data: "bs:setdir" }],
          [{ text: tr(b.lang, "🚀 Đặt + mở session mới", "🚀 Set + open new session"), callback_data: "bs:setsess" }],
          [
            { text: tr(b.lang, "↩️ Quay lại", "↩️ Back"), callback_data: "bs:list" },
            { text: tr(b.lang, "❌ Đóng", "❌ Close"), callback_data: "bs:close" },
          ],
        ],
      },
    };
  }

  if (b.view === "done") {
    const rows: Btn[][] = [];
    if (!b.opened) rows.push([{ text: tr(b.lang, "🚀 Mở session mới tại đây", "🚀 Open a new session here"), callback_data: "bs:setsess" }]);
    rows.push([{ text: tr(b.lang, "📂 Duyệt tiếp", "📂 Keep browsing"), callback_data: "bs:list" }]);
    rows.push([{ text: tr(b.lang, "❌ Đóng", "❌ Close"), callback_data: "bs:close" }]);
    return { text: b.result ?? tr(b.lang, "✅ Xong", "✅ Done"), keyboard: { inline_keyboard: rows } };
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
  if (parentWithin(b.path, ctx.cfg.browseRoots)) {
    nav.push({ text: tr(b.lang, "⬆️ Lên", "⬆️ Up"), callback_data: "bs:up" });
  }
  nav.push({ text: b.showHidden ? tr(b.lang, "🙈 Ẩn file ẩn", "🙈 Hide hidden files") : tr(b.lang, "👁 Hiện file ẩn", "👁 Show hidden files"), callback_data: "bs:hid" });
  nav.push({ text: tr(b.lang, "✅ Mở tại đây", "✅ Open here"), callback_data: "bs:open" });
  rows.push(nav);

  if (pageCount > 1) {
    rows.push([
      { text: "◀️", callback_data: `bs:pg:${b.page - 1}` },
      { text: `${b.page + 1}/${pageCount}`, callback_data: "bs:noop" },
      { text: "▶️", callback_data: `bs:pg:${b.page + 1}` },
    ]);
  }
  rows.push([{ text: tr(b.lang, "❌ Đóng", "❌ Close"), callback_data: "bs:close" }]);

  const meta: string[] = [];
  if (b.note) meta.push(b.note);
  if (b.error) meta.push(b.error);
  meta.push(
    `<i>${b.items.length} ${tr(b.lang, "thư mục con", "subdirectories")}${pageCount > 1 ? ` · ${tr(b.lang, "trang", "page")} ${b.page + 1}/${pageCount}` : ""}</i>`,
  );
  meta.push(tr(b.lang, "Chạm một thư mục để vào · ✅ để mở OpenCode tại đây", "Tap a folder to enter · ✅ to open OpenCode here"));
  return {
    text: [`<b>📂 ${esc(shortPath(b.path, 70))}</b>`, ...meta].join("\n"),
    keyboard: { inline_keyboard: rows },
  };
}

/**
 * Handle a button tap on the browser message (data = `bs:<action>[:arg]`).
 * Every action edits the browser message in place; `close` deletes it and
 * drops the browser state.
 */
export async function handleBrowseCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number, answer: (toast?: string) => void = (t) => { void ctx.tg.answerCallbackQuery(cb.id, t).catch(() => {}); }): Promise<void> {
  const b = ctx.browsers.get(conv);
  if (!b) {
    answer(tr(ctx.userPrefs.getLang(cb.from?.id ?? ""), "Phiên duyệt đã đóng — gửi /browse", "The browser was closed — send /browse"));
    return;
  }

  const [, action, arg] = (cb.data ?? "").split(":");
  let close = false;
  try {
    switch (action) {
      case "nav": {
        const item = b.items[Number(arg)];
        if (!item) throw new Error(tr(b.lang, "Mục không còn tồn tại — gửi /browse để tải lại.", "The entry no longer exists — send /browse to reload."));
        b.path = item.path;
        b.page = 0;
        b.view = "list";
        b.note = undefined;
        await reloadBrowse(ctx, b);
        break;
      }
      case "up": {
        const parent = parentWithin(b.path, ctx.cfg.browseRoots);
        if (parent) {
          b.path = parent;
          b.page = 0;
          b.view = "list";
          await reloadBrowse(ctx, b);
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
        await reloadBrowse(ctx, b);
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
        ctx.st.set(conv, { directory: b.path });
        b.view = "done";
        b.opened = false;
        b.result = [
          tr(b.lang, `✅ Đã đặt thư mục làm việc:`, `✅ Working directory set:`) + `\n<code>${esc(b.path)}</code>`,
          "",
          tr(b.lang, "Session mới sẽ chạy ở đây. Gõ /new hoặc bấm “🚀 Mở session mới tại đây”.", "New sessions will run here. Send /new or tap “🚀 Open a new session here”."),
        ].join("\n");
        break;
      }
      case "setsess": {
        const state = ctx.st.get(conv);
        await ctx.stopCurrent(conv, true);
        const sessionID = await ctx.oc.createSession(b.path);
        await ctx.applyModelAndVariant(sessionID, state);
        if (state.agent) {
          await ctx.oc.setAgent(sessionID, state.agent).catch((e) => warn("setAgent:", e?.message));
        }
        ctx.st.set(conv, { sessionID, directory: b.path });
        ctx.stopWatch(conv, "session-changed"); // W5.1: the conversation moved to a new session
        b.view = "done";
        b.opened = true;
        b.result = [
          tr(b.lang, `🚀 Đã mở session <code>${esc(sessionID)}</code>`, `🚀 Opened session <code>${esc(sessionID)}</code>`),
          `📁 <code>${esc(b.path)}</code>`,
          "",
          tr(b.lang, "Gửi tin nhắn để bắt đầu làm việc.", "Send a message to start working."),
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
    answer(`⚠️ ${(e as Error).message}`);
    return;
  }

  answer();
  if (close) {
    ctx.browsers.delete(conv);
    if (messageId) await ctx.tg.deleteMessage(conv, messageId);
    return;
  }
  if (!messageId) return;
  const v = renderBrowse(ctx, b);
  await ctx.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
}
