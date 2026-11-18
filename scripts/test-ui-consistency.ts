/**
 * UI consistency guard (T6 of docs/sdd/message-layer.md, M4.4).
 *
 * After the T5 migration, every ❌/✅ the bot sends should come from
 * src/ui/ (UI_ICON + the message-line helpers). This check fails if a new
 * ❌ or ✅ literal appears anywhere else under src/, so the rule cannot
 * drift back.
 *
 * Rules
 *   R1. Scope: every .ts file under src/, except src/ui/ itself.
 *   R2. Whole-line comments are exempt — they are never sent to Telegram.
 *       A ❌/✅ in a trailing comment on a code line must still be listed.
 *   R3. File exceptions: files that are an allowed home for ❌/✅ (the
 *       STRINGS table in src/i18n.ts, per M3.2).
 *   R4. Line exceptions: the reviewed set of occurrences that are
 *       deliberately outside src/ui/ (button labels, mid-line marks,
 *       conditional icon arguments, icon tables). Each entry is a
 *       distinctive substring of the source line; a line is allowed only
 *       if EVERY icon on it sits inside a listed substring.
 *
 * Maintaining the list
 *   - A new ❌/✅ outside src/ui/ must use the src/ui helpers. If that is
 *     truly not possible, add a reviewed entry below and note it in the
 *     T6 checkpoint.
 *   - An entry whose substring no longer appears in its file (or no longer
 *     contains an icon) fails the check — update or remove it in the same
 *     commit that changes the code.
 *
 * Run:  npx tsx scripts/test-ui-consistency.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const ICON_RE = /❌|✅/;

// ── R3: file exceptions ─────────────────────────────────────────────────────
const FILE_EXCEPTIONS: Record<string, string> = {
  "src/i18n.ts":
    "STRINGS table — fixed words (lang_set_*, style_*, error_prefix) live here by design (M3.2)",
};

// ── R4: line exceptions — the reviewed list (T6 checkpoint) ─────────────────
interface Exc {
  file: string;
  text: string;
  why: string;
}

const EXCEPTIONS: Exc[] = [
  // src/health.ts — icon table
  {
    file: "src/health.ts",
    text: '{ ok: "✅", warn: "⚠️", fail: "❌", off: "⚪" }',
    why: "icon table (HealthStatus → icon, same role as ICON in format.ts)",
  },

  // src/spec-checkpoint.ts — checkpoint card
  {
    file: "src/spec-checkpoint.ts",
    text: 'accept: tr(lang, "✅ Chấp nhận", "✅ Accept")',
    why: "button label (card: accept)",
  },
  {
    file: "src/spec-checkpoint.ts",
    text: "<b>${esc(c.name)}</b> ✅",
    why: "trailing mark on a card line (task ok)",
  },
  {
    file: "src/spec-checkpoint.ts",
    text: "<b>${esc(c.name)}</b> ❌ (chưa chạy)",
    why: "trailing mark on a card line (task not run)",
  },
  {
    file: "src/spec-checkpoint.ts",
    text: "else lines.push(`• <b>${esc(c.name)}</b> ❌`)",
    why: "trailing mark on a card line (task blocked)",
  },

  // src/rotation-health.ts — rotation verdict
  {
    file: "src/rotation-health.ts",
    text: 'r.outcome === "success" ? "✅" : "❌"',
    why: "conditional icon (rotation outcome → ✅/❌)",
  },
  {
    file: "src/rotation-health.ts",
    text: '"✅ bounded — nền &lt;100K, ổn định", "✅ bounded — floor &lt;100K, stable"',
    why: "verdict line (bounded) — label-prefixed, not a bare okLine",
  },
  {
    file: "src/rotation-health.ts",
    text: '"❌ vượt ngưỡng — nền &gt;120K hoặc lần xoay cuối thất bại", "❌ over threshold — floor &gt;120K or last rotation failed"',
    why: "verdict line (over threshold) — label-prefixed, not a bare errorLine",
  },

  // src/commands/spec.ts — task list + ready button
  {
    file: "src/commands/spec.ts",
    text: 'status === "done" ? "✅" : status === "next" ? "▶️" : status === "blocked" ? "⛔" : "○"',
    why: "icon selector (task status → icon), 2 sites",
  },
  {
    file: "src/commands/spec.ts",
    text: 'tr(lang, "✅ Sẵn sàng review", "✅ Mark ready for review")',
    why: "button label (Mark ready for review), 2 sites",
  },

  // src/watch.ts — watch result header + close button
  {
    file: "src/watch.ts",
    text: 'header("✅", tr(lang, "Hoàn tất", "Done"), durMs)',
    why: "icon argument to header() (phase done)",
  },
  {
    file: "src/watch.ts",
    text: 'header("❌", tr(lang, "Thất bại", "Failed"), durMs)',
    why: "icon argument to header() (phase failed)",
  },
  {
    file: "src/watch.ts",
    text: 'tr(lang, "❌ Đóng", "Close"), callback_data: `w:${id}:c`',
    why: "button label (watch close)",
  },

  // src/bot.ts — reboot card, pickers, file browser, permission card
  {
    file: "src/bot.ts",
    text: 'tr(lang, "✅ Xác nhận reboot", "✅ Confirm reboot")',
    why: "button label (confirm reboot)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Huỷ", "❌ Cancel"), data: rebootCallback.encode({ op: "cancel" })',
    why: "button label (cancel reboot)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Đóng", "❌ Close"), callback_data: useCb.encode("close")',
    why: "button label (use picker close)",
  },
  {
    file: "src/bot.ts",
    text: '{ text: tr(b.lang, "❌ Đóng", "❌ Close"), callback_data: bsCallback.encode({ op: "close" }) }',
    why: "button label (file-browser close)"
  },
  {
    file: "src/bot.ts",
    text: 'rows.push([{ text: tr(b.lang, "❌ Đóng", "❌ Close"), callback_data: bsCallback.encode({ op: "close" }) }]);',
    why: "button label (file-browser close), 2 sites",
  },
  {
    file: "src/bot.ts",
    text: 'tr(b.lang, "✅ Mở tại đây", "✅ Open here")',
    why: "button label (file-browser open here)",
  },
  {
    file: "src/bot.ts",
    text: '"Chạm một thư mục để vào · ✅ để mở OpenCode tại đây", "Tap a folder to enter · ✅ to open OpenCode here"',
    why: "mid-line ✅ mention (file-browser hint)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Đóng", "❌ Close"), callback_data: modelCb.encode({ op: "close" })',
    why: "button label (model picker close)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Đóng", "❌ Close"), callback_data: modeCb.encode("close")',
    why: "button label (mode picker close)",
  },
  {
    file: "src/bot.ts",
    text: "`❌ Unknown variant <code>${esc(want)}</code>`",
    why: "❌ message passed inline as a call argument",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Đóng", "❌ Close"), callback_data: variantCb.encode("close")',
    why: "button label (variant picker close)",
  },
  {
    file: "src/bot.ts",
    text: "`✅ Variant → <code>${esc(id)}</code> (${how})`",
    why: "✅ message passed inline (variant set)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Huỷ", "❌ Cancel"), callback_data: formCb.encode({ formID: fd, op: "x" })',
    why: "button label (form-question cancel), 2 sites",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "✅ Duyệt 1 lần", "✅ Allow once")',
    why: "button label (allow once)",
  },
  {
    file: "src/bot.ts",
    text: 'tr(lang, "❌ Từ chối", "❌ Deny")',
    why: "button label (deny)",
  },

  // src/orchestrator.ts — kill picker, auto-off note, topic rename, assign card
  {
    file: "src/orchestrator.ts",
    text: 'tr(lang, "❌ Đóng", "❌ Close"), callback_data: killCb.encode("close")',
    why: "button label (kill picker close)",
  },
  {
    file: "src/orchestrator.ts",
    text: '"🛂 Auto: <b>off</b> — Manager phải chờ bạn bấm ✅ trước khi tạo worker hoặc giao việc.", "🛂 Auto: <b>off</b> — the Manager waits for your ✅ tap before spawning workers or assigning tasks."',
    why: "mid-line ✅ mention (auto-off note)",
  },
  {
    file: "src/orchestrator.ts",
    text: "editForumTopic(conv, `❌ ${name}`)",
    why: "topic renamed with a ❌ prefix (delete failed)",
  },
  {
    file: "src/orchestrator.ts",
    text: '{ text: "✅ Giao", callback_data: apCb.encode({ id, op: "ok" }) }',
    why: "button label (assign: ok)",
  },
  {
    file: "src/orchestrator.ts",
    text: '{ text: "❌ Huỷ", callback_data: apCb.encode({ id, op: "no" }) }',
    why: "button label (assign: cancel)",
  },

  // src/callbacks.ts — registry error toast (added post-T6 by the callback-registry spec)
  {
    file: "src/callbacks.ts",
    text: 'vi: "❌ Lỗi: nút không phản hồi"',
    why: "error toast constant (C2.4: handler threw — button failed)",
  },
  {
    file: "src/callbacks.ts",
    text: 'en: "❌ Error: the button failed"',
    why: "error toast constant (C2.4: handler threw — button failed)",
  },

  // src/commands/spec.ts — /spec group header + manager-tool error (added post-T6)
  {
    file: "src/commands/spec.ts",
    text: "✅ Đã xong (${finished.length})",
    why: "section header (✅ Đã xong group, /spec 2-group display)",
  },
  {
    file: "src/commands/spec.ts",
    text: 'tr(lang, "❌ Không rõ task nào.", "❌ Unknown task.")',
    why: "inline ❌ error (manager spec tool: unparseable run ref)",
  },
];

// ── scanner ─────────────────────────────────────────────────────────────────

/** R2 — a whole-line comment is never sent to Telegram. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

/**
 * R4 matching: a line is allowed iff, after removing every exception
 * substring for its file, no ❌/✅ remains on the line. Returns the
 * offending remainder, or null when the line is fully covered.
 */
