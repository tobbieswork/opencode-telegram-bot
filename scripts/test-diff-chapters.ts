/**
 * Chaptered diff review (plannotator #4 adapted) — the pure grouping plus the
 * git-backed helpers the /wt diff index and on-demand chapter view rely on:
 *   - groupDiffChapters(tracked, untracked, max)  — deterministic, no I/O
 *   - diffFileList(wt)                             — tracked vs untracked files
 *   - chapterPatch(wt, diffFiles, chapter)         — one chapter's patch
 *
 * Runs against a throwaway git repo (no live Telegram/OpenCode).
 * Run:  npx tsx scripts/test-diff-chapters.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupDiffChapters, diffFileList, chapterPatch, DIFF_CHAPTER_MAX, type DiffChapter } from "../src/worktree.js";

const pexec = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  pexec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd }).then((r) => r.stdout.trim());

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
const titles = (cs: DiffChapter[]) => cs.map((c) => c.title);
const filesOf = (cs: DiffChapter[], t: string) => cs.find((c) => c.title === t)?.files ?? [];

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tg-diffch-"));
  const repo = join(base, "repo");
  try {
    // ── groupDiffChapters: pure grouping ───────────────────────────────────
    console.log("# groupDiffChapters — pure");
    {
      const cs = groupDiffChapters(["a.txt", "src/x.ts", "test/t.ts"], ["newfile.txt"]);
      check("groups by top-level segment", JSON.stringify(titles(cs)) === JSON.stringify(["(root)", "src", "test"]), JSON.stringify(titles(cs)));
      check("root files land in (root), sorted", JSON.stringify(filesOf(cs, "(root)")) === JSON.stringify(["a.txt", "newfile.txt"]), JSON.stringify(filesOf(cs, "(root)")));
      check("biggest area first, ties by name (src before test)", titles(cs).indexOf("src") < titles(cs).indexOf("test"));
    }
    {
      const cs = groupDiffChapters(["src/a.ts", "src/b.ts", "src/c.ts", "x/1.ts"], []);
      check("most-files area leads", titles(cs)[0] === "src", JSON.stringify(titles(cs)));
    }
    {
      // dedupe a file that is both tracked-changed and (re)listed untracked
      const cs = groupDiffChapters(["dup.ts"], ["dup.ts"]);
      check("union dedupes a file in both lists", filesOf(cs, "(root)").length === 1 && filesOf(cs, "(root)")[0] === "dup.ts", JSON.stringify(filesOf(cs, "(root)")));
    }
    {
      // overflow: 10 top-level segments (> DIFF_CHAPTER_MAX=8) → keep 7 + (other)
      const tracked = Array.from({ length: 10 }, (_, i) => `s${i}/f.ts`);
      const cs = groupDiffChapters(tracked, []);
      check("capped at DIFF_CHAPTER_MAX chapters", cs.length === DIFF_CHAPTER_MAX, String(cs.length));
      check("overflow merges into a trailing (other)", cs[cs.length - 1].title === "(other)", JSON.stringify(titles(cs)));
      check("kept the 7 earliest by name, rest in (other)", cs[0].title === "s0" && filesOf(cs, "(other)").length === 3, JSON.stringify({ first: cs[0].title, other: filesOf(cs, "(other)") }));
    }
    {
      check("empty lists → no chapters", groupDiffChapters([], []).length === 0);
    }

    // ── git fixture for diffFileList / chapterPatch ────────────────────────
    mkdirSync(repo);
    await git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "rootfile.txt"), "root\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/x.ts"), "export const x = 1;\n");
    writeFileSync(join(repo, "src/y.ts"), "export const y = 2;\n");
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test/t.ts"), "test('ok');\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);

    // changes vs base: modify a.txt + src/x.ts + test/t.ts (tracked), add untracked newfile.txt
    writeFileSync(join(repo, "a.txt"), "alpha changed\n");
    writeFileSync(join(repo, "src/x.ts"), "export const x = 99;\n");
    writeFileSync(join(repo, "test/t.ts"), "test('changed');\n");
    writeFileSync(join(repo, "newfile.txt"), "brand new\n");

    console.log("# diffFileList — tracked vs untracked");
    const df = await diffFileList({ root: repo, base: "HEAD" });
    check("tracked = modified files vs base", JSON.stringify([...df.tracked].sort()) === JSON.stringify(["a.txt", "src/x.ts", "test/t.ts"]), JSON.stringify(df.tracked));
    check("untracked = never-added files", JSON.stringify(df.untracked) === JSON.stringify(["newfile.txt"]), JSON.stringify(df.untracked));

    console.log("# chapterPatch — one chapter's patch");
    const chapters = groupDiffChapters(df.tracked, df.untracked);
    check("fixture produces (root)/src/test chapters", JSON.stringify(titles(chapters)) === JSON.stringify(["(root)", "src", "test"]), JSON.stringify(titles(chapters)));
    const rootC = chapters.find((c) => c.title === "(root)")!;
    const rootPatch = await chapterPatch({ root: repo, base: "HEAD" }, df, rootC);
    check("root chapter shows the tracked a.txt diff", rootPatch.includes("alpha changed") && rootPatch.includes("+"), rootPatch);
    check("root chapter lists the untracked newfile.txt", rootPatch.includes("untracked: newfile.txt"), rootPatch);
    const srcC = chapters.find((c) => c.title === "src")!;
    const srcPatch = await chapterPatch({ root: repo, base: "HEAD" }, df, srcC);
    check("src chapter shows src/x.ts diff (99) and not y.ts", srcPatch.includes("99") && !srcPatch.includes("y.ts"), srcPatch);
    check("src chapter has no untracked line", !srcPatch.includes("untracked:"), srcPatch);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall diff-chapter checks passed");
}
void main();
