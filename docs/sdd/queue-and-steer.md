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

**Key mechanism (from Q0, OpenCode 2.2.6):** `oc.prompt` gains a `delivery?: "steer" | "queue"` param, forwarded to `client.session.prompt`. OpenCode natively holds a `queue` prompt (runs after the current turn) and delivers a `steer` prompt at the running turn's next safe point (step boundary), auto-degrading to a queued turn when it cannot fold. `steer` is the server default. The bot delegates these to the server and keeps only a thin policy/UI/audit layer.

| Item | Approach |
|---|---|
| Prompt delivery | `opencode.ts` `oc.prompt(sessionID, text, { messageID?, delivery? })` forwards `delivery` to `client.session.prompt`. `queue` = server holds + runs after the current turn; `steer` = server delivers at the running turn's next safe point. |
| Queue store | New `src/queue.ts`: pure `QueueStore` keyed by conv — the bot-side policy/UI/audit layer. `push` -> `{ok, position}` or `{full}`; `shift`; `clear`; `expire(now)`; `list`. Time injected for tests. In memory only (see risks). It holds the message until the turn ends and is the source for the `/queue` list, the "you are #N" position, and expiry; the actual send happens in drain. |
| Busy UI | New `src/busy.ts` builds the busy reply and handles callbacks `q:add:<msgId>` and `q:steer:<msgId>`. Reads the text from `BusyNoteStore` (extended to retain until the turn ends). Replaces the two inline busy replies in `runPrompt` (`bot.ts`) and `promptManager` (`orchestrator.ts`). In `off` mode the reply is byte-identical to today. |
| Queue send (drain) | **Queue is a bot-side hold.** The message sits in `QueueStore`; on turn-end it is sent. Plain sessions / worker topics: in `runPromptTask`'s `finally` (after `inflight.delete`), if the turn succeeded and not `draining`, `drainQueue(conv)` calls `runPrompt` for the head item (the normal `inflight` guard still applies). Manager: `dropManagerTurn` gains an `outcome` param; only `succeeded` drains. (Native `delivery:"queue"` is *not* used here — the bot owns the hold for cap/expiry//queue/shutdown control; running-after-the-turn is equivalent either way.) |
| Steer (S-native, primary) | `q:steer` callback -> immediate `oc.prompt(sid, text, { delivery: "steer" })`. The server delivers at the next safe point (step boundary) and auto-degrades to a queued turn when it cannot (the spec's Q2.3 fallback, built-in) — no bot-side abort. Because it waits for a safe point, the button says "applies at the next safe point" (it does not freeze the current stream). Further steers while one is in flight are queued. |
| Steer (S-pivot, fallback) | Version-gated to OpenCode < 2.2.5 (no native `delivery`): abort the in-flight controller + `oc.interrupt(sid)` (what `stopCurrent(conv, true)` does, minus clearing the queue and the "Interrupted" message), wait for `inflight` to clear, then `runPrompt` with a mid-turn-correction preamble + text. The interrupted turn's partial reply is still shown (Q0 test D: interrupt keeps the partial). |
| Stop / clear | `stopCurrent` clears the queue (`/stop` means stop); `/new`, `/clear` and a session switch also clear it (Q1.5). |
| Shutdown | `drainInflight` sets `draining`; drain checks it; shutdown notifies queued chats that their messages were not run. |
| Config | `OPENCODE_TG_BUSY_MODE` in `src/config.ts` (`ask` default / `queue` / `off`), documented in the README config table (the doc-sync test enforces) and `.env.example`. |
| Command | `/queue` added to `src/commands.ts`, the README command table, and the golden set in `scripts/test-commands.ts`. |

### Decisions (change any of them)
- Default mode `ask`: nothing happens without a tap; the old note button stays.
- Queue cap 3, expiry 30 minutes.
- A failed turn **holds** the queue (does not run it): the next message may assume the earlier one worked.
- Queue is in memory only: a prompt that replays after a restart is a worse surprise than a lost one for a bot that runs code.
- **Queue = bot-side hold + drain** (not native `delivery:"queue"`): the bot owns cap/expiry//queue/shutdown. **Steer = native** (`delivery:"steer"`) because it must be sent while the turn runs.

### Risks and open questions
- ~~Unknown: what OpenCode does with a prompt sent to a busy session.~~ **Resolved by Q0** (see Findings): a busy prompt is accepted + queued; native `delivery:"steer"|"queue"` exists; interrupt keeps the partial reply.
- **Steer preemption (Q5 to confirm):** Q0 observed safe-point delivery + auto-degrade, but the steer landed after the turn's parallel tool steps had finished, so *preemption of still-pending steps* was not directly observed. Q5 should re-test with sequential steps to confirm a steer cuts off pending work.
- **Steer is not instant:** the correction waits for the next safe point; the UI says so (it does not freeze the current token stream).
- **Race at turn end:** a user message arriving exactly as a queued one starts. Draining goes through `runPrompt`, so the `inflight` guard decides; a loser goes back to the head of the queue.
- **Manager bot events:** a worker report starts a Manager turn the user did not start; a user message arriving then is queued behind it.
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

_Ran 2026-11-12 against the live OpenCode service **v2.2.6** (throwaway sessions; script `scripts/spike-busy-prompt.ts`, report `/tmp/opencode/q0-spike-report.json`)._

**Key discovery: OpenCode 2.2.6 has a NATIVE prompt `delivery` mode — `"steer" | "queue"` — on a per-session inbox.**
- API: `client.session.prompt({ sessionID, id, text, delivery?: "steer" | "queue" })` → returns `{ id: inboxID, delivery }`.
- **`steer` is the DEFAULT** when no `delivery` is passed (Exp A, no field → response `delivery=steer`).
- Server events: `session.inbox.enqueued` / `session.inbox.delivered` / `session.inbox.cancelled`, each carrying `delivery` (`@opencode/schema/dist/event-manifest.d.ts`: `delivery: ["steer","queue"]`).
- So the bot's **current** `oc.prompt()` (no delivery) already sends `steer`; it just never does so while busy because `runPrompt`/`promptManager` intercept with "Still working" before the prompt is sent.

**Q1 (busy prompt) — a prompt sent to a busy session:**
- **No error.** The prompt is **accepted and queued** as a separate assistant turn (runs after the current one). Exp A (no delivery) and Exp B (`delivery:"steer"`) both → "two separate assistant turns (users=2, assistants=2), session outcome succeeded". (Event level: the delivered prompt ran as the next step of the **same execution** — one `execution.started`/`succeeded` pair covering both prompts; the two assistant messages are two steps, not two executions.)
- The native **`queue`** mode is the explicit version of this behaviour.

**Q2 (interrupt mid-turn) — does interrupt keep the partial reply:**
- `interrupt` returns `{ interrupted: boolean }`. In Exp C the turn finished (~+27.8s) *before* the interrupt landed (~+28.4s) → `interrupted:false`, and the (complete) reply is preserved in message history. The clean "interrupt while actively generating" case was not captured (timing — the slow turn completed first); that path needs the correction sent while the turn is still emitting deltas.

**Recommendation for Q5 (steer mechanism): use S-native.**
- Steer = `session.prompt({ delivery: "steer" })`; Queue = `session.prompt({ delivery: "queue" })`. Both native — the bot delegates the hold / run-after / current-turn semantics to OpenCode's inbox instead of building its own queue store + abort-and-resend.
- **Design improvement for the spec:** this simplifies Q1/Q3/Q5 substantially. The bot's queue store shrinks to a UI/audit/policy layer (cap 3, expiry 30 min, position display, per-conv tracking) sitting on top of the native delivery; "drain" becomes "send with the right delivery" rather than "runPrompt the head item". **S-pivot** (abort + `oc.interrupt` + resend with preamble) remains a fallback, version-gated to < 2.2.5.
- **Part 2 (2026-11-12, `scripts/spike-interrupt.ts`, report `/tmp/opencode/q0-spike2-report.json`) — resolved both open items:**
- **D: interrupt mid-streaming** (interrupt 1.5s after `session.text.started`) → `{"interrupted": true}` (this time it actually interrupted), session outcome `interrupted`, and the **partial reply is preserved** (17 lines kept, the assistant message carries `ERROR=Step interrupted`). → **Q2 confirmed: interrupt keeps the partial reply** — the S-pivot fallback's key requirement holds.
- **E: steer between tool steps** (turn doing 3 separate file reads; steer "stop reading" sent after the first `tool.success`) → steer **delivered mid-execution at a step boundary** (`inbox.delivered` at `step.ended`, before `execution.succeeded`) and **answered as the next step of the SAME execution** (one execution.started/succeeded pair) — not a new execution. Note: the model batched all 3 reads into one parallel step, so *all reads and the original summary had already finished* by the time the steer landed — preemption of still-pending steps was therefore **not directly observed** in this run (flag for Q5: re-test with sequential steps). So steer is **safe-point delivery** — the correction joins the running turn at the next yield point — **not** a literal token-level fold into the in-flight generation. That matches Kiro's own definition ("deliver to the running turn at the next safe point").

**Revised recommendation for Q5: S-native, confirmed.**
- Steer = `session.prompt({ delivery: "steer" })` → delivered at the next safe point (step boundary) of the running turn. Queue = `delivery: "queue"`.
- The "fold" caveat is **resolved**: there is no token-level fold, but there *is* safe-point delivery (the correction joins the turn at the next step boundary), which is the intended steer behaviour. The bot shows the partial/running output until the safe point, then the correction takes over.
- S-pivot (abort + `oc.interrupt` + resend) remains a version-gated fallback for < 2.2.5; its interrupt keeps the partial reply (test D).
- **UI note for Q2/Q5:** because steer is not instant (it waits for a safe point), the "Steer now" button should tell the user the correction applies at the next safe point — it does not freeze the current token stream.

*Checkpoint (choose S-native or S-pivot):* **S-native** (`delivery:"steer"`), S-pivot as version-gated fallback. **Decision: S-native.**
