/**
 * Per-user language preference → LLM instruction injection.
 *
 * The design (docs/sdd/language-preference.md) makes the user's language an
 * explicit, deterministic, per-user preference (`/lang vi|en`, stored in
 * data/users.json). This module turns that preference into a per-session
 * OpenCode INSTRUCTION (a system-context `api/*` entry) so the LLM replies in
 * the chosen language:
 *
 *   - "en"        → pin replies to English (an explicit instruction).
 *   - "vi" / unset → NO injection (the LLM behaviorally mirrors the input).
 *
 * Applied per SESSION and idempotently, so it survives /new, /use, and
 * rotation: a fresh session re-applies the pin on its next prompt, and
 * switching the preference away from "en" clears it.
 */
import type { Lang, StateManager } from "./state.js";
import type { ConvKey } from "./conv.js";

/** Instruction key for the explicit "en" pin (namespaced `api/<key>`). */
export const LANGUAGE_EN_KEY = "tgbot.language_en";
/** The exact instruction injected when the user's preference is "en". */
export const LANGUAGE_EN_INSTRUCTION = "Respond in English to all user messages.";

/**
 * The instruction text to inject for a language preference.
 * "en" → the English pin; "vi"/unset → null (no injection, behavioral mirror).
 */
export function languageInstructionFor(lang: Lang | "vn" | undefined): string | null {
  return lang === "en" ? LANGUAGE_EN_INSTRUCTION : null;
}

/** The minimal OpenCode surface applyLanguagePin needs (keeps it testable). */
export interface InstructionCtl {
  setInstruction(sessionID: string, key: string, value: unknown): Promise<void>;
  removeInstruction(sessionID: string, key: string): Promise<void>;
}

/**
 * Apply (or clear) the per-session language instruction for a user's
 * preference. "en" sets the English pin; "vi"/unset clears it (so switching
 * away from "en" reverts to the behavioral mirror). Idempotent and
 * best-effort — it never throws, and a failed set is simply retried on the
 * next prompt (the applied-marker is only recorded on success).
 */
export async function applyLanguagePin(
  oc: InstructionCtl,
  st: StateManager,
  conv: ConvKey,
  sessionID: string,
  lang: Lang | "vn" | undefined,
): Promise<void> {
  const state = st.peek(conv);
  if (!state) return;
  const want = languageInstructionFor(lang);
  if (want) {
    if (state.languageEnSession !== sessionID) {
      try {
        await oc.setInstruction(sessionID, LANGUAGE_EN_KEY, want);
        st.set(conv, { languageEnSession: sessionID }); // success only — a failure retries next prompt
      } catch {
        /* best-effort */
      }
    }
  } else if (state.languageEnSession === sessionID) {
    try {
      await oc.removeInstruction(sessionID, LANGUAGE_EN_KEY);
    } catch {
      /* best-effort */
    }
    st.set(conv, { languageEnSession: undefined });
  }
}

/** Every Vietnamese diacritical Latin letter (lowercase); the uppercase set is derived. */
const VN_DIACRITICS_LOWER =
  "áàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉïịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵđ";
const VN_DIACRITICS_RE = new RegExp(`[${VN_DIACRITICS_LOWER}${VN_DIACRITICS_LOWER.toUpperCase()}]`, "g");

/** Heuristic: VN diacritics are absent from English and code; a 3-char threshold tolerates a few quoted VN words in an EN task. */
export function detectTaskLang(text: string): "en" | "vn" {
  return (text.match(VN_DIACRITICS_RE)?.length ?? 0) >= 3 ? "vn" : "en";
}
