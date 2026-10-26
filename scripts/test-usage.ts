/**
 * Checks the /usage report math: context-window pressure (pct), compact token
 * notation, the display sort (worst pressure first, unknowns last), warning
 * thresholds, row capping, and the empty-state. Pure logic only — the network
 * side lives in opencode.ts and is exercised live via /usage.
 *
 * Run:  npx tsx scripts/test-usage.ts
 */
import { UsageRow, pctOf, fmtTok, sortUsage, formatUsageReport, newestAssistantInfo } from "../src/usage.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const esc = (s: string) => s; // no special chars in the test labels

const row = (over: Partial<UsageRow> & { label: string }): UsageRow => ({
  id: over.label,
  cumInput: 0,
  cumOutput: 0,
  ...over,
});

// ── pctOf ────────────────────────────────────────────────────────────────────
{
  check("pct basic", pctOf(50_000, 200_000) === 25);
  check("pct rounds", pctOf(113_123, 200_000) === 57);
  check("pct >100 (window exceeded)", pctOf(300_000, 200_000) === 150);
  check("pct no current → undefined", pctOf(undefined, 200_000) === undefined);
  check("pct no limit → undefined", pctOf(50_000, undefined) === undefined);
  check("pct zero limit → undefined", pctOf(50_000, 0) === undefined);
}

// ── fmtTok ───────────────────────────────────────────────────────────────────
{
  check("fmtTok small", fmtTok(980) === "980");
  check("fmtTok K", fmtTok(12_345) === "12.3K");
  check("fmtTok K whole", fmtTok(12_000) === "12K");
  check("fmtTok M", fmtTok(2_400_000) === "2.4M");
  check("fmtTok M whole", fmtTok(2_000_000) === "2M");
  check("fmtTok 0", fmtTok(0) === "0");
  check("fmtTok NaN-guard", fmtTok(Number.NaN) === "0");
  check("fmtTok negative-guard", fmtTok(-5) === "0");
  // K→M boundary: round before choosing the unit (999 950 is "1M", not "1000K")
  check("fmtTok K→M boundary -1", fmtTok(999_949) === "999.9K", fmtTok(999_949));
  check("fmtTok K→M boundary", fmtTok(999_950) === "1M", fmtTok(999_950));
  check("fmtTok just under M", fmtTok(999_999) === "1M", fmtTok(999_999));
}

