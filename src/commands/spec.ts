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
import { basename, dirname, join } from "node:path";
import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import { chatOf } from "../conv.js";
import type { Lang, SpecPrState, WorkerStatus } from "../state.js";
import { MACHINE_STATE_KEY } from "../state.js";
import { gitRoot, ensureSpecWorktree, resolveBaseBranch, runGit, specBranchName, specSlug, removeWorktree } from "../worktree.js";
import { ghApi, githubRepoSlug, ghPrReady } from "../github.js";
import { parseSpec, initMarkers, markTask, type ParsedTask } from "../spec.js";
import { buildTaskPrompt } from "../spec-prompt.js";
import { singleButton } from "../ui/keyboards.js";
import { errorLine, okLine, raw, statusLine, warnLine } from "../ui/text.js";
import { warn } from "../logger.js";
import { NAME_RE as WORKER_NAME_RE, BUSY } from "../orchestrator.js";
import { classifyShellItems, workerCommitsSinceFork } from "../spec-checkpoint.js";
import { audit } from "../audit.js";
import { isUserAllowed } from "../schedule.js";
import { tr } from "../i18n.js";
import { esc, trunc } from "../format.js";
import { oneArg, fields } from "../callbacks.js";

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

// ── S5 (spec PR): state + body helpers ───────────────────────────────────────
/** The spec worktree's root (where the `spec/<name>` branch is checked out),
 * computed the same way ensureSpecWorktree does — without creating it. */
function specWtRoot(repoRoot: string, name: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, specSlug(name));
}

/** The recorded PR for a spec (S5), or undefined. Machine-scoped (S5: the PR
 * belongs to the spec + its repo, not to one conversation). */
function getSpecPr(bot: Bot, name: string): SpecPrState | undefined {
  return bot.st.peek(MACHINE_STATE_KEY)?.specPr?.[name];
}

/** Record (or, with undefined, clear) the PR state for a spec. */
function setSpecPr(bot: Bot, name: string, pr: SpecPrState | undefined): void {
  const m = bot.st.peek(MACHINE_STATE_KEY) ?? {};
  const map = { ...(m.specPr ?? {}) };
  if (pr) map[name] = pr;
  else delete map[name];
  bot.st.set(MACHINE_STATE_KEY, { specPr: map });
}

/** The PR body: the spec title (H1) + every task with its status. */
function prBody(tasks: ParsedTask[], title: string): string {
  const next = nextRunnable(tasks);
  const lines: string[] = [`# ${title}`, ""];
  tasks.forEach((t, i) => {
    const status = t.marker === "done" ? "done" : i === next ? "next" : t.needs ? "blocked" : "todo";
    const icon = status === "done" ? "✅" : status === "next" ? "▶️" : status === "blocked" ? "⛔" : "○";
    let l = `- ${icon} ${t.id} ${t.title}`;
    if (t.marker === "done" && t.commit) l += ` — \`${t.commit}\``;
    if (t.needs) l += ` — _needs: ${t.needs}_`;
    lines.push(l);
  });
  return lines.join("\n");
}

/** The PR title (S5.1): `feat: <spec title>`. */
function prTitle(title: string): string {
  return `feat: ${title}`;
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
        ? okLine(lang, tr(lang, "Tất cả tasks đã xong.", "All tasks done."))
        : "⛔ " + tr(lang, "Không còn task chạy được — các task còn lại đang bị chặn.", "No runnable task left — the rest are blocked.")
    );
  }
  return lines.join("\n");
}

