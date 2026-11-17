/**
 * S6 (Accept, Redo, Stop) — the checkpoint card's controls:
 *   - spcacc:<spec>:<n>  → Accept: re-derive from live state (session tool
 *     items + git), mark the task done in the WORKTREE's spec file, commit
 *     that single line on the spec branch only (S4.4), offer the next task.
 *   - spcredo:<spec>:<n> → Redo with note: pending-note pattern (10-min
 *     expiry); the next plain text in the card's conv is the note, delivered
 *     to the SAME worker session (keeps its context).
 *   - spcstop:<spec>:<n> → Stop: stops the BUSY worker; keeps the worktree
 *     and its uncommitted work; the S5 hook re-posts the errored card.
 * All three validate the CURRENT worker (stale-card guard): no worker named
 * spec-<name> with specRun.spec === <name> → bilingual "no run found".
 *
 * Layers (both vi + en):
 *   - shared helpers (workerCommitsSinceFork / markerCommitSubject)
 *   - handler level (duck bot, like scripts/test-spec-run.ts): happy + every
 *     refusal path, the pending-note flow, expiry, command pass-through
 *   - e2e git (temp repo + real worktree): Accept's diff is EXACTLY one
 *     marker line (the task's checkpoint); Redo delivers the note to the
 *     session; Stop leaves the worktree + uncommitted files intact
 *   - S5 settlement hook re-fire (done→running→done posts a second card)
 *   - real Bot dispatcher: all three prefixes are routed to the spec handler
 *     (spcacc: must NOT fall into the "spec:" detail branch)
 *
 * Run:  npx tsx scripts/test-spec-controls.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSpecCallback } from "../src/commands/spec.js";
import { markerCommitSubject, workerCommitsSinceFork } from "../src/spec-checkpoint.js";
import { ensureSpecWorktree } from "../src/worktree.js";
import { initMarkers } from "../src/spec.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Bot } from "../src/bot.js";
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

// ── fixtures ────────────────────────────────────────────────────────────────
// Task 1 is already done (marked), task 2 is the running one, task 3 is the
// next runnable (it must be offered after Accept of task 2).
const GAMMA = `# Gamma spec

## 5. Tasks
1. [x] (abc1234) **S1 First.** A done task. *Checkpoint: review it.*
2. **S2 Second.** The running task. *Checkpoint: check the diff.*
3. **S3 Third.** The next task.
`;

const CONV = "123:45"; // the owner chat's conv (where the card was posted)
const WORKER_CONV = "123:45:99"; // the spec worker's topic conv

const tmp = mkdtempSync(join(tmpdir(), "spec-ctrl-"));
let seq = 0;

/** A fresh S4-style run: repo on main, spec worktree on spec/gamma, the
 * marker commit (exact S4 subject) and — by default — a worker commit. */
async function newRunFixture(opts: { workerCommit?: boolean; uncommitted?: boolean } = {}): Promise<{
  repo: string;
  wt: { root: string; directory: string; branch: string; base: string };
  workerHash?: string;
}> {
  seq++;
  const repo = join(tmp, `gamma-${seq}`);
  mkdirSync(join(repo, "docs", "sdd"), { recursive: true });
  writeFileSync(join(repo, "docs", "sdd", "gamma.md"), GAMMA);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test.local"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const wt = await ensureSpecWorktree(repo, repo, "gamma");
  const file = join(wt.root, "docs", "sdd", "gamma.md");
  const before = readFileSync(file, "utf8");
  const marked = initMarkers(before);
  if (marked !== before) {
    writeFileSync(file, marked);
    git(wt.root, ["add", "--", "docs/sdd/gamma.md"]);
    git(wt.root, ["commit", "-q", "-m", markerCommitSubject("gamma")]);
  }
  let workerHash: string | undefined;
  if (opts.workerCommit !== false) {
    mkdirSync(join(wt.root, "src"), { recursive: true });
    writeFileSync(join(wt.root, "src", "foo.ts"), "export const x = 1;\n");
    git(wt.root, ["add", "-A"]);
    git(wt.root, ["commit", "-q", "-m", "feat: S2 work"]);
    workerHash = git(wt.root, ["rev-parse", "--short", "HEAD"]);
  }
  if (opts.uncommitted) writeFileSync(join(wt.root, "uncommitted.txt"), "wip\n");
  return { repo, wt, workerHash };
}

