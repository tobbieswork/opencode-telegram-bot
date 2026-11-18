/**
 * Admin feature: the two-step `/reboot` flow (confirmation card + `reboot:`
 * callbacks) and the re-located `/status`, `/context`, `/usage` commands
 * (bodies moved from commands/meta.ts). The `kill:` callback stays a one-line
 * delegate to the orchestrator in bot.ts. Moved out of bot.ts
 * (docs/sdd/split-bot-ts.md, T4). The feature talks to the bot only through
 * the narrow `BotCtx` interface; `Bot` satisfies it structurally so behaviour
 * is unchanged.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { ChatState } from "../state.js";
import { MACHINE_STATE_KEY } from "../state.js";
import type { ModelInfo } from "../opencode.js";
import { esc, trunc, stripTags, fmtNum, timeAgo } from "../format.js";
import { tr } from "../i18n.js";
import { warn, error } from "../logger.js";
import { QUESTIONS_PREAMBLE } from "../shared.js";
import type { UsageRow, RotationInfo } from "../usage.js";
import { formatUsageReport, compactionCeiling } from "../usage.js";
import { SAFE_REBOOT_BIN, rebootTokenFile, buildTokenLine, rebootGoData, isRebootConfirmFresh } from "../uptime.js";
import { currentMode } from "./model.js";

/**
 * The deployed version: `git describe --tags --match "v[0-9]*" --always --dirty`
 * (e.g. `v1.0.2-3-gabc1234`), or the bare short hash when no tag exists yet.
 * Empty string on any failure — /status must never break because git is missing
 * or the repo is not clean.
 *
 * `--match "v[0-9]*"` limits describe to the clean vX.Y.Z tags: release-please
 * also keeps a `<component>-vX.Y.Z` anchor tag on the same commit, and without
 * the filter describe would report that longer name.
 */
function deployedVersion(): Promise<string> {
  return new Promise((res) =>
    execFile("git", ["describe", "--tags", "--match", "v[0-9]*", "--always", "--dirty"], { timeout: 3000 }, (e, out) =>
      res(e ? "" : out.trim())
    )
  );
}

/** Posts the two-step "confirm reboot" card (`reboot:go` / `reboot:cancel`). */
export async function sendRebootConfirm(ctx: BotCtx, conv: ConvKey): Promise<void> {
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const kb: import("../shared.js").Keyboard = {
    inline_keyboard: [
      [
        { text: tr(lang, "✅ Xác nhận reboot", "✅ Confirm reboot"), callback_data: rebootGoData(Date.now()) },
        { text: tr(lang, "❌ Huỷ", "❌ Cancel"), callback_data: "reboot:cancel" },
      ],
    ],
  };
  const secs = Math.round(ctx.cfg.rebootDelayMs / 1000);
  const text =
    tr(lang, `⚠️ <b>Chắc reboot máy không?</b>\n`, `⚠️ <b>Reboot the box?</b>\n`) +
    tr(lang, `Máy sẽ khởi động lại trong ~${secs} giây; bot + OpenCode sẽ tắt và tự chạy lại sau (linger). `, `The box reboots in ~${secs}s; the bot + OpenCode stop and self-resume after (linger). `) +
    tr(lang, "Bấm <b>Xác nhận</b> nếu bạn chắc chắn, hoặc <b>Huỷ</b>.", "Tap <b>Confirm</b> if you're sure, or <b>Cancel</b>.");
  await ctx.tg.sendMessage(conv, text, { reply_markup: kb });
}

/** /reboot — manually start the two-step reboot flow (no confirmation gate yet). */
export async function cmdReboot(ctx: BotCtx, conv: ConvKey): Promise<void> {
  await sendRebootConfirm(ctx, conv);
}

/**
 * Reboot callback flow (two explicit taps required — this reboots the box):
 *   reboot:ask     (from the uptime reminder) → show the confirmation
 *   reboot:go      (from the confirmation)   → confirm, then reboot after the delay
 *   reboot:cancel  → abort
 *   reboot:snooze  (from the uptime reminder)→ re-arm the snooze interval
 */
