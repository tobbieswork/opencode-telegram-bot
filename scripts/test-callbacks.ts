/**
 * Checks the typed callback registry (src/callbacks.ts —
 * docs/sdd/callback-registry.md, T2: registry core):
 * - C1.1/C1.3: the helper defs (simple/oneArg/fields/tokenArg) encode/decode
 *   round-trip, and the encoder enforces Telegram's 64-BYTE cap
 *   (Buffer.byteLength, not string length): strict mode throws
 *   CallbackLimitError, plain defs always refuse, tokenArg falls back to a
 *   short-lived token in production;
 * - C1.2: registering the same prefix twice throws, naming BOTH owners;
 * - C2.1/C2.4/C3.2: dispatchCallback routes a registered prefix to its
 *   handler with the decoded args and returns false for unregistered
 *   prefixes (so the legacy startsWith chain keeps working); exactly one
 *   answerCallbackQuery happens per dispatch, even when the handler throws
 *   or forgets to answer;
 * - C2.2: registered data that fails to decode, and data that matches
 *   nothing (answerExpired), get a short "button expired" toast, warn once
 *   per unique data string, and never throw.
 *
 * No Telegram and no Bot instance involved: the registry only touches
 * `bot.tg.answerCallbackQuery`, which is faked here.
 *
 * Run: npx tsx scripts/test-callbacks.ts
 */
import {
  CALLBACK_MAX_BYTES,
  CallbackLimitError,
  ERROR_TOAST,
  EXPIRED_TOAST,
  answerExpired,
  callbackOwner,
  defineCallback,
  dispatchCallback,
  fields,
  oneArg,
  registerCallback,
  registeredPrefixes,
  setCallbackStrict,
  simple,
  tokenArg,
  _clearCallbacksForTest,
  _resetWarnOnceForTest,
  _setTokenTtlMsForTest,
} from "../src/callbacks.js";
import type { Bot } from "../src/bot.js";
import type { CallbackQuery } from "../src/telegram.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function throws(fn: () => unknown, ctor?: new (...args: unknown[]) => Error): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return ctor ? e instanceof ctor : true;
  }
}

/** A fake bot: the registry only touches `bot.tg.answerCallbackQuery`. */
function fakeBot(): { bot: Bot; answers: Array<{ id: string; text?: string }> } {
  const answers: Array<{ id: string; text?: string }> = [];
  const bot = {
    tg: {
      answerCallbackQuery: async (id: string, text?: string): Promise<void> => {
        answers.push({ id, text });
      },
    },
  } as unknown as Bot;
  return { bot, answers };
}

function cb(data: string, id = "cbq-1"): CallbackQuery {
  return { id, data, from: { id: 1 }, message: { chat: { id: 42 }, message_id: 7 } };
}

const base = (bot: Bot) => ({ bot, conv: "c1", messageId: 7, lang: "vi" as const });

