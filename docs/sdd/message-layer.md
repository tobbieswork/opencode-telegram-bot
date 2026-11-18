# Spec: Message and keyboard layer

- **Status:** Draft — T1 (usage count) done 2026-11-18, helper list awaiting approval (see §6); no code written
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
- M1.2 Message helpers shall exist for the repeating shapes: `okLine`, `errorLine`, `warnLine`, `statusLine`, `titledList` (T1, §6: `codeBlock` dropped — 1 use).
- M1.3 Each helper shall escape its untrusted arguments itself, so a caller cannot forget it, and shall accept already-safe HTML only through an explicit `raw()` wrapper.
- M1.4 Each helper shall truncate to the Telegram limit (4096 characters per message, 1024 for a caption) with the existing `trunc()` behaviour.

### M2 Keyboards
- M2.1 Keyboard helpers shall exist for the repeating shapes: `confirmKeyboard` (Yes / No), `pickerKeyboard` (list of options with paging; the name `choiceKeyboard` is already taken by `src/choices.ts:223`), `backCloseRow`, `singleButton`.
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
- **Over-abstraction.** A helper used in fewer than 3 places is not worth adding. T1 counted usage (§6) and dropped the rest (`codeBlock`).
- **Order with the other two specs.** This layer is independent, but the smoothest order is: callback registry, then the file split, then this layer applied to each file as it moves.

## 4. Tasks (each ends with a human checkpoint)

1. [x] **T1 Usage count.** (done 2026-11-18, results in §6) Read-only: count each repeated shape (error line, ok line, confirm keyboard, picker) with file and line. Keep only shapes with 3 or more uses. Update this spec. *Checkpoint: approve the helper list.*
2. [x] **T2 Icons and text helpers** (M1, M3, M4.3). (done 2026-11-18 — `src/ui/icons.ts` with `ICON` + `UI_ICON`, `src/ui/text.ts` with `okLine`/`errorLine`/`warnLine`/`statusLine`/`titledList` + `raw()`, `scripts/test-ui.ts` in `test:unit`; `format.ts` re-exports `ICON` per M1.1.) `src/ui/icons.ts`, `text.ts`, `scripts/test-ui.ts` added to `test:unit`. No call sites changed. *Checkpoint: review the helper API and wording.*
3. [x] **T3 Keyboard helpers** (M2). (done 2026-11-18 — `src/ui/keyboards.ts`: `confirmKeyboard`, `singleButton`, `backCloseRow`, `pickerKeyboard` + `BTN_LABEL_MAX=32`; plain `Btn`s, no callback registry yet per M2.2; `scripts/test-keyboards.ts` in `test:unit`.) `src/ui/keyboards.ts` and tests. *Checkpoint: review.*
4. [ ] **T4 Pilot migration:** `src/commands/agents.ts` and `src/commands/meta.ts`, byte-identical output. *Checkpoint: see the messages in Telegram.*
5. [ ] **T5 Migrate remaining files**, one commit per file or module (`schedule`, `orchestrator/*`, `bot.ts` sections). *Checkpoint after each group.*
6. [ ] **T6 Consistency check** (M4.4). Add `test:ui-consistency`; list allowed exceptions. *Checkpoint: review the exception list.*
7. [ ] **T7 End-to-end.** `npm run smoke` once at the end, then restart the service and check the journal.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 5. Out of scope
Changing wording or tone, a key-based i18n system, a new language, theming, rewriting streaming and rich-reply formatting (`src/stream.ts`, `src/rich.ts`), and changing which messages the bot sends.

## 6. T1 Usage count (2026-11-18, read-only)

Method: `grep -rn` per shape marker over `src/` (tests excluded), then manual
classification line by line. Excluded from counts: comments, button labels,
icon-table entries (`ICON` in `format.ts`, `health.ts`) and `STRINGS`
definitions in `i18n.ts` (listed per shape instead). A `tr(lang, vi, en)` call
whose vi/en sit on separate lines counts as **one** use; a conditional icon
branch (e.g. `${ok ? "✅" : "❌"}`) counts once per site.

Rule applied: a helper is kept only if its shape has **3+ uses**.

### 6.1 Error line (❌-prefixed user-facing message) — 77 uses → **keep `errorLine`**