function errorDetailText(lang: Lang, title: string, name: string, error: { line: number; message: string }): string {
  const head = warnLine(lang, raw(tr(lang, "<b>Không phân tích được spec này</b>", "<b>This spec could not be parsed</b>")));
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
  // Two groups: in-progress specs first (any task still open — including a
  // spec whose worker is running now), then finished ones; parse failures
  // (⚠️) come last, ungrouped. Buttons follow the same order.
  const active = entries.filter((e) => !("error" in e) && e.done < e.total);
  const finished = entries.filter((e) => !("error" in e) && e.done >= e.total);
  const broken = entries.filter((e) => "error" in e);
  const line = (e: SpecEntry) => ("error" in e ? `⚠️ ${esc(e.title)}` : `• ${esc(e.title)} — ${e.done}/${e.total}`);
  const section = (title: string, list: SpecEntry[]) =>
    `<b>${title}</b>\n${list.map(line).join("\n")}`;
  const parts: string[] = [];
  if (active.length) parts.push(section(tr(lang, `🔄 Đang tiến hành (${active.length})`, `In progress (${active.length})`), active));
  if (finished.length) parts.push(section(tr(lang, `✅ Đã xong (${finished.length})`, `Done (${finished.length})`), finished));
  if (broken.length) parts.push(section(tr(lang, `⚠️ Lỗi parse (${broken.length})`, `Parse errors (${broken.length})`), broken));
  await bot.sendHtml(
    conv,
    tr(lang, "📋 <b>Specs</b> — <code>docs/sdd</code>", "📋 <b>Specs</b> — <code>docs/sdd</code>") + "\n\n" + parts.join("\n\n"),
    { reply_markup: { inline_keyboard: [...active, ...finished, ...broken].map((e) => [entryButton(e)]) } }
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
  /** S6.5: carry the auto run-next flag onto the new run (autoContinueFrom passes true). */
  auto?: boolean,
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
        errorLine(lang, raw(tr(lang, `Tên spec ${esc(name)} không dùng làm tên worker được (spec-${esc(name)}): chỉ a-z, 0-9, gạch ngang, tối đa 19 ký tự.`, `Spec name ${esc(name)} can't be a worker name (spec-${esc(name)}): a-z, 0-9, hyphen only, max 19 chars.`))),
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
        specRun: { spec: name, branch: wt.branch, task: task.id, conv, uid: uid ?? 0, ...(auto ? { auto: true } : {}) },
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
    .sendMessage(conv, errorLine(lang, raw(tr(lang, `Không chạy được: ${esc((lastErr as Error).message)}`, `Couldn't run it: ${esc((lastErr as Error).message)}`))))
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
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `Spec ${esc(name)} not found in docs/sdd.`))));
    return;
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Spec này không phân tích được — không chạy được.", "This spec can't be parsed — it can't be run.")));
    return;
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không tìm thấy task này trong spec.", "Task not found in the spec.")));
    return;
  }
  // S2.5: a done task is never run.
  if (task.marker === "done") {
    await bot.tg.sendMessage(conv, okLine(lang, raw(tr(lang, `Task ${esc(task.id)} đã xong — không chạy lại.`, `Task ${esc(task.id)} is already done — not re-running.`))));
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
      { reply_markup: singleButton({ text: tr(lang, "▶️ Chạy dù vậy", "▶️ Run anyway"), data: `specrunok:${name}:${n}` }) },
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
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `Spec ${esc(name)} not found in docs/sdd.`))));
    return;
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Spec này không phân tích được — không chạy được.", "This spec can't be parsed — it can't be run.")));
    return;
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không tìm thấy task này trong spec.", "Task not found in the spec.")));
    return;
  }
  if (task.marker === "done") {
    await bot.tg.sendMessage(conv, okLine(lang, raw(tr(lang, `Task ${esc(task.id)} đã xong — không chạy lại.`, `Task ${esc(task.id)} is already done — not re-running.`))));
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
      errorLine(lang, raw(tr(lang, `Không tìm thấy run nào của spec ${esc(name)} — không có gì để xử lý.`, `No run of spec ${esc(name)} found — nothing to act on.`))),
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
 * Returns { ok } so the S6.5 auto path can act on the outcome.
 */
type AcceptResult = { ok: boolean };

async function specAccept(
  bot: Bot,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
): Promise<AcceptResult> {
  const found = specRunWorker(bot, conv, name);
  if (!found) {
    await noRunMessage(bot, conv, lang, name);
    return { ok: false };
  }
  const s = found[1];
  const w = s.worker!;
  if (BUSY.includes(w.status)) {
    await bot.tg
      .sendMessage(conv, statusLine(lang, raw(tr(lang, `Worker ${esc(w.name)} đang chạy — chờ nó xong trước khi chấp nhận.`, `Worker ${esc(w.name)} is still working — wait for it to finish before accepting.`))))
      .catch(() => {});
    return { ok: false };
  }
  if (w.status !== "done") {
    const msg =
      w.status === "failed"
        ? errorLine(lang, raw(tr(lang, `Worker ${esc(w.name)} đã thất bại — không thể chấp nhận.`, `The worker failed — it can't be accepted.`)))
        : w.status === "stopped"
          ? tr(lang, `⏹ Worker ${esc(w.name)} đã bị dừng — không thể chấp nhận.`, `⏹ The worker was stopped — it can't be accepted.`)
          : errorLine(lang, raw(tr(lang, `Worker ${esc(w.name)} chưa xong — không thể chấp nhận.`, `The worker is not finished — it can't be accepted.`)));
    await bot.tg.sendMessage(conv, msg).catch(() => {});
    return { ok: false };
  }
  const dir = s.directory;
  const relSpec = join("docs", "sdd", `${name}.md`);
  const file = join(dir ?? "", relSpec);
  let md: string;
  try {
    if (!dir) throw new Error("no worktree directory");
    md = readFileSync(file, "utf8");
  } catch {
    await noRunMessage(bot, conv, lang, name);
    return { ok: false };
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.sendHtml(conv, errorDetailText(lang, specTitle(md, name), name, res.error));
    return { ok: false };
  }
  const task = res.tasks.find((t) => t.n === n);
  if (!task) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, raw(tr(lang, `Task số ${n} không có trong spec ${esc(name)}.`, `Task ${n} not found in the spec ${esc(name)}.`))))
      .catch(() => {});
    return { ok: false };
  }
  if (task.marker === "done") {
    await bot.tg
      .sendMessage(conv, okLine(lang, raw(tr(lang, `Task ${esc(task.id)} đã được chấp nhận rồi.`, `Task ${esc(task.id)} is already accepted.`))))
      .catch(() => {});
    return { ok: false };
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
      .sendMessage(conv, errorLine(lang, tr(lang, `Có check đã lỗi (chưa chạy được) — không thể chấp nhận. Hãy dùng "Làm lại kèm ghi chú".`, `A check errored (never ran) — the run can't be accepted. Use "Redo with note".`)))
      .catch(() => {});
    return { ok: false };
  }
  // S3.1: the worker's commit, re-read from git (since the fork, marker excluded).
  const base = await resolveBaseBranch(dir!);
  const lines = (await runGit(dir!, ["log", "--format=%h %s", `${base}..HEAD`]).catch(() => "")).split("\n");
  const commits = workerCommitsSinceFork(lines, name);
  if (commits.length === 0) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, tr(lang, `Chưa thể chấp nhận — không có commit nào của worker trên nhánh kể từ khi fork.`, `Can't accept — there is no commit on the branch since the fork.`)))
      .catch(() => {});
    return { ok: false };
  }
  const commit = commits[0]; // newest first
  // Guard (2026-11-18 split-bot-ts T6 incident): the worker's commit must be
  // NEWER than the run start. A worker that ends its turn WITHOUT committing
  // (e.g. waiting on a background smoke) must not be accepted on pre-run
  // history — that stamps a stale hash and the next task would spawn into a
  // dirty worktree. Tolerance: 5s (committer dates are second-resolution).
  const commitTs = (await runGit(dir!, ["show", "-s", "--format=%ct", commit.hash]).catch(() => "")).trim();
  const runStartMs = (w as any).createdAt ?? 0;
  if (runStartMs > 0 && commitTs !== "" && Number(commitTs) * 1000 + 5000 < runStartMs) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, tr(lang,
        `Không thể chấp nhận — commit mới nhất của worker (${commit.hash}) cũ hơn thời điểm run bắt đầu: có thể worker chưa commit thay đổi. Kiểm tra worktree, commit rồi thử lại.`,
        `Can't accept — the worker's newest commit (${commit.hash}) predates this run's start: the worker may not have committed its work. Check the worktree, commit it, then retry.`)))
      .catch(() => {});
    return { ok: false };
  }
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
  // S5.1/S5.2: push the spec branch (explicit refspec — S5.4) BEFORE offering
  // the PR, because opening one needs the head branch on the remote. The push
  // is non-fatal: a failure warns and the PR offer is skipped.
  const branch = w.specRun!.branch;
  const title = specTitle(md, name);
  const allDone = nextTasks.length > 0 && nextTasks.every((t) => t.marker === "done");
  let pushed = false;
  try {
    await runGit(dir!, ["push", "origin", `HEAD:refs/heads/${branch}`]);
    pushed = true;
  } catch (e) {
    warn(`spec ${name} push failed: ${(e as Error).message}`);
  }

  const lines2: string[] = [
    okLine(lang, raw(tr(lang, `Task ${esc(task.id)} đã được chấp nhận — đã đánh dấu xong (<code>${esc(commit.hash)}</code>).`, `Task ${esc(task.id)} accepted — marked done (<code>${esc(commit.hash)}</code>).`))),
  ];
  const buttons: { text: string; callback_data: string }[] = [];
  if (next >= 0) {
    const t = nextTasks[next];
    lines2.push(`${tr(lang, "Task chạy tiếp:", "Next runnable:")} ▶️ <b>${esc(t.id)} ${esc(t.title)}</b>`);
    buttons.push({ text: `▶️ Run ${t.id}`, callback_data: `specrun:${name}:${t.n}` });
  } else {
    lines2.push(okLine(lang, tr(lang, "Tất cả tasks đã xong.", "All tasks done.")));
  }

  // S5.1/S5.2/S5.3: the PR offer. A recorded PR gets its body refreshed (+
  // "Mark ready for review" when this accept finished the spec); otherwise a
  // pushed branch offers "Open draft PR". NEVER merge (no merge path exists).
  const pr = getSpecPr(bot, name);
  if (pr) {
    let ok = true;
    try {
      await ghApi(pr.repo, "PATCH", `pulls/${pr.number}`, { body: prBody(nextTasks, title) });
    } catch (e) {
      ok = false;
      warn(`spec ${name} PR body update failed: ${(e as Error).message}`);
    }
    lines2.push(
      ok
        ? tr(lang, `🔗 PR #${pr.number} — body đã cập nhật.`, `🔗 PR #${pr.number} — body updated.`)
        : warnLine(lang, tr(lang, `Không cập nhật được body PR #${pr.number}.`, `Couldn't update PR #${pr.number}'s body.`)),
    );
    if (allDone) {
      buttons.push({ text: tr(lang, "✅ Sẵn sàng review", "✅ Mark ready for review"), callback_data: `spcready:${name}` });
    }
  } else if (pushed) {
    lines2.push(tr(lang, `🌿 Đã đẩy <code>${esc(branch)}</code>.`, `🌿 Pushed <code>${esc(branch)}</code>.`));
    buttons.push({ text: tr(lang, "📝 Mở draft PR", "📝 Open draft PR"), callback_data: `spcpr:${name}` });
  } else {
    lines2.push(
      warnLine(lang, raw(tr(lang, `Đã accept nhưng KHÔNG đẩy được <code>${esc(branch)}</code> — kiểm tra remote.`, `Accepted but could NOT push <code>${esc(branch)}</code> — check the remote.`))),
    );
  }
  const keyboard = buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : undefined;
  await bot.sendHtml(conv, lines2.join("\n"), keyboard);
  return { ok: true };
}

