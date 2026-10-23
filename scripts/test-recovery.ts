/**
 * Checks the pure auto-recovery logic: context-overflow detection, the
 * respawn decision table (incl. the one-respawn-per-task budget), the
 * replacement-name clamp, and the handoff-prompt construction (sections, caps,
 * empty follow-ups omission). No live bot needed.
 *
 * Run:  npx tsx scripts/test-recovery.ts
 */
import {
  isOverflowError,
  shouldRespawnWorker,
  respawnName,
  respawnNotice,
  buildHandoffPrompt,
  followUpsOf,
  followUpsFromMessages,
  FOLLOW_UPS_MAX,
  EVIDENCE_MAX,
  LAST_TEXT_MAX,
} from "../src/recovery.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Worker names must look like this (mirrors the orchestrator's NAME_RE). */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

// The real litellm overflow string observed in the wild (design §0.2).
const OVF = "Requested token count exceeds the model's maximum context length of 160000 tokens";

// ── isOverflowError: the shared predicate ────────────────────────────────────
{
  check("real litellm overflow string → true", isOverflowError(OVF) === true);
  check("'prompt is too long' → true", isOverflowError("The prompt is too long for this model") === true);
  check("'context window exceeded' → true", isOverflowError("context window exceeded") === true);
  check("'maximum context length' → true", isOverflowError("maximum context length of 160000") === true);
  check("'too many tokens' → true", isOverflowError("You have provided too many tokens") === true);
  check("'input length' → true", isOverflowError("input length exceeds the allowed maximum") === true);
  // Rate limit / usage cap are NOT context overflow (they just need to wait).
  check("rate limit → false", isOverflowError("Rate limit exceeded, try again in a minute") === false);
  check("usage cap → false", isOverflowError("You have reached your monthly usage cap") === false);
  check("billing error → false", isOverflowError("billing error: insufficient credit") === false);
  check("generic failure → false", isOverflowError("Something went wrong upstream") === false);
  check("empty string → false", isOverflowError("") === false);
  // Same classifier as formatTurnFailure (classifyFailure): rate limit > overflow > cap.
  check("'context limit reached' is overflow (not a usage cap) → true", isOverflowError("context limit reached") === true);
  check("overflow wording + 'per minute' (rate limit wins) → false", isOverflowError("too many tokens per minute") === false);
  check("undefined → false", isOverflowError(undefined) === false);
}

// ── shouldRespawnWorker: the decision table ──────────────────────────────────
{
  const base = { status: "failed" as const, error: OVF, hasTask: true, enabled: true };

  check("all correct → respawn", shouldRespawnWorker(base) === true);
  check("status done → no", shouldRespawnWorker({ ...base, status: "done" }) === false);
  check("status stopped → no", shouldRespawnWorker({ ...base, status: "stopped" }) === false);
  check("status running → no", shouldRespawnWorker({ ...base, status: "running" }) === false);
  check("rate-limit error → no", shouldRespawnWorker({ ...base, error: "Rate limit exceeded" }) === false);
  check("missing error → no", shouldRespawnWorker({ ...base, error: undefined }) === false);
  check("already respawned (budget) → no", shouldRespawnWorker({ ...base, respawnedFrom: "api" }) === false);
  check("no task → no", shouldRespawnWorker({ ...base, hasTask: false }) === false);
  check("feature disabled → no", shouldRespawnWorker({ ...base, enabled: false }) === false);
  // The budget guard wins even when every other condition is satisfied.
  check(
    "respawnedFrom-set is decisive (else all correct) → no",
    shouldRespawnWorker({ status: "failed", error: OVF, respawnedFrom: "x", hasTask: true, enabled: true }) === false,
  );
}

// ── respawnName: <old>-2, clamped to NAME_RE (max 24) ────────────────────────
{
  check("short name → <old>-2", respawnName("api") === "api-2");
  check("kebab name → <old>-2", respawnName("api-fix") === "api-fix-2");
  // 22-char name + "-2" = 24 (exactly the max) → kept whole.
  const n22 = "abcdefghijklmnopqrstuv"; // 22
  check("22-char name fits at exactly 24", respawnName(n22) === `${n22}-2` && respawnName(n22).length === 24);
  // 23-char name + "-2" = 25 > 24 → cut to 21 chars.
  const n23 = "abcdefghijklmnopqrstuvw"; // 23
  check("23-char name is clamped", respawnName(n23) === `${n23.slice(0, 21)}-2`, respawnName(n23));
  // 24-char name (max) + "-2" = 26 > 24 → cut to 21 chars.
  const n24 = "abcdefghijklmnopqrstuvwx"; // 24
  check("24-char name is clamped", respawnName(n24) === `${n24.slice(0, 21)}-2`, respawnName(n24));
  // Every output is a valid worker name.
  for (const n of ["a", "api", n22, n23, n24, "a".repeat(24)]) {
    const r = respawnName(n);
    check(`respawnName valid NAME_RE (len ${n.length})`, NAME_RE.test(r) && r.length <= 24, r);
  }
}

// ── respawnNotice: one Vietnamese line naming both workers ───────────────────
{
  const n = respawnNotice("api", "api-2");
  check("notice names old worker", n.includes("<b>api</b>"), n);
  check("notice names new worker", n.includes("<b>api-2</b>"), n);
  check("notice is one line", !n.includes("\n"), n);
}

