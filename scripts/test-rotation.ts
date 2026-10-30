/**
 * Manager rotation — pure logic. M1: the FLOOR (min sent-context over 24h) and
 * the per-message sent-context (input + cache.read). The network side lives in
 * bot.ts (managerFloor) and is exercised live via /status.
 *
 * Run:  npx tsx scripts/test-rotation.ts
 */
import {
  managerFloorFromMessages,
  sentContext,
  ROTATION_WINDOW_MS,
  rotationInstruction,
  runRotationHandoff,
  capWords,
  HANDOFF_BRIEF_WORDS,
} from "../src/rotation.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const H = 3600_000;
const inWindow = (t: number, tokens: object) => ({ type: "assistant", time: { created: t }, tokens });

// ── sentContext: input + cache.read (cache.write excluded) ─────────────────
{
  const flat = { type: "assistant", tokens: { input: 1000, output: 50, cache: { read: 80_000, write: 12_000 } } };
  check("sentContext flat = input + cache.read", sentContext(flat) === 81_000, String(sentContext(flat)));
  const wrapped = { info: { type: "assistant", tokens: { input: 100, cache: { read: 200 } } } };
  check("sentContext info-wrapped", sentContext(wrapped) === 300, String(sentContext(wrapped)));
  check("sentContext no tokens → 0", sentContext({ type: "assistant" }) === 0);
  // output / reasoning / cache.write are all excluded — only input + cache.read count
  check("sentContext ignores output/reasoning/write", sentContext({ type: "assistant", tokens: { input: 7, output: 999, reasoning: 888, cache: { read: 3, write: 44 } } }) === 10);
}

// ── managerFloorFromMessages: MIN over the last 24h window ─────────────────
{
  const msgs = [
    inWindow(NOW - 1 * H, { input: 90_000, cache: { read: 0 } }), // 90K
    inWindow(NOW - 2 * H, { input: 56_000, cache: { read: 0 } }), // 56K ← min
    inWindow(NOW - 3 * H, { input: 70_000, cache: { read: 0 } }), // 70K
    inWindow(NOW - 30 * H, { input: 10_000, cache: { read: 0 } }), // 10K but OLDER than 24h → excluded
    { type: "user", time: { created: NOW - 1 * H } }, // not assistant → ignored
    inWindow(NOW + 1 * H, { input: 1, cache: { read: 0 } }), // future → excluded
  ];
  check("floor = min of in-window (56K)", managerFloorFromMessages(msgs, NOW) === 56_000, String(managerFloorFromMessages(msgs, NOW)));
  check("older-than-window excluded (56K, not 10K)", managerFloorFromMessages(msgs, NOW) === 56_000);
  check("no assistant msgs → 0", managerFloorFromMessages([], NOW) === 0);
  check("only user msgs → 0", managerFloorFromMessages([{ type: "user", time: { created: NOW } }], NOW) === 0);
  check("all outside window → 0", managerFloorFromMessages([inWindow(NOW - 30 * H, { input: 100, cache: { read: 0 } })], NOW) === 0);
  const atCutoff = [inWindow(NOW - ROTATION_WINDOW_MS, { input: 42_000, cache: { read: 0 } })];
  check("message exactly at 24h cutoff is included", managerFloorFromMessages(atCutoff, NOW) === 42_000);
  const pair = [inWindow(NOW - 1 * H, { input: 80_000, cache: { read: 0 } }), inWindow(NOW - 2 * H, { input: 60_000, cache: { read: 0 } })];
  check("order-independent", managerFloorFromMessages(pair, NOW) === 60_000 && managerFloorFromMessages([...pair].reverse(), NOW) === 60_000);
}

// ── M2: capWords ─────────────────────────────────────────────────────────────
{
  check("capWords under limit unchanged", capWords("a b c", 10) === "a b c");
  check("capWords at limit", capWords("a b c d e", 5) === "a b c d e");
  check("capWords over limit cuts to N words", capWords("a b c d e", 3) === "a b c");
  check("capWords trims + normalizes whitespace", capWords("  a\t b  ", 5) === "a b");
  check("capWords empty", capWords("", 5) === "");
  check("capWords single word at limit 1", capWords("a b c", 1) === "a");
}

// ── M2: rotationInstruction ──────────────────────────────────────────────────
{
  const instr = rotationInstruction("/home/user/project", 300);
  check("instruction names the working dir", instr.includes("/home/user/project"));
  check("instruction asks to save memory + notes", instr.includes("ctx_memory") && instr.includes("ctx_note"));
  check("instruction caps the brief at 300 words", instr.includes("at most 300 words"));
  check("instruction covers branch/task/decisions/risks", /git branch/.test(instr) && /pending/.test(instr) && /reasoning/.test(instr) && /risk/.test(instr));
  check("instruction states it is for the replacement session", /replacement session/.test(instr));
  check("instruction custom word count (50)", rotationInstruction("/x", 50).includes("at most 50 words"));
}

// ── M2: runRotationHandoff (injected deps — no network) ──────────────────────
{
  const briefText = "Worked on X; branch main; done A, pending B; decided Y because Z; risk: W.";

  // happy path: prompts the old session, returns the trimmed brief
  {
    let calledSid = "";
    let calledText = "";
    const r = await runRotationHandoff("ses_old", "/proj", {
      prompt: async (sid, text) => { calledSid = sid; calledText = text; return { reply: "  " + briefText + "  " }; },
    });
    check("handoff prompts the OLD session", calledSid === "ses_old");
    check("handoff sends the rotation instruction", calledText.includes("/proj") && calledText.includes("Rotation handoff"));
    check("handoff returns trimmed brief", r === briefText, r);
  }
  // a long reply is capped to HANDOFF_BRIEF_WORDS words
  {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const r = await runRotationHandoff("s", "/d", { prompt: async () => ({ reply: long }) });
    check("handoff caps brief to HANDOFF_BRIEF_WORDS words", r.split(/\s+/).length === HANDOFF_BRIEF_WORDS, `got ${r.split(/\s+/).length}`);
  }
  // prompt throws → "" (graceful degrade)
  {
    const r = await runRotationHandoff("s", "/d", { prompt: async () => { throw new Error("boom"); } });
    check("handoff prompt error → empty brief", r === "");
  }
  // empty/whitespace reply → ""
  {
    const r = await runRotationHandoff("s", "/d", { prompt: async () => ({ reply: "   " }) });
    check("handoff empty reply → empty brief", r === "");
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll rotation checks passed.");
