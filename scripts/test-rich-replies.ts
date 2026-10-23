/**
 * Unit tests for the pure parts of the Rich Messages Phase 1 change:
 *   1. Markdown chunking for rich replies (richMarkdownChunks @ 30 000):
 *      short text = 1 chunk, 30k+ splits on newline boundaries, no empty chunks.
 *   2. The OPENCODE_TG_RICH flag parsed by loadConfig: unset → false,
 *      "1" → true, "0" → false (default must be OFF).
 *
 * I/O paths (the actual sendRichMessage / HTML fallback calls) are NOT
 * unit-tested, per repo convention (pure logic only).
 *
 * Run:  npx tsx scripts/test-rich-replies.ts
 */
import { loadConfig } from "../src/config.js";
import { RICH_CHUNK_LIMIT, richMarkdownChunks } from "../src/rich.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── chunking ─────────────────────────────────────────────────────────────────
// A short reply (≤ 30 000) must come back as exactly one chunk, unchanged.
const short = "hello, this is a **short** reply with `code` and a [link](https://x)";
const shortChunks = richMarkdownChunks(short);
check("short text → 1 chunk", shortChunks.length === 1, String(shortChunks.length));
check("short text chunk unchanged", shortChunks[0] === short);

// A deterministic small multi-split at a small max, to prove the newline
// boundary + no-empty-chunk behavior independent of the 30 000 default.
const small = richMarkdownChunks("aaaa\nbbbb\ncccc\ndddd", 5);
check("small max → splits on newline boundaries", small.join("") === "aaaa\nbbbb\ncccc\ndddd", JSON.stringify(small));
check("small max → no empty chunks", small.every((c) => c.length > 0), JSON.stringify(small));
check("small max → every chunk ≤ max", small.every((c) => c.length <= 5), JSON.stringify(small));

// A >30 000-char reply: 400 x 100-char lines joined by newlines (40 399 chars).
const line = "0123456789".repeat(10);
const longText = Array.from({ length: 400 }, () => line).join("\n");
check("precondition: long text > RICH_CHUNK_LIMIT", longText.length > RICH_CHUNK_LIMIT, String(longText.length));
const longChunks = richMarkdownChunks(longText);
check("30k+ → more than one chunk", longChunks.length >= 2, String(longChunks.length));
check("30k+ → every chunk ≤ RICH_CHUNK_LIMIT", longChunks.every((c) => c.length <= RICH_CHUNK_LIMIT));
check("30k+ → no empty chunks", longChunks.every((c) => c.length > 0));
// Reassembling the chunks must reproduce the input exactly (no data loss).
check("30k+ → chunks rejoin to the original", longChunks.join("") === longText);
// Non-final chunks break on a newline boundary (the trailing newline ends them).
check("30k+ → non-final chunks end on a newline", longChunks.slice(0, -1).every((c) => c.endsWith("\n")));

// ── flag parsing (default OFF) ───────────────────────────────────────────────
// loadConfig() requires a bot token + allowed users; provide dummies.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";

delete process.env.OPENCODE_TG_RICH;
check("OPENCODE_TG_RICH unset → richReplies false", loadConfig(process.cwd()).richReplies === false);
process.env.OPENCODE_TG_RICH = "1";
check('OPENCODE_TG_RICH="1" → richReplies true', loadConfig(process.cwd()).richReplies === true);
process.env.OPENCODE_TG_RICH = "true";
check('OPENCODE_TG_RICH="true" → richReplies true', loadConfig(process.cwd()).richReplies === true);
process.env.OPENCODE_TG_RICH = "0";
check('OPENCODE_TG_RICH="0" → richReplies false', loadConfig(process.cwd()).richReplies === false);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
