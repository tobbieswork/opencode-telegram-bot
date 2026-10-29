/**
 * Integration test for the hub side of the Mac node (src/node/mac-node.ts):
 * a real git origin (bare, in /tmp) + a scripted "daemon" clone prove the
 * full round-trip — seed, queue, claim, done, relay, collect, status, and
 * restart idempotency (no double relay).
 *
 * Run:  npx tsx scripts/test-node-io.ts
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacNode } from "../src/node/mac-node.js";
import { buildDoneFile, NODE_BRANCH, type NodeDone } from "../src/node/node-github.js";

function git(dir: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", dir, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim()));
      else ok(stdout.trim());
    });
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const ID = { name: "test", email: "test@test" };

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "node-io-"));
  try {
    // ── origin + working repo ───────────────────────────────────────────────
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    await git(root, ["init", "-q", "--bare", origin]);
    await git(root, ["clone", "-q", origin, work]);
    for (const d of [work]) {
      await git(d, ["config", "user.name", ID.name]);
      await git(d, ["config", "user.email", ID.email]);
    }
    await writeFile(join(work, "README.md"), "repo\n", "utf8");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-q", "-m", "init"]);
    await git(work, ["push", "-q", "origin", "HEAD"]);

    // ── hub node ────────────────────────────────────────────────────────────
    const cloneDir = join(root, "clone");
    const relayed: { done: NodeDone; conv: string }[] = [];
    const node = new MacNode({
      dir: cloneDir,
      repoDir: work,
      pollMs: 3600_000, // never tick during the test; pollOnce() drives it
      now: () => Date.now(),
      relay: (done, conv) => relayed.push({ done, conv }),
    });

    // 1. first task seeds the branch
    const task = await node.pushTask("Chạy typecheck rồi báo kết quả", "main", 42, "test-conv");
    check("task id format", /^nmac-[0-9a-z]{4}$/.test(task.id));
    const refs = await git(work, ["ls-remote", "--heads", origin]);
    check("node/mac branch seeded", refs.includes(NODE_BRANCH));
    const queuedFiles = (await git(cloneDir, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n");
    check("task file on branch", queuedFiles.includes(`tasks/${task.id}.md`));

    // 2. daemon side: clone the branch, claim, then file a done report
    const daemon = join(root, "daemon");
    await git(root, ["clone", "-q", "--branch", NODE_BRANCH, "--single-branch", origin, daemon]);
    await git(daemon, ["config", "user.name", ID.name]);
    await git(daemon, ["config", "user.email", ID.email]);
    mkdirSync(join(daemon, "claims"), { recursive: true });
    await writeFile(join(daemon, `claims/${task.id}.lock`), String(Date.now()), "utf8");
    await git(daemon, ["add", "-A"]);
    await git(daemon, ["commit", "-q", "-m", `node: claim ${task.id}`]);
    await git(daemon, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH]);

    const done: NodeDone = {
      id: task.id,
      status: "done",
      costUsd: 0.12,
      tokensIn: 12345,
      tokensOut: 678,
      durationMs: 45_000,
      sessionId: "sess-1",
      report: "All green.\n\n- typecheck passed",
    };
    mkdirSync(join(daemon, "done"), { recursive: true });
    await writeFile(join(daemon, `done/${task.id}.md`), buildDoneFile(done), "utf8");
    await rm(join(daemon, `claims/${task.id}.lock`));
    await git(daemon, ["add", "-A"]);
    await git(daemon, ["commit", "-q", "-m", `node: done ${task.id}`]);
    await git(daemon, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH]);

    // 3. hub polls: relay + collect
    await node.pollOnce();
    check("relay fired exactly once", relayed.length === 1, `got ${relayed.length}`);
    check("relay conv", relayed[0]?.conv === "test-conv");
    check("relay report body", relayed[0]?.done.report === done.report);
    check("relay cost", relayed[0]?.done.costUsd === 0.12);

    await git(work, ["fetch", "-q", "origin", NODE_BRANCH]);
    const branchFiles = (await git(work, ["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).split("\n");
    check("branch collected (no task/claim/done)", !branchFiles.some((f) => f.includes(task.id)), branchFiles.join(" "));

    const copy = join(root, "data", "reports", `${task.id}.md`);
    check("local report copy kept", existsSync(copy));
    const copyText = await readFile(copy, "utf8").catch(() => "");
    check("local copy is the done file", copyText === buildDoneFile(done));

    // 4. status + report
    const st = await node.status();
    check("queue empty after collect", st.queued.length === 0);
    check("lastReports has the task", st.lastReports[0]?.id === task.id && st.lastReports[0]?.status === "done");
    const rep = await node.report(task.id);
    check("report() readable", (rep ?? "").includes("All green."));
    check("report() missing id → null", (await node.report("nmac-none")) === null);

    // 5. restart idempotency: a done file reappears without a relay duplicate
    //    (simulates a crash after relay+copy but before collect).
    await git(daemon, ["pull", "-q", "--rebase", "origin", NODE_BRANCH]);
    mkdirSync(join(daemon, "done"), { recursive: true });
    await writeFile(join(daemon, `done/${task.id}.md`), buildDoneFile(done), "utf8");
    await git(daemon, ["add", "-A"]);
    await git(daemon, ["commit", "-q", "-m", `node: redeliver ${task.id}`]);
    await git(daemon, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH]);
    await node.pollOnce();
    check("no double relay on redelivery", relayed.length === 1, `got ${relayed.length}`);
    await git(work, ["fetch", "-q", "origin", NODE_BRANCH]);
    const afterRedeliver = (await git(work, ["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).split("\n");
    check("redelivered done collected", !afterRedeliver.some((f) => f.includes(task.id)));

    // 6. concurrency: a hub push rebases over a daemon push
    const t2 = await node.pushTask("task hai", "main", 42, "test-conv");
    await git(daemon, ["pull", "-q", "--rebase", "origin", NODE_BRANCH]);
    await writeFile(join(daemon, `claims/${t2.id}.lock`), "x", "utf8");
    await git(daemon, ["add", "-A"]);
    await git(daemon, ["commit", "-q", "-m", `node: claim ${t2.id}`]);
    await git(daemon, ["push", "-q", "origin", "HEAD:refs/heads/" + NODE_BRANCH]);
    const t3 = await node.pushTask("task ba", "main", 42, "test-conv");
    await git(work, ["fetch", "-q", "origin", NODE_BRANCH]);
    const finalFiles = (await git(work, ["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).split("\n");
    check("both tasks survived rebase", finalFiles.includes(`tasks/${t2.id}.md`) && finalFiles.includes(`tasks/${t3.id}.md`), finalFiles.join(" "));

    node.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => {
    if (failures) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nnode hub io: all checks passed");
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
