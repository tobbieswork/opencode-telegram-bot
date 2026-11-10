/**
 * Doc-sync check: the README must mention every command in the catalog
 * (src/commands.ts) and every OPENCODE_TG_* variable read by src/config.ts.
 * Catches the drift where features ship without docs.
 *
 * Run:  npx tsx scripts/test-doc-sync.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/commands.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const configSrc = readFileSync(join(root, "src", "config.ts"), "utf8");

// Variables that are intentionally undocumented. Keep empty unless justified.
const IGNORED_ENV = new Set<string>([]);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// R1.1: every catalog command appears as `/cmd` in the README.
const missingCmds = COMMANDS.map((c) => c.cmd).filter(
  (cmd) => !new RegExp(`/${cmd}(?![A-Za-z0-9_])`).test(readme),
);
check(
  "every command in src/commands.ts is documented in README",
  missingCmds.length === 0,
  `missing: ${missingCmds.map((c) => `/${c}`).join(", ")}`,
);

// R1.2: every OPENCODE_TG_* variable in config.ts appears in the README.
const envVars = [...new Set(configSrc.match(/OPENCODE_TG_[A-Z0-9_]+/g) ?? [])]
  .filter((v) => !IGNORED_ENV.has(v))
  .sort();
check("config.ts exposes OPENCODE_TG_* variables (sanity)", envVars.length > 10, `found ${envVars.length}`);
const missingEnv = envVars.filter((v) => !new RegExp(`${v}(?![A-Z0-9_])`).test(readme));
check(
  "every OPENCODE_TG_* variable in src/config.ts is documented in README",
  missingEnv.length === 0,
  `missing: ${missingEnv.join(", ")}`,
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall doc-sync checks passed");
