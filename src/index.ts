import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDotEnv, loadConfig } from "./config.js";
import { sweepUploads, UPLOADS_MAX_TOTAL_BYTES } from "./uploads.js";
import { OpenCodeCtl } from "./opencode.js";
import { Telegram } from "./telegram.js";
import { StateManager } from "./state.js";
import { Bot } from "./bot.js";
import { log, warn, error } from "./logger.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig(root);
  log("Starting OpenCode Telegram bot…");

  // Connect to OpenCode first — fail fast if the service is unreachable.
  const oc = new OpenCodeCtl();
  const connected = await oc.connect(cfg.opencodeServiceUrl, cfg.opencodeServiceUser, cfg.opencodeServicePassword);
  log(`Connected to OpenCode ${connected.version ?? "?"} @ ${connected.url}`);

  const tg = new Telegram(cfg.telegramToken, {
    enabled: cfg.dnsHeal && cfg.dnsStaleIp !== "",
    staleIp: cfg.dnsStaleIp,
    minFailures: cfg.dnsHealMinFailures,
    cooldownMs: cfg.dnsHealCooldownMs,
  });
  const me = await tg.getMe();
  log(`Telegram bot: @${me.username ?? "?"} (id ${me.id}) · topics in private chats: ${me.has_topics_enabled ? "on" : "off"}`);

  if (cfg.allowAny) {
    warn("OPENCODE_TG_ALLOW_ANY=1 — the bot will respond to ANYONE. Prefer TELEGRAM_ALLOWED_USER_IDS.");
  } else {
    log(`Allowlist: ${cfg.allowedUserIds.join(", ")}`);
  }
  log(`Default directory: ${cfg.opencodeDirectory}`);
  log(`State file: ${cfg.stateFile}`);

  const st = new StateManager(cfg.stateFile);
  // Sweep stale uploads (TTL + 500 MB cap) — data/uploads is bot-owned, never
  // part of a user repo (see src/uploads.ts). One log line per startup.
  const sweep = sweepUploads(join(dirname(cfg.stateFile), "uploads"), Date.now(), {
    ttlMs: cfg.uploadTtlDays * 86_400_000,
    maxBytes: UPLOADS_MAX_TOTAL_BYTES,
  });
  log(`uploads sweep: deleted ${sweep.files} files (${(sweep.bytes / 1024 / 1024).toFixed(1)} MB)`);
  const bot = new Bot(tg, oc, st, cfg);
  bot.start(); // relay OpenCode question forms to Telegram
  // Recover any reply a previous (crashed/restarted) process produced but never
  // relayed. Fire-and-forget so polling starts immediately.
  void bot.recoverOrphanedReplies().catch((e) => warn("reply recovery:", e?.message));

  // Graceful shutdown: the FIRST signal starts a drain (stop polling, let
  // in-flight turns finish and their final replies be sent); a SECOND signal
  // while draining exits immediately. The drain cap must stay below the unit's
  // TimeoutStopSec (90s) so systemd's SIGKILL escalation is always the backstop,
  // never the normal path.
  const DRAIN_TIMEOUT_MS = 45_000;
  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) {
      log(`${sig} received while draining — exiting immediately`);
      process.exit(0);
    }
    shuttingDown = true;
    log(`${sig} received — draining in-flight turns (cap ${DRAIN_TIMEOUT_MS / 1000}s)…`);
    // 1. Stop polling first: unacked updates get redelivered on the next start
    //    instead of being acked by a process that is about to die.
    tg.stop();
    // 2. No new scheduled work.
    bot.stopScheduler();
    // 3. Keep the OpenCode service + event stream ALIVE for the drain (no
    //    teardown yet): in-flight turns finish and their terminal events
    //    arrive over the stream; the final send only needs Telegram.
    void bot
      .drainInflight({ timeoutMs: DRAIN_TIMEOUT_MS })
      .then((settled) => {
        log(settled ? "drain: all turns settled — exiting" : "drain: cap reached — exiting");
        process.exit(0);
      })
      .catch((e) => {
        error("drain failed:", (e as Error)?.message ?? e);
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => error("Unhandled rejection:", e));

  await tg.poll((u) => bot.enqueue(u), {
    onDnsHeal: () => bot.notifyDnsHeal(),
  });
}

main().catch((e) => {
  error("Fatal:", e?.stack ?? e);
  process.exit(1);
});
