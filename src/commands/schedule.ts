import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ChatState, Lang } from "../state.js";
import type { ConvKey } from "../conv.js";
import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { randomInt } from "node:crypto";
import { Schedule, SchedSpec, formatSchedule, nextRunAfter, parseScheduleSpec } from "../schedule.js";
import { esc } from "../format.js";
import { errorText, tr } from "../i18n.js";
import { isUnderRoot } from "../fsbrowser.js";
import { AGENT_WHITELIST } from "../shared.js";
import type { Keyboard } from "../shared.js";

// ── /schedule ────────────────────────────────────────────────────────────
// Schedules live in a SEPARATE file (data/schedules.json), never in
// state.json: /clear and the per-chat sweeps must not touch them. The
// Scheduler (src/scheduler.ts) ticks that file; this is only the command
// surface. v1 scope: scheduled runs do read/analyze + report only — the
// worker's permission cards still go to the user, nothing is auto-approved.

/** A fresh 4-char base36 id (fits callback_data) that doesn't collide yet. */
function newScheduleId(bot: Bot): string {
  const existing = new Set(bot.scheduleStore.load().map((s) => s.id));
  for (let i = 0; i < 16; i++) {
    const id = randomInt(36 ** 4).toString(36).padStart(4, "0");
    if (!existing.has(id)) return id;
  }
  return Date.now().toString(36).slice(-4).padStart(4, "0");
}

/** Re-check a schedule's creator against the allowlist (it can change after creation). */
function creatorAllowed(bot: Bot, sch: Schedule): boolean {
  if (bot.cfg.allowAny) return true;
  return bot.cfg.allowedUserIds.includes(sch.createdBy);
}

/** The list view: one line + one button row per schedule (⏸/▶ · ▶▶ · 🗑). */
function scheduleListMarkup(bot: Bot, mine: Schedule[], lang: Lang): { html: string; kb: Keyboard } {
  const fmtNext = (ms: number) =>
    new Date(ms).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
  const lines = mine.map((s) => {
    const paused = s.enabled ? "" : "⏸ ";
    const status = s.lastStatus ? ` · ${s.lastStatus}` : "";
    const next = s.enabled ? ` · ${tr(lang, "lần tới", "next")}: ${fmtNext(s.nextRunAt)}` : "";
    return `${paused}${formatSchedule(s)}${status}${next}`;
  });
  const rows = mine.map((s) => [
    { text: s.enabled ? "⏸" : "▶", callback_data: `sch:${s.enabled ? "p" : "r"}:${s.id}` },
    { text: "▶▶", callback_data: `sch:run:${s.id}` },
    { text: "🗑", callback_data: `sch:d:${s.id}` },
  ]);
  return { html: `<b>⏰ ${tr(lang, "Lịch", "Schedules")} (${mine.length})</b>\n${lines.join("\n")}`, kb: { inline_keyboard: rows } };
}

/** The /schedule usage card, HTML-escaped (sendMessage is parse_mode HTML). Localized by lang. */
function scheduleUsageText(bot: Bot, lang: Lang): string {
  const usage =
    lang === "en"
      ? "Schedule: /schedule <spec> <prompt> [dir=<path> agent=<name>]\n" +
        "spec: daily|weekdays HH:MM · weekly mon..sun HH:MM · every <N>h · once YYYY-MM-DD HH:MM\n" +
        `e.g.: /schedule daily 08:00 Review commits from the last 24h dir=${bot.cfg.opencodeDirectory}\n\n` +
        "Manage: /schedule help · pause|resume|run|rm <id>\n" +
        "Note: dir= is required (a folder outside data/manager) — schedules don't run in the Manager folder. Default agent: build."
      : "Đặt lịch: /schedule <spec> <prompt> [dir=<đường dẫn> agent=<tên>]\n" +
        "spec: daily|weekdays HH:MM · weekly mon..sun HH:MM · every <N>h · once YYYY-MM-DD HH:MM\n" +
        `vd: /schedule daily 08:00 Review commit 24h qua dir=${bot.cfg.opencodeDirectory}\n\n` +
        "Quản lý: /schedule help · pause|resume|run|rm <id>\n" +
        "Lưu ý: phải có dir= (thư mục ngoài data/manager) — lịch không chạy trong thư mục Manager. Agent mặc định: build.";
  return esc(usage);
}

