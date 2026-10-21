import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface DirItem {
  name: string;
  path: string;
}

/**
 * List the sub-directories of `dir`, sorted alphabetically. Files are skipped
 * — this browser exists to pick a folder to work in. Dot-entries are hidden
 * unless `showHidden` is set.
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
    items.push({ name: e.name, path: join(dir, e.name) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return items;
}

/** True when `p` is one of the roots, or lives inside one of them. */
export function isUnderRoot(p: string, roots: string[]): boolean {
  const target = resolve(p);
  return roots.some((r) => {
    const root = resolve(r);
    if (target === root) return true;
    return target.startsWith(root.endsWith(sep) ? root : root + sep);
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
