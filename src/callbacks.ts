/**
 * Typed callback registry (docs/sdd/callback-registry.md — T2: registry core).
 *
 * Inline buttons carry a `callback_data` string ("prefix:arg:arg…"). This
 * module declares each prefix ONCE with a typed encoder/decoder and a
 * handler, and Bot.handleCallback dispatches registered prefixes through
 * it BEFORE the legacy startsWith chain (C2.1, C3.2). Until a prefix is
 * registered (T3+), its buttons keep flowing through the old chain — the
 * wire format never changes (C3.1). No prefix is registered by this file;
 * migration registers them in their owning modules.
 *
 * Guarantees:
 * - C1.2  registering a prefix twice throws, naming BOTH owners;
 * - C1.3  encoders enforce Telegram's 64-BYTE cap (Buffer.byteLength, not
 *         string length — Vietnamese and emoji are multi-byte). In strict
 *         mode (tests, setCallbackStrict) an over-limit encode throws
 *         CallbackLimitError; in production a plain def refuses the same
 *         way (log + throw — there is no fallback) while a tokenArg def
 *         logs and falls back to a short-lived token;
 * - C2.2  data whose prefix IS registered but fails to decode, and data
 *         that matches nothing (the caller's answerExpired), get a short
 *         "button expired" toast, warn ONCE per unique data string, and
 *         never throw;
 * - C2.3  the allow-list and no-conv gates run in Bot.handleCallback, in
 *         one place, BEFORE dispatchCallback is called — the registry
 *         never re-checks;
 * - C2.4  exactly one answerCallbackQuery per dispatch: the first
 *         ctx.answer() wins, and a handler that throws or forgets to
 *         answer is still answered, so no spinner is left on the button.
 */
import { randomBytes } from "node:crypto";
import type { Bot } from "./bot.js";
import type { ConvKey } from "./conv.js";
import { tr } from "./i18n.js";
import { error, warn } from "./logger.js";
import type { Lang } from "./state.js";
import type { CallbackQuery } from "./telegram.js";

/** Telegram caps callback_data at 64 BYTES per button. */
export const CALLBACK_MAX_BYTES = 64;

/** How long tokenArg() tokens live. In-memory only — never persisted. */
export const TOKEN_TTL_MS = 24 * 3600_000;
/** Upper bound on live tokens (oldest dropped first). */
const TOKEN_MAP_CAP = 2048;
/** Token namespace marker: direct values may never start with it. */
const TOKEN_PREFIX = "~";
/** 12 base36 chars ≈ 60 bits — no collisions within the 24 h map. */
const TOKEN_LEN = 12;

/** Thrown when an encoder would produce more than CALLBACK_MAX_BYTES. */
export class CallbackLimitError extends Error {
  constructor(prefix: string, bytes: number) {
    super(`callback "${prefix}" would be ${bytes} bytes > ${CALLBACK_MAX_BYTES}`);
    this.name = "CallbackLimitError";
  }
}

// Strict mode (tests): over-limit encodes THROW instead of falling back.
let strict = false;
/** Tests flip this on; production leaves it off. */
export function setCallbackStrict(on: boolean): void {
  strict = on;
}

/** C2.2 toast — plain text (answerCallbackQuery has no parse mode). */
export const EXPIRED_TOAST = {
  vi: "⌛ Nút đã hết hạn — hãy gửi lại lệnh",
  en: "⌛ Button expired — please resend the command",
} as const;
/** C2.4 toast when a registered handler throws. */
export const ERROR_TOAST = {
  vi: "❌ Lỗi: nút không phản hồi",
  en: "❌ Error: the button failed",
} as const;

/**
 * Base context — built by the dispatcher (Bot.handleCallback) for every
 * registered handler. C2.3: the allow-list and no-conv gates already ran
 * before dispatchCallback, so a handler never needs to re-check them.
 */
export interface CallbackBase {
  /** The Bot — a thin adapter while the migration is incomplete. */
  bot: Bot;
  /** The tapped message's conversation (never undefined). */
  conv: ConvKey;
  /** message_id of the tapped message, when Telegram provided one. */
  messageId?: number;
  /** The tapper's language, for toasts. */
  lang: Lang;
}