// ── buildHandoffPrompt: sections, caps, empty follow-ups omission ────────────
{
  const full = buildHandoffPrompt({
    originalTask: "the original task",
    followUps: ["do X", "do Y"],
    lastWorkerText: "last reply tail",
    directory: "/repo/sub",
    worktree: { branch: "tg/api-abc", base: "main" },
    gitEvidence: "stat: 3 files changed",
    error: OVF,
  });

  check("has Original task section", full.includes("## Original task"));
  check("has Follow-up section", full.includes("## Follow-up instructions issued before the crash (in order)"));
  check("has State section", full.includes("## State where the previous worker stopped"));
  check("has What happened section", full.includes("## What happened"));
  check("has Rules section", full.includes("## Rules"));

  check("original task carried verbatim", full.includes("the original task"));
  check("follow-ups listed in order", full.includes("do X") && full.includes("do Y"));
  check("directory shown", full.includes("/repo/sub"));
  check("worktree branch shown", full.includes("tg/api-abc"));
  check("worktree base shown", full.includes("main"));
  check("git evidence shown", full.includes("stat: 3 files changed"));
  check("last reply shown", full.includes("last reply tail"));
  check("provider error surfaced", full.includes("Provider error:"));
  check("context-limit explanation present", full.includes("context limit"));

  // Empty follow-ups → the whole section is omitted (not an empty header).
  const noFollow = buildHandoffPrompt({ originalTask: "t", directory: "/d" });
  check("follow-ups section omitted when empty", !noFollow.includes("## Follow-up"));
  check("state section still present without follow-ups", noFollow.includes("## State where the previous worker stopped"));

  // No worktree → the directory is shown plainly (no "git worktree" note).
  const noWt = buildHandoffPrompt({ originalTask: "t", directory: "/plain" });
  check("no worktree → no worktree note", !noWt.includes("git worktree"));

  // Caps: an over-size piece must be cut (the full run must not survive), and
  // a short piece must pass through untouched.
  const bigFollow = "C".repeat(FOLLOW_UPS_MAX + 1000);
  check("follow-ups over cap are truncated", !buildHandoffPrompt({ originalTask: "t", directory: "/d", followUps: [bigFollow] }).includes(bigFollow));
  const bigEvidence = "D".repeat(EVIDENCE_MAX + 1000);
  check("git evidence over cap is truncated", !buildHandoffPrompt({ originalTask: "t", directory: "/d", gitEvidence: bigEvidence }).includes(bigEvidence));
  const bigLast = "E".repeat(LAST_TEXT_MAX + 1000);
  check("last reply over cap is truncated", !buildHandoffPrompt({ originalTask: "t", directory: "/d", lastWorkerText: bigLast }).includes(bigLast));
  const short = buildHandoffPrompt({ originalTask: "t", directory: "/d", gitEvidence: "short stat", lastWorkerText: "short reply" });
  check("short evidence not truncated", short.includes("short stat"));
  check("short last reply not truncated", short.includes("short reply"));
}

// ── followUpsOf: drop the spawn prompt, drop empties, keep order ─────────────
{
  const a = followUpsOf([{ text: "spawn" }, { text: "f1" }, { text: "f2" }]);
  check("drops the first (spawn) message, keeps the rest in order", JSON.stringify(a) === JSON.stringify(["f1", "f2"]), JSON.stringify(a));
  const b = followUpsOf([{ text: "spawn" }, { text: "   " }, { text: "f1" }, { text: "" }]);
  check("drops empty/whitespace follow-ups", JSON.stringify(b) === JSON.stringify(["f1"]), JSON.stringify(b));
  check("only the spawn prompt → empty", JSON.stringify(followUpsOf([{ text: "spawn" }])) === JSON.stringify([]));
  check("no messages → empty", JSON.stringify(followUpsOf([])) === JSON.stringify([]));
}

// ── followUpsFromMessages: whole session, any order ──────────────────────────
{
  const u = (t: string, created: number) => ({ type: "user", time: { created }, text: t });
  const a = (created: number) => ({ type: "assistant", time: { created }, text: "x" });
  const textOf = (m: any) => m.text as string;
  // Newest-first (as the server may return it) must give the same answer as oldest-first.
  const chrono = [u("spawn prompt", 1), a(2), u("fu1", 3), a(4), u("fu2", 5)];
  const newestFirst = [...chrono].reverse();
  const want = JSON.stringify(["fu1", "fu2"]);
  check("follow-ups: chronological input", JSON.stringify(followUpsFromMessages(chrono, textOf)) === want);
  check("follow-ups: newest-first input", JSON.stringify(followUpsFromMessages(newestFirst, textOf)) === want);
  check("follow-ups: shuffled input", JSON.stringify(followUpsFromMessages([chrono[3], chrono[0], chrono[4], chrono[2], chrono[1]], textOf)) === want);
  check("follow-ups: assistant messages ignored; only spawn prompt → none", followUpsFromMessages([a(1), u("spawn", 2), a(3)], textOf).length === 0);
  check("follow-ups: empty session → none", followUpsFromMessages([], textOf).length === 0);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
