# Contributing

Thanks for considering a contribution! This is a small, dependency-light
Node.js bot — the goal is to keep it that way. Small, well-scoped changes beat
big restructures.

## How contributions work

1. **Fork** the repo on GitHub (`tobbieswork/opencode-telegram-bot`).
2. **Create a branch** off `main`: `git checkout -b feat/your-idea`
   (or `fix/…`, `docs/…`).
3. **Make your change** and keep it focused.
4. **Pass typecheck** (required): `npm run typecheck`.
5. **Push** the branch to your fork and open a **Pull Request** against `main`.
6. Keep the PR small and describe *why* (see the PR template).

Pull requests are run through **CI** (typecheck) and reviewed before merging.

## Getting set up

```sh
git clone https://github.com/<you>/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install

# typecheck (no token needed)
npm run typecheck

# end-to-end smoke test (no bot token; uses your real OpenCode service)
npm run smoke
```

To run the bot itself you need a `.env` — see `.env.example` and the README.
You do **not** need a Telegram token to work on most parts of the code.

## Conventions

- **TypeScript, strict mode** — `tsc --noEmit` must pass. Avoid `any` where you can.
- **No new runtime dependencies.** The whole point is that it's just
  `@opencode/client` + Node's built-in `fetch`. If you believe a dependency is
  needed, open an issue first.
- **Small, single-purpose modules** (see `Project layout` in the README).
- Match the existing style; comments explain *why*, not *what*.
- The bot talks to Telegram in **HTML parse mode** — keep any markup you add
  balanced within a single message (see `format.ts`).

## Security

This bot can **run code on the operator's machine**. Please do not weaken that:

- Never remove or bypass the user allowlist (`TELEGRAM_ALLOWED_USER_IDS`).
- Don't add network access to untrusted hosts.
- Don't commit secrets. `.env` is git-ignored; only `.env.example`
  (placeholders) is checked in.

## Good first contributions

Look for issues labeled `good first issue`. Good candidates: adding a command,
improving a message, a README/docs fix, or a small bug in `format.ts`.
