/**
 * S5 (checkpoint card) — S3.1/S3.2/S3.3/S3.7: a spec worker that reaches a
 * terminal status posts a checkpoint card to the owner chat's conv carrying the
 * task id, the worker's commit, the files changed, the checks RUN (from the
 * worker's ACTUAL shell results, never its claim) and NOT run, the task's
 * checkpoint sentence, and Accept / Redo / Stop buttons. An errored run or a
 * run without a worker commit offers Redo + Stop ONLY (no Accept).
 *
 * Covers, in two layers:
 *   - the PURE builders (classifyShellItems, checkNameFromCommand,
 *     computeNotRan, checkpointOutcome, renderCheckpointCard) — no I/O.
 *   - the WIRING (real Orchestrator + StateManager + a real temp git repo):
 *     setStatus(terminal) on a spec worker posts the card to specRun.conv and
 *     emits the S6.2 spec_checkpoint audit event.
 *
 * Fixtures are a fresh temp git repo (real `git init`) on a `spec/alpha`
 * branch cut from `main` — never the repo's own docs/sdd.
 *
 * Run:  npx tsx scripts/test-spec-checkpoint.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyShellItems,
  checkNameFromCommand,
  computeNotRan,
  checkpointOutcome,
  renderCheckpointCard,
  EXPECTED_CHECKS,
} from "../src/spec-checkpoint.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
/** Poll `cond` every 20ms until true or the timeout (for the fire-and-forget card). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const tmp = mkdtempSync(join(tmpdir(), "spec-ckpt-"));

try {
  // ── S3.2: classifyShellItems — three-way classification ───────────────────
  {
    const items = [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 1 } } },
      { type: "tool", name: "shell", state: { status: "error", input: { command: "npm run smoke" }, error: { message: "no such script" } } },
      { type: "tool", name: "shell", state: { status: "running", input: { command: "npm run other" } } },
      { type: "tool", name: "read", state: { status: "completed", input: { path: "x" } } }, // non-shell: ignored
    ];
    const { ran } = classifyShellItems(items);
    check("classify: 3 shell results (read tool + running ignored)", ran.length === 3, JSON.stringify(ran));
    const byName = Object.fromEntries(ran.map((r) => [r.name, r]));
    check("classify: typecheck completed exit0 → ran, passed", byName.typecheck?.ok === true, JSON.stringify(byName.typecheck));
    check("classify: test:unit completed exit1 → ran, FAILED", byName["test:unit"]?.ok === false && byName["test:unit"]?.error === undefined, JSON.stringify(byName["test:unit"]));
    check("classify: smoke status error → NOT ran (errored, carries message)", byName.smoke?.ok === false && byName.smoke?.error === "no such script", JSON.stringify(byName.smoke));
    check("classify: a pending/running check is absent (counts as not run)", !("other" in byName), JSON.stringify(Object.keys(byName)));

    // A check with no recorded result at all → not run.
    const notRan = computeNotRan(ran);
    check("notRan: only truly-absent expected checks", notRan.length === 0 || notRan.every((c) => EXPECTED_CHECKS.includes(c)), JSON.stringify(notRan));
    check("notRan: typecheck/test:unit/smoke all have results → none not-run", computeNotRan(classifyShellItems(items).ran).length === 0, JSON.stringify(computeNotRan(classifyShellItems(items).ran)));
    check("notRan: an expected check with no result IS listed", computeNotRan([]).join(",") === "typecheck,test:unit,smoke", JSON.stringify(computeNotRan([])));
  }

  // ── S3.2 (regression, 2026-11-18): exploratory calls are NOT checks ─────
  {
    // The callback-registry T4 session: typecheck + test:unit passed, but the
    // worker had run failing exploratory commands (grep with no match, ls on a
    // missing path, a python heredoc). The checkpoint must be a pass.
    const items = [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "grep -n foo src/" }, metadata: { exit: 1 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "ls docs/specs" }, metadata: { exit: 2 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "python3 - <<'EOF'" }, metadata: { exit: 1 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck 2>&1 | tail -2" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit 2>&1 | tail -5" }, metadata: { exit: 0 } } },
    ];
    // Unfiltered (legacy behaviour) still classifies everything.
    const all = classifyShellItems(items).ran;
    check("unfiltered: sees every shell call incl. failing exploratory ones", all.length === 5 && all.some((c) => !c.ok), JSON.stringify(all));
    // The checkpoint filters to the canonical verify checks.
    const { ran } = classifyShellItems(items, EXPECTED_CHECKS);
    check("canonical filter: only typecheck + test:unit remain", ran.length === 2 && ran.every((c) => c.ok), JSON.stringify(ran));
    check("canonical filter: the run is a pass despite failed greps/ls/python", checkpointOutcome({ hash: "abc", subject: "x" }, ran, false) === "pass");
    check("canonical filter: errored does not inherit exploratory tool errors", !ran.some((c) => c.error !== undefined), JSON.stringify(ran));
    // A failing CANONICAL check still fails, even among exploratory noise.
    const bad = [
      items[0],
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 1 } } },
    ];
    const { ran: ranBad } = classifyShellItems(bad, EXPECTED_CHECKS);
    check("canonical filter: a failing test:unit still fails the run", checkpointOutcome({ hash: "abc", subject: "x" }, ranBad, false) === "fail");
  }

  // ── S3.2: retry-aware — the LAST recorded occurrence per check wins ───────
  {
    // (a) failed → fixed env → re-ran green: the card shows the final state.
    const itemsA = [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 2 } } },
      { type: "tool", name: "shell", state: { status: "error", input: { command: "npm run typecheck" }, error: { message: "no node_modules" } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
    ];
    const { ran: ranA } = classifyShellItems(itemsA);
    check("retry: one entry per check name (last occurrence wins)", ranA.length === 1, JSON.stringify(ranA));
    check("retry: recovered check is ok=true and carries no error", ranA[0].ok === true && ranA[0].error === undefined, JSON.stringify(ranA[0]));
    check("retry: recovered run is a pass (with commit)", checkpointOutcome({ hash: "abc", subject: "x" }, ranA, false) === "pass");

    // (b) failed and never re-run: still fails.
    const itemsB = [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 1 } } },
    ];
    const { ran: ranB } = classifyShellItems(itemsB);
    check("retry: an unretried failure still fails", checkpointOutcome({ hash: "abc", subject: "x" }, ranB, false) === "fail");

    // (c) retry of one check never hides a failure of another check.
    const itemsC = [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 2 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 1 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
    ];
    const { ran: ranC } = classifyShellItems(itemsC);
    const cByName = Object.fromEntries(ranC.map((r) => [r.name, r]));
    check("retry: display keeps first-seen order", ranC.map((r) => r.name).join(",") === "typecheck,test:unit", JSON.stringify(ranC.map((r) => r.name)));
    check("retry: recovered check ok, sibling failure kept", cByName.typecheck?.ok === true && cByName["test:unit"]?.ok === false, JSON.stringify(ranC));
    check("retry: sibling failure → fail", checkpointOutcome({ hash: "abc", subject: "x" }, ranC, false) === "fail");

    // (d) a tool-error that is later re-run green is no longer "errored".
    const itemsD = [
      { type: "tool", name: "shell", state: { status: "error", input: { command: "npm run smoke" }, error: { message: "cwd gone" } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run smoke" }, metadata: { exit: 0 } } },
    ];
    const { ran: ranD } = classifyShellItems(itemsD);
    check("retry: re-run after tool error → not errored, ok", ranD.length === 1 && ranD[0].ok === true && ranD[0].error === undefined, JSON.stringify(ranD));
  }

  // ── S3.2: checkNameFromCommand ────────────────────────────────────────────
  {
    check("name: npm run typecheck → typecheck", checkNameFromCommand("npm run typecheck") === "typecheck", checkNameFromCommand("npm run typecheck"));
    check("name: npm run test:unit → test:unit", checkNameFromCommand("npm run test:unit") === "test:unit", checkNameFromCommand("npm run test:unit"));
    check("name: pnpm run smoke → smoke", checkNameFromCommand("pnpm run smoke") === "smoke", checkNameFromCommand("pnpm run smoke"));
    check("name: yarn test:unit → test:unit", checkNameFromCommand("yarn test:unit") === "test:unit", checkNameFromCommand("yarn test:unit"));
    check("name: wrapped (first segment) → typecheck", checkNameFromCommand("npm run typecheck; echo exit:$?") === "typecheck", checkNameFromCommand("npm run typecheck; echo exit:$?"));
    check("name: plain command → first token", checkNameFromCommand("git status") === "git", checkNameFromCommand("git status"));
  }

  // ── S3.7: checkpointOutcome ───────────────────────────────────────────────
  {
    const commit = { hash: "abc1234", subject: "feat: work" };
    const ok = [{ name: "typecheck", ok: true }];
    const bad = [{ name: "typecheck", ok: false }];
    check("outcome: errored → error", checkpointOutcome(commit, ok, true) === "error", checkpointOutcome(commit, ok, true));
    check("outcome: no commit → no-commit", checkpointOutcome(undefined, ok, false) === "no-commit", checkpointOutcome(undefined, ok, false));
    check("outcome: a failed check → fail", checkpointOutcome(commit, bad, false) === "fail", checkpointOutcome(commit, bad, false));
    check("outcome: commit + all checks ok → pass", checkpointOutcome(commit, ok, false) === "pass", checkpointOutcome(commit, ok, false));
  }

  // ── S3.1/S3.3/S3.7: renderCheckpointCard ──────────────────────────────────
  {
    const task = { n: 2, id: "S2", title: "Second", marker: "todo" as const, body: "x", reqIds: [], checkpoint: "review the diff" };
    const base = {
      task,
      workerName: "spec-alpha",
      branch: "spec/alpha",
      commit: { hash: "abc1234", subject: "feat: S2 work" },
      files: ["src/foo.ts", "docs/sdd/alpha.md"],
      checks: { ran: [{ name: "typecheck", ok: true }, { name: "test:unit", ok: false }], notRan: ["smoke"] },
      errored: false,
      lang: "en" as const,
    };

    // The normal case: a commit exists and it's not errored → Accept IS offered.
    const ok = renderCheckpointCard(base);
    const kbs = ok.keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    check("card(en): carries the task id + title", ok.text.includes("S2") && ok.text.includes("Second"), ok.text);
    check("card(en): carries the commit hash + subject", ok.text.includes("abc1234") && ok.text.includes("feat: S2 work"), ok.text);
    check("card(en): carries the files changed", ok.text.includes("src/foo.ts") && ok.text.includes("docs/sdd/alpha.md"), ok.text);
    check("card(en): lists a passed check with ✅", ok.text.includes("typecheck") && ok.text.includes("✅"), ok.text);
    check("card(en): lists a failed check with ❌", ok.text.includes("test:unit") && ok.text.includes("❌"), ok.text);
    check("card(en): lists the NOT-run check (smoke)", ok.text.includes("NOT run") && ok.text.includes("smoke"), ok.text);
    check("card(en): carries the checkpoint sentence", ok.text.includes("review the diff"), ok.text);
    check("card(en): Accept + Redo + Stop all present", kbs.includes("spcacc:alpha:2") && kbs.includes("spcredo:alpha:2") && kbs.includes("spcstop:alpha:2"), JSON.stringify(kbs));

    // S3.7: errored → NO Accept (Redo + Stop only).
    const err = renderCheckpointCard({ ...base, errored: true });
    const errKb = err.keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    check("card(errored): NO Accept button", !errKb.some((d) => d.startsWith("spcacc:")), JSON.stringify(errKb));
    check("card(errored): Redo + Stop present", errKb.includes("spcredo:alpha:2") && errKb.includes("spcstop:alpha:2"), JSON.stringify(errKb));
    check("card(errored): says it ended in error", /error/i.test(err.text), err.text);

    // S3.7: no commit → NO Accept (Redo + Stop only).
    const noc = renderCheckpointCard({ ...base, commit: undefined });
    const nocKb = noc.keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    check("card(no-commit): NO Accept button", !nocKb.some((d) => d.startsWith("spcacc:")), JSON.stringify(nocKb));
    check("card(no-commit): says no commit", /no commit/i.test(noc.text), noc.text);
    check("card(no-commit): omits the commit section", !noc.text.includes("abc1234"), noc.text);

    // S6.5: auto mode on → the card says so and does NOT offer the auto button.
    const autoCard = renderCheckpointCard({ ...base, auto: true });
    const autoKb = autoCard.keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    check("card(auto): carries the auto banner", /Auto-run/i.test(autoCard.text), autoCard.text);
    check("card(auto): no auto button", !autoKb.some((d) => d.startsWith("spcauto:")), JSON.stringify(autoKb));
    check("card(auto): Accept still present", autoKb.includes("spcacc:alpha:2"), JSON.stringify(autoKb));
    // S6.5: normal card → offers the auto opt-in button.
    check("card(normal): offers the auto opt-in button", kbs.includes("spcauto:alpha:2"), JSON.stringify(kbs));
    // S6.5: errored card (no Accept) → no auto button either.
    check("card(errored): no auto button", !errKb.some((d) => d.startsWith("spcauto:")), JSON.stringify(errKb));

    // i18n: the Vietnamese variant renders (different label set, still bilingual-safe).
    const vi = renderCheckpointCard({ ...base, lang: "vi" });
    check("card(vi): renders the Vietnamese Accept label", vi.keyboard.inline_keyboard.flat().some((b) => b.text === "✅ Chấp nhận"), JSON.stringify(vi.keyboard));
    check("card(vi): carries the same task id", vi.text.includes("S2"), vi.text);

    // HTML safety: a hostile value must be escaped, never a raw tag.
    const hostile = renderCheckpointCard({
      ...base,
      commit: { hash: "abc1234", subject: `</b><script>x</script>` },
      files: ["<b>evil</b>.ts"],
      checks: { ran: [{ name: "typecheck", ok: false, error: "bad & <broken>" }], notRan: [] },
      lang: "en",
    });
    check("card(html): no raw <script> leaks", !hostile.text.includes("<script>"), hostile.text);
    check("card(html): angle brackets are escaped", hostile.text.includes("&lt;script&gt;") && hostile.text.includes("&lt;b&gt;"), hostile.text);
  }

  // ── T2 (ocr-hardening): the parsed report block on the card ───────────────
  {
    const rTask = { n: 2, id: "S2", title: "Second", marker: "todo" as const, body: "x", reqIds: [], checkpoint: "review the diff" };
    const base = {
      task: rTask,
      workerName: "spec-alpha",
      branch: "spec/alpha",
      commit: { hash: "abc1234", subject: "feat: S2 work" },
      files: ["src/foo.ts", "docs/sdd/alpha.md"],
      checks: { ran: [{ name: "typecheck", ok: true }, { name: "test:unit", ok: false }], notRan: ["smoke"] },
      errored: false,
      lang: "en" as const,
    };
    const fullReport = {
      status: "DONE",
      coverage: "- brief section: done\n- parser + card: done",
      files: "src/foo.ts",
      tests: "npm run typecheck ok, npm run test:unit ok",
      followUps: "none",
      missing: [] as string[],
    };
    // A full report: the compact block renders, no missing-fields warning.
    const withFull = renderCheckpointCard({ ...base, report: fullReport });
    check("card(report): shows the report header", withFull.text.includes("Worker report:"), withFull.text);
    check("card(report): shows Status value", withFull.text.includes("<b>Status</b>: DONE"), withFull.text);
    check("card(report): shows multi-line Coverage (value + indented continuation)", withFull.text.includes("<b>Coverage</b>: - brief section: done") && withFull.text.includes("  - parser + card: done"), withFull.text);
    check("card(report): shows Files/Tests/Follow-ups", withFull.text.includes("<b>Files</b>: src/foo.ts") && withFull.text.includes("<b>Tests</b>:") && withFull.text.includes("<b>Follow-ups</b>: none"), withFull.text);
    check("card(report): full report → NO missing-fields warning", !withFull.text.includes("Missing report fields"), withFull.text);

    // A partial report: the missing fields get a ⚠️ line — SOFT, the buttons
    // never depend on the report (Accept is still offered).
    const partialReport = { status: "DONE", files: "src/foo.ts", missing: ["Coverage", "Tests", "Follow-ups"] as string[] };
    const withPartial = renderCheckpointCard({ ...base, report: partialReport });
    check("card(report partial): ⚠️ line lists the missing fields", withPartial.text.includes("Missing report fields:") && withPartial.text.includes("Coverage, Tests, Follow-ups"), withPartial.text);
    const pkb = withPartial.keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    check("card(report partial): SOFT — Accept still offered", pkb.includes("spcacc:alpha:2"), JSON.stringify(pkb));

    // An empty Follow-ups is PRESENT (the schema allows it) → not listed as missing.
    const emptyFollowUps = { status: "DONE", coverage: "x", files: "a", tests: "t", followUps: "", missing: [] as string[] };
    const withEmpty = renderCheckpointCard({ ...base, report: emptyFollowUps });
    check("card(report): empty Follow-ups renders without a missing warning", withEmpty.text.includes("<b>Follow-ups</b>:") && !withEmpty.text.includes("Missing report fields"), withEmpty.text);

    // No report (final message had no text) → no report section at all.
    const noReportCard = renderCheckpointCard(base);
    check("card(no report): no report section", !noReportCard.text.includes("Worker report:"), noReportCard.text);

    // HTML safety: hostile report values are escaped.
    const hostileReport = { status: "DONE", coverage: "<script>x</script>", missing: [] as string[] };
    const withHostile = renderCheckpointCard({ ...base, report: hostileReport });
    check("card(report html): no raw <script> leaks", !withHostile.text.includes("<script>") && withHostile.text.includes("&lt;script&gt;"), withHostile.text);

    // i18n: the Vietnamese header.
    const viReport = renderCheckpointCard({ ...base, lang: "vi", report: fullReport });
    check("card(report vi): Vietnamese report header", viReport.text.includes("Report của worker:"), viReport.text);
  }

  // ── Wiring: setStatus(terminal) on a spec worker posts the card ────────────
  // A real temp git repo: `main` with the spec, `spec/alpha` cut from it, a
  // marker commit, then a worker commit (so a worker commit exists).
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, "docs", "sdd"), { recursive: true });
  const SPEC = `# Alpha spec

## Design
Some design.

## 5. Tasks
1. [x] (abc1234) **S1 First.** Done. *Checkpoint: review it.*
2. [ ] **S2 Second.** The next task. *Checkpoint: review the diff.*
`;
  writeFileSync(join(repo, "docs", "sdd", "alpha.md"), SPEC);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test.local"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  // The spec branch: cut from main, marker commit, then a worker commit.
  git(repo, ["checkout", "-q", "-b", "spec/alpha"]);
  const marked = SPEC.replace("2. [ ] **S2 Second.**", "2. [ ] **S2 Second.** ");
  writeFileSync(join(repo, "docs", "sdd", "alpha.md"), marked);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "docs: add S4 task markers to alpha.md"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "foo.ts"), "export const x = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: S2 work"]);
  const workerCommitHash = git(repo, ["rev-parse", "--short", "HEAD"]);
  const HEAD = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  check("fixture: on spec/alpha", HEAD === "spec/alpha", HEAD);

  // T2: the worker's final message with the full report block — the PRODUCTION
  // shape of latestReply ({ text, time }), not a bare string.
  const FULL_REPORT = [
    "All sub-steps done.",
    "",
    "Status: DONE",
    "Coverage: - brief: done, - parser + card: done",
    "Files: src/foo.ts",
    "Tests: npm run typecheck ok, npm run test:unit ok",
    "Follow-ups: none",
  ].join("\n");

  configureAudit({ path: join(tmp, "audit.jsonl") });

  function mkOrch(ocOverrides: any = {}) {
    const sent: Array<{ c: string; h: string; o?: any }> = [];
    const tg: any = {
      editForumTopic: async () => {},
      sendMessage: async () => {},
      closeForumTopic: async () => {},
    };
    const oc: any = {
      // The worker's ACTUAL shell results: typecheck passed, test:unit failed.
      listMessages: async () => [
        {
          content: [
            { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
            { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 1 } } },
          ],
        },
      ],
      // No final message by default (a turn that ended without text); the
      // report cases override with the production { text, time } shape.
      latestReply: async () => undefined,
      ...ocOverrides,
    };
    const st = new StateManager(join(tmp, `wire-${Math.random().toString(36).slice(2)}.json`));
    const orch = new Orchestrator({
      st,
      tg,
      oc,
      userPrefs: { getLang: () => "en" },
      sendHtml: async (c: string, h: string, o?: any) => {
        sent.push({ c, h, o });
      },
    } as any);
    return { sent, st, orch };
  }

  // (a) done + a worker commit + checks → card posted to specRun.conv, Accept offered.
  // T2: the final message carries the full report block (production object shape).
  {
    const { sent, st, orch } = mkOrch({ latestReply: async () => ({ text: FULL_REPORT, time: 1 }) });
    st.set("100:7", {
      worker: { name: "spec-alpha", status: "running", specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: "100", uid: 7 } },
      sessionID: "ses_1",
      directory: repo,
    });
    (orch as any).setStatus("100:7", "done");
    const posted = await waitFor(() => sent.some((m) => m.c === "100"));
    check("wire(done): a card is posted", posted, JSON.stringify(sent.map((m) => m.c)));
    const card = sent.find((m) => m.c === "100");
    check("wire(done): posted to the OWNER conv (100), not the worker topic", card?.c === "100", JSON.stringify(card?.c));
    check("wire(done): carries the worker's commit hash", card?.h.includes(workerCommitHash), card?.h);
    check("wire(done): lists the files changed", card?.h.includes("src/foo.ts"), card?.h);
    check("wire(done): typecheck ✅ + test:unit ❌", card?.h.includes("typecheck") && card?.h.includes("test:unit"), card?.h);
    check("wire(done): smoke listed as NOT run", (card?.h ?? "").includes("smoke"), card?.h);
    const kbs = (card?.o?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? "");
    check("wire(done): Accept offered (commit exists, not errored)", kbs.includes("spcacc:alpha:2"), JSON.stringify(kbs));
    // S6.2: the spec_checkpoint audit event, outcome "fail" (test:unit failed).
    const lines = readFileSync(join(tmp, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ev = lines.find((e) => e.action === "spec_checkpoint" && e.meta?.task === "S2");
    check("wire(done): spec_checkpoint audited", !!ev, JSON.stringify(lines.map((l) => l.action)));
    check("wire(done): outcome=fail (a check failed)", ev?.outcome === "fail" || ev?.meta?.outcome === "fail", JSON.stringify(ev));
    check("wire(done): meta carries spec/branch/worker", !!ev && ev.meta.spec === "alpha" && ev.meta.branch === "spec/alpha" && ev.meta.worker === "spec-alpha", JSON.stringify(ev?.meta));
    // T2: the parsed report block is on the card (no missing-fields warning)
    // and stored on the worker entry; lastResult comes from the OBJECT shape.
    check("wire(done): card carries the report block (Status value)", (card?.h ?? "").includes("<b>Status</b>: DONE") && (card?.h ?? "").includes("Worker report:"), card?.h);
    check("wire(done): full report → no missing-fields warning", !(card?.h ?? "").includes("Missing report fields"), card?.h);
    check("wire(done): report stored on the worker entry", st.peek("100:7")?.worker?.report?.status === "DONE" && st.peek("100:7")?.worker?.report?.missing.length === 0, JSON.stringify(st.peek("100:7")?.worker?.report));
    check("wire(done): audit lastResult set from { text } shape", typeof ev?.meta?.lastResult === "string" && ev.meta.lastResult.length > 0, JSON.stringify(ev?.meta?.lastResult));
  }

  // (b) done but the worker made NO commit (marker only) → NO Accept, "no commit".
  {
    // A second branch with only the marker commit (no worker commit).
    const repo2 = join(tmp, "repo2");
    mkdirSync(join(repo2, "docs", "sdd"), { recursive: true });
    writeFileSync(join(repo2, "docs", "sdd", "alpha.md"), SPEC);
    git(repo2, ["init", "-q", "-b", "main"]);
    git(repo2, ["config", "user.email", "test@test.local"]);
    git(repo2, ["config", "user.name", "Test"]);
    git(repo2, ["add", "-A"]);
    git(repo2, ["commit", "-q", "-m", "init"]);
    git(repo2, ["checkout", "-q", "-b", "spec/alpha"]);
    writeFileSync(join(repo2, "docs", "sdd", "alpha.md"), marked);
    git(repo2, ["add", "-A"]);
    git(repo2, ["commit", "-q", "-m", "docs: add S4 task markers to alpha.md"]);
    // listMessages: no shell items at all (nothing was run).
    const { sent, st, orch } = mkOrch({ listMessages: async () => [] });
    st.set("200:9", {
      worker: { name: "spec-alpha", status: "running", specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: "200", uid: 7 } },
      sessionID: "ses_2",
      directory: repo2,
    });
    (orch as any).setStatus("200:9", "done");
    const posted = await waitFor(() => sent.some((m) => m.c === "200"));
    check("wire(no-commit): a card is posted", posted, JSON.stringify(sent.map((m) => m.c)));
    const card = sent.find((m) => m.c === "200");
    const kbs = (card?.o?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? "");
    check("wire(no-commit): NO Accept (marker commit is not the worker's)", !kbs.some((d) => d.startsWith("spcacc:")), JSON.stringify(kbs));
    check("wire(no-commit): says no commit", /no commit/i.test(card?.h ?? ""), card?.h);
    check("wire(no-commit): all expected checks listed as NOT run", (card?.h ?? "").includes("typecheck") && (card?.h ?? "").includes("test:unit") && (card?.h ?? "").includes("smoke"), card?.h);
  }

  // (c) failed → errored → NO Accept even though a commit exists.
  {
    const { sent, st, orch } = mkOrch();
    st.set("300:11", {
      worker: { name: "spec-alpha", status: "running", specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: "300", uid: 7 } },
      sessionID: "ses_3",
      directory: repo,
    });
    (orch as any).setStatus("300:11", "failed");
    const posted = await waitFor(() => sent.some((m) => m.c === "300"));
    check("wire(failed): a card is posted", posted, JSON.stringify(sent.map((m) => m.c)));
    const card = sent.find((m) => m.c === "300");
    const kbs = (card?.o?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? "");
    check("wire(failed): NO Accept (errored)", !kbs.some((d) => d.startsWith("spcacc:")), JSON.stringify(kbs));
    check("wire(failed): Redo + Stop present", kbs.includes("spcredo:alpha:2") && kbs.includes("spcstop:alpha:2"), JSON.stringify(kbs));
  }

  // (d) a non-spec worker (no specRun) → NO card at all.
  {
    const { sent, st, orch } = mkOrch();
    st.set("400:13", {
      worker: { name: "plain-worker", status: "running" },
      sessionID: "ses_4",
      directory: repo,
    });
    (orch as any).setStatus("400:13", "done");
    const posted = await waitFor(() => sent.some((m) => m.c === "400"), 300);
    check("wire(non-spec): no card posted for a non-spec worker", !posted, JSON.stringify(sent.map((m) => m.c)));
    // T2: a non-spec worker is unaffected — no report is parsed or stored.
    check("wire(non-spec): no report parsed onto a non-spec worker", st.peek("400:13")?.worker?.report === undefined, JSON.stringify(st.peek("400:13")?.worker?.report));
  }

  // (e) T2: the final message is missing report fields → the card carries a
  // ⚠️ line listing them (SOFT: Accept is still offered when the run is green).
  {
    const { sent, st, orch } = mkOrch({ latestReply: async () => ({ text: "Status: DONE\nFiles: src/foo.ts", time: 1 }) });
    st.set("500:15", {
      worker: { name: "spec-alpha", status: "running", specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: "500", uid: 7 } },
      sessionID: "ses_5",
      directory: repo,
    });
    (orch as any).setStatus("500:15", "done");
    const posted = await waitFor(() => sent.some((m) => m.c === "500"));
    check("wire(partial report): a card is posted", posted, JSON.stringify(sent.map((m) => m.c)));
    const card = sent.find((m) => m.c === "500");
    check("wire(partial report): ⚠️ line lists exactly the missing fields", (card?.h ?? "").includes("Missing report fields: Coverage, Tests, Follow-ups"), card?.h);
    check("wire(partial report): present fields still on the card", (card?.h ?? "").includes("<b>Status</b>: DONE") && (card?.h ?? "").includes("<b>Files</b>: src/foo.ts"), card?.h);
    const kbs = (card?.o?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? "");
    check("wire(partial report): SOFT — Accept still offered", kbs.includes("spcacc:alpha:2"), JSON.stringify(kbs));
    check("wire(partial report): partial report stored with its missing list", st.peek("500:15")?.worker?.report?.missing.join(",") === "Coverage,Tests,Follow-ups", JSON.stringify(st.peek("500:15")?.worker?.report));
  }

  // (f) RACE REGRESSION (site 1): a concurrent tap lands DURING the async work
  // of postSpecCheckpoint — simulated by the latestReply override doing an
  // st.set (arm auto) before returning. The report set must re-peek the fresh
  // worker and NOT clobber the concurrent change (old code spread stale `w`).
  {
    const { st, orch } = mkOrch({
      latestReply: async () => {
        const cur = st.peek("600:17")!.worker!;
        st.set("600:17", { worker: { ...cur, specRun: { ...cur.specRun, auto: true } } });
        return { text: FULL_REPORT, time: 1 };
      },
    });
    st.set("600:17", {
      worker: { name: "spec-alpha", status: "running", specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: "600", uid: 7 } },
      sessionID: "ses_6",
      directory: repo,
    });
    (orch as any).setStatus("600:17", "done");
    await waitFor(() => !!st.peek("600:17")?.worker?.report);
    const w = st.peek("600:17")?.worker;
    check("race(report): concurrent auto=true is NOT clobbered by the report set", w?.specRun?.auto === true, JSON.stringify(w?.specRun));
    check("race(report): the report is still stored", w?.report?.status === "DONE", JSON.stringify(w?.report));
  }

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll S5 spec-checkpoint checks passed.");
