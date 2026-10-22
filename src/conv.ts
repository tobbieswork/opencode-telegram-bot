/**
 * A *conversation* is where one OpenCode session talks to the user: a whole
 * chat, or one forum topic inside it (private chats with topic mode, or forum
 * supergroups). Its key is `"<chatId>"` or `"<chatId>:<threadId>"` — the
 * chat-only form is what older state files already use, so they still load.
 */
export type ConvKey = string;

export function convKey(chatId: number | string, threadId?: number): ConvKey {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

export function parseConv(key: ConvKey | number): { chatId: number; threadId?: number } {
  const [c, t] = String(key).split(":");
  return t ? { chatId: Number(c), threadId: Number(t) } : { chatId: Number(c) };
}

/** The chat a conversation belongs to (its General/top-level conversation). */
export function chatOf(key: ConvKey): ConvKey {
  return String(parseConv(key).chatId);
}
