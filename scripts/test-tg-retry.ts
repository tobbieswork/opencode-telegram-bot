/**
 * Unit test for the transport-level retry in Telegram.api() (src/telegram.ts):
 * transient network failures (undici `fetch failed`, ECONNRESET, TLS drops...)
 * are retried with backoff - Telegram HTTP errors (ok:false) and aborted
 * requests are NEVER retried. Mirrors the check() style of
 * scripts/test-topic-delete.ts (which monkeypatches globalThis.fetch).
 *
 * Run:  npx tsx scripts/test-tg-retry.ts
 */
import { Telegram } from "../src/telegram.js";

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

async function main(): Promise<void> {
  const tg = new Telegram("123:test");
  const realFetch = globalThis.fetch;
  const realDelays = Telegram.retryDelaysMs;
  Telegram.retryDelaysMs = [1, 1, 1]; // keep the suite fast (restored in finally)

  try {
    // ── Case 1: transport failure ONCE, then success → retry resolves ──
    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return okResponse({ id: 42 });
      }) as any;
      const r = await tg.getMe();
      check("retry: resolves after a transient transport failure", r?.id === 42, JSON.stringify(r));
      check("retry: fetch called exactly twice", calls === 2, `calls=${calls}`);
    }

    // ── Case 2: transport failure ALWAYS → 4 attempts total, then rethrow ──
    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as any;
      let msg = "";
      try {
        await tg.getMe();
      } catch (e) {
        msg = (e as Error).message;
      }
      check("always-failing: rejects with a Network error", /Network error calling/.test(msg), msg);
      check("always-failing: fetch called exactly 4 times (1 + 3 retries)", calls === 4, `calls=${calls}`);
    }

    // ── Case 3: Telegram HTTP error (400, ok:false) → NO retry ──
    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }) as any;
      let msg = "";
      try {
        await tg.getMe();
      } catch (e) {
        msg = (e as Error).message;
      }
      check("http 400: rejects with the Telegram description", /Bad Request/.test(msg), msg);
      check("http 400: fetch called exactly ONCE (no retry on HTTP errors)", calls === 1, `calls=${calls}`);
    }

    // ── Case 4: AbortError from fetch → rethrown immediately, no retry ──
    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      }) as any;
      let caught: unknown = null;
      try {
        await tg.getMe();
      } catch (e) {
        caught = e;
      }
      check("abort: rejects with the AbortError", (caught as Error)?.name === "AbortError", String(caught));
      check("abort: fetch called exactly once", calls === 1, `calls=${calls}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    Telegram.retryDelaysMs = realDelays;
  }

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
