/**
 * Scratchpad notes (`/note`): while the agent is busy the user can jot down
 * information that must not be lost. The note is injected into the model's
 * system context (an OpenCode instruction entry) at the start of the next
 * user-initiated turn and retires automatically at the start of the turn
 * after that — so a note is visible for exactly one turn, no manual cleanup.
 *
 * Stage machine (all pure; wiring lives in bot.ts / orchestrator.ts):
 *   /note          → stage "pending"   (not yet visible to the model)
 *   turn start     → stage "shown"     (entry PUT so the model sees it this turn)
 *   next turn start→ cleared           (entry removed; the model already saw it)
 * A new /note while "shown" re-arms to "pending", so notes written during the
 * visible turn survive to the next one (the old note is shown once more —
 * harmless).
 */

export type NotesStage = "pending" | "shown";

/** The two ChatState fields this module manages (kept structural, no import cycle). */
export interface NoteState {
  notes?: string;
  notesStage?: NotesStage;
}

/** Notes are capped to keep system context small; the oldest characters are trimmed. */
export const NOTE_MAX_CHARS = 4000;

/** Append one note line (local HH:MM-prefixed) and re-arm the stage to "pending". */
export function appendNote(state: NoteState, text: string, now: number): NoteState {
  const line = `- ${new Date(now).toTimeString().slice(0, 5)}: ${text.trim()}`;
  const next = state.notes ? `${state.notes}\n${line}` : line;
  return { ...state, notes: next.length > NOTE_MAX_CHARS ? next.slice(-NOTE_MAX_CHARS) : next, notesStage: "pending" };
}

/** Human-facing view for `/note` (no argument); null when there are no notes. */
export function showNotes(state: NoteState): string | null {
  return state.notes || null;
}

/** The instruction-entry value: self-describing, so the model knows what to do with it. */
export function noteEntryText(notes: string): string {
  return (
    "Ghi chú của người dùng (viết bằng /note khi agent đang bận). " +
    "Đọc và xử lý theo nội dung; xác nhận ngắn gọn 1 dòng ở đầu phản hồi.\n" + notes
  );
}

export interface NotePrep {
  state: NoteState;
  /** PUT the instruction entry to this value (makes pending notes visible this turn). */
  put?: string;
  /** Remove the instruction entry (the notes were already visible last turn). */
  remove?: boolean;
}

/**
 * Run at the start of a user-initiated turn: "shown" notes have already been
 * visible on the previous turn → retire them; "pending" notes → make them
 * visible this turn and mark "shown".
 */
export function prepareNotes(state: NoteState): NotePrep {
  if (!state.notes) return { state };
  if (state.notesStage === "shown") return { state: { ...state, notes: undefined, notesStage: undefined }, remove: true };
  return { state: { ...state, notesStage: "shown" }, put: noteEntryText(state.notes) };
}

/** Patch for /new (merged via st.set): drop any pending notes. */
export function dropNotes(): { notes?: undefined; notesStage?: undefined } {
  return { notes: undefined, notesStage: undefined };
}

// ── Busy-reply "Thêm vào note" button (pure helpers; wiring in bot.ts) ────────
// When a message arrives while the agent is busy, the bot replies with a busy
// notice carrying a one-tap button to save that (otherwise dropped) message as a
// /note. These pure helpers encode/parse the button's callback data and cap the
// per-conversation retention of such messages (see scripts/test-notes-callback.ts).

/** One retained user message, addressed by its Telegram message_id. */
export interface BusyNoteEntry {
  /** The user message's Telegram message_id (embedded in the callback data). */
  id: number;
  /** The message text as sent (trimmed), ready to append as a note. */
  text: string;
}

/** Prefix that marks a "Thêm vào note" callback (distinct from fq:/mode:/pb:/cont:/…). */
export const NOTE_CB_PREFIX = "note:";

/** Button label on the busy reply (Vietnamese, per repo convention). */
export const NOTE_BUTTON_LABEL = "📝 Thêm vào note";

/** How many busy messages are retained per conv (the oldest are dropped beyond this). */
export const NOTE_RETENTION_CAP = 10;

/** The reply shown when a message arrives while the agent is already working. */
export const BUSY_REPLY_TEXT = "⏳ Still working on the previous message. Send /stop to interrupt.";

/**
 * Pure: build the callback data for the note button targeting the user message
 * with Telegram `messageId`. Message ids are small integers, so `note:<id>` is
 * always well under Telegram's 64-byte callback_data cap — unlike the continue
 * button's session ids, there is no "too long to ship" omission path.
 */
export function noteCallbackData(messageId: number): string {
  return NOTE_CB_PREFIX + messageId;
}

/**
 * Pure: parse a note-button callback data → the target user-message id, or null
 * when the data is not ours or is malformed (wrong prefix / non-numeric id).
 */
export function parseNoteCallback(data: string | undefined): number | null {
  if (!data || !data.startsWith(NOTE_CB_PREFIX)) return null;
  const rest = data.slice(NOTE_CB_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Pure: append a retained busy-note entry, dropping the OLDEST first so at most
 * `cap` survive. Returns a new array (the input is not mutated).
 */
export function pushBusyNote(
  list: BusyNoteEntry[],
  id: number,
  text: string,
  cap: number = NOTE_RETENTION_CAP,
): BusyNoteEntry[] {
  const next = [...list, { id, text }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * In-memory, per-conversation retention of user messages that arrived while the
 * agent was busy, so the busy-reply "📝 Thêm vào note" button can save one with a
 * tap. A single instance is created by the Bot and handed to the Orchestrator, so
 * BOTH busy paths (the regular chat in bot.ts and the Manager in orchestrator.ts)
 * retain into — and are handled identically from — the SAME store. Capped per
 * conv (oldest dropped); cleared when the turn ends or on /stop so a stale tap
 * after the turn is "not found".
 */
export class BusyNoteStore {
  private map = new Map<string, BusyNoteEntry[]>();

  /** Retain a busy message (text trimmed as sent); caps per conv (oldest dropped). */
  push(conv: string, id: number, text: string): void {
    this.map.set(conv, pushBusyNote(this.map.get(conv) ?? [], id, text.trim()));
  }

  /**
   * Look up + consume a retained entry by its message id. Returns the stored
   * text, or null when it is not there (never retained, already consumed by a
   * prior tap, or the turn ended and the conv was cleared).
   */
  take(conv: string, id: number): string | null {
    const list = this.map.get(conv);
    if (!list) return null;
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const [entry] = list.splice(idx, 1);
    return entry.text;
  }

  /** Drop every retained entry for a conv (the turn ended or /stop). */
  clear(conv: string): void {
    this.map.delete(conv);
  }
}