/** What a registered handler receives: the base context + answer() (C2.4). */
export interface CallbackCtx extends CallbackBase {
  /**
   * Answer the callback query. First call wins; later calls are no-ops.
   * The dispatcher guarantees exactly one answer even if the handler
   * throws or never calls this.
   */
  answer(text?: string): void;
}

export type CallbackHandler<A> = (ctx: CallbackCtx, cb: CallbackQuery, args: A) => Promise<void> | void;

export interface CallbackDef<A> {
  /** The bare prefix — no trailing colon ("mdl", not "mdl:"). */
  prefix: string;
  /** Typed args → "prefix:arg:arg". Enforces the 64-byte cap (C1.3). */
  encode(args: A): string;
  /** "arg:arg" (the data after "prefix:") → typed args, or null = malformed. */
  decode(rest: string): A | null;
}

// ── encode helpers ──────────────────────────────────────────────────────────

/** The wire format can't round-trip these in a field: fail fast at encode. */
function field(prefix: string, v: string): string {
  if (v === "") throw new Error(`callback "${prefix}": empty field value`);
  if (v.includes(":")) throw new Error(`callback "${prefix}": field value may not contain ":" (${JSON.stringify(v)})`);
  return v;
}

/** C2.2: warn at most once per unique key (a stale button tapped 50× logs once). */
const warned = new Set<string>();
const WARN_CAP = 1024;
function warnOnce(key: string, what: string): void {
  if (warned.has(key)) return;
  if (warned.size >= WARN_CAP) warned.clear();
  warned.add(key);
  warn(`callback: ${what} (data="${key}")`);
}

// ── the short-lived token map (tokenArg fallback, C1.3) ────────────────────

const tokenTtl = { ms: TOKEN_TTL_MS };
interface TokenEntry {
  value: string;
  expiresAt: number;
}
// Keyed `${prefix}:${token}` so tokens can't be confused across prefixes.
const tokens = new Map<string, TokenEntry>();

/** 12 random base36 chars (≈60 bits of entropy). */
function randomToken(): string {
  for (;;) {
    let n = 0n;
    const b = randomBytes(12);
    for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
    const s = n.toString(36);
    if (s.length >= TOKEN_LEN) return s.slice(-TOKEN_LEN); // retry on a rare leading-zero run
  }
}

function mintToken(prefix: string, value: string): string {
  const now = Date.now();
  for (const [k, e] of tokens) if (e.expiresAt <= now) tokens.delete(k);
  while (tokens.size >= TOKEN_MAP_CAP) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
  let t = "";
  do {
    t = TOKEN_PREFIX + randomToken();
  } while (tokens.has(`${prefix}:${t}`));
  tokens.set(`${prefix}:${t}`, { value, expiresAt: now + tokenTtl.ms });
  return t;
}

function resolveToken(prefix: string, token: string): string | null {
  const key = `${prefix}:${token}`;
  const e = tokens.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    tokens.delete(key);
    return null;
  }
  return e.value;
}

/** Test knob: set the token TTL (no arg = back to TOKEN_TTL_MS). */
export function _setTokenTtlMsForTest(ms?: number): void {
  tokenTtl.ms = ms ?? TOKEN_TTL_MS;
}

// ── C1.1: defs, and the 64-byte cap wrapper (C1.3) ─────────────────────────

const LIMITED = Symbol("callbacks.limited-encode");
type LimitedDef<A> = CallbackDef<A> & { [LIMITED]: boolean };

/**
 * C1.1/C1.3: validate a def and wrap its encoder with the 64-byte cap.
 * Idempotent — a def that is already limited passes through untouched.
 * A wrapped encoder never returns an over-limit string: plain defs throw
 * CallbackLimitError (a warn log in production first); a tokenArg encoder
 * has already converted to a token before the wrapper sees it.
 */
