# Spec: /terminal (run a shell command from Telegram)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-13
- **Scope:** `opencode-telegram-bot`
- **Format:** analysis -> requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Builds on:** `docs/sdd/phase1-foundations.md` (audit log), `docs/sdd/watch.md` (Kill button pattern), the `/reboot` confirm flow in `src/bot.ts`
- **Command shape:** `/terminal <command>`; one pair of surrounding quotes is accepted: `/terminal "git status"`

## 1. Why, and what it is

Today the only way to run a command on the host from Telegram is to ask the agent to do it. That costs a model turn, can be refused or reworded by the model, needs the OpenCode service to be healthy, and cannot be done while the agent is busy. Common phone-side needs are small: `git status`, `tail -n 50 data/audit.log`, `df -h`, `systemctl --user restart opencode-bot`, `journalctl --user -u opencode-bot -n 30`.

`/terminal` runs one command directly on the host, as the bot's own OS user, in the chat's working folder, and returns the result. No model is involved.

This is the most powerful command the bot would have. The sections on authorization (section 3, C2) and on replay (C6) are the core of the spec; the rest is convenience.

## 2. Analysis

### What exists today
- **Command dispatch** is `text.startsWith("/")` in `Bot` (`handleCommand`), reached from the message handler and also from a **media caption** that starts with `/` (the file is dropped and the caption is dispatched).
- **Command suffix:** a command addressed to a different bot (`/cmd@OtherBot`) currently has its `@name` stripped and runs. The bot object does not know its own username (`getMe` is called in `src/index.ts` only to log it).
- **Authorization** is the global allow-list (`TELEGRAM_ALLOWED_USER_IDS`); `OPENCODE_TG_ALLOW_ANY=1` removes it.
- **Update offsets:** `Telegram.poll` sets `this.offset = u.update_id + 1` in memory *before* the handler runs. The offset is confirmed to Telegram only by the next `getUpdates`. If the process dies while handling an update, Telegram **redelivers** it after the restart.
- **Outbound text** is redacted by pattern (`redactSecrets`) on every send. Long content can go out as a document (`sendContentSmart` / `sendDocument`).
- **Dangerous-action precedent:** `/reboot` uses a two-step confirm with a one-time token.
- **Other exec in the bot** is narrow and fixed: `git`, `gh`, `sudo -n` for the safe-reboot script, all with argument vectors, no shell. There is no general command runner.
- **OpenCode has a native shell endpoint**, `POST /api/session/:id/shell` (`session.shell`): runs one command in the session's folder and emits `session.shell.started` and `session.shell.ended` (status `exited | timeout | killed`, exit code, signal, merged output, with paging). The bot already listens for these events to draw the activity line. A separate endpoint replaces the process environment used by a session's shell commands.

### Two ways to build it

| | A. OpenCode `session.shell` | B. Bot-local runner |
|---|---|---|
| Runs as | the OpenCode service process | the bot process |
| Needs OpenCode healthy | yes | no |
| Works while the agent is busy | unknown, to be tested | yes |
| Command and output enter the session history | likely (that is how `!cmd` works in the TUI); unverified | no |
| Environment | the OpenCode service's, replaceable per session | built from an allow-list, no secrets |
| Timeout, kill, output cap | native statuses; kill path unverified | we own all three |
| Code to write | small | medium (spawn, kill, cap, tests) |

**Recommendation: B for v1.** It is the only option that works when OpenCode is the thing that is broken (restarting it is a typical use), it does not put shell output into the model's context, and its failure modes are ours to test. A stays a later "share this output with the agent" option. Task T0 checks A's semantics at no model cost, so the choice is made on facts.

