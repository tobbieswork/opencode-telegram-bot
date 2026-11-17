/**
 * S5 (spec PR) — draft PR, body update, ready button, post-merge clean-up:
 *   - S5.1 first Accept → push the branch + offer "Open draft PR".
 *   - S5.2 later Accept → push + update the PR body.
 *   - S5.3 last task accepted → offer "Mark ready for review". Never merges.
 *   - S5.4 push uses an explicit refspec (never main / a protected branch).
 *   - S5.5 merged PR (detected on the next /spec) → "Clean up", which deletes
 *     the spec branch + worktree; REFUSES while the branch has commits not in main.
 *
 * Layers (both vi + en where user-facing):
 *   - github helpers (parseRepoUrl: https + git@ forms, .git/trailing slash).
 *   - e2e git (TEMP repo + a BARE remote; the origin URL is a github.com URL
 *     rewritten to the local bare path via `url.<base>.insteadOf`, so the slug
 *     derivation AND the real push/fetch/delete all run against real git).
 *   - the `gh api` transport is MOCKED (setGhApiImpl) so PR open/patch/get are
 *     captured and asserted without touching GitHub.
 *   - handler level (duck bot, like scripts/test-spec-controls.ts).
 *   - real Bot dispatcher: spcpr:/spcready:/spcclean: are routed to the spec
 *     handler (regression against the dispatch gate).
 *
 * Run:  npx tsx scripts/test-spec-pr.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSpecCallback } from "../src/commands/spec.js";
import { markerCommitSubject } from "../src/spec-checkpoint.js";
import { ensureSpecWorktree } from "../src/worktree.js";
import { initMarkers } from "../src/spec.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Bot } from "../src/bot.js";
import { StateManager, MACHINE_STATE_KEY } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { setGhApiImpl, setGhPrReadyImpl, parseRepoUrl } from "../src/github.js";

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

// ── fixtures ────────────────────────────────────────────────────────────────
// S1 is already done; S2 and S3 are open (so we can accept S2 then S3 and
// reach "all done" on the second accept).
const GAMMA = `# Gamma spec

## 5. Tasks
1. [x] (abc1234) **S1 First.** A done task. *Checkpoint: review it.*
2. **S2 Second.** The running task. *Checkpoint: check the diff.*
3. **S3 Third.** The next task.
`;

const CONV = "123:45"; // the owner chat's conv (where the reply is posted)
const WORKER_CONV = "123:45:99"; // the spec worker's topic conv

const tmp = mkdtempSync(join(tmpdir(), "spec-pr-"));
let seq = 0;

/** A fresh S5-style setup: a repo on main with a BARE origin. The origin URL
 * is a github.com URL rewritten to the local bare path via `insteadOf`, so
 * `git remote get-url origin` yields a GitHub slug while every git operation
 * actually hits the local bare repo. */
