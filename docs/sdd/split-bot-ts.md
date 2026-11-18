# Spec: Split `bot.ts` into feature modules

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-17
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Related:** `docs/sdd/callback-registry.md` (defines the handler shape used here), `docs/sdd/message-layer.md` (applied while moving code)

## 1. Problem

`src/bot.ts` is 5,241 lines with 59 imports (main, 2026-11-17). One `Bot` class holds command
routing, the callback dispatcher (an `if (data.startsWith("..."))` chain of
about 20 prefixes, plus a nested `switch` for the `bs:` menu), prompt running,
keyboards, message text and state changes. It has about 104 direct reply/edit
calls and 129 `catch` blocks.

Consequences:
- Any change to one feature touches the same file as every other feature, so
  parallel branches conflict and reviews are long.
- A feature cannot be read or tested without loading the whole class.
- `src/commands/` already shows the intended direction (`agents.ts`, `meta.ts`,
  `schedule.ts` export `cmdX(bot, conv, ...)` functions), but it holds only 3
  of the many commands.

## 2. Requirements (EARS)

### S1 Behaviour must not change
- S1.1 After every task, `npm run typecheck` and `npm run test:unit` shall pass.
- S1.2 The set of commands, callback prefixes, button labels and message texts shall be byte-identical before and after each move (a move is not a rewrite).
- S1.3 No move shall change `data/state.json` format, so running sessions reattach after a restart.
- S1.4 Each task shall be its own commit and shall pass on its own.

### S2 Structure
- S2.1 Each feature shall live in one file under `src/commands/` (commands, its callbacks, its keyboards).
- S2.2 A feature module shall receive the bot through a narrow interface (what it uses: `tg`, `st`, `oc`, `sendHtml`, language lookup), not the whole `Bot` class, so it can be tested with a fake.
- S2.3 `bot.ts` shall keep only: construction, update polling and routing, the inflight/draining guards, and wiring to feature modules.
- S2.4 Target size: `bot.ts` under 1,200 lines at the end. No feature module over 600 lines.
- S2.5 No circular imports between feature modules. Shared helpers go in `src/shared.ts` or an existing helper file.

### S3 Process
- S3.1 Features shall move one at a time, smallest and most isolated first.
- S3.2 The repo shall stay releasable between tasks (no half-moved feature on `main`).

## 3. Design

**Pattern:** follow `src/commands/agents.ts`. A module exports
`cmdX(bot, conv, arg, state)` for commands and `handleXCallback(bot, cb, conv,
messageId)` for its prefix. `bot.ts` keeps a thin line per feature that calls
the module. Once `callback-registry.md` lands, those lines become registry
entries and the `if` chain disappears.

**Narrow interface (S2.2):** add `src/commands/ctx.ts` exporting a `BotCtx`
type: the subset of `Bot` that feature modules touch. `Bot` implements it, so
no behaviour changes; tests pass a fake.

**Confirmed modules** (task 1, real call graph of `src/bot.ts`, 5,241 lines,
2026-11-18). The 8 below are the *command + callback* surface — the phase-1
split. Per-module: the functions that move, the `Bot` fields they touch, and
the tests that cover them (call-graph detail at the bottom of this section).

| Module | Commands / callbacks moved out of `bot.ts` | ~L* |
|---|---|---|
| `commands/browse.ts` | `/dir`, `/browse`, `bs:` menu (`nav`,`up`,`pg`,`hid`,`open`,`list`,`setdir`,`setsess`,`close`) | 239 |
| `commands/session.ts` | `/new`,`/clear`,`/ls`,`/history`,`/stop`,`/use`, `use:`,`nw:` | 264 |
| `commands/model.ts` | `/model`,`/models`,`/variant`,`/variants`,`/mode`,`/modes`, `mdl:`,`variant:`,`mode:` | 362 |
| `commands/permission.ts` | `perm:` (ask → card → resolve relay) | 145 |
| `commands/rotation.ts` | `rot:`, `/rotation` (re-locate from `meta.ts`), manager-floor monitor | 278 |
| `commands/notes.ts` | `cont:`, `q:add:`/`q:steer:` busy callbacks, `/note` (re-locate from `notes.ts`) | 111 |
| `commands/admin.ts` | `/reboot`,`/status`,`/usage`,`/context` (re-locate from `meta.ts`), `reboot:`, `kill:` (orch) | 98 |
| `prompt-runner.ts` | `runPrompt`,`runPromptTask`,`drainInflight`,`trackPending`,`drainQueue`,`stopCurrent` | 325 |

