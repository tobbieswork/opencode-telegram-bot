/**
 * Shared, language-aware rendering of the worker spawn intro card and the
 * Manager-confirm card. Extracted from Orchestrator (src/orchestrator.ts) as
 * PURE functions — each takes the user's `lang` first and renders via the i18n
 * table — so the Orchestrator stays the only place that knows the Telegram
 * conv while the text-building logic is testable in isolation.
 *
 * For lang = "en" (the default) the output matches the original hardcoded
 * wording byte-for-byte; "vi" swaps in the Vietnamese strings from STRINGS.
 */
import type { Lang } from "../state.js";
import { tr, STRINGS } from "../i18n.js";
import { esc, trunc } from "../format.js";

/** The worktree info a worker intro may carry (branch + base only). */
interface WorktreeLike {
  branch: string;
  base: string;
}

/** The minimal spawn shape the worker intro renders. */
export interface SpawnIntro {
  name: string;
  agent: string;
  directory: string;
  spawnedBy: "user" | "manager" | "schedule";
  task?: string;
  worktree?: WorktreeLike;
}

/**
 * The card posted to a worker's topic on spawn. Localized by `lang`: "en"
 * reproduces the original wording exactly.
 */
export function workerIntroHtml(lang: Lang, spec: SpawnIntro): string {
  const who = spec.spawnedBy === "manager" ? ` · ${tr(lang, STRINGS.worker_assigned_by.vi, STRINGS.worker_assigned_by.en)}` : "";
  const lines = [
    `🧩 <b>Worker ${esc(spec.name)}</b> · ${esc(spec.agent)}${who}`,
    `📁 <code>${esc(spec.directory)}</code>`,
  ];
  if (spec.worktree) {
    const from = lang === "en" ? "from" : "từ";
    lines.push(`🌿 ${tr(lang, STRINGS.worker_worktree.vi, STRINGS.worker_worktree.en)} <code>${esc(spec.worktree.branch)}</code> (${from} <code>${esc(spec.worktree.base)}</code>)`);
  }
  lines.push("");
  if (spec.task) lines.push(`📝 <b>${tr(lang, STRINGS.worker_task.vi, STRINGS.worker_task.en)}</b>\n${esc(trunc(spec.task, 1500))}`);
  else lines.push(tr(lang, STRINGS.worker_message_topic.vi, STRINGS.worker_message_topic.en));
  return lines.join("\n");
}

/** A Manager-confirm card: a spawn or a follow-up send. */
export interface ApprovalCard {
  kind: "spawn" | "send";
  spawn?: {
    name: string;
    agent?: string;
    directory: string;
    task?: string;
    writes?: boolean;
  };
  send?: { name: string; message: string };
}

/**
 * The full lines of a Manager-confirm card (header + bullets; the ✅/❌ buttons
 * are added by the caller). Localized by `lang`: "en" is fully English, "vi"
 * fully Vietnamese. The previous card was mixed-language; this unifies it.
 */
export function approvalLines(lang: Lang, ap: ApprovalCard): string[] {
  const lines = [`🛂 <b>${tr(lang, STRINGS.approval_assign.vi, STRINGS.approval_assign.en)}</b>`];
  if (ap.kind === "spawn" && ap.spawn) {
    const s = ap.spawn;
    lines.push(
      `${tr(lang, STRINGS.approval_new_worker.vi, STRINGS.approval_new_worker.en)}: <b>${esc(s.name)}</b> · ${esc(s.agent ?? "build")}${s.writes === false ? ` · ${tr(lang, STRINGS.approval_read_only.vi, STRINGS.approval_read_only.en)}` : ""}`,
      `📁 <code>${esc(s.directory)}</code>`,
      "",
      esc(trunc(s.task ?? "", 1500)),
    );
  } else if (ap.kind === "send" && ap.send) {
    lines.push(`${tr(lang, STRINGS.approval_send_to.vi, STRINGS.approval_send_to.en)} <b>${esc(ap.send.name)}</b>:`, "", esc(trunc(ap.send.message, 1500)));
  }
  return lines;
}
