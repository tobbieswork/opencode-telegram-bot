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
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import { chatOf } from "../conv.js";
import type { Lang } from "../state.js";
import { gitRoot, ensureSpecWorktree, resolveBaseBranch, runGit, specBranchName } from "../worktree.js";
import { parseSpec, initMarkers, markTask, type ParsedTask } from "../spec.js";
import { buildTaskPrompt } from "../spec-prompt.js";
import { warn } from "../logger.js";
import { NAME_RE as WORKER_NAME_RE, BUSY } from "../orchestrator.js";
import { classifyShellItems, workerCommitsSinceFork } from "../spec-checkpoint.js";
import { audit } from "../audit.js";
import { isUserAllowed } from "../schedule.js";
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

function detailText(lang: Lang, title: string, tasks: ParsedTask[]): string {
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
        ? "✅ " + tr(lang, "Tất cả tasks đã xong.", "All tasks done.")
        : "⛔ " + tr(lang, "Không còn task chạy được — các task còn lại đang bị chặn.", "No runnable task left — the rest are blocked.")
    );
  }
  return lines.join("\n");
}

function errorDetailText(lang: Lang, title: string, name: string, error: { line: number; message: string }): string {
  const head = tr(lang, "⚠️ <b>Không phân tích được spec này</b>", "⚠️ <b>This spec could not be parsed</b>");
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

// ── S4: Run ─────────────────────────────────────────────────────────────────
// Tapping "Run" on a spec task spawns ONE worker on a dedicated spec branch
// (spec/<name> in its own worktree, cut from main) with the buildTaskPrompt
// output. One running worker per SPEC (not per chat), persisted in state.json.
// A blocked task ("Needs:") never auto-spawns: the first tap probes what it
// can and offers an explicit "Run anyway"; the second tap spawns (S2.6).

/** Parse a run callback body "<name>:<n>" into a valid (name, n), or undefined. */
function parseRunRef(body: string): { name: string; n: number } | undefined {
  const [name, num] = body.split(":");
  if (!name || !NAME_RE.test(name)) return undefined;
  if (!/^\d+$/.test(num)) return undefined;
  const n = parseInt(num, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return { name, n };
}

/**
 * Ensure the spec branch carries S4 task markers, committing them when absent
 * (S4.3). Committed with the repository's own author (git's configured
 * identity). Returns true when a marker commit was made.
 */
async function ensureSpecMarkers(wtRoot: string, relPath: string, specName: string): Promise<boolean> {
  const file = join(wtRoot, relPath);
  const md = readFileSync(file, "utf8");
  const marked = initMarkers(md);
  if (marked === md) return false; // already marked (idempotent)
  writeFileSync(file, marked);
  await runGit(wtRoot, ["add", "--", relPath]);
  await runGit(wtRoot, ["commit", "-m", `docs: add S4 task markers to ${specName}.md`]);
  return true;
}

/**
 * The shared spawn behind both run taps (S2.1). Claims the one-running-per-
 * spec slot, creates/reuses the spec worktree, builds the prompt from the
 * WORKTREE copy of the spec, and spawns one worker via the orchestrator's
 * existing spawn. Rolls the claim back if anything before a successful spawn
 * throws, so a failed run never wedges the spec.
 */
async function specRunSpawn(
  bot: Bot,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
  task: ParsedTask,
  root: string,
  runAnyway: boolean,
): Promise<void> {
  const chat = chatOf(conv);
  const workerName = `spec-${name}`;
  const branch = specBranchName(name);
  // A previous run of this spec leaves its worker entry registered under this
  // name. A finished one (done/failed/stopped) is a stale registration, not a
  // collision — free the name so the re-run can spawn. The old topic and its
  // session stay (the run's record); /prune collects the topic later. A BUSY
  // worker with this name is a real collision and stays a hard error.
  const prev = bot.st.findWorker(chat, workerName);
  if (prev) {
    const pst = prev[1].worker?.status;
    if (pst && !BUSY.includes(pst)) bot.st.set(prev[0], { worker: undefined });
  }
  // The worker name is spec-<name> and must fit the worker-name rules
  // (a-z, 0-9, -; 24 chars total → spec name ≤ 19). Fail early with a clear
  // message instead of tripping the orchestrator's error after claim+worktree.
  if (!WORKER_NAME_RE.test(workerName)) {
    await bot.tg
      .sendMessage(
        conv,
        tr(
          lang,
          `❌ Tên spec ${esc(name)} không dùng làm tên worker được (spec-${esc(name)}): chỉ a-z, 0-9, gạch ngang, tối đa 19 ký tự.`,
          `❌ Spec name ${esc(name)} can't be a worker name (spec-${esc(name)}): a-z, 0-9, hyphen only, max 19 chars.`,
        ),
      )
      .catch(() => {});
    return;
  }
  // S2.5: one running per spec — atomic claim (check + set, no await between,
  // so two concurrent taps can't both get through).
  if (!bot.orch.claimSpecRun(chat, name, { branch, task: task.id, worker: workerName, since: Date.now() })) {
    const running = bot.st.peek(chat)?.specRunning?.[name];
    await bot.tg
      .sendMessage(
        conv,
        tr(
          lang,
          `⛔ Spec <b>${esc(name)}</b> đang có worker chạy (task ${esc(running?.task ?? task.id)}). Chờ nó xong hoặc dừng nó trước.`,
          `⛔ Spec <b>${esc(name)}</b> already has a running worker (task ${esc(running?.task ?? task.id)}). Wait for it or stop it first.`,
        ),
      )
      .catch(() => {});
    return;
  }
  // The launch calls the Telegram API (worker topic + intro message), so a
  // transient network blip can fail it (live incident 2026-11-16: a blip
  // swallowed two Run taps AND the error notice). Retry the whole launch a few
  // times, holding the claim — the worktree/marker steps are idempotent, so a
  // retry is safe.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = Number(process.env.SPEC_RUN_RETRY_DELAY_MS ?? 15000);
  let lastErr: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      // S2.1: dedicated worktree on the stable spec branch, cut from main. The
      // worker runs at the repo root (dir === root).
      const wt = await ensureSpecWorktree(root, root, name);
      const relSpec = join("docs", "sdd", `${name}.md`);
      // S4.3: the spec branch must carry task markers before the worker starts.
      await ensureSpecMarkers(wt.root, relSpec, name);
      // S2.1: build the prompt from the WORKTREE copy of the spec (so it carries
      // the markers). Fall back to the main-checkout task if the worktree parse
      // differs (shouldn't happen for a fresh branch).
      const wtMd = readFileSync(join(wt.root, relSpec), "utf8");
      const wtRes = parseSpec(wtMd);
      const wtTask = "error" in wtRes ? undefined : wtRes.tasks.find((t) => t.n === n);
      const prompt = buildTaskPrompt(wtMd, wtTask ?? task).prompt;
      const r = await bot.orch.spawn(chat, {
        name: workerName,
        directory: wt.directory,
        task: prompt,
        writes: true,
        spawnedBy: "user",
        // We already isolated the worker into its own spec worktree (the
        // spec/<name> branch); skip the orchestrator's worktree pass so it
        // doesn't wrap this in a second tg/ worktree (matters in "always" mode).
        isolate: false,
        // S5: conv = the conv the Run tap happened in (where the checkpoint card
        // is posted); uid = the tapping user (S6.2 tapped_by).
        specRun: { spec: name, branch: wt.branch, task: task.id, conv, uid: uid ?? 0 },
      });
      // S6.2: audit the run — who tapped, which spec, which task.
      audit({
        action: "spec_run",
        chatId: conv,
        userId: uid != null ? String(uid) : undefined,
        session: bot.st.peek(r.conv)?.sessionID,
        meta: { spec: name, task: task.id, branch: wt.branch, worker: workerName, runAnyway },
      });
      await bot.tg
        .sendMessage(
          conv,
          tr(
            lang,
            `🏃 Đang chạy task <b>${esc(task.id)}</b> của spec ${esc(name)} — worker <b>${esc(workerName)}</b> trong branch <code>${esc(wt.branch)}</code>.`,
            `🏃 Running task <b>${esc(task.id)}</b> of spec ${esc(name)} — worker <b>${esc(workerName)}</b> in branch <code>${esc(wt.branch)}</code>.`,
          ),
        )
        .catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      warn(`spec run ${name}/${task.id} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(e as Error).message}`);
      // If a worker entry got registered before the failure, a retry would
      // collide on the worker name — stop and report instead of double-spawning.
      // findWorker (not peek(chat)): worker entries live in topic convs
      // (chat:threadId), never in the chat-level state.
      if (bot.st.findWorker(chat, workerName) || attempt >= MAX_ATTEMPTS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  // Roll back the claim so the spec isn't wedged by a failed spawn.
  bot.orch.releaseSpecRun(chat, name, workerName);
  await bot.tg
    .sendMessage(conv, tr(lang, `❌ Không chạy được: ${esc((lastErr as Error).message)}`, `❌ Couldn't run it: ${esc((lastErr as Error).message)}`))
    .catch(() => {});
}

/**
 * First tap of a Run on a spec task (S2.5, S2.6).
 *  - todo (not blocked) → spawn immediately.
 *  - blocked ("Needs:") → probe what we can, reply with the check result and
 *    an explicit "Run anyway" button (the second tap). Never auto-spawn.
 */
async function specRunFirstTap(bot: Bot, cb: CallbackQuery, conv: ConvKey, name: string, n: number): Promise<void> {
  const uid = cb.from?.id;
  const lang = bot.userPrefs.getLang(uid ?? "");
  // S2.5: allowlist gate (defense in depth — the bot's callback gate already
  // blocks strangers before this runs; this keeps it true when called directly).
  if (!isUserAllowed(bot.cfg, uid)) {
    await bot.tg.sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.").catch(() => {});
    return;
  }
  const dir = convDir(bot, conv);
  const root = await gitRoot(dir);
  if (!root) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Repo không phải git — không chạy được spec.", "📁 Not a git repository — can't run the spec."));
    return;
  }
  let md: string;
  try {
    md = readFileSync(join(root, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `❌ Spec ${esc(name)} not found in docs/sdd.`));
    return;
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Spec này không phân tích được — không chạy được.", "❌ This spec can't be parsed — it can't be run."));
    return;
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Không tìm thấy task này trong spec.", "❌ Task not found in the spec."));
    return;
  }
  // S2.5: a done task is never run.
  if (task.marker === "done") {
    await bot.tg.sendMessage(conv, tr(lang, `✅ Task ${esc(task.id)} đã xong — không chạy lại.`, `✅ Task ${esc(task.id)} is already done — not re-running.`));
    return;
  }
  if (task.needs) {
    // S2.6: blocked — probe + offer "Run anyway" (second tap spawns).
    let checkLine: string;
    if (/opencode/i.test(task.needs)) {
      const p = await bot.specProbeService();
      checkLine = p.checkable
        ? p.ok
          ? tr(lang, "🔎 Kiểm tra: dịch vụ OpenCode <b>đang phản hồi</b> (các điều kiện khác có thể vẫn thiếu).", "🔎 Check: the OpenCode service <b>is responding</b> (other conditions may still be missing).")
          : tr(lang, "🔎 Kiểm tra: dịch vụ OpenCode <b>không phản hồi</b>.", "🔎 Check: the OpenCode service <b>is not responding</b>.")
        : tr(lang, "🔎 Không thể tự kiểm tra điều kiện này.", "🔎 This condition can't be checked automatically.");
    } else {
      checkLine = tr(lang, `🔎 Không thể tự kiểm tra: <i>${esc(task.needs)}</i>.`, `🔎 Can't check automatically: <i>${esc(task.needs)}</i>.`);
    }
    await bot.sendHtml(
      conv,
      tr(lang, `⛔ Task <b>${esc(task.id)}</b> đang bị chặn: <i>${esc(task.needs)}</i>`, `⛔ Task <b>${esc(task.id)}</b> is blocked: <i>${esc(task.needs)}</i>`) +
        `\n${checkLine}\n` +
        tr(lang, "Bấm nếu bạn chắc chắn muốn chạy dù vậy:", "Tap if you're sure you want to run it anyway:"),
      { reply_markup: { inline_keyboard: [[{ text: tr(lang, "▶️ Chạy dù vậy", "▶️ Run anyway"), callback_data: `specrunok:${name}:${n}` }]] } },
    );
    return;
  }
  await specRunSpawn(bot, conv, lang, uid, name, n, task, root, false);
}

/**
 * Second tap — an explicit "Run anyway" after the blocked-task probe (S2.6).
 * The block is NOT re-checked (that's the point of the second tap); it spawns
 * with the same allowlist + resolution as the non-blocked first tap.
 */
async function specRunSecondTap(bot: Bot, cb: CallbackQuery, conv: ConvKey, name: string, n: number): Promise<void> {
  const uid = cb.from?.id;
  const lang = bot.userPrefs.getLang(uid ?? "");
  if (!isUserAllowed(bot.cfg, uid)) {
    await bot.tg.sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.").catch(() => {});
    return;
  }
  const dir = convDir(bot, conv);
  const root = await gitRoot(dir);
  if (!root) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Repo không phải git — không chạy được spec.", "📁 Not a git repository — can't run the spec."));
    return;
  }
  let md: string;
  try {
    md = readFileSync(join(root, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `❌ Spec ${esc(name)} not found in docs/sdd.`));
    return;
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Spec này không phân tích được — không chạy được.", "❌ This spec can't be parsed — it can't be run."));
    return;
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Không tìm thấy task này trong spec.", "❌ Task not found in the spec."));
    return;
  }
  if (task.marker === "done") {
    await bot.tg.sendMessage(conv, tr(lang, `✅ Task ${esc(task.id)} đã xong — không chạy lại.`, `✅ Task ${esc(task.id)} is already done — not re-running.`));
    return;
  }
  await specRunSpawn(bot, conv, lang, uid, name, n, task, root, true);
}

// ── S6 (checkpoint-card controls): Accept / Redo with note / Stop ─────────────
/**
 * S6.4 — the worker that owns a run of `name` under this conv's chat, or
 * undefined (stale card: no worker by that name, or a worker whose run is for
 * a different spec). All three controls validate against CURRENT state this
 * way before acting.
 */
function specRunWorker(bot: Bot, conv: ConvKey, name: string) {
  const found = bot.st.findWorker(chatOf(conv), `spec-${name}`);
  if (!found) return undefined;
  const w = found[1].worker;
  if (!w || w.specRun?.spec !== name) return undefined;
  return found;
}

async function noRunMessage(bot: Bot, conv: ConvKey, lang: Lang, name: string): Promise<void> {
  await bot.tg
    .sendMessage(
      conv,
      tr(lang, `❌ Không tìm thấy run nào của spec ${esc(name)} — không có gì để xử lý.`, `❌ No run of spec ${esc(name)} found — nothing to act on.`),
    )
    .catch(() => {});
}

/**
 * S6 (S3.4/S4.4) — Accept. Re-derives everything from LIVE state (S6.4), never
 * trusting the card: the worker must still exist for this spec and be done;
 * the checks are re-classified from the session's ACTUAL shell items (a check
 * that errored never ran → refuse); the worker's commit is re-read from git
 * (no commit since the fork → refuse). On success it marks the task done in
 * the spec file INSIDE THE WORKTREE and commits that single line on the spec
 * branch only (the user's checkout is never touched — S4.4), then offers the
 * next runnable task with its Run button.
 */
async function specAccept(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
): Promise<void> {
  const found = specRunWorker(bot, conv, name);
  if (!found) return noRunMessage(bot, conv, lang, name);
  const s = found[1];
  const w = s.worker!;
  if (BUSY.includes(w.status)) {
    await bot.tg
      .sendMessage(conv, tr(lang, `⏳ Worker ${esc(w.name)} đang chạy — chờ nó xong trước khi chấp nhận.`, `⏳ Worker ${esc(w.name)} is still working — wait for it to finish before accepting.`))
      .catch(() => {});
    return;
  }
  if (w.status !== "done") {
    const msg =
      w.status === "failed"
        ? tr(lang, `❌ Worker ${esc(w.name)} đã thất bại — không thể chấp nhận.`, `❌ The worker failed — it can't be accepted.`)
        : w.status === "stopped"
          ? tr(lang, `⏹ Worker ${esc(w.name)} đã bị dừng — không thể chấp nhận.`, `⏹ The worker was stopped — it can't be accepted.`)
          : tr(lang, `❌ Worker ${esc(w.name)} chưa xong — không thể chấp nhận.`, `❌ The worker is not finished — it can't be accepted.`);
    await bot.tg.sendMessage(conv, msg).catch(() => {});
    return;
  }
  const dir = s.directory;
  const relSpec = join("docs", "sdd", `${name}.md`);
  const file = join(dir ?? "", relSpec);
  let md: string;
  try {
    if (!dir) throw new Error("no worktree directory");
    md = readFileSync(file, "utf8");
  } catch {
    return noRunMessage(bot, conv, lang, name);
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.sendHtml(conv, errorDetailText(lang, specTitle(md, name), name, res.error));
    return;
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg
      .sendMessage(conv, tr(lang, `❌ Task số ${n} không có trong spec ${esc(name)}.`, `❌ Task ${n} not found in the spec ${esc(name)}.`))
      .catch(() => {});
    return;
  }
  if (task.marker === "done") {
    await bot.tg
      .sendMessage(conv, tr(lang, `✅ Task ${esc(task.id)} đã được chấp nhận rồi.`, `✅ Task ${esc(task.id)} is already accepted.`))
      .catch(() => {});
    return;
  }
  // S3.2: re-classify the checks from the session's ACTUAL shell tool items.
  const items: Array<{ state?: any }> = [];
  if (s.sessionID) {
    const msgs = ((await bot.oc.listMessages(s.sessionID).catch(() => [])) as any[]) ?? [];
    for (const m of msgs) {
      for (const c of (m?.content ?? []) as any[]) {
        if (c?.type === "tool" && c.name === "shell") items.push(c);
      }
    }
  }
  const ran = classifyShellItems(items).ran;
  if (ran.some((c) => c.error !== undefined)) {
    await bot.tg
      .sendMessage(conv, tr(lang, `❌ Có check đã lỗi (chưa chạy được) — không thể chấp nhận. Hãy dùng "Làm lại kèm ghi chú".`, `❌ A check errored (never ran) — the run can't be accepted. Use "Redo with note".`))
      .catch(() => {});
    return;
  }
  // S3.1: the worker's commit, re-read from git (since the fork, marker excluded).
  const base = await resolveBaseBranch(dir!);
  const lines = (await runGit(dir!, ["log", "--format=%h %s", `${base}..HEAD`]).catch(() => "")).split("\n");
  const commits = workerCommitsSinceFork(lines, name);
  if (commits.length === 0) {
    await bot.tg
      .sendMessage(conv, tr(lang, `❌ Chưa thể chấp nhận — không có commit nào của worker trên nhánh kể từ khi fork.`, `❌ Can't accept — there is no commit on the branch since the fork.`))
      .catch(() => {});
    return;
  }
  const commit = commits[0]; // newest first
  // S4.4: mark the task done in the WORKTREE's spec file, and commit that
  // single change on the spec branch. The user's checkout is never touched.
  writeFileSync(file, markTask(md, n, commit.hash));
  await runGit(dir!, ["add", "--", relSpec]);
  await runGit(dir!, ["commit", "-m", `docs: mark ${task.id} done`]);
  // S6.2: audit the accept.
  audit({
    action: "spec_accept",
    chatId: conv,
    userId: uid != null ? String(uid) : undefined,
    meta: { spec: name, task: task.id, branch: w.specRun!.branch, worker: w.name, commit: commit.hash, userId: uid ?? null },
  });
  // Offer the next runnable task (same pattern as the "spec:" detail branch).
  const nextRes = parseSpec(readFileSync(file, "utf8"));
  const nextTasks = "error" in nextRes ? [] : nextRes.tasks;
  const next = nextRunnable(nextTasks);
  const lines2: string[] = [
    tr(
      lang,
      `✅ Task ${esc(task.id)} đã được chấp nhận — đã đánh dấu xong (<code>${esc(commit.hash)}</code>).`,
      `✅ Task ${esc(task.id)} accepted — marked done (<code>${esc(commit.hash)}</code>).`,
    ),
  ];
  const buttons: { text: string; callback_data: string }[] = [];
  if (next >= 0) {
    const t = nextTasks[next];
    lines2.push(`${tr(lang, "Task chạy tiếp:", "Next runnable:")} ▶️ <b>${esc(t.id)} ${esc(t.title)}</b>`);
    buttons.push({ text: `▶️ Run ${t.id}`, callback_data: `specrun:${name}:${t.n}` });
  } else {
    lines2.push(tr(lang, "✅ Tất cả tasks đã xong.", "✅ All tasks done."));
  }
  const keyboard = buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : undefined;
  await bot.sendHtml(conv, lines2.join("\n"), keyboard);
}

/**
 * S6 (S3.5) — Redo with note. Pending-note pattern: registers a pending
 * request for the card's conv and asks the user to send the note; the Bot's
 * message path then consumes the next plain text (10-minute TTL, commands
 * pass through) and the orchestrator delivers it to the SAME worker session,
 * which keeps the run's context.
 */
async function specRedo(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
): Promise<void> {
  const found = specRunWorker(bot, conv, name);
  if (!found) return noRunMessage(bot, conv, lang, name);
  const w = found[1].worker!;
  if (BUSY.includes(w.status)) {
    await bot.tg
      .sendMessage(conv, tr(lang, `⏸ Worker ${esc(w.name)} đang chạy — không thể làm lại ngay bây giờ.`, `⏸ Worker ${esc(w.name)} is still working — can't redo right now.`))
      .catch(() => {});
    return;
  }
  bot.orch.redoPending.set(conv, { spec: name, task: w.specRun!.task, workerConv: found[0], uid, since: Date.now() });
  await bot.tg
    .sendMessage(conv, tr(lang, `✍️ Gửi một ghi chú cho worker ${esc(w.name)} — nó sẽ làm lại task ${esc(w.specRun!.task)} kèm ghi chú đó.`, `✍️ Send a note for worker ${esc(w.name)} — it will redo task ${esc(w.specRun!.task)} with it.`))
    .catch(() => {});
}

/**
 * S6 (S3.6) — Stop. Only while the worker is BUSY. Stops it via the same
 * primitive /kill uses (mark stopped first, then interrupt), but keeps the
 * worktree and its uncommitted work, and never closes the topic (a Redo can
 * resume there). No spec-file marker change: the task stays open, and the S5
 * settlement hook re-posts the errored card (Redo + Stop only).
 */
async function specStop(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
): Promise<void> {
  const found = specRunWorker(bot, conv, name);
  if (!found) return noRunMessage(bot, conv, lang, name);
  const w = found[1].worker!;
  if (!BUSY.includes(w.status)) {
    await bot.tg
      .sendMessage(conv, tr(lang, `✅ Worker ${esc(w.name)} đã xong rồi — không có gì để dừng.`, `✅ Worker ${esc(w.name)} has already finished — nothing to stop.`))
      .catch(() => {});
    return;
  }
  const notice = await bot.orch.stopSpecWorker(found[0]);
  await bot.sendHtml(conv, `${notice}\n${tr(lang, "🌲 Worktree được giữ lại — công việc chưa commit vẫn còn ở đó.", "🌲 Worktree kept — uncommitted work is still there.")}`).catch(() => {});
  audit({
    action: "spec_stop",
    chatId: conv,
    userId: uid != null ? String(uid) : undefined,
    meta: { spec: name, task: w.specRun!.task, worker: w.name, userId: uid ?? null },
  });
}

/**
 * Button taps from a /spec list (state rebuilt from disk on every tap, S6.4):
 *  - "spec:<name>"            → the detail view (task list + Run buttons)
 *  - "specrun:<name>:<n>"     → Run tap on the next runnable (non-blocked) → spawn
 *  - "specblocked:<name>:<n>" → Run tap on a blocked task → probe + "Run anyway"
 *  - "specrunok:<name>:<n>"   → the explicit second tap ("Run anyway") → spawn
 *  - "spcacc:<name>:<n>"      → S6 Accept (re-derives from live state)
 *  - "spcredo:<name>:<n>"     → S6 Redo with note (pending-note flow)
 *  - "spcstop:<name>:<n>"     → S6 Stop (busy worker only)
 */
export async function handleSpecCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey): Promise<void> {
  const lang = bot.userPrefs.getLang(cb.from?.id ?? "");
  const data = cb.data ?? "";
  if (!bot.cfg.spec) {
    await bot.tg.answerCallbackQuery(cb.id);
    await bot.tg.sendMessage(conv, disabledText(lang));
    return;
  }
  // Non-fatal: a transient network failure here must NOT abort the tap — a
  // fatal answer once silently lost a user's Run tap during a network blip
  // (the handler aborted before dispatch).
  await bot.tg.answerCallbackQuery(cb.id).catch((e) =>
    warn("answerCallbackQuery (spec):", (e as Error)?.message),
  );
  if (data.startsWith("specrunok:")) {
    const ref = parseRunRef(data.slice("specrunok:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specRunSecondTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("specblocked:")) {
    const ref = parseRunRef(data.slice("specblocked:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specRunFirstTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("specrun:")) {
    const ref = parseRunRef(data.slice("specrun:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specRunFirstTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcacc:")) {
    const ref = parseRunRef(data.slice("spcacc:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specAccept(bot, cb, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcredo:")) {
    const ref = parseRunRef(data.slice("spcredo:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specRedo(bot, cb, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcstop:")) {
    const ref = parseRunRef(data.slice("spcstop:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specStop(bot, cb, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  const name = data.slice("spec:".length);
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
    // S1.4: name the spec file and the first failed line. No buttons: a spec
    // that cannot be parsed never offers to run anything.
    await bot.sendHtml(conv, errorDetailText(lang, title, name, res.error));
    return;
  }
  const next = nextRunnable(res.tasks);
  const buttons: { text: string; callback_data: string }[] = [];
  if (next >= 0) {
    buttons.push({ text: `▶️ Run ${res.tasks[next].id}`, callback_data: `specrun:${name}:${res.tasks[next].n}` });
  }
  // S2.6: every blocked todo ALSO offers a Run (a two-tap flow: the first tap
  // probes + offers "Run anyway"; the second spawns). Distinct "specblocked:"
  // prefix so the next-runnable "specrun:" button stays the single S2 one.
  for (const t of res.tasks) {
    if (t.marker === "todo" && t.needs) {
      buttons.push({ text: `⛔ Run ${t.id}`, callback_data: `specblocked:${name}:${t.n}` });
    }
  }
  const keyboard = buttons.length
    ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } }
    : undefined;
  await bot.sendHtml(conv, detailText(lang, title, res.tasks), keyboard);
}
