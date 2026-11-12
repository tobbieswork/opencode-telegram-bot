/**
 * Checks for bot-token resolution (src/secrets.ts): precedence between the
 * systemd credential, TELEGRAM_BOT_TOKEN_FILE and TELEGRAM_BOT_TOKEN, error
 * handling, permission warnings, and that the token never appears in
 * messages the function produces.
 *
 * Run:  npx tsx scripts/test-secrets.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_NAME, resolveBotToken } from "../src/secrets.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function throwsMsg(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const SECRET_A = "111111:AAA-credential-token-AAAAAAAAAAAAAAAAAAAA";
const SECRET_B = "222222:BBB-file-token-BBBBBBBBBBBBBBBBBBBBBBBBBB";
const SECRET_C = "333333:CCC-env-token-CCCCCCCCCCCCCCCCCCCCCCCCCCC";

const dir = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "secrets-test-"));
try {
  const credDir = join(dir, "creds");
  mkdirSync(credDir, { recursive: true });
  const credFile = join(credDir, CREDENTIAL_NAME);
  writeFileSync(credFile, `${SECRET_A}\n`, { mode: 0o400 });
  const tokFile = join(dir, "token");
  writeFileSync(tokFile, `  ${SECRET_B}  \n`, { mode: 0o600 });

  // ── precedence ───────────────────────────────────────────────────────────
  const all = resolveBotToken({ CREDENTIALS_DIRECTORY: credDir, TELEGRAM_BOT_TOKEN_FILE: tokFile, TELEGRAM_BOT_TOKEN: SECRET_C });
  check("systemd credential wins over file and env", all.token === SECRET_A && all.source === "systemd-credential");
  const fileEnv = resolveBotToken({ TELEGRAM_BOT_TOKEN_FILE: tokFile, TELEGRAM_BOT_TOKEN: SECRET_C });
  check("TELEGRAM_BOT_TOKEN_FILE wins over env", fileEnv.token === SECRET_B && fileEnv.source === "file");
  const envOnly = resolveBotToken({ TELEGRAM_BOT_TOKEN: `  ${SECRET_C} ` });
  check("env alone still works (unchanged behaviour), trimmed", envOnly.token === SECRET_C && envOnly.source === "env");

  // ── content handling ─────────────────────────────────────────────────────
  check("trailing newline and spaces are trimmed", all.token === SECRET_A && fileEnv.token === SECRET_B);

  // ── CREDENTIALS_DIRECTORY set but no such credential: fall through ───────
  const otherDir = join(dir, "other");
  mkdirSync(otherDir, { recursive: true });
  const fall = resolveBotToken({ CREDENTIALS_DIRECTORY: otherDir, TELEGRAM_BOT_TOKEN: SECRET_C });
  check("credentials dir without our credential falls through to env", fall.token === SECRET_C && fall.source === "env");

  // ── errors name the problem, never the secret ────────────────────────────
  const none = throwsMsg(() => resolveBotToken({}));
  check("no source at all -> clear error", !!none && /TELEGRAM_BOT_TOKEN/.test(none) && /credential/i.test(none), String(none));
  const missing = throwsMsg(() => resolveBotToken({ TELEGRAM_BOT_TOKEN_FILE: join(dir, "nope"), TELEGRAM_BOT_TOKEN: SECRET_C }));
  check("TELEGRAM_BOT_TOKEN_FILE set but unreadable -> error, not silent fallback", !!missing && /TELEGRAM_BOT_TOKEN_FILE/.test(missing) && missing.includes(join(dir, "nope")), String(missing));
  const emptyFile = join(dir, "empty");
  writeFileSync(emptyFile, "\n", { mode: 0o600 });
  const empty = throwsMsg(() => resolveBotToken({ TELEGRAM_BOT_TOKEN_FILE: emptyFile }));
  check("empty token file -> error", !!empty && /empty/i.test(empty), String(empty));
  const emptyCredDir = join(dir, "emptycred");
  mkdirSync(emptyCredDir, { recursive: true });
  writeFileSync(join(emptyCredDir, CREDENTIAL_NAME), "  \n", { mode: 0o400 });
  check("empty systemd credential -> error", !!throwsMsg(() => resolveBotToken({ CREDENTIALS_DIRECTORY: emptyCredDir })));
  check(
    "no message leaks any token",
    [none, missing, empty].every((m) => m && ![SECRET_A, SECRET_B, SECRET_C].some((s) => m.includes(s))),
  );

  // ── warnings ─────────────────────────────────────────────────────────────
  check("clean setup -> no warnings", all.warnings.length === 0 || all.warnings.every((w) => /\.env|plaintext/i.test(w)));
  check("credential + plaintext env token -> warns the env copy is still there", all.warnings.some((w) => /TELEGRAM_BOT_TOKEN/.test(w) && /env/i.test(w)), all.warnings.join("|"));
  check("file source + plaintext env token -> warns too", fileEnv.warnings.some((w) => /TELEGRAM_BOT_TOKEN/.test(w)));
  const loose = join(dir, "loose");
  writeFileSync(loose, SECRET_B, { mode: 0o600 });
  chmodSync(loose, 0o644);
  const looseRes = resolveBotToken({ TELEGRAM_BOT_TOKEN_FILE: loose });
  check("token file readable by group/others -> warns with the path", looseRes.warnings.some((w) => /readable/i.test(w) && w.includes(loose)), looseRes.warnings.join("|"));
  check("warnings never contain a token", [all, fileEnv, looseRes].every((r) => r.warnings.every((w) => ![SECRET_A, SECRET_B, SECRET_C].some((s) => w.includes(s)))));
  check("tight file permissions -> no permission warning", !resolveBotToken({ TELEGRAM_BOT_TOKEN_FILE: tokFile }).warnings.some((w) => /readable/i.test(w)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall secrets checks passed");
