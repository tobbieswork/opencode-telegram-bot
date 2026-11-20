/**
 * A *conversation* is where one OpenCode session talks to the user: a whole
 * chat, or one forum topic inside it (private chats with topic mode, or forum
 * supergroups). Its key is `"<chatId>"` or `"<chatId>:<threadId>"` — the
 * chat-only form is what older state files already use, so they still load.
 *
 * A background worker has no topic of its own: its synthetic key is
 * `"bg:<chatId>:<name>"`, which maps back to the main chat (see
 * `isBackgroundConv` / `relayConv`). Such keys are produced only internally
 * (worker spawn), never by Telegram message routing.
 */
export type ConvKey = string;

export function convKey(chatId: number | string, threadId?: number): ConvKey {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/** Key of a background (topic-less) worker's conversation in a chat. */
export function bgConvKey(chatId: number | string, name: string): ConvKey {
  return `bg:${chatId}:${name}`;
}

export function parseConv(key: ConvKey | number): {
  chatId: number;
  threadId?: number;
  background?: boolean;
  workerName?: string;
} {
  const s = String(key);
  if (s.startsWith("bg:")) {
    const [c, ...rest] = s.slice(3).split(":");
    return { chatId: Number(c), background: true, workerName: rest.join(":") };
  }
  const [c, t] = s.split(":");
  return t ? { chatId: Number(c), threadId: Number(t) } : { chatId: Number(c) };
}

/** True for a background worker's synthetic conv key (`"bg:<chatId>:<name>"`). */
export function isBackgroundConv(key: ConvKey): boolean {
  return key.startsWith("bg:");
}

/** The conversation a worker's Telegram output should be relayed to: a bg
 * conv's output goes to the main chat; a live conv is returned unchanged. */
export function relayConv(conv: ConvKey): ConvKey {
  return isBackgroundConv(conv) ? chatOf(conv) : conv;
}

/** The chat a conversation belongs to (its General/top-level conversation). */
export function chatOf(key: ConvKey): ConvKey {
  return String(parseConv(key).chatId);
}
