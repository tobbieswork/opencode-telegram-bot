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

/** Append one note line (HH:MM-prefixed) and re-arm the stage to "pending". */
export function appendNote(state: NoteState, text: string, now: number): NoteState {
  const line = `- ${new Date(now).toISOString().slice(11, 16)}: ${text.trim()}`;
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