// ── newestAssistantInfo: order-independent scan of message.list ─────────────
{
  // Two assistant steps with DIFFERENT token sums, an in-flight newest step
  // (no tokens yet), and a user message in between. The answer must be the
  // NEWEST COMPLETED step's prompt (100 + 200 = 300), never the older one's
  // (900 + 800 = 1700) — so this test fails on any direction-dependent scan.
  const newestFirst = [
    { id: "m4", type: "assistant", time: { created: 4000 }, model: { id: "mod", providerID: "p" } },
    { id: "m3", type: "assistant", time: { created: 3000 }, model: { id: "mod", providerID: "p" },
      tokens: { input: 100, output: 10, cache: { read: 200, write: 0 } } },
    { id: "m2", type: "user", time: { created: 2500 }, text: "hi" },
    { id: "m1", type: "assistant", time: { created: 1000 }, model: { id: "mod", providerID: "p" },
      tokens: { input: 900, output: 50, cache: { read: 800, write: 0 } } },
  ];
  const a = newestAssistantInfo(newestFirst);
  const b = newestAssistantInfo([...newestFirst].reverse());
  check("newest-first: newest completed step's context", a.context === 300, `got ${a.context}`);
  check("model from newest assistant", a.model?.id === "mod" && a.model?.providerID === "p");
  check("oldest-first gives the SAME result (order-independent)",
    b.context === a.context && b.model?.id === a.model?.id, `got ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
  // in-flight newest assistant (no tokens) is skipped for context but still
  // carries the model
  check("in-flight step skipped for context, model kept", a.context === 300 && a.model?.id === "mod");

  // context = input + cache.read + cache.write: a turn that just BUILT the
  // cache has a small input and a large cache.write — all of it is prompt.
  const writeHeavy = [
    { id: "w1", type: "assistant", time: { created: 1000 }, model: { id: "mod", providerID: "p" },
      tokens: { input: 50, output: 10, cache: { read: 0, write: 120_000 } } },
  ];
  const w = newestAssistantInfo(writeHeavy);
  check("context includes cache.write (50 + 0 + 120000)", w.context === 120_050, `got ${w.context}`);

  // the info-wrapped message shape (older clients) resolves identically
  const wrapped = [
    { id: "x1", info: { type: "assistant", time: { created: 1000 }, model: { id: "mod", providerID: "p" },
      tokens: { input: 50, output: 10, cache: { read: 0, write: 120_000 } } } },
  ];
  check("info-wrapped shape gives the same result", newestAssistantInfo(wrapped).context === 120_050);

  // no assistant messages → empty result, no crash
  const none = newestAssistantInfo([{ id: "u1", type: "user", time: { created: 1 }, text: "hi" }]);
  check("no assistant → undefined model+context", none.model === undefined && none.context === undefined);
}

// ── sortUsage: worst pressure first, unknowns last, then cum desc ───────────
{
  const a = row({ label: "a", current: 100_000, limit: 200_000 }); // 50%
  const b = row({ label: "b", current: 170_000, limit: 200_000 }); // 85%
  const c = row({ label: "c", current: 50_000, limit: 200_000 }); // 25%
  const d = row({ label: "d", cumInput: 9_000_000 }); // unknown pct, big
  const e = row({ label: "e", cumInput: 1_000_000 }); // unknown pct, small
  const order = sortUsage([a, b, c, d, e]).map((r) => r.label);
  check(
    "sort order",
    JSON.stringify(order) === JSON.stringify(["b", "a", "c", "d", "e"]),
    `got ${order}`,
  );
  // same pct → fall back to cumulative desc
  const f = row({ label: "f", current: 100_000, limit: 200_000, cumInput: 50_000 });
  const g = row({ label: "g", current: 100_000, limit: 200_000, cumInput: 90_000 });
  const order2 = sortUsage([f, g]).map((r) => r.label);
  check("sort tie → cum desc", JSON.stringify(order2) === JSON.stringify(["g", "f"]), `got ${order2}`);
  // input is not mutated
  const arr = [a, b, c];
  sortUsage(arr);
  check("sort does not mutate", JSON.stringify(arr.map((r) => r.label)) === JSON.stringify(["a", "b", "c"]));
}

// ── formatUsageReport ────────────────────────────────────────────────────────
{
  const empty = formatUsageReport([], esc).join("\n");
  check("empty state", empty.includes("Chưa có session"), empty);

  const rows = [
    row({ label: "quiet", current: 20_000, limit: 200_000, cumInput: 100_000, cumOutput: 10_000 }), // 10%
    row({ label: "danger", current: 170_000, limit: 200_000, cumInput: 7_400_000, cumOutput: 250_000 }), // 85%
  ];
  const out = formatUsageReport(rows, esc).join("\n");
  check("header counts all", out.includes("2 session"), out);
  check("warn count in header", out.includes("⚠️ 1 trên 80%"), out);
  check("worst row first", out.indexOf("danger") < out.indexOf("quiet"), out);
  check("warn mark on ≥80 row", /⚠️ <b>danger<\/b>/.test(out), out);
  check("pct rendered", out.includes("(85%)"), out);
  check("K notation", out.includes("170K/200K"), out);
  check("cum total", out.includes("7.7M"), out);
  check("footer totals", out.includes("7.5M in / 260K out"), out);

  // unknown context (no messages yet) → dash, no crash
  const unknown = formatUsageReport([row({ label: "fresh", limit: 200_000 })], esc).join("\n");
  check("unknown current → dash", unknown.includes("—/200K"), unknown);
  check("unknown current → no pct", !unknown.includes("%)"), unknown);

  // unknown limit (model not in list) → no pct, no warning
  const noLimit = formatUsageReport([row({ label: "orphan", current: 50_000 })], esc).join("\n");
  check("unknown limit → dash", noLimit.includes("50K/—"), noLimit);
  check("unknown limit → no warn", !noLimit.includes("⚠️"), noLimit);

  // warning threshold is configurable (10% catches both rows)
  const strict = formatUsageReport(rows, esc, { warnPct: 10 }).join("\n");
  check("custom warnPct", strict.includes("⚠️ 2 trên 10%"), strict);

  // maxRows caps the listing and counts the hidden rest
  const many = Array.from({ length: 15 }, (_, i) =>
    row({ label: `s${i}`, current: 10_000 + i, limit: 200_000, cumInput: 1_000_000 * (15 - i) }),
  );
  const capped = formatUsageReport(many, esc, { maxRows: 5 }).join("\n");
  check("cap counts hidden", capped.includes("… +10 session khác"), capped);
  const listed = capped.split("\n").filter((l) => /<b>s\d+<\/b> ·/.test(l)).length;
  check("cap limits rows", listed === 5, `listed ${listed}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll usage checks passed.");