// ── S6.5 (auto run-next) ───────────────────────────────────────────────────
/**
 * S6.5 — the next task the auto chain must handle: the FIRST undone task in
 * order. Unlike nextRunnable (which skips blocked tasks — a human can choose
 * to run around them), the auto chain NEVER jumps over a task: a blocked one
 * stops the chain (its "Needs:" condition is a human/external gate).
 */
function nextAutoTask(tasks: ParsedTask[]): ParsedTask | undefined {
  return tasks.find((t) => t.marker !== "done");
}

/**
 * S6.5 — after a successful accept: look up the next task the chain must
 * handle (fresh spec state from the worktree) and either spawn it WITHOUT a
 * tap or stop at a blocked task (offering the explicit "run anyway" two-tap
 * flow). A no-op when every task is done.
 */
async function autoContinueFrom(
  bot: Bot,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  dir: string,
): Promise<void> {
  let md: string;
  try {
    md = readFileSync(join(dir, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    return;
  }
  const res = parseSpec(md);
  const nxt = "error" in res ? undefined : nextAutoTask(res.tasks);
  if (!nxt) return; // all done — the accept's card offers the PR
  if (nxt.needs) {
    await bot
      .sendHtml(
        conv,
        tr(
          lang,
          `⛔ Task tiếp theo <b>${esc(nxt.id)}</b> đang bị chặn: <i>${esc(nxt.needs)}</i> — auto run dừng.`,
          `⛔ The next task <b>${esc(nxt.id)}</b> is blocked: <i>${esc(nxt.needs)}</i> — auto run stops.`,
        ),
        {
          reply_markup: {
            inline_keyboard: [[{ text: `⛔ Run ${nxt.id}`, callback_data: `specblocked:${name}:${nxt.n}` }]],
          },
        },
      )
      .catch(() => {});
    return;
  }
  const root = await gitRoot(convDir(bot, conv));
  if (!root) return;
  await specRunSpawn(bot, conv, lang, uid, name, nxt.n, nxt, root, false, true);
}

async function specAuto(
  bot: Bot,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
  n: number,
): Promise<AcceptResult> {
  const found = specRunWorker(bot, conv, name);
  const w = found?.[1].worker;
  const sr = w?.specRun;
  if (!found || !w || !sr) {
    void noRunMessage(bot, conv, lang, name);
    return { ok: false };
  }
  if (!sr.auto) bot.st.set(found[0], { worker: { ...w, specRun: { ...sr, auto: true } } });
  const dir = found[1].directory;
  const res = await specAccept(bot, conv, lang, uid, name, n);
  if (res.ok && dir) await autoContinueFrom(bot, conv, lang, uid, name, dir);
  return res;
}

/**
 * S6.5 (auto run-next) — terminal hook, called by the orchestrator AFTER the
 * checkpoint card is posted when a spec worker reaches a terminal status.
 * Re-derives everything from LIVE state (S6.4) exactly like Accept does —
 * worker done, no errored check, a commit since the fork — then accepts and
 * spawns the next task with no tap. Any deviation (red finish, blocked next
 * task, unreadable spec) clears the auto flag and says so; the normal card
 * (with Redo / Stop) was already posted and stays the way back in.
 * Best-effort: never throws into the worker's finish path.
 */
export async function specAutoContinue(bot: Bot, workerConv: ConvKey, status: WorkerStatus): Promise<void> {
  try {
    const s = bot.st.peek(workerConv);
    const w = s?.worker;
    if (!w?.specRun?.auto || !w.specRun.conv || !s?.directory) return;
    const { spec: name, task: taskId, conv, uid } = w.specRun;
    const lang = bot.userPrefs.getLang(uid ? String(uid) : "");
    const clearAuto = (): void => {
      const cur = bot.st.peek(workerConv)?.worker;
      if (cur?.specRun?.auto) bot.st.set(workerConv, { worker: { ...cur, specRun: { ...cur.specRun, auto: false } } });
    };
    if (status !== "done") {
      clearAuto();
      await bot
        .sendHtml(
          conv,
          tr(
            lang,
            "⛔ Auto run dừng — task vừa kết thúc không xanh (lỗi hoặc không có commit). Xem card bên trên để làm lại.",
            "⛔ Auto run stopped — the task ended not green (error or no commit). See the card above to redo.",
          ),
        )
        .catch(() => {});
      return;
    }
    const file = join(s.directory, "docs", "sdd", `${name}.md`);
    let md: string;
    try {
      md = readFileSync(file, "utf8");
    } catch {
      clearAuto();
      return;
    }
    const res = parseSpec(md);
    if ("error" in res) {
      clearAuto();
      return;
    }
    const task = res.tasks.find((t) => t.id === taskId);
    if (!task) {
      clearAuto();
      return;
    }
    const acc = await specAccept(bot, conv, lang, uid, name, task.n);
    if (!acc.ok) {
      clearAuto();
      await bot
        .sendHtml(
          conv,
          tr(
            lang,
            `⛔ Auto run dừng — không chấp nhận được <b>${esc(task.id)}</b>. Xem card bên trên.`,
            `⛔ Auto run stopped — couldn't accept <b>${esc(task.id)}</b>. See the card above.`,
          ),
        )
        .catch(() => {});
      return;
    }
    await autoContinueFrom(bot, conv, lang, uid, name, s.directory);
    // all-done / blocked are no-ops inside autoContinueFrom; the flag is
    // harmless either way (no more runnable task to trigger it).
  } catch (e) {
    warn(`specAutoContinue: ${(e as Error).message}`);
  }
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
      .sendMessage(conv, okLine(lang, raw(tr(lang, `Worker ${esc(w.name)} đã xong rồi — không có gì để dừng.`, `Worker ${esc(w.name)} has already finished — nothing to stop.`))))
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

// ── S5 (spec PR): Open draft PR / Mark ready / (S5.5) Clean up ───────────────
/**
 * S5.1 — "Open draft PR". Reads the spec from the WORKTREE (the spec branch is
 * the source of truth for task state), opens a DRAFT PR against main via the
 * gh helper, records the PR state, and offers "Mark ready for review" when
 * every task is done. Never merges.
 */
async function specPrOpen(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
): Promise<void> {
  if (!isUserAllowed(bot.cfg, cb.from?.id)) {
    await bot.tg.sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.").catch(() => {});
    return;
  }
  if (getSpecPr(bot, name)) {
    const pr = getSpecPr(bot, name)!;
    await bot.tg
      .sendMessage(conv, tr(lang, `ℹ️ Spec ${esc(name)} đã có PR #${pr.number} — không mở lại.`, `ℹ️ Spec ${esc(name)} already has PR #${pr.number} — not opening another.`))
      .catch(() => {});
    return;
  }
  const root = await gitRoot(convDir(bot, conv));
  if (!root) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Repo không phải git — không mở PR được.", "📁 Not a git repository — can't open a PR.")).catch(() => {});
    return;
  }
  const repo = await githubRepoSlug(root);
  if (!repo) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, raw(tr(lang, `Không xác định được repo GitHub từ remote origin của ${esc(name)}.`, `Couldn't determine the GitHub repo from ${esc(name)}'s origin remote.`))))
      .catch(() => {});
    return;
  }
  // The spec branch's copy of the spec (worktree), falling back to the checkout.
  const wtRoot = specWtRoot(root, name);
  let md: string;
  try {
    md = readFileSync(join(wtRoot, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    try {
      md = readFileSync(join(root, "docs", "sdd", `${name}.md`), "utf8");
    } catch {
      await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `Spec ${esc(name)} not found in docs/sdd.`)))).catch(() => {});
      return;
    }
  }
  const res = parseSpec(md);
  if ("error" in res) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Spec này không phân tích được — không mở PR được.", "This spec can't be parsed — can't open a PR."))).catch(() => {});
    return;
  }
  const title = specTitle(md, name);
  const branch = specBranchName(name);
  let number: number;
  let url: string;
  try {
    const created = await ghApi<{ number: number; html_url?: string }>(repo, "POST", "pulls", {
      title: prTitle(title),
      head: branch,
      base: "main",
      draft: true,
      body: prBody(res.tasks, title),
    });
    number = created.number;
    url = created.html_url ?? `https://github.com/${repo}/pull/${number}`;
  } catch (e) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, raw(tr(lang, `Không mở được draft PR: ${esc((e as Error).message)}`, `Couldn't open the draft PR: ${esc((e as Error).message)}`))))
      .catch(() => {});
    return;
  }
  setSpecPr(bot, name, { repo, number, title: prTitle(title), draft: true });
  audit({
    action: "spec_pr_open",
    chatId: conv,
    userId: uid != null ? String(uid) : undefined,
    meta: { spec: name, repo, number, title: prTitle(title), branch, userId: uid ?? null },
  });
  const allDone = res.tasks.length > 0 && res.tasks.every((t) => t.marker === "done");
  const buttons: { text: string; callback_data: string }[] = [];
  if (allDone) buttons.push({ text: tr(lang, "✅ Sẵn sàng review", "✅ Mark ready for review"), callback_data: `spcready:${name}` });
  const keyboard = buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : undefined;
  await bot.sendHtml(
    conv,
    tr(lang, `📝 Đã mở draft PR #${number} cho spec ${esc(name)}: ${url}`, `📝 Draft PR #${number} opened for spec ${esc(name)}: ${url}`),
    keyboard,
  );
}

