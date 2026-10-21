import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isUnderRoot } from "./fsbrowser.js";
import { warn } from "./logger.js";
import type { ModelRef } from "./state.js";

/**
 * Minimal .env loader (no dependency). Existing environment variables win,
 * so `env FOO=1 node ...` still overrides a value from the file.
 */
export function loadDotEnv(file = ".env"): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export interface Config {
  telegramToken: string;
  allowedUserIds: number[];
  allowAny: boolean;
  opencodeDirectory: string;
  opencodeServiceUrl?: string;
  opencodeServiceUser?: string;
  opencodeServicePassword?: string;
  stateFile: string;
  replyMaxLen: number;
  /** Prepend a "ask via the question tool" note to the first prompt of each session. */
  guideQuestions: boolean;
  defaultAgent?: string;
  defaultModel?: ModelRef;
  /** Default reasoning variant applied to each session (e.g. "xhigh"); overridable via /variants. */
  defaultVariant: string;
  /** Directories the folder browser is allowed to walk. */
  browseRoots: string[];
}

export function loadConfig(root: string): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather and put the token in .env).");
  }

  const rawIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.trim();
  const allowedUserIds = rawIds
    ? rawIds.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    : [];
  const allowAny = process.env.OPENCODE_TG_ALLOW_ANY === "1";
  if (allowedUserIds.length === 0 && !allowAny) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS is required (comma-separated numeric Telegram user IDs). " +
        "Find yours via @userinfobot. Set OPENCODE_TG_ALLOW_ANY=1 to disable this check (not recommended).",
    );
  }

  const dir = resolve(process.env.OPENCODE_DIRECTORY?.trim() || process.cwd());
  const cfg: Config = {
    telegramToken: token,
    allowedUserIds,
    allowAny,
    opencodeDirectory: dir,
    opencodeServiceUrl: process.env.OPENCODE_SERVICE_URL?.trim() || undefined,
    opencodeServiceUser: process.env.OPENCODE_SERVICE_USER?.trim() || undefined,
    opencodeServicePassword: process.env.OPENCODE_SERVICE_PASSWORD?.trim() || undefined,
    stateFile: resolve(process.env.STATE_FILE?.trim() || resolve(root, "data/state.json")),
    replyMaxLen: Math.max(500, Number(process.env.TELEGRAM_REPLY_MAX_LEN?.trim() || 4000)),
    guideQuestions: process.env.OPENCODE_TG_GUIDE !== "0",
    defaultVariant: process.env.OPENCODE_DEFAULT_VARIANT?.trim() || "xhigh",
    browseRoots: [],
  };
  const agent = process.env.OPENCODE_DEFAULT_AGENT?.trim();
  if (agent) cfg.defaultAgent = agent;
  const modelId = process.env.OPENCODE_DEFAULT_MODEL_ID?.trim();
  const modelProvider = process.env.OPENCODE_DEFAULT_MODEL_PROVIDER?.trim();
  if (modelId && modelProvider) cfg.defaultModel = { id: modelId, providerID: modelProvider };
  cfg.browseRoots = loadBrowseRoots(cfg.opencodeDirectory);
  return cfg;
}

/**
 * Roots the folder browser may walk. Defaults to the home directory; the
 * configured working directory is always included so the project you run the
 * bot from stays reachable.
 */
function loadBrowseRoots(workingDir: string): string[] {
  const raw = process.env.OPENCODE_TG_BROWSE_ROOTS?.trim();
  const candidates = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => resolve(s))
    : [homedir()];
  const roots: string[] = [];
  for (const r of candidates) {
    if (roots.includes(r)) continue;
    if (existsSync(r)) roots.push(r);
    else warn(`BROWSE_ROOTS: ignoring missing directory ${r}`);
  }
  if (!roots.some((r) => isUnderRoot(workingDir, [r]))) roots.push(workingDir);
  return roots;
}
