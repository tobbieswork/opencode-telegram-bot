/**
 * Pattern B — deterministic, model-agnostic choice buttons.
 *
 * The model keeps doing what it already does: end a reply with a short
 * lettered/numbered list of options. This module DETECTS that trailing list in
 * the client and renders it as an inline keyboard, then relays the clicked
 * choice back to the session "as if typed". The model is never told about
 * buttons, never calls a tool for them, and never formats anything special —
 * swapping the model changes nothing about how buttons are rendered.
 *
 * The only failure mode is "no buttons" (detection returns null → the reply is
 * sent as plain text, exactly as today). It never breaks a reply.
 *
 * See docs/sdd/interactive-buttons-research.md (§5) for the full design.
 */
import { randomInt } from "node:crypto";
import type { Keyboard, Btn } from "./shared.js";
import type { ConvKey } from "./conv.js";

/** A trailing choice list the model wrote: 2–8 short, sequentially-marked lines. */
export interface Choices {
  /** The message with the trailing list removed (trimmed). Sent as the body. */
  body: string;
  /** The option texts (marker stripped), in order. */
  options: string[];
}

/**
 * One line of a choice list: a single letter (A–H, upper or lower case) or a
 * number (1–12), optionally wrapped in parens (the closing paren then acts as
 * the separator), or followed by a separator from `. ) : - – —` (with optional
 * whitespace before it, so "A — x" works), then whitespace, then non-empty text.
 * Matches: "A. foo", "A — bar", "1) baz", "(2) qux", "3 - quux", "c: corge".
 * The marker is group 1 (paren-wrapped) or group 2 (bare); the text is group 3.
 */
const LINE_MARK = /^\s*(?:\(([A-Ha-h]|[1-9]|1[0-2])\)|([A-Ha-h]|[1-9]|1[0-2])\s*[.)\:\-–—])\s+(\S.*)$/;

/** A code-fence delimiter: a line whose trimmed form starts with ``` or ~~~. */
const FENCE = /^\s*(```|~~~)/;

/** A list item longer than this is treated as a multi-line paragraph, not an option. */
const MAX_OPT_LEN = 80;

/**
 * Detect a trailing choice list — 2–8 sequential short lines (letter A–H or
 * number 1–12) that terminate the message and are not inside a code fence —
 * and return the body (message minus that list) plus the option texts.
 * Returns null when unsure; the caller falls back to plain text.
 *
 * Rules (all conservative, to suppress false positives):
 *  - Only the LAST block: a numbered *steps* list in the middle of an answer
 *    must not become buttons. Only a list that terminates the message counts.
 *  - Sequential markers only (A,B,C / 1,2,3), all the same kind, starting at
 *    the first (A / 1) — arbitrary bullets and gaps are rejected.
 *  - Fence guard: a list inside a ``` / ~~~ code block is skipped.
 *  - 2–8 items, each option line ≤ MAX_OPT_LEN chars.
 *  - A non-empty body must remain (a message that is *only* the list falls
 *    back to plain text so we never send an empty message).
 */
export function extractTrailingChoices(markdown: string): Choices | null {
  const text = (markdown ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // Fence state per line: a delimiter line toggles the fence; content lines
  // inherit the current state. A delimiter line itself is marked "fence" so it
  // can never be mistaken for a list item.
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      fence = !fence;
      inFence[i] = true;
    } else {
      inFence[i] = fence;
    }
  }

  // Last non-blank line (the list must terminate the message).
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (end < 0) return null;

  // Walk back from `end` over the contiguous run of non-blank, non-fence lines
  // that all match LINE_MARK. `start` is the first line of that run.
  let start = end;
  while (start >= 0) {
    const line = lines[start];
    if (line.trim() === "" || inFence[start] || !LINE_MARK.test(line)) break;
    start--;
  }
  start++;

  const count = end - start + 1;
  if (count < 2 || count > 8) return null;

  // Extract markers + option texts; reject over-long options.
  const markers: string[] = [];
  const options: string[] = [];
  for (let i = start; i <= end; i++) {
    const m = LINE_MARK.exec(lines[i])!;
    markers.push(m[1] ?? m[2]);
    const opt = m[3].trim();
    if (opt.length > MAX_OPT_LEN) return null;
    options.push(opt);
  }

  // Sequential, single kind, starting at the first (A / 1).
  const firstIsLetter = /[A-Za-z]/.test(markers[0]);
  for (let i = 0; i < markers.length; i++) {
    const isLetter = /[A-Za-z]/.test(markers[i]);
    if (isLetter !== firstIsLetter) return null; // mixed letters and numbers
    if (firstIsLetter) {
      if (markers[i].toUpperCase().charCodeAt(0) !== "A".charCodeAt(0) + i) return null;
    } else if (parseInt(markers[i], 10) !== i + 1) return null;
  }

  // Body = everything before the run, with trailing blank lines trimmed.
  const body = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  if (body.trim() === "") return null; // message was only the list — keep it as text

  return { body, options };
}

/**
 * Build the inline keyboard mirroring a choice list: one button per row, label
 * truncated to ~40 chars, and a TINY `callback_data` = `ch:<id>:<i>` (id is a
 * short registry key, i the option index) — well under Telegram's 64-byte cap,
 * and carrying no option text.
 */
export function choiceKeyboard(id: string, options: string[]): Keyboard {
  const rows: Btn[][] = options.slice(0, 8).map((t, i) => [
    { text: t.length > 40 ? t.slice(0, 40) + "…" : t, callback_data: `ch:${id}:${i}` },
  ]);
  return { inline_keyboard: rows };
}

export interface ChoiceRecord {
  conv: ConvKey;
  sessionID?: string;
  options: string[];
  /** When the record was created (for TTL pruning). */
  createdAt: number;
}

/** Default TTL for unclicked choice records (24 h). */
const CHOICE_TTL_MS = 24 * 60 * 60 * 1000;

const records = new Map<string, ChoiceRecord>();

/**
 * In-memory choice registry (same process lifetime as the session map). Maps a
 * short 4-char base36 id to the full choice data so `callback_data` stays tiny.
 */
export const registry = {
  /** Store a choice set and return a fresh 4-char base36 id. */
  put(conv: ConvKey, sessionID: string | undefined, options: string[]): string {
    let id = "";
    do {
      id = randomInt(0, 36 ** 4).toString(36).padStart(4, "0");
    } while (records.has(id));
    records.set(id, { conv, sessionID, options, createdAt: Date.now() });
    return id;
  },
  get(id: string): ChoiceRecord | undefined {
    const rec = records.get(id);
    if (rec && Date.now() - rec.createdAt > CHOICE_TTL_MS) {
      records.delete(id);
      return undefined;
    }
    return rec;
  },
  delete(id: string): void {
    records.delete(id);
  },
  /** Remove records older than maxAgeMs (default 24 h). Returns count pruned. */
  prune(maxAgeMs: number = CHOICE_TTL_MS): number {
    const now = Date.now();
    let n = 0;
    for (const [id, rec] of records) {
      if (now - rec.createdAt > maxAgeMs) { records.delete(id); n++; }
    }
    return n;
  },
};
