/**
 * Checks the reaction UX's pure decision logic (src/reactions.ts):
 *  - emoji → action mapping (🚀 spawn / 👍 approve / 👎 reject / no-op),
 *  - the (message,emoji) "fired once" dedup keys,
 *  - index/reacted pruning at the caps (oldest first, no-op under cap),
 *  - the 👍 approve decision (worker-done only, never a busy worker),
 *  - 🚀 worker-name derivation (slug rules, Vietnamese text, fallbacks).
 *
 * Run:  npx tsx scripts/test-reactions.ts
 */
import {
  classifyAction,
  indexKey,
  reactedKey,
  alreadyReacted,
  pruneIndex,
  pruneReacted,
  decideApprove,
  spawnNameFromText,
  uniqueSpawnName,
  REACT_INDEX_CAP,
  REACTED_CAP,
  REACTION_SPAWN,
  REACTION_APPROVE,
  REACTION_REJECT,
  REACTION_THINK,
  REACTION_CELEBRATE,
} from "../src/reactions.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── emoji → action mapping ─────────────────────────────────────────────────
{
  check("🚀 → spawn", classifyAction(REACTION_SPAWN) === "spawn");
  check("👍 → approve", classifyAction(REACTION_APPROVE) === "approve");
  check("👎 → reject", classifyAction(REACTION_REJECT) === "reject");
  check("unknown emoji (👏) → no-op", classifyAction("👏") === null);
  check("empty → no-op", classifyAction("") === null);
  check("body-language emojis are settable constants", REACTION_THINK === "🤔" && REACTION_CELEBRATE === "🎉");
}

// ── dedup keys ─────────────────────────────────────────────────────────────
{
  check("indexKey = chat:msg", indexKey(111, 222) === "111:222");
  check("reactedKey = chat:msg:emoji", reactedKey(111, 222, "🚀") === "111:222:🚀");
  check("different emojis → different keys", reactedKey(1, 2, "👍") !== reactedKey(1, 2, "👎"));
  check("different chats → different keys", indexKey(1, 2) !== indexKey(3, 2));

  check("alreadyReacted(undefined) = false", alreadyReacted(undefined, 1, 2, "🚀") === false);
  const fired: Record<string, true> = { [reactedKey(1, 2, "🚀")]: true };
  check("alreadyReacted: fired pair → true", alreadyReacted(fired, 1, 2, "🚀") === true);
  check("alreadyReacted: other emoji → false", alreadyReacted(fired, 1, 2, "👍") === false);
  check("alreadyReacted: other message → false", alreadyReacted(fired, 1, 3, "🚀") === false);

  // the once-ever contract: after marking, the same pair is a no-op
  let reacted: Record<string, true> = {};
  const k = reactedKey(9, 8, "🚀");
  check("first tap fires", !alreadyReacted(reacted, 9, 8, "🚀"));
  reacted = { ...reacted, [k]: true };
  check("second tap of the same emoji is deduped", alreadyReacted(reacted, 9, 8, "🚀"));
}

// ── pruning: oldest first, cap respected, no-op under cap ──────────────────
{
  const mk = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { ts: 1000 + i }]));

  const small = mk(10);
  check("pruneIndex: under cap → same object", pruneIndex(small, 50) === small);

  const big = mk(REACT_INDEX_CAP + 5);
  const pruned = pruneIndex(big, REACT_INDEX_CAP);
  check("pruneIndex: drops to the cap", Object.keys(pruned).length === REACT_INDEX_CAP);
  check("pruneIndex: oldest (m0..m4) dropped", !("m0" in pruned) && !("m4" in pruned) && "m5" in pruned);
  check("pruneIndex: default cap = REACT_INDEX_CAP", Object.keys(pruneIndex(mk(REACT_INDEX_CAP + 1))).length === REACT_INDEX_CAP);

  const rSmall: Record<string, true> = { a: true, b: true };
  check("pruneReacted: under cap → same object", pruneReacted(rSmall, 50) === rSmall);

  const rBig: Record<string, true> = {};
  for (let i = 0; i < REACTED_CAP + 5; i++) rBig[`r${i}`] = true;
  const rPruned = pruneReacted(rBig, REACTED_CAP);
  check("pruneReacted: drops to the cap", Object.keys(rPruned).length === REACTED_CAP);
  check("pruneReacted: oldest (insertion order) dropped", !("r0" in rPruned) && "r5" in rPruned);
}

// ── 👍 approve decision ────────────────────────────────────────────────────
{
  check("worker-done + idle → approve", decideApprove("worker-done", false) === "approve");
  check("worker-done + running → busy", decideApprove("worker-done", true) === "busy");
  check("plain reply → invalid", decideApprove("reply", false) === "invalid");
  check("user-msg → invalid", decideApprove("user-msg", false) === "invalid");
  check("missing purpose → invalid", decideApprove(undefined, false) === "invalid");
}

// ── 🚀 worker-name derivation ──────────────────────────────────────────────
{
  check("slug: lowercases + dashes", spawnNameFromText("Fix the Cold Pool UI") === "fix-the-cold-pool-ui");
  check("slug: collapses repeated non-alphanumerics", spawnNameFromText("a  b   c!!d") === "a-b-c-d");
  check("slug: Vietnamese → only ascii letters kept", spawnNameFromText("sửa lỗi cold pool") === "s-a-l-i-cold-pool");
  check("slug: leading digit is valid (NAME_RE)", spawnNameFromText("123 abc") === "123-abc");
  check("slug: all symbols → fallback", spawnNameFromText("!!! ???") === "task");
  check("slug: caps at 24 chars, no trailing dash", spawnNameFromText("a very very very very long task name here").length <= 24);
  check("slug: custom fallback", spawnNameFromText("!!! ???", "job") === "job");

  const taken = new Set(["x"]);
  check("unique: free base kept", uniqueSpawnName("y", (n) => taken.has(n)) === "y");
  check("unique: taken base → -2", uniqueSpawnName("x", (n) => taken.has(n)) === "x-2");
  // precise uniqueness sequence
  const taken2 = new Set(["x", "x-2"]);
  check("unique: x taken + x-2 taken → x-3", uniqueSpawnName("x", (n) => taken2.has(n)) === "x-3");
  const taken3 = new Set(Array.from({ length: 9 }, (_, i) => (i === 0 ? "x" : `x-${i + 1}`)));
  check("unique: x + all suffixes 2..9 taken → undefined", uniqueSpawnName("x", (n) => taken3.has(n)) === undefined);
  // long base truncates so the suffixed name stays ≤ 24
  const long = "a".repeat(30);
  const got = uniqueSpawnName(long, (n) => n === long);
  check("unique: long base truncated, suffix fits 24", got !== undefined && got.length <= 24 && got.endsWith("-2"));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
