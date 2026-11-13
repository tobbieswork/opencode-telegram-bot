/**
 * Unit tests for the Bot API 10.4 topic deep links:
 *  - shared.topicDeepLink: supergroups get `t.me/c/<id>/<thread>`, private
 *    chats with topics get `t.me/<bot_username>/<thread>`, anything else
 *    (or an unknown username) gets no link.
 *  - Telegram.botUsername: getMe result is cached (one API call) and a
 *    failed getMe degrades to undefined instead of throwing.
 *
 * Run:  npx tsx scripts/test-topic-link.ts
 */
import { topicDeepLink } from "../src/shared.js";
import { Telegram } from "../src/telegram.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // topicDeepLink: supergroup (the pre-10.4 behaviour, unchanged).
  check(
    "supergroup -> t.me/c link",
    topicDeepLink(-1001234567890, 42) === "https://t.me/c/1234567890/42",
    `got ${topicDeepLink(-1001234567890, 42)}`,
  );
  // topicDeepLink: private chat + known username (new in Bot API 10.4).
  check(
    "private chat + username -> t.me/<username> link",
    topicDeepLink(123456, 7, "my_bot") === "https://t.me/my_bot/7",
    `got ${topicDeepLink(123456, 7, "my_bot")}`,
  );
  // topicDeepLink: private chat, username unknown -> no link (old behaviour).
  check("private chat, no username -> undefined", topicDeepLink(123456, 7) === undefined);
  // topicDeepLink: a plain (non-super) group has no forum topics -> no link.
  check("plain group -> undefined", topicDeepLink(-1001234567, 3, "my_bot") === undefined);
  // topicDeepLink: username must be a non-empty string (empty = unknown).
  check("empty username -> undefined", topicDeepLink(123456, 7, "") === undefined);

  // Telegram.botUsername: caches the getMe result (exactly one API call).
  {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "cached_bot" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const tg = new Telegram("123:test");
    try {
      const u1 = await tg.botUsername();
      const u2 = await tg.botUsername();
      check("botUsername: returns getMe username", u1 === "cached_bot" && u2 === "cached_bot", `got ${u1}, ${u2}`);
      check("botUsername: getMe called exactly once (cached)", calls.length === 1, `calls=${calls.length}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // Telegram.botUsername: a failing getMe degrades to undefined (no throw).
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const tg = new Telegram("123:test");
    try {
      const u = await tg.botUsername();
      check("botUsername: getMe failure -> undefined", u === undefined, `got ${u}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
