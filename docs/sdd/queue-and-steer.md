# Spec: Queue and Steer (messages sent while the agent is working)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-10
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Related:** `docs/sdd/phase1-foundations.md` (audit log events reused here)

## 1. Problem

Agent turns on a phone take minutes, and the user often notices a wrong
direction halfway through. Today a message sent while a turn is running is
**not delivered at all**. `runPrompt` (`src/bot.ts`) and `promptManager`
(`src/orchestrator.ts`) reply "Still working on the previous message" with a
"save as note" button. The text is kept in `BusyNoteStore` (in memory, capped,
cleared when the turn ends). The only other choices are `/stop`, which throws
the turn away, or waiting and retyping.

Two different wants hide in that moment:

- **Queue:** "do this after you finish." Nothing should be lost, nothing should
  be interrupted.
- **Steer:** "change course now." The running turn should take the correction
  into account without the user losing the work already done.

This is the same split other agent tools expose as Steer vs Queue. The public
Kiro docs describe steering as delivering the message to the running turn at the
next safe point, and say a steer that cannot be delivered becomes a visible
queued message instead of being dropped
([queue steering](https://kiro.dev/docs/cli/chat/queue-steering/),
[message controls](https://kiro.dev/docs/crew/chat/message-controls/)).
We borrow the behaviour, not any implementation.

## 2. Requirements (EARS)

### Q1 Queue
- Q1.1 When a message arrives while a conversation's turn is running and the user taps **Queue** (or busy mode is `queue`), the system shall store it in that conversation's queue and reply with its position.
- Q1.2 The queue shall hold at most 3 messages. When it is full the system shall say so and keep the message available as a note; it shall not drop it silently.
- Q1.3 When a turn ends successfully, the system shall send the oldest queued message as a new turn, one at a time, in order.
- Q1.4 When a turn ends in an error, or is interrupted by something other than `/stop`, the system shall hold the queue and offer **Run queue** / **Clear queue**; it shall not auto-run.
- Q1.5 When the user runs `/stop`, `/new`, `/clear` or switches session, the system shall clear that conversation's queue and say how many messages were dropped.
- Q1.6 A queued message older than 30 minutes shall expire, and the user shall be told.
- Q1.7 Only allow-listed users shall be able to enqueue, with the same check as normal prompts. The sender id is recorded.
- Q1.8 While the bot is shutting down (`draining`), the system shall not start queued turns, and shall tell each chat that its queued messages were not run.
- Q1.9 Queue shall work for plain sessions, worker topics and the Manager chat.
- Q1.10 If the user taps Queue after the turn has already ended, the system shall run the message immediately as a normal prompt.

### Q2 Steer
- Q2.1 When a message arrives while a turn is running and the user taps **Steer now**, the system shall deliver the text to the running turn using the mechanism chosen in task Q0.
- Q2.2 If that mechanism is interrupt-and-resend, the button and confirmation shall say so plainly ("stops the current step, keeps work done so far"), and the resent message shall carry a fixed preamble marking it as a mid-turn correction.
- Q2.3 If a steer cannot be delivered, the system shall fall back to Queue and say so; it shall not drop the message.
- Q2.4 While a steer is being delivered, further steers shall be queued instead.
- Q2.5 Steering the Manager shall affect only the Manager's own turn. Running workers continue, and the existing 12-dispatch budget keeps applying.

### Q3 Controls and visibility
- Q3.1 `OPENCODE_TG_BUSY_MODE` shall accept `ask` (default: busy reply with Queue / Steer now / note buttons), `queue` (auto-queue, no tap) or `off` (exactly today's behaviour).
- Q3.2 `/queue` shall list queued messages with their age, and `/queue clear` shall empty the queue.
- Q3.3 Each enqueue, run, drop, expiry and steer shall be written to the audit log as `queue_add`, `queue_run`, `queue_drop`, `steer`.
- Q3.4 The existing "save as note" button and `/note` shall keep working unchanged.
- Q3.5 All new user-facing text shall be available in Vietnamese and English via `tr()`.

## 3. Design

| Item | Approach |
|---|---|
| Queue store | New `src/queue.ts`: pure `QueueStore` keyed by conv. `push` -> `{ok, position}` or `{full}`; `shift`; `clear`; `expire(now)`; `list`. Time is injected for tests. In memory only (see risks). |
| Busy UI | New `src/busy.ts` builds the busy reply and handles callbacks `q:add:<msgId>` and `q:steer:<msgId>`. It reads the text from `BusyNoteStore` (extended to retain it until the turn ends). Replaces the two inline busy replies in `runPrompt` and `promptManager`. |
| Drain, plain sessions and worker topics | In `runPromptTask`'s `finally` (after `inflight.delete`), if the turn succeeded and not `draining`, call `drainQueue(conv)`, which calls `runPrompt` for the head item so the normal `inflight` guard still applies. Worker-topic user messages already take this path. |
| Drain, Manager | `dropManagerTurn` is where the busy flag is cleared on succeeded / failed / interrupted. Pass the outcome there; only `succeeded` drains. |
| Stop / clear | `stopCurrent` clears the queue (`/stop` means stop). |
| Steer, S-native | Used only if the spike shows OpenCode folds a prompt sent to a busy session into the running turn. |
| Steer, S-pivot | Fallback: abort the in-flight controller and call `oc.interrupt(sid)` (what `stopCurrent(conv, true)` does, minus clearing the queue and the "Interrupted" message), wait for `inflight` to clear, then `runPrompt` with preamble + text. The partial reply of the interrupted turn is still shown. |
| Shutdown | `drainInflight` sets `draining`; queue drain checks it; shutdown notifies queued chats. |
| Config | `OPENCODE_TG_BUSY_MODE` in `src/config.ts`, documented in the README config table (the doc-sync test enforces this) and `.env.example`. |
| Command | `/queue` added to `src/commands.ts`, the README command table, and the golden set in `scripts/test-commands.ts`. |

### Decisions I made (change any of them)
- Default mode is `ask`, so nothing happens without a tap and the old note button stays.
- Queue cap 3, expiry 30 minutes: enough for a phone, small enough that a forgotten queue cannot run something stale hours later.
- A failed turn **holds** the queue instead of running it: the next message may assume the earlier one worked.
- Queue is in memory only: a prompt that replays itself after a restart is a worse surprise than a lost one for a bot that runs code.

### Risks and open questions
- **Unknown:** what OpenCode does with a prompt sent to a busy session (error, queue it, or fold it into the turn). Task Q0 answers this before any steer code is written.
- **Interrupt mid-edit:** S-pivot can stop between a tool call and the next step, leaving a half-finished change. The session history keeps what was done and the correction says so, but a worktree may need a look afterwards. Steer is therefore opt-in per message, never automatic.
- **Race at turn end:** a user message arriving exactly as a queued one starts. Draining goes through `runPrompt`, so the existing `inflight` guard decides; a loser goes back to the head of the queue.
- **Manager bot events:** a worker report starts a Manager turn that the user did not start. A user message arriving then is queued behind it, like any other turn.
- **Cost:** queued messages are real prompts and spend tokens; the audit log makes them visible.

## 4. Tasks (each ends with a human checkpoint)

0. **Q0 Spike.** Add `scripts/spike-busy-prompt.ts` (manual, not in `test:unit`). Against the live OpenCode service, in a throwaway session and directory, start a short slow turn, send a second prompt while it runs, and record: error, queued after, or folded in. Also record whether `interrupt` keeps the partial reply. Write the result into a "Findings" section here. Costs a few real LLM prompts. *Checkpoint: choose S-native or S-pivot.*
1. **Q1 Queue store** (Q1.2, Q1.6). `src/queue.ts` with unit tests: order, cap, expiry, clear, per-conv isolation. *Checkpoint: review the API.*
2. **Q2 Busy UI** (Q1.1, Q1.7, Q1.10, Q3.1, Q3.4, Q3.5). `src/busy.ts`, config, README and `.env.example`, callbacks. In `off` mode behaviour must be identical to today. *Checkpoint: try the buttons in Telegram.*
3. **Q3 Drain** (Q1.3, Q1.4, Q1.5, Q1.8, Q1.9 for plain and worker). Hook into `runPromptTask` and `stopCurrent`, shutdown notice. Extend the drain tests. *Checkpoint: review failure and stop behaviour.*
4. **Q4 Manager drain** (Q1.9, Q2.5). Outcome through `dropManagerTurn`; test in `test:multi`. *Checkpoint: review with a running worker.*
5. **Q5 Steer** (Q2.x). Implement the mechanism chosen in Q0, with the fallback to Queue. *Checkpoint: steer a real turn from the phone.*
6. **Q6 `/queue` and audit** (Q3.2, Q3.3). Command, golden set, README row, audit events. *Checkpoint: read a sample audit log.*
7. **Q7 End-to-end.** One extra scenario in `npm run smoke`: queue a message during a turn and see it run after. Smoke is the last step, as in `AGENTS.md`; restart the service afterwards.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Persisting the queue across restarts, editing or reordering queued messages, priorities, steering advisor (`/ask`) threads, and overlap between scheduled runs and queued messages.

## 6. Findings (filled in by task Q0)
_Not run yet._