export async function handleRebootCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId: number | undefined): Promise<void> {
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const action = (cb.data ?? "").slice("reboot:".length).split(":")[0];
  if (action === "snooze") {
    ctx.st.set(MACHINE_STATE_KEY, { lastRebootReminderMs: Date.now() });
    await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "OK, sẽ nhắc lại sau.", "OK, will remind you later."));
    if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
    return;
  }
  if (action === "ask") {
    await ctx.tg.answerCallbackQuery(cb.id);
    if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
    await sendRebootConfirm(ctx, conv);
    return;
  }
  if (action === "cancel") {
    await ctx.tg.answerCallbackQuery(cb.id, tr(lang, "Đã huỷ.", "Cancelled."));
    if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
    return;
  }
  if (action === "go") {
    await ctx.tg.answerCallbackQuery(cb.id);
    if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
    if (!isRebootConfirmFresh(cb.data, Date.now())) {
      await ctx.tg.sendMessage(conv, tr(lang, "⌛ Xác nhận reboot đã hết hạn — gửi /reboot để xác nhận lại.", "⌛ The reboot confirmation expired — send /reboot to confirm again.")).catch(() => {});
      return;
    }
    if (ctx.rebootArmed) return; // double-tap: one reboot is already pending
    if (!existsSync(SAFE_REBOOT_BIN)) {
      await ctx.tg.sendMessage(conv, tr(lang, "⚠️ Wrapper <b>safe-reboot</b> chưa được cài trên máy. Chạy khối sudo trong PR #11 trước.", "⚠️ The <b>safe-reboot</b> wrapper isn't installed on this box. Apply the sudo block from PR #11 first.")).catch(() => {});
      return;
    }
    ctx.rebootArmed = true;
    const secs = Math.round(ctx.cfg.rebootDelayMs / 1000);
    await ctx.tg.sendMessage(conv, tr(lang, `🔄 <b>Đang reboot máy trong ~${secs} giây…</b>\nBot sẽ tự chạy lại sau khi máy lên (linger).`, `🔄 <b>Rebooting the box in ~${secs}s…</b>\nThe bot self-resumes after the box is back (linger).`)).catch(() => {});
    // Fire after the delay so the message above gets delivered. The token is
    // minted INSIDE the timer, right before the wrapper runs: the wrapper
    // rejects tokens older than REBOOT_TOKEN_TTL_MS, and rebootDelayMs
    // (default 15 s) is longer than that, so minting it earlier would always
    // be refused as stale. A stray `systemctl reboot` is refused regardless.
    setTimeout(() => {
      const token = randomBytes(16).toString("hex");
      const tokenFile = rebootTokenFile(homedir());
      try {
        mkdirSync(dirname(tokenFile), { recursive: true });
        writeFileSync(tokenFile, buildTokenLine(token, Date.now()), { mode: 0o600 });
      } catch (e) {
        ctx.rebootArmed = false;
        error("reboot arm failed:", (e as Error)?.message ?? e);
        void ctx.tg.sendMessage(conv, tr(ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? ""), "⚠️ Không tạo được token reboot — xem log bot.", "⚠️ Could not create the reboot token — check the bot log.")).catch(() => {});
        return;
      }
      execFile("sudo", ["-n", SAFE_REBOOT_BIN, token], (err) => {
        ctx.rebootArmed = false; // only reached if the box did NOT go down
        if (err) error("reboot denied/failed:", err.message);
      });
    }, ctx.cfg.rebootDelayMs).unref?.();
    return;
  }
  await ctx.tg.answerCallbackQuery(cb.id);
}