export function defineCallback<A>(def: CallbackDef<A>): CallbackDef<A> {
  if (typeof def.prefix !== "string" || def.prefix === "" || def.prefix.includes(":")) {
    throw new Error(`invalid callback prefix ${JSON.stringify(def.prefix)} (want a bare token, no colon)`);
  }
  if (typeof def.encode !== "function" || typeof def.decode !== "function") {
    throw new Error(`callback "${def.prefix}": encode and decode must be functions`);
  }
  if ((def as LimitedDef<A>)[LIMITED]) return def;
  const limited = {
    prefix: def.prefix,
    decode: def.decode,
    encode: (args: A): string => {
      const out = def.encode(args);
      const bytes = Buffer.byteLength(out, "utf8");
      if (bytes > CALLBACK_MAX_BYTES) {
        if (!strict) warn(`callback "${def.prefix}" exceeds ${CALLBACK_MAX_BYTES} bytes (${bytes}) — refusing`);
        throw new CallbackLimitError(def.prefix, bytes);
      }
      return out;
    },
  };
  (limited as LimitedDef<A>)[LIMITED] = true;
  return limited;
}

/** C1.1: a prefix with no arguments — wire form "prefix:". */
export function simple(prefix: string): CallbackDef<undefined> {
  return defineCallback<undefined>({
    prefix,
    encode: () => `${prefix}:`,
    decode: (rest) => (rest === "" ? undefined : null),
  });
}

/** C1.1: exactly one string argument — wire form "prefix:arg". */
export function oneArg(prefix: string): CallbackDef<string> {
  return defineCallback<string>({
    prefix,
    encode: (v) => `${prefix}:${field(prefix, v)}`,
    decode: (rest) => (rest === "" ? null : rest),
  });
}

/**
 * C1.1: exactly n string arguments — wire form "prefix:a:b:…". Field
 * values may not be empty or contain ":" (the wire format can't
 * round-trip them).
 */
export function fields(prefix: string, n: number): CallbackDef<string[]> {
  if (n < 1) throw new Error(`callback "${prefix}": fields() needs at least 1 field`);
  return defineCallback<string[]>({
    prefix,
    encode: (args) => {
      if (!Array.isArray(args) || args.length !== n) {
        throw new Error(`callback "${prefix}": expected ${n} field(s), got ${Array.isArray(args) ? args.length : typeof args}`);
      }
      return `${prefix}:${args.map((v) => field(prefix, v)).join(":")}`;
    },
    decode: (rest) => {
      const parts = rest.split(":");
      return parts.length === n && parts.every((p) => p !== "") ? parts : null;
    },
  });
}

/**
 * C1.1/C1.3: a one-argument def whose value may exceed the 64-byte cap
 * (full paths, session ids…). An over-limit value is stored in the
 * short-lived in-memory token map and the button carries a short token;
 * in strict mode the encode throws instead of falling back. Decode
 * resolves the token; an expired or unknown token is null → the C2.2
 * "button expired" toast, not a crash.
 */
export function tokenArg(prefix: string): CallbackDef<string> {
  return defineCallback<string>({
    prefix,
    encode: (v) => {
      const f = field(prefix, v);
      if (f.startsWith(TOKEN_PREFIX)) {
        throw new Error(`callback "${prefix}": value may not start with "${TOKEN_PREFIX}" (the token namespace)`);
      }
      const direct = `${prefix}:${f}`;
      if (Buffer.byteLength(direct, "utf8") <= CALLBACK_MAX_BYTES) return direct;
      if (strict) throw new CallbackLimitError(prefix, Buffer.byteLength(direct, "utf8"));
      warnOnce(prefix, `value is ${Buffer.byteLength(f, "utf8")} bytes > ${CALLBACK_MAX_BYTES} — using a short-lived token`);
      return `${prefix}:${mintToken(prefix, f)}`;
    },
    decode: (rest) => {
      if (rest.startsWith(TOKEN_PREFIX)) return resolveToken(prefix, rest);
      return rest === "" ? null : rest;
    },
  });
}

// ── C1.1/C1.2: the registry ────────────────────────────────────────────────

