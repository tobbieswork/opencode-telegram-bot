/**
 * Regression tests for two promptAndWait / reconnect defects (issue #159).
 *
 * TS-6: promptAndWait built its "before" snapshot with .catch(() => []). When
 * that snapshot call failed, beforeIds was EMPTY and every existing assistant
 * message counted as "fresh" — the PREVIOUS turn's answer was returned for
 * the NEW turn. Now a failed snapshot rejects the whole call. Related: the
 * reply pick assumed message.list is newest-first; it now sorts by
 * time.created, so the choice does not depend on list position.
 *
 * TS-7: reconnect() stopped the event stream, then re-established the client,
 * then re-subscribed. If establishment threw, subscribeEvents never ran and
 * the event stream stayed dead until the process restarted (question forms
 * and permission asks no longer relayed). Re-subscription now always runs.
 *
 * Both tests drive the REAL OpenCodeCtl with a fake client (same style as
 * scripts/test-event-loop.ts).
 *
 * Run:  npx tsx scripts/test-turn-reconnect.ts
 */
import { OpenCodeCtl } from "../src/opencode.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log("  ok  " + name);
  else {
    failures++;
    console.error("FAIL  " + name + (detail ? "\n      " + detail : ""));
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** One assistant-shaped message. */
const msg = (id: string, t: number, text?: string): any => ({
  id,
  type: "assistant",
  time: { created: t },
  content: text === undefined ? [] : [{ type: "text", text }],
});

// ── promptAndWait ─────────────────────────────────────────────────────────────

interface TurnFake {
  ctl: OpenCodeCtl;
  listScripts: Array<any[] | Error>; // one entry per message.list call
  promptCalls: number;
  waitCalls: number;
}

function makeTurnFake(initial: Array<any[] | Error>): TurnFake {
  const ctl = new OpenCodeCtl();
  const fake: TurnFake = { ctl, listScripts: [...initial], promptCalls: 0, waitCalls: 0 };
  (ctl as any).client = {
    message: {
      list: async () => {
        const s = fake.listScripts.shift();
        if (!s) throw new Error("test: unexpected extra message.list call");
        if (s instanceof Error) throw s;
        return s;
      },
    },
    session: {
      prompt: async () => {
        fake.promptCalls++;
        return {};
      },
      wait: async () => {
        fake.waitCalls++;
        return {};
      },
      get: async () => ({ outcome: "succeeded" }),
    },
  };
  return fake;
}

async function main(): Promise<void> {
  // TS-6a: a failed BEFORE snapshot must reject the call (and must not send a
  // prompt that would then be "answered" with stale content).
  {
    const f = makeTurnFake([new Error("snapshot exploded (fake, non-transient)")]);
    let err: any;
    try {
      await f.ctl.promptAndWait("ses_test", "hello");
    } catch (e) {
      err = e;
    }
    check("TS-6: rejects when the BEFORE snapshot fails", !!err, err ? String(err) : "did not throw");
    check("TS-6: no prompt sent when the snapshot fails", f.promptCalls === 0, "prompts=" + f.promptCalls);
  }

  // TS-6b: reply picked by max time.created, not by list position. The after
  // list is deliberately NOT newest-first: the true latest reply is LAST.
  {
    const before = [msg("msg_old", 1000, "old answer")];
    const after = [
      msg("msg_b", 2000, "middle reply"),
      msg("msg_old", 1000, "old answer"),
      msg("msg_c", 3000, "latest reply"),
    ];
    const f = makeTurnFake([before, after]);
    const res = await f.ctl.promptAndWait("ses_test", "new turn");
    check(
      "TS-6: out-of-order list picks max time.created",
      res.reply === "latest reply",
      "reply=" + JSON.stringify(res.reply),
    );
    check("TS-6: replyTime follows the picked message", res.replyTime === 3000, "replyTime=" + res.replyTime);
    check("TS-6: the previous turn's reply is not returned", res.reply !== "old answer", "reply=" + JSON.stringify(res.reply));
  }

  // TS-7: establishment fails mid-reconnect; the event stream must still be
  // re-subscribed, and reconnect must still throw for its caller.
  {
    const ctl = new OpenCodeCtl();
    let subscribeCalls = 0;
    const parked: Array<() => void> = [];
    (ctl as any).client = {
      event: {
        subscribe: () => {
          subscribeCalls++;
          return (async function* (): AsyncGenerator<unknown, void> {
            yield* [];
          })();
        },
      },
    };
    (ctl as any).sleep = (_ms: number) => new Promise<void>((resolve) => parked.push(resolve));
    (ctl as any).discoverArgs = {};
    (ctl as any).establishClient = async () => {
      throw new Error("service down (fake)");
    };

    // A live subscription before the reconnect, so reconnect has a loop to stop.
    ctl.subscribeEvents(() => {});
    await tick();
    check("TS-7: initial subscription armed", subscribeCalls === 1, "subs=" + subscribeCalls);

    let threw: string | undefined;
    try {
      await ctl.reconnect();
    } catch (e: any) {
      threw = String(e?.message);
    }
    check("TS-7: still throws when establishment fails", threw === "service down (fake)", "threw=" + threw);
    check("TS-7: event stream re-subscribed after the throw", subscribeCalls === 2, "subs=" + subscribeCalls);

    ctl.stopEvents();
    for (const r of parked.splice(0)) r();
  }

  if (failures > 0) {
    console.error("\nFAIL: " + failures + " check(s) failed");
    process.exit(1);
  }
  console.log("\nAll promptAndWait/reconnect tests passed");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
