/**
 * Checks the quick-replies instruction mechanism (src/suggest.ts).
 *
 * Covers applySuggestPin, modelled on the language pin tests:
 *   - enabled, fresh session → sets the instruction + records suggestSession.
 *   - enabled, same session again → idempotent (no 2nd set).
 *   - enabled, new session → re-applies.
 *   - disabled after being applied → removes the instruction + clears the marker.
 *   - disabled when nothing was set → no-op.
 *   - best-effort: a failing set never throws and does not record the marker.
 *   - missing state is a no-op.
 *
 * Run:  npx tsx scripts/test-suggest.ts
 */
import { applySuggestPin, SUGGEST_KEY, SUGGEST_INSTRUCTION, type InstructionCtl } from "../src/suggest.js";
import type { ConvKey } from "../src/conv.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const conv = "100:5" as ConvKey;

// ── fakes (mirror test-language.ts) ─────────────────────────────────────────────
function makeSt(initial: Record<string, Record<string, unknown>> = {}) {
  const data: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(initial)) data[k] = { ...v };
  return {
    peek: (c: ConvKey) => data[c],
    set: (c: ConvKey, partial: Record<string, unknown>) => {
      data[c] = { ...(data[c] ?? {}), ...partial };
    },
  };
}
function makeOc(): InstructionCtl & { calls: string[]; fail: boolean } {
  const calls: string[] = [];
  return {
    calls,
    fail: false,
    async setInstruction(sid, key, value) {
      if (this.fail) throw new Error("set failed");
      calls.push(`set:${sid}:${key}:${value === SUGGEST_INSTRUCTION ? "instr" : "other"}`);
    },
    async removeInstruction(sid, key) {
      if (this.fail) throw new Error("rm failed");
      calls.push(`rm:${sid}:${key}`);
    },
  };
}

// ── applySuggestPin ─────────────────────────────────────────────────────────────
{
  const oc = makeOc();
  const st = makeSt({ [conv]: {} });
  await applySuggestPin(oc, st, conv, "s1", true);
  check("enabled sets the instruction (with the exact text)", oc.calls.includes(`set:s1:${SUGGEST_KEY}:instr`), oc.calls.join(","));
  check("enabled records suggestSession", st.peek(conv)?.suggestSession === "s1");

  // Idempotent: a 2nd prompt on the same session does not re-set.
  await applySuggestPin(oc, st, conv, "s1", true);
  check("enabled is idempotent (no 2nd set)", oc.calls.filter((c) => c.startsWith("set:")).length === 1, oc.calls.join(","));

  // A new session re-applies.
  await applySuggestPin(oc, st, conv, "s2", true);
  check("new session re-applies the pin", oc.calls.filter((c) => c.startsWith("set:")).length === 2, oc.calls.join(","));

  // Switching off clears the instruction.
  await applySuggestPin(oc, st, conv, "s2", false);
  check("disabled clears the instruction", oc.calls.includes(`rm:s2:${SUGGEST_KEY}`), oc.calls.join(","));
  check("disabled clears the applied marker", st.peek(conv)?.suggestSession === undefined);

  // "off" when nothing was set is a no-op.
  const oc2 = makeOc();
  const st2 = makeSt({ [conv]: {} });
  await applySuggestPin(oc2, st2, conv, "s1", false);
  check("disabled with no pin is a no-op", oc2.calls.length === 0, oc2.calls.join(","));
}
{
  // Best-effort: a failing set never throws and does not record the marker.
  const oc = makeOc();
  oc.fail = true;
  const st = makeSt({ [conv]: {} });
  let threw = false;
  try {
    await applySuggestPin(oc, st, conv, "s1", true);
  } catch {
    threw = true;
  }
  check("failing set never throws", !threw);
  check("failing set does not record the marker", st.peek(conv)?.suggestSession === undefined);
}
{
  // A conv with no state is a no-op (no throw).
  const oc = makeOc();
  const st = makeSt(); // no entry for `conv`
  let threw = false;
  try {
    await applySuggestPin(oc, st, conv, "s1", true);
  } catch {
    threw = true;
  }
  check("missing state is a no-op", !threw && oc.calls.length === 0);
}

// ── the instruction text is non-trivial + mentions the marker ───────────────────
{
  check("instruction mentions the marker form", SUGGEST_INSTRUCTION.includes("[OPTIONS: first | second | third]"));
  check("instruction is a substantial text (>100 chars)", SUGGEST_INSTRUCTION.length > 100);
}

if (failures) {
  console.error(`\n${failures} suggest check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll suggest checks passed.");
