/**
 * In-memory queue of messages per conversation, for messages sent while the
 * agent's turn is still running (docs/sdd/queue-and-steer.md, Q1).
 *
 * Pure and in-memory only (no persistence — a prompt that replays after a
 * restart is a worse surprise than a lost one for a bot that runs code): it
 * holds the text until the turn ends and is the source for the position
 * display, the /queue list and expiry. The actual send is done by the drain
 * layer (a later phase).
 *
 * Defaults follow the spec decisions: cap 3 per conv, 30-min expiry. `now`
 * is injectable everywhere so tests never wait. An item is EXPIRED when
 * `at + expiryMs < now` (exactly at the boundary it is still alive).
 */
export interface QueuedItem {
  text: string;
  /** Telegram user id that enqueued the message (Q1.7). */
  senderId?: string;
  /** Enqueue time, ms. */
  at: number;
}

export type PushResult = { ok: true; position: number } | { ok: false; full: true };

const DEFAULT_CAP = 3;
const DEFAULT_EXPIRY_MS = 30 * 60 * 1000;

export class QueueStore {
  private readonly cap: number;
  private readonly expiryMs: number;
  private readonly queues = new Map<string, QueuedItem[]>();

  constructor(opts?: { cap?: number; expiryMs?: number }) {
    this.cap = opts?.cap ?? DEFAULT_CAP;
    this.expiryMs = opts?.expiryMs ?? DEFAULT_EXPIRY_MS;
  }

  /**
   * Enqueue at the tail (FIFO). Expired items are pruned first, then a conv at
   * the cap is refused with `{ full }` — nothing is ever dropped silently.
   */
  push(conv: string, item: { text: string; senderId?: string }, now = Date.now()): PushResult {
    const q = this.queues.get(conv) ?? [];
    const live = q.filter((it) => it.at + this.expiryMs >= now);
    if (live.length >= this.cap) return { ok: false, full: true };
    live.push({ text: item.text, senderId: item.senderId, at: now });
    this.queues.set(conv, live);
    return { ok: true, position: live.length };
  }

  /**
   * Re-enqueue an item at the HEAD — used by the drain layer when it loses the
   * turn-end race (Q1.11) so FIFO order is preserved: the item runs ahead of
   * anything enqueued behind it. It keeps its original `at`, so its position
   * and age are preserved (it was enqueued earlier than the items it rejoins).
   * Internal operation: the item was just `shift()`-ed out, so there is room.
   */
  prepend(conv: string, item: QueuedItem, now = Date.now()): void {
    const live = (this.queues.get(conv) ?? []).filter((it) => it.at + this.expiryMs >= now);
    live.unshift(item);
    this.queues.set(conv, live);
  }

  /**
   * Dequeue the oldest non-expired item. Expired heads are dropped first
   * (they can only be at the head: FIFO means later items are newer); the
   * next live item is returned, or null when the conv is empty.
   */
  shift(conv: string, now = Date.now()): QueuedItem | null {
    const q = this.queues.get(conv);
    if (!q) return null;
    while (q.length > 0 && q[0].at + this.expiryMs < now) q.shift();
    const head = q.shift() ?? null;
    if (head === null) this.queues.delete(conv);
    return head;
  }

  /** Drop every stored item of one conv; returns how many were dropped. */
  clear(conv: string): number {
    const n = this.queues.get(conv)?.length ?? 0;
    this.queues.delete(conv);
    return n;
  }

  /** Drop every expired item in EVERY conv; returns how many were dropped. */
  expire(now = Date.now()): number {
    let dropped = 0;
    for (const [conv, q] of this.queues) {
      const keep = q.filter((it) => it.at + this.expiryMs >= now);
      dropped += q.length - keep.length;
      if (keep.length > 0) this.queues.set(conv, keep);
      else this.queues.delete(conv);
    }
    return dropped;
  }

  /** Non-expired items oldest first, each with its age in ms. */
  list(conv: string, now = Date.now()): Array<{ text: string; senderId?: string; at: number; ageMs: number }> {
    return (this.queues.get(conv) ?? [])
      .filter((it) => it.at + this.expiryMs >= now)
      .map((it) => ({ ...it, ageMs: now - it.at }));
  }

  /** How many non-expired items the conv holds. */
  size(conv: string, now = Date.now()): number {
    return (this.queues.get(conv) ?? []).filter((it) => it.at + this.expiryMs >= now).length;
  }

  /** Whether the conv currently has stored items (expired ones count until purged). */
  has(conv: string): boolean {
    return (this.queues.get(conv)?.length ?? 0) > 0;
  }
}
