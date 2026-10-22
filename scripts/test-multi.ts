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
import { newMessageID } from "../src/opencode.js";
import { StateManager } from "../src/state.js";
import { McpBridge } from "../src/mcp-bridge.js";
import { addWorktree, diffSummary, gitRoot, mergeWorktree, removeWorktree } from "../src/worktree.js";
import { Orchestrator, Host } from "../src/orchestrator.js";
import type { Config } from "../src/config.js";

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
  check("worktree keeps the subfolder", wt.directory === join(tmp, "repo.worktrees", "w1", "pkg"), wt.directory);
  check("worktree branch + base", wt.branch === "tg/w1" && wt.base === "main");
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
  const topics: string[] = [];
  const prompts: { sid: string; text: string }[] = [];
  let sessions = 0;
  const tg: any = {
    createForumTopic: async (_chat: number, name: string) => (topics.push(name), 100 + topics.length),
    editForumTopic: async (_conv: string, name: string) => void topics.push(name),
    closeForumTopic: async () => {},
    answerCallbackQuery: async () => {},
    editMessageText: async (_c: unknown, _m: number, text: string) => void sent.push("[edit] " + text),
    deleteMessage: async () => {},
  };
  const oc: any = {
    createSession: async () => `ses_${++sessions}`,
    prompt: async (sid: string, text: string) => (prompts.push({ sid, text }), "msg_x"),
    interrupt: async () => {},
    latestReply: async () => ({ text: "did it\nSUMMARY: ok", time: 5 }),
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
  } as unknown as Config;
  const st = new StateManager(join(tmp, "orch-state.json"));
  let lastKb: any;
  const host: Host = {
    tg,
    oc,
    st,
    cfg,
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
  check("last result is kept for the Manager", /SUMMARY: ok/.test(st.get(r.conv).worker?.lastResult ?? ""));
  const b = await spawn("repo-b", repo, { task: "edit" });
  check("first writer uses the main checkout", !st.get(a.conv).worker?.worktree);
  check("second writer in the same repo gets a worktree", st.get(b.conv).worker?.worktree?.branch === "tg/repo-b", JSON.stringify(st.get(b.conv).worker));
  check("…and runs inside it", st.get(b.conv).directory === join(tmp, "repo.worktrees", "repo-b"));
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
  check("approval card has buttons", JSON.stringify(lastKb).includes("ap:1:ok") && JSON.stringify(lastKb).includes("ap:1:no"));
  await orch.handleCallback({ id: "c1", data: "ap:1:ok" } as any, "42", 9);
  check("approve -> worker spawned", sessions === before + 1 && !!st.findWorker("42", "docs"));
  check("approved plan worker is read-only", st.findWorker("42", "docs")?.[1].worker?.writes === false);
  check("stale approval tap is refused", (await orch.handleCallback({ id: "c2", data: "ap:1:ok" } as any, "42", 9)) && sessions === before + 1);

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

  (orch as any).budget.set("42", 0);
  check("dispatch budget stops runaway loops", await throws(() => tool("spawn_worker").run({ name: "more", directory: root, task: "t" }), /budget/));
  check("list_directories stays inside the roots", await throws(() => tool("list_directories").run({ path: join(tmp, "outside") }), /ngoài vùng/));
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
