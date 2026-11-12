/**
 * R4 (docs/sdd/quick-replies.md, R5.2): tap-rate + model-compliance summary
 * for quick replies, straight from the audit log.
 *
 * Reads the JSONL audit log the bot writes (default <repo>/data/audit.log),
 * counts suggest_shown / suggest_tap / suggest_none, and prints:
 *   - eligibility: eligible replies (shown + none), compliance = shown /
 *     eligible (how often the model followed the instruction);
 *   - tap rate: taps / shown (how often the user picked an option).
 * A plain-vs-manager breakdown follows (meta.manager on the events).
 *
 * Read-only. Run:  npx tsx scripts/suggest-tap-rate.ts [path/to/audit.log]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logPath = resolve(process.argv[2] ?? join(root, "data", "audit.log"));

if (!existsSync(logPath)) {
  console.log(`no audit log at ${logPath}`);
  process.exit(0);
}

let shown = 0;
let taps = 0;
let none = 0;
let optTotal = 0;
let optsSeen = 0;
const byScope = new Map<string, { shown: number; tap: number }>();

for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let ev: { action?: string; meta?: { count?: unknown; idx?: unknown; manager?: unknown } };
  try {
    ev = JSON.parse(line) as typeof ev;
  } catch {
    continue; // torn/malformed line — never die on the log
  }
  const scope = ev.meta?.manager === true ? "manager" : "plain";
  const bump = (field: "shown" | "tap") => {
    const s = byScope.get(scope) ?? { shown: 0, tap: 0 };
    s[field] += 1;
    byScope.set(scope, s);
  };
  if (ev.action === "suggest_shown") {
    shown++;
    bump("shown");
    if (typeof ev.meta?.count === "number") {
      optTotal += ev.meta.count;
      optsSeen++;
    }
  } else if (ev.action === "suggest_tap") {
    taps++;
    bump("tap");
  } else if (ev.action === "suggest_none") {
    none++;
  }
}

const eligible = shown + none;
if (eligible === 0 && taps === 0) {
  console.log(`no suggest events in ${logPath} (feature off, or not run yet)`);
  process.exit(0);
}

const pct = (t: number, s: number) => (s > 0 ? `${((t / s) * 100).toFixed(1)}%` : "-");
console.log(`audit log: ${logPath}\n`);
console.log(`${"eligible".padEnd(10)} ${"shown".padStart(6)} ${"none".padStart(6)} ${"compliance".padStart(11)} ${"tap".padStart(5)} ${"tap%".padStart(7)}`);
console.log(
  `${String(eligible).padStart(10)} ${String(shown).padStart(6)} ${String(none).padStart(6)} ${pct(shown, eligible).padStart(11)} ${String(taps).padStart(5)} ${pct(taps, shown).padStart(7)}`,
);
if (optsSeen > 0) {
  console.log(`\navg options per shown reply: ${(optTotal / optsSeen).toFixed(1)}`);
}
console.log(`\nby scope (shown / tap / tap%):`);
for (const scope of ["plain", "manager"]) {
  const s = byScope.get(scope) ?? { shown: 0, tap: 0 };
  if (s.shown === 0 && s.tap === 0) continue;
  console.log(`${scope.padEnd(8)} shown ${String(s.shown).padStart(5)}  tap ${String(s.tap).padStart(4)}  ${pct(s.tap, s.shown)}`);
}