function uncovered(line: string, file: string): string | null {
  let rem = line;
  for (const e of EXCEPTIONS) if (e.file === file) rem = rem.replaceAll(e.text, "");
  return ICON_RE.test(rem) ? rem : null;
}

/** R1 — every .ts file under src/, except src/ui/. */
function listTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = abs.slice(root.length + 1);
      if (e.isDirectory()) {
        if (rel === "src/ui") continue;
        walk(abs);
      } else if (e.name.endsWith(".ts")) out.push(abs);
    }
  };
  walk(join(root, "src"));
  return out;
}

const files = listTsFiles();
check("scope: found src/**/*.ts files (src/ui/ excluded)", files.length > 10, `found ${files.length}`);
check("scope: no src/ui/ file in the scan set", files.every((p) => !p.startsWith(join(root, "src", "ui"))));
const contents = new Map<string, string>();
for (const abs of files) contents.set(abs.slice(root.length + 1), readFileSync(abs, "utf8"));

// ── self-tests: the detector itself ─────────────────────────────────────────
{
  check("self-test: an unlisted ❌ line is flagged", uncovered('send(`❌ brand new`)', "src/none.ts") !== null);
  check("self-test: an unlisted ✅ line is flagged", uncovered('send(`✅ brand new`)', "src/none.ts") !== null);
  check(
    "self-test: a whole-line comment is exempt",
    isCommentLine("  // ❌ noted, never sent") && isCommentLine(" * ✅ doc comment"),
  );
  check(
    "self-test: a code line with a trailing comment is NOT exempt",
    !isCommentLine('const a = "x"; // ❌ note'),
  );
  const healthLine = (contents.get("src/health.ts") ?? "")
    .split("\n")
    .find((l) => l.includes("const ICON"));
  check(
    "self-test: the health ICON line is covered by its exception",
    healthLine !== undefined && uncovered(healthLine, "src/health.ts") === null,
  );
}