/**
 * S5.3 — "Mark ready for review". Un-drafts the recorded PR via `gh pr ready`
 * (the REST update endpoint silently ignores `draft:false`).
 * It NEVER merges — there is no merge code path anywhere in this feature.
 */
async function specPrReady(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
): Promise<void> {
  if (!isUserAllowed(bot.cfg, cb.from?.id)) {
    await bot.tg.sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.").catch(() => {});
    return;
  }
  const pr = getSpecPr(bot, name);
  if (!pr) {
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Chưa có PR nào cho spec ${esc(name)}.`, `No PR recorded for spec ${esc(name)}.`)))).catch(() => {});
    return;
  }
  try {
    await ghPrReady(pr.repo, pr.number);
  } catch (e) {
    await bot.tg
      .sendMessage(conv, errorLine(lang, raw(tr(lang, `Không đánh dấu sẵn sàng được PR #${pr.number}: ${esc((e as Error).message)}`, `Couldn't mark PR #${pr.number} ready: ${esc((e as Error).message)}`))))
      .catch(() => {});
    return;
  }
  setSpecPr(bot, name, { ...pr, draft: false });
  audit({
    action: "spec_pr_ready",
    chatId: conv,
    userId: uid != null ? String(uid) : undefined,
    meta: { spec: name, repo: pr.repo, number: pr.number, userId: uid ?? null },
  });
  await bot.tg.sendMessage(conv, okLine(lang, tr(lang, `PR #${pr.number} đã sẵn sàng review.`, `PR #${pr.number} is ready for review.`))).catch(() => {});
}

