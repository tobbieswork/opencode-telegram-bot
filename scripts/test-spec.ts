/**
 * Unit + golden tests for src/spec.ts (task S1 of docs/sdd/spec-tasks.md).
 * The golden test reads every docs/sdd/*.md file (fs in the test only — the
 * parser itself is pure). Drift is visible, not a failure (S1.4): each file
 * must either parse to ≥1 task with plausible fields or return a named error.
 *
 * Run:  npx tsx scripts/test-spec.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, markTask, initMarkers, findRequirement, type ParsedTask } from "../src/spec.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdd = join(root, "docs", "sdd");
const read = (f: string) => readFileSync(join(sdd, f), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const isOk = (r: ReturnType<typeof parseSpec>): r is { tasks: ParsedTask[]; tasksHeadingLine: number } =>
  "tasks" in r;

/** Fields that must survive a marker/commit rewrite untouched. */
function sameExceptStatus(a: ParsedTask, b: ParsedTask): boolean {
  return (
    a.n === b.n &&
    a.id === b.id &&
    a.title === b.title &&
    a.body === b.body &&
    JSON.stringify(a.reqIds) === JSON.stringify(b.reqIds) &&
    a.checkpoint === b.checkpoint &&
    a.needs === b.needs
  );
}

function changedLineIndices(a: string, b: string): number[] | "length" {
  const la = a.split("\n");
  const lb = b.split("\n");
  if (la.length !== lb.length) return "length";
  const idx: number[] = [];
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) idx.push(i);
  return idx;
}

// ── canonical spec (spec-tasks.md) ──────────────────────────────────────────
const canonical = read("spec-tasks.md");
const cp = parseSpec(canonical);
{
  check("canonical: parses", isOk(cp), isOk(cp) ? undefined : JSON.stringify(cp));
  if (isOk(cp)) {
    const t = cp.tasks;
    check("canonical: 9 tasks", t.length === 9, `got ${t.length}`);
    check("canonical: n = 0..8", t.every((x, i) => x.n === i));
    check("canonical: heading line 120", cp.tasksHeadingLine === 120, `got ${cp.tasksHeadingLine}`);

    const t0 = t[0];
    check("task 0: done with hash c1249c0", t0.marker === "done" && t0.commit === "c1249c0", JSON.stringify(t0));
    check("task 0: id/title", t0.id === "S0" && t0.title === "Spike", JSON.stringify({ id: t0.id, title: t0.title }));
    check("task 0: checkpoint", t0.checkpoint === "confirm the answers before building S3.", JSON.stringify(t0.checkpoint));
    check("task 0: reqIds S3.2/S3.5", t0.reqIds.includes("S3.2") && t0.reqIds.includes("S3.5"), JSON.stringify(t0.reqIds));
    check("task 0: no needs", t0.needs === undefined);

    const t1 = t[1];
    check("task 1: done with commit da3ca13", t1.marker === "done" && t1.commit === "da3ca13", JSON.stringify(t1));
    check("task 1: id/title", t1.id === "S1" && t1.title === "Parser", JSON.stringify({ id: t1.id, title: t1.title }));
    check("task 1: reqIds incl. range endpoints", t1.reqIds.includes("S1.1") && t1.reqIds.includes("S1.4") && t1.reqIds.includes("S4.1") && t1.reqIds.includes("S4.3"), JSON.stringify(t1.reqIds));
    check("task 1: range S4.1 to S4.3 expanded (S4.2 present)", t1.reqIds.includes("S4.2"), JSON.stringify(t1.reqIds));
    check("task 1: checkpoint", t1.checkpoint === "review the parsed output for each spec.", JSON.stringify(t1.checkpoint));
    check("task 1: body keeps the spec file ref, drops the checkpoint", t1.body.includes("`src/spec.ts`") && !t1.body.includes("Checkpoint"), t1.body);
    check("task 1: body not rewrapped (single line)", !t1.body.includes("\n"), t1.body);

    const t8 = t[8];
    check("task 8: no checkpoint", t8.checkpoint === undefined && t8.id === "S8" && t8.title === "End to end", JSON.stringify(t8));
  }
}

