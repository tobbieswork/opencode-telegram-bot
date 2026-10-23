/**
 * Pure helpers for the "⏯ Chạy tiếp" (continue) button the bot offers when a
 * turn the user is waiting on ends in a GENUINE failure (a model/provider error
 * or context overflow — NOT a user-triggered /stop). The Bot (bot.ts) owns the
 * Telegram send and the click handling; this file only decides WHEN to offer the
 * button and how to encode/parse its callback data, so that decision is
 * unit-testable in isolation (see scripts/test-continue.ts).
 */

/** The one-line prompt sent to the model when the user taps the button. */
export const CONTINUE_PROMPT = "Tiếp tục phần còn lại, không hỏi lại.";

/** Button label (Vietnamese, per repo convention). */
export const CONTINUE_BUTTON_LABEL = "⏯ Chạy tiếp";

/** Prefix that marks a continue-button callback (distinct from fq:/mode:/pb:/…). */
export const CONTINUE_CB_PREFIX = "cont:";

/** Telegram caps `callback_data` at 64 BYTES per button. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Pure: should the "chạy tiếp" button be offered for this turn event? Only a
 * genuine failure qualifies — a clean success and a user-triggered /stop
 * (`interrupted` true) both do NOT. This is the single decision the bot gates
 * the button on.
 */
export function shouldOfferContinue(p: { outcome?: string; interrupted: boolean }): boolean {
  return p.outcome === "failed" && !p.interrupted;
}

/**
 * Pure: build the callback data for a continue button targeting `sessionID`. The
 * data carries the session id so the click routes back to the exact session that
 * failed (and is rejected if that session has since been replaced). Returns
 * undefined when the data would exceed Telegram's 64-byte cap — then the button
 * must be OMITTED rather than shipped unclickable.
 */
export function continueCallbackData(sessionID: string): string | undefined {
  const data = CONTINUE_CB_PREFIX + sessionID;
  return Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES ? data : undefined;
}

/**
 * Pure: parse a continue-button callback data → the target sessionID, or
 * undefined when the data is not ours or is malformed (wrong prefix / empty id).
 */
export function parseContinueData(data: string | undefined): string | undefined {
  if (!data || !data.startsWith(CONTINUE_CB_PREFIX)) return undefined;
  const sessionID = data.slice(CONTINUE_CB_PREFIX.length);
  return sessionID.length > 0 ? sessionID : undefined;
}

/**
 * Pure: the anti-spam dedupe. True when a continue button has ALREADY been
 * offered for this exact turn in this conv, so it must not be offered again.
 * `lastOfferedTurn` is the turn id recorded the last time we offered (undefined
 * = never); `turnId` is the current turn's id (the prompt's message id — unique
 * per turn). A fresh turn has a fresh id, so a NEW failure still gets a fresh
 * button while the SAME failure never offers twice.
 */
export function alreadyOfferedContinue(lastOfferedTurn: string | undefined, turnId: string): boolean {
  return lastOfferedTurn === turnId;
}