export async function cmdSchedule(bot: Bot, conv: ConvKey, arg: string, state: ChatState, uid?: number): Promise<void> {
  // Top-level safety net: no /schedule input may drop without a reply — an
  // unexpected throw (e.g. statSync on a vanishing dir) must never be silent.
  try {
    await cmdScheduleInner(bot, conv, arg, state, uid);
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    try {
      await bot.tg.sendMessage(conv, errorText(bot.userPrefs.getLang(uid ?? ""), m));
    } catch {
      /* swallow — last resort */
    }
  }
}

async function cmdScheduleInner(bot: Bot, conv: ConvKey, arg: string, state: ChatState, uid?: number): Promise<void> {
  const lang = bot.userPrefs.getLang(uid ?? "");
  const loc = lang === "en" ? "en-US" : "vi-VN";
  // No arg → list this conv's schedules with control buttons.
  if (!arg) {
    const mine = bot.scheduleStore.load().filter((s) => s.conv === conv);
    if (!mine.length) {
      await bot.tg.sendMessage(conv, tr(lang, "⏰ Chưa có lịch nào cho chat này.\n\n", "⏰ No schedules for this chat yet.\n\n") + scheduleUsageText(bot, lang));
      return;
    }
    const v = scheduleListMarkup(bot, mine, lang);
    await bot.sendHtml(conv, v.html, { reply_markup: v.kb });
    return;
  }

  // Subcommands: pause|resume|run|rm <id>
  const [sub, ...rest] = arg.split(/\s+/);
  const subLc = sub.toLowerCase();
  if (subLc === "help" || subLc === "--help" || subLc === "-h") {
    await bot.tg.sendMessage(conv, tr(lang, "⏰ Cách dùng /schedule\n\n", "⏰ /schedule usage\n\n") + scheduleUsageText(bot, lang));
    return;
  }
  if (["pause", "resume", "run", "rm", "del", "delete"].includes(subLc)) {
    const id = (rest.join(" ").trim().split(/\s+/)[0] ?? "").replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(id)) {
      await bot.tg.sendMessage(conv, tr(lang, "⏰ Id không hợp lệ — 4 ký tự a-z/0-9. Danh sách: /schedule", "⏰ Invalid id — 4 chars a-z/0-9. List: /schedule"));
      return;
    }
    if (subLc === "run") return scheduleRun(bot, conv, id);
    const op: "pause" | "resume" | "rm" = subLc === "pause" ? "pause" : subLc === "resume" ? "resume" : "rm";
    return scheduleMutate(bot, conv, id, op);
  }

  // Add: /schedule <spec> <prompt> [dir=<path> agent=<name>]
  if (uid === undefined) {
    await bot.tg.sendMessage(conv, tr(lang, "⛔ Không xác định được người dùng.", "⛔ Can't determine the user."));
    return;
  }
  let spec: SchedSpec;
  let prompt: string;
  try {
    ({ spec, prompt } = parseScheduleSpec(arg, Date.now(), lang));
  } catch (e) {
    await bot.tg.sendMessage(conv, `❌ ${(e as Error).message.replace(/^schedule:\s*/, "")}`);
    return;
  }
  if (!prompt) {
    await bot.tg.sendMessage(conv, tr(lang, "❌ Thiếu prompt — ví dụ: /schedule daily 08:00 Review commit 24h qua", "❌ Missing prompt — e.g.: /schedule daily 08:00 Review commits from the last 24h"));
    return;
  }
  // Option tokens — parseScheduleSpec strips them from the prompt itself.
  let dir = state.directory || bot.cfg.opencodeDirectory;
  let agent = "build";
  for (const t of arg.trim().split(/\s+/)) {
    if (/^dir=/i.test(t)) dir = t.slice(4);
    else if (/^agent=/i.test(t)) agent = t.slice(6).toLowerCase();
  }
  if (!AGENT_WHITELIST.includes(agent)) {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Agent không hợp lệ — chọn: ${AGENT_WHITELIST.join(", ")}`, `❌ Invalid agent — choose: ${AGENT_WHITELIST.join(", ")}`));
    return;
  }
  if (!isAbsolute(dir)) dir = resolve(bot.cfg.opencodeDirectory, dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Không tìm thấy thư mục: <code>${esc(dir)}</code>`, `❌ Directory not found: <code>${esc(dir)}</code>`));
    return;
  }
  if (bot.cfg.browseRoots.length && !isUnderRoot(dir, bot.cfg.browseRoots)) {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Thư mục ngoài vùng cho phép (OPENCODE_TG_BROWSE_ROOTS): <code>${esc(dir)}</code>`, `❌ Directory outside the allowed area (OPENCODE_TG_BROWSE_ROOTS): <code>${esc(dir)}</code>`));
    return;
  }
  if (bot.scheduleStore.load().length >= bot.cfg.maxSchedules) {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Đã đủ ${bot.cfg.maxSchedules} lịch (giới hạn). Xoá bớt trước khi thêm.`, `❌ Schedule limit (${bot.cfg.maxSchedules}) reached. Delete some first.`));
    return;
  }
  const now = Date.now();
  const sch: Schedule = {
    id: newScheduleId(bot),
    conv,
    prompt,
    spec,
    tz: bot.cfg.scheduleTz,
    dir,
    agent,
    nextRunAt: nextRunAfter(spec, now, bot.cfg.scheduleTz, lang),
    createdBy: uid,
    enabled: true,
    createdAt: now,
  };
  // Spawn the (idle) worker topic FIRST: if the chat can't host a topic the
  // schedule would be useless, so on failure nothing is kept. The error
  // message already carries the topic guidance (orchestrator.spawn).
  try {
    await bot.orch.spawn(conv, { name: "sch-" + sch.id, directory: dir, agent, spawnedBy: "schedule" });
  } catch (e) {
    const m = (e as Error).message;
    const hint =
      m.includes("thư mục của Manager") || m.includes("Manager directory")
        ? lang === "en"
          ? `\n→ Add dir= (a folder outside data/manager). E.g.: dir=${bot.cfg.opencodeDirectory}`
          : `\n→ Thêm dir= (thư mục ngoài data/manager). VD: dir=${bot.cfg.opencodeDirectory}`
        : "";
    await bot.tg.sendMessage(conv, `❌ ${m}${hint}`);
    return;
  }
  try {
    bot.scheduleStore.add(sch, lang);
  } catch (e) {
    await bot.tg.sendMessage(conv, `❌ ${(e as Error).message}`);
    return;
  }
  await bot.tg.sendMessage(
    conv,
    `${tr(lang, "⏰ Đã tạo lịch", "⏰ Created schedule")} <b>#${sch.id}</b> — ${formatSchedule(sch)}\n${tr(lang, "lần tới", "next")}: ${new Date(sch.nextRunAt).toLocaleString(loc, { dateStyle: "short", timeStyle: "short" })}\n📁 <code>${esc(dir)}</code> · agent: ${agent}`,
  );
}