/**
 * S5.5 — "Clean up". Offered once the recorded PR is merged. Refuses while the
 * spec branch has any commit not in main (`git log origin/main..spec/<name>`
 * non-empty). Otherwise deletes the REMOTE branch (main is never pushed),
 * removes the worktree, and clears the PR state.
 */
async function specCleanUp(
  bot: Bot,
  cb: CallbackQuery,
  conv: ConvKey,
  lang: Lang,
  uid: number | undefined,
  name: string,
): Promise<void> {
  if (!isUserAllowed(bot.cfg, cb.from?.id)) {
    await bot.tg.sendMessage(conv, "⛔ <b>Not authorized.</b> You are not on the allowlist.").catch(() => {});
    return;
  }
  const pr = getSpecPr(bot, name);
  if (!pr) {
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Chưa có PR nào cho spec ${esc(name)} — không có gì để dọn.`, `No PR recorded for spec ${esc(name)} — nothing to clean up.`)))).catch(() => {});
    return;
  }
  const root = await gitRoot(convDir(bot, conv));
  if (!root) {
    await bot.tg.sendMessage(conv, tr(lang, "📁 Repo không phải git — không dọn được.", "📁 Not a git repository — can't clean up.")).catch(() => {});
    return;
  }
  const branch = specBranchName(name);
  const wtRoot = specWtRoot(root, name);
  // (a) Refuse while the branch has any commit that is not in main.
  try {
    await runGit(wtRoot, ["fetch", "origin", "main"]);
  } catch (e) {
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Không fetch được main: ${esc((e as Error).message)}`, `Couldn't fetch main: ${esc((e as Error).message)}`)))).catch(() => {});
    return;
  }
  let extra = "";
  try {
    extra = await runGit(wtRoot, ["log", "--format=%h", `origin/main..${branch}`]);
  } catch {
    extra = ""; // the branch is gone locally — nothing unmerged to protect
  }
  if (extra.trim()) {
    const first = extra.trim().split("\n")[0];
    await bot.tg
      .sendMessage(
        conv,
        errorLine(lang, raw(tr(lang, `Không dọn được — branch <code>${esc(branch)}</code> còn commit chưa có trong main (${esc(first)}…). Hãy merge PR trước.`, `Can't clean up — branch <code>${esc(branch)}</code> still has commits not in main (${esc(first)}…). Merge the PR first.`))),
      )
      .catch(() => {});
    return;
  }
  // (b) Delete the remote branch (allowed — main is never pushed), remove the
  // worktree (reusing the existing primitive), clear the PR state.
  await runGit(root, ["push", "origin", "--delete", branch]).catch((e) => {
    warn(`spec ${name} remote branch delete failed: ${(e as Error).message}`);
  });
  let removed = "";
  try {
    removed = await removeWorktree(root, { root: wtRoot, branch }, lang);
  } catch (e) {
    removed = (e as Error).message;
  }
  setSpecPr(bot, name, undefined);
  audit({
    action: "spec_cleanup",
    chatId: conv,
    userId: uid != null ? String(uid) : undefined,
    meta: { spec: name, repo: pr.repo, number: pr.number, branch, userId: uid ?? null },
  });
  await bot.sendHtml(
    conv,
    tr(
      lang,
      `🧹 Đã dọn dẹp spec ${esc(name)}: branch + worktree đã xoá.
${esc(removed)}`,
      `🧹 Cleaned up spec ${esc(name)}: branch + worktree deleted.
${esc(removed)}`,
    ),
  ).catch(() => {});
}

