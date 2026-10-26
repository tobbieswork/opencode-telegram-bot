/**
 * Pure state machine for Telegram's LIVE streaming draft (Bot API 10.1+
 * `sendMessageDraft`). No I/O and no imports of bot code — the caller
 * (src/bot.ts) owns one `DraftState` per conversation, feeds it OpenCode's
 * `session.text.delta` and tool-start events, and sends back any returned
 * `DraftAction` via `Telegram.sendMessageDraft`.
 *
 * A *part* is one contiguous run of streamed text; a new part begins after a
 * tool call. Each part gets its own draft_id, and a tool call temporarily
 * replaces the draft text with `""` (the client renders a "Thinking…"
 * placeholder). Drafts are ephemeral (30 s) and are cleared automatically when
 * the bot sends the final regular message, so this is a pure preview layer —
 * the final-reply path is untouched.
 */

export interface DraftState {
  /** Identity of the text part (segment) currently being streamed. */
  partID: string;
  /** draft_id of the active draft (always non-zero). */
  draftID: number;
  /** Text accumulated for the current part (grows as deltas arrive). */
  text: string;
  /** ms timestamp of the last draft sent; `0` = nothing sent yet. */
  lastSentAt: number;
  /**
   * Remaining preview updates this turn may still send (edit transport is
   * rate-limited per chat, so a finite budget prevents a 3-minute turn from
   * storming `editMessageText`). `Infinity` = unlimited (draft transport).
   */
  editsLeft: number;
}

/** Edit-transport preview updates per turn (group chats, ~3s throttle). */
export const EDIT_BUDGET = 20;

/**
 * Is this conversation a 1:1 user chat (chat_id > 0)? Only 1:1 peers accept
 * `sendMessageDraft` (groups reject with `TEXTDRAFT_PEER_INVALID`), so the
 * bot uses the ephemeral-draft transport here and the self-editing-message
 * transport in groups.
 */
export function isDmConv(conv: string): boolean {
  return Number(conv.split(":")[0]) > 0;
}

/** A single draft update to send. `text === ""` → the client's "Thinking…" placeholder. */
export interface DraftAction {
  draftID: number;
  text: string;
}

/** Telegram caps draft text at 4096 chars after entity parsing. */
const DRAFT_TEXT_LIMIT = 4096;

/**
 * Last `n` characters of `t` (a no-op when shorter). A reply longer than the
 * limit shows its TAIL — where the newest tokens land — instead of its head.
 * Operates on UTF-16 code units (`String.length`/`slice`), per the spec.
 */
function tail(t: string, n: number): string {
  return t.length > n ? t.slice(-n) : t;
}

/**
 * Next draft_id: a monotonic increment from `prev` (or from 1 when there is no
 * previous id). Always non-zero — the API rejects `draft_id: 0`.
 */
export function newDraftID(prev?: number): number {
  return (prev ?? 0) + 1;
}

/**
 * Fold one streamed text delta into the draft state.
 *
 * A delta for a part we haven't seen yet (`state === null` or the part id
 * changed) starts a FRESH draft: a new draft_id (so the previous part's text
 * is not carried over) and `lastSentAt = 0` (so the very first delta of the
 * part emits immediately, unthrottled). Within a part, deltas accumulate into
 * `text` and are emitted at most once per `throttleMs` window, sending only the
 * last `DRAFT_TEXT_LIMIT` chars.
 */
export function onTextDelta(
  state: DraftState | null,
  partID: string,
  delta: string,
  now: number,
  throttleMs = 1500,
  maxEdits: number = Infinity,
): { state: DraftState; action?: DraftAction } {
  const fresh = state === null || state.partID !== partID;
  const s: DraftState = fresh
    ? { partID, draftID: newDraftID(state?.draftID), text: "", lastSentAt: 0, editsLeft: maxEdits }
    : { ...state };
  s.text += delta;
  if (s.editsLeft > 0 && now - s.lastSentAt >= throttleMs) {
    s.lastSentAt = now;
    s.editsLeft -= 1;
    return { state: s, action: { draftID: s.draftID, text: tail(s.text, DRAFT_TEXT_LIMIT) } };
  }
  return { state: s };
}

/**
 * Handle a tool starting. When there is visible draft text, replace it with
 * `""` (the "Thinking…" placeholder) using the SAME draft_id — so the client
 * animates the transition rather than swapping drafts. Throttled like text so
 * a burst of tool starts doesn't storm the API. The state is otherwise kept
 * as-is: the next text delta arrives under a new part id and starts a fresh
 * draft, so the stale `text` is never re-sent.
 */
export function onToolStart(
  state: DraftState | null,
  now: number,
  throttleMs = 1500,
): { state: DraftState | null; action?: DraftAction } {
  if (state && state.text.length > 0 && state.editsLeft > 0 && now - state.lastSentAt >= throttleMs) {
    const s: DraftState = { ...state, lastSentAt: now, editsLeft: state.editsLeft - 1 };
    return { state: s, action: { draftID: state.draftID, text: "" } };
  }
  return { state };
}