/** pause/resume/rm — the creator must still be on the allowlist. */
async function scheduleMutate(bot: Bot, conv: ConvKey, id: string, op: "pause" | "resume" | "rm"): Promise<void> {
  const lang = bot.userPrefs.getLang(bot.st.peek(conv)?.createdBy ?? "");
  const sch = bot.scheduleStore.get(id);
  if (!sch || sch.conv !== conv) {
    await bot.tg.sendMessage(conv, tr(lang, `⏰ Không tìm thấy lịch #${id} của chat này.`, `⏰ No schedule #${id} for this chat.`));
    return;
  }
  if (!creatorAllowed(bot, sch)) {
    await bot.tg.sendMessage(conv, tr(lang, `⛔ Người tạo lịch #${id} không còn trong allowlist — không thể thao tác.`, `⛔ The creator of schedule #${id} is no longer on the allowlist — can't modify.`));
    return;
  }
  if (op === "rm") {
    bot.scheduleStore.remove(id);
    await bot.tg.sendMessage(conv, tr(lang, `🗑 Đã xoá lịch #${id}. Topic + lịch sử vẫn giữ — /prune để dọn topic.`, `🗑 Deleted schedule #${id}. Topic + history kept — /prune to clean the topic.`));
    return;
  }
  const updated = bot.scheduleStore.set(id, { enabled: op === "resume" });
  if (!updated) {
    await bot.tg.sendMessage(conv, tr(lang, `⏰ Không tìm thấy lịch #${id}.`, `⏰ Schedule #${id} not found.`));
    return;
  }
  await bot.tg.sendMessage(conv, op === "resume" ? tr(lang, `▶ Đã bật lại lịch #${id}.`, `▶ Resumed schedule #${id}.`) : tr(lang, `⏸ Đã tạm dừng lịch #${id}.`, `⏸ Paused schedule #${id}.`));
}

