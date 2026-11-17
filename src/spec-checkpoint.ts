/**
 * S5 (checkpoint card) — pure builders for the spec-task checkpoint message
 * (S3.1, S3.2, S3.3, S3.7). No I/O: the orchestrator gathers the facts (spec
 * re-parse, git, recorded shell results) and hands them to these functions.
 *
 * S3.2 — "ran / not run" is built from the worker's ACTUAL command results,
 * never from its own claim. A shell tool item is classified three-way (the
 * semantics verified live in the S0 findings, docs/sdd/spec-tasks.md §7):
 *   - state.status === "error"                    → not run (errored): the
 *     tool failed before the command ran; carry its error message.
 *   - state.status === "completed", exit !== 0    → ran, FAILED.
 *   - state.status === "completed", exit === 0    → ran, passed.
 * Anything else (pending/running, or a check with no item at all) is "not run".
 *
 * Retry-aware (user decision 2026-11-17): for each check name, the LAST
 * recorded occurrence wins. A worker that fails a verify command, fixes the
 * environment (e.g. `npm ci`), and re-runs it to green left the task in a
 * passing state — the card shows the final state, not the first stumble.
 * A check that failed and was never re-run still fails.
 *
 * S3.3 — the card carries Accept / Redo with note / Stop buttons.
 * S3.7 — an errored run, or a run without a commit, says so and offers Redo
 * with note + Stop ONLY (never Accept).
 *
 * Every user-facing string is bilingual via tr() (S6.3) and every
 * interpolated value is HTML-escaped (the card is sent as Telegram HTML).
 */
import type { ParsedTask } from "./spec.js";
import { tr } from "./i18n.js";
import type { Lang } from "./state.js";
import { esc } from "./format.js";
import type { Btn } from "./shared.js";

/** One recorded check result (a classified shell item). */
export interface RanCheck {
  /** The check name derived from the command (e.g. "typecheck"). */
  name: string;
  /** true = ran and passed; false = ran and failed, or errored before running. */
  ok: boolean;
  /** Present when the item had status "error" (the command never ran). */
  error?: string;
}

/**
 * The canonical verify checks, in AGENTS.md's verify order (typecheck and the
 * unit tests first, smoke last). A check of this set with no recorded result
 * counts as "not run" (S3.2).
 */
export const EXPECTED_CHECKS = ["typecheck", "test:unit", "smoke"];

/**
 * Derive a check name from a raw shell command line. `npm run <script>` (and
 * the pnpm/yarn equivalents) yields the script name; anything else yields the
 * first command segment's first token. A wrapped command
 * (`cmd; echo exit:$?`) is named from its FIRST segment, so the wrapper never
 * hides the check (S0 findings).
 */
export function checkNameFromCommand(cmd: string): string {
  const first = (cmd.split(/;|&&|\|\||\|/)[0] ?? "").trim();
  const tokens = first.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && (tokens[0] === "npm" || tokens[0] === "pnpm") && tokens[1] === "run") {
    return tokens[2];
  }
  if (tokens.length >= 3 && tokens[0] === "yarn" && tokens[1] === "run") return tokens[2];
  if (tokens.length >= 2 && tokens[0] === "yarn") return tokens[1];
  return tokens[0] ?? first;
}

/**
 * S3.2 — classify a worker's shell tool items into their run results.
 * `items` are duck-typed `{ state?: { status, input, metadata?, error? } }`
 * (the `{ type:"tool", name:"shell", state }` items of a session's messages);
 * non-shell / stateless items are ignored.
 */
