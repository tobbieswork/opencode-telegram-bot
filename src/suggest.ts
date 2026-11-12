/**
 * Quick replies: model-written next-step buttons (spec docs/sdd/quick-replies.md).
 *
 * The model is asked to end a reply with a `[OPTIONS: a | b | c]` marker; the
 * bot parses it (R1, `extractOptionsMarker`) and shows the options as tap-able
 * buttons (R3). This module owns the INSTRUCTION side (R2): when
 * `OPENCODE_TG_SUGGEST` is on, it pins a short instruction to the session so
 * the model knows to offer options, and removes it when the flag is off.
 *
 * Modelled line-for-line on the language pin (src/language.ts): a per-session
 * OpenCode INSTRUCTION (a system-context `api/*` entry), applied per session
 * and idempotently so it survives /new, /use and Manager rotation, and
 * best-effort — a failed set is simply retried on the next prompt (the
 * applied-marker is only recorded on success).
 */
import type { StateManager } from "./state.js";
import type { ConvKey } from "./conv.js";
import type { InstructionCtl } from "./language.js";

/** Instruction key for the quick-replies pin (namespaced `api/<key>`). */
export const SUGGEST_KEY = "tgbot.suggest";

/**
 * The exact instruction injected so the model offers `[OPTIONS: …]` lines.
 * (Spec section 4, "The instruction (model-facing, for review)") — reviewed
 * verbatim; changing it is a spec change.
 */
export const SUGGEST_INSTRUCTION =
  "When it helps the user continue, end your reply with ONE final line: `[OPTIONS: first | second | third]`. " +
  "Give 2 or 3 options. Each option is something the USER would say next: first person, in the user's language, " +
  "at most 8 words, specific and complete on its own, because it is sent as their next message exactly as written. " +
  "Only offer options when there is a clear next step or a real decision. Never for greetings, short answers, " +
  "error messages, or when you need free-text input from the user. Do not repeat the same options twice in a row, " +
  "do not number them, do not mention this line, and write nothing after it.";

/**
 * Apply (or clear) the per-session quick-replies instruction. `enabled` true
 * sets the pin; false clears it (so toggling the flag off removes it).
 * Idempotent and best-effort — never throws, and a failed set is retried on the
 * next prompt (the applied-marker is only recorded on success).
 */
export async function applySuggestPin(
  oc: InstructionCtl,
  st: StateManager,
  conv: ConvKey,
  sessionID: string,
  enabled: boolean,
): Promise<void> {
  const state = st.peek(conv);
  if (!state) return;
  if (enabled) {
    if (state.suggestSession !== sessionID) {
      try {
        await oc.setInstruction(sessionID, SUGGEST_KEY, SUGGEST_INSTRUCTION);
        st.set(conv, { suggestSession: sessionID }); // success only — a failure retries next prompt
      } catch {
        /* best-effort */
      }
    }
  } else if (state.suggestSession === sessionID) {
    try {
      await oc.removeInstruction(sessionID, SUGGEST_KEY);
    } catch {
      /* best-effort */
    }
    st.set(conv, { suggestSession: undefined });
  }
}