// ── entry sanity ────────────────────────────────────────────────────────────
{
  const noIcon = EXCEPTIONS.filter((e) => !ICON_RE.test(e.text));
  check("entries: every entry contains a ❌/✅", noIcon.length === 0, noIcon.map((e) => e.text).join(" | "));
  const missing = EXCEPTIONS.filter((e) => !(contents.get(e.file) ?? "").includes(e.text));
  check(
    "entries: every entry still appears in its file (stale → update/remove)",
    missing.length === 0,
    missing.map((e) => `${e.file}: "${e.text}"`).join(" | "),
  );
  const badFiles = Object.keys(FILE_EXCEPTIONS).filter((f) => !contents.has(f));
  check("file exceptions: point at scanned files", badFiles.length === 0, badFiles.join(", "));
}

// ── the scan (R1 + R2 + R3 + R4) ────────────────────────────────────────────
interface Violation {
  file: string;
  line: number;
  remainder: string;
}
const violations: Violation[] = [];
let iconLines = 0;
let fileExcLines = 0;
let commentLines = 0;
let listedLines = 0;
const entryLines = new Map<number, number[]>();

for (const [rel, src] of contents) {
  const inFileExc = rel in FILE_EXCEPTIONS;
  src.split("\n").forEach((line, i) => {
    if (!ICON_RE.test(line)) return;
    iconLines++;
    if (inFileExc) {
      fileExcLines++;
      return;
    }
    if (isCommentLine(line)) {
      commentLines++;
      return;
    }
    if (uncovered(line, rel) !== null) violations.push({ file: rel, line: i + 1, remainder: line.trim() });
    else {
      listedLines++;
      EXCEPTIONS.forEach((e, idx) => {
        if (e.file === rel && line.includes(e.text)) {
          entryLines.set(idx, [...(entryLines.get(idx) ?? []), i + 1]);
        }
      });
    }
  });
}

check(
  "no unlisted ❌/✅ outside src/ui/ (M4.4)",
  violations.length === 0,
  violations.map((v) => `${v.file}:${v.line}  →  ${v.remainder}`).join("\n      "),
);
check("scan is not vacuous (saw the known icon lines)", iconLines >= 60, `saw ${iconLines} icon lines`);

// ── exception list report (for the T6 checkpoint review) ────────────────────
{
  console.log(`\nexception list — ${EXCEPTIONS.length} line entries + ${Object.keys(FILE_EXCEPTIONS).length} file:`);
  for (const [file, why] of Object.entries(FILE_EXCEPTIONS)) {
    const n = (contents.get(file) ?? "").split("\n").filter((l) => ICON_RE.test(l)).length;
    console.log(`  [file] ${file} (${n} icon lines) — ${why}`);
  }
  EXCEPTIONS.forEach((e, idx) => {
    const lines = entryLines.get(idx) ?? [];
    console.log(`  ${e.file}:${lines.join(",")} — ${e.why}`);
  });
  console.log(
    `\nicon lines: ${iconLines} total | file-except ${fileExcLines} | comments ${commentLines} | listed ${listedLines} | unlisted ${violations.length}`,
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