export function classifyShellItems(items: Array<{ state?: any }>): { ran: RanCheck[] } {
  const entries: RanCheck[] = [];
  const byName = new Map<string, RanCheck>();
  for (const it of items ?? []) {
    const st = it?.state;
    if (!st) continue;
    const cmd = typeof st.input?.command === "string" ? st.input.command : "";
    if (!cmd) continue;
    const name = checkNameFromCommand(cmd);
    let e: RanCheck;
    if (st.status === "error") {
      const msg = st.error?.message != null ? String(st.error.message) : "tool error";
      e = { name, ok: false, error: msg };
    } else if (st.status === "completed") {
      // exit 0 → passed; any other exit (incl. a masked wrapper exit) → failed.
      e = { name, ok: st.metadata?.exit === 0 };
    } else {
      // "pending" / "running" / unknown: no recorded result → not run.
      continue;
    }
    // Retry-aware: the last recorded occurrence per check name wins; the
    // display keeps first-seen order.
    if (byName.has(name)) byName.set(name, e);
    else { byName.set(name, e); entries.push(e); }
  }
  return { ran: entries.map((x) => byName.get(x.name)!) };
}

/** S3.2 — the expected checks with no recorded result, in verify order. */
export function computeNotRan(ran: RanCheck[]): string[] {
  const seen = new Set(ran.map((r) => r.name));
  return EXPECTED_CHECKS.filter((c) => !seen.has(c));
}

/**
 * S4.3: the exact subject of the marker commit that ensureSpecMarkers makes
 * on the spec branch. The marker is the orchestrator's own commit, not the
 * worker's work — so it is excluded from "the worker's commits".
 */
export function markerCommitSubject(spec: string): string {
  return `docs: add S4 task markers to ${spec}.md`;
}

/**
 * S6.4 — parse `git log --format=%h %s` output (newest first) into
 * { hash, subject } commits, excluding the S4 marker commit. Blank lines and
 * hash-only lines are ignored. The caller scopes the range (e.g. `base..HEAD`);
 * this only filters + parses.
 */
export function workerCommitsSinceFork(
  lines: string[],
  spec: string,
): { hash: string; subject: string }[] {
  const marker = markerCommitSubject(spec);
  const out: { hash: string; subject: string }[] = [];
  for (const raw of lines ?? []) {
    const line = String(raw).trim();
    const sp = line.indexOf(" ");
    if (sp < 1) continue;
    const subject = line.slice(sp + 1).trim();
    if (subject === marker) continue;
    out.push({ hash: line.slice(0, sp), subject });
  }
  return out;
}

/**
 * The audit outcome of a run (S6.2 `spec_checkpoint.meta.outcome`):
 * "error" (ended in error) > "no-commit" (no worker commit) > "fail" (a check
 * failed) > "pass".
 */
export function checkpointOutcome(
  commit: { hash: string; subject: string } | undefined,
  ran: RanCheck[],
  errored: boolean,
): "pass" | "fail" | "error" | "no-commit" {
  if (errored) return "error";
  if (!commit) return "no-commit";
  if (ran.some((c) => !c.ok)) return "fail";
  return "pass";
}

export interface CheckpointCardArgs {
  /** The re-parsed spec task (id, n, title, checkpoint sentence). */
  task: ParsedTask;
  workerName: string;
  /** The spec branch (`spec/<name>`); the spec name is derived from it. */
  branch: string;
  /** The worker's commit since the fork, when there is one (S3.7: may be none). */
  commit?: { hash: string; subject: string };
  /** Files changed since the fork (best-effort; omit the section when absent). */
  files?: string[];
  checks: { ran: RanCheck[]; notRan: string[] };
  /** S3.7: the run ended in error (failed/stopped, or an errored shell item). */
  errored: boolean;
  lang: Lang;
}

export interface CheckpointCard {
  text: string;
  keyboard: { inline_keyboard: Btn[][] };
}

/** S3.3 button labels (bilingual). */
function buttonLabels(lang: Lang): { accept: string; redo: string; stop: string } {
  return {
    accept: tr(lang, "✅ Chấp nhận", "✅ Accept"),
    redo: tr(lang, "🔁 Làm lại kèm ghi chú", "🔁 Redo with note"),
    stop: tr(lang, "⏹ Dừng", "⏹ Stop"),
  };
}

/**
 * S3.1/S3.3/S3.7 — render the checkpoint card. Pure: every fact is passed in.
 * The card carries the task id, the commit (short hash + subject), the files
 * changed, the checks run with their result, the checks NOT run, and the
 * task's checkpoint sentence. An errored run or a run without a commit says so
 * and offers Redo with note + Stop ONLY (no Accept).
 */
