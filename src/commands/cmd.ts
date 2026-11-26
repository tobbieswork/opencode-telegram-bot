/**
 * /cmd — run a shell command on the host, with a two-step confirmation.
 *
 * Flow: `/cmd <command>` posts a card showing the exact command; the user taps
 * Run to execute it (or Cancel to dismiss). Mirrors /reboot's two-tap confirm.
 *
 * Security model (narrowest viable, documented):
 *   - Allow-list only: a non-allowlisted user is rejected by the onMessage gate
 *     before any command dispatches, so only the configured user can use /cmd.
 *   - Two-step confirm: the command is shown first; a single-use, 10-minute
 *     token must be tapped to execute, so a stale card can't re-arm.
 *   - Runs as the bot user (the systemd user service); no privilege escalation
 *     (this box has no passwordless sudo for general commands — only the
 *     one-shot safe-reboot wrapper, which /reboot already exposes).
 *   - 60s timeout, 4MB buffer; each stream is tail-capped to fit Telegram.
 *   - Every execution is audit-logged (action "cmd"); the command text is
 *     redacted + truncated by the audit layer.
 *
 * This is a remote shell. The allow-list is the only gate; the bot already runs
 * arbitrary (LLM-generated) code as the same user, so /cmd is not a new trust
 * boundary — it is a direct user-triggered path for the one allowed user.
 */
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { audit } from "../audit.js";
import { esc } from "../format.js";
import { tr } from "../i18n.js";
import { oneArg, simple } from "../callbacks.js";
import { confirmKeyboard } from "../ui/keyboards.js";
import { UI_ICON } from "../ui/icons.js";
import type { Lang } from "../state.js";
import type { ConvKey } from "../conv.js";
import type { CallbackQuery } from "../telegram.js";
import type { BotCtx } from "./ctx.js";

const CMD_TIMEOUT_MS = 60_000;
const CMD_MAX_BUFFER = 4 * 1024 * 1024; // 4MB
const CMD_MAX_OUTPUT = 30_000; // keep the tail of each stream past this
const CMD_CONFIRM_TTL_MS = 10 * 60_000; // 10 min — a stale card can't re-arm

/** Run button: `sh:<token>` (the token maps to the command server-side). */
export const shCallback = oneArg("sh");
/** Cancel button: `shcancel:` (no value). */
export const shCancelCallback = simple("shcancel");

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout); otherwise the exit code. */
  exit: number | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a shell command via `sh -c`, capturing stdout/stderr/exit. Never throws:
 * a timeout or non-zero exit is reported in the result. Bounded by timeout +
 * maxBuffer. `cwd` defaults to the user's home (absolute paths + `cd` work).
 */
export async function runShellCommand(
  command: string,
  opts: { timeoutMs?: number; cwd?: string; maxBuffer?: number } = {},
): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? CMD_TIMEOUT_MS;
  const cwd = opts.cwd ?? homedir();
  const maxBuffer = opts.maxBuffer ?? CMD_MAX_BUFFER;
  const t0 = Date.now();
  return await new Promise<ShellResult>((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, cwd, maxBuffer, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - t0;
        const killed = !!(err && (err as unknown as { killed?: boolean }).killed);
        const code =
          err && !killed
            ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1)
            : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exit: killed ? null : code, timedOut: killed, durationMs });
      },
    );
  });
}

/** Keep the tail of a stream past the cap, reporting how many head-chars were dropped. */
export function tailCap(s: string, cap: number = CMD_MAX_OUTPUT): { text: string; cut: number } {
  if (s.length <= cap) return { text: s, cut: 0 };
  return { text: s.slice(-cap), cut: s.length - cap };
}

/**
 * Build the HTML reply for a shell result: a header (the command), a status
 * line (exit / timeout + duration), then stdout and — if present — stderr, each
 * as a <pre> block with its tail kept past the cap. The body may exceed one
 * Telegram message; the caller sends it via tg.sendMessage (tag-balanced chunking).
 */
export function formatCmdResult(command: string, res: ShellResult, lang: Lang): { ok: boolean; html: string } {
  const secs = (res.durationMs / 1000).toFixed(1);
  const lines: string[] = [`<b>/cmd</b> <code>${esc(command)}</code>`];
  if (res.timedOut) {
    const s = Math.round(res.durationMs / 1000);
    lines.push(`${UI_ICON.warning} ${tr(lang, `hết hạn sau ${s}s`, `timed out after ${s}s`)}`);
  } else if (res.exit === 0) {
    lines.push(`${UI_ICON.success} exit 0 · ${secs}s`);
  } else {
    lines.push(`${UI_ICON.error} exit ${res.exit} · ${secs}s`);
  }
  if (res.stdout) {
    const { text, cut } = tailCap(res.stdout);
    if (cut) lines.push(`<i>…${tr(lang, `bỏ ${cut} ký tự đầu`, `dropped ${cut} head chars`)}…</i>`);
    lines.push(`<pre>${esc(text)}</pre>`);
  }
  if (res.stderr) {
    const { text, cut } = tailCap(res.stderr);
    lines.push(`<b>stderr</b>`);
    if (cut) lines.push(`<i>…${tr(lang, `bỏ ${cut} ký tự đầu`, `dropped ${cut} head chars`)}…</i>`);
    lines.push(`<pre>${esc(text)}</pre>`);
  }
  if (!res.stdout && !res.stderr) {
    lines.push(`(${tr(lang, "không có output", "no output")}, exit ${res.timedOut ? "?" : res.exit})`);
  }
  return { ok: !res.timedOut && res.exit === 0, html: lines.join("\n") };
}

