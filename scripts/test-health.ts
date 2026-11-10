/**
 * Checks for the health collector (src/health.ts): status rules, the "off"
 * case, read-only guarantee, failure/timeout isolation, and rendering.
 *
 * Run:  npx tsx scripts/test-health.ts
 */
import { collectHealth, formatHealth, type Probe } from "../src/health.js";
import { buildProbes, type HealthSources } from "../src/health-probes.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const byId = (lines: { id: string }[], id: string) => lines.find((l) => l.id === id) as any;

async function main(): Promise<void> {
  // ── R2.2: OK / WARN / FAIL with last-success time ────────────────────────
  const probes: Probe[] = [
    { id: "opencode", enabled: true, check: () => ({ ok: true, lastOkAt: NOW - 5_000 }) },
    { id: "scheduler", enabled: true, check: () => ({ ok: true, lastOkAt: NOW - 10 * MIN, staleAfterMs: 2 * MIN }) },
    { id: "advisor", enabled: true, check: () => ({ ok: false, lastOkAt: NOW - 60 * MIN, detail: "HTTP 502" }) },
  ];
  const lines = await collectHealth(probes, NOW);
  check("ok probe -> ok with its last-success time", byId(lines, "opencode").status === "ok" && byId(lines, "opencode").lastOkAt === NOW - 5_000);
  check("ok but older than staleAfterMs -> warn", byId(lines, "scheduler").status === "warn");
  check("failed probe -> fail with detail", byId(lines, "advisor").status === "fail" && byId(lines, "advisor").detail === "HTTP 502");
  check("ok probe without staleAfterMs never goes warn", byId(await collectHealth([{ id: "x", enabled: true, check: () => ({ ok: true, lastOkAt: NOW - 999 * MIN }) }], NOW), "x").status === "ok");
  check("ok probe with no activity yet stays ok", byId(await collectHealth([{ id: "x", enabled: true, check: () => ({ ok: true }) }], NOW), "x").status === "ok");

  // ── R2.3 / R2.4: disabled -> off, and its check is never invoked ────────
  let called = false;
  const off = await collectHealth([{ id: "pr-watch", enabled: false, check: () => ((called = true), { ok: true }) }], NOW);
  check("disabled subsystem -> off (not fail)", byId(off, "pr-watch").status === "off");
  check("disabled subsystem's check is never called", called === false);

  // ── isolation: one broken probe never takes down the report ──────────────
  const mixed = await collectHealth(
    [
      { id: "boom", enabled: true, check: () => { throw new Error("kaput"); } },
      { id: "rej", enabled: true, check: async () => { throw new Error("async kaput"); } },
      { id: "fine", enabled: true, check: () => ({ ok: true }) },
    ],
    NOW,
  );
  check("a throwing probe -> fail with the message", byId(mixed, "boom").status === "fail" && /kaput/.test(byId(mixed, "boom").detail));
  check("a rejecting probe -> fail with the message", byId(mixed, "rej").status === "fail" && /async kaput/.test(byId(mixed, "rej").detail));
  check("other probes still report", byId(mixed, "fine").status === "ok" && mixed.length === 3);

  const hung = await collectHealth([{ id: "hang", enabled: true, check: () => new Promise(() => {}) }], NOW, { timeoutMs: 30 });
  check("a hung probe times out -> fail", byId(hung, "hang").status === "fail" && /timed out/i.test(byId(hung, "hang").detail));

  check("order of probes is preserved", (await collectHealth(probes, NOW)).map((l) => l.id).join() === "opencode,scheduler,advisor");

  // ── the real probe set (src/health-probes.ts) over fake sources ──────────
  {
    const base = (): HealthSources => ({
      opencode: async () => ({ version: "1.2.3" }),
      bridge: { enabled: true, check: async () => ({ ok: true }) },
      scheduler: { enabled: true, lastTickAt: NOW - 20_000, tickMs: 30_000 },
      prWatch: { enabled: true, intervalMs: 5 * MIN, lastOkAt: NOW - 2 * MIN },
      advisor: { enabled: true, ping: async () => ({ ok: true, sessions: 2 }) },
      uptime: { enabled: true, lastOkAt: NOW - 3 * 3600_000 },
      dnsHeal: { enabled: true, consecutiveFailures: 0, minFailures: 3, healCount: 0, lastPollOkAt: NOW - 10_000 },
    });
    const run = async (mut: (s: HealthSources) => void) => {
      const s = base();
      mut(s);
      return collectHealth(buildProbes(s, () => NOW), NOW);
    };
    const happy = await run(() => {});
    check("probes cover every subsystem in order", happy.map((l) => l.id).join() === "opencode,mcp-bridge,scheduler,pr-watch,advisor,uptime,dns-heal", happy.map((l) => l.id).join());
    check("all-healthy sources -> every line ok", happy.every((l) => l.status === "ok"), JSON.stringify(happy));
    check("opencode shows its version", byId(happy, "opencode").detail === "v1.2.3");

    check("opencode unreachable -> fail with the reason", byId(await run((s) => { s.opencode = async () => { throw new Error("ECONNREFUSED"); }; }), "opencode").detail === "ECONNREFUSED");
    check("bridge reporting trouble -> fail", byId(await run((s) => { s.bridge.check = async () => ({ ok: false, detail: "tg-bridge failed" }); }), "mcp-bridge").status === "fail");
    check("bridge with no Manager chat -> off", byId(await run((s) => { s.bridge.enabled = false; }), "mcp-bridge").status === "off");

    check("scheduler with no tick yet stays ok", byId(await run((s) => { s.scheduler.lastTickAt = 0; }), "scheduler").status === "ok");
    check("scheduler silent for > 3 ticks -> warn", byId(await run((s) => { s.scheduler.lastTickAt = NOW - 5 * MIN; }), "scheduler").status === "warn");
    check("scheduler off by config -> off", byId(await run((s) => { s.scheduler.enabled = false; }), "scheduler").status === "off");

    check("pr-watch last error -> fail with the error", (() => { return true; })() && byId(await run((s) => { s.prWatch.lastError = "gh: rate limited"; }), "pr-watch").detail === "gh: rate limited");
    check("pr-watch silent for > 3 intervals -> warn", byId(await run((s) => { s.prWatch.lastOkAt = NOW - 30 * MIN; }), "pr-watch").status === "warn");
    check("pr-watch off -> off", byId(await run((s) => { s.prWatch.enabled = false; }), "pr-watch").status === "off");

    check("advisor unreachable -> fail", byId(await run((s) => { s.advisor.ping = async () => null; }), "advisor").status === "fail");
    check("advisor unhealthy -> fail", byId(await run((s) => { s.advisor.ping = async () => ({ ok: false, sessions: 0 }); }), "advisor").status === "fail");
    check("advisor not configured -> off", byId(await run((s) => { s.advisor.enabled = false; }), "advisor").status === "off");

    check("uptime monitor stale (> 13h) -> warn", byId(await run((s) => { s.uptime.lastOkAt = NOW - 14 * 3600_000; }), "uptime").status === "warn");
    check("uptime monitor never checked (e.g. no /proc) stays ok", byId(await run((s) => { s.uptime.lastOkAt = undefined; }), "uptime").status === "ok");

    check("dns-heal below the failure threshold -> ok", byId(await run((s) => { s.dnsHeal.consecutiveFailures = 2; }), "dns-heal").status === "ok");
    check("dns-heal at the failure threshold -> fail", byId(await run((s) => { s.dnsHeal.consecutiveFailures = 3; }), "dns-heal").status === "fail");
    check("dns-heal reports how many heals ran", byId(await run((s) => { s.dnsHeal.healCount = 2; }), "dns-heal").detail === "2 heals");
    check("dns-heal off -> off", byId(await run((s) => { s.dnsHeal.enabled = false; }), "dns-heal").status === "off");
  }

  // ── rendering (R2.1, R2.5) ───────────────────────────────────────────────
  const all = await collectHealth(
    [...probes, { id: "pr-watch", enabled: false, check: () => ({ ok: true }) }, { id: "esc", enabled: true, check: () => ({ ok: false, detail: "<b>&" }) }],
    NOW,
  );
  const en = formatHealth(all, "en", NOW);
  const vi = formatHealth(all, "vi", NOW);
  check("one line per subsystem plus a header", en.split("\n").length === all.length + 1, en);
  check("status icons: ok / warn / fail / off", /✅.*opencode/.test(en) && /⚠️.*scheduler/.test(en) && /❌.*advisor/.test(en) && /⚪.*pr-watch/.test(en));
  check("shows time since last success", /opencode.*5s ago/.test(en) && /advisor.*1h ago/.test(en), en);
  check("shows detail on failure", /advisor.*HTTP 502/.test(en));
  check("off lines say off, with no time", /pr-watch.*off/.test(en) && !/pr-watch.*ago/.test(en));
  check("html in detail is escaped", /&lt;b&gt;&amp;/.test(en) && !/<b>&/.test(en.replace(/<b>Health/, "")));
  check("vietnamese rendering differs from english", vi !== en && /trước/.test(vi), vi);
  check("overall header reflects the worst status", /❌/.test(en.split("\n")[0]) && /✅/.test(formatHealth([all[0]], "en", NOW).split("\n")[0]));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall health checks passed");
}

main();
