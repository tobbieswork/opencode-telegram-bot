/**
 * Pure helpers for the "⏯ Chạy tiếp" (continue) button the bot offers when a
 * turn the user is waiting on ends in a GENUINE failure (a model/provider error
 * or context overflow — NOT a user-triggered /stop). The Bot (bot.ts) owns the
 * Telegram send and the click handling; this file only decides WHEN to offer the
 * button and how to encode/parse its callback data, so that decision is
 * unit-testable in isolation (see scripts/test-continue.ts).
 */

import { CallbackLimitError, oneArg } from "./callbacks.js";
import type { Lang } from "./state.js";

/** The one-line prompt sent to the model when the user taps the button. */
export const CONTINUE_PROMPT = "Tiếp tục phần còn lại, không hỏi lại.";

/** Localized continue prompt (model-facing one-liner). */
export function continuePrompt(lang: Lang = "vi"): string {
  return lang === "en" ? "Continue with the rest, don't ask again." : CONTINUE_PROMPT;
}

/** Button label (Vietnamese, per repo convention). */
export const CONTINUE_BUTTON_LABEL = "⏯ Chạy tiếp";

/** Localized continue-button label. */
export function continueButtonLabel(lang: Lang = "vi"): string {
  return lang === "en" ? "⏯ Continue" : CONTINUE_BUTTON_LABEL;
}

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
 * The `cont:` callback def (docs/sdd/callback-registry.md — T3 pilot
 * migration): one session-id argument. Declared ONCE here — the producer
 * below encodes through it, bot.ts registers it with its handler, and
 * parseContinueData is a thin view over the same decode, so the wire form
 * has a single source of truth.
 */
export const continueCallback = oneArg("cont");

/**
 * Pure: build the callback data for a continue button targeting `sessionID`. The
 * data carries the session id so the click routes back to the exact session that
 * failed (and is rejected if that session has since been replaced). Returns
 * undefined when the data would exceed Telegram's 64-byte cap — then the button
 * must be OMITTED rather than shipped unclickable (the registry's encoder
 * refuses over-limit data, so we catch exactly that and drop the button).
 */
export function continueCallbackData(sessionID: string): string | undefined {
  try {
    return continueCallback.encode(sessionID);
  } catch (e) {
    if (e instanceof CallbackLimitError) return undefined;
    throw e;
  }
}

/**
 * Pure: parse a continue-button callback data → the target sessionID, or
 * undefined when the data is not ours or is malformed (wrong prefix / empty id).
 */
export function parseContinueData(data: string | undefined): string | undefined {
  if (!data || !data.startsWith(CONTINUE_CB_PREFIX)) return undefined;
  return continueCallback.decode(data.slice(CONTINUE_CB_PREFIX.length)) ?? undefined;
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
