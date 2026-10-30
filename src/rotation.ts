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
