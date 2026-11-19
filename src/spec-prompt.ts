/**
 * Prompt builder for spec tasks (task S3 of docs/sdd/spec-tasks.md;
 * requirements S2.2, S2.3). Pure function: builds the self-contained worker
 * prompt for one parsed task from the spec's text. No I/O, no clock, no env.
 *
 * Risk "Prompt size" (spec, design): the prompt is capped at `cap`
 * characters (default PROMPT_CAP = 6000). The task part, the working rules,
 * the tool-discipline lines (T3, ocr-hardening) and the Report schema
 * (T2, ocr-hardening) are NEVER cut. When the cap
 * would be exceeded, items are cut in priority order — requirement texts
 * (from the end of the task's reqIds backwards, then from the start), then
 * the out-of-scope section, then the verify order — and every cut is named
 * in `cut` and in a trailing "Truncated (size cap): …" line. `cut` is empty
 * ⇔ nothing was truncated.
 */
import { findRequirement, type ParsedTask } from "./spec.js";

/** Default size cap for a worker prompt (characters). */
export const PROMPT_CAP = 6000;

export interface BuiltPrompt {
  prompt: string;
  /** Human names of the parts cut to fit the cap; empty ⇔ nothing cut. */
  cut: string[];
}

const H2 = /^##\s/;

/** Fenced code blocks are data, not structure (same rule as src/spec.ts). */
function fenceToggles(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*(?:```|~~~)/.test(l)) inFence = !inFence;
    inside.push(inFence);
  }
  return inside;
}

/**
 * The spec's "Out of scope" section: a level-2 heading whose text contains
 * "out of scope" (case-insensitive; a number prefix is allowed), up to the
 * next level-2 (or higher) heading. Fence-aware, like the S1 parser.
 * undefined when the spec has no such section (or it is empty).
 */
export function outOfScopeSection(md: string): string | undefined {
  const lines = md.split(/\r?\n/);
  const fenced = fenceToggles(lines);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !H2.test(lines[i])) continue;
    if (/out\s+of\s+scope/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (!fenced[i] && H2.test(lines[i])) {
      end = i;
      break;
    }
  }
  const text = lines.slice(start, end).join("\n").trim();
  return text === "" ? undefined : text;
}

/**
 * Build the worker prompt for one parsed task.
 *
 * Sections, in order, newline-separated with short headers:
 *   Task          — the task's id, title, and body as parsed (verbatim),
 *                   plus its checkpoint sentence when the task has one.
 *   Requirements  — each of the task's reqIds with its text copied from the
 *                   spec via findRequirement; an id that cannot be resolved
 *                   is still listed, with a "(not found in spec)" marker.
 *   Out of scope  — the spec's "Out of scope" section, when the spec has one.
 *   Verify order  — the AGENTS.md order: typecheck and unit tests first,
 *                   smoke last (only when asked).
 *   Working rules — S2.3: write tests before code; make exactly one
 *                   conventional commit for this task; stop after it.
 *   Tool discipline — T3 (ocr-hardening): prompt-only budget lines — no
 *                   re-reading files already in the brief, a tool-call budget
 *                   per sub-step, no re-running green checks, no marginal
 *                   extra work.
 *   Report        — T2 (ocr-hardening): the fixed Status / Coverage / Files
 *                   / Tests / Follow-ups block the worker's final message
 *                   must end with (the host parses it on completion).
 *
 * Size cap: see the file header. A cut requirement keeps its id in place
 * with a "(text cut)" marker; a cut section disappears entirely.
 */
export function buildTaskPrompt(
  specMd: string,
  task: ParsedTask,
  cap: number = PROMPT_CAP
): BuiltPrompt {
  const taskPart = [
    `## Task ${task.id}: ${task.title}`,
    task.body,
    task.checkpoint !== undefined ? `*Checkpoint: ${task.checkpoint}*` : undefined,
  ]
    .filter((l): l is string => l !== undefined && l !== "")
    .join("\n");

  const rulePart = [
    "## Working rules",
    "- Write tests before code.",
    "- Make exactly one conventional commit for this task.",
    "- Stop after that commit — do not start the next task.",
  ].join("\n");

  // T3 (ocr-hardening): prompt-only tool-discipline budget lines (no infra).
  // Never cut, like the working rules and the report schema: the discipline
  // IS the point of the section.
  const disciplinePart = [
    "## Tool discipline",
    "- Files already shown in the brief are in context — do not re-read them.",
    "- Max 2–3 tool calls per sub-step; batch independent calls in parallel.",
    "- Do not re-run a verification command that already ran green in this session unless files it covers changed since.",
    "- End with the Report section once all sub-steps are done/skipped — do not go looking for marginal extra work.",
  ].join("\n");

  // T2 (ocr-hardening): the fixed report schema — the worker's final message
  // must END with this block; the host (postSpecCheckpoint) parses it. Part of
  // the never-cut set, like the working rules: the schema is the point.
  const reportPart = [
    "## Report",
    "End your final message with this exact block (the host parses it — keep the field names and colons verbatim):",
    "Status: DONE | BLOCKED | FAILED",
    "Coverage: each deliverable of the task, each marked done or skipped (+reason)",
    "Files: the paths you changed",
    "Tests: the verify commands you ran and their results",
    "Follow-ups: anything left for a later task (may be empty)",
  ].join("\n");

  const verifyPart = [
    "## Verify order",
    "- npm run typecheck and npm run test:unit first",
    "- npm run smoke last (only when asked)",
  ].join("\n");

  const oosText = outOfScopeSection(specMd);
  const reqLines: string[] = task.reqIds.map((id) => {
    const text = findRequirement(specMd, id);
    return text !== undefined ? text : `- ${id} (not found in spec)`;
  });
  const reqCutLine = (id: string) => `- ${id} (text cut)`;

  const cut: string[] = [];
  let cutReqCount = 0; // requirements cut, from the end of reqIds backwards
  let cutOos = false;
  let cutVerify = false;

  const render = (): string => {
    const sections: string[] = [taskPart];
    if (task.reqIds.length > 0) {
      const lines = task.reqIds.map((id, i) =>
        i >= task.reqIds.length - cutReqCount ? reqCutLine(id) : reqLines[i]
      );
      sections.push(`## Requirements\n${lines.join("\n")}`);
    }
    if (oosText !== undefined && !cutOos) sections.push(`## Out of scope\n${oosText}`);
    if (!cutVerify) sections.push(verifyPart);
    sections.push(rulePart);
    sections.push(disciplinePart);
    sections.push(reportPart);
    const body = sections.join("\n");
    return cut.length === 0 ? body : `${body}\n\nTruncated (size cap): ${cut.join(", ")}`;
  };

  while (render().length > cap) {
    let label: string;
    if (cutReqCount < task.reqIds.length) {
      cutReqCount++;
      label = `requirement ${task.reqIds[task.reqIds.length - cutReqCount]} text`;
    } else if (oosText !== undefined && !cutOos) {
      cutOos = true;
      label = "out-of-scope section";
    } else if (!cutVerify) {
      cutVerify = true;
      label = "verify order section";
    } else {
      break; // only the uncutable parts (task, working rules, tool discipline, report) remain
    }
    cut.push(label);
  }

  return { prompt: render(), cut };
}
