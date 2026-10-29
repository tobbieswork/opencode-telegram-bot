/**
 * Tests for the Mac-node git-branch task protocol (src/node/node-github.ts):
 * id format, front-matter build/parse round-trips, malformed input
 * rejection, path/tree helpers, and status classification.
 *
 * Run:  npx tsx scripts/test-node.ts
 */
import {
  NODE_BRANCH,
  buildDoneFile,
  buildTaskFile,
  claimPath,
  classifyTask,
  donePath,
  newTaskId,
  parseDoneFile,
  parseTaskFile,
  taskIdsFromTree,
  taskPath,
  type NodeDone,
  type NodeTask,
} from "../src/node/node-github.js";
import { resolveCloneUrl } from "../node/mac-daemon/git.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const TASK: NodeTask = {
  id: "nmac-a1b2",
  base: "main",
  maxTurns: 200,
  timeoutMs: 1_800_000,
  createdAt: "2026-10-29T02:00:00.000Z",
  createdBy: "8635324226",
  prompt: "Chạy typecheck rồi báo kết quả.\n\n- Điểm 1\n- Điểm 2",
};

const DONE: NodeDone = {
  id: "nmac-a1b2",
  status: "done",
  costUsd: 0.1234,
  tokensIn: 12345,
  tokensOut: 678,
  durationMs: 45_000,
  sessionId: "124156f9-7273-4536-94ff-00d11cb30164",
  codeBranch: "node/mac/nmac-a1b2",
  report: "**Kết quả:** xanh.\n\nChi tiết ở đây.",
};

// ── id + branch constants ───────────────────────────────────────────────────
{
  check("branch constant", NODE_BRANCH === "node/mac");
  const ids = new Set(Array.from({ length: 50 }, () => newTaskId()));
  check("newTaskId format", [...ids].every((s) => /^nmac-[0-9a-z]{4}$/.test(s)));
  check("newTaskId no collisions (50)", ids.size === 50);
  check("paths", taskPath("x") === "tasks/x.md" && claimPath("x") === "claims/x.lock" && donePath("x") === "done/x.md");
}

// ── task file round-trip ────────────────────────────────────────────────────
{
  const parsed = parseTaskFile(buildTaskFile(TASK));
  check("task round-trip", JSON.stringify(parsed) === JSON.stringify(TASK), JSON.stringify(parsed));
}

// ── task parse: malformed input rejected ────────────────────────────────────
{
  check("no front matter → null", parseTaskFile("just a prompt, no metadata") === null);
  const missing = buildTaskFile(TASK).replace(/^createdAt: .*\n/m, "");
  check("missing required field → null", parseTaskFile(missing) === null);
  const badNum = buildTaskFile(TASK).replace("maxTurns: 200", "maxTurns: abc");
  check("non-numeric maxTurns → null", parseTaskFile(badNum) === null);
  const zero = buildTaskFile(TASK).replace("timeoutMs: 1800000", "timeoutMs: 0");
  check("zero timeoutMs → null", parseTaskFile(zero) === null);
  const noBody = buildFrontlessTask();
  check("empty prompt → null", parseTaskFile(noBody) === null);
}

// ── task parse: unknown front-matter keys tolerated ─────────────────────────
{
  const extra = buildTaskFile(TASK).replace("---\nid:", "---\nfutureKey: 42\nid:");
  const parsed = parseTaskFile(extra);
  check("unknown key ignored", parsed !== null && JSON.stringify(parsed) === JSON.stringify(TASK));
}

function buildFrontlessTask(): string {
  return buildTaskFile(TASK).replace(/^---\n[\s\S]*?\n---\n/, "");
}

// ── done file round-trip ────────────────────────────────────────────────────
{
  const parsed = parseDoneFile(buildDoneFile(DONE));
  check("done round-trip (with codeBranch)", JSON.stringify(parsed) === JSON.stringify(DONE), JSON.stringify(parsed));
  const noBranch: NodeDone = { ...DONE, codeBranch: undefined };
  const parsed2 = parseDoneFile(buildDoneFile(noBranch));
  check("done round-trip (no codeBranch)", parsed2 !== null && parsed2.codeBranch === undefined);
}

// ── done parse: malformed input rejected ────────────────────────────────────
{
  check("done: no front matter → null", parseDoneFile("report only") === null);
  const badStatus = buildDoneFile(DONE).replace("status: done", "status: exploded");
  check("done: unknown status → null", parseDoneFile(badStatus) === null);
  const badCost = buildDoneFile(DONE).replace("costUsd: 0.1234", "costUsd: free");
  check("done: non-numeric cost → null", parseDoneFile(badCost) === null);
  const noSession = buildDoneFile(DONE).replace(/^sessionId: .*\n/m, "");
  check("done: missing sessionId → null", parseDoneFile(noSession) === null);
}

// ── tree helpers ────────────────────────────────────────────────────────────
{
  const tree = [
    "tasks/nmac-b.md",
    "tasks/nmac-a.md",
    "tasks/notes.txt",
    "tasks/sub/nmac-x.md",
    "claims/nmac-a.lock",
    "claims/stray.lock.txt",
    "done/nmac-z.md",
    "README.md",
  ];
  check("task ids from tree", JSON.stringify(taskIdsFromTree("tasks", tree)) === JSON.stringify(["nmac-a", "nmac-b"]));
  check("claim ids from tree", JSON.stringify(taskIdsFromTree("claims", tree)) === JSON.stringify(["nmac-a"]));
  check("done ids from tree", JSON.stringify(taskIdsFromTree("done", tree)) === JSON.stringify(["nmac-z"]));
}

// ── classification precedence ───────────────────────────────────────────────
{
  const files = [taskPath("a"), claimPath("a"), donePath("a")];
  check("done beats claim+task", classifyTask("a", files) === "done");
  check("claim beats task", classifyTask("a", [taskPath("a"), claimPath("a")]) === "running");
  check("task only = pending", classifyTask("a", [taskPath("a")]) === "pending");
  check("no trace = unknown", classifyTask("a", []) === "unknown");
}

// ── clone URL resolution (SSH → HTTPS, token embed) ─────────────────────────
{
  check("https untouched, no token", resolveCloneUrl("https://github.com/a/b.git", "") === "https://github.com/a/b.git");
  check("scp-style ssh → https", resolveCloneUrl("git@github.com:a/b.git", "") === "https://github.com/a/b.git");
  check("ssh:// → https", resolveCloneUrl("ssh://git@github.com/a/b.git", "") === "https://github.com/a/b.git");
  check("https + token embedded", resolveCloneUrl("https://github.com/a/b.git", "tok_123") === "https://x-access-token:tok_123@github.com/a/b.git");
  check("ssh + token → https with token", resolveCloneUrl("git@github.com:a/b.git", "tok_123") === "https://x-access-token:tok_123@github.com/a/b.git");
  check("unknown scheme + token untouched", resolveCloneUrl("ssh://git@gitlab.com/a/b.git", "t") === "ssh://git@gitlab.com/a/b.git");
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nnode protocol: all checks passed`);
