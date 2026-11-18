# Spec: Typed callback registry

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-17
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Related:** `docs/sdd/split-bot-ts.md` (modules register here), `docs/sdd/message-layer.md` (keyboard helpers build buttons through this)

## 1. Problem

Inline buttons carry a `callback_data` string. Today about 62 of these are
written by hand across the code, with prefixes such as `bs:`, `wt:`, `sch:`,
`mdl:`, `fq:`, `use:`, `reboot:`, `perm:`, `nw:`, `mode:`, `ap:`, `variant:`,
`rot:`, `kill:`, `agent:`, `prune:`, `pb:`, `cmd:`, `ch:`, `cont:`, `q:`. The
dispatcher in `bot.ts` is a chain of `data.startsWith("xx:")` checks, and each
handler splits and parses its own string.

Consequences:
- A typo in a prefix compiles fine and the button silently does nothing.
- Two features can pick the same prefix without any warning.
- Telegram limits `callback_data` to 64 bytes. Nothing checks that, so a long path or id is cut off or rejected at runtime.
- Parsing differs per handler (`split(":")`, index access), so a malformed or stale button (old message, other user) is handled differently in each place.

## 2. Requirements (EARS)

### C1 Definition
- C1.1 Each callback prefix shall be declared once, in one place, with a name, an encoder (typed arguments to string) and a decoder (string to typed arguments, or a failure).
- C1.2 Registering a prefix that already exists shall fail at startup with a clear error naming both owners.
- C1.3 The encoder shall refuse (throw in tests, log and fall back in production) a result longer than 64 bytes.

### C2 Dispatch
- C2.1 `handleCallback` shall look up the prefix in the registry and call the matching handler with decoded arguments, replacing the `startsWith` chain.
- C2.2 A callback whose data matches no prefix, or fails to decode, shall be answered with a short "button expired" toast and logged once at `warn`. It shall not throw.
- C2.3 Existing authorization checks (allow-list, conversation ownership) shall run in the dispatcher before any handler, in one place.
- C2.4 Handlers shall always answer the callback query (no spinner left on the button), including on error.

### C3 Compatibility
- C3.1 The wire format of every existing callback (`prefix:arg:arg`) shall stay unchanged, so buttons on messages already sent keep working after a deploy.
- C3.2 Migration shall be per prefix. Unmigrated prefixes keep using the old chain until moved; the dispatcher tries the registry first, then the chain.
- C3.3 Each migrated prefix shall have a unit test: encode, decode round trip; malformed input; length limit.

## 3. Design

New `src/callbacks.ts`:

```ts
export interface CallbackDef<A> {
  prefix: string;                     // "mdl"
  encode(args: A): string;            // -> "mdl:pick:gpt-5"
  decode(rest: string): A | null;     // null = malformed
}
export function defineCallback<A>(def: CallbackDef<A>): CallbackDef<A>;
export function registerCallback<A>(def: CallbackDef<A>, handler: (ctx, cb, args: A) => Promise<void>): void;
export function dispatchCallback(ctx, cb): Promise<boolean>; // false = not in registry
```

- Helpers for common shapes: `simple(prefix)` (no arguments), `oneArg(prefix)`, `fields(prefix, [..])` so most prefixes are one line.
- The encoder checks the 64-byte limit with `Buffer.byteLength`, not string length (Vietnamese text and emoji take more than one byte).
- Long values (full paths, session ids) that do not fit are stored in a small short-lived map and referenced by a short token. The `bs:` browser already does something like this; the registry exposes it as `tokenArg()` so there is one implementation.
- `dispatchCallback` is the only place that answers the callback query on error, and the only place that applies the allow-list check (C2.3).

### Decisions (change any of them)
- Keep the existing string format (C3.1). No JSON or binary payloads.
- Migrate the smallest prefixes first (`pb`, `ch`, `cont`, `reboot`), the `bs:` menu last because it has the most sub-actions.
- Registry lives in its own file, not in `shared.ts`, because it has runtime logic.

### Risks and open questions
- **Old buttons after deploy.** Handled by C3.1; a test replays a captured list of real callback strings against the new decoders.
- **Handler signature differences.** Some handlers take `messageId`, some `conv`. The registry passes one context object; adapters are thin wrappers during migration.
- **Size.** Adds about 150 lines and removes the chain in `bot.ts`; net effect is neutral until all prefixes move.

