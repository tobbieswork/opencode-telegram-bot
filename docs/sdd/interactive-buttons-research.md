# Interactive buttons in LLM chat — research & recommendation

**Status:** research / design input (read-only). No code changed by this doc.
**Goal:** turn the free-form text choices the LLM already writes at the end of a
message (e.g. `A — option 1`, `B — option 2`, `C — option 3`) into real Telegram
inline-keyboard buttons — **deterministically and model-agnostically**: if someone
clones the bot and swaps in a different model, the buttons must still appear
without telling that model anything about the button mechanism.

---

## TL;DR — recommendation

**Use Pattern B (deterministic post-processing of the model's free-form text),
as a layered complement to the existing `question` tool (Pattern A/C).**

The model keeps doing what it already does — end its reply with a short
lettered/numbered list of options. The **client** (the bot) detects that trailing
list, renders it as an inline keyboard, and relays the clicked choice back to the
session as a new user message. The model is never told about buttons, never calls
a tool for them, and never formats anything special. Swapping the model changes
nothing about button rendering.

Why this beats the alternatives for our constraint:

- **Not Pattern A (tool call):** a tool call is exactly "the LLM remembering to
  call a tool" — the thing we must not depend on. Weak/local models are
  unreliable at tool calling (see Cline §below).
- **Not Pattern C (model emits a JSON/XML marker):** that *is* "telling the model
  about the button mechanism" (the marker format), which the constraint forbids.
- **Pattern B is the only fully model-agnostic mechanism.** The "marker" is a
  lettered list — a natural *content* format any model produces when asked for
  options — not a UI mechanism.

It also matches what the big players actually ship: the buttons are **never
emitted by the model**. The model produces content (text / code / a typed
intent); a deterministic client layer maps content → buttons (Cursor, Copilot),
or a *separate* cheap call generates the buttons (ChatGPT follow-ups). Our
Pattern B is the zero-extra-call version of that same "client renders, model is
unaware" architecture.

---

## 1. The four (actually five) architectural patterns

| ID | Name | Who decides the buttons | Model-agnostic? | Deterministic? |
|----|------|------------------------|:---------------:|:--------------:|
| **A** | **Tool call** — model calls `show_choices([...])` / emits `tool_use` | Model | ❌ (must remember to call) | ⚠️ (depends on model tool reliability) |
| **B** | **Post-processing / pattern detection** — client regexes the free-form text | Client | ✅ | ✅ (if detection is normalized) |
| **C** | **Structured marker in output** — prompt defines a syntax (XML/JSON); client parses it | Model (format) + client (parse) | ⚠️ (model must follow the format) | ✅ (parsing is deterministic) |
| **D1** | **Separate generation** — a 2nd (cheap) model call, fixed prompt, emits the UI | A second call, not the main model | ✅ (w.r.t. the main model) | ⚠️ (2nd model is still an LLM) |
| **D2** | **UI-state / content-driven** — buttons are a function of detected content / app state | Client | ✅ | ✅ |

The big players use **A, C, D1 and D2** a lot. **B is the under-used one** —
Anthropic even explicitly discourages it for *decisions* ("if you're writing a
regex to extract a decision from model output, that decision should have been a
tool call"). But **B is precisely the pattern our constraint demands**, and it is
the zero-cost, zero-latency, zero-extra-model way to be model-agnostic.

---

## 2. Systems × approach (evidence)

| System | Interactive element | Mechanism | Pattern | Evidence |
|--------|--------------------|-----------|:-------:|----------|
| **ChatGPT (consumer)** | Follow-up suggestion chips under a reply | A *separate* generation, injected by the web client **after** the main response stream closes; clicking sends the text as if typed | **D1** | [OpenAI community — "automated UI widget injected natively by OpenAI's web interface after the response generation stream closes"](https://community.openai.com/t/feature-request-setting-to-disable-follow-up-suggestions/1396688); [OpenAI community — "use another AI API call … cheapest model … output only valid JSON `{q1,q2,q3}`"](https://community.openai.com/t/how-to-create-follow-up-question-in-chat/645463) |
| **OpenAI (developer API)** | Generative UI (buttons/forms rendered from model output) | **Structured Outputs**: model emits a UI JSON tree (`div/button/header/section/field/form`) via `response_format` or a `generate_ui` tool; app renders recursively | **A / C** | [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs); [conversational-assistant demo (`generate_ui` + "Select order" carousel)](https://github.com/openai/openai-structured-outputs-samples/blob/main/conversational-assistant/README.md) |
| **Claude (consumer)** | In-chat multiple-choice / form widgets | A **pre-designed module** (`AskUserQuestion`) the model decides to *load and populate*; rendering is a fixed UI, model only supplies data | **D2** (+A to trigger) | [NN/g — "a predesigned module called AskUserQuestion that Claude can decide to load and populate"](https://www.nngroup.com/articles/genui-buttons-and-checkboxes/) |
| **Claude (API / agent)** | Any tool action, computer use | **Tool use** (`tool_use` blocks); Anthropic's own docs push decisions into tools, not text-parsing | **A** | [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works); [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| **Claude (consumer)** | Rich interactive side-panel (not in-chat buttons) | **Artifacts** — separate rendered panel | n/a | [What are artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) |
| **Gemini (consumer, AI Mode)** | Checkboxes on hotel results; on-the-fly interactive tools | **Generative UI** — Gemini 3 generates the whole interactive interface for a prompt | **C** (model emits UI) | [Google research — Generative UI](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt); [NN/g — AI Mode checkboxes](https://www.nngroup.com/articles/genui-buttons-and-checkboxes/) |
| **Gemini (API)** | UI automation | **Gemini Computer Use** model — function calls *are* the UI actions | **A** | [Gemini 2.5 Computer Use](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-computer-use-model) |
| **Cursor** | Apply / Accept / Reject / Keep / Undo on code & diffs | Buttons **rendered by the client** on detected code blocks / diffs. "Apply is a specialized Cursor model … the chat model generates the code, and Apply handles the integration." Model never emits buttons. | **D2** | [Cursor — Apply](https://docs.cursor.com/agent/apply); accept/reject UX [forum](https://forum.cursor.com/t/accept-btn-not-showing/156585) |
| **Cline** | Approve / Reject card on a tool action | Model emits **XML tags** (`<write_to_file>…</write_to_file>`) per the system prompt; the extension's **streaming parser** deterministically extracts them and renders the Approve/Reject card. Buttons are client-rendered, not model-emitted. | **C** (deterministic parse) | [write_to_file spec](https://github.com/cline/cline/blob/main/src/core/prompts/system-prompt/tools/write_to_file.ts); [modelmeld — "no tools field — prompt-based XML tool calls; iterates the chunk stream and parses XML"](https://github.com/modelmeld/modelmeld/blob/main/docs/integrations/cline.md); [JSON-vs-XML parser breakage on local models](https://github.com/cline/cline/issues/10843) |
| **Devin (Cognition)** | Allow/Deny on tool calls; plan approval; confidence gating | Model emits **typed events** (`tool_call`, `permission_request`, `plan`); the SDK/UI maps each event type → a UI part with Allow/Deny buttons. Buttons are client-rendered from event type. Devin waits for approval when confidence < 🟢. | **D2** (+A for the event) | [Devin AI SDK — "tool calls become dynamic-tool parts … permission request → tool-approval-request"](https://docs.devin.ai/sdk/ai-sdk/overview); [Interactive Planning / approval](https://docs.devin.ai/work-with-devin/interactive-planning); [Devin 2.1 confidence ratings](https://cognition.com/blog/devin-2-1) |
| **GitHub Copilot** | Insert / Run / Preview on code & shell blocks; Allow/Deny permission prompts | Buttons **rendered by the client** on *detected content* (code blocks, shell commands). "The response often includes interactive elements … a menu to insert a code block, or a button to invoke a VS Code command." Custom model-requested buttons are **not** supported (feature request closed not-planned). | **D2** | [Copilot in your IDE — interactive elements](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/chat-with-copilot/chat-in-ide); [feature request for custom action buttons (not planned)](https://github.com/microsoft/vscode/issues/275025); [permission prompts](https://docs.github.com/en/copilot/responsible-use/agents) |

### Reading the table

Two recurring facts matter more than any single system:

1. **Nobody makes the model *draw* the buttons.** In every system the buttons are
   produced by a **client-side layer** — either from a typed intent (A/C) or from
   detected content/state (D2) or from a separate call (D1). The model's job stops
   at content.
2. **When a vendor wants to be model-agnostic, it does NOT add a mechanism the
   main model must learn.** ChatGPT's follow-ups are a **second, separate** call
   (D1) — the main model just writes prose. Cursor/Copilot/Devin render buttons
   off **content they already detect** (D2). Our constraint ("no telling the model
   about the mechanism") points directly at **B / D1 / D2**, away from **A / C**.

---

## 3. Where we are today (the bot already has Pattern A/C)

The bot **already** has a tool-based question path:

- `src/shared.ts` → `QUESTIONS_PREAMBLE` tells the agent to "ask with the
  `question` tool … the user answers via Telegram buttons."
- `src/bot.ts` → `onFormCreated` (≈L3317) maps OpenCode's `form.created` event to a
  conv and `buildFormKeyboard` (≈L3383) renders each field's `options` as
  `fq:<field>:o<i>` inline buttons; a click calls `session.form.reply`
  (`src/opencode.ts` ≈L636) to relay the answer.
- `src/orchestrator.ts` → worker preamble also says "ask with the `question` tool
  (clear multiple-choice options, ONE question at a time)."

That is **Pattern A/C and it works** — *when the model actually calls the tool*.
The problem this task solves is the **other** case: the manager (and some workers)
answer by **writing the choices as plain text** at the end of the message instead
of calling the tool. That path currently renders as flat text — no buttons.

So the design is **layered**, exactly like the big players:

- Keep the `question` tool path (A/C) for *structured* decisions — it is the
  "right" mechanism and already ships.
- Add a **Pattern B post-processor** as the **model-agnostic catch-all** that turns
  the *free-form* trailing choice list into buttons. It needs nothing from the
  model except the list it already writes.

The two coexist cleanly: tool → structured form buttons; plain-text list →
post-processed buttons. If a model switches, the text path keeps working.

---

## 4. Recommendation for our bot

**Primary: Pattern B — deterministic post-processing of the trailing choice list.**

Concretely:

- **Detect** a short lettered/numbered list in the **last block** of the reply
  (2–8 items, sequential markers `A/B/C` or `1/2/3`, short lines, not in a code
  fence).
- **Render** the body text unchanged and **attach** an inline keyboard mirroring
  the list to the last chunk. (Non-destructive: keep the text so full option
  wording stays readable even though button labels truncate. Optional: strip the
  now-redundant list for a cleaner look — a one-line flag.)
- **Relay** the clicked option as a **new user message** to the session
  (`session.prompt(sessionID, <option text>`) — the proven "send it as if typed"
  behaviour (same as ChatGPT/ChatLab follow-ups).

### Why B and not the others

| Option | Verdict | Reason |
|--------|---------|--------|
| **A — tool call** | ❌ reject | The constraint is literally "don't depend on the LLM remembering to call a tool." Also fragile: weak/local models drop tool calls (Cline's JSON-vs-XML breakage, §2). |
| **C — model emits JSON/XML marker** | ❌ reject as primary | Requiring the model to emit a special marker format **is** "telling the model about the button mechanism." Fails the constraint. (We keep C *only* via the existing `question` tool, which is optional.) |
| **D1 — separate cheap call** | ⚠️ fallback | Truly model-agnostic, but adds latency + cost on every reply, and the 2nd model is itself non-deterministic. Only worth it if B's detection proves unreliable across models. |
| **D2 — content-driven** | ◐ partial fit | Cursor/Copilot render buttons on *code blocks* — we have no code here; our "content" is a prose list, which is exactly B. |
| **B — post-process the list** | ✅ **adopt** | 100% model-agnostic, zero extra calls, zero model-side knowledge, deterministic. The list is a *content* instruction the model already follows, not a UI mechanism. |

### Trade-offs of B (be honest about them)

- **Detection can miss or over-fire** if a model formats options unusually
  (e.g. a long multi-line option, or a non-sequential list). → Mitigate with a
  normalized matcher + a conservative "last block only, 2–8 short sequential
  lines" rule + **graceful fallback to plain text** (never break the reply).
- **We cannot force the model to write a list.** The system prompt already asks
  for options; if a model stops listing them, buttons don't appear — but that is
  the *content* deciding, not the button mechanism, so the constraint is intact.
- **Button label truncation** (Telegram shows ~40 chars, `callback_data` ≤ 64
  bytes). → Keep full wording in the body text; use a short id in
  `callback_data`, not the option text.

---

## 5. Implementation sketch (tied to the real code)

All integration points exist; this is a *new* pure helper + small edits to two
functions. No new model knowledge, no new tool.

### 5.1 Detect — pure, testable helper (new file `src/choices.ts`)

```ts
/** A trailing "choice list" the LLM wrote: 2–8 short, sequentially-marked lines. */
export interface Choices { body: string; options: string[] }

// single letter (A. / A) / A: / A — / A - / (A)) or number (1. / 1) / 1: / 1 -)
const MARK = /(?:^|\n)\s*(?:\(?([A-Ha-h]|[1-9]|1[0-2])\)?[\.\)\:\-–—]\s+)(\S.*)$/;

export function extractTrailingChoices(markdown: string): Choices | null {
  // Work on the cleaned text (after stripTags), before HTML/rich chunking,
  // so list markers are intact and code fences are easy to exclude.
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  // 1) Find the last contiguous run of non-empty lines that all match MARK,
  //    and that sits at the very end (ignore trailing blank lines).
  // 2) Require: 2..8 lines, sequential markers, each option line <= ~80 chars,
  //    and the run is NOT inside a ``` fence.
  // (omitted: ~20 lines of the obvious scan; kept as a pure fn for unit tests)
  // Return null when unsure → caller falls back to plain text (never breaks reply).
  // On success: body = markdown minus that trailing run; options = the label texts.
}
```

Design notes (robustness):
- **Only the last block.** A numbered *steps* list in the middle of an answer must
  not become buttons. We only convert a list that terminates the message — which
  is exactly how the manager writes its choices.
- **Sequential markers** (`A,B,C` / `1,2,3`) is a strong "these are options"
  signal and suppresses false positives on bullet lists.
- **Fence guard:** if the run is inside ```` ``` ```` (a code sample), skip.
- **Fallback = no change.** Any uncertainty → return `null` → the reply is sent
  exactly as today. Failure mode is "no buttons", never "broken message."

### 5.2 Render — attach the keyboard to the last chunk

`sendReply` (`src/bot.ts` ≈L987) is the single choke point for model replies.
Add detection at the top and thread the keyboard onto the **last** chunk:

```ts
private async sendReply(conv: ConvKey, text: string): Promise<void> {
  const clean = stripTags(text ?? "");
  if (!clean) return;

  // NEW: deterministic, model-agnostic choice buttons.
  const ch = extractTrailingChoices(clean);
  const kb: Keyboard | undefined = ch?.options
    ? choiceKeyboard(registry.put(conv, this.st.peek(conv)?.sessionID, ch.options))
    : undefined;

  const body = ch ? ch.body : clean;               // default: keep body intact
  /* …existing rich / HTML chunking of `body`… */
  // On the LAST chunk only, pass the keyboard:
  //   rich path:  this.tg.sendRich(conv, lastChunk, kb ? { reply_markup: kb } : {})
  //   html path:  this.tg.sendMessageId(conv, lastChunk, kb ? { reply_markup: kb } : {})
}
```

`sendRich` already forwards `opts.reply_markup` (`src/telegram.ts` ≈L386) and
`sendMessage` accepts `reply_markup` via `opts`, so this is a two-line change per
path. Keyboard builder mirrors the existing `fq:` builder (`src/bot.ts` ≈L3407):

```ts
// src/choices.ts
import type { Keyboard } from "./shared.js";
export function choiceKeyboard(id: string, options: string[]): Keyboard {
  const rows = options.slice(0, 8).map(
    (t) => [{ text: t.slice(0, 40), callback_data: `ch:${id}` }],
  );
  return { inline_keyboard: rows };   // one button per row, like the kill-picker
}
```

### 5.3 Relay — click → send the choice as a new user turn

`callback_data` is capped at 64 bytes, so we never put the option text in it. A
short id (4-char base36, like `src/commands/schedule.ts`) maps to the full data:

```ts
// in-memory, per-process (same lifetime as the session map)
const registry = new Map<string, { conv: ConvKey; sessionID?: string; options: string[] }>();
// id = 4-char base36; `registry.put(...)` returns the id; `choiceKeyboard(id, …)`
// encodes it as `ch:<id>`.
```

Add one branch to `handleCallback` (`src/bot.ts` ≈L2597), next to the existing
`fq:` / `perm:` branches:

```ts
if (data.startsWith("ch:")) {
  const id = data.slice(3);
  const rec = registry.get(id);
  await this.tg.answerCallbackQuery(cb.id);            // stop the client spinner
  if (!rec || !rec.sessionID) return;
  // The user's pick is the text of the row they tapped. We pass the clicked
  // label back; simplest reliable mapping is row index == option index, so
  // encode the index too: `ch:<id>:<i>`. (See note below.)
  const choice = rec.options[i];
  await this.oc.prompt(rec.sessionID, choice);          // "as if typed"
  // Optional: clear/disable the keyboard so it can't be re-tapped after the
  // turn resumes (editMessageText with an empty reply_markup, cf. the existing
  // one-shot button removal in telegram.ts).
  return;
}
```

**Index, not text, in `callback_data`:** encode the option *index*
(`ch:<id>:<i>`), look the label up from `registry`. This keeps `callback_data`
tiny, avoids any 64-byte/encoding worries, and is unambiguous (the model wrote
the labels; we relay the exact label the user tapped).

Relay semantics = **"send as if typed"** — the documented behaviour of
ChatGPT/ChatLab follow-ups ("When a visitor clicks a follow-up button, the
question is sent to the chatbot just as if they had typed it"). The session is
idle at this point (the reply that produced the buttons already finished its
turn), so `oc.prompt` starts a clean new user turn. If the session somehow became
busy again first, `oc.prompt` fails gracefully — same guard the existing
`sendToWorker` uses (`BUSY` check).

### 5.4 Files touched (narrow change)

| File | Change |
|------|--------|
| `src/choices.ts` | **new** — `extractTrailingChoices()` (pure) + `choiceKeyboard()` + `registry`. |
| `src/bot.ts` | `sendReply`: detect + attach `reply_markup` to last chunk (both rich & html paths); `handleCallback`: new `ch:` branch. |
| (optional) `src/shared.ts` | none needed — `Keyboard`/`Btn` types already exported. |

No change to any model prompt, no new tool, no new endpoint. That is the
narrowest viable change: one pure helper + two small edits at the two existing
choke points.

---

## 6. Edge cases & guards

- **Long option text:** button label truncated to ~40 chars; full text stays in
  the message body (we keep the body by default).
- **`callback_data` 64-byte cap:** use `ch:<4charId>:<i>` (≤ ~12 bytes).
- **> 8 options:** render first 8 (Telegram shows ≤ 8 rows well); the rest stay
  as text. (Hard API cap is 100 buttons — never approached.)
- **List inside a code fence / mid-message list:** not converted (fence guard +
  last-block-only rule).
- **User types instead of tapping:** unchanged — normal message flow already works;
  buttons are a convenience, not a requirement.
- **Stale keyboard after a `/new` or turn reuse:** remove/empty the keyboard on
  tap (the bot already does this for one-shot buttons, `src/telegram.ts`
  "remove (or replace) an inline keyboard … used to take the button off").
- **Two reply paths:** only `sendReply` (the model-reply choke point) is wired;
  command/status messages are unaffected.

---

## 7. References

- OpenAI Structured Outputs (generative UI): <https://platform.openai.com/docs/guides/structured-outputs>
- OpenAI conversational-assistant demo (`generate_ui`): <https://github.com/openai/openai-structured-outputs-samples/blob/main/conversational-assistant/README.md>
- ChatGPT follow-ups = separate, post-stream generation: <https://community.openai.com/t/feature-request-setting-to-disable-follow-up-suggestions/1396688>
- "Use another AI API call … output only valid JSON `{q1,q2,q3}`": <https://community.openai.com/t/how-to-create-follow-up-question-in-chat/645463>
- ChatJS follow-up suggestions (separate cheap model): <https://www.chatjs.dev/docs/features/follow-up-suggestions>
- Claude tool use ("regex → should be a tool call"): <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works>
- Claude computer use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- Claude artifacts: <https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them>
- NN/g GenUI — Claude `AskUserQuestion` predesigned module, Gemini AI Mode checkboxes: <https://www.nngroup.com/articles/genui-buttons-and-checkboxes/>
- Google Generative UI: <https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt>
- Gemini Computer Use: <https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-computer-use-model>
- Cursor Apply (client renders buttons; Apply is a separate model): <https://docs.cursor.com/agent/apply>
- Cline XML tool format: <https://github.com/cline/cline/blob/main/src/core/prompts/system-prompt/tools/write_to_file.ts>
- Cline "no tools field — prompt-based XML, parse the stream" + local-model JSON/JSON breakage: <https://github.com/modelmeld/modelmeld/blob/main/docs/integrations/cline.md>, <https://github.com/cline/cline/issues/10843>
- Devin AI SDK (typed events → UI parts, Allow/Deny): <https://docs.devin.ai/sdk/ai-sdk/overview>
- Devin Interactive Planning / confidence-gated approval: <https://docs.devin.ai/work-with-devin/interactive-planning>, <https://cognition.com/blog/devin-2-1>
- Copilot interactive elements (content-detected buttons): <https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/chat-with-copilot/chat-in-ide>
- Copilot custom action buttons request (closed not-planned): <https://github.com/microsoft/vscode/issues/275025>
