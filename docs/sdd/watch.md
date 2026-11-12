# Spec: /watch (a live view of the session, with Close and Stop task)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-12
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Builds on:** `src/stream.ts` (live preview and its edit throttling), `docs/sdd/queue-and-steer.md` (busy handling), `docs/sdd/phase1-foundations.md` (audit log)

## 1. Problem

`/history` is a snapshot. `cmdHistory` (`src/commands/meta.ts`) reads the session's
messages once, takes the last 6 (user text cut at 300 characters, assistant at
400) and sends a new message. To see progress the user has to send `/history`
again and again, and each call adds another message to the chat.

The bot does show progress while a turn it started is running: the activity line
("Reading src/bot.ts") is on by default, and the streaming preview is off by
default (`OPENCODE_TG_STREAM`). Neither helps in three cases:

- a turn that was not started from this chat (for example someone is driving the same session from the terminal on the machine);
- a long Manager turn, where the main chat shows only "Working";
- a user who wants a view they can open and close on demand, without turning the global preview on.

## 2. Goals and non-goals

**Goals**
- `/watch` posts one card that updates itself while the session works, and stops by itself when the turn ends.
- Two clearly separate buttons: **Close** (stop watching, delete the card) and **Stop task** (stop the agent, same as `/stop`).
- Never spam: one card per chat, throttled edits, a time limit.

**Non-goals (v1)**
- Changing `/history` itself. It stays a snapshot, and keeps its name.
- Watching another conversation's session (for example a worker's topic from the main chat). That is the natural next step, see section 6.
- Showing the full final answer in the card. The normal reply path still delivers it.
- Keeping a watch alive across a bot restart.

## 3. Requirements (EARS)

### W1 Starting and showing
- W1.1 When an allow-listed user sends `/watch`, the system shall post one card for the conversation's current session and start updating it.
- W1.2 If the conversation has no session, the system shall say so and post nothing.
- W1.3 The card shall show: the state (working, idle, done, failed, stopped), elapsed time of the running turn, the current tool step (the same short label as the activity line), the tail of the assistant text being written (about the last 1,200 characters, escaped), and the last user prompt cut to 200 characters.
- W1.4 If no turn is running when the card is posted, the system shall show the last 6 messages exactly as `/history` does and mark the card idle.
- W1.5 There shall be at most one watch per conversation. A second `/watch` shall close the first and start a new card.
- W1.6 `/live` shall be an alias of `/watch`.

### W2 Updating
- W2.1 The system shall update the card when OpenCode events for that session arrive (text written, tool step started, turn started or ended), and shall edit at most once per `OPENCODE_TG_WATCH_INTERVAL_MS` (default 3000, accepted range 2000 to 5000).
- W2.2 The system shall edit only when the rendered text has changed.
- W2.3 In group conversations the interval shall never be below 5000 ms, because group chats have stricter edit limits than 1:1 chats.
- W2.4 If Telegram answers with a flood-control error, the system shall honor its `retry_after` and double the interval up to 10 seconds, as the streaming preview does.
- W2.5 If no event has arrived for 10 seconds while a turn is running, the system shall fall back to reading the session state every 5 seconds, until events resume.

### W3 When the turn ends
- W3.1 When the turn succeeds, fails or is interrupted, the system shall make one final edit that shows the outcome and the turn's duration, and stop updating. It shall not repeat the assistant's answer.
- W3.2 The final answer shall reach the user through the normal reply path, unchanged. This covers turns started elsewhere too, because the bot already relays out-of-band turn results.
- W3.3 A frozen card shall offer **Close** and **Watch again**. Watch again shall behave as a new `/watch`.
- W3.4 If nothing happens for 60 seconds while the session is idle, the system shall freeze the card the same way.
- W3.5 No watch shall run longer than `OPENCODE_TG_WATCH_MAX_MIN` minutes (default 10); then the card freezes.

