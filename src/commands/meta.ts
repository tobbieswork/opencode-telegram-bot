import { execFile } from "node:child_process";
import type { Bot } from "../bot.js";
import type { CallbackQuery } from "../telegram.js";
import type { ModelInfo } from "../opencode.js";
import { MACHINE_STATE_KEY } from "../state.js";
import type { ChatState } from "../state.js";
import type { ConvKey } from "../conv.js";
import { esc, trunc, stripTags, fmtNum, timeAgo } from "../format.js";
import { helpText, commandGrid } from "../commands.js";
import type { UsageRow } from "../usage.js";
import { formatUsageReport } from "../usage.js";
import { appendNote, noteEntryText, showNotes, BUSY_REPLY_TEXT, parseNoteCallback } from "../notes.js";
import { warn } from "../logger.js";
import { QUESTIONS_PREAMBLE, NOTES_KEY } from "../shared.js";

export async function cmdHelp(bot: Bot, conv: ConvKey): Promise<void> {
  await bot.sendHtml(conv, helpText(), { reply_markup: commandGrid() });
}

/**
 * `/note [text]` — jot down information while the agent is busy. Without a
 * text, show the pending notes. The note reaches the model through an
 * instruction entry at the start of the next user-initiated turn and retires
 * on the turn after that (see src/notes.ts).
 */
export async function cmdNote(bot: Bot, conv: ConvKey, arg: string): Promise<void> {
  const text = arg.trim();
  if (!text) {
    const pending = showNotes(bot.st.get(conv));
    await bot.tg.sendMessage(conv, pending ? `📝 Ghi chú đang chờ:\n${esc(pending)}` : "Chưa có ghi chú nào. Dùng: /note (nội dung)");
    return;
  }
  const cur = bot.st.get(conv);
  const next = appendNote(cur, text, Date.now());
  bot.st.set(conv, next);
  const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
  if (sid) {
    // Best-effort immediate PUT so the note is in context by the time the next
    // turn starts; prepareNotesTurn re-puts at turn start anyway (self-healing).
    await bot.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!)).catch((e) => warn("note put:", (e as Error).message));
  }
  await bot.tg.sendMessage(conv, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.");
}

/**
 * "📝 Thêm vào note" button on a busy reply: append the user message that was
 * dropped (the agent was busy) to the scratchpad notes, so the agent sees it on
 * the next turn. The text is looked up in the in-memory retention map by the
 * user message's Telegram id (carried in the callback data); if the turn has
 * already ended (or the bot restarted) the entry is gone → "not found".
 */
