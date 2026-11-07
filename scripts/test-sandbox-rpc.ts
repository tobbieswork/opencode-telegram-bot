/**
 * Unit tests for src/sandbox/ — the Zero-Context-Workers RPC endpoint
 * (tool allowlist, path confinement, exec validation) and the HTTP server.
 *
 * Run:  npx tsx scripts/test-sandbox-rpc.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_ALLOWLIST, validateTool, validatePath, validateExec } from "../src/sandbox/allowlist.js";
import { startRpcServer, stopRpcServer } from "../src/sandbox/rpc-server.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-rpc-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-rpc-outside-"));
const wt = path.join(tmp, "worktree");
fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
fs.writeFileSync(path.join(wt, "a.txt"), "hello world\nsecond line\n");
fs.writeFileSync(path.join(wt, "sub", "b.txt"), "nested file\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(wt, "escape-link")); // symlink escape

// ── validateTool ─────────────────────────────────────────────────────────────
{
  check("validateTool('read_file') → true", validateTool("read_file") === true);
  check("validateTool('exec') → true", validateTool("exec") === true);
  check("validateTool('spawn_worker') → false", validateTool("spawn_worker") === false);
  check("validateTool('') → false", validateTool("") === false);
  check("every allowlist entry validates", TOOL_ALLOWLIST.every((t) => validateTool(t)));
  check("allowlist has exactly 5 tools", TOOL_ALLOWLIST.length === 5, JSON.stringify(TOOL_ALLOWLIST));
}

// ── validatePath ─────────────────────────────────────────────────────────────
{
  check("relative path inside worktree → true", validatePath("a.txt", wt) === true);
  check("nested relative path → true", validatePath("sub/b.txt", wt) === true);
  check("dot-dot that stays inside → true", validatePath("sub/../a.txt", wt) === true);
  check("not-yet-existing file inside → true", validatePath("sub/new-file.txt", wt) === true);
  check("../../etc/passwd → false", validatePath("../../etc/passwd", wt) === false);
  check("deep ../ escape → false", validatePath("../../../../etc/passwd", wt) === false);
  check("absolute path outside → false", validatePath("/etc/passwd", wt) === false);
  check("absolute outside sibling → false", validatePath(path.join(outside, "secret.txt"), wt) === false);
  check("absolute not-existing outside → false", validatePath(path.join(outside, "does-not-exist"), wt) === false);
  check("symlink pointing outside → false", validatePath("escape-link", wt) === false);
  check("absolute path inside worktree → true", validatePath(path.join(wt, "a.txt"), wt) === true);
  check("empty path → false", validatePath("", wt) === false);
}

// ── validateExec ─────────────────────────────────────────────────────────────
{
  check("'ls -la' → true", validateExec("ls -la") === true);
  check("'echo hello world' → true", validateExec("echo hello world") === true);
  check("'ls; rm -rf /' → false", validateExec("ls; rm -rf /") === false);
  check("'echo $(whoami)' → false", validateExec("echo $(whoami)") === false);
  check("'ls | grep x' → false", validateExec("ls | grep x") === false);
  check("'ls && who' → false", validateExec("ls && who") === false);
  check("'ls || who' → false", validateExec("ls || who") === false);
  check("'echo hi > f' → false", validateExec("echo hi > f") === false);
  check("'cat < f' → false", validateExec("cat < f") === false);
  check("backtick command → false", validateExec("ls `whoami`") === false);
  check("'ls & sleep 1' → false", validateExec("ls & sleep 1") === false);
  check("empty command → false", validateExec("") === false);
}

// ── RPC server ───────────────────────────────────────────────────────────────
{
  const { port, stop } = await startRpcServer("test-token", wt);
  check("server bound (port > 0)", port > 0, `port ${port}`);
  const base = `http://127.0.0.1:${port}`;

  async function rpc(body: unknown, token = "test-token"): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* 401/405 have empty bodies */
    }
    return { status: res.status, json: parsed };
  }

  // valid read_file
  let r = await rpc({ tool: "read_file", params: { path: "a.txt" } });
  check("read_file valid path → 200", r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`);
  check("read_file returns content", r.json?.content === "hello world\nsecond line\n", JSON.stringify(r.json?.content));

  // write_file + read back
  r = await rpc({ tool: "write_file", params: { path: "sub/out.txt", content: "written\n" } });
  check("write_file → 200 ok:true", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  r = await rpc({ tool: "read_file", params: { path: "sub/out.txt" } });
  check("written file reads back", r.json?.content === "written\n", JSON.stringify(r.json?.content));

  // grep
  r = await rpc({ tool: "grep", params: { pattern: "hello", path: "a.txt" } });
  check("grep → 200 with 1 match", r.status === 200 && r.json?.matches?.length === 1, JSON.stringify(r.json));
  check("grep match contains pattern", String(r.json?.matches?.[0] ?? "").includes("hello"), JSON.stringify(r.json?.matches));

  // glob
  r = await rpc({ tool: "glob", params: { pattern: "*.txt", path: "." } });
  const files: string[] = r.json?.files ?? [];
  check("glob → 200", r.status === 200, `status ${r.status}`);
  check("glob finds a.txt and sub/b.txt", files.includes(path.join(wt, "a.txt")) && files.includes(path.join(wt, "sub", "b.txt")), JSON.stringify(files));

  // exec (valid)
  r = await rpc({ tool: "exec", params: { cmd: "echo sandbox-ok", cwd: "." } });
  check("exec valid cmd → 200", r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`);
  check("exec returns stdout", String(r.json?.stdout ?? "").includes("sandbox-ok"), JSON.stringify(r.json));

  // non-whitelisted tool → 403
  r = await rpc({ tool: "spawn_worker", params: {} });
  check("non-whitelisted tool → 403", r.status === 403, `status ${r.status}`);
  check("403 carries error string", typeof r.json?.error === "string", JSON.stringify(r.json));

  // path escape → 403
  r = await rpc({ tool: "read_file", params: { path: "../../../../etc/passwd" } });
  check("read_file path escape → 403", r.status === 403, `status ${r.status}`);
  r = await rpc({ tool: "read_file", params: { path: "escape-link" } });
  check("read_file symlink escape → 403", r.status === 403, `status ${r.status}`);
  r = await rpc({ tool: "write_file", params: { path: "../outside-write.txt", content: "x" } });
  check("write_file path escape → 403", r.status === 403, `status ${r.status}`);
  check("escape write did NOT happen", !fs.existsSync(path.join(tmp, "outside-write.txt")));

  // exec with metacharacters → 403
  r = await rpc({ tool: "exec", params: { cmd: "ls; rm -rf /", cwd: "." } });
  check("exec with metacharacters → 403", r.status === 403, `status ${r.status}`);
  r = await rpc({ tool: "exec", params: { cmd: "echo $(whoami)" } });
  check("exec with $() → 403", r.status === 403, `status ${r.status}`);
  r = await rpc({ tool: "exec", params: { cmd: "ls", cwd: "../.." } });
  check("exec cwd outside worktree → 403", r.status === 403, `status ${r.status}`);

  // wrong token → 401
  r = await rpc({ tool: "read_file", params: { path: "a.txt" } }, "wrong-token");
  check("wrong token → 401", r.status === 401, `status ${r.status}`);
  r = await rpc({ tool: "read_file", params: { path: "a.txt" } }, "");
  check("missing token → 401", r.status === 401, `status ${r.status}`);

  // malformed body → 400
  const bad = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: "{not json",
  });
  check("malformed JSON → 400", bad.status === 400, `status ${bad.status}`);

  // non-POST → 405, unknown path → 404
  const get = await fetch(`${base}/rpc`, { headers: { authorization: "Bearer test-token" } });
  check("GET /rpc → 405", get.status === 405, `status ${get.status}`);
  const nf = await fetch(`${base}/other`, { headers: { authorization: "Bearer test-token" } });
  check("unknown path → 404", nf.status === 404, `status ${nf.status}`);

  stop();
  stopRpcServer();
}

// ── cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll sandbox RPC checks passed.");
