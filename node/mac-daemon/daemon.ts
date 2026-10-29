#!/usr/bin/env -S npx tsx
/**
 * Mac node daemon — the other end of the /node task queue.
 *
 * Every poll interval:
 *   1. update its own private clone of the repo (WORKROOT/repo)
 *   2. look for an unclaimed task on the node/mac branch
 *   3. claim it (claims/<id>.lock)
 *   4. run it: git worktree at the task's base ref → `claude -p`
 *   5. deliver: code branch (if files changed) + done/<id>.md report
 *   6. clean up the worktree
 *
 * It never touches the user's own working clone — everything (repo clone,
 * worktrees, logs) lives under WORKROOT (default ~/mac-node).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude } from "./claude.js";
import { git, pushBranch, resolveCloneUrl } from "./git.js";
import {
  buildDoneFile,
  claimPath,
  codeBranchFor,
  DONE_DIR,
  NODE_BRANCH,
  parseTaskFile,
  taskIdsFromTree,
  TASKS_DIR,
  type NodeDone,
} from "../../src/node/node-github.js";

// ── config ───────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const WORKROOT = process.env.MAC_NODE_WORKROOT?.trim() || join(homedir(), "mac-node");
const POLL_MS = Math.max(10_000, Number(process.env.MAC_NODE_POLL_MS?.trim() || 30_000));
const CLAUDE_BIN = process.env.MAC_NODE_CLAUDE_BIN?.trim() || "claude";
const MAX_TURNS = Math.max(1, Number(process.env.MAC_NODE_MAX_TURNS?.trim() || 200));
const TIMEOUT_MS = Math.max(60_000, Number(process.env.MAC_NODE_TIMEOUT_MS?.trim() || 30 * 60_000));
const REPO_CLONE = join(WORKROOT, "repo");
const WT_ROOT = join(WORKROOT, "wt");
const LOG_DIR = join(WORKROOT, "logs");

function log(line: string): void {
  const l = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(l);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "daemon.log"), l);
  } catch {}
}

// ── singleton guard (launchd KeepAlive + a manual run must not collide) ─────

const LOCK = join(WORKROOT, ".lock");
function acquireLock(): boolean {
  try {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    if (pid > 0 && pid !== process.pid) {
      process.kill(pid, 0); // throws when the pid is dead
      log(`another daemon (pid ${pid}) is running — exiting`);
      return false;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  mkdirSync(WORKROOT, { recursive: true });
  writeFile(LOCK, String(process.pid)).catch(() => {});
  return true;
}

// ── clone management ─────────────────────────────────────────────────────────

/**
 * Keep the private clone fresh. Returns false when the node/mac branch
 * doesn't exist on the origin yet (nothing to do).
 *
 * The clone's own working tree is the daemon's view of the node branch —
 * node commits are made there directly (the code worktrees are separate).
 */
async function ensureRepo(): Promise<boolean> {
  // An interrupted clone has a .git dir but no remote-tracking refs —
  // "healthy" means we can see the node branch locally.
  const healthy = await git(REPO_CLONE, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + NODE_BRANCH], 10_000)
    .then(() => true)
    .catch(() => false);
  if (!healthy) {
    if (existsSync(REPO_CLONE)) {
      log("broken clone on disk — removing and re-cloning…");
      await rm(REPO_CLONE, { recursive: true, force: true });
    }
    log("cloning repo…");
    await mkdir(WORKROOT, { recursive: true });
    const rawUrl = await git(REPO_ROOT, ["remote", "get-url", "origin"]);
    const url = resolveCloneUrl(rawUrl, process.env.MAC_NODE_GIT_TOKEN?.trim() || "");
    await git(REPO_ROOT, ["clone", "-q", url, REPO_CLONE], 300_000);
  }
  await git(REPO_CLONE, ["fetch", "-q", "--prune", "origin"], 120_000);
  const hasNodeBranch = await git(REPO_CLONE, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/" + NODE_BRANCH])
    .then(() => true)
    .catch(() => false);
  if (!hasNodeBranch) return false;
  await git(REPO_CLONE, ["checkout", "-q", NODE_BRANCH]).catch(() =>
    git(REPO_CLONE, ["checkout", "-q", "-b", NODE_BRANCH, "origin/" + NODE_BRANCH]),
  );
  await git(REPO_CLONE, ["merge", "-q", "--ff-only", "origin/" + NODE_BRANCH]);
  return true;
}

/** Read a file from the freshly fetched origin/node/mac (FETCH_HEAD). */
async function readBranchFile(path: string): Promise<string | null> {
  try {
    return await git(REPO_CLONE, ["show", `FETCH_HEAD:${path}`]);
  } catch {
    return null;
  }
}