export async function handleNoteCallback(bot: Bot, cb: CallbackQuery, conv: ConvKey, messageId?: number): Promise<void> {
  const id = parseNoteCallback(cb.data);
  if (id == null) {
    await bot.tg.answerCallbackQuery(cb.id);
    return;
  }
  // Consume the entry NOW (before any await) so a double-tap can't append twice.
  const text = bot.busyNotes.take(conv, id);
  if (text == null) {
    await bot.tg.answerCallbackQuery(cb.id, "Không tìm thấy nội dung tin nhắn đó.");
    return;
  }
  // Save via the SAME path as cmdNote: append + persist + best-effort PUT.
  const cur = bot.st.get(conv);
  const next = appendNote(cur, text, Date.now());
  bot.st.set(conv, next);
  const sid = cur.sessionID; // appendNote spreads the full state, so sessionID is unchanged
  if (sid) {
    await bot.oc.setInstruction(sid, NOTES_KEY, noteEntryText(next.notes!)).catch((e) => warn("note put:", (e as Error).message));
  }
  await bot.tg.answerCallbackQuery(cb.id, "📝 Đã ghi — agent sẽ xem ở lượt tiếp theo.");
  // Remove the button: edit the busy message back to plain text (empty keyboard).
  // Best-effort — the message may be too old or deleted; ignore gracefully.
  if (messageId != null) {
    await bot.tg
      .editMessageText(conv, messageId, BUSY_REPLY_TEXT, { reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
  }
}

/**
 * The deployed version: `git describe --tags --always --dirty` (e.g. `v1.0.2-3-gabc1234`),
 * or the bare short hash when no tag exists yet. Empty string on any failure —
 * /status must never break because git is missing or the repo is not clean.
 */
function deployedVersion(): Promise<string> {
  return new Promise((res) =>
    execFile("git", ["describe", "--tags", "--always", "--dirty"], { timeout: 3000 }, (e, out) =>
      res(e ? "" : out.trim())
    )
  );
}

export async function cmdStatus(bot: Bot, conv: ConvKey, state: ChatState): Promise<void> {
  const info = await bot.oc.serverInfo().catch(() => null);
  const version = await deployedVersion();
  const busy = bot.inflight.has(conv);
  const mode = bot.currentMode(state);
  // Explicitly set model wins; otherwise observe what the session actually
  // runs on (server-resolved default) from the newest assistant message.
  const live = state.sessionID ? await bot.oc.getSessionModel(state.sessionID).catch(() => undefined) : undefined;
  const model = state.model ?? live;
  const modelLabel = model ? (model.providerID && model.providerID !== "?" ? `${model.providerID}/${model.id}` : model.id) : null;
  const lines = [
    `<b>Bot</b>${version ? ` <code>${esc(version)}</code>` : ""}`,
    `<b>OpenCode</b>${info?.version ? " v" + info.version : ""}`,
    `url: <code>${esc((info?.urls ?? [info?.url]).filter(Boolean).join(", ") || "?")}</code>`,
    `dir: <code>${esc(state.directory || bot.cfg.opencodeDirectory)}</code>`,
    `session: ${state.sessionID ? `<code>${state.sessionID}</code>` : "none"}`,
    `model: ${modelLabel ? `<code>${esc(modelLabel)}</code>` : "default"}`,
    `variant: <code>${esc(state.variant ?? bot.cfg.defaultVariant)}</code>`,
    `mode: ${mode ? `<code>${esc(mode)}</code>` : "—"}`,
    `agent: ${state.agent ? `<code>${state.agent}</code>` : "default"}`,
    `state: ${busy ? "⏳ busy" : "🟢 idle"}`,
  ];
  await bot.sendHtml(conv, lines.join("\n"));
}

/**
 * `/context` — a photo of the current session: what it is, how much it has
 * used, and what it most recently touched. Distinct from /status (connection
 * + settings) and /history (recent message text).
 */
export async function cmdContext(bot: Bot, conv: ConvKey, state: ChatState): Promise<void> {
  if (!state.sessionID) return bot.tg.sendMessage(conv, "No current session. Send /new.");
  let r;
  try {
    r = await bot.oc.getSessionReport(state.sessionID);
  } catch (e) {
    return bot.tg.sendMessage(conv, `⚠️ Could not read the session: ${(e as Error).message}`);
  }
  const base = r.directory || state.directory || bot.cfg.opencodeDirectory;
  const rel = (p: string) => (base && p.startsWith(base) ? p.slice(base.length).replace(/^\//, "") : p);

  const lines: string[] = [];
  lines.push(`📋 <b>Session</b> — ${esc(trunc(r.title || "(no title)", 60))}`);
  lines.push(`id: <code>${esc(r.id)}</code>`);
  if (r.directory) lines.push(`📁 <code>${esc(r.directory)}</code>`);

  const live = await bot.oc.getSessionModel(state.sessionID).catch(() => undefined);
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
  await bot.sendHtml(conv, lines.join("\n"));
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
export async function cmdUsage(bot: Bot, conv: ConvKey, arg = ""): Promise<void> {
  const all = /\s--all\b/.test(arg);
  const models = await bot.oc.listModels().catch(() => [] as ModelInfo[]);
  const entries = Object.entries(bot.st.all()).filter(
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
        bot.oc.getSession(sid).catch(() => null),
        bot.oc.latestAssistantInfo(sid).catch(() => undefined),
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
  await bot.sendHtml(conv, formatUsageReport(rows, esc, { warnPct: bot.cfg.usageWarnPct, maxRows: bot.cfg.usageMaxRows, activeHours: bot.cfg.usageActiveHours, all }).join("\n"));
}

export async function cmdHistory(bot: Bot, conv: ConvKey, state: ChatState): Promise<void> {
  if (!state.sessionID) return bot.tg.sendMessage(conv, "No current session. Send /new.");
  const msgs = await bot.oc.listMessages(state.sessionID).catch(() => [] as any[]);
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
  await bot.sendHtml(conv, `<b>Recent messages</b>\n${lines.join("\n")}`);
}