| File | Uses | Lines |
|---|---|---|
| `src/commands/spec.ts` | 34 | 312, 405, 434, 439, 444, 499, 504, 509, 538, 575, 578, 600, 623, 633, 820, 833, 839, 858, 899, 906, 940, 954, 970, 1034, 1043, 1052, 1061, 1070, 1079, 1089, 1098, 1107, 1115, 1124 |
| `src/bot.ts` | 16 | 2826, 3715, 3767, 3769, 3783, 3800, 3817, 4234, 4376, 4403, 4533, 4672, 4677, 4703, 5013, 5208 |
| `src/commands/schedule.ts` | 10 | 131, 135, 146, 151, 155, 159, 189, 195, 245, 297 |
| `src/orchestrator.ts` | 6 | 469, 506, 600, 793, 1700, 1877 |
| `src/btw.ts` | 2 | 66, 87 |
| `src/format.ts` | 2 | 128, 130 |
| `src/spec-checkpoint.ts` | 2 | 204, 218 |
| `src/rotation-health.ts` | 2 | 235, 246 |
| `src/commands/agents.ts` | 1 | 35 |
| `src/activity.ts` | 1 | 79 |
| `src/watch.ts` | 1 | 199 |

`errorText()` already exists (`src/i18n.ts:22`), used at `ask.ts:65` and
`commands/schedule.ts:81` — `errorLine` supersedes it.

### 6.2 Ok line (✅-prefixed) — 35 uses → **keep `okLine`**

| File | Uses | Lines |
|---|---|---|
| `src/bot.ts` | 16 | 1534, 3396, 3522, 3523, 3719, 3775, 3862, 4074, 4236, 4305, 4383, 4681, 4705, 4746, 5071, 5206 |
| `src/commands/spec.ts` | 8 | 187, 449, 513, 606, 671, 681, 772, 917 |
| `src/commands/agents.ts` | 2 | 37, 79 |
| `src/orchestrator.ts` | 2 | 1392, 1710 |
| `src/rotation-health.ts` | 2 | 235, 241 |
| `src/spec-checkpoint.ts` | 2 | 204, 242 |
| `src/activity.ts` | 1 | 79 |
| `src/pr-watch.ts` | 1 | 225 |
| `src/watch.ts` | 1 | 197 |

Plus 7 ✅-prefixed `STRINGS` entries in `i18n.ts` (81, 85, 130, 134, 138, 142, 146).

### 6.3 Warn line (⚠️-prefixed) — 46 uses → **keep `warnLine`**

| File | Uses | Lines |
|---|---|---|
| `src/bot.ts` | 22 | 728, 805, 852, 872, 1500, 1531, 1577, 1609, 2825, 3226, 3414, 3517, 3708, 3809, 3833, 4108, 4230, 4319, 4411, 4748, 5037, 5237 |
| `src/commands/meta.ts` | 4 | 169, 321, 341, 402 |
| `src/commands/spec.ts` | 4 | 110, 195, 699, 711 |
| `src/orchestrator.ts` | 4 | 1473, 1717, 1828, 1848 |
| `src/spec-checkpoint.ts` | 2 | 223, 252 |
| `src/format.ts` | 2 | 105, 114 |
| `src/rotation-health.ts` | 2 | 244, 245 |
| `src/advisor/advisor.ts` | 1 | 214 |
| `src/recovery.ts` | 1 | 75 |
| `src/scheduler.ts` | 1 | 251 |
| `src/busy.ts` | 1 | 97 |
| `src/commands/schedule.ts` | 1 | 314 |
| `src/commands/agents.ts` | 1 | 81 |

### 6.4 Status line (⏳-prefixed) — 12 uses → **keep `statusLine`**

| File | Uses | Lines |
|---|---|---|
| `src/bot.ts` | 4 | 273 (+699, same const), 786, 1521, 1527 |
| `src/commands/meta.ts` | 1 | 146 |
| `src/commands/spec.ts` | 1 | 568 |
| `src/advisor/advisor.ts` | 1 | 185 |
| `src/btw.ts` | 1 | 43 |
| `src/format.ts` | 1 | 99 |
| `src/notes.ts` | 1 | 106 |
| `src/watch.ts` | 1 | 159 |

Plus the `working_indicator` string (`i18n.ts:162`) behind the
"⏳ Đang xử lý…" machinery in `bot.ts:1670-1700`.