async function newPrFixture(): Promise<{ repo: string; origin: string; wt: { root: string; directory: string; branch: string; base: string } }> {
  seq++;
  const origin = join(tmp, `origin-${seq}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const repo = join(tmp, `repo-${seq}`);
  mkdirSync(join(repo, "docs", "sdd"), { recursive: true });
  writeFileSync(join(repo, "docs", "sdd", "gamma.md"), GAMMA);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@test.local"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
  git(repo, ["config", `url.${origin}.insteadOf`, "https://github.com/o/r.git"]);
  git(repo, ["push", "-q", "origin", "main"]);
  const wt = await ensureSpecWorktree(repo, repo, "gamma");
  // S4.3: the spec branch carries the task markers (exact S4 subject).
  const file = join(wt.root, "docs", "sdd", "gamma.md");
  const before = readFileSync(file, "utf8");
  const marked = initMarkers(before);
  if (marked !== before) {
    writeFileSync(file, marked);
    git(wt.root, ["add", "--", "docs/sdd/gamma.md"]);
    git(wt.root, ["commit", "-q", "-m", markerCommitSubject("gamma")]);
  }
  // The worker's commit (what Accept will attribute).
  mkdirSync(join(wt.root, "src"), { recursive: true });
  writeFileSync(join(wt.root, "src", "foo.ts"), "export const x = 1;\n");
  git(wt.root, ["add", "-A"]);
  git(wt.root, ["commit", "-q", "-m", "feat: S2 work"]);
  return { repo, origin, wt };
}

/** Push the spec branch to origin (the explicit S5.4 refspec the bot uses). */
function pushSpecBranch(wt: { root: string; branch: string }): void {
  git(wt.root, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
}

/** Does the bare origin have the spec branch? */
function originHasBranch(origin: string, branch: string): boolean {
  try {
    git(origin, ["show-ref", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Simulate the PR being MERGED into main: merge the spec branch into main
 * and push, so every spec-branch commit is an ancestor of origin/main. */
function simulateMerge(repo: string, wt: { root: string; branch: string }): void {
  const sha = git(wt.root, ["rev-parse", wt.branch]);
  git(repo, ["merge", "-q", "--no-ff", "-m", "Merge spec/gamma", sha]);
  git(repo, ["push", "-q", "origin", "main"]);
}

const OK_ITEMS = [
  {
    content: [
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run typecheck" }, metadata: { exit: 0 } } },
      { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm run test:unit" }, metadata: { exit: 0 } } },
    ],
  },
];

function seedWorker(st: StateManager, wtRoot: string, status: string, task: string, over: Record<string, any> = {}): void {
  st.set(WORKER_CONV, {
    worker: {
      name: "spec-gamma",
      status,
      spawnedBy: "user",
      createdAt: 1,
      updatedAt: 1,
      specRun: { spec: "gamma", branch: "spec/gamma", task, conv: CONV, uid: 7 },
      ...over,
    },
    sessionID: "ses_1",
    directory: wtRoot,
  });
}

// ── the mocked gh transport ─────────────────────────────────────────────────
const ghCalls: Array<{ repo: string; method: string; path: string; body?: any }> = [];
let prGetState: any = { state: "open", merged: false };
const readyCalls: Array<{ repo: string; number: number }> = [];
function resetGh(): void {
  ghCalls.length = 0;
  readyCalls.length = 0;
  prGetState = { state: "open", merged: false };
}
setGhPrReadyImpl(async (repo, number) => {
  readyCalls.push({ repo, number });
})
setGhApiImpl(async (repo, method, path, body) => {
  ghCalls.push({ repo, method, path, body });
  if (method === "POST" && path === "pulls") return { number: 42, html_url: `https://github.com/${repo}/pull/42` };
  if (method === "PATCH" && /^pulls\/\d+\/?$/.test(path)) return {};
  if (method === "GET" && /^pulls\/\d+\/?$/.test(path)) return prGetState;
  return {};
});
function ghCallsWhere(fn: (c: (typeof ghCalls)[number]) => boolean): Array<(typeof ghCalls)[number]> {
  return ghCalls.filter(fn);
}

/** A duck bot wired to a REAL Orchestrator + StateManager + a duck OpenCode
 * client (the same shape scripts/test-spec-controls.ts uses). */
