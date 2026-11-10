/**
 * Health report: one line per background subsystem (OpenCode connection, MCP
 * bridge, scheduler, PR-watch, advisor, ...), each OK / WARN / FAIL / off with
 * the time of its last success.
 *
 * Pure and read-only by design: the collector only calls the `check` functions
 * it is handed (cheap getters over state the subsystems already keep) and never
 * triggers subsystem work. A disabled subsystem is reported "off" without its
 * check being called. One broken or hung probe never takes down the report.
 *
 * The /health command (task 5) builds the probe list from the live Bot; this
 * file knows nothing about Telegram, config or the subsystems themselves.
 */
import type { Lang } from "./state.js";
import { esc } from "./format.js";
import { tr } from "./i18n.js";

export type HealthStatus = "ok" | "warn" | "fail" | "off";

export interface ProbeResult {
  ok: boolean;
  /** Epoch ms of the last successful activity, if the subsystem tracks one. */
  lastOkAt?: number;
  /** When set, an `ok` result whose lastOkAt is older than this becomes `warn`. */
  staleAfterMs?: number;
  detail?: string;
}

export interface Probe {
  id: string;
  /** False = turned off by config: reported "off", check() is not called. */
  enabled: boolean;
  check: () => ProbeResult | Promise<ProbeResult>;
}

export interface HealthLine {
  id: string;
  status: HealthStatus;
  lastOkAt?: number;
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

export async function collectHealth(
  probes: Probe[],
  now: number,
  opts: { timeoutMs?: number } = {},
): Promise<HealthLine[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(probes.map((p) => runProbe(p, now, timeoutMs)));
}

async function runProbe(p: Probe, now: number, timeoutMs: number): Promise<HealthLine> {
  if (!p.enabled) return { id: p.id, status: "off" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    // Promise.resolve().then(...) so a synchronous throw becomes a rejection too.
    const r = await Promise.race([Promise.resolve().then(() => p.check()), timeout]);
    if (!r.ok) return { id: p.id, status: "fail", lastOkAt: r.lastOkAt, detail: r.detail };
    const stale = r.staleAfterMs != null && r.lastOkAt != null && now - r.lastOkAt > r.staleAfterMs;
    return { id: p.id, status: stale ? "warn" : "ok", lastOkAt: r.lastOkAt, detail: r.detail };
  } catch (e) {
    return { id: p.id, status: "fail", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ICON: Record<HealthStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌", off: "⚪" };

/** "5s ago" / "5 giây trước" — deterministic (takes `now`), unlike format.timeAgo. */
function ago(ms: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [n, en, vi] =
    s < 60 ? [s, "s", "giây"] : s < 3600 ? [Math.floor(s / 60), "m", "phút"] : s < 86400 ? [Math.floor(s / 3600), "h", "giờ"] : [Math.floor(s / 86400), "d", "ngày"];
  return tr(lang, `${n} ${vi} trước`, `${n}${en} ago`);
}

/** Telegram-HTML report: a header with the worst status, then one line per subsystem. */
export function formatHealth(lines: HealthLine[], lang: Lang, now: number): string {
  const worst: HealthStatus = lines.some((l) => l.status === "fail") ? "fail" : lines.some((l) => l.status === "warn") ? "warn" : "ok";
  const title = tr(lang, "Sức khoẻ hệ thống", "Health");
  const out = [`🩺 <b>${title}</b> ${ICON[worst]}`];
  for (const l of lines) {
    const parts = [`${ICON[l.status]} <code>${esc(l.id)}</code>`];
    if (l.status === "off") {
      parts.push(tr(lang, "tắt", "off"));
    } else {
      if (l.lastOkAt != null) parts.push(ago(now - l.lastOkAt, lang));
      if (l.status === "warn") parts.push(tr(lang, "quá cũ", "stale"));
      if (l.detail) parts.push(esc(l.detail));
    }
    out.push(parts.join(" · "));
  }
  return out.join("\n");
}