/** Commit+push node-branch changes in the clone's working tree. */
async function nodeCommit(files: Array<{ path: string; content?: string; delete?: boolean }>, message: string): Promise<void> {
  for (const f of files) {
    const p = join(REPO_CLONE, f.path);
    if (f.delete) {
      if (existsSync(p)) await rm(p);
    } else {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content ?? "");
    }
  }
  const status = await git(REPO_CLONE, ["status", "--porcelain"]);
  if (status) {
    await git(REPO_CLONE, ["add", "-A"]);
    await git(REPO_CLONE, ["commit", "-q", "-m", message]);
    await pushBranch(REPO_CLONE, NODE_BRANCH);
  }
}

// ── one task ─────────────────────────────────────────────────────────────────

async function runTask(id: string): Promise<void> {
  const wtDir = join(WT_ROOT, id);
  log(`task ${id}: starting`);
  const done: NodeDone = {
    id,
    status: "failed",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    sessionId: "",
    report: "❌ Lỗi nội bộ daemon.",
  };
  try {
    const raw = await readBranchFile(`${TASKS_DIR}/${id}.md`);
    const task = raw ? parseTaskFile(raw) : null;
    if (!task) throw new Error("task file missing or malformed");

    // claim first, so the hub shows "running"
    await nodeCommit([{ path: claimPath(id), content: String(Date.now()) }], `node: claim ${id}`);

    // code worktree at the task's base ref
    await git(REPO_CLONE, ["fetch", "-q", "origin", task.base], 300_000).catch(() => {});
    await mkdir(WT_ROOT, { recursive: true });
    await git(REPO_CLONE, ["worktree", "add", "-q", wtDir, "FETCH_HEAD"], 120_000);
    await git(wtDir, ["checkout", "-q", "-b", codeBranchFor(id)]);

    // run claude
    const r = await runClaude({
      bin: CLAUDE_BIN,
      workdir: wtDir,
      prompt: task.prompt,
      maxTurns: task.maxTurns > 0 ? task.maxTurns : MAX_TURNS,
      timeoutMs: task.timeoutMs > 0 ? task.timeoutMs : TIMEOUT_MS,
      log: (l) => log(`[${id}] ${l}`),
    });
    Object.assign(done, r);

    // code branch (only when files changed)
    const changed = await git(wtDir, ["status", "--porcelain"]).catch(() => "");
    if (changed.trim()) {
      await git(wtDir, ["add", "-A"]);
      await git(wtDir, ["commit", "-q", "-m", `node(${id}): ${task.prompt.slice(0, 60).replace(/\n/g, " ")}`]);
      await pushBranch(wtDir, codeBranchFor(id));
      done.codeBranch = codeBranchFor(id);
      done.report += `\n\n🌿 Đã sửa code — branch \`${done.codeBranch}\` đã push (merge tay nếu cần).`;
    }
  } catch (e) {
    log(`task ${id}: FAILED — ${e instanceof Error ? e.message : e}`);
    done.status = "failed";
    if (!done.report || done.report.startsWith("❌ Lỗi nội bộ")) {
      done.report = `❌ Daemon lỗi: ${e instanceof Error ? e.message : String(e)}`;
    }
  } finally {
    // deliver the report (claim removed, done added) — always attempted
    await nodeCommit(
      [
        { path: claimPath(id), delete: true },
        { path: `${DONE_DIR}/${id}.md`, content: buildDoneFile(done) },
      ],
      `node: done ${id} (${done.status})`,
    ).catch((e) => log(`task ${id}: DELIVERY FAILED — ${e instanceof Error ? e.message : e}`));
    // clean up the worktree
    await git(REPO_CLONE, ["worktree", "remove", "-q", "--force", wtDir]).catch(() => {});
    await git(REPO_CLONE, ["worktree", "prune", "-q"]).catch(() => {});
    log(`task ${id}: finished (${done.status}) — $${done.costUsd.toFixed(2)}, ${done.durationMs}ms`);
  }
}

// ── main loop ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (!(await ensureRepo())) return; // node branch doesn't exist yet
  await git(REPO_CLONE, ["fetch", "-q", "origin", NODE_BRANCH]);
  const files = (await git(REPO_CLONE, ["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).split("\n").filter(Boolean);
  const claims = taskIdsFromTree("claims", files);
  const dones = taskIdsFromTree(DONE_DIR, files);
  for (const id of taskIdsFromTree(TASKS_DIR, files)) {
    if (claims.includes(id) || dones.includes(id)) continue;
    await runTask(id); // serial: one task at a time (v1)
    return; // next cycle re-lists
  }
}

async function main(): Promise<void> {
  if (!acquireLock()) process.exit(0);
  log(`mac node daemon started (workroot ${WORKROOT}, poll ${POLL_MS}ms, claude ${CLAUDE_BIN})`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(`tick error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

void main().catch((e) => {
  log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