\* bot.ts lines of the named functions (`bs:` switch counts as browse).
`/status`,`/usage`,`/context`,`/rotation`,`/note` are *re-located* from
`commands/meta.ts` / `notes.ts` — their bodies already live outside `bot.ts`,
so they cost ~0 lines to "move" (re-import only).

**Confirmed move order** — a module may move once every `this.` member it calls
is still reachable (still on `Bot`, or already moved and kept on the narrow
`BotCtx` interface):

1. `permission` — 0 cross-module calls; own state `permissionPrompts`; the best
   unit-tested small module (`test-perm-relay` drives `bot.ts` directly).
   *(The draft pilot was `rotation`; `permission` is the slimmer, better-tested
   pilot — recommended swap.)*
2. `notes` — busy/continue callbacks; calls `runPromptTask` (stays on `Bot`
   until `prompt-runner` moves last).
3. `rotation` — calls `applyModelAndVariant` (model) + `stopCurrent` (both still
   on `Bot` at this point).
4. `admin` — self-contained (`rebootArmed` own); re-locates `meta.ts` commands.
5. `model` — 0 cross-module calls; `modelPickers` own. **Must move before
   `session`** (session calls `applyModelAndVariant`).
6. `browse` — `browsers` own; its `setsess` action calls `stopCurrent` +
   `applyModelAndVariant` (both already moved).
7. `session` — calls `applyModelAndVariant` (model, moved) + `stopCurrent`.
8. `prompt-runner` — **last**: the turn engine (`inflight`/`draining`/`drafts`/
   `turnGen`); every other feature calls into it (`runPromptTask`, `stopCurrent`,
   `prepareNotesTurn`).

**Shared primitives that must stay on the narrow interface (`BotCtx`)** —
called across module boundaries, so they cannot be private to one module:
- `stopCurrent(conv, interrupt)` — aborts `inflight`, drops preview/queue/notes.
  Used by session, browse (`setsess`), rotation, prompt-runner. Recommended
  home: `prompt-runner` (owns `inflight`), exposed via `BotCtx`.
- `applyModelAndVariant(sid, state)` + `resolveModel` — model primitives called
  by session, rotation, browse, prompt-runner.
- `cancelAllReminders` / `startPromptReminder` / `findPromptConv` — reminder
  plumbing used by permission, session, prompt-runner.
- Core services `tg`/`oc`/`st`/`cfg`/`userPrefs` + the message/turn surface
  `sendHtml`/`sendReply`/`startTyping`/`stopTyping`/`startWorking`/`stopWorking`/
  `clearActivity`/`stopWatch`/`dropPreview`.

