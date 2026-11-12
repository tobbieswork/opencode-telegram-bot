/**
 * Checks for gitFingerprint (src/gitstate.ts): a cheap "did the working tree
 * change?" signal used by the next-step Review rule. Uses a real temporary git
 * repo; no network, no OpenCode.
 *
 * Run:  npx tsx scripts/test-gitstate.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFingerprint } from "../src/gitstate.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" }).toString();
/** Bump mtime explicitly so two edits in the same millisecond still differ. */
let tick = 1_800_000_000;
const touch = (p: string) => utimesSync(p, ++tick, tick);

async function main(): Promise<void> {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "gitstate-"));
  try {
    // ── not a repository ───────────────────────────────────────────────────
    const plain = join(root, "plain");
    mkdirSync(plain);
    check("a folder outside any repo → undefined", (await gitFingerprint(plain)) === undefined);
    check("a folder that does not exist → undefined", (await gitFingerprint(join(root, "nope"))) === undefined);

    // ── a repo with no commits yet ─────────────────────────────────────────
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    check("a repo with no commits still fingerprints", typeof (await gitFingerprint(repo)) === "string");

    // ── baseline ───────────────────────────────────────────────────────────
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    const clean = await gitFingerprint(repo);
    check("clean repo → a fingerprint", typeof clean === "string" && clean.length > 10);
    check("same state twice → identical fingerprint", clean === (await gitFingerprint(repo)));

    // ── changes are detected ───────────────────────────────────────────────
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    touch(join(repo, "a.txt"));
    const edited = await gitFingerprint(repo);
    check("editing a tracked file changes it", edited !== clean);

    writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
    touch(join(repo, "a.txt"));
    check("editing an ALREADY-modified file again changes it (status text alone would not)", (await gitFingerprint(repo)) !== edited);

    const before = await gitFingerprint(repo);
    writeFileSync(join(repo, "b.txt"), "new\n");
    check("a new untracked file changes it", (await gitFingerprint(repo)) !== before);

    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "c.txt"), "x\n");
    const withSub = await gitFingerprint(repo);
    writeFileSync(join(repo, "sub", "c.txt"), "xy\n");
    touch(join(repo, "sub", "c.txt"));
    check("editing an untracked file inside a new folder changes it", (await gitFingerprint(repo)) !== withSub);

    const beforeIgnored = await gitFingerprint(repo);
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored", "junk.log"), "noise\n");
    check("a git-ignored file does NOT change it", (await gitFingerprint(repo)) === beforeIgnored);

    const beforeCommit = await gitFingerprint(repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "work");
    check("committing the work changes it (HEAD moved)", (await gitFingerprint(repo)) !== beforeCommit);

    // ── a subfolder of the repo works too ──────────────────────────────────
    const inSub = await gitFingerprint(join(repo, "sub"));
    check("a subfolder of a repo fingerprints the whole repo", typeof inSub === "string" && inSub === (await gitFingerprint(repo)));

    // ── limits ─────────────────────────────────────────────────────────────
    for (let i = 0; i < 12; i++) writeFileSync(join(repo, `many-${i}.txt`), "x\n");
    check("more changed paths than the cap → undefined (caller falls back)", (await gitFingerprint(repo, { maxPaths: 5 })) === undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall gitstate checks passed");
}

main();
