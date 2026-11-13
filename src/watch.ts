/**
 * Pure state machine for the /watch live card (docs/sdd/watch.md, task W1).
 * No I/O and no bot-code imports: the caller (src/bot.ts, task W3) owns one
 * WatchState per conversation, feeds it the decoupled events below (mapped
 * from OpenCode's session events), and performs the returned `edit` via
 * `editMessageTextStrict`. Mirrors the src/stream.ts convention: time is
 * injected, so everything is unit-testable (scripts/test-watch.ts).
 *
 * The card is ONE message, edited in place:
 *   - working: state + running-turn elapsed time, the current tool step (the
 *     same short label as the activity line), the last user prompt (200 chars)
 *     and the ~1,200-char ESCAPED tail of the assistant text being written.
 *   - idle: the last 6 messages, exactly as /history renders them (W1.4).
 *   - final (done / failed / stopped): the outcome and the turn's duration
 *     only — the answer is never repeated (the normal relay path delivers it).
 *
 * Update rules (W2.1-W2.4): at most one edit per interval, an edit is emitted
 * only when the rendered text changed, and a Telegram flood-control answer
 * doubles the interval (up to 10 s) while honoring retry_after — the same
 * shape as the streaming preview's backoff.
 */
import type { Lang } from "./state.js";
import { esc, trunc, stripTags } from "./format.js";
import { tr } from "./i18n.js";

/** Card states, in lifecycle order. */
export type WatchPhase = "working" | "idle" | "done" | "failed" | "stopped";

/** One row of the idle card — a session message, extracted like /history does. */
export interface HistoryLine {
  /** The message's `type` ("user", "assistant"; anything else renders "· <type>"). */
  type: string;
  /** Raw text: the user's text, or the assistant's text parts joined with "\n". */
  text: string;
}

export interface WatchState {
  sessionID: string;
  lang: Lang;
  phase: WatchPhase;
  /** When the watch started, ms. */
  startedAt: number;
  /** The running turn's start, ms; 0 = no turn in flight. */
  turnStartedAt: number;
  /** The turn's end, ms; 0 while running. */
  turnEndedAt: number;
  /** Failure text (phase "failed"); "" otherwise. */
  error: string;
  /** Current tool step label (e.g. "📖 Đang đọc src/bot.ts"); "" = thinking. */
  toolLabel: string;
  /** Assistant text accumulated for the current turn (tail-capped). */
  text: string;
  /** Last user prompt, raw (render truncates to WATCH_PROMPT_CHARS). */
  lastPrompt: string;
  /** Snapshot of the last messages for the idle card. */
  history: HistoryLine[];
  // ── throttle / backoff machinery (W2.1-W2.4) ──
  /** The configured base interval, ms. */
  baseIntervalMs: number;
  /** Current interval, ms (grows with backoff, resets on a successful edit). */
  intervalMs: number;
  /** When the card was last edited, ms; 0 = never. */
  lastEditedAt: number;
  /** Earliest ms at which the next edit may go out (flood floor); 0 = none. */
  earliestEditAt: number;
  /** The last rendered text actually sent to Telegram (change detection). */
  lastRendered: string;
}

/** How a turn ended. "stopped" = interrupted (user stop / shutdown). */
export type WatchOutcome = "done" | "failed" | "stopped";

/** Decoupled events the reducer folds into the state (W3 maps OpenCode events to these). */
export type WatchEvent =
  | { kind: "turn-start"; now: number; /** Prompt that started the turn (raw). */ prompt?: string }
  | { kind: "text-delta"; now: number; /** One `session.text.delta` chunk. */ text: string }
  | { kind: "tool-step"; now: number; /** Activity-line label; "" = no tool running (thinking). */ label: string }
  | { kind: "turn-end"; now: number; outcome: WatchOutcome; /** `error.message` when outcome is "failed". */ error?: string };

export interface WatchEdit {
  /** The full HTML to send via editMessageTextStrict. */
  text: string;
  /** "final" = the turn ended; no further updates will follow (W3.1). */
  reason: "update" | "final";
}

export interface WatchResult {
  state: WatchState;
  /** Set when the caller should edit the card. */
  edit?: WatchEdit;
}

// ── limits ────────────────────────────────────────────────────────────────────
/** Telegram's max message length (after parsing); the card must stay under it. */
export const WATCH_CARD_LIMIT = 4096;
/** How much of the assistant text the working card shows (its tail). */
export const WATCH_TAIL_CHARS = 1200;
/** The last-user-prompt line length. */
export const WATCH_PROMPT_CHARS = 200;
/** Backoff ceiling (W2.4), same as the streaming preview. */
export const WATCH_MAX_INTERVAL_MS = 10_000;
/** Accepted interval range (W2.1). */
export const WATCH_MIN_INTERVAL_MS = 2000;
export const WATCH_MAX_INTERVAL_MS_1TO1 = 5000;
/** The state's text buffer keeps only this much tail (render uses ≤ 1,200). */
const TEXT_CAP = 4_000;
/** Safety margin kept free of the 4,096 cap. */
const LIMIT_MARGIN = 64;

