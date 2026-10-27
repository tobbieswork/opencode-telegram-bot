/** Agents shown to the user (the rest are internal OpenCode roles). */
export const AGENT_WHITELIST = ["build", "general", "explore", "plan"];

/**
 * Preamble prepended to the FIRST prompt of each session so the agent knows it is
 * headless (driven via Telegram) and should ask decisions through the `question`
 * tool — which we relay to the user as Telegram buttons — one question at a time.
 */
export const QUESTIONS_PREAMBLE =
  "[System note: You are running headless, driven through Telegram — the user has no terminal. " +
  "When you need a decision or input from the user, ask with the `question` tool using clear " +
  "multiple-choice options, ONE question at a time; the user answers via Telegram buttons. " +
  "Prefer asking over guessing when genuinely ambiguous.]";

/** Instruction-entry key for /note scratchpad notes (see src/notes.ts). */
export const NOTES_KEY = "tgbot.notes";

export type Btn = { text: string; callback_data: string };
export type Keyboard = { inline_keyboard: Btn[][] };
