/**
 * Unit tests for src/sandbox/scriptPreamble.ts — the Zero-Context-Workers
 * "Script Mode" instruction block injected into build workers' preamble.
 *
 * Run:  npx tsx scripts/test-script-preamble.ts
 */
import { scriptInstruction } from "../src/sandbox/scriptPreamble.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const en = scriptInstruction("en");

// ── content ───────────────────────────────────────────────────────────────────
check("returns a string", typeof en === "string", String(typeof en));
check("non-empty", en.length > 0, `len=${en.length}`);
check('contains "Script Mode"', en.includes("Script Mode"));
check("mentions the 60s timeout", /60s/.test(en), en.match(/60s/)?.[0] ?? "no match");

// ── all five allowed tool names ───────────────────────────────────────────────
for (const tool of ["read_file", "write_file", "grep", "glob", "exec"]) {
  check(`lists tool: ${tool}`, en.includes(tool));
}

// ── language-neutral ──────────────────────────────────────────────────────────
check("language-neutral: vi === en", scriptInstruction("vi") === en);
check("language-neutral: fr === en", scriptInstruction("fr") === en);

// ── size budget ───────────────────────────────────────────────────────────────
check("under 1000 chars", en.length < 1000, `len=${en.length}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nAll script-preamble checks passed (${en.length} chars).`);
