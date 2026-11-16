/**
 * Pure parser for the task lists in spec files (docs/sdd/*.md). No I/O —
 * file reading belongs to the caller (see scripts/test-spec.ts).
 *
 * Item shape (matches the current specs):
 *   N. [marker] (commit)? **ID Title.** body text (REQ IDs). *Checkpoint: sentence.*
 *
 * - marker: `[ ]` todo / `[x]` done — OPTIONAL; a markerless list is all
 *   todo (S4.3). Done items carry `(short-hash)` right after the marker.
 * - reqIds: tokens like `Q1.2`, `W6.1`, `S4.3` appearing in the body.
 * - checkpoint: the `*Checkpoint: ...*` sentence, if present.
 * - needs: the rest of a body line starting with `Needs:` (S2.6).
 *
 * S1.4: a list that cannot be parsed returns an error naming the first
 * failed line — never throws, never guesses.
 */

export interface ParsedTask {
  n: number;
  id: string;
  title: string;
  marker: "todo" | "done";
  commit?: string;
  body: string;
  reqIds: string[];
  checkpoint?: string;
  needs?: string;
}

export type ParseResult =
  | { tasks: ParsedTask[]; tasksHeadingLine: number }
  | { error: { line: number; message: string } };

/** `## 5. Tasks …`, `## Tasks`, `## 5.Tasks` … */
const TASKS_HEADING = /^##\s+\d*\.?\s*Tasks/i;
/** Next level-2 heading ends the tasks section (### sub-heads do not). */
const H2 = /^##\s/;
/** Start of a numbered item line. */
const ITEM_START = /^(\d+)\.\s+(.*)$/;
/**
 * Everything after `N. ` on the item's first line: optional marker, optional
 * commit hash, the bold `**ID Title.**` (trailing period may sit inside or
 * outside the bold), then the rest of the body line.
 */
const ITEM_REST =
  /^(\[[ xX]\]\s+)?(\(([0-9a-fA-F]{4,12})\)\s+)?\*\*([^*]+?)\.?\*\*\s*(.*)$/;
/** A task ID: letters + digits, e.g. S1, Q1, W2. */
const TASK_ID = /^([A-Z]+\d+)\s*(.*)$/;
/** Requirement IDs in body text: `Q1.2`, `W6.1`, bare `W2` … */
const REQ_ID = /\b[A-Z]+\d+(?:\.\d+)?\b/g;
/** Trailing `*Checkpoint: sentence.*` on the item. */
const CHECKPOINT = /\*Checkpoint:\s*([^*]*)\*\s*$/i;
const NEEDS = /^Needs:\s*/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ItemAcc {
  line: number; // 1-based line where the item starts
  n: number;
  id: string;
  title: string;
  marker: "todo" | "done";
  commit?: string;
  rest: string; // body text, checkpoint included; continuations appended
}

function isTitleOk(titleText: string): boolean {
  return TASK_ID.test(titleText);
}

function finishItem(c: ItemAcc): ParsedTask {
  let body = c.rest;
  let checkpoint: string | undefined;
  const ck = body.match(CHECKPOINT);
  if (ck) {
    checkpoint = ck[1].trim();
    body = body.slice(0, ck.index).trimEnd();
  }
  body = body.trim();
  let needs: string | undefined;
  for (const l of body.split("\n")) {
    const t = l.trim();
    if (NEEDS.test(t)) {
      needs = t.replace(NEEDS, "").trim();
      break;
    }
  }
  const reqIds: string[] = [];
  for (const m of c.rest.matchAll(REQ_ID)) {
    if (!reqIds.includes(m[0])) reqIds.push(m[0]);
  }
  const task: ParsedTask = { n: c.n, id: c.id, title: c.title, marker: c.marker, body, reqIds };
  if (c.commit !== undefined) task.commit = c.commit;
  if (checkpoint !== undefined) task.checkpoint = checkpoint;
  if (needs !== undefined) task.needs = needs;
  return task;
}

/**
 * Parse the task list of a spec. Finds the `## … Tasks` heading and reads
 * numbered items until the next `## ` heading. Item body lines continue on
 * following non-blank lines; free text after a blank line (e.g. the
 * "Verification order" note) is not part of any item.
 */
