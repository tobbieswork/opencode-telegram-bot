/**
 * Checks the per-user language mechanism (src/language.ts) and the worker
 * spawn / Manager-confirm templates (src/orchestrator/templates.ts).
 *
 * Covers:
 *   - languageInstructionFor: "en" → the pin, "vi"/unset → null.
 *   - applyLanguagePin: sets the pin for "en", is idempotent per session,
 *     clears it on "vi"/unset, and is best-effort (never throws).
 *   - detectTaskLang: EN/VN heuristic on the raw task text (VN diacritics).
 *   - workerIntroHtml: en reproduces the original wording, vi localizes.
 *   - approvalLines: en is fully English, vi fully Vietnamese.
 *
 * Run:  npx tsx scripts/test-language.ts
 */
import { languageInstructionFor, applyLanguagePin, detectTaskLang, LANGUAGE_EN_INSTRUCTION, type InstructionCtl } from "../src/language.js";
import { workerIntroHtml, approvalLines } from "../src/orchestrator/templates.js";
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

// ── languageInstructionFor ─────────────────────────────────────────────────────────
{
  check("en → the English pin", languageInstructionFor("en") === LANGUAGE_EN_INSTRUCTION);
  check("vi → null (no injection)", languageInstructionFor("vi") === null);
  check("unset → null (no injection)", languageInstructionFor(undefined) === null);
}

// ── detectTaskLang ───────────────────────────────────────────────
{
  check("pure English sentence → en", detectTaskLang("Fix the retry logic in the queue module and add unit tests.") === "en");
  check("normal Vietnamese sentence → vn", detectTaskLang("Viết thử nghiệm cho module queue") === "vn");
  check("EN task with 1-2 quoted VN words → en", detectTaskLang("Fix the bug in the queue module (xem thử lại)") === "en");
  check("empty string → en", detectTaskLang("") === "en");
  check("file paths + code identifiers → en", detectTaskLang("src/queue/retry.ts: export function backoff(attempt: number): number { return attempt * 100; }") === "en");
  check("uppercase Đ sentence → vn", detectTaskLang("Định nghửa lại hàm này trong file src/queue.ts") === "vn");
}

// ── fakes ──────────────────────────────────────────────────────────────────────────
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
    async setInstruction(sid, key) {
      if (this.fail) throw new Error("set failed");
      calls.push(`set:${sid}:${key}`);
    },
    async removeInstruction(sid, key) {
      if (this.fail) throw new Error("rm failed");
      calls.push(`rm:${sid}:${key}`);
    },
  };
}

// ── applyLanguagePin ───────────────────────────────────────────────────────────────
{
  // "en" sets the pin once and records the applied-session.
  const oc = makeOc();
  const st = makeSt({ [conv]: {} });
  await applyLanguagePin(oc, st, conv, "s1", "en");
  check("en sets the instruction", oc.calls.includes("set:s1:tgbot.language_en"), oc.calls.join(","));
  check("en records languageEnSession", st.peek(conv)?.languageEnSession === "s1");

  // Idempotent: a 2nd prompt on the same session does not re-set.
  await applyLanguagePin(oc, st, conv, "s1", "en");
  check("en is idempotent (no 2nd set)", oc.calls.filter((c) => c.startsWith("set:")).length === 1, oc.calls.join(","));

  // A new session re-applies.
  await applyLanguagePin(oc, st, conv, "s2", "en");
  check("new session re-applies the pin", oc.calls.filter((c) => c.startsWith("set:")).length === 2, oc.calls.join(","));

  // Switching to "vi" clears the pin.
  await applyLanguagePin(oc, st, conv, "s2", "vi");
  check("vi clears the instruction", oc.calls.includes("rm:s2:tgbot.language_en"), oc.calls.join(","));
  check("vi clears the applied marker", st.peek(conv)?.languageEnSession === undefined);

  // "vi" when nothing was set is a no-op.
  const oc2 = makeOc();
  const st2 = makeSt({ [conv]: {} });
  await applyLanguagePin(oc2, st2, conv, "s1", "vi");
  check("vi with no pin is a no-op", oc2.calls.length === 0, oc2.calls.join(","));
}
{
  // Best-effort: a failing set never throws and does not record the marker.
  const oc = makeOc();
  oc.fail = true;
  const st = makeSt({ [conv]: {} });
  let threw = false;
  try {
    await applyLanguagePin(oc, st, conv, "s1", "en");
  } catch {
    threw = true;
  }
  check("failing set never throws", !threw);
  check("failing set does not record the marker", st.peek(conv)?.languageEnSession === undefined);
}
{
  // A conv with no state is a no-op (no throw).
  const oc = makeOc();
  const st = makeSt(); // no entry for `conv`
  let threw = false;
  try {
    await applyLanguagePin(oc, st, conv, "s1", "en");
  } catch {
    threw = true;
  }
  check("missing state is a no-op", !threw && oc.calls.length === 0);
}

