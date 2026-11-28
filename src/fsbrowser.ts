import { readdir, stat } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface DirItem {
  name: string;
  path: string;
}

/** `realpath` that returns null instead of throwing (missing path, loop, …). */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The real (symlink-resolved) location of the deepest existing component of
 * `p`, or null when nothing along the way can be resolved. Not-yet-existing
 * paths resolve through their deepest existing ancestor, so a symlinked
 * parent still gets caught — same approach as `validatePath` in the sandbox
 * allowlist.
 */
function realOf(p: string): string | null {
  let probe = resolve(p);
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return tryRealpath(probe);
}

/**
 * List the sub-directories of `dir`, sorted alphabetically. Files are skipped
 * — this browser exists to pick a folder to work in. Dot-entries are hidden
 * unless `showHidden` is set. Symlinked directories that resolve outside the
 * real location of `dir` are skipped too: they would be an escape hatch out
 * of the browse jail.
 */
export async function listDirs(dir: string, showHidden: boolean): Promise<DirItem[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const items: DirItem[] = [];
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = (await stat(join(dir, e.name))).isDirectory();
      } catch {
        isDir = false; // broken symlink
      }
    }
    if (!isDir) continue;
    if (e.isSymbolicLink() && !isUnderRoot(join(dir, e.name), [dir])) continue;
    items.push({ name: e.name, path: join(dir, e.name) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return items;
}

/**
 * True when `p` is one of the roots, or lives inside one of them. Containment
 * is checked lexically (catches `..` and foreign absolute paths) and again on
 * real, symlink-resolved locations — so a link inside a root that points
 * outside it cannot escape the jail.
 */
export function isUnderRoot(p: string, roots: string[]): boolean {
  const target = resolve(p);
  return roots.some((r) => {
    const root = resolve(r);
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
    const realRoot = tryRealpath(root);
    if (realRoot === null) return true; // root does not exist — nothing can hide behind it
    const real = realOf(target);
    if (real === null) return false; // unresolvable (e.g. symlink loop) — reject
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  });
}

/**
 * The closest ancestor of `p` that is still inside the allowed roots, or
 * undefined when going up would leave them.
 */
export function parentWithin(p: string, roots: string[]): string | undefined {
  const cur = resolve(p);
  const parent = dirname(cur);
  if (parent === cur) return undefined;
  return isUnderRoot(parent, roots) ? parent : undefined;
}

/** Keep the tail of a long path readable: /a/b/c/d → …/c/d */
export function shortPath(p: string, max = 64): string {
  if (p.length <= max) return p;
  const parts = p.split(sep);
  let out = parts[parts.length - 1] ?? p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}${sep}${out}`;
    if (next.length + 2 > max) return `…${sep}${out}`;
    out = next;
  }
  return out;
}
