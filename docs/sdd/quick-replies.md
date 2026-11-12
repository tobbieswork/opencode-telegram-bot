# Spec: Quick replies (model-written next-step buttons)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-12
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Builds on:** `src/choices.ts` (choice buttons), `docs/sdd/next-step-buttons.md` (rule-based buttons), `src/language.ts` (session instructions), `src/audit.ts`

## 1. Problem

The rule-based next-step buttons are fixed: Review, Board, New session. They
cannot know that, after a design discussion, the useful next move is "Draft the
spec" or "Compare the two options". The agent knows. On a phone a tap is much
cheaper than typing, so we want the agent to offer a few short replies that the
user can send with one tap.

The bot already has half of this. `src/choices.ts` turns a lettered or numbered
list at the end of a reply into buttons, and a tap sends the text back. Three
gaps:

1. **Nobody asks the model to offer replies.** Buttons appear only if the model happens to end with a list.
2. **A one-line marker is not recognised.** `[OPTIONS: a | b | c]` is a compact, unambiguous format that is easy to strip from the visible text; the lettered-list parser cannot read it.
3. **A tap is not the same as typing.** `handleChoiceCallback` calls `oc.prompt` directly. It therefore skips `runPrompt`: the prompt is not in the audit log, there is no typing indicator, no footer and no next-step buttons for the answer. For the Manager it skips `promptManager`, so the 12-dispatch budget is not refilled. It also does not check whether a turn is running: a tap while the agent works silently steers the old choice into the new turn (OpenCode's default delivery is "steer").

## 2. Goals and non-goals

**Goals**
- The agent can end a reply with up to 3 short replies; the bot shows them as buttons and removes the marker from the visible text.
- Tapping a button is exactly like the user typing that text: same entry point, same audit, same safeguards.
- What the button says is exactly what is sent.
- Off by default until we have seen how well models follow the instruction.

**Non-goals (v1)**
- A second model call that invents suggestions. It costs tokens and seconds on every turn; revisit only if the in-reply approach fails.
- Quick replies in worker topics, `/ask` threads and scheduled runs.
- Learning from taps, per-user settings, or replacing the rule-based buttons.

## 3. Requirements (EARS)

### R1 Reading the marker
- R1.1 When a reply's last non-blank line (outside any code fence) has the form `[OPTIONS: first | second | third]`, the system shall remove that line from the visible text and show its options as buttons.
- R1.2 The system shall accept 2 to 4 options and shall show at most 3. Options shall be trimmed, de-duplicated and non-empty.
- R1.3 An option longer than 56 characters shall make the whole marker invalid: the reply is then sent unchanged-except-for-the-marker-line and no buttons are shown. Nothing shall be truncated, so a button always shows the full text it will send.
- R1.4 A malformed marker, or a marker that is not the last line, shall be left alone: the reply is sent exactly as received.
- R1.5 If the reply also ends with a lettered or numbered list that the existing parser reads, the marker shall take precedence and the list shall stay as text.

### R2 Asking the model
- R2.1 Where `OPENCODE_TG_SUGGEST` is on, the system shall attach a short instruction to the session (as a session instruction, like the language setting), once per session, and re-attach it after the session changes (`/new`, `/use`, Manager rotation).
- R2.2 Where the setting is off, the system shall remove a previously attached instruction.
- R2.3 The instruction shall apply to plain sessions and the Manager only.
- R2.4 The instruction text is in section 4 and shall be reviewed as part of this spec.

### R3 Tapping
- R3.1 A tap shall go through the same entry point as a typed message (`runPrompt` for plain sessions, `promptManager` for the Manager), so it is audited, shows the typing indicator, gets the turn footer and next-step buttons, and refills the Manager's dispatch budget.
- R3.2 If a turn is running when the button is tapped, the system shall refuse with "A task is running", keep the buttons, and send nothing.
- R3.3 After an accepted tap, the keyboard shall be replaced by a single inert button showing the chosen text with a check mark, so the chat shows what was sent.
- R3.4 A button shall work once, shall be bound to the session it was created for, and shall answer "expired" after a restart or "no longer applies" after the session changed.
- R3.5 Taps shall pass the same allow-list check as any callback.

### R4 Coexistence
- R4.1 When a reply carries quick replies, the rule-based next-step buttons shall stay quiet for that turn (the existing rule that a reply with model buttons gets no second set). When the model offers none, the rules apply as today.

### R5 Control and visibility
- R5.1 `OPENCODE_TG_SUGGEST` shall default to off. When off, behaviour shall be identical to today, except R3, which also applies to the existing lettered-list buttons.
- R5.2 The system shall write `suggest_shown` (with the option count), `suggest_tap` (with the option index) and `suggest_none` (an eligible reply that carried no marker) to the audit log, so tap rate and model compliance can be measured.
- R5.3 Button labels and system messages shall be available in Vietnamese and English via `tr()`. The options themselves are written by the model in the user's language.

## 4. Design

| Item | Approach |
|---|---|
| Parser | New pure function `extractOptionsMarker(markdown)` in `src/choices.ts`, next to `extractTrailingChoices`, with the same fence handling. Returns `{ body, options }` or null. |
| Rendering | Reuse `choiceKeyboard` and `choices.registry` (callback `ch:<id>:<i>`, 4-character id, 24 h TTL). One button per row. `choiceKeyboard` currently cuts labels at 40 characters; for markers it shall not cut (limit is enforced by R1.3), because the label must equal the sent text. |
| Instruction | New `src/suggest.ts` with the instruction text and `applySuggestPin(oc, st, conv, sessionID, enabled)`, modelled on `applyLanguagePin` (self-tracked per session id, success-only marker, best-effort). |
| Tap routing | `handleChoiceCallback` calls `runPrompt` / `promptManager` instead of `oc.prompt`. It checks `inflight` / Manager busy first and only then consumes the record and edits the keyboard (today it removes the keyboard first). |
| Chosen state | After an accepted tap: `editMessageReplyMarkup` to one button `✅ <text>` with callback `ch:done`, answered silently. |
| Eligibility for `suggest_none` | Counted for replies in plain sessions and the Manager when the feature is on and the reply is longer than 200 characters. Short answers are not expected to carry options. |
| Config | One variable in `src/config.ts`, documented in the README config table (the doc-sync test enforces this) and `.env.example`. |

### The instruction (model-facing, for review)

> When it helps the user continue, end your reply with ONE final line: `[OPTIONS: first | second | third]`. Give 2 or 3 options. Each option is something the USER would say next: first person, in the user's language, at most 8 words, specific and complete on its own, because it is sent as their next message exactly as written. Only offer options when there is a clear next step or a real decision. Never for greetings, short answers, error messages, or when you need free-text input from the user. Do not repeat the same options twice in a row, do not number them, do not mention this line, and write nothing after it.

Cost: about 130 tokens in the session's system context.

### Decisions I made (change any of them)
- **Off by default.** Turn it on after task R0 shows how well models follow the instruction. Suggested bar to switch the default: valid, relevant options on at least 80% of the substantive replies in the spike, and none on the trivial ones.
- **Marker, not another call.** No extra tokens per turn beyond the instruction.
- **Up to 3 shown, 56 characters each, never truncated.** Telegram buttons hold 64 characters; the full text is visible before the tap.
- **Quick replies win over rule buttons** on the same turn (R4.1). The model can itself offer "Review the changes".
- **A tap is a typed message** (R3.1). This also fixes the audit gap and the Manager budget for the existing lettered-list buttons.
- **A tap during a running turn is refused** (R3.2). This changes today's behaviour for the existing buttons, where it silently steers into the running turn.
- **Plain sessions and Manager only.**

### Risks and open questions
- **Compliance varies by model.** Some will ignore the instruction, add options to every reply, or format them badly. The parser is strict, so the failure mode is "no buttons" or "raw marker line left visible" (R1.4), never a broken reply. R0 measures this before any default changes.
- **Noise.** Options on every reply train people to ignore them. The instruction says when to stay silent and `suggest_none` shows how often the model does.
- **Prompt injection.** Content the agent reads could push it to offer a harmful option. The user sees the full text before tapping, a tap is no more powerful than typing it, and OpenCode's permission prompts still apply.
- **Behaviour change to existing buttons** (R3.2): tapping during a running turn no longer steers silently.
- **Manager rotation** starts a fresh session: the instruction is re-attached by R2.1, like the language setting.

## 5. Tasks (each ends with a human checkpoint)

0. **R0 Spike.** `scripts/spike-suggest.ts` (manual, not in `test:unit`): run about six representative prompts (a design question, a code change, a trivial question, a greeting, an error, a Manager-style request) against the live OpenCode service with the instruction attached, and record for each: marker present, valid, option lengths, relevance noted by hand. Costs a handful of real model prompts. Write the result into "Findings" here. Also confirm that a session instruction applies to Manager sessions. *Checkpoint: decide the default and tune the instruction text.*
1. **R1 Parser** (R1). `extractOptionsMarker` with tests: valid forms, 2 and 4 options, limits, fences, marker not last, malformed, over-long option, precedence over lettered lists. *Checkpoint: review the cases.*
2. **R2 Config and instruction** (R2, R5.1, R5.3). `src/suggest.ts`, config, README, `.env.example`, tests for apply, re-apply, remove and idempotence. *Checkpoint: review the final instruction text.*
3. **R3 Tap routing** (R3, R4). Rewire `handleChoiceCallback`; busy refusal; chosen-button state; precedence over rule buttons; extend `test-multi` and `test-choices`. *Checkpoint: tap each kind of button from the phone, including while a turn runs.*
4. **R4 Audit** (R5.2). The three events and an extension of `scripts/nextstep-tap-rate.ts` to report tap rate and compliance. *Checkpoint: read a sample report.*
5. **R5 End-to-end.** A soft check in `npm run smoke` with the setting on: it cannot force the model to comply, so it reports compliance and fails only if a valid marker was received but not rendered. Smoke runs last, as in `AGENTS.md`.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 6. Out of scope
A separate model call for suggestions, worker topics and `/ask` threads, per-user settings, learning from taps, and changing the rule table.

## 7. Findings (filled in by task R0)

Spike: `scripts/spike-suggest.ts`, run 2026-11-12 against the live service
(OpenCode 2.2.6, model `qwen/qwen3.8-27b`), exact production instruction
(`SUGGEST_INSTRUCTION`), one fresh session, 6 representative prompts.

| # | prompt | kind | marker | valid | note |
|---|--------|------|--------|-------|------|
| 1 | storage direction for a todo API | substantive | absent | – | answered 3 options as a numbered list, ended "Which one are you going with?" |
| 2 | create a file | substantive | absent | – | one-line confirmation |
| 3 | capital of France | trivial | absent | – | one sentence (correct) |
| 4 | greeting | trivial | absent | – | short reply (correct) |
| 5 | explain a TypeError | trivial | absent | – | explanation only (correct) |
| 6 | split/sequence two small jobs | substantive | absent | – | 3-line plan |

**Result: 0/6 markers. Substantive 0/3 (bar: ≥80%), trivial 0/3 (bar: ~0).**

- The model answered every prompt naturally and never emitted the
  `[OPTIONS: …]` line, even when the prompt was a pure decision
  ("I will pick"). Prompt 1 shows the model *does* offer options — as a
  numbered in-body list, which the existing lettered-list detector
  (Pattern B) already turns into buttons.
- Session instructions apply to Manager sessions too: the spike uses the
  same `setInstruction` mechanism as the language pin (proven in production
  on Manager sessions), applied via the identical `applySuggestPin` call
  site in `promptManager`.

**Decision: default stays OFF.** The feature is dormant on the current
model. The infrastructure (parser, rendering, tap routing, audit, report,
smoke) is complete and tested; flip `OPENCODE_TG_SUGGEST=1` to measure a
future model with `scripts/suggest-tap-rate.ts`. Tuning the instruction
text (a spec change) is only worth revisiting if a model shows partial
compliance.