// ── workerIntroHtml ────────────────────────────────────────────────────────────────
{
  const en = workerIntroHtml("en", { name: "api-fix", agent: "build", directory: "/repo", spawnedBy: "user" });
  check("en intro has name+agent", en.includes("🧩 <b>Worker api-fix</b> · build"));
  check("en intro has dir", en.includes("📁 <code>/repo</code>"));
  check("en intro uses EN hint (no task)", en.includes("Message in this topic to work with the worker."));
  check("en intro no 'Assigned' for user spawn", !en.includes("Assigned"));

  const enMgr = workerIntroHtml("en", { name: "w", agent: "build", directory: "/d", spawnedBy: "manager" });
  check("en intro marks manager spawn", enMgr.includes("· Assigned by Manager"));

  const enWt = workerIntroHtml("en", { name: "w", agent: "build", directory: "/d", spawnedBy: "user", worktree: { branch: "b", base: "main" } });
  check("en intro worktree line", enWt.includes("🌿 dedicated worktree, branch <code>b</code> (from <code>main</code>)"));

  const enTask = workerIntroHtml("en", { name: "w", agent: "build", directory: "/d", spawnedBy: "user", task: "fix the bug" });
  check("en intro shows task", enTask.includes("📝 <b>Task</b>\nfix the bug"));

  const vi = workerIntroHtml("vi", { name: "api-fix", agent: "build", directory: "/repo", spawnedBy: "user" });
  check("vi intro uses VI hint (no task)", vi.includes("Nhắn tin trong topic này để làm việc với worker."));
  const viWt = workerIntroHtml("vi", { name: "w", agent: "build", directory: "/d", spawnedBy: "user", worktree: { branch: "b", base: "main" } });
  check("vi intro worktree line", viWt.includes("🌿 worktree riêng, nhánh <code>b</code> (từ <code>main</code>)"));
  const viMgr = workerIntroHtml("vi", { name: "w", agent: "build", directory: "/d", spawnedBy: "manager" });
  check("vi intro marks manager spawn", viMgr.includes("Giao bởi Manager"));
}

// ── approvalLines ──────────────────────────────────────────────────────────────────
{
  const spawnEn = approvalLines("en", { kind: "spawn", spawn: { name: "w", agent: "build", directory: "/d", task: "do X" } });
  check("approval spawn en header", spawnEn[0] === "🛂 <b>Manager wants to assign work</b>");
  check("approval spawn en worker line", spawnEn[1].includes("New worker: <b>w</b> · build"));
  check("approval spawn en dir line", spawnEn[2].includes("📁 <code>/d</code>"));
  check("approval spawn en task line", spawnEn[spawnEn.length - 1] === "do X");

  const spawnVi = approvalLines("vi", { kind: "spawn", spawn: { name: "w", agent: "build", directory: "/d" } });
  check("approval spawn vi header", spawnVi[0] === "🛂 <b>Manager muốn giao việc</b>");
  check("approval spawn vi worker line", spawnVi[1].includes("Worker mới: <b>w</b>"));

  const spawnRo = approvalLines("en", { kind: "spawn", spawn: { name: "w", directory: "/d", writes: false } });
  check("approval spawn en read-only tag", spawnRo[1].includes("· read-only"));
  const spawnRoVi = approvalLines("vi", { kind: "spawn", spawn: { name: "w", directory: "/d", writes: false } });
  check("approval spawn vi read-only tag", spawnRoVi[1].includes("· chỉ đọc"));

  const sendEn = approvalLines("en", { kind: "send", send: { name: "w", message: "keep going" } });
  check("approval send en line", sendEn[1] === "Send to worker <b>w</b>:");
  check("approval send en message", sendEn[sendEn.length - 1] === "keep going");
  const sendVi = approvalLines("vi", { kind: "send", send: { name: "w", message: "tiếp tục" } });
  check("approval send vi line", sendVi[1] === "Gửi tới worker <b>w</b>:");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll language/template checks passed.");