/** `/status` — bot/server/session/connection at a glance. */
export async function cmdStatus(ctx: BotCtx, conv: ConvKey, state: ChatState): Promise<void> {
  const info = await ctx.oc.serverInfo().catch(() => null);
  const version = await deployedVersion();
  const busy = ctx.inflight.has(conv);
  const mode = currentMode(state);
  // Explicitly set model wins; otherwise observe what the session actually
  // runs on (server-resolved default) from the newest assistant message.
  const live = state.sessionID ? await ctx.oc.getSessionModel(state.sessionID).catch(() => undefined) : undefined;
  const model = state.model ?? live;
  const modelLabel = model ? (model.providerID && model.providerID !== "?" ? `${model.providerID}/${model.id}` : model.id) : null;
  const lines = [
    `<b>Bot</b>${version ? ` <code>${esc(version)}</code>` : ""}`,
    `<b>OpenCode</b>${info?.version ? " v" + info.version : ""}`,
    `url: <code>${esc((info?.urls ?? [info?.url]).filter(Boolean).join(", ") || "?")}</code>`,
    `dir: <code>${esc(state.directory || ctx.cfg.opencodeDirectory)}</code>`,
    `session: ${state.sessionID ? `<code>${state.sessionID}</code>` : "none"}`,
    `model: ${modelLabel ? `<code>${esc(modelLabel)}</code>` : "default"}`,
    `variant: <code>${esc(state.variant ?? ctx.cfg.defaultVariant)}</code>`,
    `mode: ${mode ? `<code>${esc(mode)}</code>` : "—"}`,
    `agent: ${state.agent ? `<code>${esc(state.agent)}</code>` : "default"}`,
    `state: ${busy ? "⏳ busy" : "🟢 idle"}`,
  ];
  // The Manager's context FLOOR (min sent-context over 24h) — the persistent
  // baseline that drifts up over days and drives auto-rotation. Manager convs
  // only; a read failure just omits the line (never breaks /status).
  if (state.manager && state.sessionID) {
    const floor = (await ctx.managerFloor(state.sessionID)) ?? 0;
    if (floor > 0) lines.push(`ctx floor: ~${Math.round(floor / 1000)}K`);
  }
  await ctx.sendHtml(conv, lines.join("\n"));
}

/**
 * `/context` — a photo of the current session: what it is, how much it has
 * used, and what it most recently touched. Distinct from /status (connection
 * + settings) and /history (recent message text).
 */