async function main(): Promise<void> {
  // ── C1.1: the helper defs round-trip ───────────────────────────────────
  {
    _clearCallbacksForTest();
    const s = simple("noop");
    check("simple: encodes as 'noop:'", s.encode() === "noop:");
    check("simple: empty rest decodes to undefined (no args)", s.decode("") === undefined);
    check("simple: non-empty rest is malformed", s.decode("x") === null);

    const pb = oneArg("pb");
    check("oneArg: encodes pb:go", pb.encode("go") === "pb:go");
    check("oneArg: round-trips", pb.decode("go") === "go");
    check("oneArg: empty rest is malformed", pb.decode("") === null);
    check("oneArg: encode rejects an empty value", throws(() => pb.encode("")));
    check("oneArg: encode rejects a colon in the value", throws(() => pb.encode("a:b")));

    const sch = fields("sch", 2);
    check("fields: encodes sch:run:ab12", sch.encode(["run", "ab12"]) === "sch:run:ab12");
    check("fields: round-trips", JSON.stringify(sch.decode("run:ab12")) === JSON.stringify(["run", "ab12"]));
    check("fields: too few fields is malformed", sch.decode("ls") === null);
    check("fields: too many fields is malformed", sch.decode("a:b:c") === null);
    check("fields: an empty field is malformed", sch.decode("a::b") === null);
    check("fields: encode rejects a wrong arity (1 of 2)", throws(() => sch.encode(["a"])));
    check("fields: encode rejects a wrong arity (3 of 2)", throws(() => sch.encode(["a", "b", "c"])));
    check("fields: encode rejects a colon in a value", throws(() => sch.encode(["a:b", "c"])));

    const use = tokenArg("use");
    check(
      "tokenArg: a short value is inlined",
      use.encode("ses_abc123") === "use:ses_abc123" && use.decode("ses_abc123") === "ses_abc123",
    );
    const long = "x".repeat(70);
    const tok = use.encode(long);
    check("tokenArg: a long value becomes a ≤64-byte token form", Buffer.byteLength(tok, "utf8") <= 64 && /^use:~[a-z0-9]{12}$/.test(tok), tok);
    check("tokenArg: the token decodes back to the value", use.decode(tok.slice("use:".length)) === long);
    check("tokenArg: an unknown token is malformed", use.decode("~zzzzzzzzzzzz") === null);
    check("tokenArg: an empty value is malformed", use.decode("") === null);
    check("tokenArg: a value starting with '~' is refused", throws(() => use.encode("~nope")));
  }

  // ── C1.3: the 64-byte cap is enforced in BYTES, not chars ───────────────
  {
    check("the cap is 64 bytes", CALLBACK_MAX_BYTES === 64);
    setCallbackStrict(true);
    try {
      const pb = oneArg("pb"); // "pb:" = 3 bytes → 61 ASCII chars fit
      check("strict: exactly 64 bytes encodes", pb.encode("a".repeat(61)).length === 64);
      check("strict: 65 bytes throws CallbackLimitError", throws(() => pb.encode("a".repeat(62)), CallbackLimitError));
      // Vietnamese chars are 2 bytes in UTF-8 — a char-count check would miss this.
      check("strict: 30 Vietnamese chars (63 B) encode", pb.encode("ă".repeat(30)).length === 33);
      check("strict: 31 Vietnamese chars (65 B) throw", throws(() => pb.encode("ă".repeat(31)), CallbackLimitError));
      check("strict: tokenArg throws instead of falling back", throws(() => tokenArg("use").encode("y".repeat(70)), CallbackLimitError));
    } finally {
      setCallbackStrict(false);
    }
    const pb = oneArg("pb");
    check("prod: a plain def still refuses >64 B", throws(() => pb.encode("a".repeat(62)), CallbackLimitError));
    const use = tokenArg("use");
    const long = "z".repeat(70);
    const tok = use.encode(long);
    check("prod: tokenArg falls back to a token (round-trips)", Buffer.byteLength(tok, "utf8") <= 64 && use.decode(tok.slice("use:".length)) === long, tok);
  }

  // ── C1.3: tokens are short-lived (in-memory, TTL-bound) ─────────────────
  {
    _setTokenTtlMsForTest(1);
    const use = tokenArg("use");
    const tok = use.encode("t".repeat(70));
    await new Promise((r) => setTimeout(r, 10));
    check("an expired token decodes to null", use.decode(tok.slice("use:".length)) === null, tok);
    _setTokenTtlMsForTest(); // back to the 24 h default
    const fresh = use.encode("t".repeat(70));
    check("after the TTL reset, fresh tokens resolve again", use.decode(fresh.slice("use:".length)) === "t".repeat(70));
  }

  // ── C1.2: a prefix is declared once; duplicates name both owners ────────
  {
    _clearCallbacksForTest();
    const noop = (): void => {};
    registerCallback(oneArg("pb"), noop, "plan-to-build");
    check("the owner is recorded", callbackOwner("pb") === "plan-to-build");
    registerCallback(oneArg("rot"), noop, "rotation");
    check("registeredPrefixes is sorted", JSON.stringify(registeredPrefixes()) === JSON.stringify(["pb", "rot"]));
    let msg = "";
    try {
      registerCallback(oneArg("pb"), noop, "other-feature");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("a duplicate prefix throws", msg !== "");
    check("the error names the prefix", msg.includes('"pb"'), msg);
    check("the error names the first owner", msg.includes("plan-to-build"), msg);
    check("the error names the second owner", msg.includes("other-feature"), msg);
    check("defineCallback rejects a colon in the prefix", throws(() => defineCallback({ prefix: "a:b", encode: () => "a:b", decode: () => null })));
    check("defineCallback rejects an empty prefix", throws(() => defineCallback({ prefix: "", encode: () => "", decode: () => null })));
  }

  // ── C2.1/C2.4/C3.2: dispatch ────────────────────────────────────────────
  {
    _clearCallbacksForTest();
    _resetWarnOnceForTest();
    const { bot, answers } = fakeBot();
    let calls = 0;
    let seen: { args?: unknown; conv?: string; messageId?: number; lang?: string; cb?: CallbackQuery } = {};
    registerCallback(
      oneArg("dt"),
      (ctx, cbq, args) => {
        calls++;
        seen = { args, conv: ctx.conv, messageId: ctx.messageId, lang: ctx.lang, cb: cbq };
        ctx.answer("ok-toast");
      },
      "test",
    );

    check("C3.2: an unregistered prefix falls through (false)", (await dispatchCallback(base(bot), cb("zz:1"))) === false);
    check("fall-through answers nothing (the chain's job)", answers.length === 0);
    check("no-colon data falls through", (await dispatchCallback(base(bot), cb("zzz"))) === false);
    check("empty data falls through", (await dispatchCallback(base(bot), cb(""))) === false);

    const q = cb("dt:hello");
    check("C2.1: a registered prefix dispatches (true)", (await dispatchCallback(base(bot), q)) === true);
    check("the handler ran once", calls === 1);
    check("with the decoded args", seen.args === "hello");
    check("ctx carries the conv", seen.conv === "c1");
    check("ctx carries the messageId", seen.messageId === 7);
    check("ctx carries the tapper's lang", seen.lang === "vi");
    check("the handler got the original callback", seen.cb === q);
    check("exactly one answer", answers.length === 1, JSON.stringify(answers));
    check("with the handler's toast", answers[0]?.text === "ok-toast");
    check("for this query id", answers[0]?.id === "cbq-1");

    let simpleArgs: unknown = "sentinel";
    registerCallback(simple("ww2"), (ctx, _cbq, args) => { simpleArgs = args; ctx.answer(); }, "test");
    check("a zero-arg prefix dispatches", (await dispatchCallback(base(bot), cb("ww2:"))) === true);
    check("…with args === undefined", simpleArgs === undefined);
    check("…and is answered (2nd)", answers.length === 2);

    registerCallback(oneArg("boom"), () => { throw new Error("kapow"); }, "test");
    check("C2.4: a throwing handler is still handled (true)", (await dispatchCallback(base(bot), cb("boom:x"))) === true);
    check("C2.4: …and still answered", answers.length === 3);
    check("…with the error toast", answers[2]?.text === ERROR_TOAST.vi, JSON.stringify(answers[2]));

    registerCallback(oneArg("quiet"), () => {}, "test");
    check("C2.4: a forgetful handler gets a silent answer", (await dispatchCallback(base(bot), cb("quiet:x"))) === true && answers.length === 4);
    check("…with no toast", answers[3]?.text === undefined);

    registerCallback(oneArg("late"), (ctx) => { ctx.answer("first"); throw new Error("after answering"); }, "test");
    check(
      "answer-then-throw keeps exactly one answer (the handler's wins)",
      (await dispatchCallback(base(bot), cb("late:x"))) === true && answers.length === 5 && answers[4]?.text === "first",
      JSON.stringify(answers[4]),
    );
  }

  // ── C2.2: decode failure + unmatched data → expired toast, warn once ────
  {
    _clearCallbacksForTest();
    _resetWarnOnceForTest();
    const { bot, answers } = fakeBot();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]): void => { warns.push(a.map(String).join(" ")); };
    try {
      registerCallback(oneArg("dm"), () => { throw new Error("handler must not run on decode failure"); }, "test");
      check("an empty value (decode → null) is handled", (await dispatchCallback(base(bot), cb("dm:"))) === true);
      check("…with the expired toast (vi)", answers.length === 1 && answers[0]?.text === EXPIRED_TOAST.vi, JSON.stringify(answers));

      await dispatchCallback(base(bot), cb("dm:"));
      await dispatchCallback(base(bot), cb("dm:"));
      check("warned exactly once per unique data", warns.filter((w) => w.includes('data="dm:"')).length === 1, JSON.stringify(warns));

      const crazy = defineCallback<string>({
        prefix: "cr",
        encode: (v) => `cr:${v}`,
        decode: () => { throw new Error("parser exploded"); },
      });
      registerCallback(crazy, () => {}, "test");
      check("a throwing decode does not propagate", (await dispatchCallback(base(bot), cb("cr:x"))) === true);
      check("…and still gets the expired toast", answers[answers.length - 1]?.text === EXPIRED_TOAST.vi, JSON.stringify(answers[answers.length - 1]));

      await answerExpired(bot, cb("junk:data"), "en", "junk:data");
      check("answerExpired toasts in the tapper's lang (en)", answers[answers.length - 1]?.text === EXPIRED_TOAST.en, JSON.stringify(answers[answers.length - 1]));
      const n = warns.length;
      await answerExpired(bot, cb("junk:data"), "en", "junk:data");
      check("answerExpired warns once per data", warns.length === n, JSON.stringify(warns));
    } finally {
      console.warn = origWarn;
    }
  }
}

main().then(
  () => {
    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
