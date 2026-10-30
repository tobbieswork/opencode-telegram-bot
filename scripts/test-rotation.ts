/**
 * Manager rotation — pure logic. M1: the FLOOR (min sent-context over 24h) and
 * the per-message sent-context (input + cache.read). The network side lives in
 * bot.ts (managerFloor) and is exercised live via /status.
 *
 * Run:  npx tsx scripts/test-rotation.ts
 */
import { managerFloorFromMessages, sentContext, ROTATION_WINDOW_MS } from "../src/rotation.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const H = 3600_000;
const inWindow = (t: number, tokens: object) => ({ type: "assistant", time: { created: t }, tokens });

// ── sentContext: input + cache.read (cache.write excluded) ─────────────────
{
  const flat = { type: "assistant", tokens: { input: 1000, output: 50, cache: { read: 80_000, write: 12_000 } } };
  check("sentContext flat = input + cache.read", sentContext(flat) === 81_000, String(sentContext(flat)));
  const wrapped = { info: { type: "assistant", tokens: { input: 100, cache: { read: 200 } } } };
  check("sentContext info-wrapped", sentContext(wrapped) === 300, String(sentContext(wrapped)));
  check("sentContext no tokens → 0", sentContext({ type: "assistant" }) === 0);
  // output / reasoning / cache.write are all excluded — only input + cache.read count
  check("sentContext ignores output/reasoning/write", sentContext({ type: "assistant", tokens: { input: 7, output: 999, reasoning: 888, cache: { read: 3, write: 44 } } }) === 10);
}

// ── managerFloorFromMessages: MIN over the last 24h window ─────────────────
{
  const msgs = [
    inWindow(NOW - 1 * H, { input: 90_000, cache: { read: 0 } }), // 90K
    inWindow(NOW - 2 * H, { input: 56_000, cache: { read: 0 } }), // 56K ← min
    inWindow(NOW - 3 * H, { input: 70_000, cache: { read: 0 } }), // 70K
    inWindow(NOW - 30 * H, { input: 10_000, cache: { read: 0 } }), // 10K but OLDER than 24h → excluded
    { type: "user", time: { created: NOW - 1 * H } }, // not assistant → ignored
    inWindow(NOW + 1 * H, { input: 1, cache: { read: 0 } }), // future → excluded
  ];
  check("floor = min of in-window (56K)", managerFloorFromMessages(msgs, NOW) === 56_000, String(managerFloorFromMessages(msgs, NOW)));
  check("older-than-window excluded (56K, not 10K)", managerFloorFromMessages(msgs, NOW) === 56_000);
  check("no assistant msgs → 0", managerFloorFromMessages([], NOW) === 0);
  check("only user msgs → 0", managerFloorFromMessages([{ type: "user", time: { created: NOW } }], NOW) === 0);
  check("all outside window → 0", managerFloorFromMessages([inWindow(NOW - 30 * H, { input: 100, cache: { read: 0 } })], NOW) === 0);
  const atCutoff = [inWindow(NOW - ROTATION_WINDOW_MS, { input: 42_000, cache: { read: 0 } })];
  check("message exactly at 24h cutoff is included", managerFloorFromMessages(atCutoff, NOW) === 42_000);
  const pair = [inWindow(NOW - 1 * H, { input: 80_000, cache: { read: 0 } }), inWindow(NOW - 2 * H, { input: 60_000, cache: { read: 0 } })];
  check("order-independent", managerFloorFromMessages(pair, NOW) === 60_000 && managerFloorFromMessages([...pair].reverse(), NOW) === 60_000);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll rotation checks passed.");
