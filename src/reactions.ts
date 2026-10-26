/**
 * Pure helpers for the Telegram reaction UX (flag OPENCODE_TG_REACT, used by
 * the Bot in bot.ts). A user reacts to a message the bot indexed; the emoji
 * decides the action. Deliberately framework-free and side-effect-free so the
 * decisions are unit-testable (see scripts/test-reactions.ts), like reminders.ts.
 */

/** Emojis with a wired-up action; anything else is a no-op. */
export const REACTION_SPAWN = "🚀";
export const REACTION_APPROVE = "👍";
export const REACTION_REJECT = "👎";
/** Bot body language (the bot reacting, never an action). */
export const REACTION_THINK = "🤔";
export const REACTION_CELEBRATE = "🎉";
export const REACTION_FAIL = "👎";

/** What a reaction on an indexed message can do. */
export type ReactionAction = "spawn" | "approve" | "reject";

/** The action a reaction emoji maps to, or null for a no-op emoji. */
export function classifyAction(emoji: string): ReactionAction | null {
  if (emoji === REACTION_SPAWN) return "spawn";
  if (emoji === REACTION_APPROVE) return "approve";
  if (emoji === REACTION_REJECT) return "reject";
  return null;
}

/** Cap on the machine-wide message index (oldest ts dropped first). */
export const REACT_INDEX_CAP = 500;
/** Cap on the (message,emoji) reacted-once set. */
export const REACTED_CAP = 500;
/** Max stored text per index entry (the 🚀 spawn takes the stored text). */
export const REACT_TEXT_MAX = 4000;

/**
 * The key of a message in the index: `${chatId}:${messageId}`. A
 * `message_reaction` update carries ONLY chat.id + message_id (no topic
 * info), so this pair is all we can key on — the bot-maintained index
 * supplies the rest (conv, purpose, text).
 */
export function indexKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * The key of a (message,emoji) pair in the "reacted once" set. One pair may
 * trigger at most ONCE ever — the dedup key a reaction is marked with before
 * any async work, so a doubled event (or a second tap of the same emoji)
 * can't fire the action twice.
 */
export function reactedKey(chatId: number, messageId: number, emoji: string): string {
  return `${chatId}:${messageId}:${emoji}`;
}

/** True when this (message,emoji) has already fired an action. */
export function alreadyReacted(
  reacted: Record<string, true> | undefined,
  chatId: number,
  messageId: number,
  emoji: string,
): boolean {
  return Boolean(reacted?.[reactedKey(chatId, messageId, emoji)]);
}

/**
 * Trim a message index to `cap` entries, dropping the OLDEST (by ts) first.
 * Returns the input unchanged when it is already under the cap, so a save
 * that adds nothing doesn't rewrite the map.
 */
export function pruneIndex<T extends { ts: number }>(
  msgIndex: Record<string, T>,
  cap: number = REACT_INDEX_CAP,
): Record<string, T> {
  const keys = Object.keys(msgIndex);
  if (keys.length <= cap) return msgIndex;
  const drop = new Set(
    [...keys].sort((a, b) => msgIndex[a].ts - msgIndex[b].ts).slice(0, keys.length - cap),
  );
  const out: Record<string, T> = {};
  for (const k of keys) if (!drop.has(k)) out[k] = msgIndex[k];
  return out;
}

/**
 * Trim a "reacted once" set to `cap` keys, dropping the OLDEST (insertion
 * order — plain `true` values carry no timestamp) first.
 */
export function pruneReacted(reacted: Record<string, true>, cap: number = REACTED_CAP): Record<string, true> {
  const keys = Object.keys(reacted);
  if (keys.length <= cap) return reacted;
  const keep = new Set(keys.slice(-cap));
  const out: Record<string, true> = {};
  for (const k of keys) if (keep.has(k)) out[k] = true;
  return out;
}

/**
 * Pure approve decision for a 👍 on an indexed message:
 *  - purpose must be a worker-done report (anything else: no-op),
 *  - the worker must not be busy (running/waiting) — then it stays and we
 *    just tell the user it is still running.
 */
export type ApproveDecision = "approve" | "busy" | "invalid";
export function decideApprove(purpose: string | undefined, workerBusy: boolean): ApproveDecision {
  if (purpose !== "worker-done") return "invalid";
  if (workerBusy) return "busy";
  return "approve";
}

/**
 * A valid worker name for a 🚀 spawn, derived from the message text:
 * lower-cased, non-alphanumerics collapsed to dashes, max 24 chars — shaped
 * to the orchestrator's NAME_RE (`[a-z0-9][a-z0-9-]{0,23}`). Unicode (e.g.
 * Vietnamese) collapses to the ASCII letters it contains. Falls back to
 * `fallback` when nothing usable is left.
 */
export function spawnNameFromText(text: string, fallback = "task"): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9]/.test(slug)) return fallback;
  slug = slug.replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Pick a unique worker name for a 🚀 spawn: the base name, or `<base>-2`,
 * `<base>-3`, … The base is truncated so the suffixed name stays within the
 * 24-char NAME_RE limit (mirroring recovery.ts' respawnName truncation).
 * Returns undefined when every candidate up to `-9` is taken.
 */
export function uniqueSpawnName(base: string, isTaken: (name: string) => boolean): string | undefined {
  if (!isTaken(base)) return base;
  for (let i = 2; i <= 9; i++) {
    const name = `${base.slice(0, 21)}-${i}`;
    if (!isTaken(name)) return name;
  }
  return undefined;
}
