/**
 * /spec command (spec-to-tasks S2): list + detail, NO running.
 *
 * Fixtures are small markdown files in a fresh temp dir (a real `git init`
 * for the git-root cases) — never the repo's own docs/sdd.
 *
 * Run:  npx tsx scripts/test-spec-cmd.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSpec, handleSpecCallback } from "../src/commands/spec.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
// alpha: 1 done (with commit), 1 next, 1 blocked (Needs:), 1 todo, checkpoints.
const ALPHA = `# Alpha spec

## Design
Some design text.

## 5. Tasks
1. [x] (abc1234) **S1 First.** A done task (Q1.1). *Checkpoint: review it.*
2. [ ] **S2 Second.** The next task. *Checkpoint: browse in Telegram.*
3. [ ] **S3 Third.** Needs: live OpenCode service
4. [ ] **S4 Fourth.** A later task.
`;

// beta: a design doc — no Tasks section, must NOT be listed.
const BETA = `# Beta design doc

## Notes
No tasks section here — a pure design doc.
`;

// gamma: a Tasks section whose first item cannot be parsed (fails at line 4).
const GAMMA = `# Gamma spec

## Tasks
1. this item has no bold task id so it fails to parse
`;

// delta: first todo is blocked, so the next runnable is the second one.
const DELTA = `# Delta spec

## Tasks
1. [ ] **D1 One.** Needs: VPN access
2. [ ] **D2 Two.** plain next task
`;

// omega: everything done — no Run button, "all done" note.
const OMEGA = `# Omega spec

## Tasks
1. [x] (fff0011) **O1 Only.** everything done
`;

// ── setup: temp dirs (a git repo with fixtures, a bare git repo, a plain dir) ─
const tmp = mkdtempSync(join(tmpdir(), "spec-cmd-"));
const repo = join(tmp, "repo");
const sdd = join(repo, "docs", "sdd");
mkdirSync(sdd, { recursive: true });
for (const [name, body] of [
  ["alpha.md", ALPHA],
  ["beta.md", BETA],
  ["gamma.md", GAMMA],
  ["delta.md", DELTA],
  ["omega.md", OMEGA],
] as const) writeFileSync(join(sdd, name), body);
execFileSync("git", ["init", "-q"], { cwd: repo });

const bare = join(tmp, "bare"); // git repo, no docs/sdd
mkdirSync(bare, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: bare });

const plain = join(tmp, "plain"); // not a git repo at all
mkdirSync(plain, { recursive: true });

// ── duck bot ────────────────────────────────────────────────────────────────
interface SentMsg {
  text: string;
  kb?: Array<Array<{ text: string; callback_data: string }>>;
}
function mkBot(lang: "vi" | "en", dir: string, spec = true) {
  const sent: SentMsg[] = [];
  const push = (_c: string, text: string, opts?: { reply_markup?: { inline_keyboard: SentMsg["kb"] } }) => {
    sent.push({ text, kb: opts?.reply_markup?.inline_keyboard });
  };
  const bot: any = {
    cfg: { spec, opencodeDirectory: dir },
    userPrefs: { getLang: () => lang },
    st: { peek: () => ({ directory: dir }), get: () => ({ directory: dir }) },
    tg: {
      sendMessage: async (c: string, text: string, opts?: any) => void push(c, text, opts),
      answerCallbackQuery: async (_id: string, _t?: string) => {},
    },
    sendHtml: async (c: string, text: string, opts?: any) => void push(c, text, opts),
  };
  return { bot, sent };
}
const CONV = "123:45";
const cb = (data: string) => ({ id: "cb-1", from: { id: 7 }, data });

try {
  // ── S6.1: off-flag reply (vi + en), one line, nothing else ─────────────────
  for (const lang of ["vi", "en"] as const) {
    const { bot, sent } = mkBot(lang, repo, false);
    await cmdSpec(bot, CONV, 7);
    const t = sent[0]?.text ?? "";
    check(`off-flag (${lang}): exactly one message, no buttons`, sent.length === 1 && !sent[0].kb, JSON.stringify(sent));
    check(`off-flag (${lang}): says disabled`, lang === "vi" ? t.includes("tắt") : t.includes("disabled"), t);
  }

  // ── S1.3: not a git repo — one line, nothing else ──────────────────────────
  {
    const { bot, sent } = mkBot("vi", plain);
    await cmdSpec(bot, CONV, 7);
    const t = sent[0]?.text ?? "";
    check("S1.3 not-git: one line, no buttons", sent.length === 1 && !sent[0].kb, JSON.stringify(sent));
    check("S1.3 not-git: names the problem", t.includes("git"), t);
  }

  // ── S1.3: git repo without docs/sdd — one line, nothing else ───────────────
  {
    const { bot, sent } = mkBot("en", bare);
    await cmdSpec(bot, CONV, 7);
    const t = sent[0]?.text ?? "";
    check("S1.3 no docs/sdd: one line, no buttons", sent.length === 1 && !sent[0].kb, JSON.stringify(sent));
    check("S1.3 no docs/sdd: mentions docs/sdd", t.includes("docs/sdd"), t);
  }

  // ── S1.1: list with progress (vi + en) ─────────────────────────────────────
  for (const lang of ["vi", "en"] as const) {
    const { bot, sent } = mkBot(lang, repo);
    await cmdSpec(bot, CONV, 7);
    const m = sent[0];
    const kb = (m?.kb ?? []).flat();
    check(`list (${lang}): one message with buttons`, !!m?.kb, JSON.stringify(sent));
    check(`list (${lang}): 4 entries (design doc excluded)`, kb.length === 4, kb.map((b) => b.text).join(" | "));
    const alpha = kb.find((b) => b.callback_data === "spec:alpha");
    const gamma = kb.find((b) => b.callback_data === "spec:gamma");
    const omega = kb.find((b) => b.callback_data === "spec:omega");
    check(`list (${lang}): alpha shows title + 1/4`, !!alpha && alpha.text.includes("Alpha spec") && alpha.text.includes("1/4"), alpha?.text);
    check(`list (${lang}): omega shows 1/1`, !!omega && omega.text.includes("1/1"), omega?.text);
    check(`list (${lang}): gamma marked with ⚠️`, !!gamma && gamma.text.includes("⚠️"), gamma?.text);
    check(`list (${lang}): design doc has no button`, !kb.some((b) => b.callback_data === "spec:beta"));
    const body = (m?.text ?? "").replace(/<\/?[a-z]+>/g, "");
    check(`list (${lang}): no raw < outside markup`, !body.includes("<"), m?.text);
  }

  // ── S1.2: detail — statuses done/next/todo/blocked + checkpoints + Run ─────
  {
    const { bot, sent } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("spec:alpha"), CONV);
    const m = sent[0];
    const t = m?.text ?? "";
    check("detail alpha: message with buttons", !!m?.kb, t);
    check("detail alpha: done ✅ with commit hash", t.includes("✅") && t.includes("abc1234"), t);
    check("detail alpha: next is ▶️ S2", /▶️\s*<b>S2<\/b>/.test(t), t);
    check("detail alpha: blocked ⛔ with reason", t.includes("⛔") && t.includes("live OpenCode service"), t);
    check("detail alpha: todo ○ S4", /○\s*<b>S4<\/b>/.test(t), t);
    check("detail alpha: checkpoint lines shown", t.includes("Checkpoint: review it") && t.includes("Checkpoint: browse in Telegram"), t);
    const runBtns = (m?.kb ?? []).flat().filter((b) => b.callback_data.startsWith("specrun:"));
    check("detail alpha: exactly one Run button", runBtns.length === 1, JSON.stringify(runBtns));
    check("detail alpha: Run on the next runnable (S2, n=2)", runBtns[0]?.callback_data === "specrun:alpha:2" && runBtns[0].text.includes("S2"), JSON.stringify(runBtns));
  }

  // ── S1.2: next skips a blocked first todo ──────────────────────────────────
  {
    const { bot, sent } = mkBot("en", repo);
    await handleSpecCallback(bot, cb("spec:delta"), CONV);
    const m = sent[0];
    const t = m?.text ?? "";
    const runBtns = (m?.kb ?? []).flat().filter((b) => b.callback_data.startsWith("specrun:"));
    check("detail delta: D1 blocked, D2 is next", t.includes("⛔") && t.includes("VPN access") && /▶️\s*<b>D2<\/b>/.test(t), t);
    check("detail delta: Run targets D2 (n=2)", runBtns.length === 1 && runBtns[0]?.callback_data === "specrun:delta:2", JSON.stringify(runBtns));
  }

  // ── S1.2: all done — no Run button ─────────────────────────────────────────
  {
    const { bot, sent } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("spec:omega"), CONV);
    const m = sent[0];
    const t = m?.text ?? "";
    check("detail omega: ✅ with commit", t.includes("✅") && t.includes("fff0011"), t);
    check("detail omega: no Run button", (m?.kb?.flat().filter((b) => b.callback_data.startsWith("specrun:")).length ?? 0) === 0, JSON.stringify(m?.kb));
    check("detail omega: all-done note", t.includes("xong") || t.includes("done"), t);
  }

  // ── regression: detail notes follow the user's language (S6.3) ─────────────
  {
    const { bot, sent } = mkBot("en", repo);
    await handleSpecCallback(bot, cb("spec:omega"), CONV);
    const t = sent[0]?.text ?? "";
    check("detail omega (en): all-done note in English", t.includes("All tasks done."), t);
    check("detail omega (en): no Vietnamese leak", !t.includes("Tất cả"), t);
  }
  {
    const { bot, sent } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("spec:gamma"), CONV);
    const t = sent[0]?.text ?? "";
    check("parse-error detail (vi): heading in Vietnamese", t.includes("Không phân tích được"), t);
  }

  // ── Run tap: bilingual "not available yet" (execution is S4) ───────────────
  {
    const { bot, sent } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("specrun:alpha:2"), CONV);
    const t = sent[0]?.text ?? "";
    check("run tap: vi line", t.includes("Chưa thể chạy task"), t);
    check("run tap: en line", t.includes("not available yet"), t);
  }

  // ── S1.4: parse failure — listed marked, detail names file + line, no run ──
  {
    const { bot, sent } = mkBot("en", repo);
    await handleSpecCallback(bot, cb("spec:gamma"), CONV);
    const m = sent[0];
    const t = m?.text ?? "";
    check("parse-error detail: names the spec file", t.includes("gamma.md"), t);
    check("parse-error detail: names the failing line (4)", t.includes("4:"), t);
    check("parse-error detail: no buttons (never offer to run)", !m?.kb, t);
  }

  // ── safety: tampered / unknown names are refused ───────────────────────────
  {
    const { bot, sent } = mkBot("en", repo);
    await handleSpecCallback(bot, cb("spec:../../etc/passwd"), CONV);
    const t = sent[0]?.text ?? "";
    check("unknown spec: refused with one line", sent.length === 1 && t.includes("❌"), t);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll /spec command checks passed.");
