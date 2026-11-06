# Design Doc: User-Selectable Language

- **Status:** Draft
- **Date:** 2026-11-05
- **Scope:** Telegram bot (`opencode-telegram-bot`)

## 1. Background

### Current state

The bot has language mismatches across components:

| Component | Current language | How it's decided |
|---|---|---|
| Bot UI (commands, `/help`) | Vietnamese | Hardcoded |
| Worker templates (spawn confirmation, task header) | English | Hardcoded (just changed from Vietnamese) |
| LLM (Manager) | Mirrors input language | Behavioral, not deterministic |
| Worker responses | Mixed | Depends on task language |

### Problem

No single source of truth for language. Each component decides independently → mismatch.

**Example of the mismatch:** User writes in Vietnamese → Manager responds in Vietnamese → but the worker spawn template says "Assigned by Manager" / "Task" (English) → the user sees mixed languages in the same flow.

> Prior art: an earlier per-session mechanism (`guidedLanguageSession` field in `ChatState`,
> the `OPENCODE_TG_LANGUAGE` instruction) applied a "stay in the user's language" prompt to the
> manager session. It was behavioral (prompt-based) and is currently disabled — it did not cover
> the bot UI or worker templates, which is why this design introduces an explicit, deterministic
> preference that all components read from one place.

## 2. Goals

- **G1:** User can select their preferred language via a command (`/lang vi` or `/lang en`).
- **G2:** All bot components sync to the selected language (deterministic, not behavioral):
  - Bot UI strings (commands, `/help`, error messages).
  - Worker templates (spawn confirmation, task header).
  - LLM (Manager) responses.
  - Worker task instructions.
- **G3:** Default language = Vietnamese (current behavior, backward compatible).
- **G4:** Language preference is stored **per-user** (not per-chat, not global).

## 3. Non-Goals

- **NG1:** Auto-detect input language (keep behavioral mirror as a fallback, but the primary mechanism is the explicit preference).
- **NG2:** Multi-language per message (1 chat = 1 language).
- **NG3:** LLM translation (the LLM responds in the preferred language, but does NOT translate content — e.g. if the user sends English content, the LLM does NOT translate it to Vietnamese).
- **NG4:** Support for languages other than Vietnamese + English (initial scope: vi + en only).

## 4. Design

### 4.1 Data Model

- **Where:** `state.json` (the bot's persistent state).
- **Shape:** Add a per-user `language` preference (keyed by user ID, not chat ID):

```typescript
interface UserPrefs {
  language?: "vi" | "en";  // default: "vi" (backward compatible)
}
// Stored in the bot's state: users: Record<userId, UserPrefs>
```

- **Why per-user:** The same user should get the same language across all their chats (e.g. a user who prefers English gets English in all their chats, not just one).

### 4.2 Propagation

- **To LLM (Manager):** Inject the language preference into the system prompt:
  - When the language is `"en"`: inject "Respond in English to all user messages." (explicit pin).
  - When the language is `"vi"` or unset (default): **no injection** — the LLM behaviorally mirrors the input (current behavior). Vietnamese is the native language of the box, so an explicit pin is unnecessary; the behavioral mirror is sufficient.
  - Switching from `"en"` to `"vi"`/unset **clears** the English pin (idempotent, per-session).
- **To bot UI:** Use an i18n table (vi/en strings) for all bot UI strings:
  - Commands (`/help`, `/usage`, `/schedule`, etc.).
  - Error messages.
  - Status messages.
  - The i18n table is a simple `{ vi: {...}, en: {...} }` object.
- **To worker templates:** Use the language preference when rendering the worker spawn confirmation + task header:
  - If `"vi"`: "giao bởi Manager" / "Nhiệm vụ" (original Vietnamese).
  - If `"en"`: "Assigned by Manager" / "Task" (new English).
  - If unset: default to `"vi"` (current behavior).
- **To worker task instructions:** The task instruction is sent in the preferred language (the Manager writes the task in the preferred language).

### 4.3 Component Matrix

| Component | Change | Effort | Risk |
|---|---|---|---|
| `state.ts` | Add `language?: "vi" \| "en"` to `ChatState` | S | Low |
| `commands.ts` | New `/lang` command (vi/en) | S | Low |
| `bot.ts` | System prompt injection (language → LLM instruction) | S | Medium (LLM compliance) |
| `orchestrator.ts` | Worker templates use language preference | S | Low |
| `format.ts` (or new `i18n.ts`) | i18n table + `tr(lang, vi, en)` helper | M | Low |
| All UI strings | Replace hardcoded VN strings with `tr(lang, vi, en)` | M | Medium (many strings) |

### 4.4 C4 Diagram (textual)

```
[Context Level]
User → /lang vi → Bot stores preference in state.json

[Container Level]
Bot → { LLM (Manager), Bot UI, Worker Templates }
  - LLM: receives system prompt with language instruction
  - Bot UI: renders strings from i18n table
  - Worker Templates: renders strings from i18n table

[Component Level]
state.json → { SystemPrompt, i18n, Template }
  - SystemPrompt: injects language instruction
  - i18n: provides vi/en strings
  - Template: uses language preference for VN/EN strings
```

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| LLM ignores the language instruction | Medium (responses in wrong language) | Keep behavioral mirror as fallback; test with multiple prompts |
| i18n table grows (many strings to translate) | Medium (maintenance burden) | Start with vi + en only; add more languages later if needed |
| Breaking change (default language change) | Low (default = "vi", current behavior) | Default is `"vi"` (no change for existing users) |
| Scope creep (more languages, auto-detect) | Low (Non-Goals prevent it) | Non-Goals explicitly exclude auto-detect + multi-language |
| Incomplete i18n (some strings missed) | Medium (mixed languages) | Audit all UI strings; add a test that checks for hardcoded VN/EN strings |

## 6. Alternatives Considered

| Alternative | Why not |
|---|---|
| **ADR only** | Too lightweight — no holistic design, no propagation mechanism |
| **RFC** | Too heavy — requires discussion + approval process, overkill for 1 feature |
| **OpenSpec** | Designed for spec changes, not feature design; the project has it but it's not the right tool for a holistic design doc |
| **4+1 View Model** | Too heavy — requires 4 views + 1 scenario, overkill for 1 feature |
| **C4 Model only** | Good for visualizing propagation, but it's a diagramming framework, not a design process; use as a complement (included in §4.4) |
| **No design doc (just implement)** | Risky — without a design, scope creep is likely; the feature touches many components |
