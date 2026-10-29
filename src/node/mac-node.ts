/**
 * Hub side of the Mac node (Claude CLI on a second machine).
 *
 * Tasks travel over the `node/mac` git branch (protocol in node-github.ts):
 * the hub commits a task file, a daemon on the Mac picks it up, runs
 * `claude -p`, and files a done file. This module owns the hub's I/O: a
 * dedicated single-branch clone (cfg.nodeMacDir — the live working tree is
 * never touched), polling for done files, and relaying reports to the chat
 * that queued the task.
 *
 * Crash-safety: a relayed report is kept as a local copy (data/node/reports/)
 * BEFORE the branch files are collected, and the conv mapping (which chat to
 * reply to) lives in data/node/conv-map.json — so a restart never loses a
 * report and never relays the same one twice (worst case: one duplicate
 * after a crash between relay and collect).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { warn } from "../logger.js";
import { esc } from "../format.js";
import {
  buildTaskFile,
  claimPath,
  DONE_DIR,
  newTaskId,
  NODE_BRANCH,
  parseDoneFile,
  parseTaskFile,
  taskIdsFromTree,
  taskPath,
  type NodeDone,
  type NodeTask,
} from "./node-github.js";
import type { Bot } from "../bot.js";

/** Agent identity for commits made by the hub on the node branch (repo convention). */
const GIT_IDENTITY = { name: "Qwen3.8-27B (OpenCode)", email: "qwen38-27b-noreply@opencode.local" };

/** Run git with an argument vector (never a shell string) and return trimmed stdout. */
function git(dir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", dir, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim()));
      else ok(stdout.trim());
    });
  });
}

export interface MacNodeDeps {
  /** Directory of the single-branch clone (created on demand). */
  dir: string;
  /** Working repo whose `origin` hosts the node/mac branch. */
  repoDir: string;
  /** Poll interval, ms. */
  pollMs: number;
  now: () => number;
  /** Relay a finished report to the chat that queued the task. */
  relay: (done: NodeDone, conv: string) => void;
}

/** A queued task with its conv mapping, for /node status. */
export interface NodeTaskInfo {
  id: string;
  base: string;
  state: "pending" | "running";
}

export class MacNode {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(private d: MacNodeDeps) {}

  /** Local data dir (reports + conv map), a sibling of the clone. */
  private dataDir(): string {
    return join(dirname(this.d.dir), "data");
  }