// ── single-use confirm tokens: token → { command, ts } ────────────────────────
const pendingCmds = new Map<string, { command: string; ts: number }>();

/** Mint a 12-char base36 token bound to `command`; opportunistically GC expired. */
function mintPendingCmd(command: string): string {
  let token = "";
  for (;;) {
    token = randomBytes(9).toString("base64url").slice(0, 12);
    if (!pendingCmds.has(token)) break;
  }
  pendingCmds.set(token, { command, ts: Date.now() });
  if (pendingCmds.size > 50) {
    const now = Date.now();
    for (const [k, v] of pendingCmds) if (now - v.ts > CMD_CONFIRM_TTL_MS) pendingCmds.delete(k);
  }
  return token;
}

/** Consume a token (single-use); null if missing or past the 10-min TTL. */
function takePendingCmd(token: string): { command: string } | null {
  const rec = pendingCmds.get(token);
  pendingCmds.delete(token); // single-use regardless of outcome
  if (!rec) return null;
  if (Date.now() - rec.ts > CMD_CONFIRM_TTL_MS) return null; // stale
  return rec;
}

/** Test hook: drop all pending confirmations (prevents cross-test bleed). */
export function _clearPendingCmdsForTest(): void {
  pendingCmds.clear();
}

/**
 * `/cmd <command>` — post the confirmation card (no execution yet). The Run
 * button carries a single-use, 10-min token bound to `command`.
 */
export async function cmdCmd(ctx: BotCtx, conv: ConvKey, arg: string, uid?: number): Promise<void> {
  const lang: Lang = ctx.userPrefs.getLang(uid ?? "");
  const command = arg.trim();
  if (!command) {
    await ctx.tg.sendMessage(
      conv,
      tr(
        lang,
        "Cú pháp: <code>/cmd &lt;lệnh&gt;</code> — chạy lệnh shell (có nút xác nhận, timeout 60s).\nVD: <code>/cmd ls -la</code>, <code>/cmd git log --oneline -5</code>",
        "Usage: <code>/cmd &lt;command&gt;</code> — run a shell command (confirm to execute, 60s timeout).\nE.g. <code>/cmd ls -la</code>, <code>/cmd git log --oneline -5</code>",
      ),
    );
    return;
  }
  const token = mintPendingCmd(command);
  const kb = confirmKeyboard(
    lang,
    { text: tr(lang, "▶️ Chạy", "▶️ Run"), data: shCallback.encode(token) },
    { text: tr(lang, "❌ Huỷ", "❌ Cancel"), data: shCancelCallback.encode(undefined) },
  );
  const text =
    `<b>/cmd</b> <code>${esc(command)}</code>\n` +
    tr(lang, "Bấm <b>▶️ Chạy</b> để thực thi (timeout 60s), hoặc <b>Huỷ</b>.", "Tap <b>▶️ Run</b> to execute (60s timeout) or <b>Cancel</b>.");
  await ctx.tg.sendMessage(conv, text, { reply_markup: kb });
}

/** Run-button handler: consume the token and execute the bound command. */
export async function handleCmdRun(
  ctx: BotCtx,
  cb: CallbackQuery,
  conv: ConvKey,
  token: string,
  answer: (t?: string) => void,
  messageId?: number,
): Promise<void> {
  const uid = cb.from?.id;
  const lang: Lang = ctx.userPrefs.getLang(uid ?? "");
  const rec = takePendingCmd(token);
  if (!rec) {
    answer(tr(lang, "Xác nhận đã hết hạn — gửi /cmd lại.", "Confirmation expired — send /cmd again."));
    if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
    return;
  }
  answer();
  if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
  const res = await runShellCommand(rec.command);
  audit({
    action: "cmd",
    userId: uid,
    chatId: conv,
    outcome: res.timedOut ? "timeout" : res.exit === 0 ? "ok" : "error",
    text: rec.command,
    meta: { exit: res.exit, timedOut: res.timedOut, durationMs: res.durationMs },
  });
  const { html } = formatCmdResult(rec.command, res, lang);
  await ctx.tg.sendMessage(conv, html);
}

/** Cancel-button handler: dismiss the card (no execution). */
export async function handleCmdCancel(
  ctx: BotCtx,
  cb: CallbackQuery,
  conv: ConvKey,
  answer: (t?: string) => void,
  messageId?: number,
): Promise<void> {
  const lang: Lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  answer(tr(lang, "Đã huỷ.", "Cancelled."));
  if (messageId !== undefined) await ctx.tg.editMessageReplyMarkup(conv, messageId, {}).catch(() => {});
}
