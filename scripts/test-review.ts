/**
 * Checks /review's prompt builder (src/review.ts): the target is validated
 * against a strict whitelist (it ends up in git/gh commands the model runs),
 * and the prompt always carries the read-only + skill instructions.
 *
 * Run:  npx tsx scripts/test-review.ts
 */
import { reviewPrompt, REVIEW_USAGE } from "../src/review.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── valid targets ────────────────────────────────────────────────────────────
for (const t of ["84", "#84", "main..HEAD", "main...feat/x", "staged", "7605bb1", "fix/review-findings", "HEAD~2", "origin/main"]) {
  const p = reviewPrompt(t);
  check(`accepts "${t}"`, p !== null && p.includes(`\`${t}\``), String(p));
}

// ── empty target → default scope ─────────────────────────────────────────────
{
  const p = reviewPrompt("   ");
  check("empty target uses the default scope", p !== null && p.includes("mặc định"), String(p));
}

// ── injection-shaped / malformed targets are rejected, not escaped ───────────
for (const t of ["main; rm -rf /", "$(id)", "`id`", "a b", "x|y", "a&&b", 'a"b', "a'b", "a\nb", "x".repeat(101), "<b>"]) {
  check(`rejects ${JSON.stringify(t.length > 20 ? t.slice(0, 20) + "…" : t)}`, reviewPrompt(t) === null);
}

// ── prompt content ───────────────────────────────────────────────────────────
{
  const p = reviewPrompt("84")!;
  check("prompt names the review-code skill", p.includes("review-code"));
  check("prompt is read-only", p.includes("Chỉ đọc") && p.includes("không sửa file"));
  check("prompt forbids restarting services", p.includes("không restart"));
}

// ── usage text: Telegram HTML sanity ─────────────────────────────────────────
{
  const body = REVIEW_USAGE.replace(/<\/?code>/g, "");
  check("usage has balanced <code> tags", (REVIEW_USAGE.match(/<code>/g) ?? []).length === (REVIEW_USAGE.match(/<\/code>/g) ?? []).length);
  check("usage has no raw < or >", !body.includes("<") && !body.includes(">"), body);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll review checks passed.");
