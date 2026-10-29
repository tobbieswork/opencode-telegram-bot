/**
 * Checks for the multi-session layer, with no OpenCode service or Telegram:
 * conversation keys, idempotent message ids, the topic-aware state store, the
 * MCP bridge protocol, git worktree isolation (against a throwaway repo), and
 * the Orchestrator's spawn / approval / budget rules against mocks.
 *
 * Run:  npx tsx scripts/test-multi.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convKey, parseConv, chatOf } from "../src/conv.js";
import { newMessageID, OpenCodeCtl } from "../src/opencode.js";
import { StateManager } from "../src/state.js";
import { McpBridge } from "../src/mcp-bridge.js";
import { addWorktree, diffSummary, gitRoot, mergeWorktree, removeWorktree } from "../src/worktree.js";
import { Orchestrator, Host } from "../src/orchestrator.js";
import { BusyNoteStore } from "../src/notes.js";
import { loadConfig, type Config } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
async function throws(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocbot-multi-")));

// ── conversation keys ───────────────────────────────────────────────────────
{
  check("chat-only key is the bare id (old state files still load)", convKey(42) === "42");
  check("topic key", convKey(-1001, 7) === "-1001:7");
  check("parse topic key", JSON.stringify(parseConv("-1001:7")) === JSON.stringify({ chatId: -1001, threadId: 7 }));
  check("parse chat key", parseConv("42").threadId === undefined && parseConv(42).chatId === 42);
  check("chatOf topic", chatOf("-1001:7") === "-1001");
}

// ── idempotent prompt ids ───────────────────────────────────────────────────
{
  const ids = Array.from({ length: 200 }, () => newMessageID());
  check("ids look like OpenCode message ids", ids.every((i) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(i)), ids[0]);
  check("ids are unique", new Set(ids).size === ids.length);
  check("ids sort by creation", ids.every((id, i) => i === 0 || ids[i - 1].slice(4, 16) <= id.slice(4, 16)));
}

// ── topic-aware state ──────────────────────────────────────────────────────
{
  const file = join(tmp, "state.json");
  const st = new StateManager(file);
  st.set("42", { sessionID: "ses_top", manager: true });
  st.set("42:7", { sessionID: "ses_w1", worker: { name: "api", status: "running", spawnedBy: "user", createdAt: 1, updatedAt: 1 } });
  st.set("43:7", { sessionID: "ses_other" });
  check("session index -> topic", st.findChatBySession("ses_w1") === "42:7");
  check("convsOfChat groups a chat's topics", st.convsOfChat("42:9").map(([k]) => k).sort().join(",") === "42,42:7");
  check("findWorker by name", st.findWorker("42", "api")?.[0] === "42:7" && !st.findWorker("43", "api"));
  st.set("42:7", { sessionID: "ses_w2" });
  check("index follows a session switch", st.findChatBySession("ses_w2") === "42:7" && !st.findChatBySession("ses_w1"));
  check("no temp files left by atomic writes", readdirSync(tmp).filter((f) => f.endsWith(".tmp")).length === 0);
  check("reload keeps topics", new StateManager(file).get("42:7").worker?.name === "api");
  check("peek does not create", new StateManager(file).peek("99") === undefined);
}

// ── MCP bridge protocol ─────────────────────────────────────────────────────
{
  let got: any;
  const bridge = new McpBridge((route) =>
    route === "42"
      ? [{ name: "echo", description: "echo", inputSchema: { type: "object" }, run: async (a) => ((got = a), `ECHO:${a.text}`) }]
      : undefined,
  );
  await bridge.listen(0);
  const call = (route: string, body: unknown, auth = `Bearer ${bridge.token}`) =>
    fetch(bridge.url(route), { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const init = await (await call("42", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } })).json();
  check("initialize negotiates a supported version", init.result?.protocolVersion === "2025-06-18" && !!init.result?.capabilities?.tools);
  check("notification -> 202", (await call("42", { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);
  const list = await (await call("42", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  check("tools/list", list.result?.tools?.[0]?.name === "echo");
  const res = await (await call("42", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } })).json();
  check("tools/call runs the tool", res.result?.content?.[0]?.text === "ECHO:hi" && got?.text === "hi");
  const bad = await (await call("42", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } })).json();
  check("unknown tool -> JSON-RPC error", bad.error?.code === -32602);
  check("wrong token -> 401", (await call("42", {}, "Bearer nope")).status === 401);
  check("unknown route (chat without Manager) -> 404", (await call("77", { jsonrpc: "2.0", id: 4, method: "tools/list" })).status === 404);
  check("GET (no server stream) -> 405", (await fetch(bridge.url("42"), { headers: { authorization: `Bearer ${bridge.token}` } })).status === 405);
  bridge.close();
}

// ── git worktrees ───────────────────────────────────────────────────────────
const repo = join(tmp, "repo");
{
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
  mkdirSync(join(repo, "pkg"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "pkg", "a.txt"), "one\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");

  check("gitRoot from a subfolder", (await gitRoot(join(repo, "pkg"))) === repo);
  check("gitRoot outside a repo", (await gitRoot(tmp)) === undefined);
  const wt = await addWorktree(repo, join(repo, "pkg"), "w1");
  check("worktree keeps the subfolder", wt.directory === join(wt.root, "pkg") && wt.root.startsWith(join(tmp, "repo.worktrees", "w1-")), wt.directory);
  check("worktree branch + base", /^tg\/w1-[0-9a-f]{6}$/.test(wt.branch) && wt.base === "main", wt.branch);
  const twin = await addWorktree(repo, repo, "w1");
  check("same worker name twice in one repo gets distinct worktrees", twin.branch !== wt.branch && twin.root !== wt.root);
  await removeWorktree(repo, twin);
  writeFileSync(join(wt.directory, "a.txt"), "one\ntwo\n");
  writeFileSync(join(wt.directory, "new.txt"), "x\n");
  const diff = await diffSummary(wt);
  check("diff shows tracked + untracked changes", /a\.txt/.test(diff) && /new\.txt/.test(diff), diff);

  writeFileSync(join(repo, "dirty.txt"), "x");
  check("merge refuses a dirty main checkout", await throws(() => mergeWorktree(repo, wt, "w1"), /chưa commit/));
  rmSync(join(repo, "dirty.txt"));
  const merged = await mergeWorktree(repo, wt, "w1");
  check("merge commits worker changes and merges", /Đã merge/.test(merged) && g(repo, "show", "HEAD:pkg/new.txt") === "x", merged);
  check("remove deletes worktree and merged branch", /xoá worktree và nhánh/.test(await removeWorktree(repo, wt)));
}

// ── orchestrator (mock Telegram + OpenCode) ─────────────────────────────────
{
  const sent: string[] = [];
  const deletedTopics: string[] = [];
  const closedTopics: string[] = [];
  const removedSessions: string[] = [];
  const topics: string[] = [];
  const prompts: { sid: string; text: string }[] = [];
  const replyOpts: any[] = [];
  let sessions = 0;
  const tg: any = {
    createForumTopic: async (_chat: number, name: string) => (topics.push(name), 100 + topics.length),
    editForumTopic: async (_conv: string, name: string) => void topics.push(name),
    closeForumTopic: async (conv: string) => void closedTopics.push(conv),
    openForumTopic: async () => {},
    answerCallbackQuery: async () => {},
    editMessageText: async (_c: unknown, _m: number, text: string) => void sent.push("[edit] " + text),
    deleteMessage: async () => {},
    deleteForumTopic: async (conv: string) => void deletedTopics.push(conv),
  };
  const oc: any = {
    createSession: async () => `ses_${++sessions}`,
    prompt: async (sid: string, text: string) => (prompts.push({ sid, text }), "msg_x"),
    interrupt: async () => {},
    removeSession: async (sid: string) => void removedSessions.push(sid),
    latestReply: async (_sid: string, _after: number, opts: any) => (replyOpts.push(opts), { text: "did it\nSUMMARY: ok", time: 5 }),
    sessionState: async () => ({ busy: true }),
  };
  const root = join(tmp, "work");
  mkdirSync(join(root, "proj"), { recursive: true });
  mkdirSync(join(tmp, "outside"), { recursive: true });
  symlinkSync(join(tmp, "outside"), join(root, "escape"));
  const cfg = {
    opencodeDirectory: root,
    browseRoots: [root, repo],
    managerDir: join(tmp, "mgr"),
    maxWorkers: 2,
    worktreeMode: "auto",
    bridgePort: 0,
    autoClose: true,
  } as unknown as Config;
  const st = new StateManager(join(tmp, "orch-state.json"));
  let lastKb: any;
  const host: Host = {
    tg,
    oc,
    st,
    cfg,
    busyNotes: new BusyNoteStore(),
    sendHtml: async (_conv, html, opts) => {
      sent.push(html);
      if (opts?.reply_markup) lastKb = opts.reply_markup;
    },
    applyModelAndVariant: async () => {},
    startTyping: () => {},
  };
  const orch = new Orchestrator(host);
  const spawn = (name: string, directory: string, extra: object = {}) =>
    orch.spawn("42", { name, directory, spawnedBy: "user", writes: true, ...extra } as any);

  const r = await spawn("api-fix", join(root, "proj"), { task: "do X" });
  check("spawn opens a topic named with status", topics[0] === "🟢 api-fix" && r.conv === "42:101");
  check("spawn binds a session to the topic", st.get("42:101").sessionID === "ses_1" && st.findChatBySession("ses_1") === "42:101");
  check("task is prompted with the worker preamble", prompts[0]?.sid === "ses_1" && /worker "api-fix"/.test(prompts[0].text) && /do X$/.test(prompts[0].text));
  check("rejects a bad name", await throws(() => spawn("Bad Name!", root), /không hợp lệ/));
  check("rejects a duplicate name", await throws(() => spawn("api-fix", root), /Đã có worker/));
  check("rejects a dir outside the roots", await throws(() => spawn("w2", join(tmp, "outside")), /ngoài vùng/));
  check("rejects a symlink escaping the roots", await throws(() => spawn("w2", join(root, "escape")), /ngoài vùng/));
  check("rejects a missing dir", await throws(() => spawn("w2", join(root, "nope")), /Không tìm thấy/));

  // Two writers in one repo: the second gets its own worktree.
  const a = await spawn("repo-a", repo, { task: "edit" });
  check("max busy workers enforced", await throws(() => spawn("repo-b", repo, { task: "edit" }), /tối đa 2/));
  orch.onExecution(r.conv, "session.execution.succeeded");
  await new Promise((res) => setTimeout(res, 50));
  check("turn end marks the worker done + renames the topic", st.get(r.conv).worker?.status === "done" && topics.includes("✅ api-fix"));
  check("finished worker's topic is auto-closed (autoClose on)", closedTopics.includes(r.conv));
  check("last result is kept for the Manager", /SUMMARY: ok/.test(st.get(r.conv).worker?.lastResult ?? ""));
  const b = await spawn("repo-b", repo, { task: "edit" });
  check("first writer uses the main checkout", !st.get(a.conv).worker?.worktree);
  check("second writer in the same repo gets a worktree", /^tg\/repo-b-/.test(st.get(b.conv).worker?.worktree?.branch ?? ""), JSON.stringify(st.get(b.conv).worker));
  check("…and runs inside it", st.get(b.conv).directory === st.get(b.conv).worker?.worktree?.root);
  check("the turn's reply is read from the last turn only", replyOpts.every((o) => o?.lastTurn === true) && replyOpts.length > 0);
  orch.onWaiting(b.conv);
  check("permission ask -> waiting", st.get(b.conv).worker?.status === "waiting" && topics.includes("🟡 repo-b"));
  orch.onResumed(b.conv);
  check("answered -> running", st.get(b.conv).worker?.status === "running");

  // Manager tools: confirm mode puts a card in front of the user.
  st.set("42", { manager: true, sessionID: "ses_mgr" });
  const tools = (orch as any).toolsFor("42") as { name: string; run: (a: any) => Promise<string> }[];
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  orch.onExecution(a.conv, "session.execution.succeeded");
  orch.onExecution(b.conv, "session.execution.succeeded");
  await new Promise((res) => setTimeout(res, 50));
  const before = sessions;
  const pending = await tool("spawn_worker").run({ name: "docs", directory: root, task: "write docs", agent: "plan" });
  check("confirm mode: spawn waits for approval", /^PENDING/.test(pending) && sessions === before);
  const okBtn = JSON.stringify(lastKb).match(/ap:([0-9a-f]+):ok/);
  check("approval card has buttons with a random id", !!okBtn && okBtn[1].length === 10 && JSON.stringify(lastKb).includes(`ap:${okBtn?.[1]}:no`));
  check("a card tapped from another chat is refused", (await orch.handleCallback({ id: "c0", data: okBtn![0] } as any, "77", 9)) && sessions === before);
  await orch.handleCallback({ id: "c1", data: okBtn![0] } as any, "42:5", 9);
  check("approve -> worker spawned", sessions === before + 1 && !!st.findWorker("42", "docs"));
  check("approved plan worker is read-only", st.findWorker("42", "docs")?.[1].worker?.writes === false);
  check("stale approval tap is refused", (await orch.handleCallback({ id: "c2", data: okBtn![0] } as any, "42", 9)) && sessions === before + 1);
  check("an old card's id (pre-restart counter) matches nothing", (await orch.handleCallback({ id: "c3", data: "ap:1:ok" } as any, "42", 9)) && /hết hạn/.test(sent.join("\n") + ""));

  st.set("42", { auto: true });
  const auto = await tool("send_to_worker").run({ name: "api-fix", message: "also do Y" });
  check("auto mode: send goes straight through", /^Sent/.test(auto) && prompts.at(-1)?.text === "also do Y");
  check("send to a busy worker is refused", await throws(() => tool("send_to_worker").run({ name: "api-fix", message: "z" }), /running/));
  check("list_workers summarises", /api-fix — running/.test(await tool("list_workers").run({})));
  check("unknown worker is a clear error", await throws(() => tool("get_worker_result").run({ name: "ghost" }), /No worker named/));

  // /manager on: OpenCode connects to the bridge the moment it is registered
  // (before the chat is marked as having a Manager) — that first call must work.
  {
    let firstCall = 0;
    oc.addRemoteMcp = async (_dir: string, _name: string, url: string, headers: Record<string, string>) => {
      const r = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      firstCall = r.status;
    };
    oc.mcpStatus = async () => ({ status: firstCall === 200 ? "connected" : "failed" });
    oc.createSession = async () => "ses_mgr2";
    st.set("55", {});
    await orch.handleCommand("55", "/manager", "on");
    check("bridge answers OpenCode's first connect during /manager on", firstCall === 200, `HTTP ${firstCall}`);
    check("manager turned on", st.get("55").manager === true && st.get("55").sessionID === "ses_mgr2");
    oc.mcpStatus = async () => ({ status: "failed", error: "HTTP 404" });
    st.set("56", {});
    await orch.handleCommand("56", "/manager", "on");
    check("a bridge that fails to connect is reported, not silently ignored", !st.get("56").manager && /HTTP 404/.test(sent.at(-1) ?? ""), sent.at(-1));
  }

  // #5: an approved/auto send can't start a second turn or exceed the limit.
  {
    const conv = st.findWorker("42", "api-fix")![0];
    check("send to a busy worker is refused even when approved", await throws(() => (orch as any).sendToWorker(conv, "again"), /đang running/));
    for (const [k] of st.convsOfChat("42").filter(([, x]) => x.worker)) (orch as any).setStatus(k, "done");
    const busyNames = ["docs", "repo-a"].map((n) => st.findWorker("42", n)![0]);
    for (const k of busyNames) (orch as any).setStatus(k, "running"); // 2 busy = the limit
    check("send to an idle worker respects the busy limit", await throws(() => (orch as any).sendToWorker(conv, "again"), /tối đa 2/));
    for (const k of busyNames) (orch as any).setStatus(k, "done");
  }

  // #4: /kill must not be reported to the Manager as a finished turn.
  {
    const conv = st.findWorker("42", "api-fix")![0];
    (orch as any).setStatus(conv, "running");
    oc.interrupt = async () => orch.onExecution(conv, "session.execution.interrupted"); // event fires mid-call
    (orch as any).reports.delete("42");
    await (orch as any).stopWorker(conv, false);
    await new Promise((res) => setTimeout(res, 50));
    check("killed worker is stopped", st.get(conv).worker?.status === "stopped");
    check("…and not reported to the Manager", !(orch as any).reports.get("42")?.some((r: string) => /api-fix/.test(r)));
    oc.interrupt = async () => {};
  }

  // #1: a worker whose turn ended while nobody was listening gets settled.
  {
    const conv = st.findWorker("42", "docs")![0];
    (orch as any).setStatus(conv, "running");
    await orch.healWorkers();
    check("still-busy session stays running", st.get(conv).worker?.status === "running");
    oc.sessionState = async () => ({ busy: false, outcome: "succeeded" });
    await orch.healWorkers();
    check("idle session heals a stuck 'running' worker to done", st.get(conv).worker?.status === "done");
    oc.sessionState = async () => ({ busy: true });
  }

  // #3: concurrent spawns can't race past the name check or the busy limit.
  {
    for (const [k] of st.convsOfChat("42").filter(([, x]) => x.worker)) (orch as any).setStatus(k, "done");
    const slow = oc.createSession;
    oc.createSession = async () => (await new Promise((r) => setTimeout(r, 30)), `ses_${++sessions}`);
    const same = await Promise.allSettled([spawn("twin", root), spawn("twin", root)]);
    check("same name spawned twice at once -> exactly one", same.filter((r) => r.status === "fulfilled").length === 1);
    const many = await Promise.allSettled(["p1", "p2", "p3", "p4"].map((n) => spawn(n, root, { task: "t" })));
    check("parallel spawns respect the busy limit", many.filter((r) => r.status === "fulfilled").length === 2, JSON.stringify(many.map((r) => r.status)));
    oc.createSession = slow;
    for (const [k] of st.convsOfChat("42").filter(([, x]) => x.worker)) (orch as any).setStatus(k, "done");
  }

  // Lượt chạy lịch và worker thường phải tranh cùng giới hạn theo chat chính.
  {
    const execution = orch.scheduledExecution();
    const sch = { id: "slot", conv: "42:77", prompt: "Kiểm tra", dir: root, agent: "plan",
      spec: { kind: "daily" as const, time: { h: 9, m: 0 } }, tz: "UTC", nextRunAt: Date.now(), enabled: true,
      createdBy: 1, createdAt: 1 };
    const lease = { id: "scheduled-slot", schedule: sch, mode: "manual" as const, messageID: "msg_slot",
      admittedAt: Date.now(), deadline: Date.now() + 60_000, phase: "preparing" as const };
    execution.claim(sch, lease.id);
    await spawn("slot-peer", root, { task: "Kiểm tra" });
    check("lịch trong topic và worker thường dùng chung capacity của chat", await throws(
      () => spawn("slot-over", root, { task: "Kiểm tra" }), /tối đa 2/));
    check("lượt lịch thứ hai không chiếm slot đang được giữ", await throws(async () => {
      execution.claim({ ...sch, id: "more" }, "another-slot");
    }, /tối đa 2/));
    execution.release(lease);
    check("nhả reservation lịch mở đúng một slot cho worker thường", !!(await spawn("slot-after", root, { task: "Kiểm tra" })).conv);
    await orch.handleCommand("42", "/kill", "slot-peer");
    await orch.handleCommand("42", "/kill", "slot-after");
  }

  // #7: a failed session create leaves no topic, no worktree, and the name free.
  {
    const ok = oc.createSession;
    oc.createSession = async () => {
      throw new Error("Transport: fetch failed");
    };
    const n = deletedTopics.length;
    check("session create failure is reported", await throws(() => spawn("flaky", root), /fetch failed/));
    check("…the orphan topic is deleted", deletedTopics.length === n + 1);
    oc.createSession = ok;
    check("…and the name can be used again", !!(await spawn("flaky", root)).conv);
  }

  (orch as any).budget.set("42", 0);
  check("dispatch budget stops runaway loops", await throws(() => tool("spawn_worker").run({ name: "more", directory: root, task: "t" }), /budget/));
  check("list_directories stays inside the roots", await throws(() => tool("list_directories").run({ path: join(tmp, "outside") }), /ngoài vùng/));

  // /prune: only FINISHED workers older than the cutoff are offered; busy and
  // fresh ones survive. Confirming deletes topic + session + state entry.
  {
    const now = Date.now();
    const DAY = 86_400_000;
    const doneOld = st.findWorker("42", "api-fix")![0];
    st.set(doneOld, { worker: { ...st.get(doneOld).worker!, status: "done", updatedAt: now - 8 * DAY } });
    const freshDone = st.findWorker("42", "flaky")![0];
    (orch as any).setStatus(freshDone, "done"); // finished, but recent (updatedAt = now)
    const busyOld = st.findWorker("42", "twin")![0];
    // done + old → it goes into the prune list; we flip it back to "running"
    // right before confirming to prove the confirm step skips busy workers.
    st.set(busyOld, { worker: { ...st.get(busyOld).worker!, status: "done", updatedAt: now - 30 * DAY } });
    await orch.handleCommand("42", "/prune", "");
    const pruneBtn = JSON.stringify(lastKb).match(/prune:([0-9a-f]+)/);
    check(
      "prune card lists the old finished workers, not the fresh one",
      !!pruneBtn && /api-fix/.test(sent.at(-1) ?? "") && !/flaky/.test(sent.at(-1) ?? ""),
      sent.at(-1),
    );
    await orch.handleCommand(doneOld, "/prune", "");
    check("prune is refused inside a topic", /khung chat chính/.test(sent.at(-1) ?? ""), sent.at(-1));
    const ses = st.get(doneOld).sessionID;
    // Between showing the card and the user confirming, twin starts a new turn:
    (orch as any).setStatus(busyOld, "running");
    await orch.handleCallback({ id: "p0", data: pruneBtn![0] } as any, "42", 9);
    check("prune deletes the topic", deletedTopics.includes(doneOld));
    check("prune retires the worker session", removedSessions.includes(ses ?? ""));
    check("prune clears the state entry", st.peek(doneOld) === undefined);
    check("…and skips a worker that went busy again", st.get(busyOld).worker?.status === "running" && !deletedTopics.includes(busyOld) && /bỏ qua 1/.test(sent.at(-1) ?? ""), sent.at(-1));
    check("fresh finished worker is kept", !!st.peek(freshDone)?.worker);
    await orch.handleCommand("42", "/prune", "7");
    check("second /prune finds nothing left", /Không có topic worker cũ nào/.test(sent.at(-1) ?? ""), sent.at(-1));
    lastKb = undefined;
    await orch.handleCommand("42", "/prune", "1");
    check("/prune 1 day: api-fix gone, flaky (0d old) not prunable → no card", lastKb === undefined, JSON.stringify(lastKb));
    await orch.handleCommand("42", "/prune", "abc");
    check("invalid day arg falls back to the default (no candidates)", /Không có topic worker cũ nào/.test(sent.at(-1) ?? ""), sent.at(-1));
  }
}

// ── #9: removing a worktree retires the session that lived in it ────────────
{
  const sent: string[] = [];
  const st = new StateManager(join(tmp, "wt-state.json"));
  const host: Host = {
    tg: { answerCallbackQuery: async () => {}, editMessageText: async () => {}, editForumTopic: async () => {} } as any,
    oc: {} as any,
    st,
    cfg: { browseRoots: [repo], managerDir: join(tmp, "mgr"), maxWorkers: 2, worktreeMode: "auto" } as any,
    busyNotes: new BusyNoteStore(),
    sendHtml: async (_c, html) => void sent.push(html),
    applyModelAndVariant: async () => {},
    startTyping: () => {},
  };
  const orch = new Orchestrator(host);
  const wt = await addWorktree(repo, join(repo, "pkg"), "gone");
  st.set("9:1", {
    sessionID: "ses_wt",
    directory: wt.directory,
    worker: { name: "gone", status: "done", spawnedBy: "user", writes: true, repoRoot: repo, worktree: { root: wt.root, branch: wt.branch, base: wt.base }, createdAt: 1, updatedAt: 1 },
  });
  await orch.handleCallback({ id: "w", data: "wt:gone:rmok" } as any, "9:1", 3);
  const after = st.get("9:1");
  check("worktree removed -> session retired", after.sessionID === undefined && after.worker?.status === "stopped" && !after.worker?.worktree);
  check("…topic points back at the main checkout subfolder", after.directory === join(repo, "pkg"), after.directory);
}

// ── #6 + #1: OpenCode helpers (real logic, stubbed transport) ───────────────
{
  const oc = new OpenCodeCtl() as any;
  oc.listMessages = async () => [
    { type: "assistant", time: { created: 30 }, content: [{ type: "tool" }] },
    { type: "user", time: { created: 20 } },
    { type: "assistant", time: { created: 10 }, content: [{ type: "text", text: "OLD ANSWER" }] },
  ];
  check("latestReply(lastTurn) ignores the previous turn's answer", (await oc.latestReply("s", 0, { lastTurn: true })) === undefined);
  check("latestReply without lastTurn still finds it", (await oc.latestReply("s"))?.text === "OLD ANSWER");
  oc.getSession = async () => ({ outcome: "succeeded", time: { updated: 100, idle: 90 } });
  check("session updated after idle = busy (outcome is stale)", JSON.stringify(await oc.sessionState("s")) === JSON.stringify({ busy: true }));
  oc.getSession = async () => ({ outcome: "failed", time: { updated: 100, idle: 104 } });
  check("idle caught up = finished, with its outcome", (await oc.sessionState("s")).outcome === "failed");
  oc.getSession = async () => ({ time: { updated: 100 } });
  check("never ran = busy (not settled)", (await oc.sessionState("s")).busy === true);
}

// ── #10: limits are never silently disabled by a typo ──────────────────────
{
  process.env.TELEGRAM_BOT_TOKEN = "x";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.OPENCODE_TG_MAX_WORKERS = "five";
  process.env.OPENCODE_TG_BRIDGE_PORT = "80a";
  const c = loadConfig(tmp);
  check("non-numeric OPENCODE_TG_MAX_WORKERS falls back to 5", c.maxWorkers === 5);
  check("non-numeric bridge port falls back to random", c.bridgePort === 0);
  process.env.OPENCODE_TG_MAX_WORKERS = "0";
  check("a limit of 0 falls back too", loadConfig(tmp).maxWorkers === 5);
  process.env.OPENCODE_TG_MAX_WORKERS = "3";
  check("a valid value is kept", loadConfig(tmp).maxWorkers === 3);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
