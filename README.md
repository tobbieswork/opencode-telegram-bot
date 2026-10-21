# opencode-telegram-bot

Remotely drive a running **OpenCode** service from **Telegram**. Text the bot a
message, it runs it through OpenCode and sends the result back. Manage sessions,
directories, models, agents, and interrupt work — all from your phone.

```
Telegram  ←── long polling ──  this bot  ── @opencode/client ──  OpenCode service
   you                                (Node 20+)                  (the agent you already have)
```

No database, no framework — just `@opencode/client` + Node's built-in `fetch`.
The whole Telegram transport is ~130 lines you can read in one sitting.

## How it works

- The bot **discovers your running OpenCode background service** (or one you
  point it at) and talks to its HTTP API.
- Each Telegram chat is bound to its own **session + directory + model + agent**,
  persisted to `data/state.json` so a restart reattaches to the same session.
- Sending a plain message = send a prompt to that session. The bot waits until the
  session goes idle, then sends back the assistant's text (with OpenCode's internal
  `§N§` tags stripped) and a small `outcome · time` footer.
- Long-running work is **non-blocking**: the polling loop keeps reading Telegram
  updates while a prompt runs, so `/stop` always works.
- When the agent needs input, its **`question` tool** is relayed to you as
  **inline buttons**, one question at a time — tap an option or type your own
  answer. Answering the form on the OpenCode side is what un-blocks the session
  (a question that was never answered used to hang the whole task).

## Prerequisites

- Node.js **20+** (built-in `fetch`).
- An **OpenCode** service running (`opencode service status` should show a URL).
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather).

## Setup

```sh
cd opencode-telegram-bot
npm install
cp .env.example .env
```

Fill in `.env`:

