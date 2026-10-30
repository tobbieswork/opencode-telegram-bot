/**
 * Pure helpers for the pending-prompt reminder schedule (used by the Bot in
 * bot.ts). The backoff is EXPONENTIAL: the gap before each reminder keeps
 * growing (`baseMs * factor^n`), so we nudge more gently over time. This is
 * deliberately NOT a fixed interval — each wait is longer than the last.
 */

/**
 * Longest delay setTimeout accepts (2^31-1 ms, ~24.8 days). Anything larger
 * overflows and Node fires the timer after ~1 ms, so an env-tuned backoff
 * (e.g. OPENCODE_TG_REMIND_MAX=20) would turn into a reminder storm.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Clamp a delay into what setTimeout can honour. */
export function clampTimerDelay(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}

/** When (ms epoch) a freshly-shown prompt should get its first reminder. */
export function firstReminderAt(baseMs: number, now: number): number {
  return now + clampTimerDelay(baseMs); // baseMs * factor^0
}

/**
 * The schedule to store when a prompt is (re)registered. A prompt that is
 * already persisted (same id and kind — e.g. re-registered by reconcile() after
 * a restart) KEEPS its schedule, so a restart doesn't reset the backoff or hand
 * an exhausted prompt a fresh budget; a new prompt starts at the first reminder.
 */
export function scheduleForRegistration(
  existing: { kind: string; firstShownAt: number; remindersSent: number; nextReminderAt: number } | undefined,
  kind: string,
  baseMs: number,
  now: number,
): { firstShownAt: number; remindersSent: number; nextReminderAt: number } {
  if (existing && existing.kind === kind) {
    return { firstShownAt: existing.firstShownAt, remindersSent: existing.remindersSent, nextReminderAt: existing.nextReminderAt };
  }
  return { firstShownAt: now, remindersSent: 0, nextReminderAt: firstReminderAt(baseMs, now) };
}

/** The gap (ms) before the next reminder, once `sent` reminders have already fired. */
export function nextReminderDelay(baseMs: number, factor: number, sent: number): number {
  return clampTimerDelay(baseMs * Math.pow(factor, sent));
}

/**
 * Ids of persisted reminders whose prompt no longer exists in OpenCode (answered
 * or cancelled while the bot was down). `live.<kind>` is the set of ids OpenCode
 * still lists, or undefined when that listing failed — then the kind is left
 * alone, since "unknown" must not be read as "gone".
 */
export function stalePromptIds(
  pending: Record<string, { kind: "form" | "permission" }> | undefined,
  live: { form?: Set<string>; permission?: Set<string> },
): string[] {
  return Object.entries(pending ?? {})
    .filter(([id, p]) => {
      const ids = live[p.kind];
      return ids !== undefined && !ids.has(id);
    })
    .map(([id]) => id);
}

/** True once `max` reminders have been sent — stop nudging (prompt stays pending). */
export function reminderBudgetExhausted(remindersSent: number, max: number): boolean {
  return remindersSent >= max;
}

export function snoozeSchedule(current: { nextReminderAt: number; snoozeBaseAt?: number }, until?: number) {
  const base = current.snoozeBaseAt ?? current.nextReminderAt;
  if (!Number.isFinite(base) || (until !== undefined && !Number.isFinite(until))) throw new Error("Mốc tạm hoãn không hợp lệ.");
  return { nextReminderAt: until === undefined ? base : Math.max(base, until), snoozeBaseAt: until === undefined ? undefined : base, snoozedUntil: until };
}

/**
 * Pure: after a reminder has been sent, decide whether the schedule should be
 * advanced. `captured` is the schedule as it was when this reminder fired;
 * `current` is the schedule NOW (re-read AFTER the async send). Returns undefined
 * when the prompt is no longer the same one (cancelled/answered/overwritten, so
 * `current` is gone or its `firstShownAt` changed) — the caller must NOT advance
 * or re-arm then. This is what keeps a fired reminder from nudging a prompt that
 * was settled or replaced while the send was in flight (a reminder racing an answer).
 */
export function nextScheduleAfterReminder(
  captured: { firstShownAt: number; remindersSent: number },
  current: { firstShownAt: number; remindersSent: number } | undefined,
  baseMs: number,
  factor: number,
  now: number,
): { remindersSent: number; nextReminderAt: number } | undefined {
  if (!current || current.firstShownAt !== captured.firstShownAt) return undefined;
  const sent = captured.remindersSent + 1;
  return { remindersSent: sent, nextReminderAt: now + nextReminderDelay(baseMs, factor, sent) };
}
