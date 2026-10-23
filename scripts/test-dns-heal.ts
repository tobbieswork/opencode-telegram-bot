/**
 * Checks the DNS/VPN self-heal state machine (src/dns-heal.ts): the failure
 * threshold, the heal cooldown, the single-in-flight guarantee, the success
 * reset, and the resolvectl probe parsing. PURE logic only — this test must
 * never spawn sudo or touch the network.
 *
 * Run:  npx tsx scripts/test-dns-heal.ts
 */
import {
  DnsHealConfig,
  HealState,
  DNS_HEAL_CMD,
  DNS_PROBE_CMD,
  freshHealState,
  recordNetworkFailure,
  recordSuccess,
  shouldHeal,
  startHeal,
  finishHeal,
  probeShowsStaleDns,
} from "../src/dns-heal.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const MIN = 60_000;
const STALE = "192.0.2.53"; // sample/demo address (TEST-NET-1), not a real server
const cfg: DnsHealConfig = { enabled: true, staleIp: STALE, minFailures: 3, cooldownMs: 10 * MIN };
const T = 1_000_000_000; // arbitrary "now"

/** A state with `n` consecutive failures (no heal yet). */
function failed(n: number): HealState {
  const s = freshHealState();
  for (let i = 0; i < n; i++) recordNetworkFailure(s, T);
  return s;
}

// ── constants ───────────────────────────────────────────────────────────────
{
  check("heal cmd is the sudo -n systemctl restart", DNS_HEAL_CMD === "sudo -n systemctl restart systemd-resolved");
  check("probe cmd is the read-only resolvectl status", DNS_PROBE_CMD === "resolvectl status");
}

// ── fresh state: nothing to heal ────────────────────────────────────────────
{
  const s = freshHealState();
  check("fresh: zero failures, never healed, not in flight", s.consecutiveFailures === 0 && s.lastHealAt === 0 && s.healCount === 0 && !s.healInFlight);
  check("fresh: shouldHeal is false", shouldHeal(s, T, cfg) === false);
}

// ── threshold ───────────────────────────────────────────────────────────────
{
  check("threshold: 2 < 3 failures → no heal", shouldHeal(failed(2), T, cfg) === false);
  check("threshold: exactly 3 failures → heal", shouldHeal(failed(3), T, cfg) === true);
  check("threshold: 7 failures → heal", shouldHeal(failed(7), T, cfg) === true);
}

// ── cooldown ────────────────────────────────────────────────────────────────
{
  // A heal finished 1 minute ago: within the 10-minute cooldown.
  const s = failed(5);
  s.lastHealAt = T - 1 * MIN;
  check("cooldown: 1 min after last heal → blocked", shouldHeal(s, T, cfg) === false);

  // Exactly at the cooldown boundary: allowed (>=).
  const s2 = failed(3);
  s2.lastHealAt = T - 10 * MIN;
  check("cooldown: exactly cooldown elapsed → allowed", shouldHeal(s2, T, cfg) === true);

  // Well past the cooldown: allowed.
  const s3 = failed(3);
  s3.lastHealAt = T - 11 * MIN;
  check("cooldown: 11 min after last heal → allowed", shouldHeal(s3, T, cfg) === true);
}

// ── in-flight: a second heal must never start while one is running ──────────
{
  const s = failed(5);
  startHeal(s, T);
  check("in-flight: startHeal sets the flag", s.healInFlight === true);
  check("in-flight: blocks a second heal (threshold+cooldown met)", shouldHeal(s, T, cfg) === false);
  finishHeal(s, T + 2_000);
  check("in-flight: finishHeal clears the flag", s.healInFlight === false);
}

// ── startHeal/finishHeal bookkeeping ───────────────────────────────────────
{
  const s = failed(4);
  startHeal(s, T + 100);
  check("bookkeeping: healCount increments", s.healCount === 1);
  check("bookkeeping: lastHealAt stamped on start", s.lastHealAt === T + 100);
  finishHeal(s, T + 3_000);
  check("bookkeeping: lastHealAt refreshed on finish (cooldown runs from finish)", s.lastHealAt === T + 3_000);
  startHeal(s, T + 4_000);
  finishHeal(s, T + 5_000);
  check("bookkeeping: healCount is per-heal, not per-failure", s.healCount === 2);
}

// ── success resets the failure streak ──────────────────────────────────────
{
  const s = failed(9);
  recordSuccess(s);
  check("success: streak resets to 0", s.consecutiveFailures === 0);
  check("success: streak below threshold again → no heal", shouldHeal(s, T, cfg) === false);

  // A failure streak rebuilt after a success still reaches the threshold.
  recordNetworkFailure(s, T);
  recordNetworkFailure(s, T);
  recordNetworkFailure(s, T);
  check("success: a fresh streak of 3 still heals (never healed before)", shouldHeal(s, T, cfg) === true);
}

// ── failure/success interplay: a success between failures breaks the streak ─
{
  const s = freshHealState();
  recordNetworkFailure(s, T);
  recordNetworkFailure(s, T);
  recordSuccess(s); // blip recovered
  recordNetworkFailure(s, T);
  check("interleaved: 2 failures, success, 1 failure → streak is 1, no heal", s.consecutiveFailures === 1 && shouldHeal(s, T, cfg) === false);
}

// ── master switch ───────────────────────────────────────────────────────────
{
  check("disabled: enabled=false never heals even at threshold", shouldHeal(failed(10), T, { ...cfg, enabled: false }) === false);
}

// ── probe parsing: stale VPN DNS detection in resolvectl output ────────────
{
  const withStale = `
Global
        Protocols: -LLMNR -mDNS -DNSSD -DNSOverTLS DNSSEC=no+support
         Resolvconf: /etc/resolv.conf
Current DNS Servers: 192.0.2.53 8.8.8.8
       DNS Servers: 192.0.2.53 8.8.8.8
`;
  const clean = `
Global
        Protocols: -LLMNR -mDNS -DNSSD -DNSOverTLS DNSSEC=no+support
         Resolvconf: /etc/resolv.conf
Current DNS Servers: 8.8.8.8 1.1.1.1
`;
  check("probe: stale server listed → true", probeShowsStaleDns(withStale, STALE) === true);
  check("probe: only public servers → false", probeShowsStaleDns(clean, STALE) === false);
  check("probe: empty output → false", probeShowsStaleDns("", STALE) === false);
  check("probe: empty staleIp never matches", probeShowsStaleDns(withStale, "") === false);
  check("probe: IP prefix does not match a longer IP", probeShowsStaleDns("Current DNS Servers: 192.0.2.530 8.8.8.8", STALE) === false);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
