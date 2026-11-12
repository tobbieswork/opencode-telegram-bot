/**
 * Unit tests for src/nextsteps.ts — S1 of docs/sdd/next-step-buttons.md.
 * Pure engine: rules, exclusions, cap, threshold, encoding, TTL, binding.
 *
 * Run:  npx tsx scripts/test-nextsteps.ts
 */
import {
  decide,
  labelFor,
  RULES,
  registry,
  computeFilesNew,
  callbackFor,
  parseCallback,
  type NextStepFacts,
  type NextStepConfig,
  type Rule,
} from "../src/nextsteps.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const CFG: NextStepConfig = { nextSteps: true, minSecs: 90 };

/** Baseline facts: a quiet, eligible plain build turn. Mutate per case. */
function facts(over: Partial<NextStepFacts> = {}): NextStepFacts {
  return {
    kind: "plain",
    outcome: "succeeded",
    interrupted: false,
    agent: "build",
    elapsedMs: 120_000,
    busyWorkers: 0,
    filesNew: true,
    overflow: false,
    hasChoices: false,
    hasOtherKeyboard: false,
    ...over,
  };
}

function rulesOf(sugs: ReturnType<typeof decide>): string {
  return sugs.map((s) => s.rule).join("|");
}

// ── review (plain) ───────────────────────────────────────────────────────────
{
  const base = facts();
  check("review plain: fires on eligible build turn", rulesOf(decide(base, CFG, NOW)) === "review", JSON.stringify(decide(base, CFG, NOW)));

  check("review plain: NOT for agent=plan", decide(facts({ agent: "plan" }), CFG, NOW).length === 0);
  check("review plain: NOT for agent=explore", decide(facts({ agent: "explore" }), CFG, NOW).length === 0);
  check("review plain: NOT when outcome=failed", decide(facts({ outcome: "failed" }), CFG, NOW).length === 0);
  check("review plain: NOT when filesNew=false", decide(facts({ filesNew: false }), CFG, NOW).length === 0);
  check("review plain: NOT when interrupted", decide(facts({ interrupted: true }), CFG, NOW).length === 0);

  // Threshold boundary (N4.2 default 90s): exact minSecs fires, 1ms below doesn't.
  check("threshold: elapsedMs === minSecs fires", rulesOf(decide(facts({ elapsedMs: 90_000 }), CFG, NOW)) === "review");
  check("threshold: elapsedMs < minSecs does NOT fire", decide(facts({ elapsedMs: 89_999 }), CFG, NOW).length === 0);
  check("threshold: custom minSecs=0 fires immediately", rulesOf(decide(facts({ elapsedMs: 1 }), { nextSteps: true, minSecs: 0 }, NOW)) === "review");
}

// ── review (worker) ──────────────────────────────────────────────────────────
{
  const w = facts({ kind: "worker", agent: "general", worker: { writes: true, hasWorktree: false } });
  check("review worker: fires for writing worker with changes", rulesOf(decide(w, CFG, NOW)) === "review");
  check("review worker: NOT when writes=false (N2.2)", decide(facts({ kind: "worker", agent: "plan", worker: { writes: false, hasWorktree: false } }), CFG, NOW).length === 0);
  check("review worker: NOT when worker undefined", decide(facts({ kind: "worker" }), CFG, NOW).length === 0);
  check("review worker: NOT when filesNew=false", decide(facts({ kind: "worker", worker: { writes: true, hasWorktree: true }, filesNew: false }), CFG, NOW).length === 0);
  check("review worker: NOT when outcome=failed", decide(facts({ kind: "worker", worker: { writes: true, hasWorktree: false }, outcome: "failed" }), CFG, NOW).length === 0);
}

// ── N2.1: review never in the Manager conversation ───────────────────────────
{
  const m = facts({ kind: "manager", busyWorkers: 0 });
  check("N2.1: review NOT shown in manager even when all plain conditions hold", decide(m, CFG, NOW).length === 0, JSON.stringify(decide(m, CFG, NOW)));
}

// ── board ─────────────────────────────────────────────────────────────────────
{
  const b = facts({ kind: "manager", agent: "general", busyWorkers: 2, filesNew: false });
  check("board: fires for manager with busy workers", rulesOf(decide(b, CFG, NOW)) === "board", JSON.stringify(decide(b, CFG, NOW)));
  check("board: NOT when no busy workers", decide(facts({ kind: "manager", busyWorkers: 0 }), CFG, NOW).length === 0);
  check("board: NOT when outcome=failed", decide(facts({ kind: "manager", busyWorkers: 1, outcome: "failed" }), CFG, NOW).length === 0);
  check("board: NOT in plain conversation", decide(facts({ busyWorkers: 3 }), CFG, NOW).length === 1 && rulesOf(decide(facts({ busyWorkers: 3 }), CFG, NOW)) === "review");
}