1. **`TELEGRAM_BOT_TOKEN`** — from @BotFather (`/newbot`).
2. **`TELEGRAM_ALLOWED_USER_IDS`** — your numeric Telegram ID. Find it by
   messaging [@userinfobot](https://t.me/userinfobot). You can list several,
   comma-separated.
3. *(optional)* **`OPENCODE_DIRECTORY`** — working directory for new sessions
   (defaults to where you run the bot).

Then run:

```sh
npm start
```

On first run it prints the connected OpenCode URL/version and your bot's
`@handle`. Open that bot in Telegram and send `/help`.

> ⚠️ **Security.** This bot can run code on your machine. Always set
> `TELEGRAM_ALLOWED_USER_IDS` to yourself. Do **not** set
> `OPENCODE_TG_ALLOW_ANY=1` on an exposed network.

## Usage

Send any message to run it. Example:

```
you:   review the last commit and suggest fixes
bot:   …(typing)…
bot:   The last commit adds retry logic but…
       succeeded · 42.3s
```

### Commands

| Command | Description |
| --- | --- |
| `/help` | Show help + a tappable command menu |
| `/new` | Start a fresh session in the current directory |
| `/ls` | List recent sessions |
| `/use <id>` | Switch this chat to an existing session |
| `/dir [path]` | Show or set the working directory |
| `/browse [path]` | Browse folders with buttons and open a session there |
| `/models` | List available models |
| `/model <id>` | Set the model (also accepts `provider/id`) |
| `/variants [id]` | List/set the model's reasoning variant (default `xhigh`) |
| `/agents` | List user-facing agents |
| `/agent <id>` | Set the agent (`build`, `general`, `explore`, `plan`) |
| `/mode` | Pick an operating mode via buttons — `build` / `plan` / `general` / `explore` |
| `/stop` | Interrupt the running task |
| `/history` | Show the last few messages of the current session |
| `/status` | Show what the bot is connected to |
| `/clear` | Reset this chat's session/dir/model/agent |

### When OpenCode asks a question

If the agent hits a decision that needs your input, it uses its `question` tool.
The bot surfaces that as an inline keyboard, one question at a time:

```
bot:   ❓ Câu 1/1 · Pick
       Which number do you prefer?
       [One]  [Two]  [Three]  [✍️ Gõ tự do…]  [❌ Huỷ]
you:   (tap One)
bot:   ✅ Đã gửi câu trả lời cho OpenCode.
```

Multiple-choice answers are button taps; free-text answers are typed (tap
"Gõ tự do…" first). On the first prompt of each session the bot prepends a short
note telling the agent it's headless and should ask decisions via the `question`
tool (disable with `OPENCODE_TG_GUIDE=0`).

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | ✅\* | — | Comma-separated numeric user IDs |
| `OPENCODE_TG_ALLOW_ANY` | | off | `1` = allow any user (**not recommended**) |
| `OPENCODE_DIRECTORY` | | `process.cwd()` | Working dir for new sessions |
| `OPENCODE_SERVICE_URL` | | auto-discover | Explicit OpenCode service URL |
| `OPENCODE_SERVICE_USER` / `OPENCODE_SERVICE_PASSWORD` | | — | Basic-auth creds for an explicit service |
| `OPENCODE_DEFAULT_AGENT` | | — | Agent for new sessions |
| `OPENCODE_DEFAULT_MODEL_ID` + `OPENCODE_DEFAULT_MODEL_PROVIDER` | | — | Model for new sessions |
| `STATE_FILE` | | `./data/state.json` | Where per-chat state is stored |
| `TELEGRAM_REPLY_MAX_LEN` | | `4000` | Max chars per outgoing message |
| `OPENCODE_TG_GUIDE` | | on | `0` = don't prepend the "ask via question tool" note to new sessions |
| `OPENCODE_TG_BROWSE_ROOTS` | | home dir | Comma-separated dirs the `/browse` browser may walk |

\* required unless `OPENCODE_TG_ALLOW_ANY=1`.

## Running it in the background

It's a single long-running Node process. Pick whatever you like:

```sh
# tmux / screen
tmux new -s ocbot 'npm start'

# nohup
nohup npm start > bot.log 2>&1 &

# systemd (user unit) — create ~/.config/systemd/user/opencode-tg.service
#   [Service] WorkingDirectory=/path/to/opencode-telegram-bot
#   [Service] ExecStart=/usr/bin/npm start
```

Then `systemctl --user enable --now opencode-tg`.

## Development

```sh
npm run typecheck   # strict tsc, no emit
npm run smoke       # drive the bot through a mock Telegram + real OpenCode
npm run dev         # same as start
```

`npm run smoke` needs no bot token: it connects to your real OpenCode service,
sends a canned prompt, and prints every message it *would* send to Telegram —
a quick way to verify the whole loop.

## Troubleshooting

- **`TELEGRAM_BOT_TOKEN ... 401`** — wrong token; check `.env`.
- **Bot never replies to me** — is your numeric ID in `TELEGRAM_ALLOWED_USER_IDS`?
- **`Directory does not exist`** — fix `OPENCODE_DIRECTORY` or send `/dir <path>`.
- **Can't find the OpenCode service** — check `opencode service status`, or set
  `OPENCODE_SERVICE_URL` (and user/password) explicitly.
- **`429` warnings in the log** — you're hitting Telegram's rate limit; the bot
  backs off automatically.
- **`⚠️ Cannot connect to OpenCode` / "Transport: fetch failed"** — the bot could
  not reach the OpenCode service. It now **retries transient blips** and
  **re-discovers the service automatically** (the service restarts on a new
  port). If it still fails, start the service (`opencode service`) and check
  `opencode service status`.

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the
workflow (fork → branch → PR) and the project conventions. In short:

- Fork, branch, make a focused change.
- `npm run typecheck` must pass — it's enforced by **CI** on every push and PR.
- Keep it **dependency-free and small** (just `@opencode/client` + Node `fetch`).
- Open a PR and describe *why*.

We follow a [Code of Conduct](./.github/CODE_OF_CONDUCT.md); new code is released
under the [MIT license](./LICENSE).

## Project layout

```
src/
  index.ts      entrypoint: config → connect → poll
  config.ts     env loading + validation
  opencode.ts   OpenCode control wrapper (sessions, prompts, models, agents)
  fsbrowser.ts  directory listing for the /browse picker
  telegram.ts   Telegram Bot API client (long polling)
  bot.ts        command routing + per-chat state + background prompt task
  state.ts      JSON persistence of per-chat state (+ event→chat routing for forms)
  format.ts     escaping / tag-stripping / chunking
  logger.ts     tiny timestamped logger
scripts/
  smoke.ts      token-free end-to-end smoke test
```

## License

[MIT](./LICENSE) © Tobbies Nguyen
