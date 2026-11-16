/**
 * Regression test for the OpenCode event-loop backoff (issue #148).
 *
 * Before the fix, the loop reset its backoff to 1000 ms and called onConnect
 * (which in the bot runs an API reconcile) right after `client.event.subscribe()`
 * returned — before any event was actually observed. Because subscribe is lazy
 * (the first HTTP open happens inside the for-await), a dead service made EVERY
 * attempt look like a clean reconnect: the delay never grew past 1000 ms and
 * the bot reconciled once per second during an outage.
 *
 * The test drives the REAL OpenCodeCtl.eventLoop with a fake client whose
 * `event.subscribe()` returns scripted AsyncIterables, and a fake clock (the
 * ctl's injectable `sleep`) that parks the loop after every attempt so the
 * delays passed to sleep can be asserted one by one:
 *   1. the delay GROWS (1000, 2000, 4000, 8000, ...) across consecutive
 *      attempts that observe no event — whether the stream throws or closes
 *      cleanly before yielding anything;
 *   2. onConnect fires exactly once per attempt that yields at least one real
 *      event, never on an eventless attempt, and the backoff resets to 1000 ms
 *      at that moment.
 *
 * Run:  npx tsx scripts/test-event-loop.ts
 */
import { OpenCodeCtl } from "../src/opencode.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Attempt {
  events: number;
  connect: boolean;
}

interface Harness {
  ctl: OpenCodeCtl;
  sleeps: number[];
  attempts: Attempt[];
  onEventCalls: unknown[];
  onErrors: unknown[];
  /** Flag that onConnect fired on the attempt currently being processed. */
  markConnect: () => void;
  /** Let the loop finish its parked backoff sleep and run one more attempt. */
  advance: () => Promise<void>;
  stop: () => void;
}

/**
 * Build a ctl whose `client.event.subscribe()` returns the stream scripted by
 * `streamFor(attemptIndex)` and whose backoff clock records the delay and
 * parks instead of sleeping. After each attempt the loop parks in that (fake)
 * sleep, so the test advances it one attempt at a time.
 */
function makeHarness(streamFor: (attempt: number) => AsyncIterable<unknown>): Harness {
  const ctl = new OpenCodeCtl();
  const sleeps: number[] = [];
  const attempts: Attempt[] = [];
  const onEventCalls: unknown[] = [];
  const onErrors: unknown[] = [];
  const paused: Array<() => void> = [];

  (ctl as any).client = {
    event: {
      subscribe: () => {
        const rec: Attempt = { events: 0, connect: false };
        attempts.push(rec);
        const stream = streamFor(attempts.length - 1);
        return (async function* wrap(): AsyncGenerator<unknown, void> {
          for await (const ev of stream) {
            rec.events++;
            yield ev;
          }
        })();
      },
    },
  };
  (ctl as any).sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      sleeps.push(ms);
      paused.push(resolve);
    });

  const waitPaused = async (): Promise<void> => {
    for (let i = 0; i < 2000 && paused.length === 0; i++) await tick();
  };

  const markConnect = (): void => {
    const cur = attempts[attempts.length - 1];
    if (cur) cur.connect = true;
  };

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    ctl.stopEvents();
    for (const r of paused.splice(0)) r();
  };

  return {
    ctl,
    sleeps,
    attempts,
    onEventCalls,
    onErrors,
    markConnect,
    advance: async (): Promise<void> => {
      await waitPaused();
      const r = paused.shift();
      if (!r) throw new Error("event loop did not park on a backoff sleep");
      r();
      await waitPaused();
    },
    stop,
  };
}

/** A stream that fails on first read (dead service). */
function deadStream(): AsyncGenerator<unknown, void> {
  return (async function* (): AsyncGenerator<unknown, void> {
    yield* [];
    throw new Error("ECONNREFUSED (fake dead service)");
  })();
}

/** A stream that closes immediately without yielding anything. */
function emptyStream(): AsyncGenerator<unknown, void> {
  return (async function* (): AsyncGenerator<unknown, void> {
    yield* [];
  })();
}

/** A stream that yields exactly `events`, then closes. */
function eventsThenClose(events: unknown[]): AsyncGenerator<unknown, void> {
  return (async function* (): AsyncGenerator<unknown, void> {
    for (const ev of events) yield ev;
  })();
}

async function main(): Promise<void> {
  // 1) Dead service: backoff must grow; onConnect must never fire.
  const a = makeHarness(() => deadStream());
  a.ctl.subscribeEvents((ev) => a.onEventCalls.push(ev), (e) => a.onErrors.push(e), () => a.markConnect());
  await a.advance();
  await a.advance();
  await a.advance();
  check(
    "delay grows across no-event attempts (1000, 2000, 4000, 8000)",
    JSON.stringify(a.sleeps) === JSON.stringify([1000, 2000, 4000, 8000]),
    `sleeps=${JSON.stringify(a.sleeps)}`,
  );
  check(
    "onConnect never fires on eventless (re)connects",
    a.attempts.length === 4 && a.attempts.every((t) => t.events === 0 && !t.connect),
    `attempts=${JSON.stringify(a.attempts)}`,
  );
  check("every dead attempt surfaced an error", a.onErrors.length === 4, `errors=${a.onErrors.length}`);
  check("no events were delivered", a.onEventCalls.length === 0);
  a.stop();

  // 2) Stream that closes cleanly with zero events: backoff must NOT reset.
  const b = makeHarness(() => emptyStream());
  b.ctl.subscribeEvents((ev) => b.onEventCalls.push(ev), (e) => b.onErrors.push(e), () => b.markConnect());
  await b.advance();
  check(
    "eventless clean close does not reset backoff (1000, 2000)",
    JSON.stringify(b.sleeps) === JSON.stringify([1000, 2000]),
    `sleeps=${JSON.stringify(b.sleeps)}`,
  );
  check(
    "no onConnect / no onEvent on an empty stream",
    b.attempts.length === 2 && b.attempts.every((t) => !t.connect) && b.onEventCalls.length === 0,
    `attempts=${JSON.stringify(b.attempts)}`,
  );
  b.stop();

  // 3) First real event: reset the backoff and fire onConnect exactly once.
  const e1 = { type: "test.first-event" };
  const cSpecs = [deadStream, deadStream, () => eventsThenClose([e1]), emptyStream];
  const c = makeHarness((i) => cSpecs[Math.min(i, cSpecs.length - 1)]());
  c.ctl.subscribeEvents((ev) => c.onEventCalls.push(ev), (e) => c.onErrors.push(e), () => c.markConnect());
  await c.advance();
  await c.advance();
  await c.advance();
  check(
    "backoff grows, resets to 1000 on first real event, grows again without events",
    JSON.stringify(c.sleeps) === JSON.stringify([1000, 2000, 1000, 2000]),
    `sleeps=${JSON.stringify(c.sleeps)}`,
  );
  check(
    "onConnect fires exactly once, only on the eventful attempt",
    c.attempts.map((t) => (t.connect ? "y" : "-")).join(",") === "-,-,y,-",
    `attempts=${JSON.stringify(c.attempts)}`,
  );
  check("the first event was delivered to onEvent", c.onEventCalls.length === 1 && c.onEventCalls[0] === e1);
  c.stop();

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll event-loop backoff tests passed`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
