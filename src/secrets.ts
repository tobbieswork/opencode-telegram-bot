/**
 * Where the Telegram bot token comes from.
 *
 * The bot can run code on the host from a Telegram message, so its token is
 * worth more than a typical API key. A plaintext `.env` value is read into
 * process.env, which every child process inherits (the OpenCode service the
 * bot auto-starts runs agents that can `printenv`). Preferred sources, first
 * match wins:
 *
 *   1. systemd credential  `$CREDENTIALS_DIRECTORY/telegram-bot-token`
 *      (LoadCredentialEncrypted= / LoadCredential= in the unit; never in the
 *      environment, never inherited, readable only by the service)
 *   2. `TELEGRAM_BOT_TOKEN_FILE`  path to a file holding the token (use 0600)
 *   3. `TELEGRAM_BOT_TOKEN`       the original behaviour, unchanged
 *
 * Nothing here ever puts a token into an error message or a warning.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** File name of the systemd credential (the unit's `LoadCredential*=` name). */
export const CREDENTIAL_NAME = "telegram-bot-token";

export type TokenSource = "systemd-credential" | "file" | "env";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** Human-readable advisories (never contain the token). */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function resolveBotToken(env: Env): ResolvedToken {
  const warnings: string[] = [];
  const envToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const stillInEnv = (): void => {
    if (envToken) {
      warnings.push(
        "TELEGRAM_BOT_TOKEN is still set in the environment/.env (plaintext, inherited by child processes) — remove it now that the token comes from a safer source.",
      );
    }
  };

  // 1. systemd credential. The directory is set for ANY credential the unit
  //    loads, so a missing file just means this one isn't configured.
  const credDir = env.CREDENTIALS_DIRECTORY?.trim();
  if (credDir) {
    const credPath = join(credDir, CREDENTIAL_NAME);
    const raw = readTrimmed(credPath);
    if (raw !== undefined) {
      if (!raw) throw new Error(`The systemd credential "${CREDENTIAL_NAME}" (${credPath}) is empty.`);
      stillInEnv();
      return { token: raw, source: "systemd-credential", warnings };
    }
  }

  // 2. Explicit file. If it is configured it must work: no silent fallback to
  //    a different (possibly stale) token.
  const file = env.TELEGRAM_BOT_TOKEN_FILE?.trim();
  if (file) {
    const raw = readTrimmed(file);
    if (raw === undefined) throw new Error(`TELEGRAM_BOT_TOKEN_FILE is set but ${file} cannot be read.`);
    if (!raw) throw new Error(`TELEGRAM_BOT_TOKEN_FILE ${file} is empty.`);
    try {
      if ((statSync(file).mode & 0o077) !== 0) {
        warnings.push(`Token file ${file} is readable by group/others — run: chmod 600 ${file}`);
      }
    } catch {
      /* stat failed after a successful read: ignore, the read already proved access */
    }
    stillInEnv();
    return { token: raw, source: "file", warnings };
  }

  // 3. Environment (original behaviour).
  if (envToken) return { token: envToken, source: "env", warnings };

  throw new Error(
    "No Telegram bot token found. Provide one of: a systemd credential " +
      `"${CREDENTIAL_NAME}", TELEGRAM_BOT_TOKEN_FILE=<path>, or TELEGRAM_BOT_TOKEN in .env ` +
      "(create a bot with @BotFather).",
  );
}