## 4. Tasks (each ends with a human checkpoint)

1. [x] **T1 Inventory.** Read-only: list every `callback_data` producer and every consumer, with prefix, arguments and max length. Add the list to this spec. Flag any that can exceed 64 bytes. *Checkpoint: review the inventory.*
2. [x] **T2 Registry core** (C1, C2.1-C2.4). `src/callbacks.ts`, `scripts/test-callbacks.ts` added to `test:unit`. Dispatcher tries registry, then old chain (C3.2). No prefix migrated yet. *Checkpoint: review the API.*
3. [ ] **T3 Pilot migration:** `pb`, `ch`, `cont`, `reboot` with round-trip tests including a captured real callback string each. *Checkpoint: try the buttons in Telegram.*
4. [ ] **T4 Migrate the rest** in groups of 3-4 prefixes (`mode`, `agent`, `variant`, `mdl`; then `perm`, `rot`, `kill`, `prune`; then `nw`, `use`, `fq`, `cmd`, `sch`, `wt`, `ap`, `q`). *Checkpoint after each group.*
5. [ ] **T5 Migrate `bs:`** (the browser menu and its sub-actions). *Checkpoint: browse folders and pick a session in Telegram.*
6. [ ] **T6 Remove the old chain** and add a startup self-check that lists registered prefixes (C1.2). *Checkpoint: read the startup log.*
7. [ ] **T7 End-to-end.** `npm run smoke` once at the end, then restart the service and check the journal.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. T1 — Callback inventory (read-only, 2026-11-18)

### 5.1 Dispatch shape

One dispatcher: `Bot.handleCallback` (src/bot.ts:3910). Order:

1. Allow-list gate `this.allowed(cb.from.id)` → "Not allowed" toast (this is the single C2.3 spot today).
2. `conv = convOf(cb.message)`; no conv → silent answer.
3. Chain of `data.startsWith("<prefix>")` → per-prefix handler (table 5.2).
4. Orchestrator sub-dispatcher `Orchestrator.handleCallback` (src/orchestrator.ts:1645) for `ap:` / `wt:` / `prune:` — returns `false` if not one of those.
5. `bs:` is handled inline in the dispatcher: `data.split(":")` + `switch (action)` (src/bot.ts:4027).
6. Fallback: anything else is answered silently, no toast (a C2.2 gap: unknown/stale buttons vanish).

