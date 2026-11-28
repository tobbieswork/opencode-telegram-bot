/**
 * Pure-function checks for the folder browser: the path jail (isUnderRoot /
 * parentWithin — the safety boundary for the /browse buttons), shortPath, and
 * listDirs against a throwaway directory. No service or network needed.
 *
 * Run:  npx tsx scripts/test-fsbrowser.ts
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isUnderRoot, parentWithin, shortPath, listDirs } from "../src/fsbrowser.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const ROOT = "/home/x/proj";

// ── isUnderRoot: the jail ──────────────────────────────────────────────────
{
  check("root itself is under root", isUnderRoot(ROOT, [ROOT]));
  check("child of root", isUnderRoot("/home/x/proj/src", [ROOT]));
  check("deep child", isUnderRoot("/home/x/proj/a/b/c", [ROOT]));
  check("prefix trap: /projx is NOT under /proj", !isUnderRoot("/home/x/projx", [ROOT]));
  check("sibling dir rejected", !isUnderRoot("/home/x/other", [ROOT]));
  check("outside rejected", !isUnderRoot("/etc/passwd", [ROOT]));
  check("trailing-slash root accepted", isUnderRoot("/home/x/proj/src", [ROOT + "/"]));
  check("any-of roots", isUnderRoot("/opt/work/a", [ROOT, "/opt/work"]));
}

// ── parentWithin: "up" that never leaves the jail ─────────────────────────
{
  check("step up inside", parentWithin("/home/x/proj/src/bot.ts", [ROOT]) === "/home/x/proj/src");
  check("up to the root", parentWithin("/home/x/proj/src", [ROOT]) === ROOT);
  check("at the root -> undefined", parentWithin(ROOT, [ROOT]) === undefined);
  check("going up would leave -> undefined", parentWithin("/home/x", [ROOT]) === undefined);
  check("filesystem root has no parent", parentWithin("/", ["/"]) === undefined);
}

// ── shortPath ─────────────────────────────────────────────────────────────
{
  check("short path unchanged", shortPath("/a/b/c") === "/a/b/c");
  const long = "/home/phatnd12/fpt/opencode-telegram-bot/src/some/very/long/path/file.ts";
  const s = shortPath(long, 30);
  check("long path truncated with …/", s === "…/some/very/long/path/file.ts", s);
  check("long path within budget", s.length <= 30, String(s.length));
}

// ── listDirs: dirs only, hidden filtered, numeric sort ────────────────────
{
  const base = join("/tmp/opencode", `fsb-test-${process.pid}`);
  await mkdir(join(base, "dir10"), { recursive: true });
  await mkdir(join(base, "dir2"), { recursive: true });
  await mkdir(join(base, "zzz"), { recursive: true });
  await mkdir(join(base, ".hidden"), { recursive: true });
  await writeFile(join(base, "file.txt"), "x");
  try {
    const items = await listDirs(base, false);
    check(
      "dirs only, numeric sort",
      items.map((i) => i.name).join(",") === "dir2,dir10,zzz",
      items.map((i) => i.name).join(","),
    );
    check("hidden excluded by default", !items.some((i) => i.name.startsWith(".")));
    const withHidden = await listDirs(base, true);
    check("hidden included when asked", withHidden.some((i) => i.name === ".hidden"));
    check("paths are absolute under base", items.every((i) => i.path.startsWith(base + "/")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ── symlink jail: a link inside the root must not point outside it ─────────
{
  const base = join("/tmp/opencode", `fsb-sym-${process.pid}`);
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  await mkdir(join(allowed, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(allowed, "sub", "real.txt"), "x");
  await writeFile(join(outside, "secret.txt"), "x");
  await symlink(outside, join(allowed, "link")); // inside root -> outside root
  await symlink(join(allowed, "sub"), join(allowed, "inlink")); // stays inside
  await symlink(join(allowed, "gone"), join(allowed, "broken")); // dangling
  try {
    check("escape symlink target NOT under root", !isUnderRoot(join(allowed, "link", "secret.txt"), [allowed]));
    check("escape symlink itself NOT under root", !isUnderRoot(join(allowed, "link"), [allowed]));
    check("missing path through escape symlink NOT under root", !isUnderRoot(join(allowed, "link", "newdir"), [allowed]));
    check("existing in-root path still under root", isUnderRoot(join(allowed, "sub", "real.txt"), [allowed]));
    check("missing in-root path still under root", isUnderRoot(join(allowed, "sub", "newdir"), [allowed]));
    check("up through escaping symlink blocked", parentWithin(join(allowed, "link", "deep"), [allowed]) === undefined);
    const items = await listDirs(allowed, false);
    const names = items.map((i) => i.name).join(",");
    check("escaping symlink not offered", !items.some((i) => i.name === "link"), names);
    check("in-tree symlink still offered", items.some((i) => i.name === "inlink"), names);
    check("normal dir still offered", items.some((i) => i.name === "sub"), names);
    check("dangling symlink not offered", !items.some((i) => i.name === "broken"), names);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
