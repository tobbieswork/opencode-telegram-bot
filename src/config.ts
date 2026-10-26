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
  /** Set a per-session "reply in the user's language" instruction (stops CJK leaks); off removes it. */
  guideLanguage: boolean;
  /** Show a live "agent is doing…" activity line while a turn runs. */
  activity: boolean;
  /** Remind the user about a pending question-form / permission they haven't answered. */
  remind: boolean;
  /** Base delay (ms) before the FIRST reminder for a pending form/permission. */
  remindBaseMs: number;
  /** Multiplier applied after each reminder (exponential backoff, not a fixed interval). */
  remindFactor: number;
  /** Max number of reminders before we stop nudging (the prompt stays pending). */
  remindMax: number;
  defaultAgent?: string;
  defaultModel?: ModelRef;
  /** Default reasoning variant applied to each session (e.g. "xhigh"); overridable via /variants. */
  defaultVariant: string;
  /** Directories the folder browser is allowed to walk (also where workers may run). */
  browseRoots: string[];
  /** Where each chat's Manager session lives (`<managerDir>/<chatId>`); holds its agent file. */
  managerDir: string;
  /** Max workers per chat that may be busy at once (running or waiting). */
  maxWorkers: number;
  /** Git worktree isolation for writing workers: "auto" (when another writer shares the repo), "always", "off". */
  worktreeMode: "auto" | "always" | "off";
  /** Port of the Manager's local MCP bridge (0 = pick a free one). */
  bridgePort: number;
  /** Close a worker's topic when the worker finishes (the user reopens it by messaging in it). */
  autoClose: boolean;
  /** Nudge the user to reboot the machine when uptime passes the threshold (kernel updates). */
  uptimeMonitor: boolean;
  /** Reboot the machine (with confirmation) when uptime reaches this many days. */
  uptimeThresholdDays: number;
  /** After a snooze, how many days before the reboot reminder fires again. */
  uptimeRemindIntervalDays: number;
  /** Delay (ms) between tapping "confirm reboot" and the actual reboot, so the message gets delivered. */
  rebootDelayMs: number;
  /**
   * Auto-respawn a worker that died from context overflow (a fresh session in
   * the SAME directory/worktree, handed the original task + git evidence).
   * Bounded to one respawn per original task. Default OFF (it spends tokens and runs
   * a write agent unattended): enable with OPENCODE_TG_RECOVER_OVERFLOW=1.
   */
  recoverOverflow: boolean;
  /** Self-heal stale VPN DNS: restart systemd-resolved after repeated fetch failures. */
  dnsHeal: boolean;
  /** The VPN's DNS server IP that lingers after an unclean VPN stop (empty = heal stays off). */
  dnsStaleIp: string;
  /** Consecutive network failures before the DNS heal is allowed to run. */
  dnsHealMinFailures: number;
  /** Minimum gap between two DNS heals, ms. */
  dnsHealCooldownMs: number;
  /** Send final model replies as native rich Markdown (server-side GFM) instead of hand-rolled HTML. */
  richReplies: boolean;
  /**
   * Stream a LIVE preview of in-progress replies via `sendMessageDraft`
   * (Bot API 10.1+). Pure preview layer: the final-message path is unchanged
   * (the ephemeral draft is wiped when the real reply is sent). Default OFF.
   */
  stream: boolean;
  /** /usage: percentage of the context window at/above which a session is flagged with a warning mark. */
  usageWarnPct: number;
  /** /usage: maximum number of per-session rows to render (the rest are counted, not listed). */
  usageMaxRows: number;
  /** /usage: a session untouched for this many hours is shown as "dead" (collapsed). */
  usageActiveHours: number;
  /**
   * Watch the configured GitHub repo for PR activity (merged / new review
   * comments / CI status / reviews) and post ONE line to the main chat per
   * change. GitHub has no self-hosted webhook here, so this polls on an
   * interval. Default OFF: enable with OPENCODE_TG_PR_WATCH=1.
   */
  prWatch: boolean;
   /** The GitHub repo to watch, "owner/repo" (empty = watcher stays off even if enabled). */
  prWatchRepo: string;
  /** Poll interval for the PR watcher, ms (floor 60s). */
  prWatchIntervalMs: number;
  /**
   * Telegram reaction UX: the user reacts to indexed messages (🚀 spawn a
   * worker, 👍 approve / 👎 reject a worker's DONE report) and the bot itself
   * reacts (🤔 on a new prompt, 🎉 on a worker done, 👎 on a failed turn).
   * Default OFF: enable with OPENCODE_TG_REACT=1 (needs "message_reaction"
   * delivery — the bot is admin, and the update is in allowed_updates).
   */
  react: boolean;
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
    guideLanguage: process.env.OPENCODE_TG_LANGUAGE !== "0",
    activity: process.env.OPENCODE_TG_ACTIVITY !== "0",
    remind: process.env.OPENCODE_TG_REMIND !== "0",
    // parseIntSetting/parseFloatSetting guard against a non-numeric env value (e.g.
    // OPENCODE_TG_REMIND_MAX=abc) yielding NaN, which would make the backoff fire ~every ms.
    remindBaseMs: parseIntSetting("OPENCODE_TG_REMIND_BASE_MS", 5 * 60_000, 1000),
    remindFactor: parseFloatSetting("OPENCODE_TG_REMIND_FACTOR", 2, 1),
    remindMax: parseIntSetting("OPENCODE_TG_REMIND_MAX", 4, 1),
    defaultVariant: process.env.OPENCODE_DEFAULT_VARIANT?.trim() || "xhigh",
    browseRoots: [],
    managerDir: resolve(process.env.OPENCODE_TG_MANAGER_DIR?.trim() || resolve(root, "data/manager")),
    maxWorkers: parseIntSetting("OPENCODE_TG_MAX_WORKERS", 5, 1),
    worktreeMode: parseWorktreeMode(process.env.OPENCODE_TG_WORKTREE),
    bridgePort: parseIntSetting("OPENCODE_TG_BRIDGE_PORT", 0, 0),
    autoClose: process.env.OPENCODE_TG_AUTO_CLOSE !== "0",
    uptimeMonitor: process.env.OPENCODE_TG_UPTIME_MONITOR !== "0",
    uptimeThresholdDays: parseIntSetting("OPENCODE_TG_UPTIME_THRESHOLD_DAYS", 30, 1),
    uptimeRemindIntervalDays: parseIntSetting("OPENCODE_TG_UPTIME_REMIND_INTERVAL_DAYS", 3, 1),
    rebootDelayMs: parseIntSetting("OPENCODE_TG_REBOOT_DELAY_MS", 15000, 1000),
    recoverOverflow: process.env.OPENCODE_TG_RECOVER_OVERFLOW === "1" || process.env.OPENCODE_TG_RECOVER_OVERFLOW === "true",
    dnsHeal: process.env.OPENCODE_TG_DNS_HEAL !== "0",
    dnsStaleIp: process.env.OPENCODE_TG_DNS_STALE_IP?.trim() ?? "",
    dnsHealMinFailures: parseIntSetting("OPENCODE_TG_DNS_HEAL_MIN_FAILURES", 3, 1),
    dnsHealCooldownMs: parseIntSetting("OPENCODE_TG_DNS_HEAL_COOLDOWN_MS", 10 * 60_000, 1000),
    // Default OFF: only an explicit "1"/"true" enables rich (server-side GFM) replies.
    richReplies: process.env.OPENCODE_TG_RICH === "1" || process.env.OPENCODE_TG_RICH === "true",
    // Default OFF: only an explicit "1"/"true" enables live streaming drafts.
    stream: process.env.OPENCODE_TG_STREAM === "1" || process.env.OPENCODE_TG_STREAM === "true",
    usageWarnPct: parseIntSetting("OPENCODE_TG_USAGE_WARN_PCT", 80, 1),
    usageMaxRows: parseIntSetting("OPENCODE_TG_USAGE_MAX_ROWS", 10, 1),
    usageActiveHours: parseIntSetting("OPENCODE_TG_USAGE_ACTIVE_HOURS", 24, 1),
    prWatch: process.env.OPENCODE_TG_PR_WATCH === "1" || process.env.OPENCODE_TG_PR_WATCH === "true",
    prWatchRepo: process.env.OPENCODE_TG_PR_WATCH_REPO?.trim() ?? "",
    prWatchIntervalMs: parseIntSetting("OPENCODE_TG_PR_WATCH_INTERVAL_MS", 5 * 60_000, 60_000),
    // Default OFF: only an explicit "1"/"true" enables the reaction UX.
    react: process.env.OPENCODE_TG_REACT === "1" || process.env.OPENCODE_TG_REACT === "true",
  };
  const agent = process.env.OPENCODE_DEFAULT_AGENT?.trim();
  if (agent) cfg.defaultAgent = agent;
  const modelId = process.env.OPENCODE_DEFAULT_MODEL_ID?.trim();
  const modelProvider = process.env.OPENCODE_DEFAULT_MODEL_PROVIDER?.trim();
  if (modelId && modelProvider) cfg.defaultModel = { id: modelId, providerID: modelProvider };
  cfg.browseRoots = loadBrowseRoots(cfg.opencodeDirectory);
  return cfg;
}

/** An integer setting; anything unparsable or below `min` falls back to the default (with a warning). */
function parseIntSetting(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min) return n;
  warn(`${name}=${raw} is not a whole number >= ${min} — using ${fallback}`);
  return fallback;
}

/** A float setting; anything non-finite or below `min` falls back to the default (with a warning). */
function parseFloatSetting(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= min) return n;
  warn(`${name}=${raw} is not a number >= ${min} — using ${fallback}`);
  return fallback;
}

function parseWorktreeMode(raw?: string): Config["worktreeMode"] {
  const v = raw?.trim().toLowerCase();
  return v === "always" || v === "off" ? v : "auto";
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
