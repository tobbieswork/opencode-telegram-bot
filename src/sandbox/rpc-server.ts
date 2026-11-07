import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateTool, validatePath, validateExec } from "./allowlist.js";
import { log, warn } from "../logger.js";

export interface RpcHandle {
  port: number;
  stop: () => void;
}

/** A request that is valid JSON but rejected by the sandbox guards → 403. */
class RejectError extends Error {}

/** The single active sandbox RPC server (one worktree at a time in this slice). */
let active: Server | undefined;

/** Stop the active sandbox RPC server (no-op when none is running). */
export function stopRpcServer(): void {
  active?.close();
  active = undefined;
}

/**
 * Start a sandbox tool endpoint for the worker's worktree.
 *
 * Plain HTTP POST JSON (not MCP) — the only client is our own sandbox script.
 * Binds to 127.0.0.1 only, guarded by a bearer token (same approach as
 * McpBridge.token). Every tool is validated against the allowlist and all
 * paths/exec commands are confined to the worktree before execution.
 */
export function startRpcServer(token: string, worktree: string): Promise<RpcHandle> {
  const work = path.resolve(worktree);
  const server = createServer((req, res) => void handle(req, res, token, work));
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      active = server;
      log(`sandbox RPC listening on 127.0.0.1:${port} (worktree ${work})`);
      ok({ port, stop: () => stopRpcServer() });
    });
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function handle(req: IncomingMessage, res: ServerResponse, token: string, work: string): void {
  const url = req.url ?? "";
  if (!url.startsWith("/rpc")) return void json(res, 404, { error: "not found" });
  if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
  if (!authorized(req, token)) return void res.writeHead(401).end();

  void readBody(req).then((body) => {
    let req2: any;
    try {
      req2 = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const tool = req2?.tool;
    const params: Record<string, unknown> = req2?.params ?? {};
    if (!validateTool(tool)) return json(res, 403, { error: `tool not allowed: ${String(tool)}` });
    try {
      json(res, 200, runTool(tool, params, work));
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (e instanceof RejectError) return json(res, 403, { error: msg });
      warn(`sandbox RPC ${tool} failed:`, msg);
      json(res, 500, { error: msg });
    }
  });
}

function runTool(tool: string, params: Record<string, unknown>, work: string): unknown {
  switch (tool) {
    case "read_file": {
      const abs = requirePath(params, work, "path");
      return { content: fs.readFileSync(abs, "utf8") };
    }
    case "write_file": {
      const abs = requirePath(params, work, "path");
      const content = params.content;
      if (typeof content !== "string") return jsonError("write_file: content must be a string");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { ok: true };
    }
    case "grep": {
      const abs = requirePath(params, work, "path");
      const pattern = strParam(params, "pattern");
      // spawnSync (no shell) so the pattern — a regex, may contain `|` etc. —
      // is passed verbatim as an argument and can never execute anything.
      const r = spawnSync("grep", ["-rn", "--", pattern, abs], { cwd: work, timeout: 30_000, encoding: "utf8" });
      if (r.error || r.status === 2) throw new Error(`grep failed: ${r.stderr || r.error?.message}`);
      return { matches: r.status === 1 ? [] : (r.stdout ?? "").split("\n").filter(Boolean) };
    }
    case "glob": {
      const abs = requirePath(params, work, "path");
      const pattern = strParam(params, "pattern");
      const re = globToRegex(pattern);
      return { files: globWalk(abs, re) };
    }
    case "exec": {
      const cmd = strParam(params, "cmd");
      if (!validateExec(cmd)) return jsonError(`exec command rejected (shell metacharacters not allowed): ${cmd}`);
      let cwd: string;
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        if (!validatePath(params.cwd, work)) return jsonError("exec: cwd is outside the worktree");
        cwd = path.isAbsolute(params.cwd) ? path.resolve(params.cwd) : path.resolve(work, params.cwd);
      } else {
        cwd = work;
      }
      try {
        const out = execSync(cmd, { cwd, timeout: 30_000, encoding: "utf8" });
        return { stdout: out ?? "", stderr: "" };
      } catch (e) {
        const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
        return { stdout: toStr(err.stdout), stderr: toStr(err.stderr) };
      }
    }
    default:
      return jsonError(`unknown tool: ${tool}`);
  }
}

/** Validate a required path param against the worktree; returns the absolute path. */
function requirePath(params: Record<string, unknown>, work: string, name: string): string {
  const p = params[name];
  if (typeof p !== "string" || p.length === 0) return jsonError(`${name} must be a non-empty string`);
  if (!validatePath(p, work)) return jsonError(`${name} is outside the worktree: ${p}`);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(work, p);
}

function strParam(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== "string" || v.length === 0) return jsonError(`${name} must be a non-empty string`);
  return v;
}

function toStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : v ? v.toString("utf8") : "";
}

function jsonError(message: string): never {
  throw new RejectError(message);
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/** Recursive walk (symlinked directories are NOT followed) matching files against the pattern. */
function globWalk(root: string, re: RegExp): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const rel = path.relative(root, full);
        if (re.test(rel) || re.test(e.name)) out.push(full);
      }
    }
  }
  return out.sort();
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("body too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}