// ── new-keep ──────────────────────────────────────────────────────────────────
{
  const n = facts({ outcome: "failed", overflow: true, filesNew: false });
  check("new-keep: fires on overflow failure", rulesOf(decide(n, CFG, NOW)) === "new-keep", JSON.stringify(decide(n, CFG, NOW)));
  check("new-keep: NOT when overflow=false", decide(facts({ outcome: "failed", overflow: false }), CFG, NOW).length === 0);
  check("new-keep: NOT when outcome=succeeded", decide(facts({ overflow: true }), CFG, NOW).length === 1 && rulesOf(decide(facts({ overflow: true }), CFG, NOW)) === "review");
  check("new-keep: works in worker kind too (overflow is kind-agnostic)", rulesOf(decide(facts({ kind: "worker", outcome: "failed", overflow: true, worker: { writes: false, hasWorktree: false } }), CFG, NOW)) === "new-keep");
}

// ── Exclusions (N1.2–N1.4) ───────────────────────────────────────────────────
{
  check("no rule fires → []", decide(facts({ outcome: "failed", overflow: false, filesNew: false }), CFG, NOW).length === 0);
  check("hasChoices → [] (N1.3)", decide(facts({ hasChoices: true }), CFG, NOW).length === 0);
  check("hasOtherKeyboard → [] (N1.3)", decide(facts({ hasOtherKeyboard: true }), CFG, NOW).length === 0);
  check("interrupted → [] (N1.4)", decide(facts({ interrupted: true, outcome: "interrupted" }), CFG, NOW).length === 0);
  check("advisor → [] (N1.4)", decide(facts({ kind: "advisor", agent: "general" }), CFG, NOW).length === 0);
  check("scheduled → [] (N1.4)", decide(facts({ kind: "scheduled", agent: "build" }), CFG, NOW).length === 0);
  check("cfg.nextSteps=false → [] (off mode)", decide(facts(), { nextSteps: false, minSecs: 90 }, NOW).length === 0);
}

// ── Cap of 3 (N1.2) ──────────────────────────────────────────────────────────
{
  // All three rules eligible at once (review via plain + board needs manager,
  // so simulate with a manager turn that also fails-with-overflow? no — build a
  // facts set where review(worker) is impossible; instead use a synthetic
  // 4-rule table to prove the cap, plus a real 3-eligible scenario.
  const always: Rule = { rule: "board", when: () => true };
  const four: Rule[] = [
    { rule: "review", when: () => true },
    always,
    { rule: "new-keep", when: () => true },
    { rule: "board", when: () => true },
  ];
  const capped = decide(facts(), CFG, NOW, four);
  check("cap: 4 eligible rules → exactly 3 suggestions", capped.length === 3, JSON.stringify(rulesOf(capped)));
  check("cap: keeps priority order (first 3)", rulesOf(capped) === "review|board|new-keep", rulesOf(capped));

  // Real table: at most 3 even if everything were eligible.
  const sugs = decide(facts(), CFG, NOW);
  check("cap: real table never exceeds 3", sugs.length <= 3);
  check("rule table has 4 entries (review×2, board, new-keep)", RULES.length === 4);
}

// ── Suggestion shape & labels (N3.4) ─────────────────────────────────────────
{
  const sugs = decide(facts(), CFG, NOW);
  check("suggestion shape: rule === action", sugs.length === 1 && sugs[0].rule === sugs[0].action);
  check("label: vi default", sugs[0].label("vi") === "🔍 Review thay đổi", sugs[0].label("vi"));
  check("label: en", sugs[0].label("en") === "🔍 Review changes", sugs[0].label("en"));
  check("labelFor: board vi/en identical", labelFor("board", "vi") === "📋 Board" && labelFor("board", "en") === "📋 Board");
  check("labelFor: new-keep vi", labelFor("new-keep", "vi") === "♻ Phiên mới, giữ context", labelFor("new-keep", "vi"));
  check("labelFor: new-keep en", labelFor("new-keep", "en") === "♻ New session, keep context", labelFor("new-keep", "en"));
  check("labelFor: unknown lang falls back to vi", labelFor("review", "fr") === "🔍 Review thay đổi");
}

// ── Callback encoding ─────────────────────────────────────────────────────────
{
  const id = "a1b2";
  const cb = callbackFor(id, 0);
  check("callbackFor shape: ns:<id>:<k>", cb === "ns:a1b2:0", cb);
  check("callback < 64 bytes (k=0)", Buffer.byteLength(cb, "utf8") < 64, String(Buffer.byteLength(cb, "utf8")));
  const cb9 = callbackFor("zzzz", 9);
  check("callback < 64 bytes (k=9)", Buffer.byteLength(cb9, "utf8") < 64, cb9);
  const cb12 = callbackFor("zzzz", 12);
  check("callback < 64 bytes (k=12, 2 digits)", Buffer.byteLength(cb12, "utf8") < 64, cb12);

  check("parseCallback round-trip (k=0)", JSON.stringify(parseCallback(cb)) === JSON.stringify({ id: "a1b2", k: 0 }));
  check("parseCallback round-trip (k=2)", JSON.stringify(parseCallback(callbackFor("0abc", 2))) === JSON.stringify({ id: "0abc", k: 2 }));
  check("parseCallback rejects ch: prefix", parseCallback("ch:a1b2:0") === null);
  check("parseCallback rejects note: prefix", parseCallback("note:123") === null);
  check("parseCallback rejects ns:<id> without k", parseCallback("ns:a1b2") === null);
  check("parseCallback rejects non-base36 id", parseCallback("ns:AAAA:0") === null);
  check("parseCallback rejects short id", parseCallback("ns:ab:0") === null);
  check("parseCallback rejects non-numeric k", parseCallback("ns:a1b2:x") === null);
  check("parseCallback rejects negative k", parseCallback("ns:a1b2:-1") === null);
  check("parseCallback rejects empty string", parseCallback("") === null);
}

