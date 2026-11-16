/**
 * S4 (spec Run) — execution: tapping "Run" on a spec task spawns ONE worker on
 * a dedicated spec branch (spec/<name>, its own worktree cut from the default
 * branch) with the buildTaskPrompt output. One running worker per SPEC,
 * persisted in state.json; a blocked task is a two-tap flow (probe + "Run
 * anyway"); the spec_run audit event is recorded.
 *
 * Fixtures are small markdown files in a fresh temp git repo (real `git init`
 * + an initial commit + a local identity) — never the repo's own docs/sdd.
 *
 * Run:  npx tsx scripts/test-spec-run.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSpecCallback } from "../src/commands/spec.js";
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

// ── fixtures ────────────────────────────────────────────────────────────────
// alpha: 1 done (S1), 1 non-blocked next (S2), 1 blocked (S3, mentions
// opencode → probe is checkable), 1 todo (S4).
const ALPHA = `# Alpha spec

## Design
Some design text.

## 5. Tasks
1. [x] (abc1234) **S1 First.** A done task (Q1.1). *Checkpoint: review it.*
2. [ ] **S2 Second.** The next task. *Checkpoint: browse in Telegram.*
3. [ ] **S3 Third.** Needs: live OpenCode service
4. [ ] **S4 Fourth.** A later task.
`;

// unmarked: a markerless task list — S4.3 must add markers + commit them on
// the spec branch before the worker runs.
const UNMARKED = `# Unmarked spec

## Tasks
1. **U1 One.** first task
2. **U2 Two.** second task
`;

const tmp = mkdtempSync(join(tmpdir(), "spec-run-"));
const repo = join(tmp, "repo");
mkdirSync(join(repo, "docs", "sdd"), { recursive: true });
writeFileSync(join(repo, "docs", "sdd", "alpha.md"), ALPHA);
writeFileSync(join(repo, "docs", "sdd", "unmarked.md"), UNMARKED);
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "test@test.local"]);
git(repo, ["config", "user.name", "Test"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "init"]);

// Direct all audit writes of this process at a scratch file (audit() is a
// no-op until configureAudit; the run flow emits spec_run there).
configureAudit({ path: join(tmp, "audit.jsonl") });

// ── duck bot + duck orchestrator (records claims/releases/spawns) ───────────
const CONV = "123:45";
const cb = (data: string, uid = 7) => ({ id: "cb-1", from: { id: uid }, data });

function mkBot(lang: "vi" | "en", dir: string, allow: { allowAny?: boolean; allowedUserIds?: number[] } = {}) {
  const sent: { text: string; kb?: Array<Array<{ text: string; callback_data: string }>> }[] = [];
  const push = (_c: string, text: string, opts?: { reply_markup?: { inline_keyboard: any } }) => {
    sent.push({ text, kb: opts?.reply_markup?.inline_keyboard });
  };
  const orch: any = {
    claims: [] as any[],
    releases: [] as any[],
    spawns: [] as any[],
    reaps: 0,
    claimSpecRun: (chat: string, spec: string, entry: any) => {
      orch.claims.push({ chat, spec, entry });
      return true;
    },
    releaseSpecRun: (chat: string, spec: string, worker?: string) => {
      orch.releases.push({ chat, spec, worker });
    },
    spawn: async (_chat: string, spec: any) => {
      orch.spawns.push(spec);
      return { conv: "worker-conv", worker: { name: spec.name } };
    },
    reapSpecRunMarkers: () => {
      orch.reaps++;
    },
  };
  const bot: any = {
    cfg: { spec: true, opencodeDirectory: dir, allowAny: allow.allowAny ?? true, allowedUserIds: allow.allowedUserIds ?? [] },
    userPrefs: { getLang: () => lang },
    st: { peek: () => ({ directory: dir }), get: () => ({ directory: dir }) },
    tg: {
      sendMessage: async (c: string, text: string, opts?: any) => void push(c, text, opts),
      answerCallbackQuery: async (_id: string, _t?: string) => {},
    },
    sendHtml: async (c: string, text: string, opts?: any) => void push(c, text, opts),
    orch,
    specProbeService: async () => ({ ok: true, checkable: true }),
  };
  return { bot, sent, orch };
}

try {
  // ── Guard logic (real Orchestrator + real StateManager) ───────────────────
  {
    const st = new StateManager(join(tmp, "guard-state.json"));
    const orch = new Orchestrator({ st } as any);
    const chat = "100";
    check("guard: first claim succeeds", orch.claimSpecRun(chat, "alpha", { branch: "spec/alpha", task: "S2", worker: "spec-alpha", since: 1 }) === true);
    check("guard: second claim (same spec) rejected", orch.claimSpecRun(chat, "alpha", { branch: "spec/alpha", task: "S2", worker: "spec-alpha", since: 2 }) === false);
    check("guard: different spec claimable in same chat", orch.claimSpecRun(chat, "beta", { branch: "spec/beta", task: "T1", worker: "spec-beta", since: 1 }) === true);
    orch.releaseSpecRun(chat, "alpha", "spec-alpha");
    check("guard: release (matching worker) clears entry", st.peek(chat)?.specRunning?.alpha === undefined);
    check("guard: re-claim after release succeeds", orch.claimSpecRun(chat, "alpha", { branch: "spec/alpha", task: "S2", worker: "spec-alpha", since: 3 }) === true);
    orch.releaseSpecRun(chat, "alpha", "some-other-worker");
    check("guard: release (mismatched worker) keeps entry", st.peek(chat)?.specRunning?.alpha?.worker === "spec-alpha");
    orch.releaseSpecRun(chat, "alpha", "spec-alpha");
    orch.releaseSpecRun(chat, "beta");
    check("guard: chat clean after releases", (st.peek(chat)?.specRunning?.alpha === undefined) && (st.peek(chat)?.specRunning?.beta === undefined));
  }

  // ── Dead-marker reaping (real Orchestrator) ───────────────────────────────
  {
    const st = new StateManager(join(tmp, "reap-state.json"));
    const orch = new Orchestrator({ st } as any);
    const chat = "200";
    st.set(chat, {
      specRunning: {
        dead: { branch: "spec/dead", task: "D1", worker: "spec-dead", since: 1 },
        live: { branch: "spec/live", task: "L1", worker: "spec-live", since: 1 },
      },
    });
    // A live spec worker in a topic of the same chat (status "running" ∈ BUSY).
    st.set("200:11", { worker: { name: "spec-live", status: "running" } });
    orch.reapSpecRunMarkers();
    check("reap: dead marker (no live worker) removed", st.peek(chat)?.specRunning?.dead === undefined);
    check("reap: live marker (busy worker) kept", st.peek(chat)?.specRunning?.live?.worker === "spec-live");
  }

  // ── Release via the setStatus hook (real Orchestrator, no manual release) ──
  {
    // setStatus with a CHANGED status calls tg.editForumTopic — a no-op duck.
    const tg: any = { editForumTopic: async () => {} };
    const st = new StateManager(join(tmp, "setstatus-state.json"));
    const orch = new Orchestrator({ st, tg } as any);
    const chat = "300";
    const seed = () => {
      st.set(chat, { specRunning: undefined });
      st.set("300:7", { worker: { name: "spec-g", status: "running", specRun: { spec: "g", branch: "spec/g", task: "G1" } } });
      orch.claimSpecRun(chat, "g", { branch: "spec/g", task: "G1", worker: "spec-g", since: 1 });
    };
    // done → the setStatus hook releases the marker (not a manual release call).
    seed();
    check("setstatus: marker claimed before done", st.peek(chat)?.specRunning?.g?.worker === "spec-g", JSON.stringify(st.peek(chat)?.specRunning));
    orch.setStatus("300:7", "done");
    check("setstatus: done releases the marker via the hook", st.peek(chat)?.specRunning?.g === undefined, JSON.stringify(st.peek(chat)?.specRunning));
    check("setstatus: worker settled to done", st.peek("300:7")?.worker?.status === "done", String(st.peek("300:7")?.worker?.status));
    // stopped → released again (covers the stop/kill path, not just done).
    seed();
    orch.setStatus("300:7", "stopped");
    check("setstatus: stopped releases the marker via the hook", st.peek(chat)?.specRunning?.g === undefined, JSON.stringify(st.peek(chat)?.specRunning));
  }

  // ── Answer resilience (B3 class): a failing answerCallbackQuery must not
  // abort the tap — a live incident lost a user's Run tap when the box network
  // blipped and the fatal answer threw before dispatch.
  {
    const { bot, sent } = mkBot("vi", repo);
    bot.tg.answerCallbackQuery = async () => { throw new Error("network error"); };
    await handleSpecCallback(bot, cb("spec:alpha"), CONV);
    const detail = sent.find((m) => (m.text ?? "").includes("<b>Alpha spec</b>"));
    check("tap: failing answer does not abort dispatch (detail still sent)", !!detail, JSON.stringify(sent.map((m) => m.text?.slice(0, 50))));
  }

  // ── Non-blocked Run → spawn + audit + worktree ────────────────────────────
  {
    const { bot, sent, orch } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("specrun:alpha:2"), CONV);
    check("run: spawns exactly one worker", orch.spawns.length === 1, JSON.stringify(orch.spawns));
    const sp = orch.spawns[0] ?? {};
    check("run: worker named spec-alpha", sp.name === "spec-alpha", sp.name);
    check("run: specRun.branch = spec/alpha", sp.specRun?.branch === "spec/alpha", JSON.stringify(sp.specRun));
    check("run: specRun.task = S2", sp.specRun?.task === "S2", JSON.stringify(sp.specRun));
    check("run: writes=true, spawnedBy=user", sp.writes === true && sp.spawnedBy === "user");
    check("run: prompt non-empty and names the task", typeof sp.task === "string" && sp.task.length > 0 && sp.task.includes("S2"), String(sp.task).slice(0, 80));
    check("run: claimed the spec slot", orch.claims.some((c: any) => c.spec === "alpha"), JSON.stringify(orch.claims));
    // The dedicated worktree was created on the spec branch.
    const wt = join(tmp, "repo.worktrees", "spec-alpha");
    check("run: spec worktree created (has the spec file)", existsSync(join(wt, "docs", "sdd", "alpha.md")), wt);
    // User-facing confirmation, not the old "not available yet" stub.
    const all = sent.map((m) => m.text).join("\n");
    check("run: no longer 'not available yet'", !all.includes("not available yet"), all);
    check("run: tells the user it's running in the spec branch", all.includes("spec/alpha") && all.includes("spec-alpha"), all);
    // S6.2: the spec_run audit event.
    const lines = readFileSync(join(tmp, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ev = lines.find((e) => e.action === "spec_run" && e.meta?.task === "S2" && e.meta?.runAnyway === false);
    check("audit: spec_run emitted for S2", !!ev, JSON.stringify(lines.map((l) => l.action)));
    check("audit: meta carries spec/branch/worker", !!ev && ev.meta.spec === "alpha" && ev.meta.branch === "spec/alpha" && ev.meta.worker === "spec-alpha", JSON.stringify(ev?.meta));
  }

  // ── Blocked task → two-tap flow ───────────────────────────────────────────
  {
    const { bot, sent, orch } = mkBot("vi", repo);
    // First tap: probe + "Run anyway", NO spawn.
    await handleSpecCallback(bot, cb("specblocked:alpha:3"), CONV);
    check("blocked: first tap does NOT spawn", orch.spawns.length === 0);
    const m = sent[0];
    check("blocked: names the blocking condition", (m?.text ?? "").includes("live OpenCode service"), m?.text);
    check("blocked: probe result shown (OpenCode checkable)", (m?.text ?? "").includes("phản hồi") || (m?.text ?? "").includes("responding"), m?.text);
    const kb = (m?.kb ?? []).flat();
    check("blocked: offers 'Run anyway' (specrunok:alpha:3)", kb.some((b) => b.callback_data === "specrunok:alpha:3"), JSON.stringify(kb));
    // Second tap: spawns.
    await handleSpecCallback(bot, cb("specrunok:alpha:3"), CONV);
    check("blocked: second tap spawns", orch.spawns.length === 1, JSON.stringify(orch.spawns));
    check("blocked: spawn is S3 on spec/alpha", orch.spawns[0]?.specRun?.task === "S3" && orch.spawns[0]?.specRun?.branch === "spec/alpha", JSON.stringify(orch.spawns[0]?.specRun));
    // S6.2: the runAnyway variant of the audit event.
    const lines = readFileSync(join(tmp, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("audit: spec_run with runAnyway=true for S3", lines.some((e) => e.action === "spec_run" && e.meta?.task === "S3" && e.meta?.runAnyway === true), JSON.stringify(lines.map((l) => l.meta)));
  }

  // ── Allowlist gate (defense in depth) ─────────────────────────────────────
  {
    const denied = mkBot("vi", repo, { allowAny: false, allowedUserIds: [7] });
    await handleSpecCallback(denied.bot, cb("specrun:alpha:2", 99), CONV); // uid 99 not allowed
    check("allowlist: non-allowlisted uid does NOT spawn", denied.orch.spawns.length === 0);
    check("allowlist: non-allowlisted uid → 'Not authorized'", denied.sent.map((m) => m.text).join("\n").includes("Not authorized"), denied.sent.map((m) => m.text).join("\n"));
    const allowed = mkBot("vi", repo, { allowAny: false, allowedUserIds: [7] });
    await handleSpecCallback(allowed.bot, cb("specrun:alpha:2", 7), CONV); // uid 7 allowed
    check("allowlist: allowlisted uid spawns", allowed.orch.spawns.length === 1);
  }

  // ── A done task is never re-run ───────────────────────────────────────────
  {
    const { bot, sent, orch } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("specrun:alpha:1"), CONV); // S1 is done
    check("done: not re-run (no spawn)", orch.spawns.length === 0);
    check("done: says already done", sent.map((m) => m.text).join("\n").includes("xong") || sent.map((m) => m.text).join("\n").includes("done"), sent.map((m) => m.text).join("\n"));
  }

  // ── S4.3: markers committed onto the spec branch for a markerless spec ────
  {
    const { bot, orch } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("specrun:unmarked:1"), CONV);
    check("markers: spawn attempted", orch.spawns.length === 1, JSON.stringify(orch.spawns));
    const wt = join(tmp, "repo.worktrees", "spec-unmarked");
    const specText = existsSync(join(wt, "docs", "sdd", "unmarked.md")) ? readFileSync(join(wt, "docs", "sdd", "unmarked.md"), "utf8") : "";
    check("markers: worktree spec now carries [ ] markers", specText.includes("1. [ ] **U1 One.**") && specText.includes("2. [ ] **U2 Two.**"), specText);
    // The marker commit is on the spec branch (more than the init commit).
    const commitCount = git(wt, ["rev-list", "--count", "HEAD"]);
    check("markers: a marker commit was made on the spec branch", parseInt(commitCount, 10) >= 2, `count=${commitCount}`);
    const lastSubject = git(wt, ["log", "-1", "--format=%s"]);
    check("markers: commit subject mentions the spec", lastSubject.includes("unmarked"), lastSubject);
  }

  // ── Reuse: a fresh run of a finished spec reuses the existing worktree ────
  {
    // spec-alpha's worktree already exists from the earlier run. A fresh run
    // (slot free) must reuse it, not fail on "path already exists".
    const { bot, orch } = mkBot("vi", repo);
    await handleSpecCallback(bot, cb("specrun:alpha:2"), CONV);
    check("reuse: a fresh run of the same spec succeeds (reuses worktree)", orch.spawns.length === 1, JSON.stringify(orch.spawns));
  }
  // ── Bot.handleCallback dispatch routes the new S4 prefixes (regression) ──
  // The handler tests above call handleSpecCallback directly; this drives the
  // REAL Bot dispatcher to prove "specrun:", "specblocked:" and "specrunok:"
  // are actually routed to the spec handler (a missing prefix here means the
  // button tap is silently dropped).
  {
    const stateFile = join(tmp, "route-state.json");
    const sent2: Array<{ text: string; kb?: Array<Array<{ text: string; callback_data: string }>> }> = [];
    const tg: any = {
      onThreadNotFound: undefined,
      onMessageReaction: undefined,
      sendMessage: async (_c: string, text: string, opts?: any) => { sent2.push({ text, kb: opts?.reply_markup?.inline_keyboard }); return 1; },
      sendMessageId: async (_c: string, text: string, opts?: any) => { sent2.push({ text, kb: opts?.reply_markup?.inline_keyboard }); return 1; },
      sendChatAction: async () => {},
      deleteMessage: async () => {},
      editMessageReplyMarkup: async () => {},
      answerCallbackQuery: async () => {},
      stop: () => {},
    };
    const oc: any = {
      promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
      prompt: async () => "msg_x",
      interrupt: async () => {},
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
    // Capture, don't neutralize, the user-facing sends; spy the orch methods a
    // run would touch so no real session/topic is created.
    (bot as any).sendHtml = async (_c: string, text: string, opts?: any) => void sent2.push({ text, kb: opts?.reply_markup?.inline_keyboard });
    (bot as any).sendReply = async () => {};
    (bot as any).startTyping = () => {};
    (bot as any).stopTyping = () => {};
    (bot as any).startWorking = () => {};
    (bot as any).clearActivity = () => {};
    (bot as any).dropPreview = async () => {};
    (bot as any).offerContinueKeyboard = () => undefined;
    const rec = { claims: [] as any[], releases: [] as any[], spawns: [] as any[] };
    const orch: any = (bot as any).orch;
    // claimSpecRun must return true (claim granted) for the run to proceed.
    orch.claimSpecRun = (chat: string, spec: string, entry: any) => { rec.claims.push({ chat, spec, entry }); return true; };
    orch.releaseSpecRun = (chat: string, spec: string, worker?: string) => void rec.releases.push({ chat, spec, worker });
    orch.spawn = async (_chat: string, spec: any) => { rec.spawns.push(spec); return { conv: "route-conv", worker: { name: spec.name } }; };
    const cbFor = (data: string) => ({
      id: "cb-route",
      from: { id: 7 },
      data,
      message: { message_id: 1, chat: { id: 12345 }, is_topic_message: false },
    });
    // Non-blocked Run → routed, claims the slot and spawns.
    await (bot as any).handleCallback(cbFor("specrun:alpha:2"));
    check("route: specrun: reaches the spec handler (claims + spawns)", rec.claims.some((c: any) => c.spec === "alpha") && rec.spawns.length === 1, JSON.stringify({ claims: rec.claims, spawns: rec.spawns }));
    // Blocked Run, first tap → routed, probes, offers "Run anyway" (no spawn).
    const before = rec.spawns.length;
    await (bot as any).handleCallback(cbFor("specblocked:alpha:3"));
    check("route: specblocked: routed, no spawn (probe only)", rec.spawns.length === before, JSON.stringify(rec.spawns));
    check("route: specblocked: offers the 'Run anyway' button", sent2.some((m) => (m.kb ?? []).flat().some((b) => b.callback_data === "specrunok:alpha:3")), JSON.stringify(sent2.map((m) => m.kb)));
    // Blocked Run, second tap → routed, spawns.
    await (bot as any).handleCallback(cbFor("specrunok:alpha:3"));
    check("route: specrunok: routed and spawns (second tap)", rec.spawns.length === before + 1, JSON.stringify(rec.spawns.map((x: any) => x.specRun)));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll S4 spec-Run checks passed.");