  start(): void {
    void this.poll().catch((e) => warn("node poll:", e?.message));
    this.timer = setInterval(() => {
      void this.poll().catch((e) => warn("node poll:", e?.message));
    }, this.d.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ── clone management ──────────────────────────────────────────────────────

  /** Ensure the single-branch clone exists; seed the branch on first use. */
  private async ensureClone(): Promise<void> {
    if (existsSync(join(this.d.dir, ".git"))) return;
    await mkdir(dirname(this.d.dir), { recursive: true });
    const url = await git(this.d.repoDir, ["remote", "get-url", "origin"]);
    try {
      await git(this.d.repoDir, ["clone", "--quiet", "--branch", NODE_BRANCH, "--single-branch", url, this.d.dir], 120_000);
    } catch (e) {
      if (!/not found|does not exist|couldn't find remote ref/i.test(String(e))) throw e;
      // First use: seed the branch with a README so both sides have a base commit.
      await mkdir(this.d.dir, { recursive: true });
      await git(this.d.dir, ["init", "-q", "-b", NODE_BRANCH]);
      await git(this.d.dir, ["remote", "add", "origin", url]);
      await git(this.d.dir, ["config", "user.name", GIT_IDENTITY.name]);
      await git(this.d.dir, ["config", "user.email", GIT_IDENTITY.email]);
      await writeFile(join(this.d.dir, "README.md"), NODE_README, "utf8");
      await git(this.d.dir, ["add", "README.md"]);
      await git(this.d.dir, ["commit", "-q", "-m", "node: seed task branch"]);
      await git(this.d.dir, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH], 120_000);
    }
    await git(this.d.dir, ["config", "user.name", GIT_IDENTITY.name]);
    await git(this.d.dir, ["config", "user.email", GIT_IDENTITY.email]);
  }

  /** Fast-forward the clone to origin/node/mac. */
  private async sync(): Promise<void> {
    await this.ensureClone();
    await git(this.d.dir, ["fetch", "--quiet", "origin", NODE_BRANCH]);
    await git(this.d.dir, ["merge", "--ff-only", "-q", "FETCH_HEAD"]);
  }

  /** Push with rebase-retry (the daemon pushes to the same branch in parallel). */
  private async push(): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await git(this.d.dir, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH]);
        return;
      } catch (e) {
        if (i >= 2) throw e;
        await git(this.d.dir, ["fetch", "--quiet", "origin", NODE_BRANCH]);
        await git(this.d.dir, ["rebase", "-q", "FETCH_HEAD"]);
      }
    }
  }

  /** Commit any local changes (no-op when the tree is clean) and push. */
  private async commitPush(message: string): Promise<void> {
    const status = await git(this.d.dir, ["status", "--porcelain"]);
    if (status) {
      await git(this.d.dir, ["add", "-A"]);
      await git(this.d.dir, ["commit", "-q", "-m", message]);
      await this.push();
    }
  }

  // ── task queue ────────────────────────────────────────────────────────────

  /** Queue a task for the Mac; returns the task (id + base) for the ack. */
  async pushTask(prompt: string, base: string, uid: number | string, conv: string): Promise<NodeTask> {
    await this.sync();
    const task: NodeTask = {
      id: newTaskId(),
      base,
      maxTurns: 200,
      timeoutMs: 30 * 60_000,
      createdAt: new Date(this.d.now()).toISOString(),
      createdBy: String(uid),
      prompt,
    };
    await mkdir(join(this.d.dir, dirname(taskPath(task.id))), { recursive: true });
    await writeFile(join(this.d.dir, taskPath(task.id)), buildTaskFile(task), "utf8");
    await this.setConv(task.id, conv);
    await this.commitPush(`node: queue ${task.id} (base ${base})`);
    return task;
  }

  // ── polling + relay ───────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pollOnce();
    } finally {
      this.busy = false;
    }
  }

  /** One poll cycle (public so tests can drive it deterministically). */
  async pollOnce(): Promise<void> {
    await this.sync();
    const files = (await git(this.d.dir, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").filter(Boolean);
    for (const id of taskIdsFromTree(DONE_DIR, files)) {
      const text = await git(this.d.dir, ["show", `HEAD:${DONE_DIR}/${id}.md`]).catch(() => "");
      const done = parseDoneFile(text);
      if (!done || done.id !== id) continue;
      const copy = join(this.dataDir(), "reports", id + ".md");
      if (existsSync(copy)) {
        await this.collect(id);
        continue;
      }
      const conv = await this.takeConv(id);
      if (conv) this.d.relay(done, conv);
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(copy, text, "utf8");
      await this.collect(id);
    }
  }

  /** Delete the branch files of a finished task (report already kept locally). */
  private async collect(id: string): Promise<void> {
    for (const p of [taskPath(id), claimPath(id), `${DONE_DIR}/${id}.md`]) {
      const f = join(this.d.dir, p);
      if (existsSync(f)) await rm(f);
    }
    await this.commitPush(`node: collect ${id}`).catch((e) => warn("node collect:", e?.message));
  }

  // ── conv mapping (task id → chat), persisted ──────────────────────────────

  private convMapPath(): string {
    return join(this.dataDir(), "conv-map.json");
  }

  private async setConv(id: string, conv: string): Promise<void> {
    const map = await this.readConvMap();
    map[id] = conv;
    await mkdir(this.dataDir(), { recursive: true });
    await writeFile(this.convMapPath(), JSON.stringify(map, null, 2), "utf8");
  }

  private async takeConv(id: string): Promise<string | undefined> {
    const map = await this.readConvMap();
    const conv = map[id];
    delete map[id];
    await writeFile(this.convMapPath(), JSON.stringify(map, null, 2), "utf8").catch(() => {});
    return conv || undefined;
  }

  private async readConvMap(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.convMapPath(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  // ── /node status + log ────────────────────────────────────────────────────

  async status(): Promise<{ queued: NodeTaskInfo[]; lastReports: { id: string; status: string; costUsd: number }[] }> {
    await this.sync();
    const files = (await git(this.d.dir, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").filter(Boolean);
    const queued: NodeTaskInfo[] = [];
    for (const id of taskIdsFromTree("tasks", files)) {
      const task = (await git(this.d.dir, ["show", `HEAD:${taskPath(id)}`]).then(parseTaskFile).catch(() => null));
      if (task) queued.push({ id: task.id, base: task.base, state: files.includes(claimPath(id)) ? "running" : "pending" });
    }
    const lastReports: { id: string; status: string; costUsd: number }[] = [];
    const repDir = join(this.dataDir(), "reports");
    const names = existsSync(repDir) ? (await readdir(repDir)).filter((n) => n.endsWith(".md")).sort().reverse() : [];
    for (const n of names.slice(0, 5)) {
      const done = parseDoneFile(await readFile(join(repDir, n), "utf8").catch(() => ""));
      if (done) lastReports.push({ id: done.id, status: done.status, costUsd: done.costUsd });
    }
    return { queued, lastReports };
  }

  /** Local copy of a finished report (null = not found / too old). */
  async report(id: string): Promise<string | null> {
    const p = join(this.dataDir(), "reports", id + ".md");
    if (!existsSync(p)) return null;
    return readFile(p, "utf8");
  }
}

const NODE_README = `# node/mac

Task queue between the bot (hub) and the Mac node daemon (node/mac-daemon/).

- tasks/<id>.md  — hub → daemon: a task to run (front matter + prompt)
- claims/<id>.lock — daemon: "working on it"
- done/<id>.md  — daemon → hub: the report (front matter + markdown)

Human-inspectable on purpose; both sides share src/node/node-github.ts.
`;

// ── /node command ─────────────────────────────────────────────────────────────

export const NODE_USAGE =
  "/node task <mô tả> — giao việc cho node Mac (Claude CLI)\n" +
  "  · thêm base=<branch> trước mô tả để checkout branch khác (mặc định main)\n" +
  "  · daemon nhận trong ~30s; report tự về chat này\n" +
  "/node status — task đang chờ/đang chạy + reports gần nhất\n" +
  "/node log <id> — xem lại report (reports cũ nhất bị quét đi)";

/** /node task|status|log — the Mac node surface. */
export async function cmdNode(bot: Bot, conv: string, arg: string, uid: number | undefined): Promise<void> {
  try {
    const node = bot.node;
    if (!node) return bot.tg.sendMessage(conv, "Node Mac chưa bật (OPENCODE_TG_NODE_MAC=1).");
    const [sub, ...rest] = (arg ?? "").trim().split(/\s+/);
    if (!sub || sub === "help") return bot.tg.sendMessage(conv, esc(NODE_USAGE), undefined);

    if (sub === "task") {
      let base = "main";
      let i = 0;
      if (rest[0]?.startsWith("base=")) {
        base = rest[0].slice(5).trim();
        if (!base) throw new Error("base= rỗng — dùng base=<branch>");
        i = 1;
      }
      const prompt = rest.slice(i).join(" ").trim();
      if (!prompt) throw new Error("thiếu mô tả task — /node task <mô tả>");
      const task = await node.pushTask(prompt, base, uid ?? "unknown", conv);
      await bot.tg.sendMessage(
        conv,
        `📦 <b>Task ${esc(task.id)}</b> đã vào hàng đợi node Mac (base <code>${esc(base)}</code>).\nDaemon nhận trong ~30s, kết quả tự hiện ở đây.`,
      );
      return;
    }

    if (sub === "status") {
      const { queued, lastReports } = await node.status();
      const lines = ["🖥 <b>Node Mac</b>"];
      for (const q of queued) lines.push(`${q.state === "running" ? "🔧" : "⏳"} ${esc(q.id)} — ${esc(q.base)}`);
      if (!queued.length) lines.push("⏳ hàng đợi trống");
      if (lastReports.length) {
        lines.push("", "<b>Reports gần nhất:</b>");
        for (const r of lastReports) lines.push(`• ${esc(r.id)} — ${esc(r.status)} · $${r.costUsd.toFixed(2)}`);
      }
      await bot.tg.sendMessage(conv, lines.join("\n"));
      return;
    }

    if (sub === "log") {
      const id = rest[0];
      if (!id) throw new Error("thiếu id — /node log <id>");
      const text = await node.report(id);
      if (!text) throw new Error(`không tìm thấy report ${esc(id)}`);
      await bot.tg.sendMessage(conv, esc(text));
      return;
    }

    throw new Error(`lệnh không rõ — ${esc(NODE_USAGE.split("\n")[0])}`);
  } catch (e) {
    await bot.tg.sendMessage(conv, `❌ Lỗi: ${esc((e as Error)?.message ?? String(e))}`);
  }
}