export function renderCheckpointCard(args: CheckpointCardArgs): CheckpointCard {
  const { task, workerName, branch, commit, files, checks, errored, lang } = args;
  const spec = branch.startsWith("spec/") ? branch.slice("spec/".length) : branch;
  const canAccept = !errored && !!commit; // S3.7: never offer Accept otherwise
  const lines: string[] = [];

  // Header — the outcome icon makes a failing card impossible to miss.
  lines.push(
    tr(
      lang,
      `${canAccept ? "✅" : "❌"} <b>Checkpoint</b> — task <b>${esc(task.id)}</b> ${esc(task.title)}`,
      `${canAccept ? "✅" : "❌"} <b>Checkpoint</b> — task <b>${esc(task.id)}</b> ${esc(task.title)}`,
    ),
  );
  lines.push(
    tr(
      lang,
      `🧩 Worker: <b>${esc(workerName)}</b> · <code>${esc(branch)}</code>`,
      `🧩 Worker: <b>${esc(workerName)}</b> · <code>${esc(branch)}</code>`,
    ),
  );

  // S3.7 — say it explicitly.
  if (errored) {
    lines.push(tr(lang, "❌ Worker kết thúc với lỗi — chưa thể chấp nhận.", "❌ The worker ended in an error — it can't be accepted."));
  } else if (!commit) {
    lines.push(
      tr(
        lang,
        "⚠️ Không có commit nào trên nhánh kể từ khi fork — chưa thể chấp nhận.",
        "⚠️ No commit on the branch since the fork — it can't be accepted.",
      ),
    );
  }

  // S3.1 — the commit (short hash + subject); the section is omitted when absent.
  if (commit) {
    lines.push(`${tr(lang, "📝 Commit", "📝 Commit")}: <code>${esc(commit.hash)}</code> ${esc(commit.subject)}`);
  }

  // S3.1 — the files changed (best-effort section, omitted when absent).
  if (files && files.length) {
    lines.push(tr(lang, "📄 Files đã thay đổi:", "📄 Files changed:"));
    for (const f of files) lines.push(`• <code>${esc(f)}</code>`);
  }

  // S3.1 — the checks that were run, with their result.
  if (checks.ran.length) {
    lines.push(tr(lang, "✅ Checks đã chạy:", "✅ Checks run:"));
    for (const c of checks.ran) {
      if (c.ok) lines.push(`• <b>${esc(c.name)}</b> ✅`);
      else if (c.error !== undefined) lines.push(`• <b>${esc(c.name)}</b> ❌ (chưa chạy) — <i>${esc(c.error)}</i>`);
      else lines.push(`• <b>${esc(c.name)}</b> ❌`);
    }
  }

  // S3.1 — the checks that were NOT run.
  if (checks.notRan.length) {
    lines.push(tr(lang, "⚠️ Checks CHƯA chạy:", "⚠️ Checks NOT run:"));
    for (const c of checks.notRan) lines.push(`• <b>${esc(c)}</b>`);
  }

  // S3.1 — the task's checkpoint sentence from the spec.
  if (task.checkpoint) {
    lines.push(`${tr(lang, "💬 Checkpoint", "💬 Checkpoint")}: <i>${esc(task.checkpoint)}</i>`);
  }

  // S3.3 — the buttons (S3.7: no Accept for errored / no-commit runs).
  const labels = buttonLabels(lang);
  const buttons: Btn[] = [];
  if (canAccept) buttons.push({ text: labels.accept, callback_data: `spcacc:${spec}:${task.n}` });
  buttons.push({ text: labels.redo, callback_data: `spcredo:${spec}:${task.n}` });
  buttons.push({ text: labels.stop, callback_data: `spcstop:${spec}:${task.n}` });

  return { text: lines.join("\n"), keyboard: { inline_keyboard: buttons.map((b) => [b]) } };
}
