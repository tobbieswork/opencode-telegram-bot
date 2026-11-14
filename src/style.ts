/**
 * Per-user output-style preference → LLM instruction injection.
 *
 * The user picks a response style once via `/style <name>`; it is stored
 * per-user in data/users.json (like the language preference) and this module
 * turns it into a per-session OpenCode INSTRUCTION (a system-context `api/*`
 * entry) pinned to the MANAGER conversation so the bot's replies match the
 * style:
 *
 *   - "default"     → NO injection (byte-identical to the stock behavior).
 *   - other styles  → the exact per-style instruction text below.
 *
 * Applied per SESSION and idempotently, so it survives /new, /use, and
 * Manager rotation: a fresh session re-applies the pin on its next prompt,
 * and switching the preference back to "default" clears it.
 *
 * Modelled line-for-line on the quick-replies pin (src/suggest.ts): best-
 * effort — a failed set is simply retried on the next prompt (the applied-
 * marker is only recorded on success).
 */
import { createHash } from "node:crypto";
import type { StateManager } from "./state.js";
import type { ConvKey } from "./conv.js";
import type { InstructionCtl } from "./language.js";

/** The available output styles. "default" = no instruction at all. */
export type StyleName = "default" | "concise" | "explanatory" | "learning" | "proactive";

/** All styles, in display order (default first). */
export const STYLE_NAMES: StyleName[] = ["default", "concise", "explanatory", "learning", "proactive"];

/**
 * Resolve a `/style` argument — a 1-based number string ("1".."5", mapped into
 * STYLE_NAMES order) or a style name — to a valid style, or null when it
 * matches neither. Whitespace is trimmed; matching is case-insensitive.
 */
export function resolveStyleArg(a: string): StyleName | null {
  const s = a.trim().toLowerCase();
  if (s === "") return null;
  if (/^\d+$/.test(s)) {
    return STYLE_NAMES[Number(s) - 1] ?? null;
  }
  return STYLE_NAMES.includes(s as StyleName) ? (s as StyleName) : null;
}

/** Instruction key for the output-style pin (namespaced `api/<key>`). */
export const STYLE_KEY = "tgbot.style";

/**
 * The exact per-style instruction texts. Changing one is a behavior change
 * (it changes styleVersionFor, which re-pins already-tracked sessions on
 * their next turn). "default" has no text — styleInstructionFor returns null.
 */
const STYLE_INSTRUCTIONS: Record<Exclude<StyleName, "default">, string> = {
  concise:
    "Respond concisely: lead with the result or answer in the first line(s); no preamble, no restating the " +
    "question, no closing summary. Still be fully complete on the technical work — code, fixes, and " +
    "explanations of errors, security warnings, and destructive/deleting operations must be complete. " +
    "Expand detail only when the user asks for it.",
  explanatory:
    "In addition to the answer, add a short '★ Insight' block after the main response explaining WHY you " +
    "chose the approach (key decisions, trade-offs, reasoning). Keep the main answer normal; the insight " +
    "is a brief add-on.",
  learning:
    "Respond in explanatory style, but additionally leave a few short code sections that involve a design " +
    "decision as clearly-marked '// TODO: you' stubs with a one-line hint, so the user writes them " +
    "themselves. Keep stubs minimal and never break the build.",
  proactive:
    "Be proactive: start acting immediately on the task without asking for confirmation on routine, " +
    "low-risk decisions (file naming, small refactors, standard patterns). Only pause to ask when a " +
    "decision is genuinely ambiguous, high-risk, destructive, or irreversible. State what you decided " +
    "and why, briefly.",
};

/**
 * The instruction text to inject for a style preference.
 * "default" → null (no injection); otherwise the exact style text.
 */
export function styleInstructionFor(style: StyleName): string | null {
  return style === "default" ? null : STYLE_INSTRUCTIONS[style];
}

/**
 * Fingerprint of the style's instruction text. Changing the text changes
 * this, which makes applyStylePin re-pin already-tracked sessions on their
 * next turn (the session-id tracker alone would keep serving a stale text
 * after a deploy). "default" has no text → "".
 */
export function styleVersionFor(style: StyleName): string {
  if (style === "default") return "";
  return createHash("sha256").update(style + ":" + styleInstructionFor(style)!).digest("hex").slice(0, 16);
}

/**
 * Apply (or clear) the per-session output-style instruction for a user's
 * preference. A real style sets the pin; "default" clears it (so switching
 * back to "default" removes it). Idempotent and best-effort — it never
 * throws, and a failed set is simply retried on the next prompt (the
 * applied-marker is only recorded on success).
 */
export async function applyStylePin(
  oc: InstructionCtl,
  st: StateManager,
  conv: ConvKey,
  sessionID: string,
  style: StyleName,
): Promise<void> {
  const state = st.peek(conv);
  if (!state) return;
  if (style === "default") {
    if (state.styleSession === sessionID) {
      try {
        await oc.removeInstruction(sessionID, STYLE_KEY);
      } catch {
        /* best-effort */
      }
      st.set(conv, { styleSession: undefined, styleVersion: undefined });
    }
    return;
  }
  const version = styleVersionFor(style);
  if (state.styleSession !== sessionID || state.styleVersion !== version) {
    try {
      await oc.setInstruction(sessionID, STYLE_KEY, styleInstructionFor(style)!);
      // success only — a failure retries next prompt; the version check makes
      // an instruction-text change re-pin tracked sessions on their next turn
      st.set(conv, { styleSession: sessionID, styleVersion: version });
    } catch {
      /* best-effort */
    }
  }
}
