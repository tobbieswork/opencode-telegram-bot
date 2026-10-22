# Project Rules

## Running the bot
- The bot runs under systemd (`opencode-bot` user service) from source via
  `tsx src/index.ts` — no build step, no hot reload. After editing src/, the
  running process still has the old code in memory: restart it with
  `systemctl --user restart opencode-bot` and check `journalctl --user
  -u opencode-bot -n 20 --no-pager`. The unit pins the nvm Node 24 path —
  if the Node version changes, update `deploy/opencode-bot.service` too.
  `data/state.json` survives restarts, so existing sessions reattach — do
  not delete it casually. Never run a second `npm start` alongside the
  service (Telegram polling 409 conflicts).

## Testing & verification
- Verify in this order: `npm run typecheck` + `npm run test:unit` first
  (seconds), `npm run smoke` last (minutes).
- `npm run smoke` is a real end-to-end run: it drives the live OpenCode
  service with 3 real LLM prompts and takes ~3-4 minutes. It needs the
  OpenCode service running. When it finishes, verify the log sections
  (menu, mode picker, sweep, question relay), not just the exit code.

## Conventions
- Commits follow Conventional Commits (feat: / fix: / test: / docs:).
- The bot's commands are user-facing; most labels are in Vietnamese.
