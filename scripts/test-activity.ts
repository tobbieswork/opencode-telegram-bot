/**
 * Checks the pure activity-label helpers: tool → Vietnamese label mapping,
 * input clipping, and the done-line format (✅/❌ + elapsed time).
 *
 * Run:  npx tsx scripts/test-activity.ts
 */
import { clip, toolActivityLabel, activityDoneLine } from "../src/activity.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── clip: whitespace collapse + ellipsis ─────────────────────────────────────
{
  check("clip collapses whitespace", clip("  a   b\tc ") === "a b c");
  check("clip short string untouched", clip("abc") === "abc");
  const long = clip("x".repeat(100));
  check("clip long string truncated to max", long.length === 48, String(long.length));
  check("clip ends with ellipsis", long.endsWith("…"));
}

// ── toolActivityLabel: per-tool labels ───────────────────────────────────────
{
  check("read", toolActivityLabel("read", { path: "src/bot.ts" }) === "📖 Đang đọc src/bot.ts");
  check("write", toolActivityLabel("write", { path: "src/x.ts" }) === "✍️ Đang ghi src/x.ts");
  check("edit", toolActivityLabel("edit", { path: "src/x.ts" }) === "✏️ Đang sửa src/x.ts");
  check("bash", toolActivityLabel("bash", { command: "npm run test:unit" }) === "▶ Đang chạy npm run test:unit");
  check("bash without command", toolActivityLabel("bash", {}) === "▶ Đang chạy lệnh shell");
  check("grep", toolActivityLabel("grep", { pattern: "^export" }) === "🔍 Đang tìm ^export");
  check("webfetch", toolActivityLabel("webfetch", { url: "https://example.com" }) === "🌐 Đang xem https://example.com");
  check("unknown tool falls back to name", toolActivityLabel("mystery_tool", {}) === "🔧 Đang dùng mystery_tool");
  check("missing input tolerated", toolActivityLabel("read", undefined) === "📖 Đang đọc ");
  check("bash command is clipped", toolActivityLabel("bash", { command: "x".repeat(80) }).length === 72);
}

// ── activityDoneLine: ✅/❌ + done verb + optional elapsed ────────────────────
{
  const ok = activityDoneLine("📖 Đang đọc src/bot.ts", true, 1.256);
  check("done ok mark", ok.startsWith("✅"), ok);
  check("done verb swapped to Đã", ok.includes("Đã đọc"), ok);
  check("done elapsed rounded", ok.includes("1.3s"), ok);
  const bad = activityDoneLine("▶ Đang chạy npm test", false);
  check("done fail mark", bad.startsWith("❌"), bad);
  check("done fail has no elapsed", !/\d+\.\d+s/.test(bad), bad);
  check("done line without 'Đang' untouched", activityDoneLine("❓ Đang hỏi", true, 0) === "✅ ❓ Đã hỏi · 0.0s");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
