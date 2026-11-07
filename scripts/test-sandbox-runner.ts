/**
 * Unit tests for src/sandbox/runner.ts — the Zero-Context-Workers script
 * sandbox (worker_threads isolation, rpc() execution, timeout, blocked globals).
 *
 * Run:  npx tsx scripts/test-sandbox-runner.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript } from "../src/sandbox/runner.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-runner-"));
const wt = path.join(tmp, "worktree");
fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
fs.writeFileSync(path.join(wt, "test.txt"), "needle in a line\nsecond line\n");

// ── basic ───────────────────────────────────────────────────────────────────────
{
  const r = await runScript("return 'hello';", { worktree: wt });
  check("basic: returns 'hello'", r.result === "hello" && r.error === undefined, JSON.stringify(r));
  check("basic: not timed out", r.timedOut === false, JSON.stringify(r));
  check("basic: durationMs > 0", r.durationMs > 0, `durationMs ${r.durationMs}`);
}

// ── RPC: read_file ──────────────────────────────────────────────────────────────
{
  const r = await runScript('const f = await rpc("read_file", { path: "test.txt" }); return f.content;', { worktree: wt });
  check("rpc read_file: returns file content", r.error === undefined && r.result === "needle in a line\nsecond line\n", JSON.stringify(r));
}

// ── RPC: three tools (read + grep + write) ──────────────────────────────────────
{
  const code = [
    'const c = await rpc("read_file", { path: "test.txt" });',
    'const g = await rpc("grep", { pattern: "needle", path: "test.txt" });',
    'const w = await rpc("write_file", { path: "sub/result.txt", content: "written by script\\n" });',
    'return "read=" + (c.content.length > 0) + " grep=" + g.matches.length + " write=" + w.ok;',
  ].join("\n");
  const r = await runScript(code, { worktree: wt });
  check("multi-rpc: read+grep+write all succeed", r.error === undefined && r.result === "read=true grep=1 write=true", JSON.stringify(r));
  check("multi-rpc: file actually written to worktree", fs.readFileSync(path.join(wt, "sub", "result.txt"), "utf8") === "written by script\n");
}

// ── timeout ─────────────────────────────────────────────────────────────────────
{
  const r = await runScript("await new Promise((resolve) => setTimeout(resolve, 5000));", { worktree: wt, timeoutMs: 1000 });
  check("timeout: killed by timeout", r.timedOut === true, JSON.stringify(r));
  check("timeout: error is 'timeout'", r.error === "timeout", JSON.stringify(r));
  check("timeout: result is empty", r.result === "", JSON.stringify(r));
}

// ── blocked globals: require / process / fs ─────────────────────────────────────
{
  const req = await runScript("return require('fs');", { worktree: wt });
  check("require blocked", req.error !== undefined && req.result === "", JSON.stringify(req));
  check("require error names require", /require/.test(req.error ?? ""), JSON.stringify(req.error));

  const proc = await runScript("return process.env;", { worktree: wt });
  check("process blocked", proc.error !== undefined && /process/.test(proc.error ?? ""), JSON.stringify(proc.error));

  const fsr = await runScript("return fs.readFileSync('/etc/passwd');", { worktree: wt });
  check("fs blocked", fsr.error !== undefined && /fs/.test(fsr.error ?? ""), JSON.stringify(fsr.error));
}

// ── RPC guards: path escape + non-whitelisted tool ──────────────────────────────
{
  const esc = await runScript('await rpc("read_file", { path: "../../etc/passwd" }); return "should not reach here";', { worktree: wt });
  check("path escape rejected", esc.error !== undefined && /outside the worktree/.test(esc.error ?? ""), JSON.stringify(esc.error));

  const bad = await runScript('await rpc("spawn_worker", {});', { worktree: wt });
  check("non-whitelisted tool rejected", bad.error !== undefined && /not allowed/.test(bad.error ?? ""), JSON.stringify(bad.error));
}

// ── return value stringification ────────────────────────────────────────────────
{
  const r = await runScript("return 42;", { worktree: wt });
  check("non-string return is stringified", r.result === "42" && r.error === undefined, JSON.stringify(r));
}

// ── cleanup ─────────────────────────────────────────────────────────────────────
// (Workers are terminated inside runScript; if any leaked with pending timers
// this process would hang instead of exiting.)
fs.rmSync(tmp, { recursive: true, force: true });
check("temp files removed", !fs.existsSync(tmp));

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll sandbox runner checks passed.");
