# Spec: Rule-based next-step buttons

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-12
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Builds on:** `docs/sdd/queue-and-steer.md` (merged: busy replies, `audit()` events with `meta`), `docs/sdd/phase1-foundations.md` (audit log)
- **Related research:** `docs/sdd/interactive-buttons-research.md` (model-written choice buttons, "Pattern B")

## 1. Problem

On a phone, typing is the expensive part of working with an agent. When a turn
ends, the useful next move is often obvious: look at what a worker changed,
check on the other workers, recover from a context overflow. Today the user has
to remember the command and type it.

The bot already does this in three one-off places, each with its own callback
prefix and its own handler:

| Existing button | Shown when | Where |
|---|---|---|
| `pb:go` Switch to build & execute | a plan-mode turn succeeds | `maybeOfferPlanToBuild` in `src/bot.ts` |
| `cont:<sid>` Continue | a turn fails for real (not `/stop`) | `offerContinueKeyboard` + `src/continue.ts` |
| `wt:<name>:diff/merge/rm` | a worker with a git worktree finishes | `worktreeKeyboard` in `src/orchestrator.ts` |

Plus the model-written choice buttons (`ch:<id>:<i>`, `src/choices.ts`), which
appear only if the model happens to end its reply with a lettered list.

Kiro's public docs describe the same idea as follow-up suggestions: the agent
proposes next steps, a click pre-fills a prompt and sends nothing, and the
default is silence unless a task was large
([follow-up suggestions](https://kiro.dev/docs/crew/)). We borrow the behaviour
and the restraint. We do not borrow the mechanism: Kiro's suggestions are
written by the agent, ours are decided by plain rules in the bot.

## 2. Goals and non-goals

**Goals**
- One small, shared place that decides "which next-step buttons, if any, belong under this turn's result", from facts the bot already has.
- Deterministic and free: no model call, same behaviour on any model.
- Quiet by default: a button appears only when a rule has a reason.
- Measurable: every shown button and every tap is in the audit log.

**Non-goals (v1)**
- Model-generated suggestions (a second LLM call that proposes next steps). Decide after we see tap rates.
- Replacing the three existing buttons above. They keep working as they are; the new engine does not duplicate them.
- Buttons that write, merge, delete or deploy. v1 only offers read-only actions.

## 3. Requirements (EARS)

### N1 Deciding
- N1.1 When a turn ends, the system shall evaluate a fixed rule table against facts the bot already holds (outcome, interrupted, conversation kind, agent mode, worker writes/worktree, elapsed time, busy-worker count, files changed). It shall make no model call.
- N1.2 The system shall show at most 3 buttons, in one row, and nothing at all when no rule applies (no empty message).
- N1.3 If the reply carries model-written choice buttons, or the turn already carries a dedicated keyboard (Continue, Switch to build), the system shall not add its own buttons to that turn.
- N1.4 The system shall not show buttons after a turn the user stopped (`/stop`, `interrupted`), after an advisor (`/ask`) thread, or after an unattended scheduled run.
- N1.5 A rule shall fire only for a turn that ended while the conversation was otherwise idle, so a button never appears under a result that a queued message is about to supersede.

### N2 Rules in v1

| Id | Fires when | Button | Action on tap |
|---|---|---|---|
| `review` | plain session on the build agent, turn succeeded, took at least `OPENCODE_TG_NEXT_MIN_SECS`, and files changed since the last offer | 🔍 Review changes | same read-only review as `/review` (`reviewPrompt`) |
| `review` | a worker with `writes: true` finishes with status done and made changes | 🔍 Review | same, in the worker topic; added to the worktree card when there is one |
| `board` | a Manager turn ended and at least one worker is still running or waiting | 📋 Board | runs `/board` (read-only, no agent turn) |
| `new-keep` | a turn failed with a context-overflow error (`isOverflowError` in `src/format.ts`) | ♻ New session, keep context | opens the existing `/new` confirm (`nw:` flow); it asks before doing anything |

- N2.1 `review` shall never be shown in the Manager conversation (`/review` already refuses there: the Manager has no repo).
- N2.2 `review` shall not fire for workers that cannot write (`writes: false`, plan/explore/general read-only agents).
- N2.3 "Files changed since the last offer" shall mean: the set of modified files reported for the session now contains a path it did not contain when `review` was last offered in this conversation. The set is kept in memory per conversation.

### N3 Tap behaviour
- N3.1 Every button shall work once. After a tap the system shall remove that keyboard.
- N3.2 A button shall be bound to the session it was created for. If the conversation has since moved to another session (`/new`, `/use`, `/clear`), the tap shall be refused with a short message and do nothing.
- N3.3 If a turn is running when the button is tapped, the system shall refuse with "A task is running" and keep the button.
- N3.4 The prompt a button sends shall be fixed text from the code, never model-generated, and the button label shall say what happens.
- N3.5 Taps shall pass the same allow-list check as any callback.
- N3.6 A button that outlived a bot restart shall answer "expired" instead of failing silently.
- N3.7 When the user sends their next message, the previous next-step keyboard shall be removed (best effort).

### N4 Control and visibility
- N4.1 `OPENCODE_TG_NEXT_STEPS` shall turn the feature on (default) or off with `0`. When off, behaviour shall be identical to today.
- N4.2 `OPENCODE_TG_NEXT_MIN_SECS` (default 90) shall set the minimum turn length for the `review` rule on plain sessions.
- N4.3 The system shall write `nextstep_shown` and `nextstep_tap` to the audit log with the rule id, so tap rates can be measured.
- N4.4 All button labels and messages shall be available in Vietnamese and English via `tr()`.

## 4. Design

| Item | Approach |
|---|---|
| Engine | New `src/nextsteps.ts`, pure: `decide(facts, cfg) -> Suggestion[]`. A `Suggestion` is `{ rule, label(lang), action }`. The rule table is one array, easy to read and to test. No I/O, time injected. |
| Facts | `{ kind: "plain" \| "worker" \| "manager" \| "advisor" \| "scheduled", outcome, interrupted, agent, elapsedMs, worker?: { writes, hasWorktree }, busyWorkers, filesNew: boolean, overflow: boolean, hasChoices, hasOtherKeyboard }`. Built where the turn ends; the engine never touches Telegram or OpenCode. |
| Callback data | `ns:<id>:<k>`. `id` is a 4-character base36 key into an in-memory registry (same shape as `choices.registry`: conversation, session, rule, created-at, 24 h TTL). Short enough for Telegram's 64-byte limit and carries no user text. |
| Where it renders | Plain session: on the existing quiet footer message (`<outcome> · <seconds>`) so there is no extra message. Worker with a worktree: added to the worktree card. Worker without a worktree and Manager: one short line with the buttons. |
| Files changed | Reuse what `/context` already reads (`oc.getSessionReport(sid).modifiedFiles`). It is called only after the cheap gates pass (succeeded, build agent, long enough), not on every turn. |
| Tap handling | New `ns:` branch in `handleCallback`: look up the registry, run the N3 checks, then call the same function the matching command uses (`reviewPrompt` through `runPrompt`, `/board`, the `/new` confirm). |
| Queue interplay | Buttons appear when the conversation is idle, so a tap normally runs immediately. A tap on a busy conversation is refused (N3.3); it does not queue. |
| Config | Two variables in `src/config.ts`, documented in the README config table (the doc-sync test enforces it) and `.env.example`. |
| Existing buttons | Untouched in v1. A later cleanup could move Continue and Switch-to-build onto the engine; not needed now. |

### Decisions I made (change any of them)
- **One tap, no confirm, for fixed read-only actions.** I earlier suggested a confirm step for every button. For these rules it adds a tap and little safety: the prompt is fixed, read-only, and the label says what it does (the Continue and Switch-to-build buttons already work this way). A confirm step is required once a button can write, or once its prompt is model-generated.
- **Default on.** The rules are gated, so the feature stays quiet, and we need it on to measure it. `0` switches it off.
- **90 seconds** as the "meaningful turn" line for plain sessions. A guess; the audit log will tell us whether to move it.
- **Board only when workers are still busy.** Showing it after every Manager reply would be noise.

### Risks and open questions
- **Review noise.** "A long build turn that touched new files" is a proxy for "worth reviewing". It will sometimes show after a turn that was mostly discussion. Mitigation: measure taps, then tune the threshold or drop the rule.
- **Cost of the files check.** `getSessionReport` is one extra OpenCode call at the end of qualifying turns. Task S0 checks its speed and what `modifiedFiles` contains (per session or per turn) before we rely on it.
- **Keyboard clutter.** Old keyboards stay on old messages in Telegram. One-shot taps (N3.1) and removal on the next message (N3.7) keep this bounded.
- **Rules can disagree with the model.** If the model's own reply already says "want me to review?", the button is redundant but harmless.
- **Dependency.** Audit events need the audit log from Phase 1 (merged).

## 5. Tasks (each ends with a human checkpoint)

0. **S0 Read-only check.** Without any model call, read how `getSessionReport` behaves on a real session (time taken, whether `modifiedFiles` is per session). The overflow check is `isOverflowError` in `src/format.ts`; confirm it is what the failure path already uses. Write the result into a "Findings" section here. *Checkpoint: confirm the `review` rule's data source.*
1. **S1 Engine** (N1, N2, N3.1 to N3.6). `src/nextsteps.ts` with the rule table, `decide`, the registry and callback encoding, plus `scripts/test-nextsteps.ts`: every rule, the exclusions, the 3-button cap, thresholds, encoding under 64 bytes, TTL, session binding. *Checkpoint: review the rule table as a table.*
2. **S2 Config and docs** (N4.1, N4.2, N4.4). Two variables, README and `.env.example`; doc-sync stays green; `off` behaves exactly as today. *Checkpoint: review the wording.*
3. **S3 Plain sessions** (N1.3 to N1.5, N3.7). Build facts at the turn end in `runPromptTask`, attach to the footer, `ns:` tap handler for `review`. *Checkpoint: try it from the phone.*
4. **S4 Workers** (N2.1, N2.2). Add `review` to the worktree card and to writing workers without one. *Checkpoint: finish a worker and tap Review.*
5. **S5 Manager and failures.** `board` after a Manager turn with busy workers, `new-keep` on overflow. *Checkpoint: check both with a real Manager chat.*
6. **S6 Audit** (N4.3). `nextstep_shown` and `nextstep_tap`; a small summary of tap rate per rule, readable from the log. *Checkpoint: read a sample log.*
7. **S7 End-to-end.** One extra scenario in `npm run smoke` with `OPENCODE_TG_NEXT_MIN_SECS=0`: a build turn that changes a file shows Review, and tapping it starts a review turn. Smoke runs last, as in `AGENTS.md`.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 6. Out of scope
Model-generated suggestions, buttons that write or merge, moving the three existing buttons onto the engine, per-user preferences for which rules to show, and suggestions after scheduled runs.

## 7. Findings (filled in by task S0)
_Not run yet._