/**
 * W2.1 + W2.3: clamp the configured interval into [2000, 5000], and floor it
 * at 5000 for group conversations (stricter edit limits than 1:1).
 */
export function clampWatchInterval(ms: number, isGroup: boolean): number {
  const c = Math.min(Math.max(Math.round(ms), WATCH_MIN_INTERVAL_MS), WATCH_MAX_INTERVAL_MS_1TO1);
  return isGroup ? Math.max(c, WATCH_MAX_INTERVAL_MS_1TO1) : c;
}

/** "42s" / "1m 23s" (floored; negative → 0). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The last ~n chars of `text`, escaped, and GUARANTEED ≤ maxEscaped chars
 * even when escaping expands the tail (e.g. text full of "<"). A cut that
 * lands inside an entity is pulled back to the entity's start so the card
 * never contains a dangling "&amp".
 */
function escTail(text: string, n: number, maxEscaped: number): string {
  const rawCut = text.length > n;
  const raw = rawCut ? text.slice(-n) : text;
  let e = esc(raw);
  let escCut = false;
  if (e.length > maxEscaped) {
    e = e.slice(-maxEscaped);
    const amp = e.lastIndexOf("&");
    if (amp !== -1 && !e.slice(amp + 1).includes(";")) e = e.slice(0, amp);
    escCut = true;
  }
  return rawCut || escCut ? "…" + e : e;
}

/**
 * Render the card as Telegram HTML (always under WATCH_CARD_LIMIT).
 * `now` is injected: the working header shows the turn's elapsed time.
 */
export function renderWatch(state: WatchState, lang: Lang, now: number): string {
  const header = (icon: string, label: string, durMs?: number): string =>
    durMs === undefined ? `<b>${icon} ${label}</b>` : `<b>${icon} ${label} · ${formatElapsed(durMs)}</b>`;

  if (state.phase === "working") {
    const lines: string[] = [
      header("⏳", tr(lang, "Đang chạy", "Working"), state.turnStartedAt > 0 ? now - state.turnStartedAt : undefined),
    ];
    if (state.toolLabel) lines.push(esc(state.toolLabel));
    if (state.lastPrompt) lines.push(`👤 ${esc(trunc(stripTags(state.lastPrompt), WATCH_PROMPT_CHARS))}`);
    // Everything above is bounded (header ~40, tool ≤ ~120, prompt ≤ 604 escaped);
    // give the text tail whatever of the limit remains.
    const overhead = lines.join("\n").length + 1;
    const budget = Math.max(0, WATCH_CARD_LIMIT - LIMIT_MARGIN - overhead);
    if (state.text) {
      const t = escTail(state.text, WATCH_TAIL_CHARS, budget);
      if (t) lines.push(t);
    }
    return lines.join("\n");
  }

  if (state.phase === "idle") {
    // W1.4: the last messages, exactly as /history renders them, marked idle.
    const lines: string[] = [
      `<b>💤 ${tr(lang, "Đang nghỉ", "Idle")}</b>`,
      `<b>${tr(lang, "Tin nhắn gần đây", "Recent messages")}</b>`,
    ];
    for (const h of state.history) {
      if (h.type === "user") lines.push(`👤 ${esc(trunc(stripTags(h.text), 300))}`);
      else if (h.type === "assistant") lines.push(`🤖 ${esc(trunc(stripTags(h.text), 400))}`);
      else lines.push(`· ${esc(h.type)}`);
    }
    // Pathological line sets (every line full of HTML chars) could still bust
    // the limit; drop the OLDEST history lines until it fits — the newest win.
    let out = lines.join("\n");
    while (out.length > WATCH_CARD_LIMIT && lines.length > 2) {
      lines.splice(2, 1); // the two header lines are always kept
      out = lines.join("\n");
    }
    return out;
  }

  // Final states — outcome + duration only, never the answer (W3.1).
  const durMs = state.turnStartedAt > 0 && state.turnEndedAt >= state.turnStartedAt ? state.turnEndedAt - state.turnStartedAt : undefined;
  if (state.phase === "done") return header("✅", tr(lang, "Hoàn tất", "Done"), durMs);
  if (state.phase === "failed") {
    const lines = [header("❌", tr(lang, "Thất bại", "Failed"), durMs)];
    if (state.error) lines.push(esc(trunc(state.error, 200)));
    return lines.join("\n");
  }
  return header("⏹", tr(lang, "Đã dừng", "Stopped"), durMs);
}

