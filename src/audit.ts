/**
 * Append-only audit log of what the bot did on the host's behalf.
 *
 * The bot can run code on this machine from a Telegram message, so we keep a
 * bot-level trail (separate from OpenCode's own per-session history): who asked
 * for what, in which chat/session/directory, and how it ended.
 *
 *  - one JSON object per line (JSONL), mode 0600
 *  - secrets redacted with redactSecrets, free text truncated
 *  - rotated to a dated archive `<file>.YYYY-MM-DD` (UTC date) at a size limit;
 *    same-day collisions get a counter: `<file>.YYYY-MM-DD.1`, `.2`, …
 *  - retention: the 14 newest dated archives are kept, older ones are pruned
 *  - NEVER throws: auditing must not break the bot. A failure is warned once.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Structured payload (written verbatim, not redacted). For machine fields. */
  meta?: Record<string, unknown>;
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
/** How many dated archives to keep; older ones are pruned after each rotation. */
const RETENTION_ARCHIVES = 14;

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
      rotateIfNeeded(opts.path, maxBytes, now);
      appendFileSync(opts.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`audit log write failed (${opts.path}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}

function rotateIfNeeded(path: string, maxBytes: number, now: () => Date): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return; // no file yet
  }
  if (size < maxBytes) return;
  archiveDated(path, now());
  pruneArchives(path);
}

/**
 * Rename the active file to `<path>.YYYY-MM-DD` (UTC date of rotation). If an
 * archive already exists for that day (a second rotation on the same day),
 * append an increasing counter — `<path>.YYYY-MM-DD.1`, `.2`, … — so an
 * existing same-day archive is never clobbered.
 */
function archiveDated(path: string, date: Date): void {
  const day = date.toISOString().slice(0, 10);
  let target = `${path}.${day}`;
  for (let n = 1; existsSync(target); n++) target = `${path}.${day}.${n}`;
  renameSync(path, target);
}

/** Keep only the newest RETENTION_ARCHIVES dated archives, oldest deleted first. */
function pruneArchives(path: string): void {
  const dir = dirname(path);
  const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?$`);
  const archives: Array<{ file: string; day: string; n: number }> = [];
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (!m) continue;
    archives.push({ file: name, day: m[1], n: m[2] === undefined ? 0 : Number(m[2]) });
  }
  archives.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.n - b.n));
  for (const a of archives.slice(0, Math.max(0, archives.length - RETENTION_ARCHIVES))) {
    unlinkSync(join(dir, a.file));
  }
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