### W4 Buttons
- W4.1 **Close** shall stop updating and delete the card. It shall not affect the agent.
- W4.2 **Stop task** shall be shown only while a turn is running, on its own row, and shall do exactly what `/stop` does (stop waiting, interrupt the turn on the server, clear the queue as `/stop` does). The card shall then show "Stopped" and freeze.
- W4.3 Both buttons shall pass the allow-list check, work once, and be bound to the session the card was created for. If the conversation has moved to another session, the tap shall be refused and do nothing.
- W4.4 After a bot restart an old button shall answer "expired".

### W5 Stopping a watch automatically
- W5.1 The system shall stop a watch when the user runs `/new`, `/clear`, switches session, or when the bot shuts down.
- W5.2 If the card can no longer be edited (the user deleted it, or Telegram says the message is gone), the system shall stop that watch quietly.

### W6 Control and visibility
- W6.1 `/watch` shall be available only when `OPENCODE_TG_WATCH` is on (default) **and** the live preview is off (`OPENCODE_TG_STREAM` not set to `1`/`true`). `OPENCODE_TG_WATCH=0` disables it outright. In both cases nothing else in the bot shall change.
- W6.2 `/history` shall get a **🔴 Live** button under its snapshot that starts a watch. When `/watch` is not available (W6.1), `/history` shall be byte-identical to today, with no button.
- W6.7 If `OPENCODE_TG_WATCH` is on while the live preview is also on, the system shall log one startup warning that `/watch` is inactive because of `OPENCODE_TG_STREAM`, and shall not start any watch.
- W6.8 If a user sends `/watch` while it is inactive, the system shall reply with the reason (live preview is on, or the feature is switched off) and post no card.
- W6.3 The system shall write `watch_start`, `watch_end` (with the reason: done, idle, timeout, closed, replaced, session changed, edit failed, shutdown) and `watch_stop_task` to the audit log.
- W6.4 All card text and button labels shall be available in Vietnamese and English via `tr()`.
- W6.5 Card text shall go through the bot's secret redaction, like every other outgoing message.

## 4. Design

| Item | Approach |
|---|---|
| Pure core | New `src/watch.ts`, no I/O: `WatchState`, a reducer that folds events into state, `render(state, lang)` to HTML (kept under 4,096 characters), and the throttle and backoff rules. Time is injected, so it is unit-testable like `src/stream.ts`. |
| Events | Hook into the existing `onOpenCodeEvent` in `src/bot.ts`. Events carry a session id; `st.findChatBySession` already maps it to the conversation. Relevant ones: `session.text.delta`, `session.tool.called`, `session.execution.started/succeeded/failed/interrupted`. The tool step label comes from `toolActivityLabel`. |
| Why a message, not a draft | The streaming preview in 1:1 chats uses `sendMessageDraft`, which is ephemeral (about 30 s) and tied to the turn the bot started. The watch card must outlive that, so it is a normal message edited with `editMessageText` in every chat type. |
| Edit failures | Use `editMessageTextStrict` so a vanished card is detected (W5.2) instead of looking like a no-op. |
| Initial snapshot | Reuse the message list that `/history` reads, extracted into a small helper, for the idle card (W1.4) and the prompt line. |
| Fallback poll | `oc.sessionState(sid)` already tells busy or idle. It is used only in the gap described in W2.5. |
| Callback data | `w:<id>:c` (Close), `w:<id>:s` (Stop task), `w:<id>:r` (Watch again). `id` is a 4-character key into an in-memory registry with the conversation, session, card message id and a timeout (same shape as `choices.registry`). |
| Stop task | Calls the same path as `cmdStop`: `stopCurrent` plus `oc.interrupt`, including the Manager's busy flag. |
| Command | `/watch` (alias `live`) in `src/commands.ts`, the README command table, and the golden set in `scripts/test-commands.ts`. |
| Config | Three variables in `src/config.ts` (`OPENCODE_TG_WATCH`, `_INTERVAL_MS`, `_MAX_MIN`), documented in the README config table (the doc-sync test enforces this) and `.env.example`. The README row for `OPENCODE_TG_WATCH` says it has no effect while `OPENCODE_TG_STREAM` is on. |
| Preview exclusion | One derived value, `watchActive = cfg.watch && !cfg.stream`, computed once at config load and used by the command, the `/history` button and the startup warning (W6.7). No watch code runs when it is false, so the two live views can never edit the chat at the same time. |

