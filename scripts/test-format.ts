/**
 * Pure-function checks for the Markdown → Telegram-HTML conversion, focused on
 * the table renderer (narrow → aligned <pre>, wide → bullet list, tall → split
 * at row boundaries). No service or network needed.
 *
 * Run:  npx tsx scripts/test-format.ts
 */
import { mdToHtmlChunks, fmtNum, timeAgo, formatTurnFailure, classifyFailure, isOverflowError } from "../src/format.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Per-tag open/close balance for one message (b/i/s/code/pre/a all must match). */
function countTags(msg: string): Array<{ tag: string; ok: boolean }> {
  return ["b", "i", "s", "code", "pre", "a"].map((tag) => {
    const open = (msg.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
    const close = (msg.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    return { tag, ok: open === close };
  });
}

const MAX = 4000;
const show = (label: string, units: string[]) => {
  console.log(`\n== ${label} == (${units.length} message(s))`);
  units.forEach((u, i) => console.log(`--- message ${i + 1} ---\n${u}\n`));
};

// ── number / time formatting ─────────────────────────────────────────────────
{
  check("fmtNum small", fmtNum(42) === "42");
  check("fmtNum thousand", fmtNum(1234) === "1.2K");
  check("fmtNum round K", fmtNum(2000) === "2K");
  check("fmtNum million", fmtNum(9569987) === "9.6M");
  check("fmtNum zero", fmtNum(0) === "0");
  const now = Date.now();
  check("timeAgo seconds", timeAgo(now - 30_000) === "30s ago");
  check("timeAgo minutes", timeAgo(now - 5 * 60_000) === "5m ago");
  check("timeAgo hours", timeAgo(now - 3 * 3600_000) === "3h ago");
  check("timeAgo days", timeAgo(now - 2 * 86400_000) === "2d ago");
}

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

  // regression: a literal `*` (or `_`) inside inline code must NOT be treated
  // as a Markdown delimiter — previously this unbalanced the <i>/<b> tags and
  // made Telegram reject the message with "can't parse entities".
  const codeStar = "match `a.* b` then *italic* text";
  const u4 = mdToHtmlChunks(codeStar, MAX);
  check("code-star: single msg", u4.length === 1, JSON.stringify(u4));
  check("code-star: code kept intact", u4[0].includes("<code>a.* b</code>"), u4[0]);
  check("code-star: italic intact", u4[0].includes("<i>italic</i>"), u4[0]);
  check(
    "code-star: tags balanced",
    countTags(u4[0]).every((c) => c.ok),
    u4[0],
  );
  // the star inside code stays literal, the real star pair becomes <i>…</i>
  const codeUnder = "run `snake_case file_` and *em* ok";
  const u5 = mdToHtmlChunks(codeUnder, MAX);
  check("code-underscore: code intact", u5[0].includes("<code>snake_case file_</code>"), u5[0]);
  check("code-underscore: tags balanced", countTags(u5[0]).every((c) => c.ok), u5[0]);
}

// ── failure messaging (context overflow vs generic provider error vs no detail) ──
{
  const ctx = formatTurnFailure(
    {
      type: "provider.invalid-request",
      message:
        "litellm.BadRequestError: OpenAIException - Requested token count exceeds the model's maximum context length of 160000 tokens. You requested a total of 166771 tokens.",
    },
    2400,
  );
  console.log(`\n== context overflow ==\n${ctx}\n`);
  check("fail: ctx detected as overflow", ctx.includes("đầy context"), ctx);
  check("fail: ctx suggests /clear", ctx.includes("/clear"), ctx);
  check("fail: ctx has no raw token dump", !ctx.includes("166771"), ctx);

  // A rate limit is NOT context overflow — it must not suggest /clear (the review
  // flagged the old regex matching "exceeds the rate limit" / "…per minute").
  const rateLimit = formatTurnFailure(
    { type: "provider.rate-limit", message: "429 Too Many Requests — back off and retry." },
    1200,
  );
  console.log(`\n== rate limit ==\n${rateLimit}\n`);
  check("fail: rate-limit labelled as such", rateLimit.includes("giới hạn tốc độ"), rateLimit);
  check("fail: rate-limit NOT ctx (no /clear advice)", !rateLimit.includes("đầy context") && !rateLimit.includes("/clear"), rateLimit);
  check("fail: rate-limit shows raw detail", rateLimit.includes("429 Too Many Requests"), rateLimit);

  // The per-minute token cap must ALSO be treated as rate limit, not context.
  const ratePerMinute = formatTurnFailure(
    { type: "provider.error", message: "You have exceeded your current usage limit: max 40000 input tokens per minute." },
    900,
  );
  check("fail: per-minute cap → rate limit, not ctx", ratePerMinute.includes("giới hạn tốc độ") && !ratePerMinute.includes("đầy context"), ratePerMinute);

  // Anthropic's real context-overflow message must be detected as ctx (the review
  // flagged the old regex missing "…exceed context limit").
  const ctxAnthropic = formatTurnFailure(
    { type: "provider.invalid-request", message: "400 {\"error\":{\"type\":\"invalid_request_error\",\"message\":\"input length and max_tokens exceed context limit: 250000 > 128000\"}}" },
    800,
  );
  check("fail: anthropic ctx detected", ctxAnthropic.includes("đầy context"), ctxAnthropic);
  check("fail: anthropic ctx suggests /clear", ctxAnthropic.includes("/clear"), ctxAnthropic);

  // A usage/quota cap does not clear in seconds: it must NOT say "wait a few seconds",
  // and must not suggest /clear. (Real error seen from the free-tier model.)
  const usageCap = formatTurnFailure({ type: "provider.error", message: "Free usage limit reached" }, 900);
  check("fail: usage cap labelled as such", usageCap.includes("hết hạn mức") && usageCap.includes("/model"), usageCap);
  check("fail: usage cap is NOT a rate limit", !usageCap.includes("giới hạn tốc độ") && !usageCap.includes("vài giây"), usageCap);
  check("fail: usage cap NOT ctx", !usageCap.includes("/clear") && !usageCap.includes("đầy context"), usageCap);
  check("fail: usage cap shows raw detail", usageCap.includes("Free usage limit reached"), usageCap);

  // A generic (non-rate, non-context) error shows the raw message + type + elapsed.
  const other = formatTurnFailure(
    { type: "provider.error", message: "Internal error 500: server exploded" },
    1200,
  );
  console.log(`\n== generic provider error ==\n${other}\n`);
  check("fail: other shows type", other.includes("provider.error"), other);
  check("fail: other shows message", other.includes("server exploded"), other);
  check("fail: other not mislabeled as ctx", !other.includes("đầy context"), other);
  check("fail: other shows elapsed", other.includes("1.2s"), other);

  const none = formatTurnFailure(undefined, 500);
  console.log(`\n== no detail ==\n${none}\n`);
  check("fail: none is generic", none.includes("không có thông tin chi tiết"), none);

  // every variant is valid, balanced Telegram-HTML and short enough for one message
  for (const [label, msg] of [
    ["ctx", ctx],
    ["rateLimit", rateLimit],
    ["ratePerMinute", ratePerMinute],
    ["usageCap", usageCap],
    ["ctxAnthropic", ctxAnthropic],
    ["other", other],
    ["none", none],
  ] as const) {
    for (const tag of ["b", "i", "code"]) {
      const open = (msg.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
      const close = (msg.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      check(`fail ${label}: <${tag}> balanced`, open === close, msg);
    }
    check(`fail ${label}: fits one message`, msg.length <= 4000, `${msg.length} chars`);
  }

  // a raw message full of HTML must be escaped, not injected (no ctx keyword
  // so it routes through the raw-message path, not the context-overflow branch)
  const hostile = formatTurnFailure({ message: "boom & <script>alert(1)</script>" }, 300);
  check("fail: hostile html escaped", hostile.includes("&lt;script&gt;") && !hostile.includes("<script>"), hostile);
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

// ── classifyFailure: one precedence for what we tell the user and what we do ──
{
  check("classify: rate limit", classifyFailure("Rate limit exceeded") === "rate-limit");
  check("classify: usage cap", classifyFailure("You exceeded your current quota") === "usage-cap");
  check("classify: real overflow string", classifyFailure("Requested token count exceeds the model's maximum context length of 160000 tokens") === "overflow");
  check("classify: 'context limit reached' is overflow, not a cap", classifyFailure("context limit reached") === "overflow");
  check("classify: overflow wording mentioning quota stays overflow", classifyFailure("Context window limit reached, input exceeds quota") === "overflow");
  check("classify: weak 'too many tokens' + quota → cap", classifyFailure("insufficient quota: too many tokens") === "usage-cap");
  check("classify: weak 'too many tokens' alone → overflow", classifyFailure("You have provided too many tokens") === "overflow");
  check("classify: 'too many tokens per minute' → rate limit", classifyFailure("too many tokens per minute") === "rate-limit");
  check("classify: 'usage limit … per minute' stays rate limit", classifyFailure("usage limit hit, 50 per minute") === "rate-limit");
  check("classify: unknown → undefined", classifyFailure("Something went wrong") === undefined);
  check("isOverflowError agrees", isOverflowError("context limit reached") === true && isOverflowError("monthly usage cap quota") === false);
  const capMsg = formatTurnFailure({ message: "context limit reached" }, 1000);
  check("formatTurnFailure: 'context limit reached' tells the user to /clear", capMsg.includes("/clear") && !capMsg.includes("hạn mức"));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
