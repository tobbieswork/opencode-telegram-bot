/**
 * The concrete probe set behind /health. It reads plain facts about each
 * subsystem (a "HealthSources" bag the Bot fills from the state it already
 * keeps) and turns them into Probes for collectHealth(). No timers, no
 * network of its own beyond the two explicit liveness pings handed in
 * (OpenCode info, advisor /health) — everything else is a getter.
 */
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
  ];
}