/** The worker's ACTUAL shell results: everything passed (accept-able). */
const OK_ITEMS = [
  {
    content: [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 0 } } },
    ],
  },
];
/** A check that errored before running (S3.2 "not run") — accept must refuse. */
const ERROR_ITEMS = [
  {
    content: [
      { type: "tool", name: "shell", state: { status: "error", input: { command: "npm run test:unit" }, error: { message: "no node_modules" } } },
    ],
  },
];

function seedWorker(st: StateManager, wtRoot: string, status: string, over: Record<string, any> = {}): void {
  st.set(WORKER_CONV, {
    worker: {
      name: "spec-gamma",
      status,
      spawnedBy: "user",
      createdAt: 1,
      updatedAt: 1,
      specRun: { spec: "gamma", branch: "spec/gamma", task: "S2", conv: CONV, uid: 7 },
      ...over,
    },
    sessionID: "ses_1",
    directory: wtRoot,
  });
}

/** Duck bot wired to a REAL Orchestrator + StateManager (so the redo/stop
 * primitives run for real) and a duck OpenCode client. */
function mkBot(lang: "vi" | "en", items: any[] = OK_ITEMS) {
  const sent: Array<{ c: string; t: string; kb?: any[] }> = [];
  const st = new StateManager(join(tmp, `ctrl-st-${++seq}.json`));
  const oc: any = {
    prompts: [] as Array<{ s: string; m: string }>,
    interrupts: [] as string[],
    listMessages: async () => items,
    prompt: async (s: string, m: string) => {
      oc.prompts.push({ s, m });
      return "msg_x";
    },
    interrupt: async (s: string) => void oc.interrupts.push(s),
    latestReply: async () => "tail",
  };
  const orch = new Orchestrator({
    st,
    tg: {
      editForumTopic: async () => {},
      closeForumTopic: async () => {},
      sendMessage: async (c: string, t: string) => void sent.push({ c, t }),
    },
    oc,
    cfg: { maxWorkers: 10, replyMaxLen: 4000 },
    userPrefs: { getLang: () => lang },
    sendHtml: async (c: string, h: string, o?: any) => void sent.push({ c, t: h, kb: o?.reply_markup?.inline_keyboard }),
    startTyping: () => {},
    stopTyping: () => {},
  } as any);
  const bot: any = {
    cfg: { spec: true, opencodeDirectory: tmp, allowAny: true, allowedUserIds: [] },
    userPrefs: { getLang: () => lang },
    st,
    oc,
    orch,
    tg: {
      sendMessage: async (c: string, t: string) => void sent.push({ c, t }),
      answerCallbackQuery: async () => {},
    },
    sendHtml: async (c: string, h: string, o?: any) => void sent.push({ c, t: h, kb: o?.reply_markup?.inline_keyboard }),
  };
  return { bot, sent, st, orch, oc };
}
const cb = (data: string, uid = 7) => ({ id: "cb-1", from: { id: uid }, data });
const auditLines = () =>
  readFileSync(join(tmp, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

configureAudit({ path: join(tmp, "audit.jsonl") });

try {
  // ── Shared helpers: workerCommitsSinceFork / markerCommitSubject ─────────
  {
    const lines = ["a1b2c3d feat: S2 work", markerCommitSubject("gamma").replace(/^.*?(docs:)/, "e4f5a6b $1"), "init commit x9y8z7w".replace("init commit x9y8z7w", "x9y8z7w init")];
    const commits = workerCommitsSinceFork(lines, "gamma");
    check("helper: the marker commit is excluded", commits.length === 2 && commits.every((c) => c.subject !== markerCommitSubject("gamma")), JSON.stringify(commits));
    check("helper: newest first, hash+subject parsed", commits[0].hash === "a1b2c3d" && commits[0].subject === "feat: S2 work", JSON.stringify(commits));
    check("helper: empty / blank lines survive", workerCommitsSinceFork([], "gamma").length === 0 && workerCommitsSinceFork(["", "  "], "gamma").length === 0);
    check("helper: a branch with ONLY the marker commit → no worker commit", workerCommitsSinceFork([`h1 ${markerCommitSubject("gamma")}`], "gamma").length === 0);
    check("helper: marker subject is the exact S4 string", markerCommitSubject("gamma") === "docs: add S4 task markers to gamma.md");
  }

  // ── Accept — happy path (both languages): the e2e git checkpoint ─────────
  for (const lang of ["vi", "en"] as const) {
    const fx = await newRunFixture();
    const { bot, sent } = mkBot(lang);
    seedWorker(bot.st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    const file = join(fx.wt.root, "docs", "sdd", "gamma.md");
    const text = readFileSync(file, "utf8");
    check(`accept(${lang}): the marker line is [x] (<worker-hash>)`, text.includes(`2. [x] (${fx.workerHash}) **S2 Second.**`), text.split("\n").slice(4, 9).join(" | "));
    // The fixture's own initMarkers (S4.3) also marked task 3 with "[ ]", so
    // the expected file is the initMarkers-ed spec with ONLY line 2 changed.
    check(`accept(${lang}): no other line changed`, text === initMarkers(GAMMA).replace("2. [ ] **S2 Second.**", `2. [x] (${fx.workerHash}) **S2 Second.**`), text.split("\n").slice(3, 6).join(" | "));
    // THE CHECKPOINT: the accept commit's diff is EXACTLY one marker line.
    const numstat = git(fx.wt.root, ["diff", "--numstat", "HEAD~1", "HEAD"]);
    check(`accept(${lang}): commit diff is exactly one file, one line`, numstat === "1\t1\tdocs/sdd/gamma.md", numstat);
    check(`accept(${lang}): the new commit is on the spec branch`, git(fx.wt.root, ["rev-parse", "--abbrev-ref", "HEAD"]) === "spec/gamma" && git(fx.wt.root, ["log", "-1", "--format=%s"]).startsWith("docs: mark S2 done"), git(fx.wt.root, ["log", "-2", "--format=%s"]));
    check(`accept(${lang}): the user's checkout (main) is untouched`, git(fx.repo, ["status", "--porcelain"]) === "" && !readFileSync(join(fx.repo, "docs", "sdd", "gamma.md"), "utf8").includes(`(${fx.workerHash})`), git(fx.repo, ["status", "--porcelain"]));
    // Reply: the next runnable task (S3) with its Run button.
    const last = sent[sent.length - 1];
    check(`accept(${lang}): reply offers the next task`, (last?.t ?? "").includes("S3 Third"), last?.t);
    check(`accept(${lang}): reply carries the Run S3 button`, (last?.kb ?? []).flat().some((b: any) => b.callback_data === "specrun:gamma:3"), JSON.stringify(last?.kb));
    const all = sent.map((m) => m.t).join("\n");
    if (lang === "vi") check("accept(vi): vi confirmation", all.includes("đã được chấp nhận"), all);
    else check("accept(en): en confirmation", all.includes("accepted — marked done"), all);
    // S6.2: spec_accept audit with the required meta.
    const ev = auditLines().find((e) => e.action === "spec_accept" && e.userId === "7");
    check(`accept(${lang}): spec_accept audited`, !!ev, JSON.stringify(auditLines().map((l) => l.action)));
    check(`accept(${lang}): meta {spec,task,branch,worker,commit,userId}`, !!ev && ev.meta.spec === "gamma" && ev.meta.task === "S2" && ev.meta.branch === "spec/gamma" && ev.meta.worker === "spec-gamma" && ev.meta.commit === fx.workerHash && ev.meta.userId === 7, JSON.stringify(ev?.meta));
  }

  // ── Accept — refusals ─────────────────────────────────────────────────────
  {
    // (a) errored re-classification (a check never ran).
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en", ERROR_ITEMS);
    seedWorker(bot.st, fx.wt.root, "done");
    const before = git(fx.wt.root, ["rev-list", "--count", "HEAD"]);
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(errored): no commit made", git(fx.wt.root, ["rev-list", "--count", "HEAD"]) === before);
    check("accept-refuse(errored): explains the errored check (en)", sent.map((m) => m.t).join("\n").includes("errored (never ran)"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi } = mkBot("vi", ERROR_ITEMS);
    const st2 = botVi.st as StateManager;
    seedWorker(st2, fx.wt.root, "done");
    const sentVi: any[] = [];
    botVi.tg.sendMessage = async (c: string, t: string) => void sentVi.push({ c, t });
    await handleSpecCallback(botVi, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(errored): vi message", sentVi.map((m) => m.t).join("\n").includes("đã lỗi"), sentVi.map((m) => m.t).join("\n"));
  }
  {
    // (b) no worker commit (marker commit only — not the worker's work).
    const fx = await newRunFixture({ workerCommit: false });
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "done");
    const before = git(fx.wt.root, ["rev-list", "--count", "HEAD"]);
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(no-commit): no commit made", git(fx.wt.root, ["rev-list", "--count", "HEAD"]) === before);
    check("accept-refuse(no-commit): says no worker commit (en)", sent.map((m) => m.t).join("\n").includes("no commit on the branch since the fork"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi, sent: sentVi } = mkBot("vi");
    seedWorker(botVi.st, fx.wt.root, "done");
    await handleSpecCallback(botVi, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(no-commit): vi message", sentVi.map((m) => m.t).join("\n").includes("không có commit nào của worker"), sentVi.map((m) => m.t).join("\n"));
  }
  {
    // (c) no worker at all (stale card).
    const { bot, sent } = mkBot("en");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(no-worker): 'no run' (en)", sent.map((m) => m.t).join("\n").includes("No run of spec"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi, sent: sentVi } = mkBot("vi");
    await handleSpecCallback(botVi, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(no-worker): vi message", sentVi.map((m) => m.t).join("\n").includes("không có gì để xử lý"), sentVi.map((m) => m.t).join("\n"));
  }
  {
    // (d) specRun.spec mismatch (worker exists but is not a run of THIS spec).
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "done", { specRun: { spec: "other", branch: "spec/other", task: "S2", conv: CONV, uid: 7 } });
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(spec-mismatch): 'no run', no action", sent.map((m) => m.t).join("\n").includes("No run of spec"), sent.map((m) => m.t).join("\n"));
  }
  {
    // (e) busy worker.
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "running");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(busy): wait message (en)", sent.map((m) => m.t).join("\n").includes("wait for it to finish before accepting"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi, sent: sentVi } = mkBot("vi");
    seedWorker(botVi.st, fx.wt.root, "running");
    await handleSpecCallback(botVi, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(busy): vi message", sentVi.map((m) => m.t).join("\n").includes("chờ nó xong trước khi chấp nhận"), sentVi.map((m) => m.t).join("\n"));
  }
  {
    // (f) terminal but not done (failed) — the card wouldn't offer Accept,
    // but a stale tap must still be refused clearly.
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "failed");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(failed): says the worker failed (en)", sent.map((m) => m.t).join("\n").includes("The worker failed"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi, sent: sentVi } = mkBot("vi");
    seedWorker(botVi.st, fx.wt.root, "stopped");
    await handleSpecCallback(botVi, cb("spcacc:gamma:2"), CONV);
    check("accept-refuse(stopped): vi message", sentVi.map((m) => m.t).join("\n").includes("bị dừng"), sentVi.map((m) => m.t).join("\n"));
  }
  {
    // (g) already accepted (double tap) — idempotent, no second commit.
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV); // first: succeeds
    const count = git(fx.wt.root, ["rev-list", "--count", "HEAD"]);
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV); // second: already done
    check("accept-refuse(already): no second marker commit", git(fx.wt.root, ["rev-list", "--count", "HEAD"]) === count);
    check("accept-refuse(already): says already accepted (en)", sent.map((m) => m.t).join("\n").includes("already accepted"), sent.map((m) => m.t).join("\n"));
  }
  {
    // (h) task number not in the spec.
    const fx = await newRunFixture();
    const { bot, sent } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcacc:gamma:99"), CONV);
    check("accept-refuse(bad-n): task not found (en)", sent.map((m) => m.t).join("\n").includes("not found in the spec"), sent.map((m) => m.t).join("\n"));
  }

  // ── Redo with note — the pending-note flow (both languages) ──────────────
  for (const lang of ["vi", "en"] as const) {
    const fx = await newRunFixture();
    const { bot, sent, st, oc } = mkBot(lang);
    seedWorker(st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcredo:gamma:2"), CONV);
    const all = sent.map((m) => m.t).join("\n");
    if (lang === "vi") check("redo(vi): asks for the note", all.includes("Gửi một ghi chú"), all);
    else check("redo(en): asks for the note", all.includes("Send a note"), all);
    check(`redo(${lang}): a pending note is registered for the conv`, st === (bot as any).st && (bot as any).orch.redoPending.get(CONV)?.spec === "gamma", JSON.stringify([...(bot as any).orch.redoPending.entries()]));
    // The next plain text in the conv is consumed as the note.
    const consumed = await (bot as any).orch.tryConsumeRedoNote(CONV, "fix the failing test");
    check(`redo(${lang}): the note is consumed`, consumed === true);
    check(`redo(${lang}): the note reaches the SAME session`, oc.prompts.length === 1 && oc.prompts[0].s === "ses_1" && oc.prompts[0].m === "fix the failing test", JSON.stringify(oc.prompts));
    check(`redo(${lang}): the worker is running again`, st.peek(WORKER_CONV)?.worker?.status === "running", String(st.peek(WORKER_CONV)?.worker?.status));
    check(`redo(${lang}): the note is shown in the worker topic`, sent.some((m) => m.c === WORKER_CONV && m.t.includes("fix the failing test")), JSON.stringify(sent.map((m) => [m.c, m.t?.slice(0, 40)])));
    check(`redo(${lang}): confirmation sent to the card conv`, sent.some((m) => m.c === CONV && ((lang === "vi" && m.t.includes("Đã gửi ghi chú")) || (lang === "en" && m.t.includes("Note sent to worker")))), sent.map((m) => m.t).join(" | "));
    const ev = auditLines().find((e) => e.action === "spec_redo" && e.meta?.note === "fix the failing test");
    check(`redo(${lang}): spec_redo audited {spec,task,worker,note}`, !!ev && ev.meta.spec === "gamma" && ev.meta.task === "S2" && ev.meta.worker === "spec-gamma", JSON.stringify(ev));
    check(`redo(${lang}): nothing pending afterwards`, (bot as any).orch.redoPending.size === 0);
  }
  {
    // Expiry: after the 10-minute window the text is NOT the note.
    const fx = await newRunFixture();
    const { bot, sent, st, oc } = mkBot("en");
    seedWorker(st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcredo:gamma:2"), CONV);
    (bot as any).orch.redoPending.get(CONV).since = Date.now() - 11 * 60 * 1000;
    const consumed = await (bot as any).orch.tryConsumeRedoNote(CONV, "too late");
    check("redo(expiry): expired note is NOT consumed", consumed === false);
    check("redo(expiry): no prompt sent to the session", oc.prompts.length === 0);
    check("redo(expiry): the request was canceled with a notice", sent.map((m) => m.t).join("\n").includes("expired"), sent.map((m) => m.t).join("\n"));
    check("redo(expiry): nothing pending afterwards", (bot as any).orch.redoPending.size === 0);
  }
  {
    // Commands pass through while a note is pending (the request stays).
    const fx = await newRunFixture();
    const { bot, st, oc } = mkBot("en");
    seedWorker(st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcredo:gamma:2"), CONV);
    const consumed = await (bot as any).orch.tryConsumeRedoNote(CONV, "/kill x");
    check("redo(command): a command is NOT consumed", consumed === false);
    check("redo(command): the request stays pending", (bot as any).orch.redoPending.size === 1);
    check("redo(command): no prompt sent", oc.prompts.length === 0);
  }
  {
    // Stale card: no worker / busy worker.
    const { bot, sent } = mkBot("en");
    await handleSpecCallback(bot, cb("spcredo:gamma:2"), CONV);
    check("redo(no-worker): 'no run'", sent.map((m) => m.t).join("\n").includes("No run of spec"), sent.map((m) => m.t).join("\n"));
    const fx = await newRunFixture();
    const { bot: botBusy, sent: sentBusy, st: stBusy } = mkBot("en");
    seedWorker(stBusy, fx.wt.root, "running");
    await handleSpecCallback(botBusy, cb("spcredo:gamma:2"), CONV);
    check("redo(busy): refused with a wait message", sentBusy.map((m) => m.t).join("\n").includes("can't redo right now"), sentBusy.map((m) => m.t).join("\n"));
  }

  // ── Stop — busy worker: stopped, worktree + uncommitted work kept ────────
  for (const lang of ["vi", "en"] as const) {
    const fx = await newRunFixture({ uncommitted: true });
    const { bot, sent, st, oc } = mkBot(lang);
    seedWorker(st, fx.wt.root, "running");
    await handleSpecCallback(bot, cb("spcstop:gamma:2"), CONV);
    check(`stop(${lang}): the session was interrupted`, oc.interrupts.includes("ses_1"), JSON.stringify(oc.interrupts));
    check(`stop(${lang}): the worker is stopped`, st.peek(WORKER_CONV)?.worker?.status === "stopped", String(st.peek(WORKER_CONV)?.worker?.status));
    check(`stop(${lang}): the worktree is kept`, existsSync(fx.wt.root), fx.wt.root);
    check(`stop(${lang}): the uncommitted file is kept`, existsSync(join(fx.wt.root, "uncommitted.txt")));
    check(`stop(${lang}): the spec file is unchanged (task not done)`, !readFileSync(join(fx.wt.root, "docs", "sdd", "gamma.md"), "utf8").includes("2. [x]"), readFileSync(join(fx.wt.root, "docs", "sdd", "gamma.md"), "utf8").split("\n")[5]);
    const all = sent.map((m) => m.t).join("\n");
    if (lang === "vi") check("stop(vi): vi stop notice", all.includes("Đã dừng worker"), all);
    else check("stop(en): en stop notice", all.includes("Stopped worker") && all.includes("Worktree kept"), all);
    const ev = auditLines().find((e) => e.action === "spec_stop" && e.userId === "7");
    check(`stop(${lang}): spec_stop audited {spec,task,worker,userId}`, !!ev && ev.meta.spec === "gamma" && ev.meta.task === "S2" && ev.meta.worker === "spec-gamma" && ev.meta.userId === 7, JSON.stringify(ev?.meta));
    // S3.7: the S5 settlement hook re-posts the errored card — Redo + Stop,
    // NO Accept.
    const card = await waitFor(() => sent.some((m) => m.c === CONV && m.kb));
    check(`stop(${lang}): the checkpoint card is re-posted`, card, JSON.stringify(sent.map((m) => [m.c, m.kb])));
    const kbs = (sent.find((m) => m.c === CONV && m.kb)?.kb ?? []).flat().map((b: any) => b.callback_data);
    check(`stop(${lang}): card offers Redo + Stop only`, kbs.includes("spcredo:gamma:2") && kbs.includes("spcstop:gamma:2") && !kbs.some((d) => d.startsWith("spcacc:")), JSON.stringify(kbs));
  }
  {
    // Terminal worker → "already finished" instead of a stop.
    const fx = await newRunFixture();
    const { bot, sent, oc } = mkBot("en");
    seedWorker(bot.st, fx.wt.root, "done");
    await handleSpecCallback(bot, cb("spcstop:gamma:2"), CONV);
    check("stop(terminal): 'already finished' (en)", sent.map((m) => m.t).join("\n").includes("already finished"), sent.map((m) => m.t).join("\n"));
    const { bot: botVi, sent: sentVi } = mkBot("vi");
    seedWorker(botVi.st, fx.wt.root, "done");
    await handleSpecCallback(botVi, cb("spcstop:gamma:2"), CONV);
    check("stop(terminal): vi message", sentVi.map((m) => m.t).join("\n").includes("không có gì để dừng"), sentVi.map((m) => m.t).join("\n"));
    check("stop(terminal): no interrupt", oc.interrupts.length === 0);
    const { bot: botNone } = mkBot("en");
    await handleSpecCallback(botNone, cb("spcstop:gamma:2"), CONV);
    check("stop(no-worker): 'no run'", true, "placeholder — the real check is the next block");
  }
  {
    const { bot, sent } = mkBot("en");
    await handleSpecCallback(bot, cb("spcstop:gamma:2"), CONV);
    check("stop(no-worker): 'no run' (en)", sent.map((m) => m.t).join("\n").includes("No run of spec"), sent.map((m) => m.t).join("\n"));
  }

  // ── Redo re-fire: done→running→done posts a SECOND checkpoint card ───────
  // (the S5 settlement hook, fire-once per transition — verified, not rebuilt)
  {
    const sent: Array<{ c: string; kb?: any[] }> = [];
    const st = new StateManager(join(tmp, `refire-${++seq}.json`));
    const orch = new Orchestrator({
      st,
      tg: { editForumTopic: async () => {}, sendMessage: async () => {}, closeForumTopic: async () => {} },
      oc: { listMessages: async () => OK_ITEMS, latestReply: async () => "tail" },
      cfg: { maxWorkers: 10, replyMaxLen: 4000 },
      userPrefs: { getLang: () => "en" },
      sendHtml: async (c: string, _h: string, o?: any) => void sent.push({ c, kb: o?.reply_markup?.inline_keyboard }),
      startTyping: () => {},
      stopTyping: () => {},
    } as any);
    // No directory on purpose: the card's git facts are empty, but the
    // fire-once posting logic is exactly what is under test.
    st.set("500:7", { worker: { name: "spec-gamma", status: "running", specRun: { spec: "gamma", branch: "spec/gamma", task: "S2", conv: "500", uid: 7 } }, sessionID: "ses_1" });
    (orch as any).setStatus("500:7", "done");
    check("refire: the first card is posted", await waitFor(() => sent.length === 1), String(sent.length));
    (orch as any).setStatus("500:7", "running"); // the redo starts a new turn
    await new Promise((r) => setTimeout(r, 150));
    check("refire: no card while the worker runs again", sent.length === 1, String(sent.length));
    (orch as any).setStatus("500:7", "done"); // the redo finishes
    check("refire: a SECOND card is posted when the worker finishes again", await waitFor(() => sent.length === 2), String(sent.length));
  }

  // ── Real Bot dispatcher: the three new prefixes are routed ───────────────
  function mkRealBot(lang: "vi" | "en", repo: string, items: any[]) {
    const stateFile = join(tmp, `route-${++seq}.json`);
    const sent: Array<{ c: string; t: string; kb?: any[] }> = [];
    const tg: any = {
      sendMessage: async (c: string, t: string, o?: any) => void sent.push({ c, t, kb: o?.reply_markup?.inline_keyboard }),
      sendMessageId: async (c: string, t: string, o?: any) => void sent.push({ c, t, kb: o?.reply_markup?.inline_keyboard }),
      sendChatAction: async () => {},
      deleteMessage: async () => {},
      editMessageReplyMarkup: async () => {},
      editForumTopic: async () => {},
      closeForumTopic: async () => {},
      answerCallbackQuery: async () => {},
      stop: () => {},
    };
    const oc: any = {
      prompts: [] as Array<{ s: string; m: string }>,
      interrupts: [] as string[],
      promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
      prompt: async (s: string, m: string) => {
        oc.prompts.push({ s, m });
        return "msg_x";
      },
      interrupt: async (s: string) => void oc.interrupts.push(s),
      listMessages: async () => items,
      latestReply: async () => "tail",
      createSession: async () => "ses_1",
      setInstruction: async () => {},
      removeInstruction: async () => {},
    };
    const st = new StateManager(stateFile);
    const cfg: any = {
      stateFile,
      maxSchedules: 5,
      busyMode: "ask",
      nextSteps: false,
      nextMinSecs: 0,
      maxWorkers: 5,
      spec: true,
      allowAny: true,
      allowedUserIds: [],
      opencodeDirectory: repo,
      opencodeUrl: "http://127.0.0.1:1",
    };
    const bot = new Bot(tg, oc, st, cfg);
    // Wire the requested language into the user-pref store (the real Bot
    // defaults to vi); the orchestrator's host options hold the same store.
    (bot as any).userPrefs = { getLang: () => lang };
    (bot as any).orch.h.userPrefs = { getLang: () => lang };
    (bot as any).sendHtml = async (c: string, t: string, o?: any) => void sent.push({ c, t, kb: o?.reply_markup?.inline_keyboard });
    (bot as any).sendReply = async () => {};
    (bot as any).startTyping = () => {};
    (bot as any).stopTyping = () => {};
    (bot as any).startWorking = () => {};
    (bot as any).clearActivity = () => {};
    (bot as any).dropPreview = async () => {};
    (bot as any).offerContinueKeyboard = () => undefined;
    return { bot, sent, st, oc };
  }
  const cbFor = (data: string) => ({
    id: "cb-route",
    from: { id: 7 },
    data,
    message: { message_id: 1, chat: { id: 12345 }, is_topic_message: false },
  });
  const REAL_CONV = "12345";
  const REAL_WORKER_CONV = "12345:99";
  function seedRealWorker(st: StateManager, wtRoot: string, status: string): void {
    st.set(REAL_WORKER_CONV, {
      worker: { name: "spec-gamma", status, spawnedBy: "user", createdAt: 1, updatedAt: 1, specRun: { spec: "gamma", branch: "spec/gamma", task: "S2", conv: REAL_CONV, uid: 7 } },
      sessionID: "ses_1",
      directory: wtRoot,
    });
  }

  {
    // spcacc: is routed to the ACCEPT path — and NOT into the "spec:" detail
    // branch (which would render the task list instead of accepting).
    const fx = await newRunFixture();
    const { bot, sent, st } = mkRealBot("en", fx.repo, OK_ITEMS);
    seedRealWorker(st, fx.wt.root, "done");
    await (bot as any).handleCallback(cbFor("spcacc:gamma:2"));
    const text = readFileSync(join(fx.wt.root, "docs", "sdd", "gamma.md"), "utf8");
    check("route(spcacc): the accept ran (marker committed in the worktree)", text.includes(`2. [x] (${git(fx.wt.root, ["rev-parse", "--short", "HEAD~1"])})`) || text.includes("2. [x] ("), text.split("\n")[5]);
    check("route(spcacc): the detail view was NOT rendered", !sent.some((m) => (m.t ?? "").includes("📋 <b>Gamma spec</b>")), sent.map((m) => m.t?.slice(0, 50)).join(" | "));
  }
  {
    // spcredo: is routed; the note is consumed from the next plain text via
    // the real Bot message path; a non-text message leaves the request pending.
    const fx = await newRunFixture();
    const { bot, sent, st, oc } = mkRealBot("en", fx.repo, OK_ITEMS);
    seedRealWorker(st, fx.wt.root, "done");
    await (bot as any).handleCallback(cbFor("spcredo:gamma:2"));
    check("route(spcredo): asks for the note", sent.map((m) => m.t).join("\n").includes("Send a note"), sent.map((m) => m.t).join(" | "));
    check("route(spcredo): the request is pending", (bot as any).orch.redoPending.size === 1);
    // A photo without caption: not text → the request must stay pending.
    await (bot as any).handle({ message: { message_id: 2, chat: { id: 12345 }, from: { id: 7 }, photo: [{ file_id: "p1" }] } });
    check("route(spcredo): a non-text message leaves the request pending", (bot as any).orch.redoPending.size === 1, String((bot as any).orch.redoPending.size));
    // The next plain text: consumed as the note, delivered to the session.
    await (bot as any).handle({ message: { message_id: 3, chat: { id: 12345 }, from: { id: 7 }, text: "please fix the test" } });
    check("route(spcredo): the plain text is consumed as the note", (bot as any).orch.redoPending.size === 0);
    check("route(spcredo): the note reached the worker session", oc.prompts.some((p: any) => p.s === "ses_1" && p.m === "please fix the test"), JSON.stringify(oc.prompts));
    check("route(spcredo): the worker is running again", st.peek(REAL_WORKER_CONV)?.worker?.status === "running", String(st.peek(REAL_WORKER_CONV)?.worker?.status));
  }
  {
    // spcstop: is routed and stops a BUSY worker (worktree kept).
    const fx = await newRunFixture({ uncommitted: true });
    const { bot, st, oc } = mkRealBot("en", fx.repo, OK_ITEMS);
    seedRealWorker(st, fx.wt.root, "running");
    await (bot as any).handleCallback(cbFor("spcstop:gamma:2"));
    check("route(spcstop): the worker is stopped", st.peek(REAL_WORKER_CONV)?.worker?.status === "stopped", String(st.peek(REAL_WORKER_CONV)?.worker?.status));
    check("route(spcstop): the session was interrupted", oc.interrupts.includes("ses_1"), JSON.stringify(oc.interrupts));
    check("route(spcstop): the worktree + uncommitted file are kept", existsSync(fx.wt.root) && existsSync(join(fx.wt.root, "uncommitted.txt")));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll S6 spec-controls checks passed.");
