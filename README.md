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
- When a tool needs a **permission** the agent doesn't already have, the bot
  relays the request as a card with buttons (`Duyệt 1 lần` / `Duyệt luôn` /
  `Từ chối`) — tap one to answer from Telegram, or answer in the terminal TUI;
  whichever comes first settles the other side.
- **Plan → build handoff**: after any successful turn that ends in `plan` mode,
  the bot offers a one-tap button that switches the session to `build` and
  executes the plan that is already in context.
- **Many sessions at once**: each Telegram **forum topic** is its own
  conversation with its own session, so several agents can work in parallel —
  and an optional **Manager agent** in the main chat splits your requests into
  tasks and hands them to worker sessions (see below).

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

## Running as a systemd service (optional)

To keep the bot alive across restarts/logouts and auto-restart it on crash,
install the bundled user-level unit (it pins an absolute Node path, because
systemd's default PATH won't see nvm):

```sh
cp deploy/opencode-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-bot
```

- Status/logs: `systemctl --user status opencode-bot`, `journalctl --user -u opencode-bot -f`
- Keep it running after you log out (needs sudo, once): `sudo loginctl enable-linger $USER`
- Before enabling, stop any manual `npm start`/`nohup` instance first, or two
  processes will fight over Telegram polling (409 conflicts in the log).
- After changing the Node version in nvm, update the pinned paths in the
  unit and `systemctl --user restart opencode-bot`.

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
| `/context` | Photo of the current session — usage, files touched, last prompt |
| `/status` | Show what the bot is connected to |
| `/clear` | Reset this chat's session/dir/model/agent |
| `/spawn <name> [dir]` | Create a worker: a new topic with its own session |
| `/board` | Status of every worker in this chat |
| `/kill [name]` | Stop a worker (in its topic: no name needed) · `/stopall` stops all |
| `/manager on\|off` | Turn the Manager agent on/off in the main chat |
| `/auto on\|off` | Manager dispatches on its own, or waits for your ✅ |
| `/wt` | In a worker topic: diff / merge / remove its git worktree |

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

## Many sessions in parallel (topics + Manager)

Telegram **forum topics** turn one chat into many conversations. The bot treats
every topic as its own conversation — its own session, directory, model, agent,
`/stop`, and history — so you can keep several agents busy at the same time.

Topics work in a **private chat with the bot** when the bot has topic mode
(Bot API 9.3+; the bot logs `topics in private chats: on/off` at startup), or in a
**supergroup with Topics enabled**, where the bot must be an admin with the
*Manage topics* right.

```
📁 Chat with the bot
├─ General          ← you ⇄ Manager agent (or a normal session)
├─ 🟢 api-auth       ← worker: own session + directory (or git worktree)
├─ 🟡 fix-login      ← waiting for you (permission / question)
└─ ✅ write-tests    ← done
```

**By hand**: `/spawn api-auth ~/Code/app` creates a topic + session; just talk
in that topic. `/board` shows all of them; topic titles show live status
(🟢 running · 🟡 waiting for you · ✅ done · ❌ failed · ⏹ stopped).

**With the Manager**: `/manager on` in the main chat starts a Manager agent (an
OpenCode session with its own agent prompt). Tell it what you want; it picks
directories, splits the work, and dispatches it to workers through a small tool
bridge (a local MCP server inside the bot, bound to `127.0.0.1`, token-guarded,
registered only for the Manager's own folder). When workers finish, their
results are fed back to the Manager, which summarises them for you.

- **Approval**: by default (`/auto off`) every dispatch the Manager wants —
  a new worker or a follow-up — appears as a card: `✅ Giao` / `❌ Huỷ` /
  `⚡ Giao + bật auto`. With `/auto on` it dispatches on its own.
- **Permissions and questions** of a worker always go to *you*, in that
  worker's topic. The Manager never answers them.
- **Guard rails**: at most `OPENCODE_TG_MAX_WORKERS` busy workers per chat; a
  dispatch budget per user message stops Manager ↔ worker loops; workers may
  only run under `OPENCODE_TG_BROWSE_ROOTS` (symlinks resolved first).
- **Parallel edits in one repo**: a writing worker that would share a git
  checkout with another busy writer gets its **own worktree + branch**
  (`<repo>.worktrees/<name>`, branch `tg/<name>`). When it's done, the topic
  offers **Diff / Merge / Remove**. Merge only runs on a clean main checkout on
  the base branch and aborts cleanly on conflict; remove keeps unmerged branches.

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
| `OPENCODE_TG_LANGUAGE` | | on | `0` = don't set the per-session "reply in the user's language" instruction (and remove it from sessions that have it) |
| `OPENCODE_TG_REMIND` | | on | `0` = don't re-send unanswered questions/permissions |
| `OPENCODE_TG_REMIND_BASE_MS` | | `300000` | Delay before the first reminder (ms, min 1000) |
| `OPENCODE_TG_REMIND_FACTOR` | | `2` | Backoff multiplier between reminders (min 1) |
| `OPENCODE_TG_REMIND_MAX` | | `4` | Reminders per prompt before the bot stops nudging (the prompt stays pending) |
| `OPENCODE_TG_BROWSE_ROOTS` | | home dir | Comma-separated dirs the `/browse` browser may walk — and where workers may run |
| `OPENCODE_TG_MAX_WORKERS` | | `5` | Max busy (running/waiting) workers per chat |
| `OPENCODE_TG_WORKTREE` | | `auto` | Worktree isolation for writing workers: `auto` / `always` / `off` |
| `OPENCODE_TG_MANAGER_DIR` | | `./data/manager` | Where each chat's Manager session and agent file live |
| `OPENCODE_TG_BRIDGE_PORT` | | random | Port of the Manager's local MCP bridge |

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
npm run test:unit   # fast checks, no service needed (incl. topics, bridge, worktrees, orchestrator)
npm run smoke       # drive the bot through a mock Telegram + real OpenCode
npm run smoke:multi # parallel topics + Manager + approval against real OpenCode (a few minutes)
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
  telegram.ts   Telegram Bot API client (long polling, forum topics)
  bot.ts        command routing + per-conversation state + background prompt task
  conv.ts       conversation keys: a chat, or one forum topic in it
  orchestrator.ts  worker topics, the Manager agent, approvals, worktree actions
  mcp-bridge.ts tiny MCP server the Manager calls to steer workers
  worktree.ts   git worktree isolation for parallel writers
  state.ts      JSON persistence of per-conversation state (+ event→conversation routing)
  format.ts     escaping / tag-stripping / chunking
  logger.ts     tiny timestamped logger
scripts/
  smoke.ts      token-free end-to-end smoke test
  smoke-multi.ts  end-to-end test of topics + Manager
  test-*.ts     unit checks (npm run test:unit)
```

## License

[MIT](./LICENSE) © Tobbies Nguyen
