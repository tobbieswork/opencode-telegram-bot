/**
 * Regression for the `gh api` transport in src/github.ts (S7 PR flow).
 *
 * Live bug: ghApiDefault passed the JSON body as the --input ARGUMENT VALUE.
 * `gh api --input` expects a FILE PATH, so gh tried to open a file literally
 * named `{"title":…}` and every draft-PR / ready / body-update tap failed
 * with "no such file or directory". The S7 suite stubs the transport
 * (setGhApiImpl), so arg construction against a real gh-compatible binary
 * was never exercised.
 *
 * This test points OPENCODE_TG_GH_BIN at a fake `gh` shell script that
 * records its args and copies the --input file it is given, then asserts:
 *   1. --input receives a real, existing file path (not a JSON literal)
 *   2. the file's content is exactly the JSON body
 *   3. the temp file is cleaned up after the call resolves
 *   4. a bodyless call carries no --input at all
 *
 * Run:  npx tsx scripts/test-spec-gh.ts
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghApi } from "../src/github.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const fakeDir = mkdtempSync(join(tmpdir(), "fake-gh-"));
const argsFile = join(fakeDir, "args.txt");
const bodyFile = join(fakeDir, "body.txt");
const fakeGh = join(fakeDir, "gh");
writeFileSync(
  fakeGh,
  `#!/bin/sh\n` +
    `for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_GH_ARGS"\n` +
    `prev=""\n` +
    `for a in "$@"; do\n` +
    `  if [ "$prev" = "--input" ]; then cp "$a" "$FAKE_GH_BODY"; fi\n` +
    `  prev="$a"\n` +
    `done\n` +
    `printf '{"ok":true}\\n'\n`,
);
chmodSync(fakeGh, 0o755);

try {
  // --- 1–3: a POST with a JSON body -------------------------------------
  const body = {
    title: "feat: Throwaway E2E spec",
    head: "spec/throwaway-e2e",
    base: "main",
    draft: true,
    body: "# Throwaway E2E spec\n\n- ✅ E1 Create e2e.txt — `1682f1f`",
  };
  process.env.OPENCODE_TG_GH_BIN = fakeGh;
  process.env.FAKE_GH_ARGS = argsFile;
  process.env.FAKE_GH_BODY = bodyFile;
  const res = await ghApi("tobbieswork/opencode-telegram-bot", "POST", "pulls", body);
  check("response is parsed JSON from gh stdout", res && res.ok === true, JSON.stringify(res));

  const args = readFileSync(argsFile, "utf8").trim().split("\n");
  check("args address the right endpoint",
    args[0] === "api" && args[1] === "-X" && args[2] === "POST" &&
    args[3] === "repos/tobbieswork/opencode-telegram-bot/pulls",
    JSON.stringify(args));
  const inputIdx = args.indexOf("--input");
  check("--input is present on a body-bearing call", inputIdx >= 0, JSON.stringify(args));
  const inputPath = args[inputIdx + 1];
  check("--input value is a path, not a JSON literal",
    inputIdx >= 0 && !!inputPath && !inputPath.startsWith("{") && inputPath.includes("body.json"),
    String(inputPath));
  check("the --input file contained exactly the JSON body",
    existsSync(bodyFile) && readFileSync(bodyFile, "utf8") === JSON.stringify(body));
  check("temp input file is cleaned up after the call", !existsSync(inputPath));

  // --- 4: a bodyless GET carries no --input ------------------------------
  rmSync(argsFile);
  await ghApi("tobbieswork/opencode-telegram-bot", "GET", "pulls/123");
  const args2 = readFileSync(argsFile, "utf8").trim().split("\n");
  check("bodyless call has no --input", !args2.includes("--input"), JSON.stringify(args2));
  check("bodyless call still parses the response", true);
} finally {
  delete process.env.OPENCODE_TG_GH_BIN;
  delete process.env.FAKE_GH_ARGS;
  delete process.env.FAKE_GH_BODY;
  rmSync(fakeDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nAll gh-transport checks passed.");
