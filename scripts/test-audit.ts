/**
 * Checks for the audit log (src/audit.ts): schema, redaction, truncation,
 * file mode, rotation to dated archives (same-day collision-safe), 14-file
 * retention, and "a write failure never throws".
 *
 * Run:  npx tsx scripts/test-audit.ts
 */
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../src/audit.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "audit-test-"));
const lines = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
/** All archives of <name> for <day>, incl. same-day counter copies, oldest first. */
const archivesOf = (name: string, day: string) =>
  readdirSync(dir)
    .filter((f) => f === `${name}.${day}` || f.startsWith(`${name}.${day}.`))
    .map((f) => ({ file: f, n: f.endsWith(day) ? 0 : Number(f.slice(f.lastIndexOf(".") + 1)) }))
    .sort((a, b) => a.n - b.n)
    .map((a) => join(dir, a.file));

try {
  // ── R3.1 / R3.2: one JSON line per event with the documented fields ──────
  const p1 = join(dir, "a.log");
  const fixed = new Date("2026-11-10T08:00:00.000Z");
  const a1 = createAudit({ path: p1, now: () => fixed });
  a1({ action: "prompt", userId: 42, chatId: -100, session: "ses_1", dir: "/work/app", outcome: "accepted", text: "hello" });
  a1({ action: "spawn", userId: 42, chatId: -100, outcome: "ok" });
  const rows = lines(p1);
  check("writes one JSON line per event", rows.length === 2);
  check("entry carries ISO timestamp", rows[0].ts === "2026-11-10T08:00:00.000Z");
  check(
    "entry carries user, chat, action, session, dir, outcome",
    rows[0].userId === 42 && rows[0].chatId === -100 && rows[0].action === "prompt" &&
      rows[0].session === "ses_1" && rows[0].dir === "/work/app" && rows[0].outcome === "accepted",
  );
  check("appends rather than overwrites", rows[1].action === "spawn");

  // ── R3.3: secrets redacted, long text truncated ──────────────────────────
  const p2 = join(dir, "b.log");
  const a2 = createAudit({ path: p2, maxText: 40 });
  const ghp = `ghp_${"a1B2c3D4".repeat(4)}xyZw`;
  a2({ action: "prompt", text: `use token ${ghp} please` });
  a2({ action: "prompt", text: "x".repeat(500) });
  const r2 = lines(p2);
  check("secret is redacted", !JSON.stringify(r2[0]).includes(ghp));
  const t = String(r2[1].text);
  check("long text is truncated", t.length <= 41 + 1 && t.endsWith("…"), `len=${t.length}`);

  // ── R3.4: file mode 0600 ─────────────────────────────────────────────────
  check("log file is mode 0600", (statSync(p1).mode & 0o777) === 0o600, (statSync(p1).mode & 0o777).toString(8));

  // ── T2: rotation at size limit → dated archive with correct content ──────
  const p3 = join(dir, "c.log");
  const a3 = createAudit({ path: p3, maxBytes: 300, now: () => new Date("2026-11-19T08:00:00.000Z") });
  for (let i = 0; i < 20; i++) a3({ action: "prompt", text: `event ${i}` });
  check("rotates to a dated archive when the size limit is hit", existsSync(`${p3}.2026-11-19`));
  check("active log stays near the limit", statSync(p3).size <= 600, String(statSync(p3).size));
  const p3Arch = archivesOf("c.log", "2026-11-19");
  const first = lines(p3Arch[0]);
  check("archive holds the pre-rotation events (correct content)",
    first.length > 0 && first[0].text === "event 0" && first.every((r) => String(r.ts).startsWith("2026-11-19T08:00")),
    JSON.stringify(first[0]));
  const p3Total = lines(p3).length + p3Arch.reduce((n, f) => n + lines(f).length, 0);
  check("no event is lost across rotations", p3Total === 20, `total=${p3Total}`);

  // ── T2: same-day collision — a second rotation must not clobber ──────────
  const p4 = join(dir, "d.log");
  const a4 = createAudit({ path: p4, maxBytes: 300, now: () => new Date("2026-11-19T09:00:00.000Z") });
  for (let i = 0; i < 20; i++) a4({ action: "prompt", text: `r1-${i}` });
  const p4First = `${p4}.2026-11-19`;
  check("first rotation creates the dated archive", existsSync(p4First));
  const p4Snapshot = lines(p4First).map((r) => String(r.text)).join(",");
  for (let i = 0; i < 20; i++) a4({ action: "prompt", text: `r2-${i}` });
  const p4Arch = archivesOf("d.log", "2026-11-19");
  check("later same-day rotations use counter copies", p4Arch.length >= 2, String(p4Arch.length));
  check("the first archive is untouched by later rotations",
    lines(p4First).map((r) => String(r.text)).join(",") === p4Snapshot);
  const p4All = [...lines(p4), ...p4Arch.flatMap((f) => lines(f))];
  check("no event lost or duplicated across same-day rotations",
    p4All.length === 40 && p4All.filter((r) => String(r.text).startsWith("r2-")).length === 20,
    `total=${p4All.length}`);

  // ── T2: retention — only the 14 newest dated archives survive ────────────
  // 16 clock-days, each with 10 fixed-length (101 B) lines and maxBytes 505
  // (= 5 lines): day 1 rotates once, every later day twice — 31 archives total.
  const p5 = join(dir, "e.log");
  let dayMs = Date.UTC(2026, 10, 1);
  const a5 = createAudit({ path: p5, maxBytes: 505, now: () => new Date(dayMs) });
  for (let d = 1; d <= 16; d++) {
    dayMs = Date.UTC(2026, 10, d);
    for (let i = 0; i < 10; i++) a5({ action: "prompt", text: "y".repeat(40) });
  }
  const p5Arch = readdirSync(dir)
    .filter((f) => /^e\.log\.\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(f))
    .sort();
  check("retention keeps exactly 14 archives", p5Arch.length === 14, String(p5Arch.length));
  check("oldest archives are pruned (Nov 01 and 09 gone)",
    !p5Arch.some((f) => f.includes("2026-11-01") || f.includes("2026-11-09")));
  check("newest archives are kept (Nov 10 base and Nov 16 counter present)",
    p5Arch.includes("e.log.2026-11-10") && p5Arch.includes("e.log.2026-11-16.1"),
    p5Arch.join(" "));
  const newest = lines(join(dir, "e.log.2026-11-16.1"));
  check("newest archive has correct content (5 same-day events)",
    newest.length === 5 && newest.every((r) => String(r.text) === "y".repeat(40)),
    String(newest.length));

  // ── R3.5: a write failure never throws ───────────────────────────────────
  const blocker = join(dir, "file-not-dir");
  writeFileSync(blocker, "x");
  const a6 = createAudit({ path: join(blocker, "sub", "d.log") }); // parent is a file → mkdir fails
  let threw = false;
  try {
    a6({ action: "prompt" });
    a6({ action: "prompt" });
  } catch {
    threw = true;
  }
  check("write failure does not throw", !threw);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall audit checks passed");
