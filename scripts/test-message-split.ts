/**
 * Unit tests for the >4096-char chunking in Telegram.sendMessage
 * (src/telegram.ts: splitTelegramChunks + the send path).
 *
 * Telegram rejects sendMessage text over 4096 chars, and each message is
 * parsed as HTML independently, so a chunk with an unbalanced tag is a 400.
 * The chunker must keep every chunk ≤ limit AND well-formed.
 *
 * Run:  npx tsx scripts/test-message-split.ts
 */
import { Telegram, splitTelegramChunks } from "../src/telegram.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const okResponse = (result: unknown): Response =>
  new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Well-formed iff every opened tag is closed (in order) within the string. */
function tagBalanced(s: string): boolean {
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].startsWith("</")) {
      const i = stack.lastIndexOf(m[1].toLowerCase());
      if (i === -1) return false;
      stack.length = i;
    } else if (!m[0].endsWith("/>")) {
      stack.push(m[1].toLowerCase());
    }
  }
  return stack.length === 0;
}

/** Original text with every tag stripped (content order preserved). */
function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

async function main(): Promise<void> {
  // ── splitTelegramChunks — pure ────────────────────────────────────────────
  {
    const t = "short message";
    check("short: single chunk, identical", JSON.stringify(splitTelegramChunks(t)) === JSON.stringify([t]));
    check("exactly limit: single chunk", splitTelegramChunks("x".repeat(4000)).length === 1);
  }

  {
    // ~6,300 chars of newline-separated prose
    const paras = Array.from({ length: 210 }, (_, i) => `para ${i} — ` + "lorem ipsum dolor sit amet ".repeat(3).trim());
    const t = paras.join("\n");
    const chunks = splitTelegramChunks(t);
    check("prose: multiple chunks", chunks.length >= 2, `n=${chunks.length}`);
    check("prose: every chunk ≤ 4000", chunks.every((c) => c.length <= 4000), chunks.map((c) => c.length).join(","));
    check("prose: every chunk balanced", chunks.every(tagBalanced));
    check("prose: content preserved (join === original)", chunks.join("") === t);
  }

  {
    // 9,000 chars, no newlines at all
    const t = "w".repeat(9000);
    const chunks = splitTelegramChunks(t);
    check("long line: multiple chunks", chunks.length >= 3, `n=${chunks.length}`);
    check("long line: every chunk ≤ 4000", chunks.every((c) => c.length <= 4000), chunks.map((c) => c.length).join(","));
    check("long line: content preserved", chunks.join("") === t);
  }

  {
    // ~5,400-char <pre> block with newlines (the cut point is INSIDE <pre>)
    const code = Array.from({ length: 320 }, (_, i) => `line ${i}: const x = ${i};`).join("\n");
    const t = `<pre>${code}</pre>`;
    const chunks = splitTelegramChunks(t);
    check("pre block: multiple chunks", chunks.length >= 2, `n=${chunks.length}`);
    check("pre block: every chunk balanced", chunks.every(tagBalanced), chunks.map((c) => `${tagBalanced(c)}:${c.slice(0, 40)}`).join(" | "));
    check("pre block: every chunk ≤ 4096 (Telegram hard limit)", chunks.every((c) => c.length <= 4096), chunks.map((c) => c.length).join(","));
    check("pre block: first chunk opens <pre>", chunks[0].startsWith("<pre>"));
    check("pre block: last chunk closes </pre>", chunks[chunks.length - 1].endsWith("</pre>"));
    check("pre block: all code preserved in order", stripTags(chunks.join("")).includes(code));
  }

  {
    // 9,000-char single-line <code> — no newlines, forced cut inside the tag
    const t = `<code>${"abc def ".repeat(1500)}</code>`; // ~9,000
    const chunks = splitTelegramChunks(t);
    check("long code: multiple chunks", chunks.length >= 3, `n=${chunks.length}`);
    check("long code: every chunk balanced", chunks.every(tagBalanced), chunks.map((c) => `${tagBalanced(c)}:${c.length}`).join(" | "));
    check("long code: every chunk ≤ 4096", chunks.every((c) => c.length <= 4096), chunks.map((c) => c.length).join(","));
    check("long code: content preserved in order", stripTags(chunks.join("")) === stripTags(t));
  }

  {
    // nested <b><i> around a boundary, with newlines
    const t = `<b>start ${"x ".repeat(1900)}</b>\n<i>mid ${"y ".repeat(1900)}</i>\n<b>end ${"z ".repeat(1900)}</b>`;
    const chunks = splitTelegramChunks(t);
    check("nested: multiple chunks", chunks.length >= 2, `n=${chunks.length}`);
    check("nested: every chunk balanced", chunks.every(tagBalanced), chunks.map((c) => c.slice(0, 60)).join(" | "));
    check("nested: content preserved", chunks.join("") === t);
  }

  {
    // stub guard: 90 chars of prose, then one giant <pre> to 9,000
    const t = "intro line\n" + "<pre>" + "q".repeat(9000) + "</pre>";
    const chunks = splitTelegramChunks(t);
    check("stub: no chunk under 100 chars except possibly the last", chunks.slice(0, -1).every((c) => c.length >= 100), chunks.map((c) => c.length).join(","));
    check("stub: every chunk balanced", chunks.every(tagBalanced));
    check("stub: every chunk ≤ 4096", chunks.every((c) => c.length <= 4096), chunks.map((c) => c.length).join(","));
  }

  // ── Telegram.sendMessage — the send path ─────────────────────────────────
  const tg = new Telegram("123:test");
  const realFetch = globalThis.fetch;
  const KB = { inline_keyboard: [[{ text: "yes", callback_data: "y:1" }]] };
  try {
    {
      const longText = Array.from({ length: 120 }, (_, i) => `line ${i}: ${"payload ".repeat(10)}`).join("\n");
      const bodies: any[] = [];
      globalThis.fetch = (async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return okResponse({ message_id: bodies.length });
      }) as any;
      await tg.sendMessage(111, longText, { reply_markup: KB, reply_to_message_id: 7 });
      check("send: split into multiple calls", bodies.length >= 2, `n=${bodies.length}`);
      check("send: every call ≤ 4000 chars", bodies.every((b) => b.text.length <= 4000), bodies.map((b) => b.text.length).join(","));
      check("send: every call parse_mode HTML", bodies.every((b) => b.parse_mode === "HTML"));
      check("send: reply-to on every call", bodies.every((b) => b.reply_to_message_id === 7));
      check("send: keyboard ONLY on the last call", bodies.filter((b) => b.reply_markup).length === 1 && bodies[bodies.length - 1].reply_markup !== undefined);
      check("send: content preserved across calls", bodies.map((b) => b.text).join("") === longText);
    }
    {
      const short = "hello";
      const bodies: any[] = [];
      globalThis.fetch = (async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return okResponse({ message_id: 1 });
      }) as any;
      await tg.sendMessage(111, short, { reply_markup: KB });
      check("send short: exactly one call", bodies.length === 1);
      check("send short: body unchanged in shape", bodies[0].text === "hello" && bodies[0].parse_mode === "HTML" && bodies[0].disable_web_page_preview === true && JSON.stringify(bodies[0].reply_markup) === JSON.stringify(KB) && bodies[0].chat_id === 111);
    }
    {
      // forum conv: thread routing must ride every chunk
      const longText = "t ".repeat(9000);
      const bodies: any[] = [];
      globalThis.fetch = (async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return okResponse({ message_id: bodies.length });
      }) as any;
      await tg.sendMessage("222:42", longText);
      check("send forum: thread id on every call", bodies.length >= 2 && bodies.every((b) => b.chat_id === 222 && b.message_thread_id === 42), JSON.stringify(bodies.map((b) => [b.chat_id, b.message_thread_id])));
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main();
