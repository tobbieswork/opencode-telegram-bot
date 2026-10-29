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
  General manages their lifecycle after `/setup`. An optional **Manager agent**
  has its own topic and hands work to other sessions (see below).
- **Live activity line**: while a turn runs, one self-editing message shows
  what the agent is doing right now (`📖 Đang đọc src/bot.ts…`,
  `▶ Đang chạy npm test…`, then `✅` with elapsed time). Hidden with
  `OPENCODE_TG_ACTIVITY=0`.
- **Stickers & media**: you can send stickers, photos, voice notes and files —
  the caption is used as the prompt text. Media without a caption gets a short
  acknowledgement (the bot reads text, not pixels).
- **Command menu**: the bot registers its `/` commands with Telegram, so typing
  `/` in the chat autocompletes them.

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
| `/setup` | Enable fixed session/topic management from General of a forum supergroup |
| `/new [title]` | In managed General: create a new session **and topic**; legacy chats keep their old behavior |
| `/ls`, `/sessions` | In managed General: show session/topic lifecycle cards |
| `/use <id>`, `/attach <id>` | In managed General: attach an idle existing session or find its existing topic |
| `/close <id>` | General: confirm stop, archive the session, then close its topic; keep history |
| `/restore <id>` | General: unarchive the original session and reopen the original topic |
| `/sync` | General: retry pending lifecycle reconciliation |
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
| `/clear` | Legacy only; never resets a managed topic binding |
| `/spawn <name> [dir]` | Create a worker: a new topic with its own session |
| `/board` | Status of every worker in this chat |
| `/kill <name>` | General: stop selected work without closing its topic; `/stopall` requests all workers stop |
| `/manager on\|off` | General: open/restore or archive the Manager's own session/topic |
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

Use a **supergroup with Topics enabled** and give the bot administrator access
with **Manage Topics**. An allowlisted user runs `/setup` in **General**; the bot
checks its actual permissions before enabling the new mode. Enabling it is
persisted per group, not a change to all existing chats.

```
📁 Forum supergroup
├─ General          ← management commands, session cards and approvals; no LLM
├─ Manager          ← optional Manager agent, its own fixed session
├─ 🟢 api-auth       ← one fixed session + directory/worktree
├─ 🟡 fix-login      ← questions and permissions for that session
└─ ✅ write-tests    ← finished turn; topic stays open until its session is closed
```

**By hand**: use `/new` or `/spawn api-auth ~/Code/app` in General, then work in
the returned topic. `/new`, `/use`, `/clear`, folder buttons and stale menus
cannot replace a managed topic's session. `/stop` stops work but leaves the
session/topic open. Closing from General waits for termination evidence before
archiving and closing; unconfirmed work retains its capacity slot.

**With the Manager**: `/manager on` in General opens its own topic. Talk to the
Manager there; it picks
directories, splits the work, and dispatches it to workers through a small tool
bridge (a local MCP server inside the bot, bound to `127.0.0.1`, token-guarded,
registered only for the Manager's own folder). When workers finish, their
results are fed back to the Manager, which summarises them for you.

**Tên chủ đề theo OpenCode**: trong General, mở `/sessions` → **Đồng bộ tên chủ đề**
→ xem trước → **Bật đồng bộ tên cho nhóm**. Bot tự cập nhật một chiều theo tiêu
đề phiên, không cần phiên quản lý hoặc gọi mô hình AI. Chính sách chỉ bật sau xác
nhận, không tự đổi tên hàng loạt khi cập nhật bot. Xem
[hướng dẫn vận hành](docs/session-topics-operations.md#đồng-bộ-tên-chủ-đề-theo-tiêu-đề-opencode).

Kế hoạch các cải tiến tiếp theo, thứ tự và tiêu chí nghiệm thu:
[quản lý phiên, tên chủ đề, quay lại công việc, thông báo và tìm kiếm](docs/plan-session-workflow-improvements.md).

- **Approval**: by default (`/auto off`) every dispatch the Manager wants —
  a new worker or a follow-up — appears in General as a card: `✅ Giao` / `❌ Huỷ` /
  `⚡ Giao + bật auto`. With `/auto on` it dispatches on its own.
- **Permissions and questions** of a worker always go to *you*, in that
  worker's topic. The Manager never answers them.
- **Guard rails**: at most `OPENCODE_TG_MAX_WORKERS` busy workers per chat; a
  dispatch budget per user message stops Manager ↔ worker loops; workers may
  only run under `OPENCODE_TG_BROWSE_ROOTS` (symlinks resolved first).
- **Parallel edits in one repo**: a writing worker that would share a git
  checkout with another busy writer gets its **own worktree + branch**
  (`<repo>.worktrees/<name>`, branch `tg/<name>`). When it's done, the topic
  offers worktree actions. Merge only runs on a clean main checkout on the base
  branch and aborts cleanly on conflict. Destructive legacy pruning/worktree
  removal is blocked for managed sessions; closing does not delete either.

OpenCode archive/unarchive/delete events are reconciled at startup, reconnect
and every minute, so a missed event does not silently create a replacement.
Each scheduled run gets a fresh topic and session; completed runs stay open
until explicitly closed. Durable execution replay is still required before
new scheduled runs can be admitted.

Existing chats and sessions are **not migrated automatically**. Same-group idle
legacy sessions can be explicitly attached; cross-chat ownership and ambiguous
duplicate bindings are refused. Private topic chats retain their legacy mode:
the archive/close workflow above requires a forum supergroup, not private-chat
topic support. See [operation and migration details](docs/session-topics-operations.md).

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
| `OPENCODE_TG_AUTO_CLOSE` | | on | Legacy-only close-on-turn-end; ignored for groups enabled with `/setup` |

\* required unless `OPENCODE_TG_ALLOW_ANY=1`.

## Running it in the background

It's a single long-running Node process. Never start another polling instance
for the same token. Source runs through `tsx`, without hot reload; edits require
restarting the existing process. Keep `data/state.json` across restarts.

```sh
# tmux / screen
tmux new -s ocbot 'npm start'

# nohup
nohup npm start > bot.log 2>&1 &

# Linux: install/configure deploy/opencode-bot.service as a user unit
systemctl --user enable --now opencode-bot
systemctl --user restart opencode-bot
journalctl --user -u opencode-bot -n 20 --no-pager
```

On macOS use the existing process supervisor or stop the known old process
before starting its replacement; systemd commands do not apply.

## Development

```sh
npm run typecheck   # strict tsc, no emit
npm run test:unit   # fast checks, no service needed (incl. topics, bridge, worktrees, orchestrator)
npm run test:session-topics # lifecycle, command scopes and protocol adapters
npm run smoke:session-topics # real OpenCode, isolated Telegram, no LLM calls
npm run smoke       # drive the bot through a mock Telegram + real OpenCode
npm run smoke:multi # parallel topics + Manager + approval against real OpenCode (a few minutes)
npm run dev         # same as start
```

`npm run smoke` needs no bot token: it uses the real OpenCode service and LLM
prompts with isolated Telegram delivery. Inspect menu, mode, sweep and question
relay sections, not just the exit code. `smoke:session-topics` creates only owned
empty sessions in an isolated directory and proves archive/restore/restart
recovery; it does not test Telegram's application interface or live group rights.

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
