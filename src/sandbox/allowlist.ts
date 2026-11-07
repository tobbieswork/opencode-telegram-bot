import fs from "node:fs";
import path from "node:path";

/** Tools the sandboxed RPC endpoint may execute (a safe subset of the worker toolset). */
export const TOOL_ALLOWLIST = ["read_file", "write_file", "grep", "glob", "exec"] as const;

/** True only for tool names in TOOL_ALLOWLIST. */
export function validateTool(tool: string): boolean {
  return typeof tool === "string" && (TOOL_ALLOWLIST as readonly string[]).includes(tool);
}

/**
 * True only when `p` resolves to a location inside `worktree`.
 * Rejects `../` escapes, absolute paths outside the worktree, and symlinks
 * that resolve outside. Relative paths are resolved against the worktree root.
 * For not-yet-existing files (write_file), the deepest existing ancestor is
 * realpath'd instead, so a symlinked parent directory is still caught.
 */
export function validatePath(p: string, worktree: string): boolean {
  if (typeof p !== "string" || p.length === 0 || typeof worktree !== "string" || worktree.length === 0) return false;
  const root = path.resolve(worktree);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false; // worktree itself does not exist
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  // Lexical containment (catches ../ escapes and absolute paths outside).
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  // Walk up to the deepest existing component (lstat: a dangling symlink counts as existing).
  let probe = abs;
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * True only when the command contains no shell metacharacters, i.e. it must be
 * a single plain command: no `;`, `|`, `&`, `>`, `<`, `$(`, backticks
 * (`&&`/`||` contain `&`/`|` and are covered).
 */
export function validateExec(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (/[;|&<>`]/.test(cmd)) return false;
  if (cmd.includes("$(")) return false;
  return true;
}
