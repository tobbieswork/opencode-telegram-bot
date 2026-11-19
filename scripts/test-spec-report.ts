/**
 * T2 (docs/sdd/ocr-hardening.md) — the fixed spec-worker report schema:
 * parseWorkerReport extracts Status / Coverage / Files / Tests / Follow-ups
 * from a worker's final message and reports the missing fields in schema
 * order. Pure-function tests only (no I/O).
 *
 * Run:  npx tsx scripts/test-spec-report.ts
 */
import { parseWorkerReport, REPORT_FIELDS } from "../src/spec-report.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── a full block, prose before it (the block sits at the END) ───────────────
{
  const msg = [
    "All sub-steps done; the summary follows.",
    "",
    "Status: DONE",
    "Coverage:",
    "- brief section: done",
    "- parser + card: done",
    "Files: src/spec-report.ts, src/spec-prompt.ts",
    "Tests: npm run typecheck ok, npm run test:unit ok",
    "Follow-ups: none",
  ].join("\n");
  const r = parseWorkerReport(msg);
  check("full: nothing missing", r.missing.length === 0, JSON.stringify(r.missing));
  check("full: status", r.status === "DONE", JSON.stringify(r.status));
  check("full: coverage keeps the multi-line value", r.coverage === "- brief section: done\n- parser + card: done", JSON.stringify(r.coverage));
  check("full: files", r.files === "src/spec-report.ts, src/spec-prompt.ts", JSON.stringify(r.files));
  check("full: tests", r.tests === "npm run typecheck ok, npm run test:unit ok", JSON.stringify(r.tests));
  check("full: follow-ups", r.followUps === "none", JSON.stringify(r.followUps));
}

// ── bullets, lowercase names, empty Follow-ups (may be empty) ───────────────
{
  const msg = "done.\n- status: blocked\n- coverage: - a: skipped (waiting on API)\n- files: a.ts\n- tests: typecheck ok\n- follow-ups:";
  const r = parseWorkerReport(msg);
  check("bullets: lowercase + bulleted markers parse", r.status === "blocked" && r.files === "a.ts" && r.tests === "typecheck ok", JSON.stringify(r));
  check("bullets: empty Follow-ups is PRESENT (empty value), not missing", r.followUps === "" && !r.missing.includes("Follow-ups"), JSON.stringify({ followUps: r.followUps, missing: r.missing }));
  check("bullets: nothing else missing", r.missing.length === 0, JSON.stringify(r.missing));
}

// ── partial block: missing reported in schema order ─────────────────────────
{
  const r = parseWorkerReport("Status: DONE\nFiles: a.ts");
  check("partial: missing = Coverage, Tests, Follow-ups (schema order)", r.missing.join(",") === "Coverage,Tests,Follow-ups", JSON.stringify(r.missing));
  check("partial: present fields still extracted", r.status === "DONE" && r.files === "a.ts", JSON.stringify({ status: r.status, files: r.files }));
}

// ── no block at all ─────────────────────────────────────────────────────────
{
  const r = parseWorkerReport("Just finished, hope that is fine.");
  check("none: all five fields missing, in schema order", r.missing.join(",") === REPORT_FIELDS.join(","), JSON.stringify(r.missing));
  check("none: no values at all", r.status === undefined && r.coverage === undefined && r.files === undefined && r.tests === undefined && r.followUps === undefined);
}

// ── a mid-line `Files:` mention is NOT a field ──────────────────────────────
{
  const r = parseWorkerReport("The Files: list above is complete.");
  check("mid-line: 'the Files: list' does not match", r.files === undefined && r.missing.includes("Files"), JSON.stringify(r.missing));
}

// ── a decorative `Report:` header line is ignored ───────────────────────────
{
  const r = parseWorkerReport("Report:\nStatus: DONE\nCoverage: x\nFiles: a\nTests: t\nFollow-ups: f");
  check("header: 'Report:' line ignored, all fields found", r.missing.length === 0 && r.status === "DONE", JSON.stringify(r));
}

// ── repeated marker: the first occurrence wins ──────────────────────────────
{
  const r = parseWorkerReport("Status: DONE\nStatus: FAILED\nFiles: a");
  check("repeat: first Status wins", r.status === "DONE", JSON.stringify(r.status));
  check("repeat: files still parsed", r.files === "a", JSON.stringify(r.files));
}

// ── CRLF line endings ───────────────────────────────────────────────────────
{
  const r = parseWorkerReport("Status: DONE\r\nCoverage: c\r\nFiles: f\r\nTests: t\r\nFollow-ups: ");
  check("crlf: all fields found on \\r\\n lines", r.missing.length === 0 && r.coverage === "c" && r.followUps === "", JSON.stringify(r));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll T2 spec-report parser checks passed.");