export async function cmdContext(ctx: BotCtx, conv: ConvKey, state: ChatState): Promise<void> {
  if (!state.sessionID) return ctx.tg.sendMessage(conv, "No current session. Send /new.");
  let r;
  try {
    r = await ctx.oc.getSessionReport(state.sessionID);
  } catch (e) {
    return ctx.tg.sendMessage(conv, `⚠️ Could not read the session: ${(e as Error).message}`);
  }
  const base = r.directory || state.directory || ctx.cfg.opencodeDirectory;
  const rel = (p: string) => (base && p.startsWith(base) ? p.slice(base.length).replace(/^\//, "") : p);

  const lines: string[] = [];
  lines.push(`📋 <b>Session</b> — ${esc(trunc(r.title || "(no title)", 60))}`);
  lines.push(`id: <code>${esc(r.id)}</code>`);
  if (r.directory) lines.push(`📁 <code>${esc(r.directory)}</code>`);

  const live = await ctx.oc.getSessionModel(state.sessionID).catch(() => undefined);
  const model = state.model ?? live;
  const modelLabel = model ? (model.providerID && model.providerID !== "?" ? `${model.providerID}/${model.id}` : model.id) : null;
  lines.push(
    `🤖 model: ${modelLabel ? `<code>${esc(modelLabel)}</code>` : "default"} · agent: ${r.agent ? `<code>${esc(r.agent)}</code>` : "default"}`,
  );

  const t = r.tokens;
  if (t) lines.push(`📦 tokens: in ${fmtNum(t.input)} / out ${fmtNum(t.output)} / reasoning ${fmtNum(t.reasoning)} · cache ${fmtNum(t.cache)}`);
  if (typeof r.cost === "number" && r.cost > 0) lines.push(`💰 cost: $${r.cost.toFixed(4)}`);
  lines.push(`💬 ${r.messageCount} messages`);
  if (r.created) lines.push(`🕐 started ${timeAgo(r.created)}`);

  if (r.modifiedFiles.length) {
    const files = r.modifiedFiles.map((f) => `<code>${esc(rel(f))}</code>`).join(", ");
    lines.push(`📝 files: ${files}`);
  }
  if (r.lastUserPrompt) {
    // The first prompt is sent with the headless preamble prepended; strip it
    // so the "last" line shows what the user actually typed.
    const last = r.lastUserPrompt.startsWith(QUESTIONS_PREAMBLE)
      ? r.lastUserPrompt.slice(QUESTIONS_PREAMBLE.length).replace(/^\s+\n+/, "").replace(/\n+$/, "")
      : r.lastUserPrompt;
    if (last.trim()) lines.push(`👤 last: “${esc(trunc(stripTags(last), 120))}”`);
  }
  await ctx.sendHtml(conv, lines.join("\n"));
}

/**
 * /usage — context pressure across every session this bot tracks (manager,
 * workers, regular chats): current context vs the model's window, plus the
 * cumulative totals. The answer to "which session is about to overflow?"
 *
 * REST budget: exactly 2 calls per UNIQUE session — session.get (cumulative
 * tokens) and one message.list (model + current context). Convs that share a
 * session (reattach) are deduped by session id BEFORE any call is made, and
 * the calls run through a small worker pool so many tracked sessions can't
 * fan out into an unbounded burst. (maxRows can't be applied before the
 * fetch: the rows are sorted BY context pressure, which only exists after
 * the calls — so the cap still applies post-fetch, but the fetch itself is
 * already bounded by dedup + pool + the small number of tracked sessions.)
 */
export async function cmdUsage(ctx: BotCtx, conv: ConvKey, arg = ""): Promise<void> {
  const all = /\s--all\b/.test(arg);
  const models = await ctx.oc.listModels().catch(() => [] as ModelInfo[]);
  const entries = Object.entries(ctx.st.all()).filter(
    ([k, s]) => typeof s.sessionID === "string" && k !== MACHINE_STATE_KEY,
  );
  // Several convs can point at one session (reattach): dedup BEFORE calling
  // the API so a shared session costs one fetch, not one per conv.
  const bySid = new Map<string, string>();
  for (const [key, s] of entries) {
    const sid = s.sessionID as string;
    if (bySid.has(sid)) continue;
    const [chatId, topicId] = key.split(":");
    const label = s.worker?.name ?? (s.manager ? "manager" : topicId ? `#topic ${topicId}` : chatId);
    bySid.set(sid, label);
  }
  const sids = [...bySid.keys()];
  const rows: UsageRow[] = new Array(sids.length);
  let next = 0;
  const fetchRow = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= sids.length) return;
      const sid = sids[i];
      const [sess, info] = await Promise.all([
        ctx.oc.getSession(sid).catch(() => null),
        ctx.oc.latestAssistantInfo(sid).catch(() => undefined),
      ]);
      const model = info?.model;
      rows[i] = {
        label: bySid.get(sid)!,
        id: sid,
        current: info?.context,
        limit: model
          ? (models.find((m) => m.id === model.id && m.providerID === model.providerID) ??
             models.find((m) => m.id === model.id))?.contextLimit
          : undefined,
         cumInput: (sess as any)?.tokens?.input ?? 0,
         cumOutput: (sess as any)?.tokens?.output ?? 0,
         // Liveness signal (session.time.updated) — already fetched above, zero extra calls.
         updated: typeof (sess as any)?.time?.updated === "number" ? (sess as any).time.updated : undefined,
       };
    }
  };
  // At most 4 sessions in flight, regardless of how many are tracked.
  await Promise.all(Array.from({ length: Math.min(4, sids.length) }, () => fetchRow()));
  // Manager-rotation footer (display-only): the live floor + 7-day trend come
  // from the rotation monitor's snapshot — the SAME read-only source /rotation
  // renders; the thresholds come from the live config (the snapshot's copy can
  // predate a config change). The compaction ceiling is derived from the
  // manager row's model window. Any failure degrades to "no footer" — /usage
  // must always reply with the session table.
  let rotation: RotationInfo | undefined;
  try {
    const snap = ctx.rotationHealthSnapshot();
    const managerRow = rows.find((r) => r.label === "manager");
    rotation = {
      floorK: snap?.currentFloorK ?? null,
      confirmK: ctx.cfg.rotationConfirmFloorK,
      autoK: ctx.cfg.rotationAutoFloorK,
      compaction: compactionCeiling(managerRow?.limit),
      trend: snap?.floorTrend,
    };
  } catch (e) {
    warn("rotation snapshot:", (e as Error).message);
  }
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  await ctx.sendHtml(conv, formatUsageReport(rows, esc, { warnPct: ctx.cfg.usageWarnPct, maxRows: ctx.cfg.usageMaxRows, activeHours: ctx.cfg.usageActiveHours, all, rotation, lang }).join("\n"));
}
