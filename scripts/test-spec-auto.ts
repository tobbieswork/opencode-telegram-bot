/**
 * S6.5 (auto run-next) — a spec run can opt in to "auto": a green task finish
 * is accepted and the next task is spawned with NO tap; any red finish (or a
 * blocked next task) clears the flag and says so. The card offers the opt-in
 * button; a green card in auto mode says so and skips the button.
 *
 * The hook (specAutoContinue) is wired to the orchestrator's terminal path
 * (Host.onSpecCheckpoint); here it is called directly with a settled worker
 * entry, against REAL git repos (like test-spec-run): spawn a run, settle the
 * worker, and check the accept + next-spawn chain end to end. Each scenario
 * gets its own temp repo so worktree/spec state never bleeds between them.
 *
 * Run:  npx tsx scripts/test-spec-auto.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { handleSpecCallback, specAutoContinue } from "../src/commands/spec.js";
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

// alpha: S1 done, S2 runnable, S3 BLOCKED (Needs:), S4 todo.
const ALPHA = `# Alpha spec

## Design
Some design text.

## 5. Tasks
1. [x] (abc1234) **S1 First.** A done task (Q1.1). *Checkpoint: review it.*
2. [ ] **S2 Second.** The next task. *Checkpoint: browse in Telegram.*
3. [ ] **S3 Third.** Needs: live OpenCode service
4. [ ] **S4 Fourth.** A later task.
`;

// unmarked: two plain runnable tasks (no Needs:) — U1 → U2 chains.
const UNMARKED = `# Unmarked spec

## Tasks
1. **U1 One.** first task
2. **U2 Two.** second task
`;

function mkRepo(): string {
  const repo = join(mkdtempSync(join(tmpdir(), "spec-auto-")), "repo");
  mkdirSync(join(repo, "docs", "sdd"), { recursive: true });
  writeFileSync(join(repo, "docs", "sdd", "alpha.md"), ALPHA);
  writeFileSync(join(repo, "docs", "sdd", "unmarked.md"), UNMARKED);
  // T1 (accept gate): the auto-continue Accept runs `npm run …` in the spec
  // worktree — the fixture repo carries green canonical scripts.
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "alpha-fixture", private: true, scripts: { typecheck: "node -e ''", "test:unit": "node -e ''" } }, null, 1));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@test.local"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}
const repos: string[] = [];
const tmpRoot = mkdtempSync(join(tmpdir(), "spec-auto-root-"));
const repoOf = (): string => {
  const r = mkRepo();
  repos.push(r);
  return r;
};

configureAudit({ path: join(tmpRoot, "audit.jsonl") });

const CONV = "123:45";
const WCONV = "123:999";
const cb = (data: string, uid = 7) => ({ id: "cb-1", from: { id: uid }, data });

function mkBot(repo: string, lang: "vi" | "en" = "en") {
  const sent: { text: string; kb?: Array<Array<{ text: string; callback_data: string }>> }[] = [];
  const push = (_c: string, text: string, opts?: { reply_markup?: { inline_keyboard: any } }) => {
    sent.push({ text, kb: opts?.reply_markup?.inline_keyboard });
  };
  const orch: any = {
    spawns: [] as any[],
    claimSpecRun: () => true,
    releaseSpecRun: () => {},
    reapSpecRunMarkers: () => {},
    spawn: async (_chat: string, spec: any) => {
      orch.spawns.push(spec);
      return { conv: WCONV, worker: { name: spec.name } };
    },
  };
  // Conv-keyed state like the real StateManager: the OWNER conv (Run taps,
  // cards) and the WORKER conv (the worker entry + its spec worktree).
  const owner: any = { directory: repo };
  const worker: any = { directory: repo };
  const stState: any = worker; // scenario helper keeps using this for the worker entry
  const bot: any = {
    cfg: { spec: true, opencodeDirectory: repo, allowAny: true, allowedUserIds: [] },
    userPrefs: { getLang: () => lang },
    st: {
      peek: (c: string) => (c === WCONV ? worker : owner),
      get: (c: string) => (c === WCONV ? worker : owner),
      set: (c: string, patch: any) => void Object.assign(c === WCONV ? worker : owner, patch),
      findWorker: (_chat: string, name: string) =>
        worker.worker && worker.worker.name === name ? [WCONV, worker] : undefined,
    },
    tg: {
      sendMessage: async (c: string, text: string, opts?: any) => void push(c, text, opts),
      answerCallbackQuery: async () => {},
    },
    sendHtml: async (c: string, text: string, opts?: any) => void push(c, text, opts),
    orch,
    specProbeService: async () => ({ ok: true, checkable: true }),
  };
  return { bot, sent, orch, stState, owner };
}

/** Spawn a run of `spec`'s first todo task, then settle the worker entry as
 * if the worker had finished (with `status`) having made one commit on the
 * spec branch. Returns the spec worktree directory. */
async function spawnAndSettle(bot: any, stState: any, repo: string, spec: string, task: string, n: number, status: "done" | "failed", auto: boolean): Promise<string> {
  await handleSpecCallback(bot, cb(`specrun:${spec}:${n}`), CONV);
  const dir = bot.orch.spawns[0]?.directory;
  if (!dir) throw new Error("no spawn");
  stState.directory = dir; // the worker conv's directory is the spec worktree
  git(dir, ["commit", "-q", "--allow-empty", "-m", "feat: worker work"]);
  stState.worker = {
    name: `spec-${spec}`,
    status,
    specRun: { spec, branch: `spec/${spec}`, task, conv: CONV, uid: 7, auto },
  };
  return dir;
}