// ── markerless spec (S4.3: no markers = all todo) ──────────────────────────
// Synthetic fixture: the real next-step-buttons.md is closed (all [x]) since
// the feature shipped, so the markerless code path is exercised on a literal.
const nextstep = `# Unmarked next-step spec (synthetic golden)

## Tasks

0. **S0 Read-only check.** Without any model call, read how the report behaves. *Checkpoint: confirm the data source.*
1. **S1 Engine** (N1, N2, N3.1 to N3.6). Rule table, decide, registry, encoding under 64 bytes. *Checkpoint: review the rule table.*
2. **S2 Config.** Two variables, README, .env.example.
3. **S3 Plain sessions.** Build facts, attach, tap handler.
4. **S4 Workers.** Add review to the worktree card.
5. **S5 Manager and failures.** Board after a Manager turn.
6. **S6 Audit.** Events and tap rate.
7. **S7 End-to-end.** One scenario in smoke.
`;
const np = parseSpec(nextstep);
{
  check("markerless: parses 8 tasks", isOk(np) && np.tasks.length === 8, isOk(np) ? `got ${np.tasks.length}` : JSON.stringify(np));
  if (isOk(np)) {
    check("markerless: all todo", np.tasks.every((x) => x.marker === "todo" && x.commit === undefined));
    check("markerless: no commit on task 5 (no parens in shape)", np.tasks[5].commit === undefined && np.tasks[5].title === "Manager and failures", JSON.stringify(np.tasks[5]));
    check("markerless: reqIds bare + dotted", np.tasks[1].reqIds.includes("N1") && np.tasks[1].reqIds.includes("N3.1") && np.tasks[1].reqIds.includes("N3.6"), JSON.stringify(np.tasks[1].reqIds));
    check("markerless: range N3.1 to N3.6 expanded (N3.2-N3.5 present)", [2,3,4,5].every((i) => np.tasks[1].reqIds.includes(`N3.${i}`)), JSON.stringify(np.tasks[1].reqIds));
  }
}

// ── queue-and-steer (token boundaries: "Q1.9 for plain and worker") ─────────
const queue = read("queue-and-steer.md");
const qp = parseSpec(queue);
{
  check("queue: parses 8 tasks", isOk(qp) && qp.tasks.length === 8, isOk(qp) ? `got ${qp.tasks.length}` : JSON.stringify(qp));
  if (isOk(qp)) {
    check("queue: Q1.9 not swallowed by following words", qp.tasks[3].reqIds.includes("Q1.9") && qp.tasks[3].reqIds.every((r) => !r.slice(3).includes("Q1.9")), JSON.stringify(qp.tasks[3].reqIds));
    check("queue: all tokens well-formed", qp.tasks[3].reqIds.every((r) => /^[A-Z]+\d+(\.\d+)?$/.test(r)), JSON.stringify(qp.tasks[3].reqIds));
  }
}

// ── Needs: line (multi-line body) ──────────────────────────────────────────
{
  const md = [
    "# Spec: needs",
    "",
    "## 3. Tasks",
    "",
    "1. **N1 Blocked task** (N1). Some body.",
    "Needs: live OpenCode service",
    "2. **N2 Fine.** Body here.",
  ].join("\n");
  const r = parseSpec(md);
  check("needs: parses 2 tasks", isOk(r) && r.tasks.length === 2, JSON.stringify(r));
  if (isOk(r)) {
    check("needs: captured", r.tasks[0].needs === "live OpenCode service", JSON.stringify(r.tasks[0].needs));
    check("needs: absent on task 2", r.tasks[1].needs === undefined);
  }
}

// ── error cases (S1.4: named line, never throw) ─────────────────────────────
{
  const noHeading = parseSpec("# Hi\n\nhello world\n");
  check("err: no heading → line 0 + message", !isOk(noHeading) && noHeading.error.line === 0 && noHeading.error.message.length > 0, JSON.stringify(noHeading));

  const badShape = parseSpec("## 5. Tasks\n\n1. plain text, no bold\n");
  check("err: bad item shape → line 3", !isOk(badShape) && badShape.error.line === 3, JSON.stringify(badShape));

  const badTitle = parseSpec("## 5. Tasks\n\n1. **Do the thing.** hi\n");
  check("err: title without task ID → line 3", !isOk(badTitle) && badTitle.error.line === 3 && /task ID/.test(badTitle.error.message), JSON.stringify(badTitle));

  const noItems = parseSpec("## Tasks\n\njust prose, no items\n");
  check("err: heading but no items → named error", !isOk(noItems) && noItems.error.line >= 1, JSON.stringify(noItems));
}

