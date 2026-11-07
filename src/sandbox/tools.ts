import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateTool, validatePath, validateExec } from "./allowlist.js";

/** A tool call rejected by the sandbox guards (unknown tool, path outside the worktree, disallowed exec command). */
export class ToolError extends Error {}

function guardError(message: string): never {
  throw new ToolError(message);
}

/**
 * Validate and execute one sandbox tool against a worktree.
 *
 * Shared by the two RPC paths:
 * - rpc-server.ts (slice 1) — HTTP endpoint, guarded per request
 * - runner.ts (slice 2) — the worker_threads sandbox, handled on the main thread
 *
 * The logic mirrors rpc-server.ts's runTool() (kept in sync there; rpc-server.ts
 * is intentionally untouched in slice 2 — a later slice can switch it to this
 * shared function).
 *
 * @throws {ToolError} when a guard rejects the call — surfaces to the script as a thrown rpc() error
 * @throws {Error}     when the tool itself fails (e.g. grep could not run)
 */
export function executeTool(tool: string, params: Record<string, unknown>, worktree: string): unknown {
  if (!validateTool(tool)) return guardError(`tool not allowed: ${String(tool)}`);
  const work = path.resolve(worktree);
  switch (tool) {
    case "read_file": {
      const abs = requirePath(params, work, "path");
      return { content: fs.readFileSync(abs, "utf8") };
    }
    case "write_file": {
      const abs = requirePath(params, work, "path");
      const content = params.content;
      if (typeof content !== "string") return guardError("write_file: content must be a string");
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
      if (!validateExec(cmd)) return guardError(`exec command rejected (shell metacharacters not allowed): ${cmd}`);
      let cwd: string;
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        if (!validatePath(params.cwd, work)) return guardError("exec: cwd is outside the worktree");
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
      return guardError(`unknown tool: ${tool}`);
  }
}

/** Validate a required path param against the worktree; returns the absolute path. */
function requirePath(params: Record<string, unknown>, work: string, name: string): string {
  const p = params[name];
  if (typeof p !== "string" || p.length === 0) return guardError(`${name} must be a non-empty string`);
  if (!validatePath(p, work)) return guardError(`${name} is outside the worktree: ${p}`);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(work, p);
}

function strParam(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== "string" || v.length === 0) return guardError(`${name} must be a non-empty string`);
  return v;
}

function toStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : v ? v.toString("utf8") : "";
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