### Risks specific to this command
1. **Replay after a crash.** `/terminal systemctl --user restart opencode-bot` kills the bot mid-update; on restart Telegram redelivers the same update and the command runs again: a restart loop. Any command that stops the bot is exposed. Needs a persisted "already ran" record (C6).
2. **Wrong sender of the text.** The command must come only from a message the user typed. Buttons, the message queue, schedules, quick replies, the Manager and advisor threads all turn text into prompts for the agent; none of them may ever dispatch `/terminal`. A caption on an uploaded file must not either.
3. **Addressed to another bot.** In a group, `/terminal@OtherBot ...` must not run here.
4. **Phone keyboards rewrite characters.** iOS "smart punctuation" turns `--` into `—` and `"` into `“ ”`, so `ls --all` or `grep "x"` silently changes meaning. Refuse and explain; never convert silently.
5. **Secrets in output.** `env`, `printenv`, `cat .env` print secrets to a chat. Pattern redaction misses formats it does not know. The runner starts from a clean environment, and the exact values of the bot's own configured secrets are masked in addition to the pattern redaction.
6. **No keyboard for programs that ask questions.** With no terminal, `vi`, `top`, `ssh` or a password prompt would hang until the timeout. stdin is closed so prompts fail fast.
7. **Typos on a phone.** `rm -rf ~/x ` with a stray space. A denylist is not a security boundary (the user is trusted and could write the same thing a hundred ways); a confirm card for obviously destructive patterns is a typo guard only, and is documented as such.
8. **The Manager's folder.** Running in the Manager chat would run inside `data/manager/<chat>`, where its agent file lives. Refuse there, as `/review` does.

## 3. Requirements (EARS)

### C1 Invocation
- C1.1 When an authorized user sends `/terminal <command>` the system shall run the command as in C3 and reply with the result as in C4.
- C1.2 If the whole argument is one string wrapped in matching straight quotes with no other quote of that kind inside, the system shall remove that one pair; otherwise it shall use the argument as written.
- C1.3 With no argument the system shall reply with a usage text (what it does, the working folder, the timeout, that each command is a fresh shell, that there is no keyboard input) and run nothing.
- C1.4 If the command contains any of these characters, the system shall refuse and name the character and its ASCII replacement: en dash, em dash, curly single or double quotes, non-breaking space, zero-width characters. It shall not convert them.
- C1.5 A command longer than 2,000 characters or containing a NUL shall be refused.
- C1.6 `/terminal` shall be an exact command match only; it shall not have an alias.

### C2 Authorization and scope
- C2.1 The system shall run `/terminal` only when the sender's numeric id is in `OPENCODE_TG_TERMINAL_USERS` and also passes the normal allow-list. An empty list switches the feature off. `OPENCODE_TG_ALLOW_ANY=1` shall not enable it.
- C2.2 The system shall run it only in private chats (and topics of a private chat) unless `OPENCODE_TG_TERMINAL_GROUPS=1`.
- C2.3 The system shall run it only from a text message the user sent. It shall not run from a media caption, a callback, a queued or drained message, a scheduled prompt, a quick-reply or choice button, a Manager or advisor turn, or any text the agent produced.
- C2.4 If the command word carries an `@name`, the system shall run it only when `name` is this bot's own username (case-insensitive). The Bot shall be given its username at startup.
- C2.5 In the Manager conversation the system shall refuse and say why.
- C2.6 The working folder shall be the conversation's directory (a worker's directory for a worker topic), which must exist and lie under the configured browse roots; otherwise the system shall refuse.
- C2.7 A refusal shall say which rule applied and shall not reveal other users' ids or configuration values.

### C3 Execution
- C3.1 The system shall run the command with the configured shell in non-login, non-interactive mode (`-c`), in its own process group, with stdin closed.
- C3.2 The environment shall be built from an allow-list: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TZ`, `SHELL`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` (so `systemctl --user` works), the names listed in `OPENCODE_TG_TERMINAL_ENV`, plus fixed `TERM=dumb`, `NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`. Nothing else shall be inherited.
- C3.3 When the timeout (`OPENCODE_TG_TERMINAL_TIMEOUT_SEC`, default 30, maximum 300) elapses, the system shall send SIGTERM to the process group and, 3 seconds later, SIGKILL, and report "timed out".
- C3.4 The system shall run at most one terminal command per conversation and at most 3 across the bot; a further request shall be refused with the reason.
- C3.5 If a turn is running in the conversation the system shall still run the command (the main use is looking while the agent works) and say so in the header when the command touches the same folder.