### 6.5 Titled list (bold title + line list) — 6 uses → **keep `titledList`**

`bot.ts:3691` (`<b>Sessions (n)</b>`), `commands/schedule.ts:53` (`<b>⏰ Lịch (n)</b>`),
`ask.ts:54` (`🧠 <b>Advisor threads</b>`), `commands/agents.ts:17` (`<b>Agents</b>`),
`commands/meta.ts:304` (`<b>Recent messages</b>`), `orchestrator.ts:491` (workers list).
(Non-bold title variants, not counted: `bot.ts:4776`, `orchestrator.ts:1907`.)

### 6.6 Confirm keyboard (action + cancel row) — 7 uses → **keep `confirmKeyboard`**

`bot.ts:778` (reboot now / remind later), `bot.ts:796` (confirm / cancel),
`bot.ts:3476` (rotate / keep), `bot.ts:5127` (allow once / always / deny),
`orchestrator.ts:1617` (assign / cancel / auto), `orchestrator.ts:1849`
(delete for real / no), `commands/schedule.ts:306` (delete #id / back).

### 6.7 Picker (option rows + close) — 7 uses → **keep `pickerKeyboard`**

`commands/agents.ts:54` (agent), `bot.ts:3734` (use/session), `bot.ts:4247`
(model, paged ◀️/▶️), `bot.ts:4338` (mode), `bot.ts:4720` (variant),
`bot.ts:3841` (file browser, grid + paging), `orchestrator.ts:511` (kill).

Recurring sub-shapes inside pickers:
- **Close row** `❌ Đóng` / `❌ Close` — 11 sites → **keep `backCloseRow`**:
  `commands/agents.ts:60`, `bot.ts:3741`, `bot.ts:3850`, `bot.ts:3861`,
  `bot.ts:3894`, `bot.ts:4267`, `bot.ts:4351`, `bot.ts:4727`,
  `orchestrator.ts:518`, `watch.ts:433`.
- **Prompt line** `❓ <b>/cmd</b> …` — 5 sites (picker helper's title input):
  `commands/agents.ts:63`, `bot.ts:3745`, `bot.ts:4269`, `bot.ts:4730`,
  `orchestrator.ts:521`.

### 6.8 Single button (one button, or one button per row) — 12 uses → **keep `singleButton`**

Exactly-one-button keyboards: `bot.ts:1691` (👁 watch on the working line),
`bot.ts:2888` (🔨 plan→build), `bot.ts:3136` (⏯ continue), `bot.ts:4541`
(✓ inert after choice), `orchestrator.ts:843` (🔎 open topic),
`orchestrator/purge.ts:107` (🗑 delete), `commands/spec.ts:470` (▶️ run anyway).
One-button-per-row (`buttons.map((b) => [b])`): `spec-checkpoint.ts:268`,
`commands/spec.ts:235`, `commands/spec.ts:716`, `commands/spec.ts:872`,
`commands/spec.ts:1171`, `choices.ts:227`, `busy.ts:153`.

### 6.9 Code block (`<pre>`) — 1 use → **drop `codeBlock`**

Only one user-facing `<pre>`: `orchestrator.ts:1841` (worktree diff summary).
The `<pre><code>` in `format.ts:215,262` is inside `mdToHtmlChunks` itself
(streaming/rich-reply formatting — out of scope). 1 < 3 → dropped.

### 6.10 Resulting helper list

| Helper | Shape | Uses | Decision |
|---|---|---|---|
| `errorLine` | ❌-prefixed message | 77 | keep |
| `warnLine` | ⚠️-prefixed message | 46 | keep |
| `okLine` | ✅-prefixed message | 35 | keep |
| `statusLine` | ⏳-prefixed message | 12 | keep |
| `titledList` | bold title + lines | 6 | keep |
| `confirmKeyboard` | action + cancel | 7 | keep |
| `pickerKeyboard` | options + paging + close | 7 | keep (renamed from `choiceKeyboard` — name clash with `src/choices.ts:223`) |
| `backCloseRow` | `❌ Đóng` / `❌ Close` row | 11 | keep |
| `singleButton` | one button / one per row | 12 | keep |
| `codeBlock` | `<pre>` block | 1 | **drop** |
