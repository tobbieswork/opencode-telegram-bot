/**
 * Manager session rotation: detect when the Manager's post-summarization
 * context FLOOR has drifted high, and rotate it to a fresh session carrying
 * over essential state (project memory + notes + a short handoff brief).
 *
 * Why the FLOOR (not the peak): Magic Context caps the peak, but the baseline
 * AFTER each summarization creeps up day over day (measured ~16K/day on the
 * Manager). The floor — the MIN sent-context the session dropped to over the
 * last 24h — is that persistent baseline. When it drifts high, a fresh session
 * resets it without losing important context: memory + notes persist by design,
 * and a short handoff brief carries the recent thread (see rotateHandoff).
 *
 * Pure logic only (testable like usage.ts / reminders.ts — no I/O). The network
 * side (listMessages, promptAndWait, session create) lives in bot.ts as thin
 * wrappers over these functions.
 */

/** How far back the floor is measured, in ms (24h — one day of drift). */
export const ROTATION_WINDOW_MS = 24 * 3600 * 1000;

/**
 * The sent-context of ONE assistant message: tokens.input + tokens.cache.read.
 *
 * This is the FLOOR measure (the persistent baseline): `input` is the
 * non-cached part of the prompt and `cache.read` the part served from the
 * provider's cache — together they are the context that PERSISTS across turns.
 * `cache.write` is deliberately EXCLUDED: it is transient (only large on the
 * single step that builds the cache), so a write-heavy step would not represent
 * the baseline. This is narrower than /usage's `input + read + write` (which
 * measures the FULL current context) — exactly what a floor wants.
 *
 * Handles both the flat message shape and the info-wrapped one.
 */
export function sentContext(m: any): number {
  const t = m?.info?.tokens ?? m?.tokens;
  if (!t) return 0;
  const input = typeof t.input === "number" ? t.input : 0;
  const read = typeof t.cache?.read === "number" ? t.cache.read : 0;
  return input + read;
}

/** A message's creation time in ms (flat or info-wrapped shape). */
function msgTime(m: any): number {
  return m?.info?.time?.created ?? m?.time?.created ?? 0;
}

/** True for an assistant message (flat or info-wrapped). */
function isAssistant(m: any): boolean {
  const info = m?.info ?? m;
  return info?.type === "assistant" || info?.role === "assistant";
}

/**
 * The manager session's FLOOR over the last `windowMs` (default 24h): the MIN
 * of sent-context across assistant messages created in that window. Returns 0
 * when there are no assistant messages in the window (a fresh session has no
 * floor yet — nothing to rotate).
 */
export function managerFloorFromMessages(
  msgs: any[],
  now = Date.now(),
  windowMs = ROTATION_WINDOW_MS,
): number {
  const cutoff = now - windowMs;
  let min = Number.POSITIVE_INFINITY;
  for (const m of msgs ?? []) {
    if (!isAssistant(m)) continue;
    const t = msgTime(m);
    if (t < cutoff || t > now) continue;
    const sc = sentContext(m);
    if (sc > 0 && sc < min) min = sc;
  }
  return Number.isFinite(min) ? min : 0;
}

// ── M2: handoff pass ─────────────────────────────────────────────────────────

/** Max words for the handoff brief the old manager returns. */
export const HANDOFF_BRIEF_WORDS = 300;
/** Per-session instruction key carrying the handoff brief into the NEW session. */
export const ROTATION_KEY = "tgbot.rotation";

/** The handoff brief carried into a fresh manager session (instruction entry). */
export interface RotationBrief {
  /** The session id the fresh one replaces. */
  rotatedFrom: string;
  /** epoch ms the rotation happened. */
  rotatedAt: number;
  /** The old manager's handoff brief (≤ HANDOFF_BRIEF_WORDS words). */
  brief: string;
}

/** Trim `s` and normalize whitespace to single spaces, keeping at most `max` words. */
export function capWords(s: string, max: number): string {
  return s.trim().split(/\s+/).slice(0, max).join(" ");
}

/**
 * The handoff instruction, sent as a prompt to the OLD manager session. Two
 * directives: (1) save what must not be lost into the manager's OWN persistent
 * store (Magic Context memories + notes — inherited by the new session),
 * (2) reply with a short handoff brief. The brief is what the fresh manager
 * reads first; memories/notes persist regardless, so the handoff degrades
 * gracefully if the old session dies mid-pass.
 */
export function rotationInstruction(dir: string, briefWords = HANDOFF_BRIEF_WORDS): string {
  return (
    "[Rotation handoff] This manager session is about to be replaced by a fresh one. " +
    "Before you reply: (1) save anything that must not be lost into your own persistent " +
    "memory (ctx_memory) and notes (ctx_note) — architectural facts, config values, " +
    "constraints, pending intentions; the new session inherits these automatically. " +
    `Then reply with a handoff brief of at most ${briefWords} words covering: ` +
    `(a) the working directory ${dir} and the current git branch, ` +
    "(b) current task state — what is done vs still pending, " +
    "(c) recent decisions and their reasoning, " +
    "(d) open questions or risks. " +
    "Be concise and factual — it is the first thing the replacement session reads."
  );
}

/** I/O seam for runRotationHandoff: the only network call it makes. */
export interface RotationHandoffDeps {
  /** Prompt the OLD session, block until idle, return its reply text. */
  prompt: (sessionID: string, text: string) => Promise<{ reply: string }>;
}

/**
 * Run the handoff pass on the OLD manager session and return the (capped)
 * brief. Returns "" when the old session yields no brief (interrupted / call
 * failed) — the rotation still proceeds, because memory + notes already carry
 * the durable state.
 */
export async function runRotationHandoff(
  oldSID: string,
  dir: string,
  deps: RotationHandoffDeps,
  briefWords = HANDOFF_BRIEF_WORDS,
): Promise<string> {
  let reply = "";
  try {
    reply = (await deps.prompt(oldSID, rotationInstruction(dir, briefWords))).reply;
  } catch {
    /* old session error/interrupt — degrade: rely on memory + notes */
  }
  return capWords(reply, briefWords);
}