// ── markTask (S4.1/S4.2: exactly one line changes) ─────────────────────────
{
  const out = markTask(canonical, 1, "abc1234");
  const diff = changedLineIndices(canonical, out);
  check("markTask: exactly one line changed", JSON.stringify(diff) === JSON.stringify([122]), JSON.stringify(diff));
  const line = out.split("\n")[122];
  check("markTask: line rewritten to [x] (commit)", line === "1. [x] (abc1234) **S1 Parser** (S1.1, S1.4, S4.1 to S4.3). `src/spec.ts` and `test:spec`: parse, status rewrite, round trip, golden test over every file in `docs/sdd/`. *Checkpoint: review the parsed output for each spec.*", line);

  const re = parseSpec(out);
  check("markTask: round-trip reparse is 9 tasks", isOk(re) && re.tasks.length === 9, JSON.stringify(re));
  if (isOk(re) && isOk(cp)) {
    check("markTask: task 1 now done with commit", re.tasks[1].marker === "done" && re.tasks[1].commit === "abc1234");
    check("markTask: all other tasks identical except status", re.tasks.every((x, i) => i === 1 || sameExceptStatus(cp.tasks[i], x)));
  }
  check("markTask: idempotent", markTask(out, 1, "abc1234") === out);
  check("markTask: unknown n is a no-op", markTask(canonical, 99) === canonical);
  check("markTask: re-marking done task keeps its hash", markTask(canonical, 0) === canonical);

  // markTask WITHOUT a commit: the inserted marker must survive re-parse
  const outNC = markTask(nextstep, 0);
  const iNC = outNC.split("\n").findIndex((l) => /^0\. /.test(l));
  const lineNC = outNC.split("\n")[iNC];
  check("markTask no-commit: space after [x]", lineNC.startsWith("0. [x] **S0 Read-only check.**"), lineNC);
  const reNC = parseSpec(outNC);
  check("markTask no-commit: round-trip keeps done, no commit", isOk(reNC) && reNC.tasks[0].marker === "done" && reNC.tasks[0].commit === undefined, JSON.stringify(reNC.tasks?.[0]));

  // markerless item: marker inserted, commit appended after the marker
  const out2 = markTask(nextstep, 0, "deadbee");
  const diff2 = changedLineIndices(nextstep, out2);
  check("markTask on markerless: exactly one line changed", Array.isArray(diff2) && diff2.length === 1, JSON.stringify(diff2));
  const line2 = Array.isArray(diff2) && diff2.length === 1 ? out2.split("\n")[diff2[0]] : "";
  check("markTask on markerless: [x] (commit) after the number", line2.startsWith("0. [x] (deadbee) **S0 Read-only check.**"), line2);
  const re2 = parseSpec(out2);
  check("markTask on markerless: round-trip", isOk(re2) && re2.tasks[0].marker === "done" && re2.tasks[0].commit === "deadbee" && re2.tasks[0].title === "Read-only check", JSON.stringify(re2));
}

// ── initMarkers (S4.3: idempotent, targeted) ────────────────────────────────
{
  const out = initMarkers(nextstep);
  const diff = changedLineIndices(nextstep, out);
  check("initMarkers: all 8 item lines gained [ ]", Array.isArray(diff) && diff.length === 8, JSON.stringify(diff));
  const re = parseSpec(out);
  check("initMarkers: reparse 8 tasks, all todo", isOk(re) && re.tasks.length === 8 && re.tasks.every((x) => x.marker === "todo"), JSON.stringify(re));
  check("initMarkers: idempotent", initMarkers(out) === out);
  check("initMarkers: already-marked spec untouched", initMarkers(canonical) === canonical);
}

// ── findRequirement ─────────────────────────────────────────────────────────
{
  const r11 = findRequirement(canonical, "S1.1");
  check("findReq: S1.1 hit", r11 !== undefined && r11.startsWith("- S1.1 When the user sends `/spec`"), r11);
  check("findReq: S4.2 hit", (findRequirement(canonical, "S4.2") ?? "").includes("change only these markers"));
  check("findReq: S1 must not match S1.1", findRequirement(canonical, "S1") === undefined);
  check("findReq: miss → undefined", findRequirement(canonical, "Z9.9") === undefined);
  const q12 = findRequirement(queue, "Q1.2");
  check("findReq: queue Q1.2 hit", q12 !== undefined && q12.startsWith("- Q1.2 "), q12);
}

// ── reqId ranges (spec shorthand "X1 to X2") ───────────────────────────────
{
  const md = [
    "# Spec: ranges",
    "",
    "## 1. Requirements",
    "- S4.1 one",
    "- S4.2 two",
    "- S4.3 three",
    "- W2.9 nine",
    "",
    "## 2. Tasks",
    "",
    "1. **R1 Range.** (S4.1 to S4.3). Body.",
    "2. **R2 Reversed.** (S4.3 to S4.1). Body.",
    "3. **R3 Cross-prefix.** (S4.1 to W2.3). Body.",
    "4. **R4 Single.** (S4.2). Body.",
  ].join("\n");
  const r = parseSpec(md);
  check("ranges: parses 4 tasks", isOk(r) && r.tasks.length === 4, JSON.stringify(r));
  if (isOk(r)) {
    check("ranges: S4.1 to S4.3 → S4.1,S4.2,S4.3", JSON.stringify(r.tasks[0].reqIds) === JSON.stringify(["S4.1","S4.2","S4.3"]), JSON.stringify(r.tasks[0].reqIds));
    check("ranges: reversed range expands the same way", ["S4.1","S4.2","S4.3"].every((x) => r.tasks[1].reqIds.includes(x)), JSON.stringify(r.tasks[1].reqIds));
    check("ranges: cross-prefix is NOT expanded", JSON.stringify(r.tasks[2].reqIds) === JSON.stringify(["S4.1","W2.3"]), JSON.stringify(r.tasks[2].reqIds));
    check("ranges: single id untouched", JSON.stringify(r.tasks[3].reqIds) === JSON.stringify(["S4.2"]), JSON.stringify(r.tasks[3].reqIds));
  }
}

