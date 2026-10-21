import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadDotEnv, loadConfig } from "./config.js";
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

  const tg = new Telegram(cfg.telegramToken);
  const me = await tg.getMe();
  log(`Telegram bot: @${me.username ?? "?"} (id ${me.id})`);

  if (cfg.allowAny) {
    warn("OPENCODE_TG_ALLOW_ANY=1 — the bot will respond to ANYONE. Prefer TELEGRAM_ALLOWED_USER_IDS.");
  } else {
    log(`Allowlist: ${cfg.allowedUserIds.join(", ")}`);
  }
  log(`Default directory: ${cfg.opencodeDirectory}`);
  log(`State file: ${cfg.stateFile}`);

  const st = new StateManager(cfg.stateFile);
  const bot = new Bot(tg, oc, st, cfg);
  bot.start(); // relay OpenCode question forms to Telegram
  // Recover any reply a previous (crashed/restarted) process produced but never
  // relayed. Fire-and-forget so polling starts immediately.
  void bot.recoverOrphanedReplies().catch((e) => warn("reply recovery:", e?.message));

  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${sig} received, stopping…`);
    tg.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => error("Unhandled rejection:", e));

  await tg.poll((u) => bot.handle(u));
}

main().catch((e) => {
  error("Fatal:", e?.stack ?? e);
  process.exit(1);
});
