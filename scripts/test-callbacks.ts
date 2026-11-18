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
 *   per unique data string, and never throw;
 * - T3 (pilot migration of pb/ch/cont/reboot, C3.1/C3.3): the four migrated
 *   defs round-trip, reject malformed input, enforce the 64-byte cap, and
 *   decode CAPTURED real callback strings (buttons already in production);
 *   importing bot.js registers the four prefixes, and dispatch routes them
 *   to the handler adapters with exactly one answer.
 *
 * No Telegram and no Bot instance involved: the registry only touches
 * `bot.tg.answerCallbackQuery`, which is faked here. (The T3 section imports
 * bot.js for the real defs/registration — still no Bot instance, no network.)
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
import { bsCallback, pbCallback, registerBotCallbacks } from "../src/bot.js";
import type { Bot } from "../src/bot.js";
import { choiceCallback, choiceKeyboard, registry as choiceRecords } from "../src/choices.js";
import { continueCallback, continueCallbackData, parseContinueData } from "../src/continue.js";
import { rebootCallback, rebootGoData } from "../src/uptime.js";
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

  // ── T3: pilot migration — pb, ch, cont, reboot (C3.1/C3.3) ──────────────
  {
    // bot.js's module load registers the four pilot prefixes; the T2 section
    // above cleared the registry, so restore the real registration.
    _clearCallbacksForTest();
    registerBotCallbacks();

    check(
      "T3: all four pilot prefixes are registered",
      ["pb", "ch", "cont", "reboot"].every((p) => registeredPrefixes().includes(p)),
      JSON.stringify(registeredPrefixes()),
    );
    check("T3: pb owner", callbackOwner("pb") === "bot.ts (plan-to-build)", callbackOwner("pb"));
    check("T3: ch owner", callbackOwner("ch") === "choices.ts (choice buttons)", callbackOwner("ch"));
    check("T3: cont owner", callbackOwner("cont") === "continue.ts (continue button)", callbackOwner("cont"));
    check("T3: reboot owner", callbackOwner("reboot") === "uptime.ts (reboot flow)", callbackOwner("reboot"));

    // pb — the wire form is the fixed "pb:go" (C3.1).
    check("T3 pb: encodes as pb:go", pbCallback.encode({ op: "go" }) === "pb:go", pbCallback.encode({ op: "go" }));
    check("T3 pb: round-trips", JSON.stringify(pbCallback.decode("go")) === JSON.stringify({ op: "go" }));
    check("T3 pb: a foreign value is malformed", pbCallback.decode("stop") === null);
    check("T3 pb: empty rest is malformed", pbCallback.decode("") === null);
    check("T3 pb: extra fields are malformed", pbCallback.decode("go:extra") === null);
    check("T3 pb: the encoded form fits 64 bytes", Buffer.byteLength(pbCallback.encode({ op: "go" }), "utf8") <= CALLBACK_MAX_BYTES);

    // ch — "ch:<id>:<i>" (4-char base36 registry key + option index) or "ch:inert".
    const pick = { kind: "pick", id: "ab12", index: 3 };
    check("T3 ch: pick encodes as ch:ab12:3", choiceCallback.encode(pick) === "ch:ab12:3", choiceCallback.encode(pick));
    check("T3 ch: pick round-trips", JSON.stringify(choiceCallback.decode("ab12:3")) === JSON.stringify(pick));
    check("T3 ch: index 0 round-trips", JSON.stringify(choiceCallback.decode("ab12:0")) === JSON.stringify({ kind: "pick", id: "ab12", index: 0 }));
    check("T3 ch: inert encodes as ch:inert", choiceCallback.encode({ kind: "inert" }) === "ch:inert");
    check("T3 ch: inert round-trips", JSON.stringify(choiceCallback.decode("inert")) === JSON.stringify({ kind: "inert" }));
    check("T3 ch: an uppercase id is malformed", choiceCallback.decode("AB12:3") === null);
    check("T3 ch: a 3-char id is malformed", choiceCallback.decode("ab1:3") === null);
    check("T3 ch: a 5-char id is malformed", choiceCallback.decode("abcde:3") === null);
    check("T3 ch: a missing index is malformed", choiceCallback.decode("ab12") === null);
    check("T3 ch: an empty index is malformed", choiceCallback.decode("ab12:") === null);
    check("T3 ch: a non-numeric index is malformed", choiceCallback.decode("ab12:x") === null);
    check("T3 ch: extra fields are malformed", choiceCallback.decode("ab12:3:4") === null);
    check("T3 ch: empty rest is malformed", choiceCallback.decode("") === null);
    check("T3 ch: encode rejects a 3-char id", throws(() => choiceCallback.encode({ kind: "pick", id: "ab1", index: 0 })));
    check("T3 ch: encode rejects a negative index", throws(() => choiceCallback.encode({ kind: "pick", id: "ab12", index: -1 })));
    check("T3 ch: encode rejects a fractional index", throws(() => choiceCallback.encode({ kind: "pick", id: "ab12", index: 1.5 })));

    // cont — "cont:<sessionID>".
    check("T3 cont: encodes as cont:<id>", continueCallback.encode("ses_abc123") === "cont:ses_abc123");
    check("T3 cont: round-trips", continueCallback.decode("ses_abc123") === "ses_abc123");
    check("T3 cont: empty rest is malformed", continueCallback.decode("") === null);
    setCallbackStrict(true);
    try {
      // the prefix is 5 bytes: a 60-byte id makes 65 B (over), 59 makes 64 (ok).
      check("T3 cont: a 65-byte encode throws CallbackLimitError", throws(() => continueCallback.encode("s".repeat(60)), CallbackLimitError));
      check("T3 cont: exactly 64 bytes encodes", continueCallback.encode("s".repeat(59)).length === 64);
    } finally {
      setCallbackStrict(false);
    }
    check("T3 cont: the producer OMITS (does not throw) over the cap", continueCallbackData("s".repeat(60)) === undefined);
    check("T3 cont: the producer keeps the 64-byte boundary", continueCallbackData("s".repeat(59)) !== undefined);
    check("T3 cont: parseContinueData agrees with the def", parseContinueData("cont:ses_abc123") === "ses_abc123" && parseContinueData("cont:") === undefined);

    // reboot — "reboot:<op>" plus "reboot:go:<epoch-ms>".
    for (const op of ["ask", "snooze", "cancel"] as const) {
      check(`T3 reboot: ${op} round-trips`, rebootCallback.encode({ op }) === `reboot:${op}` && JSON.stringify(rebootCallback.decode(op)) === JSON.stringify({ op }));
    }
    check(
      "T3 reboot: go round-trips",
      rebootCallback.encode({ op: "go", issuedMs: 1762969622000 }) === "reboot:go:1762969622000" &&
        JSON.stringify(rebootCallback.decode("go:1762969622000")) === JSON.stringify({ op: "go", issuedMs: 1762969622000 }),
    );
    check("T3 reboot: rebootGoData encodes through the def", rebootGoData(1762969622000) === "reboot:go:1762969622000");
    check("T3 reboot: a go without timestamp is malformed", rebootCallback.decode("go") === null);
    check("T3 reboot: a garbled timestamp is malformed", rebootCallback.decode("go:abc") === null);
    check("T3 reboot: a zero timestamp is malformed", rebootCallback.decode("go:0") === null);
    check("T3 reboot: a negative timestamp is malformed", rebootCallback.decode("go:-1") === null);
    check("T3 reboot: an unknown op is malformed", rebootCallback.decode("xyz") === null);
    check("T3 reboot: an op with extra fields is malformed", rebootCallback.decode("ask:extra") === null);
    check("T3 reboot: empty rest is malformed", rebootCallback.decode("") === null);
    check("T3 reboot: encode rejects a fractional issuedMs", throws(() => rebootCallback.encode({ op: "go", issuedMs: 1.5 })));
    check("T3 reboot: encode rejects a non-positive issuedMs", throws(() => rebootCallback.encode({ op: "go", issuedMs: 0 })));

    // C3.1 — replay CAPTURED real callback strings against the new decoders,
    // so buttons already sent before this deploy keep working.
    // pb: "pb:go" is the only wire string this button has ever carried (a
    // single literal producer), so the captured string is exactly this one.
    check("T3 C3.1: captured 'pb:go' decodes", JSON.stringify(pbCallback.decode("go")) === JSON.stringify({ op: "go" }));
    // ch: choice ids live in the bot's memory (they do not survive a
    // restart), so capture a real one through the real producer — registry.put
    // (the real id generator) + choiceKeyboard (the real encoder).
    const chId = choiceRecords.put("c1", "ses_captured", ["one", "two"]);
    const chWire = choiceKeyboard(chId, ["one", "two"]).inline_keyboard[0][0].callback_data!;
    check("T3 C3.1: captured ch: has the real wire form", /^ch:[0-9a-z]{4}:0$/.test(chWire), chWire);
    check("T3 C3.1: captured ch: decodes back to the pick", JSON.stringify(choiceCallback.decode(chWire.slice("ch:".length))) === JSON.stringify({ kind: "pick", id: chId, index: 0 }), chWire);
    // cont: captured from the live journal (manager rotation line, 2026-11-15).
    const contCaptured = "cont:ses_e218197a2ffeH3ybgUypvQO7q8";
    check("T3 C3.1: captured cont: fits 64 bytes", Buffer.byteLength(contCaptured, "utf8") <= CALLBACK_MAX_BYTES);
    check("T3 C3.1: captured cont: decodes to the real session id", continueCallback.decode(contCaptured.slice("cont:".length)) === "ses_e218197a2ffeH3ybgUypvQO7q8");
    // reboot: "reboot:ask" is the exact wire string every real uptime reminder
    // has carried since the feature shipped (a single literal producer).
    check("T3 C3.1: captured 'reboot:ask' decodes", JSON.stringify(rebootCallback.decode("ask")) === JSON.stringify({ op: "ask" }));
    // plus the go variant through the real encoder with a real 13-digit ms
    // (≈ the real confirm tap of 2026-11-12 13:27:02 UTC).
    const goCaptured = rebootGoData(1762969622000);
    check("T3 C3.1: captured reboot:go: decodes back", JSON.stringify(rebootCallback.decode(goCaptured.slice("reboot:".length))) === JSON.stringify({ op: "go", issuedMs: 1762969622000 }), goCaptured);

    // Dispatch wiring: the registered prefixes route to the handler adapters
    // with exactly one answer (C2.1/C2.4) — a fake bot that records the calls.
    const { bot, answers } = fakeBot();
    const calls: string[] = [];
    (bot as Record<string, unknown>).handlePlanToBuildCallback = async (_cb: unknown, _conv: unknown, answer: (t?: string) => void) => { calls.push("pb"); answer("pb-done"); };
    (bot as Record<string, unknown>).handleChoiceCallback = async (_cb: unknown, _conv: unknown, answer: (t?: string) => void, _mid: unknown) => { calls.push("ch"); };
    (bot as Record<string, unknown>).handleContinueCallback = async (_cb: unknown, _conv: unknown, answer: (t?: string) => void, _mid: unknown) => { calls.push("cont"); answer("cont-done"); };
    (bot as Record<string, unknown>).handleRebootCallback = async (_cb: unknown, _conv: unknown, answer: (t?: string) => void, _mid: unknown) => { calls.push("reboot"); };
    check("T3 dispatch: pb:go routes to the pb handler", (await dispatchCallback(base(bot), cb("pb:go"))) === true && calls.length === 1 && calls[0] === "pb", JSON.stringify(calls));
    check("T3 dispatch: …answered exactly once, with the handler's toast", answers.length === 1 && answers[0]?.text === "pb-done", JSON.stringify(answers));
    check("T3 dispatch: ch routes to the ch handler", (await dispatchCallback(base(bot), cb(`ch:${chId}:1`))) === true && calls[1] === "ch", JSON.stringify(calls));
    check("T3 dispatch: a forgetful handler is answered silently", answers.length === 2 && answers[1]?.text === undefined, JSON.stringify(answers));
    check("T3 dispatch: the captured cont: string routes", (await dispatchCallback(base(bot), cb(contCaptured))) === true && calls[2] === "cont" && answers[2]?.text === "cont-done", JSON.stringify(calls));
    check("T3 dispatch: reboot routes", (await dispatchCallback(base(bot), cb("reboot:cancel"))) === true && calls[3] === "reboot" && answers[3]?.text === undefined, JSON.stringify(calls));
    check(
      "T3 dispatch: a malformed ch: is answered expired (no fall-through)",
      (await dispatchCallback(base(bot), cb("ch:AB12:3"))) === true && answers.length === 5 && answers[4]?.text === EXPIRED_TOAST.vi,
      JSON.stringify(answers),
    );
  }
  // ── T5: bs: migration — folder browser (C3.1/C3.3) ─────────────────────
  {
    // bot.js's module load registers the prefixes; the sections above cleared
    // the registry, so restore the real registration.
    _clearCallbacksForTest();
    registerBotCallbacks();

    check("T5: bs is registered", registeredPrefixes().includes("bs"), JSON.stringify(registeredPrefixes()));
    check("T5: bs owner", callbackOwner("bs") === "bot.ts (folder browser)", callbackOwner("bs"));

    // Round-trip: the bare ops (no numeric arg).
    for (const op of ["up", "hid", "open", "list", "setdir", "setsess", "close", "noop"] as const) {
      check(`T5 bs: ${op} encodes as bs:${op}`, bsCallback.encode({ op }) === `bs:${op}`, bsCallback.encode({ op }));
      check(`T5 bs: ${op} round-trips`, JSON.stringify(bsCallback.decode(op)) === JSON.stringify({ op }), JSON.stringify(bsCallback.decode(op)));
    }
    // Round-trip: the ops that carry a numeric arg (folder index / page).
    check(
      "T5 bs: nav:5 round-trips",
      bsCallback.encode({ op: "nav", arg: "5" }) === "bs:nav:5" && JSON.stringify(bsCallback.decode("nav:5")) === JSON.stringify({ op: "nav", arg: "5" }),
    );
    check(
      "T5 bs: pg:0 round-trips",
      bsCallback.encode({ op: "pg", arg: "0" }) === "bs:pg:0" && JSON.stringify(bsCallback.decode("pg:0")) === JSON.stringify({ op: "pg", arg: "0" }),
    );
    // Malformed: an empty op can't round-trip.
    check("T5 bs: empty rest is malformed", bsCallback.decode("") === null);
    check("T5 bs: an arg with no op is malformed", bsCallback.decode(":5") === null);
    // C1.3: the 64-byte cap is enforced in bytes (every real bs: op is short,
    // so a realistic encode fits; an over-long op is refused in strict mode).
    check("T5 bs: the longest real op fits 64 bytes", Buffer.byteLength(bsCallback.encode({ op: "setsess" }), "utf8") <= CALLBACK_MAX_BYTES);
    setCallbackStrict(true);
    try {
      check("T5 bs: an over-long op is refused (strict)", throws(() => bsCallback.encode({ op: "x".repeat(62) }), CallbackLimitError));
    } finally {
      setCallbackStrict(false);
    }

    // C3.1 — replay captured real callback strings against the new decoder,
    // so buttons already sent before this deploy keep working. bs: strings are
    // structurally bounded (a fixed op set + a small page/index integer), so
    // representative captured values are the exact wire form.
    check("T5 C3.1: captured 'bs:nav:3' decodes", JSON.stringify(bsCallback.decode("nav:3")) === JSON.stringify({ op: "nav", arg: "3" }));
    check("T5 C3.1: captured 'bs:pg:1' decodes", JSON.stringify(bsCallback.decode("pg:1")) === JSON.stringify({ op: "pg", arg: "1" }));
    check("T5 C3.1: captured 'bs:setdir' decodes", JSON.stringify(bsCallback.decode("setdir")) === JSON.stringify({ op: "setdir" }));
    check("T5 C3.1: captured 'bs:close' decodes", JSON.stringify(bsCallback.decode("close")) === JSON.stringify({ op: "close" }));
    check("T5 C3.1: captured 'bs:setsess' decodes", JSON.stringify(bsCallback.decode("setsess")) === JSON.stringify({ op: "setsess" }));

    // Dispatch wiring: the registered prefix routes to the handler adapter with
    // exactly one answer (C2.1/C2.4) — a fake bot that records the calls.
    const { bot, answers } = fakeBot();
    const calls: string[] = [];
    (bot as Record<string, unknown>).handleBrowseCallback = async (_cb: unknown, _conv: unknown, answer: (t?: string) => void, _mid: unknown) => { calls.push("bs"); answer("bs-done"); };
    check("T5 dispatch: bs:close routes to the browse handler", (await dispatchCallback(base(bot), cb("bs:close"))) === true && calls.length === 1 && calls[0] === "bs", JSON.stringify(calls));
    check("T5 dispatch: …answered exactly once, with the handler's toast", answers.length === 1 && answers[0]?.text === "bs-done", JSON.stringify(answers));
    check("T5 dispatch: bs:nav:2 routes (arg form)", (await dispatchCallback(base(bot), cb("bs:nav:2"))) === true && calls.length === 2 && calls[1] === "bs", JSON.stringify(calls));
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
