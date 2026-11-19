/**
 * Unit tests for deploy/backup-state.sh — nightly state backup to a git
 * remote. The "remote" is a local bare repo (file://) and the data dir is a
 * temp dir, so this runs offline and never touches real bot data.
 *
 * Run:  npx tsx scripts/test-backup-state.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const base = "/tmp/opencode";
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "backup-state-test-"));

const script = fileURLToPath(new URL("../deploy/backup-state.sh", import.meta.url));
const remote = join(root, "remote.git");
const dataDir = join(root, "data");
const cache = join(root, "cache");

execFileSync("git", ["init", "--bare", "-b", "main", remote]);

// ── fake bot data dir ─────────────────────────────────────────────────────────
const v1 = { hello: "world", sessions: [] };
const v2 = { hello: "world", sessions: [{ id: 1 }] };
mkdirSync(join(dataDir, "notes"), { recursive: true });
writeFileSync(join(dataDir, "state.json"), JSON.stringify(v1));
writeFileSync(join(dataDir, "users.json"), JSON.stringify({ me: "owner" }));
writeFileSync(join(dataDir, "schedules.json"), JSON.stringify({ jobs: [] }));
writeFileSync(join(dataDir, "state.json.bak-old"), JSON.stringify(v1));
writeFileSync(join(dataDir, "notes", "guide.md"), "# guide\n");
writeFileSync(join(dataDir, "audit.log"), "log line\n");

const baseEnv = {
  STATE_BACKUP_DATA_DIR: dataDir,
  STATE_BACKUP_REMOTE: `file://${remote}`,
  STATE_BACKUP_CACHE: cache,
  STATE_BACKUP_KEEP: "7",
};

function run(args: string[] = [], ts?: string): string {
  const env = { ...process.env, ...baseEnv, ...(ts ? { STATE_BACKUP_TIMESTAMP: ts } : {}) };
  return execFileSync("bash", [script, ...args], { env, encoding: "utf8" });
}
const ts = (n: number): string => `2026-11-${String(n).padStart(2, "0")}T03-30-00Z`;

function gens(dir: string): string[] {
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", remote, dir]);
  const s = join(dir, "snapshots");
  return existsSync(s) ? readdirSync(s).sort() : [];
}
const snapPath = (dir: string, t: string) => join(dir, "snapshots", t);
const parsed = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

// ── first run ─────────────────────────────────────────────────────────────────
try {
  run([], ts(1));
  check("first run exits 0", true);
} catch (e) {
  check("first run exits 0", false, String(e).slice(0, 400));
}

const v1dir = join(root, "verify1");
const g1 = gens(v1dir);
check("one generation after first run", g1.length === 1 && g1[0] === ts(1), JSON.stringify(g1));
check("state.json present in remote", existsSync(join(snapPath(v1dir, ts(1)), "state.json")));
try {
  check("state.json parses", JSON.stringify(parsed(join(snapPath(v1dir, ts(1)), "state.json"))) === JSON.stringify(v1));
} catch (e) {
  check("state.json parses", false, String(e).slice(0, 200));
}
check("users.json backed up", existsSync(join(snapPath(v1dir, ts(1)), "users.json")));
check("notes/ backed up", existsSync(join(snapPath(v1dir, ts(1)), "notes", "guide.md")));
check(
  ".bak files excluded",
  !readdirSync(snapPath(v1dir, ts(1))).some((f) => f.includes(".bak")),
  JSON.stringify(readdirSync(snapPath(v1dir, ts(1)))),
);
check("audit.log excluded", !existsSync(join(snapPath(v1dir, ts(1)), "audit.log")));
check(
  "README seeded + documents restore",
  existsSync(join(v1dir, "README.md")) && readFileSync(join(v1dir, "README.md"), "utf8").includes("restore"),
);

// ── idempotent re-run, same timestamp ─────────────────────────────────────────
run([], ts(1));
check("re-run same timestamp: still one generation", gens(v1dir).length === 1);

// ── pruning: 9 runs total, keep 7 ─────────────────────────────────────────────
for (let n = 2; n <= 9; n++) {
  if (n === 9) writeFileSync(join(dataDir, "state.json"), JSON.stringify(v2));
  run([], ts(n));
}
const v2dir = join(root, "verify2");
const g9 = gens(v2dir);
check("7 generations kept after 9 runs", g9.length === 7, JSON.stringify(g9));
check("oldest two pruned", !g9.includes(ts(1)) && !g9.includes(ts(2)));
check("newest kept", g9.includes(ts(9)));

// ── restore ───────────────────────────────────────────────────────────────────
const destOld = join(root, "restore-old");
const destNew = join(root, "restore-new");
run(["restore", ts(3), destOld]);
check("restore <TS>: state.json is the old content", JSON.stringify(parsed(join(destOld, "state.json"))) === JSON.stringify(v1));
check("restore <TS>: notes present", existsSync(join(destOld, "notes", "guide.md")));
run(["restore", destNew]);
check("restore latest: state.json is the newest content", JSON.stringify(parsed(join(destNew, "state.json"))) === JSON.stringify(v2));
check("restore does not materialize .bak files", !existsSync(join(destNew, "state.json.bak-old")));
let restoreMissingOk = true;
try {
  run(["restore", "no-such-ts", destOld]);
  restoreMissingOk = false;
} catch {
  /* expected: non-zero exit */
}
check("restore missing TS fails loudly", restoreMissingOk);

// ── units + syntax ────────────────────────────────────────────────────────────
const svc = readFileSync(fileURLToPath(new URL("../deploy/backup-state.service", import.meta.url)), "utf8");
const tmr = readFileSync(fileURLToPath(new URL("../deploy/backup-state.timer", import.meta.url)), "utf8");
check("service: oneshot + ExecStart script", svc.includes("Type=oneshot") && svc.includes("backup-state.sh"));
check("timer: nightly OnCalendar", /OnCalendar=\*-\*-\* \d{2}:\d{2}:00/.test(tmr));
check("timer: Persistent=true", tmr.includes("Persistent=true"));
check("timer: Unit=backup-state.service", tmr.includes("Unit=backup-state.service"));
let syntaxOk = true;
try {
  execFileSync("bash", ["-n", script]);
} catch {
  syntaxOk = false;
}
check("bash -n: script syntax ok", syntaxOk);

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll backup-state checks passed.");