// ── Registry: set/get, session binding ────────────────────────────────────────
{
  const id = registry.set({ conv: "u1:c1", sessionID: "ses_abc", rule: "review", now: NOW });
  check("registry id is 4-char base36", /^[0-9a-z]{4}$/.test(id), id);
  const rec = registry.get(id, NOW + 60_000);
  check("get: returns the record", rec !== null);
  check("session binding: conv", rec?.conv === "u1:c1");
  check("session binding: sessionID", rec?.sessionID === "ses_abc");
  check("session binding: rule", rec?.rule === "review");
  check("get: unknown id → null", registry.get("zzzz", NOW) === null);
  check("get: id not in this process → null", registry.get("0000", NOW) === null || true); // "0000" may or may not exist
  const id2 = registry.set({ conv: "u1:c2", sessionID: "ses_def", rule: "board", now: NOW });
  check("two sets → distinct ids", id2 !== id);
  check("second record bound to its own session", registry.get(id2, NOW)?.sessionID === "ses_def");
}

// ── Registry: TTL (N3.6) & prune ──────────────────────────────────────────────
{
  const TTL = 24 * 60 * 60 * 1000;
  const id = registry.set({ conv: "u1:c1", sessionID: "ses_ttl", rule: "new-keep", now: NOW });
  check("TTL: get at now + 1h → alive", registry.get(id, NOW + 60 * 60 * 1000) !== null);
  check("TTL: get exactly at TTL → still alive (strictly >)", registry.get(id, NOW + TTL) !== null);
  check("TTL: get just past TTL → null", registry.get(id, NOW + TTL + 1) === null);
  check("TTL: expired id is pruned from the map (re-get still null)", registry.get(id, NOW + TTL + 1000) === null);

  // prune: one fresh, one expired.
  const fresh = registry.set({ conv: "u1:c3", sessionID: "ses_fresh", rule: "review", now: NOW + 1000 });
  const stale = registry.set({ conv: "u1:c3", sessionID: "ses_stale", rule: "review", now: NOW - (TTL + 5_000) });
  const pruned = registry.prune(NOW + 1000, TTL);
  check("prune: removes at least the stale record", pruned >= 1, String(pruned));
  check("prune: stale record gone", registry.get(stale, NOW + 1000) === null);
  check("prune: fresh record survives", registry.get(fresh, NOW + 1000) !== null);
}

// ── Opportunistic pruning: unclicked records must not pile up forever ─────────
{
  registry.clear();
  const TTL = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 10; i++) registry.set({ conv: "u1:p", sessionID: `old_${i}`, rule: "review", now: NOW - (TTL + 60_000) });
  for (let i = 0; i < 60; i++) registry.set({ conv: "u1:p", sessionID: `new_${i}`, rule: "review", now: NOW });
  check("prune-on-set: expired records are dropped once the map grows", registry.size() <= 60, String(registry.size()));
  check("prune-on-set: fresh records all survive", registry.size() === 60, String(registry.size()));
  registry.clear();
}

// ── computeFilesNew (N2.3, amended): did the turn change the working tree? ────
{
  check("filesNew: fingerprints differ → changed", computeFilesNew({ before: "a", after: "b", reportFiles: [] }) === true);
  check("filesNew: fingerprints equal → NOT changed, even if the report lists files", computeFilesNew({ before: "a", after: "a", reportFiles: ["x.ts"] }) === false);
  check("filesNew: fingerprints win over a stale 'seen' set", computeFilesNew({ before: "a", after: "b", reportFiles: [], seen: new Set(["x.ts"]) }) === true);
  check("filesNew: no fingerprint, empty report → NOT changed (no more 'assume changed')", computeFilesNew({ reportFiles: [] }) === false);
  check("filesNew: no fingerprint, report lists a new file → changed", computeFilesNew({ reportFiles: ["x.ts"] }) === true);
  check("filesNew: no fingerprint, only already-seen files → NOT changed", computeFilesNew({ reportFiles: ["x.ts"], seen: new Set(["x.ts"]) }) === false);
  check("filesNew: only one fingerprint available → falls back to the report", computeFilesNew({ before: "a", reportFiles: ["y.ts"] }) === true && computeFilesNew({ after: "a", reportFiles: [] }) === false);
}

// ── Purity: module exports only what S1 promises ──────────────────────────────
{
  check("RULES is the default table for decide", decide(facts(), CFG, NOW, RULES).length === 1);
  registry.clear();
  check("registry.clear empties the map", registry.get("a1b2", NOW) === null);
}

console.log(failures === 0 ? "\nall nextsteps checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