/** Run a schedule now (manual trigger). */
async function scheduleRun(bot: Bot, conv: ConvKey, id: string): Promise<void> {
  const lang = bot.userPrefs.getLang(bot.st.peek(conv)?.createdBy ?? "");
  const sch = bot.scheduleStore.get(id);
  if (!sch || sch.conv !== conv) {
    await bot.tg.sendMessage(conv, tr(lang, `⏰ Không tìm thấy lịch #${id} của chat này.`, `⏰ No schedule #${id} for this chat.`));
    return;
  }
  if (!creatorAllowed(bot, sch)) {
    await bot.tg.sendMessage(conv, tr(lang, `⛔ Người tạo lịch #${id} không còn trong allowlist — không thể chạy.`, `⛔ The creator of schedule #${id} is no longer on the allowlist — can't run.`));
    return;
  }
  try {
    await bot.orch.runScheduled(conv, sch);
    await bot.tg.sendMessage(conv, tr(lang, `▶▶ Đã chạy lịch #${id} — kết quả sẽ hiện trong topic sch-${id}.`, `▶▶ Ran schedule #${id} — results will show in topic sch-${id}.`));
  } catch (e) {
    await bot.tg.sendMessage(conv, tr(lang, `❌ Lịch #${id} không chạy được: ${(e as Error).message}`, `❌ Schedule #${id} can't run: ${(e as Error).message}`));
  }
}

