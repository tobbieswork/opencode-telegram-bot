/**
 * Unit tests for the `run_script` MCP tool (src/mcp-bridge.ts makeRunScriptTool),
 * the final wiring that makes the zero-context script sandbox
 * (src/sandbox/runner.ts) callable over the MCP bridge.
 *
 * Verifies: tools/list schema, success, rpc() file access, path-escape and
 * non-whitelisted-tool rejection, blocked globals, worktree resolution
 * (explicit / default / cwd), and the timeout path (short 2s timeout).
 *
 * Run:  npx tsx scripts/test-mcp-runscript.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpBridge, makeRunScriptTool } from "../src/mcp-bridge.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runscript-"));
const wt = path.join(tmp, "worktree");
fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
fs.writeFileSync(path.join(wt, "test.txt"), "needle in a line\nsecond line\n");

// Route "42": default worktree -> wt (default 60s timeout).
// Route "43": short timeout (2s) + safety (4s), for the timeout path.
// Route "44": no injected defaultWorktree -> resolves to process.cwd().
const bridge = new McpBridge((route) => {
  if (route === "42") return [makeRunScriptTool({ defaultWorktree: wt })];
  if (route === "43") return [makeRunScriptTool({ timeoutMs: 2000, safetyMs: 4000, defaultWorktree: wt })];
  if (route === "44") return [makeRunScriptTool()];
  return undefined;
});
await bridge.listen(0);
const call = (route: string, body: unknown) =>
  fetch(bridge.url(route), {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const run = async (route: string, args: Record<string, unknown>, id = 1) => {
  const res = await (
    await call(route, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "run_script", arguments: args } })
  ).json();
  return res.result;
};

// ── tools/list: run_script present with the correct schema ─────────────────────
{
  const list = await (await call("42", { jsonrpc: "2.0", id: 0, method: "tools/list" })).json();
  const tools = (list.result?.tools ?? []) as any[];
  const t = tools.find((x) => x.name === "run_script");
  check("tools/list includes run_script", !!t, JSON.stringify(tools.map((x) => x.name)));
  check(
    "schema: code is a required string",
    t?.inputSchema?.required?.includes("code") === true && t?.inputSchema?.properties?.code?.type === "string",
    JSON.stringify(t?.inputSchema),
  );
  check(
    "schema: worktree is an optional string",
    t?.inputSchema?.properties?.worktree?.type === "string" && !t?.inputSchema?.required?.includes("worktree"),
    JSON.stringify(t?.inputSchema),
  );
  check("schema: description is a non-empty string", typeof t?.description === "string" && (t?.description?.length ?? 0) > 0);
}

// ── success: return 'hello' (no worktree arg -> default worktree) ──────────────
{
  const r = await run("42", { code: "return 'hello';" });
  check("success: returns 'hello'", r?.content?.[0]?.text === "hello" && r?.isError !== true, JSON.stringify(r));
}

// ── rpc read_file via the default worktree ─────────────────────────────────────
{
  const r = await run("42", { code: 'const f = await rpc("read_file", { path: "test.txt" }); return f.content;' });
  check(
    "rpc read_file: returns file content (default worktree)",
    r?.content?.[0]?.text === "needle in a line\nsecond line\n" && r?.isError !== true,
    JSON.stringify(r),
  );
}

// ── explicit absolute worktree arg ─────────────────────────────────────────────
{
  const r = await run("42", { code: 'return (await rpc("read_file", { path: "test.txt" })).content;', worktree: wt });
  check("explicit worktree: read works", r?.content?.[0]?.text === "needle in a line\nsecond line\n", JSON.stringify(r));
}

// ── write_file via rpc (proves the sandbox can write inside the worktree) ─────
{
  const r = await run("42", { code: 'await rpc("write_file", { path: "sub/out.txt", content: "via-mcp" }); return "wrote";' });
  check("rpc write_file: returns", r?.content?.[0]?.text === "wrote" && r?.isError !== true, JSON.stringify(r));
  check("rpc write_file: file exists on disk", fs.readFileSync(path.join(wt, "sub", "out.txt"), "utf8") === "via-mcp");
}

// ── path escape rejected ───────────────────────────────────────────────────────
{
  const r = await run("42", { code: 'await rpc("read_file", { path: "../../etc/passwd" }); return "should not reach";' });
  check("path escape: isError", r?.isError === true, JSON.stringify(r));
  check("path escape: names the worktree guard", /outside the worktree/.test(r?.content?.[0]?.text ?? ""), JSON.stringify(r));
  check("path escape: text prefixed 'Script failed:'", (r?.content?.[0]?.text ?? "").startsWith("Script failed:"), JSON.stringify(r));
}

// ── non-whitelisted tool rejected ──────────────────────────────────────────────
{
  const r = await run("42", { code: 'await rpc("spawn_worker", {}); return "nope";' });
  check("non-whitelisted tool: isError", r?.isError === true, JSON.stringify(r));
  check("non-whitelisted tool: 'not allowed'", /not allowed/.test(r?.content?.[0]?.text ?? ""), JSON.stringify(r));
}

// ── blocked global (require) rejected ──────────────────────────────────────────
{
  const r = await run("42", { code: "return require('fs');" });
  check("require blocked: isError", r?.isError === true, JSON.stringify(r));
  check("require blocked: names require", /require/.test(r?.content?.[0]?.text ?? ""), JSON.stringify(r));
}

// ── invalid worktree / code args ───────────────────────────────────────────────
{
  const rel = await run("42", { code: "return 'x';", worktree: "relative/path" });
  check("relative worktree: isError", rel?.isError === true, JSON.stringify(rel));
  check("relative worktree: 'absolute path' message", /absolute path/.test(rel?.content?.[0]?.text ?? ""), JSON.stringify(rel));

  const missing = await run("42", { code: "return 'x';", worktree: path.join(tmp, "does-not-exist") });
  check("nonexistent worktree: isError", missing?.isError === true, JSON.stringify(missing));
  check(
    "nonexistent worktree: 'not an existing directory'",
    /not an existing directory/.test(missing?.content?.[0]?.text ?? ""),
    JSON.stringify(missing),
  );

  const noCode = await run("42", { code: "" });
  check("empty code: isError", noCode?.isError === true, JSON.stringify(noCode));
}

// ── no worktree + no default -> error (not process.cwd()) ────────────────────
{
  // Route "44" has no injected defaultWorktree, so omitting worktree is an error.
  const r = await run("44", { code: "return 'ok';" });
  check("no worktree + no default -> error", r?.isError === true && (r?.content?.[0]?.text ?? "").includes("worktree is required"), JSON.stringify(r));
}

// ── timeout (short 2s timeout via route "43") ─────────────────────────────────
{
  const r = await run("43", { code: "await new Promise((resolve) => setTimeout(resolve, 120000)); return 'unreachable';" });
  check("timeout: isError", r?.isError === true, JSON.stringify(r));
  check("timeout: text is the timeout message", /timed out after \d+(\.\d+)?s/i.test(r?.content?.[0]?.text ?? ""), JSON.stringify(r));
  check("timeout: script result not returned", r?.content?.[0]?.text !== "unreachable", JSON.stringify(r));
}

// ── cleanup ─────────────────────────────────────────────────────────────────────
bridge.close();
fs.rmSync(tmp, { recursive: true, force: true });
check("temp files removed", !fs.existsSync(tmp));

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll run_script MCP checks passed.");
