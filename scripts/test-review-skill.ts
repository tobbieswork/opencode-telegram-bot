/**
 * Guardrail pin for the review-code skill (T4, docs/sdd/ocr-hardening.md):
 * .opencode/skills/review-code/SKILL.md must carry the coverage pre-step
 * (list changed files; every file reviewed or skipped with a reason), the
 * citation-existence check (each cited file:line must match the diff), and
 * the coverage table in the output format.
 *
 * Run:  npx tsx scripts/test-review-skill.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, ".opencode", "skills", "review-code", "SKILL.md"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// Coverage pre-step: list the changed files; every file reviewed or skipped with a reason
check("pre-step lists changed files (git diff --name-only)", /git diff --name-only/.test(skill));
check("pre-step: every file reviewed or explicitly skipped with a reason", /every file is either reviewed or explicitly skipped with a reason/i.test(skill));

// Citation-existence check
check("findings must cite file:line", /file:line/.test(skill));
check("citation check: verify each cited line exists in the diff", /each cited line exists in the diff/i.test(skill));
check("citation check: grep the diff for the cited context", /grep -nF/.test(skill));
check("mismatched citation is a finding about the review itself", /finding about the review itself/i.test(skill));

// Output: coverage table, always last
check("output format has a Coverage table", /### Coverage/.test(skill) && /\| File \| Status \|/.test(skill));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall review-skill guardrail checks passed");
