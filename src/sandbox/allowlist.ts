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
 * Binaries that must never be the command of a sandbox `exec`:
 * - script interpreters (node, python, ...) accept full programs as arguments,
 *   so `exec("node -e \"...\"\")` would run arbitrary code outside the worktree
 *   (file reads, network exfiltration, child processes) and bypass every other
 *   guard in this module;
 * - shells (sh, bash, ...) via `-c` do the same;
 * - `env` could prefix any of the above (`env node -e ...`);
 * - `npx`/`pnpx` fetch and run arbitrary registry code.
 * Plain project tooling (npm, git, grep, ...) is still allowed.
 */
const BLOCKED_EXECUTABLES: ReadonlySet<string> = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "python",
  "ruby",
  "perl",
  "php",
  "lua",
  "luajit",
  // busybox exposes every applet (incl. sh) through one binary; installed on this box.
  "busybox",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "env",
  "npx",
  "pnpx",
]);
/** Versioned interpreters: python3, python3.11, ... ("python" itself is in the set above). */
const VERSIONED_BLOCKED_EXECUTABLES = /^python\d/;

/**
 * The basename of the executable a plain command would run. Skips leading
 * `VAR=value` environment assignments and a single layer of surrounding
 * quotes; returns "" when the command has no command token.
 */
export function commandExecutable(cmd: string): string {
  for (const token of cmd.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    let t = token;
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      t = t.slice(1, -1);
    }
    return t.split("/").pop() ?? "";
  }
  return "";
}

/**
 * True when `cmd` would run a script interpreter or shell — i.e. arbitrary
 * code execution that bypasses the worktree confinement (see BLOCKED_EXECUTABLES).
 */
export function isBlockedExecutable(cmd: string): boolean {
  const bin = commandExecutable(cmd);
  return bin !== "" && (BLOCKED_EXECUTABLES.has(bin) || VERSIONED_BLOCKED_EXECUTABLES.test(bin));
}

/**
 * True only when the command contains no shell metacharacters, i.e. it must be
 * a single plain command: no `;`, `|`, `&`, `>`, `<`, `$(`, backticks
 * (`&&`/`||` contain `&`/`|` and are covered), and no script interpreter or
 * shell as the command itself.
 */
export function validateExec(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (/[;|&<>`\n\r]/.test(cmd)) return false;
  if (cmd.includes("$(")) return false;
  if (isBlockedExecutable(cmd)) return false;
  return true;
}
