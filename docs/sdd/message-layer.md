# Spec: Message and keyboard layer

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-17
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Related:** `docs/sdd/callback-registry.md` (buttons are built through it), `docs/sdd/split-bot-ts.md`, `docs/sdd/language-preference.md` (`tr()` stays as is)

## 1. Problem

The bot has no visual design system, but it does have a visual language: icons,
status lines, error messages, confirm buttons, pickers. It is written out by
hand wherever it is needed:

- About 384 emoji literals across `src/`. Only worker status has a shared table (`ICON` in `src/format.ts`).
- About 383 `tr(lang, "vi", "en")` calls, each building its own sentence and formatting.
- About 104 direct reply/edit calls in `bot.ts` plus more in `orchestrator.ts` and `telegram.ts`, each choosing its own `parse_mode`, escaping and truncation.
- Keyboards are built inline, one object literal at a time.

Consequences: the same idea looks different in different commands (an error
may start with `❌`, `⚠️` or nothing), a forgotten `esc()` breaks HTML parsing
for the whole message, and changing a convention means editing hundreds of
places.

## 2. Requirements (EARS)

### M1 Single source of look
- M1.1 All shared icons (success, error, warning, info, running, waiting, stopped, back, close, confirm) shall be defined once in `src/ui/icons.ts`. `ICON` (worker status) shall be moved there and re-exported from `format.ts` until callers are updated.
- M1.2 Message helpers shall exist for the repeating shapes: `okLine`, `errorLine`, `warnLine`, `statusLine`, `titledList`, `codeBlock`.
- M1.3 Each helper shall escape its untrusted arguments itself, so a caller cannot forget it, and shall accept already-safe HTML only through an explicit `raw()` wrapper.
- M1.4 Each helper shall truncate to the Telegram limit (4096 characters per message, 1024 for a caption) with the existing `trunc()` behaviour.

### M2 Keyboards
- M2.1 Keyboard helpers shall exist for the repeating shapes: `confirmKeyboard` (Yes / No), `choiceKeyboard` (list of options with paging), `backCloseRow`, `singleButton`.
- M2.2 Helpers shall create buttons through the callback registry (`callback-registry.md`) once it exists, and through a plain `Btn` meanwhile.
- M2.3 Button labels shall be limited in length so they do not truncate badly on a phone (default 32 characters, set in one place).

### M3 Language
- M3.1 Helpers that contain fixed words (for example "Error:", "Cancel", "Back") shall take `lang` and return Vietnamese or English through `tr()`. `tr()` itself is unchanged.
- M3.2 Fixed words shall be defined once in the `STRINGS` table in `src/i18n.ts` (the table already exists for a few entries).

### M4 Migration and safety
- M4.1 The output of a migrated call site shall be byte-identical to the old output, unless the task says otherwise and the change is listed in its checkpoint.
- M4.2 Migration shall be per file, one commit each, with the existing tests passing after each.
- M4.3 A unit test shall check each helper for: escaping of `<`, `&`, `>`, length limit, both languages.
- M4.4 A script check (`test:ui-consistency`) shall fail if a new `❌` or `✅` literal is added outside `src/ui/` after migration, to keep the rule from drifting back.

## 3. Design

New folder `src/ui/`:

| File | Content |
|---|---|
| `icons.ts` | Icon constants. |
| `text.ts` | Message helpers (M1.2) and `raw()`. |
| `keyboards.ts` | Keyboard helpers (M2.1). |
| `index.ts` | Re-exports. |

`esc` and `trunc` stay in `src/format.ts`; `src/ui/text.ts` imports them.

Example (illustrative):

```ts
errorLine(lang, "Unknown agent: " + id)   // "❌ Lỗi: Unknown agent: &lt;...&gt;" / "❌ Error: ..."
confirmKeyboard(lang, { yes: cb.encode({...}), no: cb.encode({...}) })
```

### Decisions (change any of them)
- Keep `tr(vi, en)` inline for sentences that appear once. Only fixed, repeated words move to `STRINGS`. A key-based translation system is out of scope.
- Do not change wording during migration. Wording changes are separate commits.
- Start with errors and confirmations (most repeated), not with every message.

### Risks and open questions
- **Accidental output changes** in migrated messages. Mitigation: M4.1 and golden strings in tests for each migrated call site.
- **Over-abstraction.** A helper used in fewer than 3 places is not worth adding. Task 0 counts usage and drops the rest.
- **Order with the other two specs.** This layer is independent, but the smoothest order is: callback registry, then the file split, then this layer applied to each file as it moves.

## 4. Tasks (each ends with a human checkpoint)

1. **T1 Usage count.** Read-only: count each repeated shape (error line, ok line, confirm keyboard, picker) with file and line. Keep only shapes with 3 or more uses. Update this spec. *Checkpoint: approve the helper list.*
2. **T2 Icons and text helpers** (M1, M3, M4.3). `src/ui/icons.ts`, `text.ts`, `scripts/test-ui.ts` added to `test:unit`. No call sites changed. *Checkpoint: review the helper API and wording.*
3. **T3 Keyboard helpers** (M2). `src/ui/keyboards.ts` and tests. *Checkpoint: review.*
4. **T4 Pilot migration:** `src/commands/agents.ts` and `src/commands/meta.ts`, byte-identical output. *Checkpoint: see the messages in Telegram.*
5. **T5 Migrate remaining files**, one commit per file or module (`schedule`, `orchestrator/*`, `bot.ts` sections). *Checkpoint after each group.*
6. **T6 Consistency check** (M4.4). Add `test:ui-consistency`; list allowed exceptions. *Checkpoint: review the exception list.*
7. **T7 End-to-end.** `npm run smoke` once at the end, then restart the service and check the journal.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Changing wording or tone, a key-based i18n system, a new language, theming, rewriting streaming and rich-reply formatting (`src/stream.ts`, `src/rich.ts`), and changing which messages the bot sends.
