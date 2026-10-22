/**
 * Checks the /prune candidate selection: only FINISHED workers
 * (done/failed/stopped) strictly older than the cutoff are selected.
 * Busy workers (running/waiting) and idle ones are NEVER selected,
 * no matter how old.
 *
 * Run:  npx tsx scripts/test-prune.ts
 */
import { selectPruneable } from "../src/prune.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const now = 1_000_000_000_000;
const d7 = 7 * DAY;

// ── the four canonical cases from the spec ──────────────────────────────────
{
  const items = [
    { conv: "1:10", status: "done", updatedAt: now - 8 * DAY }, // done 8 days old → select
    { conv: "1:11", status: "done", updatedAt: now - 3 * DAY }, // done 3 days old → keep
    { conv: "1:12", status: "running", updatedAt: now - 30 * DAY }, // running 30 days → NEVER
    { conv: "1:13", status: "stopped", updatedAt: now - 8 * DAY }, // stopped 8 days → select
  ];
  const got = selectPruneable(items, now, d7);
  check("done 8 days old → selected", got.includes("1:10"));
  check("done 3 days old → NOT selected", !got.includes("1:11"));
  check("running 30 days old → NEVER selected", !got.includes("1:12"));
  check("stopped 8 days old → selected", got.includes("1:13"));
  check(
    "selects exactly the two eligible convs",
    JSON.stringify([...got].sort()) === JSON.stringify(["1:10", "1:13"]),
    JSON.stringify(got),
  );
}

// ── status coverage: failed in, waiting/idle never ─────────────────────────
{
  const items = [
    { conv: "1:14", status: "failed", updatedAt: now - 30 * DAY },
    { conv: "1:15", status: "waiting", updatedAt: now - 100 * DAY },
    { conv: "1:16", status: "idle", updatedAt: now - 100 * DAY },
  ];
  const got = selectPruneable(items, now, d7);
  check("failed 30 days old → selected", got.includes("1:14"));
  check("waiting 100 days old → NEVER selected", !got.includes("1:15"));
  check("idle 100 days old → NEVER selected", !got.includes("1:16"));
  check("exactly one selected", got.length === 1);
}

// ── the cutoff is strict: updatedAt must be OLDER than now - days ───────────
{
  const items = [
    { conv: "1:17", status: "done", updatedAt: now - 7 * DAY - 1 }, // just past the cutoff
    { conv: "1:18", status: "done", updatedAt: now - 7 * DAY }, // exactly at the cutoff (not older)
    { conv: "1:19", status: "done", updatedAt: now - 7 * DAY + 1 }, // just before it
  ];
  const got = selectPruneable(items, now, d7);
  check("just past cutoff → selected", got.includes("1:17"));
  check("exactly at cutoff → NOT selected", !got.includes("1:18"));
  check("just before cutoff → NOT selected", !got.includes("1:19"));
}

// ── a custom day count changes the cutoff ───────────────────────────────────
{
  const items = [
    { conv: "1:20", status: "done", updatedAt: now - 8 * DAY },
    { conv: "1:21", status: "failed", updatedAt: now - 5 * DAY },
  ];
  check("days=3: both 8d and 5d are old enough", JSON.stringify(selectPruneable(items, now, 3 * DAY).sort()) === JSON.stringify(["1:20", "1:21"]));
  check("days=6: only the 8-day one qualifies", JSON.stringify(selectPruneable(items, now, 6 * DAY)) === JSON.stringify(["1:20"]));
  check("days=9: none qualifies", selectPruneable(items, now, 9 * DAY).length === 0);
}

// ── degenerate inputs ────────────────────────────────────────────────────────
{
  check("no items → nothing", selectPruneable([], now, d7).length === 0);
  check("missing updatedAt treated as 0 (ancient finished → selected)", selectPruneable([{ conv: "1:22", status: "stopped" } as any], now, d7).length === 1);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
