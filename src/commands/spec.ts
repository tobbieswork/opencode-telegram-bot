/**
 * `/spec` — the spec-to-tasks flow, step S2: list + detail. NO running yet
 * (execution is S4; the Run button answers "not available yet").
 *
 * - `/spec` lists every docs/sdd/*.md file of the conversation's git repo
 *   that has a "## … Tasks" section, each as a tap button with its title
 *   (first "# " heading, else the file name) and progress "done/total".
 *   Specs without a Tasks section are design docs and are not listed (S1.1).
 *   Specs that fail to parse ARE listed, clearly marked (S1.4).
 * - Tapping a spec shows its task list: done ✅ (with commit hash), next ▶️
 *   (first todo that is not blocked), todo ○, blocked ⛔ (a "Needs:" line),
 *   plus each task's checkpoint line. The next runnable task gets a
 *   "Run <ID>" button (S1.2).
 *
 * State is rebuilt from disk on EVERY use (S6.4): each call re-resolves the
 * conversation's directory + git root and re-parses the spec files with the
 * pure parser in src/spec.ts. Nothing is persisted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { Lang } from "../state.js";
import { gitRoot } from "../worktree.js";
import { parseSpec, type ParsedTask } from "../spec.js";
import { tr } from "../i18n.js";
import { esc, trunc } from "../format.js";

/** One spec in docs/sdd/: parsed (with progress) or unparseable (S1.4). */
type SpecEntry =
  | { name: string; title: string; done: number; total: number }
  | { name: string; title: string; error: { line: number; message: string } };

/** The parser's marker for "no Tasks section at all" (src/spec.ts): that is
 * a design doc, not a parse failure, so it is not listed (S1.1). */
const NO_TASKS_HEADING = "no '## … Tasks' heading found";

/** Names we accept from button callbacks: file-safe, no traversal. */
const NAME_RE = /^[A-Za-z0-9._-]{1,55}$/;

/** The conversation's directory, falling back to the bot's default. */
function convDir(bot: Bot, conv: ConvKey): string {
  return bot.st.peek(conv)?.directory || bot.cfg.opencodeDirectory;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** First "# " heading of the file, else the file name without extension. */
function specTitle(md: string, fallback: string): string {
  for (const l of md.split(/\r?\n/)) {
    const m = l.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return fallback;
}

/** Scan docs/sdd/: every *.md with a Tasks section (parsed or failed). */
function scanSpecs(sdd: string): SpecEntry[] {
  let files: string[];
  try {
    files = readdirSync(sdd).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: SpecEntry[] = [];
  for (const f of files) {
    const name = f.slice(0, -3);
    let md: string;
    try {
      md = readFileSync(join(sdd, f), "utf8");
    } catch {
      out.push({ name, title: name, error: { line: 0, message: "unreadable file" } });
      continue;
    }
    const title = specTitle(md, name);
    const res = parseSpec(md);
    if ("error" in res) {
      if (res.error.line === 0 && res.error.message === NO_TASKS_HEADING) continue; // design doc
      out.push({ name, title, error: res.error });
      continue;
    }
    out.push({
      name,
      title,
      done: res.tasks.filter((t) => t.marker === "done").length,
      total: res.tasks.length,
    });
  }
  return out;
}

/** "title — done/total", or a warning mark for a parse failure (S1.4). */
function entryButton(e: SpecEntry): { text: string; callback_data: string } {
  const text = "error" in e ? `⚠️ ${trunc(e.title, 40)}` : `${trunc(e.title, 40)} — ${e.done}/${e.total}`;
  return { text, callback_data: `spec:${e.name}` };
}

/** The index of the next runnable task: the first todo (in order) that is
 * not blocked (has no "Needs:" line), or -1. */
function nextRunnable(tasks: ParsedTask[]): number {
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].marker === "todo" && !tasks[i].needs) return i;
  }
  return -1;
}

function taskLine(t: ParsedTask, status: "done" | "next" | "todo" | "blocked"): string {
  const icon = status === "done" ? "✅" : status === "next" ? "▶️" : status === "blocked" ? "⛔" : "○";
  let l = `${icon} <b>${esc(t.id)}</b> ${esc(t.title)}`;
  if (status === "done" && t.commit) l += ` — <code>${esc(t.commit)}</code>`;
  if (status === "blocked" && t.needs) l += ` — <i>${esc(t.needs)}</i>`;
  return l;
}

