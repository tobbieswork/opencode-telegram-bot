/**
 * The Mac-node task protocol, carried over a single git branch (`node/mac`).
 *
 * The hub and the Mac daemon exchange plain markdown files with a small
 * `key: value` front matter, so every task is inspectable in git history
 * and the protocol stays greppable by a human (and by a future adapter for
 * other nodes/executors):
 *
 *   node/mac (branch)
 *   ├── tasks/<id>.md     hub → daemon: the task to run
 *   ├── claims/<id>.lock  daemon: "I am working on this"
 *   └── done/<id>.md      daemon → hub: the report
 *
 * This module is PURE (no I/O): id generation, file build/parse, path and
 * status helpers only. The I/O side lives in mac-node.ts (hub: fetch,
 * commit, push, relay) and node/mac-daemon/ (Mac: the polling loop).
 */
import { randomInt } from "node:crypto";

/** The single branch that carries the node/mac task files. */
export const NODE_BRANCH = "node/mac";
/** Human-readable node label used in chat reports. */
export const NODE_NAME = "mac";

export const TASKS_DIR = "tasks";
export const CLAIMS_DIR = "claims";
export const DONE_DIR = "done";

/** A task the hub queues for the Mac node. */
export interface NodeTask {
  /** Task id, "nmac-xxxx". */
  id: string;
  /** Git ref in the task repo to check out as the worktree base. */
  base: string;
  /** Max Claude agent turns for this run. */
  maxTurns: number;
  /** Hard wall-clock cap for the run, ms (the daemon kills the run at this). */
  timeoutMs: number;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Telegram user id of the person who queued the task. */
  createdBy: string;
  /** The prompt itself (markdown; everything after the front matter). */
  prompt: string;
}

export type NodeTaskStatus = "done" | "failed" | "timeout";

/** The report the Mac daemon files when a task ends. */
export interface NodeDone {
  id: string;
  status: NodeTaskStatus;
  /** Total USD cost reported by Claude (0 when the run never started). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  /** Claude session id — enables follow-ups via `claude --resume`. */
  sessionId: string;
  /** Branch with the task's code changes (only set when files changed). */
  codeBranch?: string;
  /** The report body (markdown; everything after the front matter). */
  report: string;
}

// ── ids + paths ─────────────────────────────────────────────────────────────

/** Fresh task id: "nmac-" + 4 base36 chars (same style as schedule ids). */
export function newTaskId(): string {
  return "nmac-" + randomInt(36 ** 4).toString(36).padStart(4, "0");
}

export function taskPath(id: string): string {
  return `${TASKS_DIR}/${id}.md`;
}

export function claimPath(id: string): string {
  return `${CLAIMS_DIR}/${id}.lock`;
}

export function donePath(id: string): string {
  return `${DONE_DIR}/${id}.md`;
}

/**
 * Extract task ids from a flat list of branch file paths (e.g. the output
 * of `git ls-tree -r --name-only`). Only `<dir>/<id>.md` or `.lock` names
 * directly under the directory count.
 */
export function taskIdsFromTree(dir: string, entries: Iterable<string>): string[] {
  const prefix = `${dir}/`;
  const suffix = dir === CLAIMS_DIR ? ".lock" : ".md";
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue;
    const rest = e.slice(prefix.length);
    if (rest.includes("/") || !rest.endsWith(suffix)) continue;
    out.add(rest.slice(0, -suffix.length));
  }
  return [...out].sort();
}

/**
 * What the branch says about one task, given the current file list.
 * Precedence: a done file wins (the run finished), then a claim (running),
 * then the task file (pending). "unknown" = no trace on the branch.
 */
export function classifyTask(
  id: string,
  files: Iterable<string>,
): "pending" | "running" | "done" | "unknown" {
  const list = [...files];
  if (list.includes(donePath(id))) return "done";
  if (list.includes(claimPath(id))) return "running";
  if (list.includes(taskPath(id))) return "pending";
  return "unknown";
}

// ── front matter ────────────────────────────────────────────────────────────

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a file into { fields, body }. Returns null when no front matter. */
function splitFront(text: string): { fields: Map<string, string>; body: string } | null {
  const m = FRONT_RE.exec(text);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue; // tolerate blank/malformed lines; validation below
    fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { fields, body: text.slice(m[0].length).replace(/\n$/, "") };
}

function buildFront(fields: Record<string, string>): string {
  return "---\n" + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n";
}

// ── task file ───────────────────────────────────────────────────────────────

export function buildTaskFile(t: NodeTask): string {
  return (
    buildFront({
      id: t.id,
      base: t.base,
      maxTurns: String(t.maxTurns),
      timeoutMs: String(t.timeoutMs),
      createdAt: t.createdAt,
      createdBy: t.createdBy,
    }) +
    t.prompt
  );
}

export function parseTaskFile(text: string): NodeTask | null {
  const f = splitFront(text);
  if (!f) return null;
  const id = f.fields.get("id");
  const base = f.fields.get("base");
  const maxTurns = Number(f.fields.get("maxTurns"));
  const timeoutMs = Number(f.fields.get("timeoutMs"));
  const createdAt = f.fields.get("createdAt");
  const createdBy = f.fields.get("createdBy");
  if (!id || !base || !createdAt || !createdBy) return null;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  if (!f.body.trim()) return null;
  return { id, base, maxTurns, timeoutMs, createdAt, createdBy, prompt: f.body };
}

// ── done file ───────────────────────────────────────────────────────────────

export function buildDoneFile(d: NodeDone): string {
  const fields: Record<string, string> = {
    id: d.id,
    status: d.status,
    costUsd: String(d.costUsd),
    tokensIn: String(d.tokensIn),
    tokensOut: String(d.tokensOut),
    durationMs: String(d.durationMs),
    sessionId: d.sessionId,
  };
  if (d.codeBranch) fields.codeBranch = d.codeBranch;
  return buildFront(fields) + d.report;
}

export function parseDoneFile(text: string): NodeDone | null {
  const f = splitFront(text);
  if (!f) return null;
  const id = f.fields.get("id");
  const status = f.fields.get("status");
  const costUsd = Number(f.fields.get("costUsd"));
  const tokensIn = Number(f.fields.get("tokensIn"));
  const tokensOut = Number(f.fields.get("tokensOut"));
  const durationMs = Number(f.fields.get("durationMs"));
  const sessionId = f.fields.get("sessionId");
  const codeBranch = f.fields.get("codeBranch") || undefined;
  if (!id || !status || !sessionId) return null;
  if (status !== "done" && status !== "failed" && status !== "timeout") return null;
  if (!Number.isFinite(costUsd) || !Number.isInteger(tokensIn) || !Number.isInteger(tokensOut) || !Number.isFinite(durationMs)) {
    return null;
  }
  return { id, status, costUsd, tokensIn, tokensOut, durationMs, sessionId, codeBranch, report: f.body };
}
