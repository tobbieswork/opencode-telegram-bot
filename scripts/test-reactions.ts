/**
 * Checks the reaction UX's pure decision logic (src/reactions.ts):
 *  - emoji → action mapping (🔥 spawn / 👍 approve / 👎 reject / no-op),
 *  - the added-reaction diff (new_reaction vs old_reaction, FB-05),
 *  - the (message,emoji) "fired once" dedup keys,
 *  - index/reacted pruning at the caps (oldest first, no-op under cap),
 *  - the 👍 approve decision (worker-done only, never a busy worker),
 *  - the 🔥 spawn decision (never a user's own already-processed message),
 *  - 🔥 worker-name derivation (slug rules, Vietnamese text, fallbacks).
 *
 * Run:  npx tsx scripts/test-reactions.ts
 */
import {
  classifyAction,
  pickAddedReaction,
  indexKey,
  reactedKey,
  alreadyReacted,
  pruneIndex,
  pruneReacted,
  decideApprove,
  decideSpawn,
  spawnRequestBody,
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
  check("🔥 → spawn", classifyAction(REACTION_SPAWN) === "spawn");
  check("👍 → approve", classifyAction(REACTION_APPROVE) === "approve");
  check("👎 → reject", classifyAction(REACTION_REJECT) === "reject");
  check("unknown emoji (👏) → no-op", classifyAction("👏") === null);
  check("empty → no-op", classifyAction("") === null);
  check("body-language emojis are settable constants", REACTION_THINK === "🤔" && REACTION_CELEBRATE === "🎉");
}

// ── added-reaction diff (new_reaction vs old_reaction, FB-05) ─────────────
// Telegram sends the FULL reaction lists; only an emoji in new_reaction that
// is absent from old_reaction is a real add. The old new_reaction[0] decode
// misfired on multi-reaction messages in both directions.
{
  const r = (e: string): { type: string; emoji: string } => ({ type: "emoji", emoji: e });

  // FB-05 case 1: user has 👍 and adds 🔥 → the ADD is 🔥 (spawn), whichever
  // order Telegram reports the list.
  check("add 🔥 beside 👍 (new [👍,🔥], old [👍]) → 🔥", pickAddedReaction([r("👍"), r("🔥")], [r("👍")]) === "🔥");
  check("add 🔥 beside 👍 (new [🔥,👍], old [👍]) → 🔥 (order-insensitive)", pickAddedReaction([r("🔥"), r("👍")], [r("👍")]) === "🔥");

  // FB-05 case 2: removing 👍 from [👍,🔥] → nothing was added → undefined
  // (no spurious spawn, no dedupe marker).
  check("remove 👍 from [👍,🔥] (new [🔥], old [👍,🔥]) → undefined", pickAddedReaction([r("🔥")], [r("👍"), r("🔥")]) === undefined);
  check("remove the only reaction (new [], old [👍]) → undefined", pickAddedReaction([], [r("👍")]) === undefined);
  check("reorder without change (new [🔥,👍], old [👍,🔥]) → undefined", pickAddedReaction([r("🔥"), r("👍")], [r("👍"), r("🔥")]) === undefined);

  // brand-new mapped emoji on a clean message
  check("brand-new 👍 (new [👍], old []) → 👍 (approve)", pickAddedReaction([r("👍")], []) === "👍");
  check("brand-new 👎 (new [👎], old []) → 👎 (reject)", pickAddedReaction([r("👎")], []) === "👎");

  // re-adding a previously removed emoji is a real add by diff (the handler's
  // once-ever dedupe marker applies on top, as before)
  check("re-add after removal (new [🔥], old []) → 🔥 again", pickAddedReaction([r("🔥")], []) === "🔥");

  // unmapped emojis never act, mapped ones do even alongside unmapped
  check("new unmapped 👏 (new [👏], old []) → undefined", pickAddedReaction([r("👏")], []) === undefined);
  check("new [👏,👍] beside empty old → 👍 (first mapped add)", pickAddedReaction([r("👏"), r("👍")], []) === "👍");
  check("undefined lists → undefined", pickAddedReaction(undefined, undefined) === undefined);
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

// ── 🔥 spawn decision (user-message guard) ─────────────────────────────────
{
  check("user-msg → already-processed (no duplicate spawn)", decideSpawn("user-msg") === "already-processed");
  check("reply → spawn", decideSpawn("reply") === "spawn");
  check("worker-done → spawn", decideSpawn("worker-done") === "spawn");
  check("missing purpose → spawn (legacy entries)", decideSpawn(undefined) === "spawn");
}

// ── 🔥 manager relay body ────────────────────────────────────────────────
{
  const body = spawnRequestBody("123:456", "Fix the login bug on the settings page");
  check("body: names the conv", body.includes("123:456"));
  check("body: carries the message text", body.includes("Fix the login bug on the settings page"));
  check("body: asks for a self-contained task", body.includes("self-contained task"));
  check("body: names the spawn tool", body.includes("tg-bridge_spawn_worker"));
  check("body: says the user is told afterwards", body.includes("tell the user"));
  // Long text is capped so a huge paste can't bloat the manager prompt.
  const longBody = spawnRequestBody("1", "a".repeat(5000));
  check("body: long text capped (≤ 1500 + ellipsis)", longBody.includes("…") && !longBody.includes("a".repeat(1600)));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