// `any` is deliberate here: the registry is heterogeneous (one entry per
// prefix, each with its own arg type A); the public API stays fully typed.
interface Entry {
  def: CallbackDef<any>;
  handler: CallbackHandler<any>;
  owner: string;
}
const registry = new Map<string, Entry>();

/**
 * C1.1/C1.2: declare a prefix once, with its handler and an owner name
 * (for error messages and the T6 startup self-check). Registering the
 * same prefix again throws, naming BOTH owners.
 */
export function registerCallback<A>(def: CallbackDef<A>, handler: CallbackHandler<A>, owner: string): void {
  const existing = registry.get(def.prefix);
  if (existing) {
    throw new Error(`duplicate callback prefix "${def.prefix}": already owned by "${existing.owner}", re-registered by "${owner}"`);
  }
  registry.set(def.prefix, { def, handler, owner });
}

/** All registered prefixes, sorted (for the T6 startup self-check). */
export function registeredPrefixes(): string[] {
  return [...registry.keys()].sort();
}

/** The owner string of a registered prefix, if any. */
export function callbackOwner(prefix: string): string | undefined {
  return registry.get(prefix)?.owner;
}

/** Test-only: drop all registrations (the registry is module-level). */
export function _clearCallbacksForTest(): void {
  registry.clear();
}

/** Test-only: reset the warn-once set. */
export function _resetWarnOnceForTest(): void {
  warned.clear();
}

// ── C2.1/C2.2/C2.4: dispatch ───────────────────────────────────────────────

/**
 * C2.1/C3.2: try to dispatch `cb` through the registry. Returns true iff
 * the callback's prefix is registered — in which case the handler ran and
 * the query was answered EXACTLY once (C2.4). Returns false → the caller
 * falls through to the legacy startsWith chain. A registered prefix whose
 * data fails to decode is still "handled" here: it gets the C2.2 expired
 * toast, not a fall-through to the chain.
 */
export async function dispatchCallback(ctx: CallbackBase, cb: CallbackQuery): Promise<boolean> {
  const data = cb.data ?? "";
  const colon = data.indexOf(":");
  const entry = colon === -1 ? undefined : registry.get(data.slice(0, colon));
  if (!entry) return false;

  const rest = data.slice(colon + 1);
  let args: unknown;
  try {
    args = entry.def.decode(rest);
  } catch (e) {
    args = null; // a throwing decode is malformed, not fatal (C2.2: shall not throw)
    warn(`callback "${entry.def.prefix}": decode threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // C2.4: exactly one answer no matter what the handler does.
  let answered: Promise<void> | undefined;
  const answer = (text?: string): void => {
    if (answered) return;
    answered = ctx.bot.tg.answerCallbackQuery(cb.id, text).then(
      () => undefined,
      () => undefined, // answerCallbackQuery swallows expired/duplicate; belt and suspenders
    );
  };

  if (args === null) {
    warnOnce(data, `decode failed (owner: ${entry.owner})`);
    answer(tr(ctx.lang, EXPIRED_TOAST.vi, EXPIRED_TOAST.en));
    await answered;
    return true;
  }

  const full: CallbackCtx = { ...ctx, answer };
  try {
    await entry.handler(full, cb, args);
  } catch (e) {
    error(`callback "${entry.def.prefix}" handler (owner: ${entry.owner}) threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    answer(tr(ctx.lang, ERROR_TOAST.vi, ERROR_TOAST.en)); // no-op if the handler already answered
  }
  if (!answered) answer(); // the handler never answered → silent answer, no spinner
  await answered;
  return true;
}

/**
 * C2.2 (fallback): the dispatcher's "matched nothing" answer — a short
 * "button expired" toast plus a warn ONCE per unique data string. Never
 * throws. Bot.handleCallback calls this instead of answering silently.
 */
export async function answerExpired(bot: Bot, cb: CallbackQuery, lang: Lang, data: string, reason = "no handler matched"): Promise<void> {
  warnOnce(data, reason);
  await bot.tg.answerCallbackQuery(cb.id, tr(lang, EXPIRED_TOAST.vi, EXPIRED_TOAST.en));
}
