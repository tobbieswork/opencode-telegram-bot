/**
 * Checks the i18n helper (src/i18n.ts) — the tr() function and the initial
 * string table.
 *
 * Run:  npx tsx scripts/test-i18n.ts
 */
import { tr, STRINGS } from "../src/i18n.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── tr() helper ──────────────────────────────────────────────────────────────────────
{
  check("tr(vi) returns vi string", tr("vi", "Xin chào", "Hello") === "Xin chào");
  check("tr(en) returns en string", tr("en", "Xin chào", "Hello") === "Hello");

  // The lang set command strings
  check("lang_set_vi (vi lang)", tr("vi", STRINGS.lang_set_vi.vi, STRINGS.lang_set_vi.en) === STRINGS.lang_set_vi.vi);
  check("lang_set_en (en lang)", tr("en", STRINGS.lang_set_en.vi, STRINGS.lang_set_en.en) === STRINGS.lang_set_en.en);
  check("lang_set_en (vi lang shows vi)", tr("vi", STRINGS.lang_set_en.vi, STRINGS.lang_set_en.en) === STRINGS.lang_set_en.vi);

  // Worker template strings
  check("worker_task vi", tr("vi", STRINGS.worker_task.vi, STRINGS.worker_task.en) === "Nhiệm vụ");
  check("worker_task en", tr("en", STRINGS.worker_task.vi, STRINGS.worker_task.en) === "Task");
  check("worker_assigned_by vi", tr("vi", STRINGS.worker_assigned_by.vi, STRINGS.worker_assigned_by.en) === "Giao bởi Manager");
  check("worker_assigned_by en", tr("en", STRINGS.worker_assigned_by.vi, STRINGS.worker_assigned_by.en) === "Assigned by Manager");
}

// ── STRINGS table integrity ─────────────────────────────────────────────────────────
{
  const keys = Object.keys(STRINGS);
  check("table has entries", keys.length >= 6, `${keys.length} keys`);

  // Every entry has non-empty vi and en
  const bad = keys.filter((k) => !STRINGS[k].vi.trim() || !STRINGS[k].en.trim());
  check("all entries have non-empty vi+en", bad.length === 0, bad.join(","));

  // vi and en differ (they should be actual translations, not copies)
  const same = keys.filter((k) => STRINGS[k].vi === STRINGS[k].en);
  // lang_set_en is the one exception: "English" is the same in both languages
  const unexpectedSame = same.filter((k) => k !== "lang_set_en");
  check("vi≠en for all but lang_set_en", unexpectedSame.length === 0, unexpectedSame.join(","));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll i18n checks passed.");
