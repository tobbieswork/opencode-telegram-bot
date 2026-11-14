/**
 * Checks the per-user output-style mechanism (src/style.ts) and the /style
 * command (src/commands/meta.ts).
 *
 * Covers:
 *   - styleInstructionFor: each of the 4 styles → the exact verbatim text,
 *     "default" → null (no injection).
 *   - styleVersionFor: "default" → ""; one distinct 16-hex fingerprint per
 *     style (stable across calls).
 *   - applyStylePin: sets on first apply, idempotent on re-apply, re-pins on
 *     session change, re-pins on style/version change, clears on "default",
 *     best-effort (never throws, no marker on failure), missing-state no-op.
 *   - UserPrefsStore.getStyle/setStyle: default, set, per-user isolation,
 *     persistence round-trip.
 *   - cmdStyle: no-arg shows current + full list, valid arg sets + confirms
 *     (case-insensitive), invalid arg rejects with usage + list.
 *
 * Run:  npx tsx scripts/test-style.ts
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager, UserPrefsStore } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { cmdStyle } from "../src/commands/meta.js";
import { applyStylePin, STYLE_KEY, STYLE_NAMES, styleInstructionFor, styleVersionFor, type StyleName, type InstructionCtl } from "../src/style.js";
import type { ConvKey } from "../src/conv.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-style-"));
configureAudit({ path: join(tmp, "audit.log") });
const conv = "100:5" as ConvKey;

// ── styleInstructionFor (verbatim texts) ───────────────────────────────────────
const CONCISE =
  "Respond concisely: lead with the result or answer in the first line(s); no preamble, no restating the " +
  "question, no closing summary. Still be fully complete on the technical work — code, fixes, and " +
  "explanations of errors, security warnings, and destructive/deleting operations must be complete. " +
  "Expand detail only when the user asks for it.";
const EXPLANATORY =
  "In addition to the answer, add a short '★ Insight' block after the main response explaining WHY you " +
  "chose the approach (key decisions, trade-offs, reasoning). Keep the main answer normal; the insight " +
  "is a brief add-on.";
const LEARNING =
  "Respond in explanatory style, but additionally leave a few short code sections that involve a design " +
  "decision as clearly-marked '// TODO: you' stubs with a one-line hint, so the user writes them " +
  "themselves. Keep stubs minimal and never break the build.";
const PROACTIVE =
  "Be proactive: start acting immediately on the task without asking for confirmation on routine, " +
  "low-risk decisions (file naming, small refactors, standard patterns). Only pause to ask when a " +
  "decision is genuinely ambiguous, high-risk, destructive, or irreversible. State what you decided " +
  "and why, briefly.";

{
  check("default → null (no injection)", styleInstructionFor("default") === null);
  check("concise → exact verbatim text", styleInstructionFor("concise") === CONCISE);
  check("explanatory → exact verbatim text", styleInstructionFor("explanatory") === EXPLANATORY);
  check("learning → exact verbatim text", styleInstructionFor("learning") === LEARNING);
  check("proactive → exact verbatim text", styleInstructionFor("proactive") === PROACTIVE);
  const texts = ["concise", "explanatory", "learning", "proactive"].map((s) => styleInstructionFor(s as StyleName));
  check("the 4 texts are pairwise distinct", new Set(texts).size === 4);
}

// ── styleVersionFor ────────────────────────────────────────────────────────────
{
  check("default → empty string", styleVersionFor("default") === "");
  const vs = ["concise", "explanatory", "learning", "proactive"].map((s) => styleVersionFor(s as StyleName));
  check("each style has a 16-hex version", vs.every((v) => /^[0-9a-f]{16}$/.test(v)), vs.join(","));
  check("versions differ per style", new Set(vs).size === 4, vs.join(","));
  check("version is stable across calls", styleVersionFor("concise") === styleVersionFor("concise"));
}

// ── fakes (mirror test-suggest.ts) ─────────────────────────────────────────────
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
      calls.push(`set:${sid}:${key}:${value === CONCISE ? "concise" : value === EXPLANATORY ? "explanatory" : value === LEARNING ? "learning" : value === PROACTIVE ? "proactive" : "other"}`);
    },
    async removeInstruction(sid, key) {
      if (this.fail) throw new Error("rm failed");
      calls.push(`rm:${sid}:${key}`);
    },
  };
}

// ── applyStylePin ──────────────────────────────────────────────────────────────
{
  const oc = makeOc();
  const st = makeSt({ [conv]: {} });
  await applyStylePin(oc, st, conv, "s1", "concise");
  check("concise sets the instruction (exact text)", oc.calls.includes(`set:s1:${STYLE_KEY}:concise`), oc.calls.join(","));
  check("records styleSession + styleVersion", st.peek(conv)?.styleSession === "s1" && st.peek(conv)?.styleVersion === styleVersionFor("concise"));

  // Idempotent: a 2nd prompt on the same session does not re-set.
  await applyStylePin(oc, st, conv, "s1", "concise");
  check("idempotent (no 2nd set)", oc.calls.filter((c) => c.startsWith("set:")).length === 1, oc.calls.join(","));

  // A new session re-applies.
  await applyStylePin(oc, st, conv, "s2", "concise");
  check("new session re-applies the pin", oc.calls.filter((c) => c.startsWith("set:")).length === 2, oc.calls.join(","));

  // Switching style on the same session re-pins (version mismatch).
  await applyStylePin(oc, st, conv, "s2", "explanatory");
  check("style change re-pins the same session", oc.calls.includes(`set:s2:${STYLE_KEY}:explanatory`), oc.calls.join(","));
  check("re-pin records the new version", st.peek(conv)?.styleVersion === styleVersionFor("explanatory"));
  await applyStylePin(oc, st, conv, "s2", "explanatory");
  check("re-pinned state stays idempotent", oc.calls.filter((c) => c.startsWith("set:")).length === 3, oc.calls.join(","));

  // An instruction-text change (version mismatch, same style) re-pins.
  st.set(conv, { styleVersion: "stale-fingerprint" });
  await applyStylePin(oc, st, conv, "s2", "explanatory");
  check("version mismatch re-pins the same session", oc.calls.filter((c) => c.startsWith("set:")).length === 4, oc.calls.join(","));
  check("re-pin records the current version", st.peek(conv)?.styleVersion === styleVersionFor("explanatory"));

  // Switching back to "default" clears the instruction + markers.
  await applyStylePin(oc, st, conv, "s2", "default");
  check("default clears the instruction", oc.calls.includes(`rm:s2:${STYLE_KEY}`), oc.calls.join(","));
  check("default clears the session marker", st.peek(conv)?.styleSession === undefined);
  check("default clears the version marker", st.peek(conv)?.styleVersion === undefined);

  // "default" when nothing was set is a no-op.
  const oc2 = makeOc();
  const st2 = makeSt({ [conv]: {} });
  await applyStylePin(oc2, st2, conv, "s1", "default");
  check("default with no pin is a no-op", oc2.calls.length === 0, oc2.calls.join(","));
}
{
  // Best-effort: a failing set never throws and does not record the marker.
  const oc = makeOc();
  oc.fail = true;
  const st = makeSt({ [conv]: {} });
  let threw = false;
  try {
    await applyStylePin(oc, st, conv, "s1", "concise");
  } catch {
    threw = true;
  }
  check("failing set never throws", !threw);
  check("failing set does not record the marker", st.peek(conv)?.styleSession === undefined);
}
{
  // A conv with no state is a no-op (no throw).
  const oc = makeOc();
  const st = makeSt(); // no entry for `conv`
  let threw = false;
  try {
    await applyStylePin(oc, st, conv, "s1", "concise");
  } catch {
    threw = true;
  }
  check("missing state is a no-op", !threw && oc.calls.length === 0);
}

// ── UserPrefsStore.getStyle / setStyle ─────────────────────────────────────────
{
  const ufile = join(tmp, "users-prefs.json");
  const up = new UserPrefsStore(ufile);
  check("default style is default (no prefs)", up.getStyle("123") === "default");

  up.setStyle("123", "concise");
  check("setStyle + getStyle roundtrip", up.getStyle("123") === "concise");

  up.setStyle("456", "proactive");
  check("per-user isolation (456=proactive, 123=concise)", up.getStyle("456") === "proactive" && up.getStyle("123") === "concise");

  // Persistence across "restart".
  const up2 = new UserPrefsStore(ufile);
  check("styles survive reload", up2.getStyle("123") === "concise" && up2.getStyle("456") === "proactive");
  check("unknown user still defaults to default", up2.getStyle("999") === "default");

  // Overwrite + clear back to default.
  up2.setStyle("123", "default");
  check("overwrite to default works", up2.getStyle("123") === "default");
  check("setting default still creates the entry", up2.getStyle("123") === "default");
}

// ── cmdStyle (mock Bot, mirror test-queue-cmd) ─────────────────────────────────
function makeStyleBot() {
  const sent: string[] = [];
  const htmls: string[] = [];
  const tg: any = {
    sendMessage: async (_conv: string, text: string) => { sent.push(text); return 1; },
  };
  const oc: any = {
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(tmp, `state-style-${process.pid}-${Math.random().toString(16).slice(2)}.json`));
  const cfg: any = { stateFile: join(tmp, `state-file-style-${process.pid}.json`), maxSchedules: 5, busyMode: "ask" };
  const bot: any = new Bot(tg, oc, st, cfg);
  bot.sendHtml = async (_conv: string, html: string) => { htmls.push(html); };
  return { bot, sent, htmls, st };
}

{
  const { bot, sent, htmls } = makeStyleBot();
  const uid = 777;

  // No arg → current style (default) + all 5 list lines + usage hint.
  await cmdStyle(bot, conv, "", uid);
  check("no-arg replies via sendHtml", htmls.length === 1, `sent=${sent.length} html=${htmls.length}`);
  const list = htmls[0] ?? "";
  check("no-arg shows current style", list.includes("<b>default</b>"), list);
  for (const n of STYLE_NAMES) check(`no-arg lists ${n}`, list.includes(n), list);
  check("no-arg shows the usage hint", list.includes("/style [default|concise|explanatory|learning|proactive]"), list);

  // Valid arg → sets + confirms.
  await cmdStyle(bot, conv, "concise", uid);
  check("valid arg sets the pref", bot.userPrefs.getStyle(uid) === "concise");
  check("valid arg confirms (plain message)", sent.length === 1 && sent[0].includes("concise"), sent.join("|"));

  // Case-insensitive.
  await cmdStyle(bot, conv, "Proactive", uid);
  check("valid arg is case-insensitive", bot.userPrefs.getStyle(uid) === "proactive");
  check("case-insensitive arg confirms", sent.length === 2 && sent[1].includes("proactive"), sent.join("|"));

  // Invalid arg → rejects (usage + list), pref unchanged.
  const before = bot.userPrefs.getStyle(uid);
  await cmdStyle(bot, conv, "bogus", uid);
  check("invalid arg does not change the pref", bot.userPrefs.getStyle(uid) === before);
  check("invalid arg replies with the offending arg", htmls.length === 2 && htmls[1].includes("bogus"), (htmls[1] ?? "").slice(0, 120));
  check("invalid arg shows the usage hint", (htmls[1] ?? "").includes("/style [default|concise|explanatory|learning|proactive]"), (htmls[1] ?? "").slice(0, 200));

  // "default" clears back to stock behavior.
  await cmdStyle(bot, conv, "default", uid);
  check("default arg clears the pref", bot.userPrefs.getStyle(uid) === "default");
  check("default arg confirms", sent.length === 3, sent.join("|"));

  // No-arg now shows the updated current style.
  await cmdStyle(bot, conv, "", uid);
  check("no-arg reflects the updated current style", (htmls[2] ?? "").includes("<b>default</b>"), (htmls[2] ?? "").slice(0, 120));
}

if (failures > 0) {
  console.error(`\n${failures} style check(s) FAILED`);
  await rm(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log("\nAll style checks passed.");
