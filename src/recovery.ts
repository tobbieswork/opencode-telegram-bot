/**
 * Auto-recovery for a worker whose session died from *context overflow*.
 *
 * A worker turn that overflows the model's context window leaves its OpenCode
 * session permanently unusable (any further prompt on it just fails again). This
 * module holds the PURE decision + handoff-construction logic; the thin wiring
 * lives in `Orchestrator.respawnOverflow` (see `src/orchestrator.ts`). Keeping
 * it pure makes every rule unit-testable without a live bot (see
 * `scripts/test-recovery.ts`).
 *
 * Design: docs/design-worker-overflow-recovery.md.
 */
import { isOverflowError as matchContextOverflow } from "./format.js";
import type { WorkerStatus } from "./state.js";

/**
 * Is this error text a *context-overflow* error? Accepts `undefined` (a missing
 * error string is never an overflow). Wraps the shared predicate from
 * `format.ts` so both the interactive failure path and worker auto-recovery
 * classify with the same single regex.
 */
export function isOverflowError(error: string | undefined): boolean {
  return matchContextOverflow(error ?? "");
}

/**
 * Decide whether a just-failed worker should be auto-respawned. Pure:
 *
 *   enabled && status === "failed" && isOverflowError(error)
 *     && !respawnedFrom && hasTask
 *
 * Guards (why each is here):
 * - `enabled`            — cfg.recoverOverflow; an emergency off-switch.
 * - `status === "failed"`— `stopped` (user /kill) and `done` never respawn.
 * - `isOverflowError`    — only a context overflow is unrecoverable in-place;
 *                          rate-limit / usage-cap failures just need to wait.
 * - `!respawnedFrom`     — BUDGET: at most ONE auto-respawn per original task.
 *                          The field is persisted in state.json (survives a
 *                          restart), so a second death never spawns a third
 *                          worker.
 * - `hasTask`            — only a worker with a self-contained task gets a
 *                          useful handoff; a task-less worker stays manual.
 */
export function shouldRespawnWorker(p: {
  status: WorkerStatus;
  error?: string;
  respawnedFrom?: string;
  hasTask: boolean;
  enabled: boolean;
}): boolean {
  return p.enabled && p.status === "failed" && isOverflowError(p.error) && !p.respawnedFrom && p.hasTask;
}

/**
 * The replacement worker's name: `<old>-2`. Worker names must match NAME_RE
 * (`[a-z0-9-]`, max 24 chars), so when `<old>-2` would exceed 24 we cut the old
 * name to its first 21 chars (21 + "-2" = 23 ≤ 24). A valid old name always
 * yields a valid new one. (A name collision — extremely rare — makes spawn()
 * throw, which the wiring catches and reports.)
 */
export function respawnName(oldName: string): string {
  let base = oldName;
  if (`${base}-2`.length > 24) base = base.slice(0, 21);
  return `${base}-2`;
}

/** The one-line notice posted to the DEAD worker's topic before the respawn. */
export function respawnNotice(oldName: string, newName: string): string {
  // Names are constrained to [a-z0-9-] (NAME_RE), so they are HTML-safe as-is.
  return `⚠️ Worker <b>${oldName}</b> đầy context — đã tạo <b>${newName}</b> tiếp tục trong cùng thư mục.`;
}

/** Per-piece size caps for the handoff prompt (see design §2.1 budget). */
export const FOLLOW_UPS_MAX = 2000;
export const EVIDENCE_MAX = 1500;
export const LAST_TEXT_MAX = 1500;

/** The pieces of context carried into the replacement worker's first prompt. */
export interface HandoffParts {
  /** The original task, verbatim (already guarded by hasTask) — never truncated. */
  originalTask: string;
  /** Follow-up instructions issued before the crash, in order (omitted if empty). */
  followUps?: string[];
  /** Tail of the previous worker's last reply (or "error: …" when it had no text). */
  lastWorkerText?: string;
  /** Directory the previous worker ran in (its worktree dir, when isolated). */
  directory: string;
  /** Present when the worker ran in its own git worktree (branch + merge base). */
  worktree?: { branch: string; base: string };
  /** Git evidence: diffSummary (worktree) or gitStatusBrief (plain directory). */
  gitEvidence?: string;
  /** The raw provider error string (surfaced under "What happened"). */
  error?: string;
}

/** Truncate to `max` chars, appending an ellipsis when cut. */
function cap(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Indent every line of a (possibly multi-line) block under its bullet. */
function indent(s: string): string {
  return s.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
}

/**
 * Build the replacement worker's first task body (the five "##" sections). The
 * caller prepends `workerPreamble(name2)` (kept in the orchestrator so this
 * module stays dependency-light) — the result is the full spawn prompt.
 */
export function buildHandoffPrompt(p: HandoffParts): string {
  const out: string[] = [];

  out.push("## Original task");
  out.push(p.originalTask);

  if (p.followUps && p.followUps.length) {
    out.push("## Follow-up instructions issued before the crash (in order)");
    out.push(cap(p.followUps.join("\n"), FOLLOW_UPS_MAX));
  }

  out.push("## State where the previous worker stopped");
  const dir = p.worktree
    ? `${p.directory} (git worktree, branch ${p.worktree.branch}, base ${p.worktree.base})`
    : p.directory;
  out.push(`- Directory: ${dir}`);
  out.push("- Git evidence:");
  out.push(indent(p.gitEvidence ? cap(p.gitEvidence, EVIDENCE_MAX) : "(none)"));
  out.push("- Last message of the previous worker:");
  out.push(indent(cap(p.lastWorkerText ?? "(no text reply)", LAST_TEXT_MAX)));

  out.push("## What happened");
  out.push("The previous worker session hit the model's context limit and is permanently");
  out.push("unusable. You are a FRESH session in the SAME directory — all its on-disk");
  out.push("work (committed and uncommitted) is still there.");
  if (p.error) out.push(`Provider error: ${cap(p.error, 300)}`);

  out.push("## Rules");
  out.push("1. Do NOT redo work that is already on disk — inspect the git state first.");
  out.push("2. If a file is left half-edited/broken, fix or revert it (git checkout -- <file>) before continuing.");
  out.push("3. Finish the remaining parts of the original task. If it is already complete,");
  out.push("   verify (typecheck/tests per the repo) and report done.");
  out.push("4. END with the usual ≤10-line summary.");

  return out.join("\n");
}

/**
 * Follow-ups from RAW session messages, in any order: keep the user messages,
 * sort them oldest-first by `time.created` (the server's list order is not
 * guaranteed — cmdHistory sorts too), then drop the first (the spawn prompt).
 * The caller must pass the WHOLE session (no `limit`): in a truncated list the
 * oldest message is not the spawn prompt, and a real follow-up would be dropped.
 */
export function followUpsFromMessages(
  msgs: { type?: string; time?: { created?: number } }[],
  textOf: (m: any) => string,
): string[] {
  const users = msgs
    .filter((m) => m?.type === "user")
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    .map((m) => ({ text: textOf(m) }));
  return followUpsOf(users);
}

/**
 * Extract the follow-up instructions from a worker's user messages, given in
 * CHRONOLOGICAL order (oldest first): the first message is the spawn prompt
 * (dropped), the rest are the follow-ups. Empty texts are dropped.
 */
export function followUpsOf(userMessages: { text: string }[]): string[] {
  return userMessages
    .slice(1)
    .map((m) => m.text)
    .filter((t) => t.trim().length > 0);
}
