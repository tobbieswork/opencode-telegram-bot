/**
 * Append-only audit log of what the bot did on the host's behalf.
 *
 * The bot can run code on this machine from a Telegram message, so we keep a
 * bot-level trail (separate from OpenCode's own per-session history): who asked
 * for what, in which chat/session/directory, and how it ended.
 *
 *  - one JSON object per line (JSONL), mode 0600
 *  - secrets redacted with redactSecrets, free text truncated
 *  - rotated to `<file>.1` at a size limit (one generation kept)
 *  - NEVER throws: auditing must not break the bot. A failure is warned once.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.js";
import { warn } from "./logger.js";

export interface AuditEvent {
  /** What happened, e.g. "prompt", "spawn", "dispatch_approve", "dispatch_reject". */
  action: string;
  userId?: number | string;
  chatId?: number | string;
  /** OpenCode session or worker id. */
  session?: string;
  dir?: string;
  /** e.g. "accepted", "ok", "rejected", "error". */
  outcome?: string;
  /** Free text (prompt, task). Redacted and truncated before it is written. */
  text?: string;
}

export interface AuditOptions {
  path: string;
  /** Rotate when the active file reaches this size. Default 5 MB. */
  maxBytes?: number;
  /** Max characters of `text` kept. Default 500. */
  maxText?: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export type AuditFn = (event: AuditEvent) => void;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT = 500;

export function createAudit(opts: AuditOptions): AuditFn {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxText = opts.maxText ?? DEFAULT_MAX_TEXT;
  const now = opts.now ?? (() => new Date());
  let warned = false;

  return (event) => {
    try {
      const entry: Record<string, unknown> = { ts: now().toISOString(), ...event };
      if (typeof event.text === "string") {
        const clean = redactSecrets(event.text);
        entry.text = clean.length > maxText ? `${clean.slice(0, maxText)}…` : clean;
      }
      mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 });
      rotateIfNeeded(opts.path, maxBytes);
      appendFileSync(opts.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`audit log write failed (${opts.path}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}

function rotateIfNeeded(path: string, maxBytes: number): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return; // no file yet
  }
  if (size >= maxBytes) renameSync(path, `${path}.1`); // overwrites the previous generation
}

// ── Process-wide instance, configured once at startup (wired in task 3) ──────
let current: AuditFn | undefined;

/** Point the shared audit log at a file. Call once at startup. */
export function configureAudit(opts: AuditOptions): void {
  current = createAudit(opts);
}

/** Record an event. A no-op until configureAudit() has been called. */
export function audit(event: AuditEvent): void {
  current?.(event);
}
