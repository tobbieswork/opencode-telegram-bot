# Evaluation: migrating opencode-telegram-bot to Telegram Bot API 10.x Rich Messages

**Date:** 2026-10-23 · **Status:** read-only research + live probe (no code changed)
**Author:** worker `rich-msgs-eval` (driven via Telegram; manager: main chat)

---

## 0. TL;DR

- **Live probe (2026-10-23): `sendRichMessage` and `sendRichMessageDraft` both work for this bot** (exact responses in §2). Server-side GFM parsing handles every construct the bot emits today — including the delimiter-inside-inline-code case that caused our historical `can't parse entities` 400s.
- **But two documented, real-world regressions argue against a full switch now:**
  1. **Quote & Reply is broken for rich messages** — long-press on a rich bot message offers only "Reply", not "Quote & Reply" (openclaw issue #92258, user report 2026-06-17). For a coding assistant, quoting a fragment of a long answer for a follow-up is a real workflow.
  2. **Client rendering is not guaranteed** — openclaw maintainers reported that current Telegram clients "can accept native rich messages but render them as unsupported" (comment 2026-06-16, with Desktop before/after proof). Their shipped default is plain text, rich behind an opt-in flag.
- **Recommendation: phased pilot** — rich markdown for *final model replies only*, behind an env flag (default off), with per-message HTML fallback; keep HTML for all commands/cards/editing; add draft streaming only after the pilot proves out (§7).

---

## 1. Scope & method

- Read-only code review: `src/telegram.ts`, `src/format.ts`, `src/bot.ts`, `src/activity.ts`, `src/orchestrator.ts`, `src/opencode.ts` (all call sites enumerated in §4).
- Web research against the source of truth: `core.telegram.org/bots/api` (method docs, `rich-messages` doc, changelog) + the openclaw open-source issue tracking the same migration.
- **Live probe against the real Bot API** with this bot's token (read from `.env`, same path as `loadConfig()` in `src/config.ts`; the token is never printed anywhere in this report). At most 2 user-visible probe messages were sent to the allowlisted main chat `1470953552`. Probe script kept for re-runs: `/tmp/opencode/rich-probe.mjs` (plain `fetch`, same transport the bot uses).
- No SDK involved anywhere: the bot calls the Bot API over plain HTTP POST JSON (`src/telegram.ts` `api()`); `sendRichMessage` is just one more method name on that transport. **Zero new dependencies.**

### Bot API timeline (official changelog)

| Version | Date | Rich-message relevance |
|---|---|---|
| 9.3 | 2025-12-31 | `sendMessageDraft` added (plain-text streaming, 4096 limit) |
| 9.5 | 2026-03-01 | `sendMessageDraft` allowed for all bots |
| **10.1** | **2026-06-11** | **Rich messages: `sendRichMessage`, `sendRichMessageDraft`, all `RichText*`/`RichBlock*` types, `rich_message` param on `editMessageText`** |
| 10.2 | 2026-07-14 | Explicit `blocks` content mode on `InputRichMessage`, `media` field, ephemeral messages |
| 10.3 | 2026-08-24 | In-message buttons (`RichMessageButton`, `RichBlockButtons`), compact tables, expandable quotations, document blocks, `can_stop`/`keep_on_stop` on both draft methods, `stopped_message_generation` update |

So: rich messages are ~4.5 months old; the stop-button controls on drafts are ~2 months old.

### Rich message facts (from official docs)

- **Limits:** 32768 UTF-8 characters · 500 blocks (incl. nested/list items/table rows) · 16 nesting levels · 50 media attachments · 20 table columns.
- **Content modes — exactly one of** `markdown` (GFM-compatible, parsed **server-side**), `html` (rich HTML tag set), `blocks` (explicit `InputRichBlock[]`). Plus `skip_entity_detection`, `is_rtl`, `media`.
- **Automatic entity detection is ON by default**: plain URLs, e-mails, `@usernames`, `#hashtag`, `$cashtag`, bot commands, phone numbers, bank cards become clickable entities. Disable with `skip_entity_detection: true`. Inline links show an "Open this link?" confirm dialog with the full URL.
- **`sendRichMessage`**: `chat_id` + optional `message_thread_id` + `rich_message` (required) + `reply_markup` (inline keyboards still work) + `reply_parameters`.
- **`sendRichMessageDraft`**: `chat_id` (private chat) + optional `message_thread_id` + `draft_id` (non-zero; same id ⇒ animated update, different id ⇒ replace) + partial `rich_message` + `can_stop` + `keep_on_stop`. Returns `true`. **Ephemeral ~30 s preview; the final message must be sent via `sendRichMessage` to persist.** `<tg-thinking>…</tg-thinking>` block available inside drafts (a "Thinking…" placeholder).
- **`sendMessageDraft`** (pre-existing, plain text): 0–4096 chars after entity parsing, `parse_mode` HTML/Markdown, empty text = "Thinking…" placeholder.
- **`editMessageText`** accepts `text` (1–4096) **or** `rich_message` — rich messages are editable, but type-switching (text ↔ rich) is not documented ⇒ assume a rich message must be edited with rich content (verify if needed).
- **In-message buttons** (10.3): `<tg-button>`/`RichMessageButton` with `callback_data` (1–64 bytes) fires a normal `callback_query` — i.e., the bot's existing callback infrastructure could serve them.
- GFM subset confirmed in docs: `**bold**` `__bold__` `*italic*` `_italic_` `~~strike~~` `` `code` `` `==mark==` `||spoiler||`, links, `#`–`######` headings, fenced ```lang code, `---`, unordered/ordered/task lists, `>` blockquotes, GFM tables (with alignment), footnotes, `$math$`/`$$…$$`/```math, `<details>`, media blocks.

---

## 2. Live API probe (2026-10-23)

Token source: `TELEGRAM_BOT_TOKEN` in `.env` (loaded by `loadDotEnv()`; existing env vars win). Node v24.21.0, direct HTTPS to `api.telegram.org`. The bot's own polling loop was **not** touched (no `getUpdates` calls — that would steal updates from the running service).

### 2.1 `getMe`

```json
{ "ok": true, "result": {
    "id": 8635324226, "is_bot": true,
    "first_name": "Opencode Bot", "username": "opencode_local_fpt_bot",
    "has_topics_enabled": true, "allows_users_to_create_topics": true,
    ... } }
```

→ Bot id `8635324226`, private-chat topic mode **enabled** (worker topics live in this same private chat — see §5.1).

### 2.2 Probe 1 — `sendRichMessage` (markdown mode) — OK

Request (abridged): `POST bot<token>/sendRichMessage` with
`{ chat_id: 1470953552, rich_message: { markdown: "…" } }` where the markdown exercised: bold (`**`/`__`), italic (`*`/`_`), strikethrough, inline code containing a literal `.*`, a fenced ```js block, unordered + ordered lists, a GFM table, and one explicit link.

Response: **HTTP 200**, `ok: true`, `message_id: 695`, `chat.type: "private"`, and an echoed parsed `rich_message.blocks` proving server-side GFM parsing of **every** construct:

- `paragraph` with `bold` / `italic` / `strikethrough` / `code` runs — the inline-code run came back as `{"type":"code","text":"inline code with .* inside"}` → **the `*`/`_`/`~`-inside-code delimiter bug class (§4.2) does not exist server-side**;
- `{"type":"pre","text":"…","language":"js"}` — language tag carried;
- two `list` blocks (unordered `•`, ordered `1.`/`2.` with `value`);
- `{"type":"table","cells":[…is_header…],"is_bordered":true,"is_striped":true}` — native table block;
- `{"type":"url","text":"Telegram Bot API","url":"https://core.telegram.org/bots/api"}`.

(The user saw this message in the main chat at probe time — worth eyeballing: did the client render it natively or fall back? See §6.2.)

### 2.3 Probe 2 — `sendRichMessageDraft` — OK

Request: `{ chat_id: 1470953552, draft_id: 1, can_stop: true, rich_message: { markdown: "[probe] rich *draft* test — ephemeral preview, disappears in ~30s (can_stop button enabled)" } }`

Response: **HTTP 200**, `{ "ok": true, "result": true }`. An ephemeral preview (with the stop button) appeared in the chat and vanished after ~30 s without a final send, exactly as documented.

**Verdict: both methods are available for this token and behave as documented.** The only probe caveat: nothing was sent into a *worker topic* (`message_thread_id`); that case is inferred from the parameter docs + `has_topics_enabled: true` and must be verified during a pilot (§7 Phase 2).

---

## 3. What the bot does today (baseline)

Long-reply pipeline:

1. `runPrompt` → `promptAndWait` (`src/opencode.ts:432`) — sends the prompt, **blocks until the session is idle** (SSE wait), then returns the final assistant text. **No incremental text is consumed anywhere** (no `session.text.delta` handling; the event stream only drives question forms, permissions, tool/shell activity, and execution lifecycle — `onOpenCodeEvent`, `src/bot.ts:1895`).
2. While waiting: `startTyping` re-sends `sendChatAction("typing")` every 4 s; the **live activity line** is a separate message (`sendMessageId` once, then `editMessageText` per tool event, `deleteMessage` when the turn ends — `src/bot.ts:406-432`, labels in `src/activity.ts`).
3. On completion: `sendReply` (`src/bot.ts:367`) = `stripTags` → `mdToHtmlChunks(clean, replyMaxLen=4000)` → one `sendMessage(parse_mode:"HTML")` **per chunk**. Commands/cards use `sendHtml` (same 4000-char chunking).

So today there is **no text streaming at all** — the "long-reply UX" is typing indicator + activity line + one or more final HTML messages.

---

## 4. Current-code mapping

### 4.1 Call-site inventory (`src/telegram.ts` is the only transport; 68 call sites, all in `src/bot.ts`)

**Send paths (all `parse_mode: "HTML"` today):**

| Surface | Call sites | Notes |
|---|---|---|
| Model replies (the big ones) | `sendReply` :367 | `mdToHtmlChunks(text, 4000)` |
| Commands / pickers / status | `sendHtml` :359, plus ~35 direct `sendMessage`s (e.g. :619, :914, :994, :1363, :1588, :1717) | keyboard rides on the final chunk |
| Meta footer / errors | :727, :735 | `<i>…</i>` footer, failure notes |
| Media ack | `noteNonText` :382 | |
| One-shot cards (sent once, edited in place) | activity line :413; question card :1980; permission card :2161 | via `sendMessageId` |

**Edit paths (`editMessageText`, HTML today):**

| Surface | Call sites | Pattern |
|---|---|---|
| Activity line | :411 (label), :423 (done) | rewrite text in place, delete at turn end |
| Folder browser paging | :1279 | rewrite text + `reply_markup` |
| Model / agent / mode / variant pickers | :989, :1450, :1458, :1536, :1633, :1782 | rewrite text + `reply_markup`, or replace-with-confirmation |
| Question form (advance field) | :2005, :2066, :2093 | rewrite text + `reply_markup` |
| Permission result | :2212, :2220 | rewrite text |

**Delete paths:** activity line :431; picker message cleanup :983, :1274, :1435, :1530, :1608, :1776.

**Polling:** `getUpdates` with `allowed_updates: ["message","callback_query"]` (`src/telegram.ts:248`) — note this would need `stopped_message_generation` added if we adopt `can_stop` drafts.

**State:** `data/state.json` stores raw session ids + `lastRelayedTime` cursors; orphaned-reply recovery (`sweepUnrelayedReplies` :244) re-renders **raw model text** through `sendReply` ⇒ format-agnostic, no state migration needed by a rendering change.

### 4.2 What the bot actually emits today → GFM mapping

The manual converter (`blockToHtml`/`mdToHtmlChunks`, `src/format.ts`) emits exactly this subset:

| Bot emits today (HTML) | GFM rich equivalent | 1:1? |
|---|---|---|
| Fenced code ` ```lang … ``` ` → `<pre><code>` (content escaped) | same fence → `pre` block **with `language`** (live-verified §2.2) | ✅ 1:1, and the NUL-placeholder hack (`src/format.ts:125-133`) becomes unnecessary — server parser keeps `` `.*` `` literal (verified) |
| Inline `` `code` `` → `<code>` | `` `code` `` | ✅ |
| `**b**` / `__b__` → `<b>` | same | ✅ |
| `*i*` / `_i_` (with hand-rolled boundary guards, `:140-141`) → `<i>` | same | ✅ server-side is more precise (no `snake_case` heuristics needed) |
| `~~s~~` → `<s>` | same | ✅ |
| `# heading` → degraded to `<b>heading</b>` (`:142`) | `#`…`######` → **native section headings** (better rendering) | ✅ upgrade |
| `[text](url)` → `<a href>` | same (plus client "Open this link?" confirm) | ✅ |
| Bullets: **fake** per-line `• ` prefix (`:144`) | real `- item` lists → native list blocks | ✅ upgrade |
| GFM tables → hand-aligned monospace `<pre>` **or** bullet-list fallback; monospace tables split at row boundaries with repeated header (`tableToUnits`, `:223-279`) | native `table` block (live-verified) | ✅ big upgrade — all alignment/splitting/header-repeat code deleted |
| `<i>` meta footer | `*italic*` | ✅ |
| — (not emitted today) | blockquotes `>`, task lists, footnotes, math, `==mark==`, `||spoiler||`, `<details>` | future wins, no effort |

**Behavior deltas to decide explicitly:**

- **Auto entity detection** (ON by default): bare URLs/e-mails/`@usernames` in model prose become clickable (today they're inert text). For a coding bot this is probably a feature, but it's a look change ⇒ decide: leave on, or send `skip_entity_detection: true` for a closer match to today.
- **Link open confirm dialog**: client shows "Open this link?" for inline links (new friction vs. today's plain preview-suppressed links — today `disable_web_page_preview: true` is set on every send).
- **`disable_web_page_preview`** has no direct rich counterpart; explicit markdown links still render as links, so the old knob maps to "use `skip_entity_detection` for bare URLs + accept confirm dialog for explicit links".

### 4.3 The 4096 → 32768 limit change

- Today: `TELEGRAM_REPLY_MAX_LEN` defaults to **4000** (`src/config.ts:98`), applied in both `chunk()` (commands) and `mdToHtmlChunks()` (replies). A 10 k-char answer ⇒ 3 messages.
- Rich: one message holds **32768 UTF-8 characters** ⇒ virtually all model replies become a single message; multi-message splitting (and with it the entire "tags must stay balanced within each message" machinery — unit packing, `hardSplit`, per-`<pre>` re-wrapping) becomes a rare tail case for >32 k answers.
- Chunking note: the 32768 limit counts **UTF-8 characters (code points)**; JS `String.length` counts UTF-16 code units, so slicing with `.length ≤ 32768` is conservative-safe (astral emoji count 2 in JS, 1 in the limit).
- New constraint to track: **500 blocks** per message. A model answer of ~500+ paragraphs/lists/tables would hit it — unlikely in practice, but the chunker should count blocks, not just chars, when it kicks in.

---

## 5. Streaming assessment (`sendRichMessageDraft`)

### 5.1 What it would look like

- Per conv, pick a non-zero `draft_id` (e.g. derived from the turn) and call `sendRichMessageDraft` with the accumulated partial markdown as the model streams; same `draft_id` ⇒ **animated** in-place update of the ephemeral preview.
- On completion: send the final message via `sendRichMessage` (persists it); the draft preview is discarded automatically ("the draft … disappears … if the bot sends a message").
- `can_stop: true` shows the user a stop button; pressing it delivers a `stopped_message_generation` update ⇒ map it to the existing `/stop` path (`stopCurrent`). `keep_on_stop: true` keeps the partial visible briefly; to preserve a stopped partial fully, send it as a normal message (mirrors today's "interrupted — partial text" behavior, where `promptAndWait` returns whatever partial assistant text exists).
- `<tg-thinking>…</tg-thinking>` block gives a native "Thinking…" surface inside the draft.
- **Worker topics:** the main chat is a private chat with topic mode enabled (probe §2.1); workers are forum topics *inside it* (created via `createForumTopic(chatId, …)` in `src/orchestrator.ts:587`, conv = `chatId:threadId`). `sendRichMessageDraft` accepts `message_thread_id` ⇒ expected to work in topics, **unverified** (needs a live worker-topic pilot).

### 5.2 What's missing today (the real work)

The bot has **no incremental text path** (`promptAndWait` is all-or-nothing; §3). Streaming requires:

1. Consuming `session.text.delta` (and optionally `session.reasoning.delta`) from the client event stream — these events are **verified live** on the running OpenCode service (per-token, start before tool calls, interleave per step; see project memory). The wiring point already exists: `onOpenCodeEvent` (`src/bot.ts:1895`) handles other per-token-ish events the same way `onToolEvent` does.
2. A per-conv buffer (session → accumulated markdown), a **throttled** draft sender (~1 update / 1–2 s; each update is a real API call subject to 429s and the ~1 msg/s same-chat limit), and a final flush on turn end.
3. Adding `stopped_message_generation` to `allowed_updates` + a handler (small polling-surface change).
4. Reconciling drafts with the two existing "work in progress" surfaces:
   - **Typing indicator**: orthogonal (chat-level action) — it *can* coexist, but it's visually redundant while a draft is animating ⇒ suppress `startTyping` for the duration of an active draft.
   - **Activity line**: a separate *real* message, edited via `editMessageText`. It coexists technically, but (a) sending it (or any other message — e.g. a question card) will very likely dismiss the ephemeral draft preview, and (b) two concurrent "in progress" surfaces are UX noise. Design choice: while a draft is active, **fold tool activity into the draft** (append a footer line or use `<tg-thinking>`) instead of the separate message; restore the old behavior as fallback when drafts are off/failing.
5. Failure modes are benign by design: a failed draft update just skips that preview (best-effort); the final `sendRichMessage` is the source of truth; if the final send fails, today's error path still applies.

### 5.3 Draft-specific constraints

- Drafts target **private chats** (`chat_id` Integer). Main chat ✅ (verified). Worker topics: see §5.1.
- Partial-message size: the docs state no smaller cap for rich drafts than the rich limits, but mid-stream updates of a >32 k in-progress answer are an untested edge ⇒ throttle + cap draft updates at the limit until the final send (pilot check).
- `sendMessageDraft` (plain text) would cap at 4096 — irrelevant once rich drafts are the vehicle; noted only because it exists.

---

## 6. Risks

1. **Quote & Reply regression (documented, reproducible).** openclaw#92258, user `r00r1k` 2026-06-17: after switching all bot output to rich messages, "long-press on any bot message no longer shows 'Quote & Reply' option (only plain 'Reply')… Before: users could select a text fragment and quote it. After: not possible on any bot message." For a coding assistant this directly degrades the "quote this function and ask a question" workflow. The bot itself is unaffected (it never reads `reply_to_message` — verified 0 references in `src/`); this is purely a client-side user experience loss. **Mitigation:** pilot scope (rich only for model replies, opt-in), and re-test Quote & Reply after every rollout step; keep the flag if it's unacceptable for this user.
2. **Client compatibility is not guaranteed.** openclaw maintainers (2026-06-16): "Standard text remains the default because current Telegram clients can accept native rich messages but render them as unsupported" (with Desktop before/after proof in their PR #93279). Native rendering requires recent official clients; older/third-party clients' fallback behavior is uncharted. **Mitigation:** this is a single-user power bot on up-to-date clients — the Phase-0 probe (message 695 in the main chat) is the empirical answer for *this* user's clients; require positive visual confirmation before enabling the flag.
3. **API maturity.** 10.1 is ~4.5 months old; launch-era client bugs are documented (custom emoji dropped on `editMessageText`, LaTeX unrendered) and may or may not be fixed in current clients. Monitor `@BotNews`/`@BotTalk` and the changelog before Phase 2/3.
4. **Edit parity.** Rich messages are edited via `rich_message` (type-switching undocumented). The bot's cards and pickers (question form, permission, browse/model/agent/mode/variant, activity line) all live on in-place `editMessageText` + `editMessageReplyMarkup` + `deleteMessage`. Migrating those surfaces to rich is a second, independent project ⇒ keep them HTML (see recommendation). `sendRichMessage` does accept `reply_markup`, so *new* rich messages can still carry today's inline keyboards.
5. **Behavior changes in rendering** (not bugs, but visible): auto entity detection (bare URLs clickable), "Open this link?" confirm on inline links, headings rendered as real headings, tables as real tables. All desirable in aggregate; none individually controllable except via `skip_entity_detection`.
6. **Polling surface change** (`stopped_message_generation` in `allowed_updates`) — low risk but touches the one loop the whole bot depends on; do it in a tested change with `journalctl` verification after restart.
7. **Rate limits**: draft updates are real calls; throttle (§5.3) and rely on the existing 429 backoff in `Telegram.poll`-adjacent code paths (the draft sender must honor 429 itself).
8. **No SDK — actually a plus.** Everything is plain JSON over `fetch` (`src/telegram.ts`); adding two methods is ~40 lines. No dependency risk, and the whole transport stays visible in one file.

---

## 7. Recommendation

**Adopt as a phased pilot — do not flip everything, do not wait indefinitely.**

Rationale: the bot's real pain (multi-message long replies, hand-rolled HTML escaping, the delimiter-in-code bug class, table alignment hacks) is exactly what rich messages eliminate, and the probe proves the server side works for this bot. The documented regressions (Quote & Reply, client "unsupported" rendering) are real but manageable at single-user scale with a flag + fallback, and they'll only get better as clients catch up. A full immediate switch would bet the user's daily driver on ~4-month-old client behavior; doing nothing forfeits the 8× message-size win and the streaming UX.

### Migration plan

**Phase 0 — done (this doc).** Probe results §2. *User action needed:* confirm how probe message **695** rendered on each of your clients (native rich vs. fallback) and whether long-press still offers "Quote & Reply". That answer is the go/no-go for Phase 1.

**Phase 1 — rich final replies behind a flag (the 80% of the win).**
- New env flag `OPENCODE_TG_RICH` (default `0`/off), parsed like the other toggles in `src/config.ts`.
- New `Telegram.sendRich(to, markdown, opts)` (`sendRichMessage` with `message_thread_id` handling via the existing `dest()`).
- `sendReply` (`src/bot.ts:367`): when the flag is on, send the model's **raw markdown** (after `stripTags`) via `sendRich`, chunking at 32 000 chars only for the >32 k tail (counting blocks too, §4.3). No `mdToHtmlChunks` on this path.
- **Per-message graceful fallback:** if `sendRichMessage` errors (400 parse, 404 method, 429), retry that same chunk through the existing HTML path. Degradation is automatic and per-message.
- `formatTurnFailure`, meta footer, commands, cards, pickers, activity line: **unchanged (HTML)**.
- Tests: `npm run typecheck` + `npm run test:unit` (format.ts untouched ⇒ its regression suite stays green), then `npm run smoke` with the flag on; manual: one long reply with code/table/list in the main chat and in a worker topic; verify Quote & Reply on a rich reply.

**Phase 2 — draft streaming (only after Phase 1 is stable ~1–2 weeks).**
- Consume `session.text.delta` in the event path; per-conv buffer; throttled `sendRichMessageDraft` (fixed non-zero `draft_id` per turn; `can_stop: true`).
- Suppress typing while a draft is active; fold the activity line into the draft (footer line or `<tg-thinking>`); final `sendRichMessage` on completion; partial-on-stop handled as today's interrupted path.
- Add `stopped_message_generation` to `allowed_updates` + handler → `stopCurrent`.
- **Must verify live:** draft into a worker topic (`message_thread_id`), draft behavior when a question card interrupts mid-turn (card send dismisses the preview — expected, acceptable), 429 handling.

**Phase 3 — only if client behavior has proven out (re-check the openclaw thread / changelog first).**
- Rich for cards/pickers (requires confirming `editMessageText{rich_message}` + `editMessageReplyMarkup` parity on rich messages), in-message `<tg-button>` rows as an alternative to inline keyboards, and richer formatting (blockquotes for cited errors, tables for `/status`, task lists for plan output).

### Rollback plan

- Everything behind env flags defaulting off (`OPENCODE_TG_RICH`, `OPENCODE_TG_RICH_DRAFT`) ⇒ **rollback = unset flag + `systemctl --user restart opencode-bot`** (per project convention). No state migration: `data/state.json` is format-agnostic (§4.1).
- Phase 1 additionally degrades per-message (rich → HTML on error), so even with the flag on, a server-side rich regression costs only the affected messages, never a lost reply.
- Residual: rich messages already in history stay rich (can't be un-sent). At single-user scale that's a cosmetic worst case; worst-case escalation is deleting the affected chat's tail (last resort).
- Kill criteria to stop the pilot: Quote & Reply still broken *and* the user considers it blocking; or any client the user relies on renders rich as "unsupported"/unusable; or a client regression makes rich edits/quotes inconsistent.

---

## 8. Ten-line summary

1. **Live-verified (2 probes, 2026-10-23):** `sendRichMessage` (msg 695) and `sendRichMessageDraft` both work for this bot's token; server-side GFM parses code fences, inline code (incl. `.*` inside), bold/italic/strike, lists, tables, links — our historical parse-400 bug class is server-side-immune.
2. Rich = one of `markdown` (GFM, server-parsed) / `html` / `blocks`; 32768 chars, 500 blocks; drafts are ephemeral 30 s previews (same `draft_id` animates), final must be a real `sendRichMessage`.
3. Biggest concrete win: `replyMaxLen` 4000 → 32768 kills multi-message replies and the whole tag-balanced chunking machinery; tables/headings/lists render natively (deletes `tableToUnits` alignment hacks).
4. All 68 Telegram call sites are in `src/bot.ts` over one plain-HTTP transport (`src/telegram.ts`) — zero SDK, so adding the two methods is trivial; state file is format-agnostic (no migration).
5. The bot streams **no text today** (`promptAndWait` is all-or-nothing) — draft streaming is a new feature needing `session.text.delta` wiring (events verified live), throttled updates, and reconciling with typing + activity line.
6. Drafts fit the long-reply UX well, but a separate activity-line message would dismiss the ephemeral preview ⇒ fold activity into the draft (or `<tg-thinking>`) when streaming.
7. Documented regressions: **Quote & Reply broken for rich messages** (openclaw#92258) and clients reported to render rich as **unsupported** (openclaw shipped it opt-in) — both client-side, both single-user-manageable, both worth re-testing after each phase.
8. Behavior deltas to accept or configure: auto entity detection (`skip_entity_detection` toggle), "Open this link?" confirm on inline links.
9. Recommendation: **phased pilot** — Phase 1 rich markdown for final model replies only, env-flagged, per-message HTML fallback; Phase 2 draft streaming after a stable week+; Phase 3 cards/buttons only if clients prove out.
10. Rollback is a flag + service restart (no state migration); go/no-go for Phase 1 = user confirms probe msg 695 renders natively and Quote & Reply still works on their clients.

---

### Appendix A — Probe reproducibility

```bash
# re-runs getMe + the same 2 probes (2 visible messages will be sent to chat 1470953552)
node /tmp/opencode/rich-probe.mjs     # needs the project .env at the path inside the script
```

### Appendix B — Sources

- `https://core.telegram.org/bots/api` — main API doc (method list, "Rich messages" section)
- `https://core.telegram.org/bots/api/rich-messages` — rich message limits + Markdown/HTML syntax
- `https://core.telegram.org/bots/api-changelog` — 10.1/10.2/10.3 entries (Jun–Aug 2026), 9.3/9.5 (sendMessageDraft)
- Method/type docs: `sendrichmessage`, `sendrichmessagedraft`, `sendmessagedraft`, `editmessagetext`, `inputrichmessage`, `richmessagebutton`
- `https://github.com/openclaw/openclaw/issues/92258` — independent project's same migration; Quote & Reply regression report (2026-06-17) and "clients render as unsupported" note (2026-06-16); their default-off shipping decision