function mkBot(lang: "vi" | "en") {
  const sent: Array<{ c: string; t: string; kb?: any[] }> = [];
  const st = new StateManager(join(tmp, `pr-st-${++seq}.json`));
  const oc: any = {
    listMessages: async () => OK_ITEMS,
    prompt: async (s: string, m: string) => "msg_x",
    interrupt: async () => {},
    latestReply: async () => "tail",
  };
  const orch = new Orchestrator({
    st,
    tg: { editForumTopic: async () => {}, closeForumTopic: async () => {}, sendMessage: async () => {} },
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
    tg: { sendMessage: async (c: string, t: string) => void sent.push({ c, t }), answerCallbackQuery: async () => {} },
    sendHtml: async (c: string, h: string, o?: any) => void sent.push({ c, t: h, kb: o?.reply_markup?.inline_keyboard }),
  };
  return { bot, sent, st, orch };
}
const cb = (data: string, uid = 7) => ({ id: "cb-1", from: { id: uid }, data });
function seedPrState(st: StateManager, name: string, over: Record<string, any> = {}): void {
  st.set(MACHINE_STATE_KEY, { specPr: { [name]: { repo: "o/r", number: 42, title: "feat: Gamma spec", draft: false, ...over } } });
}
const auditLines = () => readFileSync(join(tmp, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
configureAudit({ path: join(tmp, "audit.jsonl") });

try {
  // ── parseRepoUrl (github slug forms) ──────────────────────────────────────
  {
    check("parseRepoUrl: https .git", parseRepoUrl("https://github.com/owner/name.git") === "owner/name");
    check("parseRepoUrl: https no .git", parseRepoUrl("https://github.com/owner/name") === "owner/name");
    check("parseRepoUrl: https trailing slash", parseRepoUrl("https://github.com/owner/name/") === "owner/name");
    check("parseRepoUrl: git@ .git", parseRepoUrl("git@github.com:owner/name.git") === "owner/name");
    check("parseRepoUrl: git@ no .git", parseRepoUrl("git@github.com:owner/name") === "owner/name");
    check("parseRepoUrl: non-github → undefined", parseRepoUrl("git@bitbucket.org:owner/name.git") === undefined);
    check("parseRepoUrl: empty → undefined", parseRepoUrl("") === undefined);
  }

  // ── S5.1: first Accept → push the branch + offer "Open draft PR" ─────────
  for (const lang of ["vi", "en"] as const) {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot(lang);
    seedWorker(bot.st, fx.wt.root, "done", "S2");
    check(`accept-push(${lang}): the spec branch is NOT on origin before`, !originHasBranch(fx.origin, "spec/gamma"));
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    check(`accept-push(${lang}): the spec branch was PUSHED to origin (explicit refspec)`, originHasBranch(fx.origin, "spec/gamma"));
    const last = sent[sent.length - 1];
    const kbs = (last?.kb ?? []).flat().map((b: any) => b.callback_data);
    check(`accept-push(${lang}): reply offers the "Open draft PR" button`, kbs.includes("spcpr:gamma"), JSON.stringify(kbs));
    check(`accept-push(${lang}): NO Mark-ready button yet (not all done)`, !kbs.includes("spcready:gamma"), JSON.stringify(kbs));
    const all = sent.map((m) => m.t).join("\n");
    if (lang === "vi") check("accept-push(vi): vi push line", all.includes("Đã đẩy"), all);
    else check("accept-push(en): en push line", all.includes("Pushed"), all);
    // The task was still marked done (S6 behavior preserved).
    const file = readFileSync(join(fx.wt.root, "docs", "sdd", "gamma.md"), "utf8");
    check(`accept-push(${lang}): S2 marked done in the worktree`, file.includes("2. [x] ("), file.split("\n").slice(4, 8).join(" | "));
    // No gh call yet (no PR to update on the first accept).
    check(`accept-push(${lang}): no gh call on the first accept`, ghCalls.length === 0, JSON.stringify(ghCalls));
  }

  // ── S5.2 + S5.3: open the PR, then a second Accept → body update + ready ─
  {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot("en");
    bot.st.set(CONV, { directory: fx.repo });
    // First accept: marks S2, pushes, offers Open PR.
    seedWorker(bot.st, fx.wt.root, "done", "S2");
    await handleSpecCallback(bot, cb("spcacc:gamma:2"), CONV);
    // Open the draft PR.
    await handleSpecCallback(bot, cb("spcpr:gamma"), CONV);
    const post = ghCallsWhere((c) => c.method === "POST" && c.path === "pulls");
    check("second-accept: spcpr POSTed the PR", post.length === 1);
    check("second-accept: recorded PR state", (bot.st.peek(MACHINE_STATE_KEY)?.specPr?.gamma)?.number === 42);
    // Second accept: a fresh worker commit for S3, then accept S3.
    writeFileSync(join(fx.wt.root, "src", "bar.ts"), "export const y = 2;\n");
    git(fx.wt.root, ["add", "-A"]);
    git(fx.wt.root, ["commit", "-q", "-m", "feat: S3 work"]);
    seedWorker(bot.st, fx.wt.root, "done", "S3");
    sent.length = 0;
    await handleSpecCallback(bot, cb("spcacc:gamma:3"), CONV);
    // The PR body was updated (PATCH) — and it now shows S3 done.
    const patch = ghCallsWhere((c) => c.method === "PATCH" && c.path === "pulls/42");
    check("second-accept: the PR body was PATCHed", patch.length === 1, JSON.stringify(ghCalls.map((c) => c.method + " " + c.path)));
    check("second-accept: the PATCH body lists S3 as done", !!patch[0]?.body?.body && patch[0].body.body.includes("✅ S3 Third"), JSON.stringify(patch[0]?.body));
    const last = sent[sent.length - 1];
    const kbs = (last?.kb ?? []).flat().map((b: any) => b.callback_data);
    const all = sent.map((m) => m.t).join("\n");
    check("second-accept: reply notes the PR number + body updated", all.includes("PR #42") && all.includes("body updated"), all);
    check("second-accept: offers Mark-ready (all tasks now done)", kbs.includes("spcready:gamma"), JSON.stringify(kbs));
    check("second-accept: no second 'Open PR' button", !kbs.includes("spcpr:gamma"), JSON.stringify(kbs));
  }

  // ── S5.1: spcpr creates a DRAFT with the correct title/head/base/body ────
  for (const lang of ["vi", "en"] as const) {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot(lang);
    bot.st.set(CONV, { directory: fx.repo });
    pushSpecBranch(fx.wt); // the accept would have pushed it
    await handleSpecCallback(bot, cb("spcpr:gamma"), CONV);
    const post = ghCallsWhere((c) => c.method === "POST" && c.path === "pulls");
    check(`spcpr(${lang}): exactly one POST /pulls`, post.length === 1, JSON.stringify(ghCalls.map((c) => c.method + " " + c.path)));
    const b = post[0]?.body ?? {};
    check(`spcpr(${lang}): title is "feat: <spec H1>"`, b.title === "feat: Gamma spec", JSON.stringify(b.title));
    check(`spcpr(${lang}): head is the explicit spec branch`, b.head === "spec/gamma", JSON.stringify(b.head));
    check(`spcpr(${lang}): base is main`, b.base === "main", JSON.stringify(b.base));
    check(`spcpr(${lang}): draft flag is true`, b.draft === true, JSON.stringify(b.draft));
    check(`spcpr(${lang}): body lists the tasks with status`, typeof b.body === "string" && b.body.includes("✅ S1 First") && b.body.includes("S2 Second"), JSON.stringify(b.body));
    check(`spcpr(${lang}): state recorded {repo,number,draft}`, (() => { const pr = bot.st.peek(MACHINE_STATE_KEY)?.specPr?.gamma; return !!pr && pr.repo === "o/r" && pr.number === 42 && pr.draft === true; })(), JSON.stringify(bot.st.peek(MACHINE_STATE_KEY)?.specPr));
    const all = sent.map((m) => m.t).join("\n");
    check(`spcpr(${lang}): reply has the PR number + URL`, all.includes("#42") && all.includes("github.com/o/r/pull/42"), all);
    const ev = auditLines().find((e) => e.action === "spec_pr_open" && e.meta?.spec === "gamma");
    check(`spcpr(${lang}): spec_pr_open audited`, !!ev && ev.meta.number === 42, JSON.stringify(ev?.meta));
    // Not all done → no Mark-ready button.
    const kbs = (sent[sent.length - 1]?.kb ?? []).flat().map((x: any) => x.callback_data);
    check(`spcpr(${lang}): no Mark-ready yet (S2/S3 open)`, !kbs.includes("spcready:gamma"), JSON.stringify(kbs));
  }

  // ── S5.3: spcready un-drafts via gh pr ready and NEVER merges ────────────
  for (const lang of ["vi", "en"] as const) {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot(lang);
    seedPrState(bot.st, "gamma", { draft: true });
    await handleSpecCallback(bot, cb("spcready:gamma"), CONV);
    check(`spcready(${lang}): un-drafted via gh pr ready`, readyCalls.length === 1 && readyCalls[0].repo === "o/r" && readyCalls[0].number === 42, JSON.stringify(readyCalls));
    check(`spcready(${lang}): NO REST draft-patch (silently ignored by GitHub)`, !ghCalls.some((c) => c.method === "PATCH" && c.body?.draft === false), JSON.stringify(ghCalls.map((c) => c.method + " " + c.path)));
    check(`spcready(${lang}): NO merge call anywhere`, !ghCalls.some((c) => /merge/.test(c.path)), JSON.stringify(ghCalls.map((c) => c.method + " " + c.path)));
    check(`spcready(${lang}): state.draft is now false`, bot.st.peek(MACHINE_STATE_KEY)?.specPr?.gamma?.draft === false);
    const all = sent.map((m) => m.t).join("\n");
    if (lang === "vi") check("spcready(vi): vi confirmation", all.includes("sẵn sàng review"), all);
    else check("spcready(en): en confirmation", all.includes("ready for review"), all);
    const ev = auditLines().find((e) => e.action === "spec_pr_ready" && e.meta?.spec === "gamma");
    check(`spcready(${lang}): spec_pr_ready audited`, !!ev && ev.meta.number === 42, JSON.stringify(ev?.meta));
  }
  {
    // No recorded PR → refused clearly.
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot("en");
    await handleSpecCallback(bot, cb("spcready:gamma"), CONV);
    check("spcready(no-pr): refused", sent.map((m) => m.t).join("\n").includes("No PR recorded"), sent.map((m) => m.t).join("\n"));
    check("spcready(no-pr): no gh call", ghCalls.length === 0);
  }

  // (The merged-detection detail-render assertions live in the real-Bot
  // dispatcher section below, where sendHtml is captured.)

  // ── S5.5: Clean up REFUSES while the branch has commits not in main ──────
  {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent, st } = mkBot("en");
    bot.st.set(CONV, { directory: fx.repo });
    pushSpecBranch(fx.wt); // the branch is on origin (pre-merge)
    seedPrState(st, "gamma");
    // The branch has a commit (feat: S2 work) NOT in main → refuse.
    await handleSpecCallback(bot, cb("spcclean:gamma"), CONV);
    const all = sent.map((m) => m.t).join("\n");
    check("clean-refuse: refused (commits not in main)", all.includes("commits not in main") || all.includes("chưa có trong main"), all);
    check("clean-refuse: the remote branch is KEPT", originHasBranch(fx.origin, "spec/gamma"));
    check("clean-refuse: the worktree is KEPT", existsSync(fx.wt.root));
    check("clean-refuse: the PR state is KEPT", !!st.peek(MACHINE_STATE_KEY)?.specPr?.gamma);
  }
  {
    // vi
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot("vi");
    bot.st.set(CONV, { directory: fx.repo });
    pushSpecBranch(fx.wt);
    seedPrState(bot.st, "gamma");
    await handleSpecCallback(bot, cb("spcclean:gamma"), CONV);
    check("clean-refuse(vi): vi refusal", sent.map((m) => m.t).join("\n").includes("chưa có trong main"), sent.map((m) => m.t).join("\n"));
  }
  {
    // No recorded PR → nothing to clean up.
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkBot("en");
    await handleSpecCallback(bot, cb("spcclean:gamma"), CONV);
    check("clean(no-pr): refused (no PR)", sent.map((m) => m.t).join("\n").includes("nothing to clean up"), sent.map((m) => m.t).join("\n"));
  }

  // ── S5.5: Clean up DELETES branch + worktree + state when clean ───────────
  for (const lang of ["vi", "en"] as const) {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent, st } = mkBot(lang);
    bot.st.set(CONV, { directory: fx.repo });
    pushSpecBranch(fx.wt);
    simulateMerge(fx.repo, fx.wt); // all spec commits are now in origin/main
    seedPrState(st, "gamma");
    await handleSpecCallback(bot, cb("spcclean:gamma"), CONV);
    const all = sent.map((m) => m.t).join("\n");
    check(`clean(${lang}): the remote branch was DELETED`, !originHasBranch(fx.origin, "spec/gamma"));
    check(`clean(${lang}): the worktree was REMOVED`, !existsSync(fx.wt.root));
    check(`clean(${lang}): the PR state was CLEARED`, st.peek(MACHINE_STATE_KEY)?.specPr?.gamma === undefined, JSON.stringify(st.peek(MACHINE_STATE_KEY)?.specPr));
    check(`clean(${lang}): confirmation sent`, all.includes(lang === "vi" ? "Đã dọn dẹp" : "Cleaned up"), all);
    const ev = auditLines().find((e) => e.action === "spec_cleanup" && e.meta?.spec === "gamma");
    check(`clean(${lang}): spec_cleanup audited`, !!ev && ev.meta.number === 42, JSON.stringify(ev?.meta));
  }

  // ── Real Bot dispatcher: spcpr:/spcready:/spcclean: are routed ────────────
  function mkRealBot(lang: "vi" | "en", repo: string) {
    const stateFile = join(tmp, `route-${++seq}.json`);
    const sent: Array<{ c: string; t: string; kb?: any[] }> = [];
    const tg: any = {
      sendMessage: async (c: string, t: string, o?: any) => void sent.push({ c, t, kb: o?.reply_markup?.inline_keyboard }),
      sendMessageId: async (c: string, t: string, o?: any) => void sent.push({ c, t, kb: o?.reply_markup?.inline_keyboard }),
      sendChatAction: async () => {}, deleteMessage: async () => {}, editMessageReplyMarkup: async () => {},
      editForumTopic: async () => {}, closeForumTopic: async () => {}, answerCallbackQuery: async () => {}, stop: () => {},
    };
    const oc: any = {
      listMessages: async () => OK_ITEMS, latestReply: async () => "tail", createSession: async () => "ses_1",
      prompt: async (s: string, m: string) => "msg_x", interrupt: async () => {}, setInstruction: async () => {}, removeInstruction: async () => {},
    };
    const st = new StateManager(stateFile);
    const cfg: any = {
      stateFile, maxSchedules: 5, busyMode: "ask", nextSteps: false, nextMinSecs: 0, maxWorkers: 5, spec: true,
      allowAny: true, allowedUserIds: [], opencodeDirectory: repo, opencodeUrl: "http://127.0.0.1:1",
    };
    const bot = new Bot(tg, oc, st, cfg);
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
    (bot as any).__sent = sent;
    return { bot, sent, st, oc };
  }
  const cbFor = (data: string) => ({
    id: "cb-route", from: { id: 7 }, data,
    message: { message_id: 1, chat: { id: 12345 }, is_topic_message: false },
  });

  // spcpr: routed → opens the PR (and NOT swallowed by the "spec:" detail).
  {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent } = mkRealBot("en", fx.repo);
    pushSpecBranch(fx.wt);
    await (bot as any).handleCallback(cbFor("spcpr:gamma"));
    const post = ghCallsWhere((c) => c.method === "POST" && c.path === "pulls");
    check("route(spcpr): reached the spec handler (PR opened)", post.length === 1, `gh=${JSON.stringify(ghCalls.map((c) => c.method + " " + c.path))} sent=${JSON.stringify(sent.map((m) => m.t?.slice(0, 80)))}`);
    check("route(spcpr): NOT the detail view", !sent.some((m) => (m.t ?? "").includes("📋 <b>Gamma spec</b>")), sent.map((m) => m.t?.slice(0, 40)).join(" | "));
  }
  // spcready: routed → un-drafts the PR.
  {
    resetGh();
    const fx = await newPrFixture();
    const { bot, st } = mkRealBot("en", fx.repo);
    seedPrState(st, "gamma", { draft: true });
    await (bot as any).handleCallback(cbFor("spcready:gamma"));
    check("route(spcready): reached the spec handler (un-drafted)", readyCalls.length === 1 && readyCalls[0].repo === "o/r" && readyCalls[0].number === 42, JSON.stringify(readyCalls));
  }
  // spcclean: routed → runs the clean-up (refuses here: branch not merged).
  {
    resetGh();
    const fx = await newPrFixture();
    const { bot, sent, st } = mkRealBot("en", fx.repo);
    pushSpecBranch(fx.wt);
    seedPrState(st, "gamma");
    await (bot as any).handleCallback(cbFor("spcclean:gamma"));
    const all = sent.map((m) => m.t).join("\n");
    check("route(spcclean): reached the spec handler (clean-up ran)", all.includes("commits not in main") || all.includes("Cleaned up"), all);
    check("route(spcclean): the branch is still on origin (refused)", originHasBranch(fx.origin, "spec/gamma"));
  }

  // ── S5.5: merged detection offers Clean up (real Bot, detail render) ──────
  {
    resetGh();
    prGetState = { state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z" };
    const fx = await newPrFixture();
    const { bot, sent, st } = mkRealBot("en", fx.repo);
    seedPrState(st, "gamma");
    await (bot as any).handleCallback(cbFor("spec:gamma"));
    const detail = sent.find((m) => (m.t ?? "").includes("Gamma spec"));
    const kbs = (detail?.kb ?? []).flat().map((b: any) => b.callback_data);
    check("merged-detect: the detail shows the merged marker", !!detail && detail.t.includes("merged into main"), detail?.t);
    check("merged-detect: the detail offers the Clean up button", kbs.includes("spcclean:gamma"), JSON.stringify(kbs));
    const gets1 = ghCallsWhere((c) => c.method === "GET" && c.path === "pulls/42").length;
    check("merged-detect: the PR state was fetched once", gets1 === 1, String(gets1));
    // Second tap: the merged result is cached → NO re-query.
    sent.length = 0;
    await (bot as any).handleCallback(cbFor("spec:gamma"));
    const detail2 = sent.find((m) => (m.t ?? "").includes("Gamma spec"));
    const kbs2 = (detail2?.kb ?? []).flat().map((b: any) => b.callback_data);
    const gets2 = ghCallsWhere((c) => c.method === "GET" && c.path === "pulls/42").length;
    check("merged-detect(cached): a second /spec does NOT re-query", gets2 === 1, `gets=${gets2}`);
    check("merged-detect(cached): still shows merged + Clean up", !!detail2 && detail2.t.includes("merged into main") && kbs2.includes("spcclean:gamma"), JSON.stringify(kbs2));
  }
  {
    // Not merged → no marker, no Clean up button (and it DOES query, since the
    // non-merged result is not cached).
    resetGh();
    prGetState = { state: "open", merged: false };
    const fx = await newPrFixture();
    const { bot, sent, st } = mkRealBot("en", fx.repo);
    seedPrState(st, "gamma");
    await (bot as any).handleCallback(cbFor("spec:gamma"));
    const detail = sent.find((m) => (m.t ?? "").includes("Gamma spec"));
    const kbs = (detail?.kb ?? []).flat().map((b: any) => b.callback_data);
    check("merged-detect(not-merged): no merged marker", !!detail && !detail.t.includes("merged into main"), detail?.t);
    check("merged-detect(not-merged): no Clean up button", !kbs.includes("spcclean:gamma"), JSON.stringify(kbs));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll S5 spec-PR checks passed.");