try {
  // ── A: auto tap on a green card, next task BLOCKED → accept + chain stops ─
  {
    const repo = repoOf();
    const { bot, sent, orch, stState } = mkBot(repoOf());
    const dir = await spawnAndSettle(bot, stState, repo, "alpha", "S2", 2, "done", false);
    await handleSpecCallback(bot, cb("spcauto:alpha:2"), CONV);
    check("A: auto flag turned on", stState.worker?.specRun?.auto === true, JSON.stringify(stState.worker?.specRun));
    const md = readFileSync(join(dir, "docs", "sdd", "alpha.md"), "utf8");
    check("A: S2 marked done with a commit hash", /^\d+\. \[x\] \([0-9a-fA-F]{4,12}\) \*\*S2 Second\.\*\*/m.test(md), md.split("\n").slice(6, 10).join(" | "));
    check("A: blocked S3 NOT spawned", orch.spawns.length === 1, String(orch.spawns.length));
    const blocked = sent.find((m) => m.kb?.flat().some((b) => b.callback_data === "specblocked:alpha:3"));
    check("A: blocked-next message offers the explicit 'run anyway' flow", !!blocked && /block|chặn/i.test(blocked.text), JSON.stringify(sent.map((m) => m.text?.slice(0, 70))));
  }

  // ── B: auto flag + green finish → hook accepts + spawns the next task ─────
  {
    const repo = repoOf();
    const { bot, orch, stState } = mkBot(repoOf());
    const dir = await spawnAndSettle(bot, stState, repo, "unmarked", "U1", 1, "done", true);
    await specAutoContinue(bot, WCONV, "done");
    check("B: U2 spawned by the hook (no tap)", orch.spawns.length === 2, String(orch.spawns.length));
    check("B: the spawn is for U2", orch.spawns[1]?.specRun?.task === "U2", JSON.stringify(orch.spawns[1]?.specRun));
    check("B: the auto flag is carried onto the next run", orch.spawns[1]?.specRun?.auto === true, JSON.stringify(orch.spawns[1]?.specRun));
    const md = readFileSync(join(dir, "docs", "sdd", "unmarked.md"), "utf8");
    check("B: U1 marked done", /^\d+\. \[x\] \([0-9a-fA-F]{4,12}\) \*\*U1 One\.\*\*/m.test(md), md.split("\n").slice(4, 8).join(" | "));
  }

  // ── C: auto flag + RED finish → cleared + notice, no accept ───────────────
  {
    const repo = repoOf();
    const { bot, sent, orch, stState } = mkBot(repoOf());
    const dir = await spawnAndSettle(bot, stState, repo, "alpha", "S2", 2, "failed", true);
    await specAutoContinue(bot, WCONV, "failed");
    check("C: auto flag cleared", stState.worker?.specRun?.auto === false, JSON.stringify(stState.worker?.specRun));
    check("C: red-finish notice posted", sent.some((m) => /auto run (stopped|dừng)/i.test(m.text ?? "")), JSON.stringify(sent.map((m) => m.text?.slice(0, 80))));
    check("C: nothing spawned", orch.spawns.length === 1, String(orch.spawns.length));
    const md = readFileSync(join(dir, "docs", "sdd", "alpha.md"), "utf8");
    check("C: S2 NOT marked done", !/\[x\] \([0-9a-fA-F]+\) \*\*S2 Second\.\*\*/.test(md), "");
  }

  // ── D: no auto flag → the hook is a no-op ─────────────────────────────────
  {
    const repo = repoOf();
    const { bot, sent, orch, stState } = mkBot(repoOf());
    const dir = await spawnAndSettle(bot, stState, repo, "alpha", "S2", 2, "done", false);
    await specAutoContinue(bot, WCONV, "done");
    check("D: no spawn without the flag", orch.spawns.length === 1, String(orch.spawns.length));
    check("D: no auto notices", sent.every((m) => !/auto run/i.test(m.text ?? "")), JSON.stringify(sent.map((m) => m.text?.slice(0, 80))));
    const md = readFileSync(join(dir, "docs", "sdd", "alpha.md"), "utf8");
    check("D: S2 still unmarked", !/\[x\] \([0-9a-fA-F]+\) \*\*S2 Second\.\*\*/.test(md), "");
  }

  // ── E: auto tap while the worker is still BUSY → accept refused, flag kept ─
  {
    const repo = repoOf();
    const { bot, sent, orch, stState } = mkBot(repoOf());
    await handleSpecCallback(bot, cb("specrun:alpha:2"), CONV);
    stState.directory = bot.orch.spawns[0]?.directory;
    stState.worker = {
      name: "spec-alpha",
      status: "running",
      specRun: { spec: "alpha", branch: "spec/alpha", task: "S2", conv: CONV, uid: 7 },
    };
    await handleSpecCallback(bot, cb("spcauto:alpha:2"), CONV);
    check("E: busy worker — nothing spawned", orch.spawns.length === 1, String(orch.spawns.length));
    check("E: still-working notice posted", sent.some((m) => /still working|đang chạy/i.test(m.text ?? "")), JSON.stringify(sent.map((m) => m.text?.slice(0, 80))));
    check("E: auto flag stays on (standing instruction)", stState.worker?.specRun?.auto === true, JSON.stringify(stState.worker?.specRun));
  }
} finally {
  for (const r of repos) rmSync(dirname(r), { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll S6.5 spec-auto checks passed.");