/**
 * Create a fresh watch. `lastRendered` is seeded with the initial render so
 * the first event only edits when something actually changed (W2.2).
 * `turn` is passed when a turn is already in flight at post time.
 */
export function createWatch(o: {
  sessionID: string;
  lang: Lang;
  now: number;
  intervalMs: number;
  history?: HistoryLine[];
  prompt?: string;
  turn?: { startedAt: number; /** Text accumulated so far this turn (the tail is shown). */ text?: string };
}): WatchState {
  const s: WatchState = {
    sessionID: o.sessionID,
    lang: o.lang,
    phase: o.turn ? "working" : "idle",
    startedAt: o.now,
    turnStartedAt: o.turn?.startedAt ?? 0,
    turnEndedAt: 0,
    error: "",
    toolLabel: "",
    text: (o.turn?.text ?? "").slice(-TEXT_CAP),
    lastPrompt: o.prompt ?? "",
    history: o.history ?? [],
    baseIntervalMs: o.intervalMs,
    intervalMs: o.intervalMs,
    lastEditedAt: 0,
    earliestEditAt: 0,
    lastRendered: "",
  };
  s.lastRendered = renderWatch(s, o.lang, o.now);
  return s;
}

/** Fold one event into the state; emits an edit when the card should go out. */
export function onWatchEvent(prev: WatchState, ev: WatchEvent): WatchResult {
  const frozen = prev.phase === "done" || prev.phase === "failed" || prev.phase === "stopped";
  const s: WatchState = { ...prev };

  switch (ev.kind) {
    case "turn-start": {
      // A frozen card never unfreezes — "Watch again" starts a NEW card (W3.3).
      if (frozen) return { state: prev };
      s.phase = "working";
      s.turnStartedAt = ev.now;
      s.turnEndedAt = 0;
      s.error = "";
      s.toolLabel = "";
      s.text = "";
      if (ev.prompt !== undefined) s.lastPrompt = ev.prompt;
      return maybeEdit(s, ev.now);
    }
    case "text-delta": {
      // Deltas only make sense for the tracked turn; a stale one (e.g. after a
      // missed execution.started, recovered by the W2.5 poll) is dropped.
      if (s.phase !== "working") return { state: prev };
      s.text += ev.text;
      if (s.text.length > TEXT_CAP * 2) s.text = s.text.slice(-TEXT_CAP);
      return maybeEdit(s, ev.now);
    }
    case "tool-step": {
      if (s.phase !== "working") return { state: prev };
      s.toolLabel = ev.label;
      return maybeEdit(s, ev.now);
    }
    case "turn-end": {
      if (frozen) return { state: prev }; // a second final must not re-edit
      s.phase = ev.outcome;
      s.turnEndedAt = ev.now;
      s.error = ev.outcome === "failed" ? (ev.error ?? "") : "";
      s.toolLabel = "";
      s.text = "";
      // W3.1: the final edit is NOT throttled — it must land, and then the
      // watch stops updating.
      const text = renderWatch(s, s.lang, ev.now);
      s.lastRendered = text;
      s.lastEditedAt = ev.now;
      return { state: s, edit: { text, reason: "final" } };
    }
  }
}

/**
 * Throttle (W2.1) + change detection (W2.2): emit an edit only when the
 * interval has elapsed, the flood floor is passed, and the render changed.
 * Emits stamp lastEditedAt optimistically; onEditSucceeded/onEditFailedFlood
 * reconcile it with what Telegram actually did.
 */
function maybeEdit(s: WatchState, now: number): WatchResult {
  if (now - s.lastEditedAt < s.intervalMs) return { state: s };
  if (now < s.earliestEditAt) return { state: s };
  const text = renderWatch(s, s.lang, now);
  if (text === s.lastRendered) return { state: s };
  s.lastEditedAt = now;
  return { state: s, edit: { text, reason: "update" } };
}

/** The edit went out — stamp the time, record the text, reset the backoff. */
export function onEditSucceeded(state: WatchState, sentText: string, now: number): WatchState {
  return { ...state, lastEditedAt: now, earliestEditAt: 0, intervalMs: state.baseIntervalMs, lastRendered: sentText };
}

/**
 * W2.4: Telegram answered with a flood-control error — honor retry_after as a
 * floor for the next edit and double the interval, up to 10 s (as the preview
 * does). The failed edit did NOT update lastEditedAt/lastRendered.
 */
export function onEditFailedFlood(state: WatchState, retryAfterSec: number, now: number): WatchState {
  const ra = Math.max(0, Math.floor(retryAfterSec)) * 1000;
  return {
    ...state,
    intervalMs: Math.min(state.intervalMs * 2, WATCH_MAX_INTERVAL_MS),
    earliestEditAt: now + ra,
  };
}