~90 button-construction sites across 14 files; **35 distinct prefixes**. Parsing is per-handler: most use `split(":")` + index access; only `cont:`, `note:`, `ns:` (and the spec family's `parseRunRef`, src/commands/spec.ts:247) have real validation.

### 5.2 Producer/consumer table

Bytes = max observed UTF-8 bytes of the full callback string. "—" = fixed string.

| Prefix | Wire format | Argument (source, bound) | Max bytes | Producer (file:line) | Consumer (file:line, parse) |
|---|---|---|---|---|---|
| `agent:` | `agent:<id>` · `agent:close` | id ∈ AGENT_WHITELIST (build/general/explore/plan) | 13 | src/commands/agents.ts:57-60 | src/commands/agents.ts `handleAgentCallback` (slice) |
| `ap:` | `ap:<id>:<ok\|no\|auto>` | id = `randomBytes(5)` hex, 10 chars | 15 | src/orchestrator.ts:1619-1622 | src/orchestrator.ts:1685 `handleApprovalCallback` (split, `approvals.get`) |
| `bs:` | `bs:<op>[:<n>]` — nav/up/pg/hid/open/list/setdir/setsess/close/noop | nav:<idx> = item index on page (≤11); pg:<n> = page | 10 | src/bot.ts:3846-3894 | src/bot.ts:4027 inline switch (split, `Number()`) |
| `ch:` | `ch:<id>:<i>` · `ch:inert` | id = 4-char base36 (choice registry); i = option index; inert = tapped-marker | 11 | src/choices.ts:225; src/bot.ts:4541 (inert) | src/bot.ts `handleChoiceCallback` :4485 (split, registry.get) |
| `cmd:` | `cmd:<cmd>` | c.cmd from COMMANDS, 40 entries, longest "variants" (8) | 12 | src/commands.ts:173 | src/bot.ts:4009 → `runCommandButton` :4124 (`data.slice(4)`) |
| `cont:` | `cont:<sessionID>` | OpenCode session id `ses_*`, observed 16–26 chars | 31 | src/continue.ts `continueCallbackData` (**omitted if >64**) | src/bot.ts:4446 `handleContinueCallback` (`parseContinueData`) |
| `fq:` | `fq:<formId>:<op>` — op ∈ x/c/o\<i\> | **formId = OpenCode server-generated, length unverified**; i = option index | ? | src/bot.ts:4983-4991 | src/bot.ts:4997 `handleFormCallback` (split, `questionForms.get`) |
| `kill:` | `kill:<name>` · `kill:close` | name = worker name = git worktree name, observed max 29 | 34 | src/orchestrator.ts:517-518 | src/orchestrator.ts:530 `handleKillCallback` (slice) |
| `mdl:` | `mdl:sel:<i>` · `mdl:pg:<n>` · `mdl:noop` · `mdl:close` | i = global model index (page·10 + pos); n = page | 10 | src/bot.ts:4256-4267 | src/bot.ts:4283 `handleModelCallback` (split, `Number()`) |
| `mode:` | `mode:<id>` · `mode:info` · `mode:close` | id ∈ MODES keys (build/plan/general/explore) | 12 | src/bot.ts:4345-4351 | src/bot.ts:4387 `handleModeCallback` (split(":")[1]) |
| `ns:` | `ns:<id>:<k>` | id = 4-char base36 (next-step registry); k = rule index | 11 | src/nextsteps.ts `callbackFor` (src/bot.ts:2995,3050) | src/bot.ts:4556 `handleNextStepCallback` (`parseCallback`) |
| `note:` | `note:<messageId>` | Telegram message id, ≤9 digits | 15 | src/notes.ts:115 (busy reply) | src/commands/meta.ts:65 `handleNoteCallback` (`parseNoteCallback`) |
| `nw:` | `nw:<op>` — clear/keep/cancel | — | 9 | src/bot.ts:3219-3221 | src/bot.ts:3623 `handleNewConfirmCallback` (split(":")[1]) |
| `pb:` | `pb:go` | — | 5 | src/bot.ts:2888 | src/bot.ts:4422 `handlePlanToBuildCallback` |
| `perm:` | `perm:<requestID>:<once\|always\|reject>` | **requestID = OpenCode server-generated, length unverified** | ? | src/bot.ts:5129-5132 | src/bot.ts:5195 `handlePermissionCallback` (split, `permissionPrompts.get`) |
| `prune:` | `prune:<id>` | id = `randomBytes(5)` hex, 10 chars | 16 | src/orchestrator/purge.ts:107 | src/orchestrator/purge.ts:117 `handlePruneCallback` (`prunePending.get`) |
| `q:` | `q:add:<messageId>` · `q:steer:<messageId>` | Telegram message id, ≤9 digits | 16 | src/busy.ts:35,40 (busy reply) | src/bot.ts:3495 `handleBusyCallback` (`parseBusyCallback`) |
| `reboot:` | `reboot:<op>[:<ms>]` — ask/snooze/cancel/go | go:<epoch-ms>, 13 digits | 22 | src/bot.ts:780-799 (src/uptime.ts `rebootGoData`) | src/bot.ts:823 `handleRebootCallback` (slice+split, `isRebootConfirmFresh`) |
| `rot:` | `rot:<op>` — cf/cx | — | 6 | src/bot.ts:3476 | src/bot.ts:3558 `handleRotationCallback` (split(":")[1]) |
| `sch:` | `sch:<op>:<id>` — p/run/d/dy · `sch:ls` | id = 4-char base36 (schedule store) | 12 | src/commands/schedule.ts:49-51,308-309 | src/commands/schedule.ts `handleScheduleCallback` (split, `scheduleStore`) |
| `spec:` | `spec:<name>` | name = docs/sdd file stem, observed max 28 | 33 | src/commands/spec.ts:111 | src/commands/spec.ts:1017 `handleSpecCallback` (startsWith+slice) |
| `specrun:` | `specrun:<name>:<n>` | name as above; n = task number | ~40 | src/commands/spec.ts:679,1138 | `handleSpecCallback` (`parseRunRef` :247) |
| `specblocked:` | `specblocked:<name>:<n>` | as above | ~43 | src/commands/spec.ts:1145 | `handleSpecCallback` (`parseRunRef`) |
| `specrunok:` | `specrunok:<name>:<n>` | as above | ~41 | src/commands/spec.ts:470 | `handleSpecCallback` (`parseRunRef`) |
| `spcacc:` | `spcacc:<spec>:<n>` | spec name; n = checkpoint task number | ~37 | src/spec-checkpoint.ts:264 | `handleSpecCallback` |
| `spcredo:` | `spcredo:<spec>:<n>` | as above | ~38 | src/spec-checkpoint.ts:265 | `handleSpecCallback` |
| `spcstop:` | `spcstop:<spec>:<n>` | as above | ~38 | src/spec-checkpoint.ts:266 | `handleSpecCallback` |
| `spcpr:` | `spcpr:<name>` | spec name | ~35 | src/commands/spec.ts:706 | `handleSpecCallback` |
| `spcready:` | `spcready:<name>` | spec name | ~38 | src/commands/spec.ts:702,871 | `handleSpecCallback` |
| `spcclean:` | `spcclean:<name>` | spec name | ~38 | src/commands/spec.ts:1167 | `handleSpecCallback` |
| `use:` | `use:<sessionID>` · `use:ls` · `use:close` | OpenCode session id, observed 16–26 chars | 30 | src/bot.ts:3737-3741 | src/bot.ts:3751 `handleUseCallback` (slice) |
| `variant:` | `variant:<v>` · `variant:close` | v = model-reported variant id, length unverified (short in practice) | ~14 | src/bot.ts:4724-4727 | src/bot.ts:4736 `handleVariantCallback` (slice) |
| `w:` | `w:<id>:<c\|r\|s>` | id = 4-char base36 (watch registry) | 8 | src/watch.ts:433-438 | src/bot.ts:2543 `handleWatchCallback` (split [1],[2]) |
| `ww:` | `ww:go` | — | 5 | src/bot.ts:1691 | src/bot.ts:2518 `handleWorkingWatchButton` |
| `wt:` | `wt:<name>:<diff\|merge\|rm\|rmok\|keep>` | name = worker/worktree name, observed max 29 | 36 | src/orchestrator.ts:1801-1849 | src/orchestrator.ts:1809 `handleWorktreeCallback` (split [1],[2]) |

### 5.3 64-byte risk flags

**Unbounded, name-derived, no guard — can exceed 64 if the name is long:**
1. `wt:<name>:<op>` — worker name comes from the git branch/worktree name; a name >55 chars breaks the button. Today's longest: 29 (`opencode-bot-fix-board-escape` → 36 bytes total).
2. `kill:<name>` — same name; breaks >60 chars (observed 34 bytes).
3. The spec family (10 prefixes, `spec:` … `spcclean:`) — name = `docs/sdd/*.md` file stem. Tightest is `specblocked:<name>:<n>`: breaks at a stem >~50 chars (observed max 43 bytes).

**External ids, no guard:**
4. `use:<sessionID>` — OpenCode session id, no length cap or omission path (observed max 26 → 30 bytes). `cont:` has the same input but **does** omit the button over 64 — `use:` doesn't.
5. `perm:<requestID>:<op>` — requestID is OpenCode-server-generated; format/length unverified on this box (no local source, no captured sample).
6. `fq:<formId>:<op>` — formId likewise server-generated, unverified.
7. `variant:<v>` — model-reported; short in practice, unverified.

**External ids, guarded:**
8. `cont:<sessionID>` — already refuses to ship over 64 (src/continue.ts `continueCallbackData`).

Everything else is structurally bounded (fixed strings, 4-char base36 ids, 10-hex ids, decimal indices/message ids, 13-digit timestamps) and cannot exceed 64 bytes.

Note: the spec's problem statement says "~62" hand-written buttons; the actual count is ~90 construction sites (35 prefixes).

## 6. Out of scope
Changing what any button does, new buttons, signing or encrypting callback data, persisting tokens across restarts, and rewriting the choice-button detector in `src/choices.ts` (it produces callbacks but keeps its own detection logic).
