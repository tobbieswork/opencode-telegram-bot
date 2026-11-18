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

1. [ ] **T1 Inventory.** Read-only: list every `callback_data` producer and every consumer, with prefix, arguments and max length. Add the list to this spec. Flag any that can exceed 64 bytes. *Checkpoint: review the inventory.*
2. [ ] **T2 Registry core** (C1, C2.1-C2.4). `src/callbacks.ts`, `scripts/test-callbacks.ts` added to `test:unit`. Dispatcher tries registry, then old chain (C3.2). No prefix migrated yet. *Checkpoint: review the API.*
3. [ ] **T3 Pilot migration:** `pb`, `ch`, `cont`, `reboot` with round-trip tests including a captured real callback string each. *Checkpoint: try the buttons in Telegram.*
4. [ ] **T4 Migrate the rest** in groups of 3-4 prefixes (`mode`, `agent`, `variant`, `mdl`; then `perm`, `rot`, `kill`, `prune`; then `nw`, `use`, `fq`, `cmd`, `sch`, `wt`, `ap`, `q`). *Checkpoint after each group.*
5. [ ] **T5 Migrate `bs:`** (the browser menu and its sub-actions). *Checkpoint: browse folders and pick a session in Telegram.*
6. [ ] **T6 Remove the old chain** and add a startup self-check that lists registered prefixes (C1.2). *Checkpoint: read the startup log.*
7. [ ] **T7 End-to-end.** `npm run smoke` once at the end, then restart the service and check the journal.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Changing what any button does, new buttons, signing or encrypting callback data, persisting tokens across restarts, and rewriting the choice-button detector in `src/choices.ts` (it produces callbacks but keeps its own detection logic).