### C4 Output
- C4.1 The system shall capture stdout and stderr merged, keep at most 256 KB, keep draining beyond that without storing, and mark the result truncated.
- C4.2 The system shall strip ANSI escape sequences and replace invalid UTF-8 and control characters except newline and tab.
- C4.3 The reply shall show the command (cut at 200 characters), then the output in a preformatted block, then one footer line: `exit <code>` or `signal <name>` or `timed out`, and the duration. Everything shall be HTML-escaped.
- C4.4 If the output exceeds 3,500 characters the reply shall show its last 3,000 characters and the system shall also send the full captured output as a text document.
- C4.5 No output shall be shown as "(no output)".
- C4.6 All text sent shall go through the bot's pattern redaction and shall also have the exact values of the bot's configured secrets (bot token, advisor token, OpenCode service password, MCP bridge token) replaced by `***`.
- C4.7 The output shall not be added to any agent session.

### C5 Confirmation (typo guard)
- C5.1 Where `OPENCODE_TG_TERMINAL_CONFIRM` is `risky` (default), the system shall, for a command matching a destructive pattern, post a confirm card with **Run** and **Cancel** instead of running. The pattern list shall cover recursive or forced deletion near `/`, `~` or `*`, `mkfs`, `dd` to a device, redirects to a device, fork bombs, `shutdown`/`reboot`/`halt`/`poweroff`, `sudo`, and `curl`/`wget` piped to a shell.
- C5.2 The card shall be bound to the user, the conversation and the exact command, work once, and expire after 60 seconds.
- C5.3 `always` shall confirm every command; `never` shall confirm none.
- C5.4 The documentation shall state that the pattern list is a typo guard, not a security control.

### C6 Control, replay and restarts
- C6.1 While a command runs, its card shall show a **Kill** button; tapping it (same sender checks) shall stop the process group as in C3.3 and report "killed".
- C6.2 Before starting a process the system shall persist the update's chat and message id with state "running". If an update with the same chat and message id is seen again, the system shall not run it and shall say "already ran".
- C6.3 At startup, any record still "running" shall be marked "unknown (bot restarted)" and its card edited to say so.
- C6.4 The records of the last 50 runs shall be kept; older ones may be dropped.
- C6.5 At shutdown the system shall not wait for running commands.

### C7 Visibility
- C7.1 The system shall write to the audit log: `terminal_run` (user, chat, folder, command redacted and cut at 500 characters, outcome, exit or signal, duration, truncated), `terminal_refused` (the rule), `terminal_confirm` (run or cancel), `terminal_kill`.
- C7.2 `/terminal` shall appear in `/help`, the command menu and the README, in Vietnamese and English.
- C7.3 When the feature is switched off, the command shall reply that it is not enabled and shall not appear in the menu or `/help`.

## 4. Design

| Item | Approach |
|---|---|
| Pure core | New `src/terminal.ts`: `parseTerminalArg` (C1), `findBadChars`, `riskOf(command)`, `buildEnv(baseEnv, extraNames)`, `sanitizeOutput`, `formatResult`, `maskSecrets(text, secrets)`. No I/O; unit-tested with a table of cases. |
| Runner | `runCommand({ shell, command, cwd, env, timeoutMs, maxBytes })` in the same file, using `spawn(shell, ["-c", command], { detached: true, stdio: ["ignore","pipe","pipe"] })`, a ring-limited buffer, and `process.kill(-pid, sig)`. A `spawn` seam is injected for tests. POSIX only: tests are skipped on Windows. |
| Handler | New `src/commands/terminal.ts` with the checks in C2, the confirm card, the Kill button and the replay record. Command registered in `src/commands.ts` (group `control`) and the golden set in `scripts/test-commands.ts`; shown only when enabled (C7.3). |
| Dispatch checks | Only the plain-message path calls the handler (C2.3). The media-caption path and `cmd:` callbacks reject it; the check is a test. |
| Bot username | `Bot` receives `me.username` from `src/index.ts` and exposes it to `handleCommand` (C2.4). |
| Callback data | `tm:<id>:<k>` with a 4-character registry id (same pattern as `choices` and `nextsteps`), `k` = `run`, `no` or `kill`. |
| Replay record | `MACHINE_STATE_KEY.terminalRuns`: `[{ chat, msgId, state, startedAt, cardMsgId }]`, written before spawn, updated on finish, trimmed to 50. |
| Config | `OPENCODE_TG_TERMINAL_USERS`, `_GROUPS`, `_TIMEOUT_SEC`, `_CONFIRM`, `_SHELL` (default `/bin/bash`, fallback `/bin/sh`), `_ENV`, in `src/config.ts`, the README config table (doc-sync enforces this) and `.env.example`. |
| Systemd | The unit pins `PATH`, so tools found by the bot are found by the command. Commands do not read the user's profile or aliases (documented). |
| Docs | A README section: what it is, the allow-list, the clean environment, the replay guard, examples, and that each command is a fresh shell (use `/dir` to change folder). |

