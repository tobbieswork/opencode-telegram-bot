/**
 * The concrete probe set behind /health. It reads plain facts about each
 * subsystem (a "HealthSources" bag the Bot fills from the state it already
 * keeps) and turns them into Probes for collectHealth(). No timers, no
 * network of its own beyond the two explicit liveness pings handed in
 * (OpenCode info, advisor /health) — everything else is a getter.
 */
import { execFile } from "node:child_process";
import { readFileSync, type Dirent } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Probe } from "./health.js";

export interface HealthSources {
  /** Cheap read of the OpenCode server; throws when unreachable. */
  opencode: () => Promise<{ version?: string }>;
  /** `enabled` = a Manager chat exists; `check` asks OpenCode whether tg-bridge is connected. */
  bridge: { enabled: boolean; check: () => Promise<{ ok: boolean; detail?: string }> };
  /** lastTickAt = epoch ms of the latest tick pass (0 = none yet). */
  scheduler: { enabled: boolean; lastTickAt: number; tickMs: number };
  prWatch: { enabled: boolean; intervalMs: number; lastOkAt?: number; lastError?: string };
  /** ping resolves null when the daemon is unreachable. */
  advisor: { enabled: boolean; ping: () => Promise<{ ok: boolean; sessions: number } | null> };
  /** The monitor re-checks every 6h. */
  uptime: { enabled: boolean; lastOkAt?: number };
  dnsHeal: { enabled: boolean; consecutiveFailures: number; minFailures: number; healCount: number; lastPollOkAt?: number };
  /** The disk probe always runs (host-level, like the OpenCode probe). */
  disk: {
    /** Warn (not fail) when the filesystem free space drops below this many bytes. */
    warnFreeBytes: number;
    /** Resolves to plain disk facts; the probe only interprets them. */
    facts: () => Promise<DiskFacts>;
  };
}

/** Plain disk facts the Bot measures; the probe only interprets them. */
export interface DiskFacts {
  /** Bytes used under the OpenCode home dir (~/.opencode). */
  opencodeBytes: number;
  /** Bytes used under the bot's data dir. */
  dataBytes: number;
  /** Free bytes on the filesystem hosting the data dir (null = unknown). */
  freeBytes: number | null;
  /** Optional SMART summary (null = not available). */
  smart: string | null;
}

/** A tick-driven subsystem is "stale" after missing this many of its own intervals. */
const MISSED_INTERVALS = 3;
/** The uptime monitor checks every 6h; allow one missed pass plus slack. */
const UPTIME_STALE_MS = 13 * 3600_000;

export function buildProbes(src: HealthSources, now: () => number): Probe[] {
  return [
    {
      id: "opencode",
      enabled: true,
      check: async () => {
        try {
          const info = await src.opencode();
          return { ok: true, lastOkAt: now(), detail: info.version ? `v${info.version}` : undefined };
        } catch (e) {
          return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    { id: "mcp-bridge", enabled: src.bridge.enabled, check: () => src.bridge.check() },
    {
      id: "scheduler",
      enabled: src.scheduler.enabled,
      check: () =>
        src.scheduler.lastTickAt > 0
          ? { ok: true, lastOkAt: src.scheduler.lastTickAt, staleAfterMs: src.scheduler.tickMs * MISSED_INTERVALS }
          : { ok: true },
    },
    {
      id: "pr-watch",
      enabled: src.prWatch.enabled,
      check: () =>
        src.prWatch.lastError
          ? { ok: false, lastOkAt: src.prWatch.lastOkAt, detail: src.prWatch.lastError }
          : { ok: true, lastOkAt: src.prWatch.lastOkAt, staleAfterMs: src.prWatch.intervalMs * MISSED_INTERVALS },
    },
    {
      id: "advisor",
      enabled: src.advisor.enabled,
      check: async () => {
        const h = await src.advisor.ping();
        if (!h) return { ok: false, detail: "unreachable" };
        if (!h.ok) return { ok: false, detail: "daemon unhealthy" };
        return { ok: true, lastOkAt: now(), detail: `${h.sessions} sessions` };
      },
    },
    {
      id: "uptime",
      enabled: src.uptime.enabled,
      check: () => ({ ok: true, lastOkAt: src.uptime.lastOkAt, staleAfterMs: UPTIME_STALE_MS }),
    },
    {
      id: "dns-heal",
      enabled: src.dnsHeal.enabled,
      check: () => {
        const d = src.dnsHeal;
        const heals = d.healCount > 0 ? `${d.healCount} heals` : undefined;
        if (d.consecutiveFailures >= d.minFailures) {
          return { ok: false, lastOkAt: d.lastPollOkAt, detail: `${d.consecutiveFailures} network failures${heals ? ` · ${heals}` : ""}` };
        }
        return { ok: true, lastOkAt: d.lastPollOkAt, detail: heals };
      },
    },
    {
      id: "disk",
      enabled: true,
      check: async () => {
        let f: DiskFacts;
        try {
          f = await src.disk.facts();
        } catch (e) {
          return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
        const low = f.freeBytes != null && f.freeBytes < src.disk.warnFreeBytes;
        const parts = [
          `opencode ${fmtBytes(f.opencodeBytes)}`,
          `data ${fmtBytes(f.dataBytes)}`,
          f.freeBytes != null ? `free ${fmtBytes(f.freeBytes)}${low ? " (low)" : ""}` : "free ?",
        ];
        if (f.smart) parts.push(f.smart);
        return { ok: true, warn: low, detail: parts.join(" · ") };
      },
    },
  ];
}

/** "711M" / "277G" — compact byte counts for the one-line /health detail. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "K", "M", "G", "T"];
  let u = 0;
  let v = n;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const s = u === 0 || v >= 100 ? String(Math.round(v)) : Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${s}${units[u]}`;
}

/**
 * Total bytes of regular files under `dir` (recursive). Symlinks are not
 * followed (no double-count, no loops); unreadable entries are skipped.
 * Returns 0 for a missing dir.
 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      try {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.isFile()) total += (await lstat(join(d, e.name))).size;
      } catch {
        // unreadable entry — skip
      }
    }
  };
  await walk(dir);
  return total;
}

/**
 * Free bytes on the filesystem hosting `path` (fs.statfs). Null when it
 * can't be determined (e.g. unsupported platform).
 */
export async function freeSpace(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * The /dev block device backing `path`, from /proc/mounts (longest matching
 * mount wins). Null off-Linux or when no /dev mount matches.
 */
export function diskDevice(path: string): string | null {
  let mounts: string;
  try {
    mounts = readFileSync("/proc/mounts", "utf8");
  } catch {
    return null;
  }
  let dev: string | null = null;
  let best = -1;
  for (const line of mounts.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [d, mpEsc] = parts;
    if (!d.startsWith("/dev/")) continue;
    const mp = mpEsc.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if ((path === mp || path.startsWith(mp.endsWith("/") ? mp : mp + "/")) && mp.length > best) {
      best = mp.length;
      dev = d;
    }
  }
  return dev;
}

/**
 * Best-effort SMART overall-health summary for `device` via `smartctl -H`.
 * NEVER uses sudo and NEVER throws: a missing binary, no permission, or no
 * overall-health line all resolve to null (the probe then omits SMART).
 */
export function smartHealth(device: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("smartctl", ["-H", device], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /overall-health self-assessment test result:\s*(\w+)/i.exec(stdout);
      if (!m) return resolve(null);
      resolve(m[1].toUpperCase() === "PASSED" ? "SMART ok" : `SMART ${m[1].toUpperCase()}`);
    });
  });
}
