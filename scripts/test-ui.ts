/**
 * Checks for the shared message foundation (T2 of docs/sdd/message-layer.md):
 * the icon tables (src/ui/icons.ts) and the message-line helpers
 * (src/ui/text.ts). Pure functions only — no service or network needed.
 *
 * Covers:
 *   - ICON: the worker status table is byte-identical to what format.ts used
 *     to define (regression guard for the move), and format.ts still
 *     re-exports it (call sites keep working, M1.1).
 *   - UI_ICON: the shared icon table (M1.1).
 *   - okLine / errorLine / warnLine / statusLine / titledList: prefixes,
 *     escaping of plain text, raw() pass-through (M1.3), the optional hint
 *     (M3.3), truncation at the message/caption limits (M1.4).
 *   - Purity: same input twice → same output, lang is a real parameter
 *     (M3.1).
 *
 * Run:  npx tsx scripts/test-ui.ts
 */
import { ICON as ICON_FROM_FORMAT } from "../src/format.js";
import { ICON, UI_ICON } from "../src/ui/icons.js";
import { CAPTION_LIMIT, errorLine, okLine, raw, statusLine, titledList, warnLine, MSG_LIMIT } from "../src/ui/text.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── icons (M1.1) ─────────────────────────────────────────────────────────────
{
  check("ICON: idle", ICON.idle === "💤");
  check("ICON: running", ICON.running === "🟢");
  check("ICON: waiting", ICON.waiting === "🟡");
  check("ICON: done", ICON.done === "✅");
  check("ICON: failed", ICON.failed === "❌");
  check("ICON: stopped", ICON.stopped === "⏹");
  check("format.ts re-exports ICON (same object)", ICON_FROM_FORMAT === ICON);
  check("UI_ICON: success", UI_ICON.success === "✅");
  check("UI_ICON: error", UI_ICON.error === "❌");
  check("UI_ICON: warning", UI_ICON.warning === "⚠️");
  check("UI_ICON: info", UI_ICON.info === "ℹ️");
  check("UI_ICON: running", UI_ICON.running === "⏳");
  check("UI_ICON: waiting", UI_ICON.waiting === "⏸");
  check("UI_ICON: stopped", UI_ICON.stopped === "⏹");
  check("UI_ICON: back", UI_ICON.back === "↩️");
  check("UI_ICON: close", UI_ICON.close === "❌");
  check("UI_ICON: confirm", UI_ICON.confirm === "✅");
  check("limits: message 4096 / caption 1024", MSG_LIMIT === 4096 && CAPTION_LIMIT === 1024);
}

// ── prefixes + escaping (M1.2, M1.3) ─────────────────────────────────────────
{
  check("okLine: prefix + plain text escaped", okLine("vi", "a<b>&c") === "✅ a&lt;b&gt;&amp;c");
  check("okLine: raw passes through", okLine("vi", raw("Model <b>x</b>")) === "✅ Model <b>x</b>");
  check("errorLine: bare prefix + escaped msg", errorLine("vi", "đường <lỗi>") === "❌ đường &lt;lỗi&gt;");
  check("errorLine: bare prefix (language-neutral)", errorLine("en", "boom") === "❌ boom");
  check("warnLine: prefix + escaped", warnLine("vi", "a<b>") === "⚠️ a&lt;b&gt;");
  check("statusLine: prefix", statusLine("en", "working") === "⏳ working");
}

// ── hint (M3.3) ──────────────────────────────────────────────────────────────
{
  check("errorLine: hint on its own italic line", errorLine("vi", "boom", "gửi /new") === "❌ boom\n<i>gửi /new</i>");
  check("errorLine: hint escaped", errorLine("vi", "boom", "a<b>") === "❌ boom\n<i>a&lt;b&gt;</i>");
  check("errorLine: raw hint passes through", errorLine("vi", "boom", raw("<code>/new</code>")) === "❌ boom\n<i><code>/new</code></i>");
  check("warnLine: hint", warnLine("en", "slow", "wait") === "⚠️ slow\n<i>wait</i>");
  check("okLine: no hint parameter", okLine("vi", "done") === "✅ done");
}

// ── truncation (M1.4) ────────────────────────────────────────────────────────
{
  const out = okLine("vi", "x".repeat(MSG_LIMIT + 100));
  check("okLine: truncates at the message limit", out.length === MSG_LIMIT + 1 && out.endsWith("…"));
  check("okLine: short output untouched", okLine("vi", "ok") === "✅ ok");
  const cap = errorLine("en", "y".repeat(CAPTION_LIMIT + 50), undefined, CAPTION_LIMIT);
  check("errorLine: custom limit (caption)", cap.length === CAPTION_LIMIT + 1 && cap.endsWith("…"));
}

// ── titledList (M1.2) ────────────────────────────────────────────────────────
{
  check("titledList: bold title + one line per entry", titledList("vi", "Sessions (2)", ["a", "b"]) === "<b>Sessions (2)</b>\na\nb");
  check("titledList: plain title escaped", titledList("vi", "a<b>", []) === "<b>a&lt;b&gt;</b>");
  check("titledList: entries escaped", titledList("vi", "T", ["x<y>"]) === "<b>T</b>\nx&lt;y&gt;");
  check("titledList: raw title passes through", titledList("vi", raw("📋 <code>docs/sdd</code>"), []) === "<b>📋 <code>docs/sdd</code></b>");
  check("titledList: no entries → title only", titledList("vi", "T", []) === "<b>T</b>");
  const long = titledList("vi", "T", Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(100)}`));
  check("titledList: truncates at the message limit", long.length === MSG_LIMIT + 1 && long.endsWith("…"));
}

// ── purity (M3.1) ────────────────────────────────────────────────────────────
{
  check("pure: same input twice → same output", errorLine("vi", "m", "h") === errorLine("vi", "m", "h"));
  check("errorLine: bare shape is language-neutral", errorLine("en", "m") === errorLine("vi", "m"));
}

// ── T4 pilot golden bytes (agents.ts + meta.ts, byte-identical) ─────────────
{
  check("golden: okLine = legacy agent-confirm bytes (vi)", okLine("vi", raw("Agent → <code>build</code> (applied to current session)")) === "✅ Agent → <code>build</code> (applied to current session)");
  check("golden: okLine = legacy agent-confirm bytes (en, prefix language-neutral)", okLine("en", raw("Agent → <code>explore</code> (applies on /new)")) === "✅ Agent → <code>explore</code> (applies on /new)");
  check("golden: okLine = legacy callback-edit bytes", okLine("vi", raw("Agent → <code>plan</code> (applied)")) === "✅ Agent → <code>plan</code> (applied)");
  check("golden: warnLine = legacy context-read-error bytes", warnLine("vi", raw("Could not read the session: ECONNRESET")) === "⚠️ Could not read the session: ECONNRESET");
  check("golden: warnLine = legacy rotation-snapshot vi bytes", warnLine("vi", raw("Không đọc được snapshot rotation: boom")) === "⚠️ Không đọc được snapshot rotation: boom");
  check("golden: warnLine = legacy rotation-snapshot en bytes", warnLine("en", raw("Can't read the rotation snapshot: boom")) === "⚠️ Can't read the rotation snapshot: boom");
  check("golden: warnLine = legacy cannot-identify-user bytes", warnLine("vi", "Cannot identify user.") === "⚠️ Cannot identify user.");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
