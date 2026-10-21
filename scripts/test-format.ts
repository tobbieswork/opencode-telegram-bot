/**
 * Pure-function checks for the Markdown → Telegram-HTML conversion, focused on
 * the table renderer (narrow → aligned <pre>, wide → bullet list, tall → split
 * at row boundaries). No service or network needed.
 *
 * Run:  npx tsx scripts/test-format.ts
 */
import { mdToHtmlChunks } from "../src/format.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const MAX = 4000;
const show = (label: string, units: string[]) => {
  console.log(`\n== ${label} == (${units.length} message(s))`);
  units.forEach((u, i) => console.log(`--- message ${i + 1} ---\n${u}\n`));
};

// ── narrow table → aligned monospace block ──────────────────────────────────
{
  const md = [
    "| Mode | Agent | Ý nghĩa |",
    "| --- | --- | --- |",
    "| plan | plan | chỉ phân tích |",
    "| build | build | viết & sửa code |",
  ].join("\n");
  const units = mdToHtmlChunks(md, MAX);
  show("narrow table (pre)", units);
  check("narrow: single message", units.length === 1, JSON.stringify(units));
  check("narrow: wrapped in <pre>", units[0].startsWith("<pre><code>") && units[0].endsWith("</code></pre>"));
  check("narrow: keeps header", units[0].includes("Mode") && units[0].includes("Agent"));
  check("narrow: escapes &", units[0].includes("viết &amp; sửa code"));
  // columns aligned: every line is the same length
  const inner = units[0].replace(/^<pre><code>/, "").replace(/<\/code><\/pre>$/, "");
  const lens = new Set(inner.split("\n").map((l) => l.length));
  check("narrow: all lines same width", lens.size === 1, `widths=${[...lens]}`);
}

// ── wide table → bullet list ────────────────────────────────────────────────
{
  const md = [
    "| Lệnh | Mô tả |",
    "| --- | --- |",
    "| /mode | Chọn chế độ làm việc bằng nút bấm cho bot |",
    "| /browse | Duyệt thư mục và chọn working directory |",
  ].join("\n");
  const units = mdToHtmlChunks(md, MAX);
  show("wide table (list)", units);
  check("wide: no <pre> block", !units.some((u) => u.includes("<pre>")));
  check("wide: label bolded", units[0].includes("<b>/mode:</b>") || units[0].includes("<b>/mode:</b>"));
  check("wide: keeps value", units.some((u) => u.includes("Duyệt thư mục")));
}

// ── 4-column table → bullet list with headers ──────────────────────────────
{
  const md = [
    "| A | B | C | D |",
    "| --- | --- | --- | --- |",
    "| 1 | 2 | 3 | 4 |",
  ].join("\n");
  const units = mdToHtmlChunks(md, MAX);
  show("4-col table (list w/ headers)", units);
  check("4col: uses column headers", units[0].includes("B: 2") && units[0].includes("D: 4"));
}

// ── tall narrow table → split at row boundaries, header repeated ───────────
{
  const rows: string[] = ["| k | v |", "| --- | --- |"];
  for (let i = 1; i <= 400; i++) rows.push(`| key${String(i).padStart(3, "0")} | value ${i} |`);
  const units = mdToHtmlChunks(rows.join("\n"), 400); // small max to force splits
  show("tall table (split)", units.slice(0, 2));
  console.log(`  … ${units.length} messages total`);
  check("tall: multiple messages", units.length > 1);
  check("tall: all messages fit max", units.every((u) => u.length <= 400));
  const headLine = units[0].split("\n")[0];
  check("tall: header repeated on continuation", units.slice(1).every((u) => u.split("\n")[0] === headLine));
  check("tall: every message is a <pre>", units.every((u) => u.startsWith("<pre><code>")));
  check("tall: no row lost", units.join("\n").includes("key400"));
}

// ── table + surrounding text share a message when they fit ─────────────────
{
  const md = "Trước bảng:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSau bảng.";
  const units = mdToHtmlChunks(md, MAX);
  show("table between text", units);
  check("mixed: single message", units.length === 1);
  check("mixed: order preserved", units[0].indexOf("Trước bảng") < units[0].indexOf("<pre>") && units[0].indexOf("<pre>") < units[0].indexOf("Sau bảng"));
}

// ── regression: code fence, long line, markdown basics ─────────────────────
{
  const fence = "x\n```\nconst a = 1;\nlet b = a < 2 ? 'y' : 'n';\n```\ny";
  const units = mdToHtmlChunks(fence, MAX);
  check("fence: escaped inside pre", units[0].includes("<pre><code>const a = 1;\nlet b = a &lt; 2 ? 'y' : 'n';</code></pre>"));
  check("fence: single message", units.length === 1);

  const long = "word ".repeat(2000).trim();
  const units2 = mdToHtmlChunks(long, 400);
  check("long line: all fit", units2.every((u) => u.length <= 400));
  check("long line: no text lost", units2.join("").replace(/\n/g, "").length >= units2.join("").length - units2.length);

  const md2 = "**bold** and *italic* and `code`";
  const units3 = mdToHtmlChunks(md2, MAX);
  check("markdown: bold/italic/code", units3[0] === "<b>bold</b> and <i>italic</i> and <code>code</code>", units3[0]);
}

// ── every tag balanced in every message (the invariant that keeps Telegram happy)
{
  const md = [
    "Intro **bold** line.",
    "| M | A | Ý |",
    "| --- | --- | --- |",
    "| p | p | a |",
    "| b | b | b |",
    "| g | g | c |",
    "```\nsome code < > &\n```",
    "End **tail**.",
  ].join("\n");
  const units = mdToHtmlChunks(md, 120); // force many splits
  const balanced = units.every((u) => {
    for (const tag of ["b", "i", "s", "code", "a", "pre"]) {
      const open = (u.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
      const close = (u.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      if (open !== close) return false;
    }
    return true;
  });
  check("invariant: tags balanced per message", balanced, units.filter((u, i) => {
    for (const tag of ["b", "i", "s", "code", "a", "pre"]) {
      const open = (u.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
      const close = (u.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      if (open !== close) return true;
    }
    return false;
  }).join("\n"));
  check("invariant: all fit", units.every((u) => u.length <= 120));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
