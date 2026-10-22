/**
 * Pure helpers for the pending-prompt reminder schedule (used by the Bot in
 * bot.ts). The backoff is EXPOENTIAL: the gap before each reminder keeps
 * growing (`baseMs * factor^n`), so we nudge more gently over time. This is
 * deliberately NOT a fixed interval — each wait is longer than the last.
 */

/** When (ms epoch) a freshly-shown prompt should get its first reminder. */
export function firstReminderAt(baseMs: number, now: number): number {
  return now + baseMs; // baseMs * factor^0
}

/** The gap (ms) before the next reminder, once `sent` reminders have already fired. */
export function nextReminderDelay(baseMs: number, factor: number, sent: number): number {
  return baseMs * Math.pow(factor, sent);
}

/** True once `max` reminders have been sent — stop nudging (prompt stays pending). */
export function reminderBudgetExhausted(remindersSent: number, max: number): boolean {
  return remindersSent >= max;
}

/**
 * Pure: after a reminder has been sent, decide whether the schedule should be
 * advanced. `captured` is the schedule as it was when this reminder fired;
 * `current` is the schedule NOW (re-read AFTER the async send). Returns undefined
 * when the prompt is no longer the same one (cancelled/answered/overwritten, so
 * `current` is gone or its `firstShownAt` changed) — the caller must NOT advance
 * or re-arm then. This is what keeps a fired reminder from nudging a prompt that
 * was settled or replaced while the send was in flight (the review's race).
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
