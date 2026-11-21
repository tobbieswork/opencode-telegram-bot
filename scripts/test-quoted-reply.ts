/**
 * foldQuotedReply (src/bot.ts) checks: a Telegram reply-quote is folded into
 * the Manager prompt as a marked, length-capped block; nothing readable =
 * no-op (the user's text goes through unchanged).
 *
 * Run:  npx tsx scripts/test-quoted-reply.ts
 */
import { foldQuotedReply, QUOTED_REPLY_MAX } from "../src/bot.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── no quote ─────────────────────────────────────────────────────────────
check("undefined quote → text unchanged", foldQuotedReply("hello", undefined) === "hello");
check("empty reply_to_message → text unchanged", foldQuotedReply("hello", {}) === "hello");
check("whitespace-only quote → text unchanged", foldQuotedReply("hello", { text: "   " }) === "hello");
check("sticker quote (no text/caption) → text unchanged", foldQuotedReply("hello", { from: { first_name: "X" } }) === "hello");

// ── basic folding ────────────────────────────────────────────────────────
{
  const out = foldQuotedReply("fix this", { text: "Error: ENOENT", from: { first_name: "Tobbies" } });
  check("marker present", out.startsWith("[You are replying to a quoted message from Tobbies:"));
  check("quoted body inside marker", out.includes("\u201cError: ENOENT\u201d"), out);
  check("user text after the block", out.endsWith("\n\nfix this"), out);
}
{
  const out = foldQuotedReply("ok", { text: "body" });
  check("no sender name → no 'from'", out.startsWith("[You are replying to a quoted message:") && !out.includes("from"), out);
}
{
  const out = foldQuotedReply("cap", { caption: "media caption" });
  check("caption used when no text", out.includes("\u201cmedia caption\u201d"), out);
}
{
  const out = foldQuotedReply("both", { text: "text wins", caption: "caption" });
  check("text preferred over caption", out.includes("text wins") && !out.includes("caption"), out);
}
{
  const out = foldQuotedReply("multi\nline", { text: "a\nb" });
  check("multi-line quote kept verbatim", out.includes("\u201ca\nb\u201d"), out);
}

// ── cap ──────────────────────────────────────────────────────────────────
{
  const long = "x".repeat(QUOTED_REPLY_MAX + 500);
  const out = foldQuotedReply("t", { text: long });
  check("long quote clipped at cap", out.includes("x".repeat(QUOTED_REPLY_MAX) + "\u2026"), `len=${out.length}`);
  check("no over-cap body survives", !out.includes("x".repeat(QUOTED_REPLY_MAX + 1)));
  check("clipped output stays bounded", out.length <= QUOTED_REPLY_MAX + 80, `len=${out.length}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("All quoted-reply checks passed.");