**Scope note (affects S2.4's 1,200-line target).** The 8 modules move ~1,820 of
the 5,241 lines. `bot.ts` also holds whole subsystems *not* in the 8: `watch`
(~430 L), `next-step`/`ns:` (~320), streaming+`activity` (~230), question
`forms` (~210), `reminders` (~170), message-layer (~170), `reactions` (~145),
`pr-watch` (~130), `choices`/`ch:` (~70), media (~70), `recovery` (~85),
`uptime` (~50). Hitting S2.4 (bot.ts < 1,200) needs those as modules too.
**Open for the checkpoint:** confirm the 8 as phase 1, with the subsystems as
phase 2 (T7+) — recommended.

### T1 call graph (functions · `Bot` fields · tests)

Fields = class state touched; **bold** = cross-module/shared (must be on
`BotCtx`). Tests = the `scripts/test-*` that cover it; "live" = only covered by
the pure-helper test + a live run (no direct `bot.ts` unit test).

- **permission** — `onPermissionAsked`, `sendPermissionCard`,
  `onPermissionResolved`, `handlePermissionCallback`.
  Fields: `permissionPrompts` (own), **oc, orch, st, tg, userPrefs**; methods
  `startPromptReminder`, `cancelReminder`, `findPromptConv`, `editCardInPlace`.
  Tests: `test-perm-relay` (drives `bot.ts`), `test-perm-timeout` (budget
  auto-reject). **Strongest coverage of the small modules.**
- **notes** — `handleBusyCallback` (`q:add:`/`q:steer:`),
  `handleContinueCallback` (`cont:`), `prepareNotesTurn`.
  Fields: `busyNotes`, `queue` (public, shared w/ orch), **inflight, oc, st,
  tg, userPrefs**; method `runPromptTask` (prompt-runner), `startTyping`.
  Tests: `test-notes`, `test-notes-callback`, `test-busy`, `test-continue`
  (all test the pure helpers in `notes.ts`/`busy.ts`; the handler glue is
  **live-only**).
- **rotation** — `managerFloor`, `rotateHandoff`, `startRotationMonitor`,
  `checkManagerRotation`, `doManagerRotation`, `writeRotationSnapshot`,
  `rotationHealthSnapshot`, `sendRotationConfirm`, `handleRotationCallback`.
  Fields: `rotationTimer`, `rotationTickInFlight` (own), **draining, inflight,
  orch, cfg, oc, st, tg, userPrefs**; methods `applyModelAndVariant` (model),
  `stopCurrent` (session/runner), `cancelAllReminders`.
  Tests: `test-rotation` (pure floor math only); handlers **live-only** (via
  `/status`).
- **admin** — `sendRebootConfirm`, `cmdReboot`, `handleRebootCallback`; plus
  re-locate `cmdStatus`,`cmdUsage`,`cmdContext` from `meta.ts`; `kill:` →
  `orch.handleKillCallback` (one-line delegate, no body).
  Fields: `rebootArmed` (own), **cfg, st, tg, userPrefs**.
  Tests: `test-uptime` (pure reboot decision), `test-health`, `test-usage`
  (pure math); `bot.ts` handlers **live-only**.
- **model** — `cmdModels`,`cmdModel`,`applyModelPick`,`renderModelPage`,
  `showModelPicker`,`handleModelCallback`,`currentMode`,`applyMode`,
  `renderModePicker`,`cmdMode`,`handleModeCallback`,`cmdVariants`,
  `cmdVariantSet`,`applyVariant`,`sendVariantPicker`,`handleVariantCallback`,
  `resolveModel`,`applyModelAndVariant`.
  Fields: `modelPickers` (own), **cfg, oc, st, tg, userPrefs**; `sendHtml`.
  Tests: **none direct** (no `test-model`); `/models` formatting in
  `test-format`. **Live-only — the least-covered module.**
- **browse** — `cmdDir`, `cmdBrowse`, `reloadBrowse`, `renderBrowse`, + the
  inline `bs:` switch in `handleCallback`.
  Fields: `browsers` (own), **cfg, st, tg, userPrefs**; `setsess` calls
  `stopCurrent` (session), `applyModelAndVariant` (model), `stopWatch`.
  Tests: `test-fsbrowser` (pure path-jail + `listDirs` only); the browse
  command + `bs:` handlers are **live-only**.
- **session** — `cmdNew`,`doNewSession`,`handleNewConfirmCallback`,
  `summarizeForHandoff`,`cmdList`,`cmdUse`,`applyUseState`,`sendUsePicker`,
  `handleUseCallback`,`stopTaskFor`,`cmdStop`,`cmdClear` (+ re-locate
  `cmdHistory` from `meta.ts`).
  Fields: `questionForms` (own), **busyNotes, cfg, inflight, orch, queue, oc,
  st, tg, userPrefs**; methods `applyModelAndVariant` (model), `stopCurrent`,
  `cancelAllReminders`, `stopWatch`, `clearActivity`, `dropPreview`.
  Tests: `test-use-cmd` (drives `bot.ts` `/use` + `use:` callback — **strong**),
  `test-continue`; `/new`,`/clear`,`/ls`,`/stop`,`/history` **live-only**.
- **prompt-runner** — `trackPending`,`drainInflight`,`runPrompt`,
  `runPromptTask`,`drainQueue`,`stopCurrent`.
  Fields: **drafts, draining, inflight, languageRemoved, nextStepFooters,
  pendingSends, queue, turnGen** + `busyNotes`,`cfg`,`oc`,`orch`,`st`,`tg`,
  `userPrefs`; methods `applyModelAndVariant` (model), `prepareNotesTurn`
  (notes), `start/stopWorking`, `clearActivity`, `dropPreview`, next-step
  builders, `notifyQueuedNotRunning`, `stopAllWatches`, `sendReply`/`sendHtml`.
  Tests: `test-drain` (`drainInflightCore` in `bot.ts`), `test-queue`,
  `test-queue-cmd`, `test-stream`, `test-activity`, `test-event-loop`,
  `test-turn-reconnect`, `test-nextsteps`, `test-board-nav`,
  `test-nextstep-residual`. **Most-covered module.**


### Decisions (change any of them)
- Move code, do not improve it. Improvements (message helpers, typed callbacks) come from the other two specs, applied to a file after it has moved.
- One PR per 2-3 modules, not one giant PR, so each can be reviewed and reverted alone.
- Do the split after `callback-registry.md` task 3, so moved modules register themselves instead of adding to the `if` chain.

### Risks and open questions
- **Hidden shared state.** Private fields of `Bot` used from many places (inflight map, draining flag) make some features harder to move. Task 1 lists these; the narrow `BotCtx` exposes them deliberately.
- **Merge conflicts** with open PRs that edit `bot.ts`. Mitigation: check open PRs before each move and move modules nobody is editing.
- **Tests that import `Bot` internals** may need small import path updates. Allowed; assertions must not change.

## 4. Tasks (each ends with a human checkpoint)

1. [x] (1cb938d) **T1 Call graph and list.** Read-only: for each candidate module, list the functions, the `Bot` fields they use and the tests that cover them. Write the confirmed module list and move order into this spec. *Checkpoint: approve the list.*
2. [x] (b13d524) **T2 `BotCtx` and one pilot module** (`permission`). Add `commands/ctx.ts`; move permission; no behaviour change. *Checkpoint: review the pattern before repeating it.*
3. [x] (65ede38) **T3 Small modules:** `permission`, `notes`. *Checkpoint: line count and tests.*
4. [x] (3ca575a) **T4 Medium modules:** `model`, `admin`. *Checkpoint: try the buttons in Telegram.*
5. [x] (a9c6a84) **T5 Large modules:** `session`, `browse`. *Checkpoint: try the folder browser and `/new` in Telegram.*
6. [x] (7f7cb89) **T6 `prompt-runner`.** Move last. *Checkpoint: run a real turn, queue and stop.*
7. [x] (d9aa43b) **T7 Cleanup.** Remove dead imports, check the size targets (S2.4), update `README.md` architecture notes if any.
8. [x] (9d58fb9) **T8 End-to-end.** `npm run smoke` once at the end, then restart the service (`systemctl --user restart opencode-bot`) and check the journal.

**T8 result (2026-11-18).** `npm run smoke` from the merged branch (main `87ad169`/v1.47.0 + T1–T7), Node 24: SMOKE_EXIT=0, all sections green — menu/mode, prompt relay, NEXT-STEP, QUICK-REPLIES, QUEUE (auto-queue → drain → empty), WATCH, and S8 (real spec worker: run → checkpoint → accept → marker). Service restarted on v1.47.0; journal is clean (0 WARN/ERROR on startup) and shows the callback-registry self-check line `callback registry: 35 prefixes — …` (C1.2), confirming the registry dispatch is live.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Rewriting handlers, changing texts or buttons, changing state format, replacing grammY-style routing, adding a test framework, and any security hardening (tracked separately).