/**
 * Button taps from a /spec list (state rebuilt from disk on every tap, S6.4):
 *  - "spec:<name>"            → the detail view (task list + Run buttons)
 *  - "specrun:<name>:<n>"     → Run tap on the next runnable (non-blocked) → spawn
 *  - "specblocked:<name>:<n>" → Run tap on a blocked task → probe + "Run anyway"
 *  - "specrunok:<name>:<n>"   → the explicit second tap ("Run anyway") → spawn
 *  - "spcacc:<name>:<n>"      → S6 Accept (re-derives from live state)
 *  - "spcauto:<name>:<n>"     → S6.5 Accept + auto run-next (then spawn if runnable)
 *  - "spcredo:<name>:<n>"     → S6 Redo with note (pending-note flow)
 *  - "spcstop:<name>:<n>"     → S6 Stop (busy worker only)
 */
export async function handleSpecCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey, answer: (toast?: string) => void = (toast) => { void bot.tg.answerCallbackQuery(cb.id, toast).catch(() => {}); }): Promise<void> {
  const lang = bot.userPrefs.getLang(cb.from?.id ?? "");
  const data = cb.data ?? "";
  if (!bot.cfg.spec) {
    answer();
    await bot.tg.sendMessage(conv, disabledText(lang));
    return;
  }
  // Non-fatal: a transient network failure here must NOT abort the tap — a
  // fatal answer once silently lost a user's Run tap during a network blip
  // (the handler aborted before dispatch).
  answer();
  if (data.startsWith("specrunok:")) {
    const ref = parseRunRef(data.slice("specrunok:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specRunSecondTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("specblocked:")) {
    const ref = parseRunRef(data.slice("specblocked:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specRunFirstTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("specrun:")) {
    const ref = parseRunRef(data.slice("specrun:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specRunFirstTap(bot, cb, conv, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcacc:")) {
    const ref = parseRunRef(data.slice("spcacc:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specAccept(bot, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcauto:")) {
    const ref = parseRunRef(data.slice("spcauto:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, tr(lang, "❌ Không rõ task nào.", "❌ Unknown task."));
      return;
    }
    await specAuto(bot, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcredo:")) {
    const ref = parseRunRef(data.slice("spcredo:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specRedo(bot, cb, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  if (data.startsWith("spcstop:")) {
    const ref = parseRunRef(data.slice("spcstop:".length));
    if (!ref) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ task nào.", "Unknown task.")));
      return;
    }
    await specStop(bot, cb, conv, lang, cb.from?.id, ref.name, ref.n);
    return;
  }
  // S5: the PR-flow controls carry the spec NAME only (no task number).
  if (data.startsWith("spcpr:")) {
    const nm = data.slice("spcpr:".length);
    if (!NAME_RE.test(nm)) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ spec nào.", "Unknown spec.")));
      return;
    }
    await specPrOpen(bot, cb, conv, lang, cb.from?.id, nm);
    return;
  }
  if (data.startsWith("spcready:")) {
    const nm = data.slice("spcready:".length);
    if (!NAME_RE.test(nm)) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ spec nào.", "Unknown spec.")));
      return;
    }
    await specPrReady(bot, cb, conv, lang, cb.from?.id, nm);
    return;
  }
  if (data.startsWith("spcclean:")) {
    const nm = data.slice("spcclean:".length);
    if (!NAME_RE.test(nm)) {
      await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ spec nào.", "Unknown spec.")));
      return;
    }
    await specCleanUp(bot, cb, conv, lang, cb.from?.id, nm);
    return;
  }
  const name = data.slice("spec:".length);
  if (!NAME_RE.test(name)) {
    await bot.tg.sendMessage(conv, errorLine(lang, tr(lang, "Không rõ spec nào.", "Unknown spec.")));
    return;
  }
  const dir = convDir(bot, conv);
  const root = await gitRoot(dir);
  let md: string;
  try {
    md = readFileSync(join(root!, "docs", "sdd", `${name}.md`), "utf8");
  } catch {
    await bot.tg.sendMessage(conv, errorLine(lang, raw(tr(lang, `Không tìm thấy spec ${esc(name)} trong docs/sdd.`, `Spec ${esc(name)} not found in docs/sdd.`))));
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
  // S5.5: a recorded PR that is merged gets a marker + a "Clean up" button.
  // The merged result is cached in state so a second /spec tap does not
  // re-query GitHub; a non-merged result is NOT cached (so a later merge is
  // still detected on the next /spec).
  let detail = detailText(lang, title, res.tasks);
  const pr = getSpecPr(bot, name);
  if (pr) {
    let merged = pr.merged === true;
    if (!merged) {
      try {
        const st = await ghApi<{ merged?: boolean; merged_at?: string | null; state?: string }>(pr.repo, "GET", `pulls/${pr.number}`);
        merged = !!(st && (st.merged === true || st.merged_at != null || st.state === "merged"));
        if (merged) setSpecPr(bot, name, { ...pr, merged: true });
      } catch {
        merged = false; // a transient gh failure must not break the detail view
      }
    }
    if (merged) {
      detail += "\n" + tr(lang, "🔀 PR đã merge vào main.", "🔀 The PR has been merged into main.");
      buttons.push({ text: tr(lang, "🧹 Dọn dẹp", "🧹 Clean up"), callback_data: `spcclean:${name}` });
    }
  }
  const keyboard = buttons.length
    ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } }
    : undefined;
  await bot.sendHtml(conv, detail, keyboard);
}

// ── Manager tools (MCP bridge) ──────────────────────────────────────────────
// The same pipeline the Telegram taps drive, callable from the Manager agent
// (tg-bridge). The bridge route is manager-only (loopback + bearer token);
// these wrappers act as the chat's owner and keep every guard of the tap
// path — allow-list, one-run claim, live-state re-derivation, audit.

/** Resolve a task reference ("6" or "T6") to the task's number + block reason. */
function taskNumberFromRef(md: string, name: string, ref: string): { n: number; needs?: string } {
  const res = parseSpec(md);
  if ("error" in res) throw new Error(`spec "${name}" does not parse: ${res.error.message} (line ${res.error.line})`);
  const trimmed = ref.trim();
  const num = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  const t = res.tasks.find((t) => t.n === num) ?? res.tasks.find((t) => t.id.toLowerCase() === trimmed.toLowerCase());
  if (!t) throw new Error(`task "${ref}" not found in spec "${name}" (tasks: ${res.tasks.map((t) => t.id).join(", ")})`);
  return { n: t.n, needs: t.needs };
}

/** Read the spec's markdown from the conversation's repo (friendly errors). */
async function managerSpecFile(bot: Bot, conv: ConvKey, name: string): Promise<string> {
  if (!NAME_RE.test(name)) throw new Error(`bad spec name "${name}"`);
  const root = await gitRoot(convDir(bot, conv));
  if (!root) throw new Error("the conversation directory is not a git repository");
  const file = join(root, "docs", "sdd", `${name}.md`);
  let md: string;
  try {
    md = readFileSync(file, "utf8");
  } catch {
    throw new Error(`spec "${name}" not found in docs/sdd/`);
  }
  return md;
}

/** The owner uid the manager acts as (the allow-list gate below re-checks it). */
function managerUid(bot: Bot): number | undefined {
  return bot.cfg.allowedUserIds?.[0];
}

function managerLang(bot: Bot, uid: number | undefined): Lang {
  return bot.userPrefs.getLang(uid != null ? String(uid) : "");
}

function managerCb(uid: number | undefined): CallbackQuery {
  return { from: { id: uid } } as unknown as CallbackQuery;
}

/** spec_list — the spec board as plain text (progress, running worker, next task). */
export async function managerSpecList(bot: Bot, conv: ConvKey): Promise<string> {
  const root = await gitRoot(convDir(bot, conv));
  if (!root) throw new Error("the conversation directory is not a git repository");
  const sdd = join(root, "docs", "sdd");
  const entries = scanSpecs(sdd);
  if (!entries.length) return "No spec with a Tasks section in docs/sdd/.";
  const chat = chatOf(conv);
  const lines: string[] = [];
  for (const e of entries) {
    if ("error" in e) {
      lines.push(`⚠️ ${e.name} — parse error: ${e.error.message} (line ${e.error.line})`);
      continue;
    }
    const res = parseSpec(readFileSync(join(sdd, `${e.name}.md`), "utf8"));
    if ("error" in res) continue; // already reported above
    const w = bot.st.findWorker(chat, `spec-${e.name}`)?.[1].worker;
    if (w && BUSY.includes(w.status)) {
      const slot = bot.st.peek(chat)?.specRunning?.[e.name];
      lines.push(`${e.name} — ${e.done}/${e.total} · ● running task ${slot?.task ?? w.specRun?.task ?? "?"} (${w.status})`);
      continue;
    }
    const next = nextAutoTask(res.tasks);
    if (!next) {
      lines.push(`${e.name} — ${e.done}/${e.total} · all done`);
    } else {
      lines.push(`${e.name} — ${e.done}/${e.total} · next: ${next.id} ${next.title}${next.needs ? ` [blocked: ${next.needs}]` : ""}`);
    }
  }
  return lines.join("\n");
}

/** spec_run — same path as the Run tap. Blocked tasks probe first; pass runAnyway to spawn. */
export async function managerSpecRun(bot: Bot, conv: ConvKey, name: string, taskRef: string, runAnyway = false): Promise<string> {
  const uid = managerUid(bot);
  if (!isUserAllowed(bot.cfg, uid)) throw new Error("the manager has no user id on the allow-list");
  const md = await managerSpecFile(bot, conv, name);
  const { n, needs } = taskNumberFromRef(md, name, taskRef);
  if (runAnyway) {
    await specRunSecondTap(bot, managerCb(uid), conv, name, n);
    return `Spawning "${name}" task ${n} (run-anyway). The checkpoint card arrives in this conversation when the worker finishes.`;
  }
  await specRunFirstTap(bot, managerCb(uid), conv, name, n);
  if (needs) {
    return `Task ${n} of "${name}" is BLOCKED ("Needs: ${needs}"). A probe + "Run anyway" offer was posted; call spec_run again with runAnyway=true to spawn.`;
  }
  return `Run requested for "${name}" task ${n}. The checkpoint card arrives in this conversation when the worker finishes.`;
}

/** spec_accept — same path as the Accept button (live-state re-derivation, marker, push). */
export async function managerSpecAccept(bot: Bot, conv: ConvKey, name: string, taskRef: string): Promise<string> {
  const uid = managerUid(bot);
  if (!isUserAllowed(bot.cfg, uid)) throw new Error("the manager has no user id on the allow-list");
  const md = await managerSpecFile(bot, conv, name);
  const { n } = taskNumberFromRef(md, name, taskRef);
  const acc = await specAccept(bot, conv, managerLang(bot, uid), uid, name, n);
  return acc.ok
    ? `Accepted "${name}" task ${n} (marked done, branch pushed). See the conversation for the next-task offer.`
    : `Could not accept "${name}" task ${n} — the refusal reason is posted in the conversation.`;
}

/** spec_auto — same path as the "Auto-run next" button (accept + auto-continue armed). */
export async function managerSpecAuto(bot: Bot, conv: ConvKey, name: string, taskRef: string): Promise<string> {
  const uid = managerUid(bot);
  if (!isUserAllowed(bot.cfg, uid)) throw new Error("the manager has no user id on the allow-list");
  if (!bot.st.findWorker(chatOf(conv), `spec-${name}`)) throw new Error(`no run of spec "${name}" found`);
  const md = await managerSpecFile(bot, conv, name);
  const { n } = taskNumberFromRef(md, name, taskRef);
  const r = await specAuto(bot, conv, managerLang(bot, uid), uid, name, n);
  return r.ok
    ? `Auto started for "${name}" task ${n}: it accepts, then the next task runs with auto-continue armed (it stops at a blocked or failing task).`
    : `Accept of "${name}" task ${n} was refused — the reason is posted in the conversation (nothing auto-ran).`;
}

// ── T6 (docs/sdd/callback-registry.md): the spec-family callback defs ──────
// Wire forms are UNCHANGED by this migration (producers keep the same
// strings): spec:/spcpr:/spcready:/spcclean: carry the spec NAME only (NAME_RE
// rejects ":", so the name can never carry a colon); specrun:/specblocked:/
// specrunok:/spcacc:/spcredo:/spcstop:/spcauto: carry "<name>:<n>". spcauto
// (the S6.5 "Auto-run next" button) was never routed by the old chain — its
// handler sat unreachable in handleSpecCallback — so it is registered here to
// close the gap; tapping it previously fell to the "expired" toast.
export const specCb = oneArg("spec");
export const spcprCb = oneArg("spcpr");
export const spcreadyCb = oneArg("spcready");
export const spccleanCb = oneArg("spcclean");
export const specrunCb = fields("specrun", 2);
export const specblockedCb = fields("specblocked", 2);
export const specrunokCb = fields("specrunok", 2);
export const spcaccCb = fields("spcacc", 2);
export const spcredoCb = fields("spcredo", 2);
export const spcstopCb = fields("spcstop", 2);
export const spcautoCb = fields("spcauto", 2);
