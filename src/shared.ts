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

export type Btn = { text: string; callback_data?: string; url?: string; switch_to_topic?: { message_id: number } };
export type Keyboard = { inline_keyboard: Btn[][] };

/**
 * Deep link that opens a forum topic from another chat (Bot API 10.4):
 * supergroups use `t.me/c/<id>/<thread>`; private chats with topics use
 * `t.me/<bot_username>/<thread>` (the link only opens for the private chat's
 * owner). Returns undefined when no link exists for this chat type, or when
 * the bot's username is unknown (private-chat case) — callers skip the link.
 */
export function topicDeepLink(chatId: number, threadId: number, botUsername?: string): string | undefined {
  if (chatId < -1000000000000) return `https://t.me/c/${Math.abs(chatId) - 1000000000000}/${threadId}`;
  if (botUsername && chatId > 0) return `https://t.me/${botUsername}/${threadId}`;
  return undefined;
}
