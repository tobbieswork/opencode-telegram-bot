/**
 * Checks for the audit log (src/audit.ts): schema, redaction, truncation,
 * file mode, rotation, and "a write failure never throws".
 *
 * Run:  npx tsx scripts/test-audit.ts
 */
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, writeFileSync } from "node:fs";
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

  // ── R3.4: rotation at size limit ─────────────────────────────────────────
  const p3 = join(dir, "c.log");
  const a3 = createAudit({ path: p3, maxBytes: 300 });
  for (let i = 0; i < 20; i++) a3({ action: "prompt", text: `event ${i}` });
  check("rotates to .1 when the size limit is hit", existsSync(`${p3}.1`));
  check("active log stays near the limit", statSync(p3).size <= 600, String(statSync(p3).size));
  const total = lines(p3).length + lines(`${p3}.1`).length;
  check("no event is lost across one rotation", total >= 10, `total=${total}`);

  // ── R3.5: a write failure never throws ───────────────────────────────────
  const blocker = join(dir, "file-not-dir");
  writeFileSync(blocker, "x");
  const a4 = createAudit({ path: join(blocker, "sub", "d.log") }); // parent is a file → mkdir fails
  let threw = false;
  try {
    a4({ action: "prompt" });
    a4({ action: "prompt" });
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