function detailText(title: string, tasks: ParsedTask[]): string {
  const done = tasks.filter((t) => t.marker === "done").length;
  const next = nextRunnable(tasks);
  const lines: string[] = [`📋 <b>${esc(title)}</b> — ${done}/${tasks.length}`, ""];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const status = t.marker === "done" ? "done" : i === next ? "next" : t.needs ? "blocked" : "todo";
    lines.push(taskLine(t, status));
    if (t.checkpoint) lines.push(`&nbsp;&nbsp;· Checkpoint: ${esc(t.checkpoint)}`);
  }
  if (next === -1) {
    lines.push("");
    lines.push(
      done === tasks.length
        ? "✅ " + tr("vi", "Tất cả tasks đã xong.", "All tasks done.")
        : "⛔ " + tr("vi", "Không còn task chạy được — các task còn lại đang bị chặn.", "No runnable task left — the rest are blocked.")
    );
  }
  return lines.join("\n");
}

function errorDetailText(title: string, name: string, error: { line: number; message: string }): string {
  const head = tr("vi", "⚠️ <b>Không phân tích được spec này</b>", "⚠️ <b>This spec could not be parsed</b>");
  const file = `📄 <code>${esc(name)}.md</code> — <b>${esc(title)}</b>`;
  const line = error.line > 0 ? `📍 ${error.line}: ${esc(error.message)}` : esc(error.message);
  return `${head}\n${file}\n${line}`;
}

/** The one-line reply when the feature is switched off (S6.1). */
function disabledText(lang: Lang): string {
  return tr(lang, "📋 /spec đang tắt (OPENCODE_TG_SPEC=0).", "📋 /spec is disabled (OPENCODE_TG_SPEC=0).");
}

/**
 * `/spec` — list the specs of the conversation's git repo (S1.1, S1.3,
 * S1.4, S6.1). Arguments are not used in S2.
 */
export async function cmdSpec(bot: Bot, conv: ConvKey, uid?: number): Promise<void> {
  const lang = bot.userPrefs.getLang(uid ?? "");
  if (!bot.cfg.spec) {
    await bot.tg.sendMessage(conv, disabledText(lang));
    return;
  }
  const dir = convDir(bot, conv);
  const root = await gitRoot(dir);
  if (!root) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Thư mục hiện tại không phải là repo git.", "📁 The current directory is not a git repository."));
    return;
  }
  const sdd = join(root, "docs", "sdd");
  if (!isDir(sdd)) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Repo không có thư mục docs/sdd.", "📁 This repository has no docs/sdd/ directory."));
    return;
  }
  const entries = scanSpecs(sdd);
  if (!entries.length) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Không có spec nào có mục Tasks trong docs/sdd.", "📁 No spec with a Tasks section in docs/sdd."));
    return;
  }
  await bot.sendHtml(
    conv,
    tr(lang, "📋 <b>Specs</b> — <code>docs/sdd</code>", "📋 <b>Specs</b> — <code>docs/sdd</code>"),
    { reply_markup: { inline_keyboard: entries.map((e) => [entryButton(e)]) } }
  );
}

/**
 * Button taps from a /spec list: "spec:<name>" opens the detail view,
 * "specrun:<name>:<n>" is a Run tap (S4, not available yet). The state is
 * rebuilt from disk on every tap (S6.4).
 */
export async function handleSpecCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey): Promise<void> {
  const lang = bot.userPrefs.getLang(cb.from?.id ?? "");
  const data = cb.data ?? "";
  if (!bot.cfg.spec) {
    await bot.tg.answerCallbackQuery(cb.id);
    await bot.tg.sendMessage(conv, disabledText(lang));
    return;
  }
  if (data.startsWith("specrun:")) {
    // S4 wires execution in; until then the Run tap only answers. Bilingual
    // on purpose: the stub reply must land without knowing the user's lang.
    await bot.tg.answerCallbackQuery(cb.id);
    await bot.tg.sendMessage(
      conv,
      "🚧 Chưa thể chạy task — tính năng chạy sẽ có ở bước tiếp theo.\n🚧 Running tasks is not available yet — it comes in the next step."
    );
    return;
  }
  const name = data.slice("spec:".length);
  await bot.tg.answerCallbackQuery(cb.id);
  if (!NAME_RE.test(name)) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ spec nào.", "❌ Unknown spec."));
    return;
  }
  const dir = convDir(bot, conv);
  const root = await gitRoot(dir);
  let md: string;
  try {
    md = readFileSync(join(root!, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `❌ Spec ${esc(name)} not found in docs/sdd.`));
    return;
  }
  const title = specTitle(md, name);
  const res = parseSpec(md);
  if ("error" in res) {
    // S1.4: name the spec file and the first failed line. No buttons: a
    // spec that cannot be parsed never offers to run anything.
    await bot.sendHtml(conv, errorDetailText(title, name, res.error));
    return;
  }
  const next = nextRunnable(res.tasks);
  const keyboard =
    next >= 0
      ? { reply_markup: { inline_keyboard: [[{ text: `▶️ Run ${res.tasks[next].id}`, callback_data: `specrun:${name}:${res.tasks[next].n}` }]] } }
      : undefined;
  await bot.sendHtml(conv, detailText(title, res.tasks), keyboard);
}
