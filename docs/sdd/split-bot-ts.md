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

**Proposed modules** (final list confirmed in task 1 from a real call graph):

| Module | Moves out of `bot.ts` |
|---|---|
| `commands/browse.ts` | `bs:` menu and folder browser (`nav`, `up`, `pg`, `hid`, `open`, `setdir`, `setsess`) |
| `commands/session.ts` | `/new`, `/clear`, `/ls`, `/history`, `/stop`, `use:`, `nw:` |
| `commands/model.ts` | `/model`, `/variant`, `/mode`, `mdl:`, `variant:`, `mode:` |
| `commands/permission.ts` | `handlePermissionCallback`, `perm:` |
| `commands/rotation.ts` | `handleRotationCallback`, `rot:` |
| `commands/notes.ts` | note and busy callbacks, `cont:`, `q:` |
| `commands/admin.ts` | `/reboot`, `/status`, `/usage`, `/context`, `reboot:`, `kill:` |
| `prompt-runner.ts` | `runPrompt`, `runPromptTask`, inflight and drain logic |

Order of moving: smallest and least coupled first (`rotation`, `permission`,
`notes`), then `model`, `admin`, `session`, `browse`, and `prompt-runner` last
because every other feature calls into it.

### Decisions (change any of them)
- Move code, do not improve it. Improvements (message helpers, typed callbacks) come from the other two specs, applied to a file after it has moved.
- One PR per 2-3 modules, not one giant PR, so each can be reviewed and reverted alone.
- Do the split after `callback-registry.md` task 3, so moved modules register themselves instead of adding to the `if` chain.

### Risks and open questions
- **Hidden shared state.** Private fields of `Bot` used from many places (inflight map, draining flag) make some features harder to move. Task 0 lists these; the narrow `BotCtx` exposes them deliberately.
- **Merge conflicts** with open PRs that edit `bot.ts`. Mitigation: check open PRs before each move and move modules nobody is editing.
- **Tests that import `Bot` internals** may need small import path updates. Allowed; assertions must not change.

## 4. Tasks (each ends with a human checkpoint)

1. **T1 Call graph and list.** Read-only: for each candidate module, list the functions, the `Bot` fields they use and the tests that cover them. Write the confirmed module list and move order into this spec. *Checkpoint: approve the list.*
2. **T2 `BotCtx` and one pilot module** (`rotation`). Add `commands/ctx.ts`; move rotation; no behaviour change. *Checkpoint: review the pattern before repeating it.*
3. **T3 Small modules:** `permission`, `notes`. *Checkpoint: line count and tests.*
4. **T4 Medium modules:** `model`, `admin`. *Checkpoint: try the buttons in Telegram.*
5. **T5 Large modules:** `session`, `browse`. *Checkpoint: try the folder browser and `/new` in Telegram.*
6. **T6 `prompt-runner`.** Move last. *Checkpoint: run a real turn, queue and stop.*
7. **T7 Cleanup.** Remove dead imports, check the size targets (S2.4), update `README.md` architecture notes if any.
8. **T8 End-to-end.** `npm run smoke` once at the end, then restart the service (`systemctl --user restart opencode-bot`) and check the journal.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Rewriting handlers, changing texts or buttons, changing state format, replacing grammY-style routing, adding a test framework, and any security hardening (tracked separately).