export function parseSpec(md: string): ParseResult {
  try {
    const lines = md.split(/\r?\n/);
    let heading = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TASKS_HEADING.test(lines[i])) {
        heading = i;
        break;
      }
    }
    if (heading === -1) {
      return { error: { line: 0, message: "no '## … Tasks' heading found" } };
    }

    const tasks: ParsedTask[] = [];
    let current: ItemAcc | null = null;
    const close = () => {
      if (current) {
        tasks.push(finishItem(current));
        current = null;
      }
    };

    for (let i = heading + 1; i < lines.length; i++) {
      const line = lines[i];
      if (H2.test(line)) break;
      const item = line.match(ITEM_START);
      if (item) {
        close();
        const m = item[2].match(ITEM_REST);
        if (!m) {
          return {
            error: {
              line: i + 1,
              message: "bad item shape — expected 'N. [marker] (commit)? **ID Title.** body'",
            },
          };
        }
        const titleText = m[4];
        const tm = titleText.match(TASK_ID);
        if (!tm) {
          return {
            error: {
              line: i + 1,
              message: `task title must start with a task ID (e.g. S1): "${titleText}"`,
            },
          };
        }
        current = {
          line: i + 1,
          n: parseInt(item[1], 10),
          id: tm[1],
          title: tm[2].trim(),
          marker: m[1] && m[1].includes("x") ? "done" : "todo",
          commit: m[3],
          rest: m[5],
        };
        continue;
      }
      if (line.trim() === "") {
        close();
        continue;
      }
      if (current) {
        current.rest += "\n" + line.trim();
        continue;
      }
      // free text outside any item — ignored (drift tolerance, S1.4 keeps
      // real failures visible via the item checks above)
    }
    close();

    if (tasks.length === 0) {
      return {
        error: { line: heading + 1, message: "no numbered task items found under the Tasks heading" },
      };
    }
    return { tasks, tasksHeadingLine: heading + 1 };
  } catch (e) {
    // never throw (S1.4) — surface an unexpected failure as a named error
    return { error: { line: 0, message: `unexpected parse failure: ${String(e)}` } };
  }
}

/**
 * Find the line (0-based) of the first, fully well-formed item with number n
 * in the tasks section; -1 if absent.
 */
function locateTaskLine(lines: string[], n: number): number {
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TASKS_HEADING.test(lines[i])) {
      heading = i;
      break;
    }
  }
  if (heading === -1) return -1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (H2.test(lines[i])) break;
    const item = lines[i].match(ITEM_START);
    if (!item || parseInt(item[1], 10) !== n) continue;
    const m = item[2].match(ITEM_REST);
    if (m && isTitleOk(m[4])) return i;
  }
  return -1;
}

/**
 * S4.1/S4.2: mark task n done. Changes ONLY the item's line: `[ ]` → `[x]`
 * (inserting the marker on markerless items), and appends `(commit)` right
 * after the marker when given (replacing an existing hash). A no-op when the
 * task cannot be found or parsed. No reformat or rewrap of any other line.
 */
export function markTask(md: string, n: number, commit?: string): string {
  const lines = md.split(/\r?\n/);
  const idx = locateTaskLine(lines, n);
  if (idx === -1) return md;
  const m = lines[idx].match(/^(\s*\d+\.\s+)(\[[ xX]\]\s+)?(\(([0-9a-fA-F]{4,12})\)\s+)?(.*)$/);
  if (!m) return md;
  const [, num, , , hash, rest] = m;
  const keep = commit ?? hash;
  lines[idx] = `${num}[x]${keep ? ` (${keep}) ` : ""}${rest}`;
  return lines.join("\n");
}

/**
 * S4.3: add `[ ]` after the number of every well-formed task line that has
 * no marker yet. Targeted line replaces only; already-marked lines are
 * untouched, so the result is idempotent.
 */
export function initMarkers(md: string): string {
  const lines = md.split(/\r?\n/);
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TASKS_HEADING.test(lines[i])) {
      heading = i;
      break;
    }
  }
  if (heading === -1) return md;
  for (let i = heading + 1; i < lines.length; i++) {
    if (H2.test(lines[i])) break;
    const item = lines[i].match(ITEM_START);
    if (!item) continue;
    const m = item[2].match(ITEM_REST);
    if (!m || !isTitleOk(m[4])) continue;
    if (!item[2].startsWith("[")) {
      lines[i] = `${item[1]}. [ ] ${item[2]}`;
    }
  }
  return lines.join("\n");
}

/**
 * Look up a requirement by line prefix `- <id>` in the spec's requirement
 * section (the `## … Requirements …` section, if the spec has one; otherwise
 * the whole document). Returns the line text, trimmed, or undefined.
 */
export function findRequirement(md: string, id: string): string | undefined {
  const lines = md.split(/\r?\n/);
  const re = new RegExp(`^\\s*-\\s*(?:\\*\\*)?${escapeRe(id)}(?:\\*\\*)?(?=\\s|$)`);
  let start = 0;
  let end = lines.length;
  let inReq = false;
  for (let i = 0; i < lines.length; i++) {
    if (H2.test(lines[i])) {
      if (inReq) {
        end = i;
        break;
      }
      if (/requirements/i.test(lines[i])) {
        inReq = true;
        start = i + 1;
      }
    }
  }
  const scope = inReq ? lines.slice(start, end) : lines;
  const found = scope.find((l) => re.test(l));
  return found === undefined ? undefined : found.trim();
}