// ── findRequirement: multi-line (indented continuation) ─────────────────────
{
  const md = [
    "# Spec: multiline req",
    "",
    "## 1. Requirements",
    "- M1.1 First line of the requirement.",
    "  continued on the next line",
    "  and a third",
    "- M1.2 Single line requirement.",
    "",
    "## 2. Tasks",
    "",
    "1. **T1 X.** (M1.1). Body.",
  ].join("\n");
  const full = findRequirement(md, "M1.1");
  check("req multiline: continuation lines joined (keeps the - M1.1 prefix, existing contract)", full === "- M1.1 First line of the requirement. continued on the next line and a third", full);
  check("req multiline: single-line unchanged", (findRequirement(md, "M1.2") ?? "").startsWith("- M1.2 Single line requirement."), findRequirement(md, "M1.2"));
  check("req multiline: id boundary still exact", findRequirement(md, "M1") === undefined);
}

// ── fenced code blocks are not structure ────────────────────────────────────
{
  const md = [
    "# Spec: fence",
    "",
    "## 1. Requirements",
    "- F1.1 Real requirement.",
    "",
    "Example of a task list (not real):",
    "",
    "```",
    "## 5. Tasks",
    "",
    "99. **Z9 Fenced item.** Should never parse.",
    "```",
    "",
    "## 5. Tasks",
    "",
    "1. **F1 Real task.** (F1.1). Body.",
    "```",
    "- F1.1 a requirement that must not match",
    "```",
  ].join("\n");
  const r = parseSpec(md);
  check("fence: fenced Tasks heading ignored, real one parsed", isOk(r) && r.tasks.length === 1 && r.tasks[0].id === "F1", JSON.stringify(r));
  check("fence: fenced requirement line not matched", (findRequirement(md, "F1.1") ?? "").includes("Real requirement"), findRequirement(md, "F1.1"));
  const onlyFenced = parseSpec("# X\n\n```\n## 5. Tasks\n\n1. **Z9 Fenced.** x.\n```\n");
  check("fence: no real heading → named error", !isOk(onlyFenced) && onlyFenced.error.line === 0, JSON.stringify(onlyFenced));
}

// ── GOLDEN: every file in docs/sdd/ ─────────────────────────────────────────
{
  console.log("\n== golden: docs/sdd/*.md ==");
  const files = readdirSync(sdd).filter((f) => f.endsWith(".md")).sort();
  let parsed = 0;
  let skipped = 0;
  for (const f of files) {
    const md = read(f);
    const r = parseSpec(md);
    if (isOk(r)) {
      const plausible =
        r.tasks.length >= 1 &&
        r.tasks.every(
          (t) => Number.isFinite(t.n) && t.id.length > 0 && typeof t.title === "string" && typeof t.body === "string" && Array.isArray(t.reqIds),
        );
      check(`golden ${f}: contract`, plausible, JSON.stringify(r.tasks.map((t) => [t.n, t.id, t.title])));
      const ids = `${r.tasks[0].id}…${r.tasks[r.tasks.length - 1].id}`;
      console.log(`  GOLDEN  ${f.padEnd(40)} PASS  ${r.tasks.length} task(s) (${ids})`);
      parsed++;
    } else {
      check(`golden ${f}: contract (named error)`, Number.isFinite(r.error.line) && r.error.line >= 0 && r.error.message.length > 0, JSON.stringify(r));
      console.log(`  GOLDEN  ${f.padEnd(40)} SKIP  line ${r.error.line}: ${r.error.message}`);
      skipped++;
    }
  }
  const canon = parseSpec(read("spec-tasks.md"));
  check("golden: spec-tasks.md parses all 9 tasks 0..8", isOk(canon) && canon.tasks.length === 9 && canon.tasks.every((t, i) => t.n === i));
  console.log(`\ngolden: ${parsed} parsed, ${skipped} skipped (named errors above), ${failures} failure(s)`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