### Decisions I made (change any of them)
- **Name:** new `/watch` command, `/history` unchanged. A rename would break the `/help` button, the README and habits for a feature that is not a rename.
- **Event-driven with a 3-second throttle,** not a fixed poll. Re-reading the whole message list every few seconds gets slower as a session grows. A fixed 2 to 5 second poll stays available only as the fallback.
- **Close deletes the card,** as you asked. Stop task does not delete it: it shows "Stopped" so you can see what happened.
- **Stop task has no confirm step,** matching `/stop`, but sits on its own row so it is hard to hit by accident.
- **The card does not repeat the final answer,** to avoid the same text twice in the chat.
- **10-minute limit and 60-second idle freeze,** so a forgotten card does not edit forever.
- **v1 watches only the conversation's own session.**
- **Only available when the live preview is off** (your instruction). Default for `OPENCODE_TG_WATCH` stays on, but it does nothing while `OPENCODE_TG_STREAM` is on, with a startup warning and a clear reply to `/watch` so it never looks broken.

### Risks and open questions
- **Overlap with the preview: removed by design.** `/watch` is inactive whenever the live preview is on (W6.1), so a turn never has two live views. The cost: someone who wants both has to pick one. The activity line (`OPENCODE_TG_ACTIVITY`, on by default) is a separate, lighter status message and still coexists with the card; its tool step and the card's tool step then show the same thing.
- **Telegram limits.** About 20 messages a minute in a group. A watch at 5 seconds is 12 edits a minute at most, and only when text changed.
- **Event coverage.** We assume session events arrive for turns driven from outside Telegram. Task W0 checks this before anything is built.
- **Privacy in groups.** The card shows the same content the normal replies show, to the same people. No new exposure, but worth stating.
- **Two people tapping Stop task.** The second tap finds nothing to stop and answers "not running".

## 5. Tasks (each ends with a human checkpoint)

0. **W0 Read-only check.** Without any model call, confirm: which fields the session events carry (session id, text part, tool name), whether events arrive for a turn driven from outside the bot, and that `deleteMessage` works on a message that has an inline keyboard. Write the result into a "Findings" section here. *Checkpoint: confirm the design holds.*
1. **W1 Core** (W1.3, W1.4, W2.1 to W2.4, W3.1). `src/watch.ts` with `scripts/test-watch.ts`: rendering and length limit, escaping, change detection, throttle, backoff, final states. *Checkpoint: review a sample card in both languages.*
2. **W2 Command and config** (W1.1, W1.2, W1.5, W1.6, W6.1, W6.4, W6.7, W6.8). `/watch`, config with the derived `watchActive`, README, `.env.example`, command catalog and golden set; config test for all four on/off combinations of `OPENCODE_TG_WATCH` and `OPENCODE_TG_STREAM`. *Checkpoint: review the wording of the "inactive" replies.*
3. **W3 Live updates** (W2, W3, W5). Event hooks, edit loop, fallback poll, idle and time limits, automatic stops. *Checkpoint: watch a real turn from the phone, in a DM and in a topic.*
4. **W4 Buttons** (W4). Close, Stop task, Watch again, session binding, restart behaviour. *Checkpoint: tap each one during a running turn.*
5. **W5 `/history` button and audit** (W6.2, W6.3, W6.5). The 🔴 Live button and the audit events. *Checkpoint: read a sample audit log.*
6. **W6 End-to-end.** One scenario in `npm run smoke`: start `/watch` during a turn, see the card change, see it freeze with the outcome. Smoke runs last, as in `AGENTS.md`; restart the service afterwards.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 6. Out of scope
Watching a worker from the main chat (`/watch <worker>`), several watches at once, paging back through older messages inside the card, persisting a watch across restarts, and live updates of `/history` itself.

## 7. Findings (filled in by task W0)
_Not run yet._