/** Schedule button taps: sch:p/sch:r (pause/resume) · sch:run · sch:d/sch:dy (rm, 2-step) · sch:ls (re-list). */
export async function handleScheduleCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const lang = bot.userPrefs.getLang(cb.from?.id ?? "");
  const [, op, id] = (cb.data ?? "").split(":");
  // Re-list after a confirm/cancel — no schedule id involved.
  if (op === "ls") {
    await bot.tg.answerCallbackQuery(cb.id);
    if (!messageId) return;
    const mine = bot.scheduleStore.load().filter((s) => s.conv === conv);
    const v = mine.length
      ? scheduleListMarkup(bot, mine, lang)
      : { html: tr(lang, "⏰ Không còn lịch nào.", "⏰ No more schedules."), kb: { inline_keyboard: [] as Array<Array<{ text: string; callback_data: string }>> } };
    await bot.tg.editMessageText(conv, messageId, v.html, { reply_markup: v.kb }).catch(() => {});
    return;
  }
  if (!/^[a-z0-9]{4}$/.test(id ?? "")) {
    await bot.tg.answerCallbackQuery(cb.id, tr(lang, "⏰ Id không hợp lệ", "⏰ Invalid id"));
    return;
  }
  const sch = bot.scheduleStore.get(id);
  if (!sch || sch.conv !== conv) {
    await bot.tg.answerCallbackQuery(cb.id, tr(lang, "⏰ Không tìm thấy lịch này của chat", "⏰ No such schedule in this chat"));
    return;
  }
  if (!creatorAllowed(bot, sch)) {
    await bot.tg.answerCallbackQuery(cb.id, tr(lang, "⛔ Người tạo không còn trong allowlist", "⛔ Creator no longer on the allowlist"));
    return;
  }
  switch (op) {
    case "p":
    case "r": {
      const enable = op === "r";
      bot.scheduleStore.set(id, { enabled: enable });
      await bot.tg.answerCallbackQuery(cb.id, enable ? tr(lang, `▶ Đã bật lại #${id}`, `▶ Resumed #${id}`) : tr(lang, `⏸ Đã dừng #${id}`, `⏸ Paused #${id}`));
      if (messageId) {
        const mine = bot.scheduleStore.load().filter((s) => s.conv === conv);
        const v = mine.length
          ? scheduleListMarkup(bot, mine, lang)
          : { html: tr(lang, "⏰ Không còn lịch nào.", "⏰ No more schedules."), kb: { inline_keyboard: [] as Array<Array<{ text: string; callback_data: string }>> } };
        await bot.tg.editMessageText(conv, messageId, v.html, { reply_markup: v.kb }).catch(() => {});
      }
      return;
    }
    case "run": {
      await bot.tg.answerCallbackQuery(cb.id, tr(lang, `▶▶ Đang chạy #${id}…`, `▶▶ Running #${id}…`));
      try {
        await bot.orch.runScheduled(conv, sch);
      } catch (e) {
        await bot.tg.sendMessage(conv, tr(lang, `❌ Lịch #${id} không chạy được: ${(e as Error).message}`, `❌ Schedule #${id} can't run: ${(e as Error).message}`)).catch(() => {});
      }
      return;
    }
    case "d": {
      // Destructive — two-step confirm (like /reboot).
      await bot.tg.answerCallbackQuery(cb.id);
      if (!messageId) return;
      const kb: Keyboard = {
        inline_keyboard: [
          [
            { text: tr(lang, `🗑 Xoá #${id}`, `🗑 Delete #${id}`), callback_data: `sch:dy:${id}` },
            { text: tr(lang, "↩️ Quay lại", "↩️ Back"), callback_data: "sch:ls" },
          ],
        ],
      };
      await bot.tg
        .editMessageText(conv, messageId, tr(lang, `⚠️ Xoá lịch <b>#${id}</b> (${formatSchedule(sch)})? Topic + lịch sử vẫn giữ.`, `⚠️ Delete schedule <b>#${id}</b> (${formatSchedule(sch)})? Topic + history kept.`), { reply_markup: kb })
        .catch(() => {});
      return;
    }
    case "dy": {
      bot.scheduleStore.remove(id);
      await bot.tg.answerCallbackQuery(cb.id, tr(lang, `🗑 Đã xoá #${id}`, `🗑 Deleted #${id}`));
      if (messageId) {
        await bot.tg
          .editMessageText(conv, messageId, tr(lang, `🗑 Đã xoá lịch <b>#${id}</b>. Dọn topic mồ côi bằng /prune.`, `🗑 Deleted schedule <b>#${id}</b>. Clean up the orphaned topic with /prune.`), { reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      return;
    }
    default:
      await bot.tg.answerCallbackQuery(cb.id);
  }
}