### Decisions I made (change any of them)
- **Bot-local runner (B), not OpenCode's shell endpoint.** Reasons in section 2.
- **Off until configured.** A separate `OPENCODE_TG_TERMINAL_USERS` list, so being allowed to use the bot is not enough. `ALLOW_ANY` cannot enable it.
- **Private chats only** by default.
- **Runs while the agent is busy** (read-only looks are the common use), with a note in the header when the folder is the same.
- **Confirm only for destructive patterns,** not for every command, and described as a typo guard.
- **No flags** (`-t 120`, `-d dir`): the whole argument is the command. Timeout and shell are config.
- **Output is not shared with the agent.** A later "share this output with the agent" button is possible.
- **Refuse smart punctuation** instead of fixing it, so what ran is always what was typed.

### Risks and open questions
- **The allow-listed user is fully trusted.** Anyone who controls that Telegram account controls the host as the bot's user. This is already true through the agent; `/terminal` removes the model and the permission prompts from that path. The second allow-list and DM-only default narrow it; they do not remove it. Turning on two-factor login for the Telegram account is the real protection and the README should say so.
- **Commands that stop the bot.** Handled by C6.2 and C6.3, but the result of such a command can never be reported. The card says so.
- **`sudo` and the sudoers rule** are the host's business. The bot does not widen them.
- **Process groups:** a command that daemonizes (`nohup x &`) survives the timeout kill. Documented.
- **Concurrency with the agent** can interleave edits in the same folder. The header note is the only mitigation.
- **Windows:** not supported; the bot targets Linux under systemd, with macOS for development.

## 5. Tasks (each ends with a human checkpoint)

0. **T0 Spike (optional, no model cost).** In a throwaway session and folder, send `echo hi` through `session.shell` and record: does the command or output enter the session history or context, does it run while a turn is busy, which environment and timeout it uses, how to stop it. Write the result into "Findings". *Checkpoint: confirm B, or choose A.*
1. **T1 Pure core** (C1, C4.2 to C4.6, C5.1, C3.2). `src/terminal.ts` pure functions and `scripts/test-terminal.ts`: quote rules, bad characters, risk patterns (positives and near-misses), environment building (no secret survives), ANSI and control stripping, secret masking, formatting and truncation. *Checkpoint: review the risk-pattern table.*
2. **T2 Runner** (C3, C4.1). `runCommand` with tests against a real shell: exit codes, stderr merge, timeout kill of a child tree, output cap with continued draining, stdin closed, env isolation (`printenv` shows no bot secret), cwd. *Checkpoint: review the kill behaviour.*
3. **T3 Config and docs** (C2.1, C2.2, C3.4, C7.2, C7.3). Variables, README section, `.env.example`, command catalog and golden set; config tests for the on/off combinations. *Checkpoint: review the wording.*
4. **T4 Handler** (C1.3 to C1.5, C2.3 to C2.7, C5, C6.1). Authorization, scope checks, confirm card, Kill button, busy header; tests for the dispatch rules (caption, callback, queue, schedule, quick reply) in `test-multi` or a new file. *Checkpoint: try it from the phone, including a refused and a confirmed command.*
5. **T5 Replay guard and audit** (C6.2 to C6.5, C7.1). Persisted records, startup repair, a test that a redelivered update does not run twice (simulate with a fake Telegram), audit events. *Checkpoint: run `systemctl --user restart opencode-bot` through `/terminal` on the real service and confirm there is no restart loop.*
6. **T6 End-to-end.** One safe scenario in `npm run smoke`: `/terminal echo smoke-ok` returns the output. Smoke runs last, as in `AGENTS.md`; restart the service afterwards.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 6. Out of scope
Interactive programs and a pseudo-terminal, a persistent shell session (`cd` that sticks), live streaming of output (see `docs/sdd/watch.md`), file upload or download through the command, running on another machine, per-command timeouts, command history and re-run buttons, sharing output with the agent, and Windows.

## 7. Findings (filled in by task T0)
_Not run yet._
