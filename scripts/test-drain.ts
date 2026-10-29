/**
 * Checks the graceful-shutdown drain core (drainInflightCore in src/bot.ts):
 * it waits for in-flight work (fake promises standing in for runPrompt tasks
 * and the final-reply sweeps) to settle, returns true when everything settles
 * within the cap, and gives up (false) exactly at the cap when work never
 * settles. Pure logic — no bot, no Telegram, no systemd.
 *
 * Run:  npx tsx scripts/test-drain.ts
 */
import { drainInflightCore } from "../src/bot.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── already idle: nothing to drain ─────────────────────────────────────────
{
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => false, timeoutMs: 500 });
  const dt = Date.now() - t0;
  check("idle → true", res === true);
  check("idle → returns fast (<50ms)", dt < 50, `dt=${dt}ms`);
}

// ── work that settles after 80ms: drain must actually wait for it ──────────
{
  let done = false;
  setTimeout(() => (done = true), 80); // fake in-flight promise resolving at 80ms
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => !done, timeoutMs: 2_000 });
  const dt = Date.now() - t0;
  check("work settles at 80ms → true", res === true);
  check("waited for the work (≥75ms, not returned early)", dt >= 75, `dt=${dt}ms`);
}

// ── two works: must wait for the SLOWER one ────────────────────────────────
{
  let done1 = false;
  let done2 = false;
  setTimeout(() => (done1 = true), 60);
  setTimeout(() => (done2 = true), 120);
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => !done1 || !done2, timeoutMs: 2_000 });
  const dt = Date.now() - t0;
  check("two works → true once BOTH settle", res === true);
  check("waited for the slower one (≥115ms)", dt >= 115, `dt=${dt}ms`);
}

// ── work that NEVER settles: give up at the cap, never block forever ───────
{
  const t0 = Date.now();
  const res = await drainInflightCore({ isBusy: () => true, timeoutMs: 200, pollMs: 25 });
  const dt = Date.now() - t0;
  check("never-settling → false", res === false);
  check("gave up at the cap (~200ms, bounded)", dt >= 200 && dt <= 325, `dt=${dt}ms`);
}

// ── work that APPEARS during the drain (the real manager flow): the terminal
//    event ends the turn, which registers the final-reply sweep; the drain
//    must pick the sweep up on the next poll and wait for it too. ───────────
{
  const pending = new Set<Promise<unknown>>();
  let turnBusy = true;
  setTimeout(() => {
    turnBusy = false; // turn ends at ~50ms
    const sweep = sleep(100); // final-reply sweep settles ~150ms after start
    pending.add(sweep);
    void sweep.finally(() => pending.delete(sweep));
  }, 50);
  const t0 = Date.now();
  const res = await drainInflightCore({
    isBusy: () => turnBusy || pending.size > 0,
    timeoutMs: 2_000,
  });
  const dt = Date.now() - t0;
  check("sweep spawned by the settling turn is awaited → true", res === true);
  check("waited past the sweep (≥145ms)", dt >= 145, `dt=${dt}ms`);
}

// ── cap hit while a late sweep is still pending → false, not a hang ────────
{
  const pending = new Set<Promise<unknown>>();
  let turnBusy = true;
  setTimeout(() => {
    turnBusy = false;
    const sweep = sleep(1_000); // settles well AFTER the 200ms cap
    pending.add(sweep);
    void sweep.finally(() => pending.delete(sweep));
  }, 50);
  const t0 = Date.now();
  const res = await drainInflightCore({
    isBusy: () => turnBusy || pending.size > 0,
    timeoutMs: 200,
    pollMs: 25,
  });
  const dt = Date.now() - t0;
  check("late sweep + short cap → false", res === false);
  check("still bounded at the cap (~200ms)", dt >= 200 && dt <= 325, `dt=${dt}ms`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
