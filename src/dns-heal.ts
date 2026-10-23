/**
 * Pure state machine for DNS/VPN self-healing in the Telegram polling loop.
 *
 * Failure mode this fixes: the box runs OpenVPN; when the VPN session dies
 * uncleanly, systemd-resolved keeps the VPN's internal DNS server
 * (172.16.254.9) as a live resolver. Every lookup then times out (~15s) and
 * undici throws `fetch failed` from getUpdates in a tight loop, even though
 * the local OpenCode service (127.0.0.1) is fine. The working recovery is
 * `sudo -n systemctl restart systemd-resolved` (NOPASSWD for exactly that
 * command).
 *
 * This module is deliberately PURE (no fs/child_process): the shell work
 * (probe + heal spawn) lives in telegram.ts, and everything decided here is
 * unit-testable like reminders.ts.
 */

/** Read-only probe: lists the DNS servers systemd-resolved currently uses. */
export const DNS_PROBE_CMD = "resolvectl status";
/** The fix: restart systemd-resolved so it drops the stale VPN DNS server. */
export const DNS_HEAL_CMD = "sudo -n systemctl restart systemd-resolved";
/** The VPN's internal DNS server that lingers after an unclean VPN stop. */
export const STALE_VPN_DNS = "172.16.254.9";

export interface DnsHealConfig {
  /** Master switch (OPENCODE_TG_DNS_HEAL). */
  enabled: boolean;
  /** Consecutive network failures required before a heal is allowed. */
  minFailures: number;
  /** Minimum gap between two heals, ms (OPENCODE_TG_DNS_HEAL_COOLDOWN_MS). */
  cooldownMs: number;
}

/** Per-process bookkeeping for the heal (kept on the Telegram client). */
export interface HealState {
  /** Consecutive network failures since the last successful poll. */
  consecutiveFailures: number;
  /** When the last heal finished (ms epoch); 0 = never healed. */
  lastHealAt: number;
  /** How many heals have been started since process start. */
  healCount: number;
  /** True while a heal command is running — blocks a second overlapping heal. */
  healInFlight: boolean;
}

export function freshHealState(): HealState {
  return { consecutiveFailures: 0, lastHealAt: 0, healCount: 0, healInFlight: false };
}

/** One getUpdates attempt failed at the network level (undici `fetch failed`). */
export function recordNetworkFailure(state: HealState, now: number): void {
  void now; // kept in the signature so call sites are uniform across record* helpers
  state.consecutiveFailures++;
}

/** Any successful round-trip (HTTP response or clean poll) resets the streak. */
export function recordSuccess(state: HealState): void {
  state.consecutiveFailures = 0;
}

/** Mark a heal as running: counts it, stamps the time, and sets the in-flight flag. */
export function startHeal(state: HealState, now: number): void {
  state.healInFlight = true;
  state.healCount++;
  state.lastHealAt = now;
}

/** Mark the heal as done: clears the in-flight flag and refreshes the cooldown stamp. */
export function finishHeal(state: HealState, now: number): void {
  state.healInFlight = false;
  state.lastHealAt = now;
}

/**
 * True when a heal should start now: the failure streak reached the threshold,
 * the cooldown since the last heal has elapsed, and no heal is in flight.
 * `enabled=false` disables the whole mechanism.
 */
export function shouldHeal(state: HealState, now: number, cfg: DnsHealConfig): boolean {
  if (!cfg.enabled) return false;
  if (state.healInFlight) return false;
  if (state.consecutiveFailures < cfg.minFailures) return false;
  if (state.lastHealAt > 0 && now - state.lastHealAt < cfg.cooldownMs) return false;
  return true;
}

/** Parse `resolvectl status` output: true when the stale VPN DNS server is still listed. */
export function probeShowsStaleDns(output: string): boolean {
  return output.includes(STALE_VPN_DNS);
}
