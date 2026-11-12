/**
 * S6 (docs/sdd/next-step-buttons.md, N4.3): tap-rate summary for the
 * rule-based next-step buttons, straight from the audit log.
 *
 * Reads the JSONL audit log the bot writes (default <repo>/data/audit.log,
 * same path as src/index.ts), counts nextstep_shown / nextstep_tap per rule
 * id (meta.rule), and prints: rule | shown | tap | tap% (+ total row).
 *
 * Read-only. Run:  npx tsx scripts/nextstep-tap-rate.ts [path/to/audit.log]
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

const shown = new Map<string, number>();
const taps = new Map<string, number>();
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let ev: { action?: string; meta?: { rule?: unknown } };
  try {
    ev = JSON.parse(line) as typeof ev;
  } catch {
    continue; // torn/malformed line — never die on the log
  }
  const rule = ev.meta?.rule;
  if (typeof rule !== "string") continue;
  if (ev.action === "nextstep_shown") shown.set(rule, (shown.get(rule) ?? 0) + 1);
  else if (ev.action === "nextstep_tap") taps.set(rule, (taps.get(rule) ?? 0) + 1);
}

const rules = [...new Set([...shown.keys(), ...taps.keys()])].sort();
if (rules.length === 0) {
  console.log(`no nextstep events in ${logPath} (feature off, or not run yet)`);
  process.exit(0);
}

const pct = (t: number, s: number) => (s > 0 ? `${((t / s) * 100).toFixed(1)}%` : "-");
const fmt = (rule: string, s: number, t: number) =>
  `${rule.padEnd(10)} ${String(s).padStart(5)} ${String(t).padStart(4)} ${pct(t, s).padStart(7)}`;

let totalShown = 0;
let totalTap = 0;
console.log(`audit log: ${logPath}\n`);
console.log(`${"rule".padEnd(10)} ${"shown".padStart(5)} ${"tap".padStart(4)} ${"tap%".padStart(7)}`);
for (const r of rules) {
  const s = shown.get(r) ?? 0;
  const t = taps.get(r) ?? 0;
  totalShown += s;
  totalTap += t;
  console.log(fmt(r, s, t));
}
console.log(fmt("total", totalShown, totalTap));
