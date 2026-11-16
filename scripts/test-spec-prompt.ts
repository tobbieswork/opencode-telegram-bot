/**
 * Unit tests for src/spec-prompt.ts (task S3 of docs/sdd/spec-tasks.md,
 * requirements S2.2, S2.3 + the "Prompt size" risk).
 *
 * Run:  npx tsx scripts/test-spec-prompt.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, findRequirement, type ParsedTask } from "../src/spec.js";
import { buildTaskPrompt, PROMPT_CAP } from "../src/spec-prompt.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = readFileSync(join(root, "docs", "sdd", "spec-tasks.md"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const RULE_LINES = [
  "Write tests before code.",
  "Make exactly one conventional commit for this task.",
  "do not start the next task.",
];

// ── real spec: tasks n=3, n=4, n=5 ─────────────────────────────────────────
const parsed = parseSpec(spec);
if (!("tasks" in parsed)) {
  console.error("FAIL  spec-tasks.md no longer parses:", JSON.stringify(parsed));
  process.exit(1);
}
const byN = (n: number): ParsedTask => {
  const t = parsed.tasks.find((x) => x.n === n);
  if (!t) throw new Error(`task n=${n} not found`);
  return t;
};

for (const n of [3, 4, 5]) {
  const t = byN(n);
  const { prompt, cut } = buildTaskPrompt(spec, t);
  check(`n=${n} (${t.id}): cut empty at default cap`, cut.length === 0, JSON.stringify(cut));
  check(`n=${n}: prompt within default cap`, prompt.length <= PROMPT_CAP, `len ${prompt.length}`);
  check(`n=${n}: id + title header`, prompt.includes(`## Task ${t.id}: ${t.title}`));
  check(`n=${n}: full body verbatim`, prompt.includes(t.body));
  if (t.checkpoint !== undefined)
    check(`n=${n}: checkpoint sentence kept`, prompt.includes(`*Checkpoint: ${t.checkpoint}*`));
  for (const id of t.reqIds) {
    const text = findRequirement(spec, id);
    check(
      `n=${n}: requirement ${id} copied verbatim`,
      text !== undefined && prompt.includes(text),
      text === undefined ? "id not resolvable in spec" : "text missing from prompt"
    );
  }
  check(`n=${n}: out-of-scope section included`, prompt.includes("## Out of scope") &&
    prompt.includes("Parallel tasks, auto-run of the next task, scheduled runs."));
  check(
    `n=${n}: verify order (typecheck+unit first, smoke last)`,
    prompt.includes("- npm run typecheck and npm run test:unit first") &&
      prompt.includes("- npm run smoke last (only when asked)")
  );
  check(`n=${n}: working rules present`, RULE_LINES.every((l) => prompt.includes(l)));
}

// ── synthetic long spec: cap must hold, cuts named, fixed parts intact ─────
const filler =
  "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const longSpec = [
  "# Long spec",
  "",
  "## 1. Requirements",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `- L${i}.1 Long requirement ${i}. ${filler.repeat(6)}`),
  "",
  "## 2. Tasks",
  `1. [ ] **T1 Big.** Do the big thing (L1.1, L2.1, L3.1, L4.1, L5.1, L6.1, L7.1, L8.1, L9.1, L10.1). ${filler.repeat(4)} *Checkpoint: verify.*`,
  "",
  "## 3. Out of scope",
  "- Things that are not in scope, listed here for the long spec.",
  "",
].join("\n");

{
  const lp = parseSpec(longSpec);
  if (!("tasks" in lp) || lp.tasks.length !== 1) {
    console.error("FAIL  long spec: expected exactly 1 task", JSON.stringify(lp));
    process.exit(1);
  }
  const t = lp.tasks[0];
  check("long: task has 10 requirement ids", t.reqIds.length === 10, JSON.stringify(t.reqIds));
  const { prompt, cut } = buildTaskPrompt(longSpec, t);
  check("long: prompt within cap", prompt.length <= PROMPT_CAP, `len ${prompt.length}`);
  check("long: something was cut", cut.length > 0);
  check(
    "long: every cut item named as a requirement text",
    cut.every((c) => /^requirement L\d+\.1 text$/.test(c)),
    JSON.stringify(cut)
  );
  check("long: first cut is the LAST-named requirement", cut[0] === "requirement L10.1 text", JSON.stringify(cut));
  check("long: task body still fully present", prompt.includes(t.body));
  check("long: working rules still fully present", RULE_LINES.every((l) => prompt.includes(l)));
  check("long: prompt ends with the truncation line", prompt.endsWith(`Truncated (size cap): ${cut.join(", ")}`));
  const firstCutId = cut[0].replace("requirement ", "").replace(" text", "");
  check("long: cut requirement keeps its id with a marker", prompt.includes(`- ${firstCutId} (text cut)`));
}

// ── synthetic spec with NO "Out of scope" section ───────────────────────────
const noOosSpec = `# No OOS spec

## 1. Requirements
- Y1.1 A simple requirement.

## 2. Tasks
1. [ ] **T1 Task.** Do it (Y1.1).
`;
{
  const np = parseSpec(noOosSpec);
  if (!("tasks" in np)) {
    console.error("FAIL  noOos spec: parse failed", JSON.stringify(np));
    process.exit(1);
  }
  const { prompt, cut } = buildTaskPrompt(noOosSpec, np.tasks[0]);
  check("noOos: builds without error", typeof prompt === "string" && prompt.length > 0);
  check("noOos: no out-of-scope part", !prompt.includes("Out of scope"));
  check("noOos: requirement still included", prompt.includes("- Y1.1 A simple requirement."));
  check("noOos: nothing cut", cut.length === 0, JSON.stringify(cut));
}

// ── task naming a requirement id that does not exist in the spec ────────────
const missingReqSpec = `# Missing req spec

## 1. Requirements
- Z1.1 A real requirement.

## 2. Tasks
1. [ ] **T1 Task.** Do it (Z1.1, Z9.9).
`;
{
  const mp = parseSpec(missingReqSpec);
  if (!("tasks" in mp)) {
    console.error("FAIL  missingReq spec: parse failed", JSON.stringify(mp));
    process.exit(1);
  }
  const { prompt, cut } = buildTaskPrompt(missingReqSpec, mp.tasks[0]);
  check("missingReq: real id copied verbatim", prompt.includes("- Z1.1 A real requirement."));
  check("missingReq: absent id listed, not dropped", prompt.includes("- Z9.9 (not found in spec)"));
  check("missingReq: nothing cut", cut.length === 0, JSON.stringify(cut));
}

// ── forced cap on a real task: full cut priority chain ──────────────────────
{
  const t = byN(3); // reqIds [S2.2, S2.3]
  const cap = 500;
  const { prompt, cut } = buildTaskPrompt(spec, t, cap);
  check("forced cap: within the given cap", prompt.length <= cap, `len ${prompt.length}`);
  check("forced cap: cut reqs from the end backwards first", cut[0] === "requirement S2.3 text" && cut[1] === "requirement S2.2 text", JSON.stringify(cut));
  check("forced cap: out-of-scope cut before verify order", cut[2] === "out-of-scope section" && (cut.length < 4 || cut[3] === "verify order section"), JSON.stringify(cut));
  check("forced cap: task body still fully present", prompt.includes(t.body));
  check("forced cap: working rules still fully present", RULE_LINES.every((l) => prompt.includes(l)));
  check("forced cap: prompt ends with the truncation line", prompt.endsWith(`Truncated (size cap): ${cut.join(", ")}`));
}

check("PROMPT_CAP is 6000", PROMPT_CAP === 6000);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
