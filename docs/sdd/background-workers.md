# Spec: Background Workers (Option B — bot-managed topic-less workers)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-13
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Related:** `docs/sdd/phase1-foundations.md` (worker lifecycle, audit events), `docs/design-worker-overflow-recovery.md` (respawn path reused), `data/manager/**/.opencode/agents/tg-manager.md` (Manager delegation policy — updated in W4)

## 1. Problem

Today every worker the Manager spawns gets a **Telegram forum topic** (`spawnReserved` → `createForumTopic`, `orchestrator.ts:722`). That is the right default for big, long, high-risk or watch-worthy tasks: the user opens the topic and follows the worker's intro, status, and result in real time. It is the wrong default for the small, well-scoped, low-risk tasks that make up most delegated work: each one carves a topic into the forum, the user has to jump into it, and the forum fills with short-lived topics that auto-close.

The Manager already has a *second* delegation path in practice — the OpenCode `subagent` tool (an invisible child session that runs to completion and returns its result to the Manager). It works, but it is **off-design**: `tg-manager.md` denies `subagent`/`execute`/`shell`/`edit`, and the subagent path is *not* part of the bot's worker system (no `list_workers`, no status, no Review row, no worktree isolation, no overflow-respawn, not healed after a restart). So a "background" task today is either a live topic (too heavy) or an untracked subagent (not managed).

**Option B** (this spec) makes background a first-class, bot-managed mode: the Manager spawns a worker that runs in its own OpenCode session **without a topic**, is fully tracked by the worker system (state, status, Review, worktree, respawn, heal), and relays its result to the **main chat** instead of a topic. The Manager auto-decides background vs live per task (policy in `tg-manager.md`) and always says which it picked.

> **Why not Option A (allow + document `subagent`)?** A is faster and proven, but leaves background work untracked. B reuses the battle-tested worker lifecycle (capacity, worktree isolation, Review fingerprint, overflow-respawn, heal) and only redirects the Telegram surface from "a topic" to "the main chat." The topic-coupling is concentrated in a small number of call sites (below), so B is a bounded change. The live path stays byte-identical and untouched.

## 2. Requirements (EARS)

### B1 Spawn + state (a worker without a topic)
- B1.1 When the Manager calls `tg-bridge_spawn_worker` with `background: true`, the system shall create the worker's OpenCode session in the given directory (and its own worktree when the shared-repo rule applies) but shall NOT call `createForumTopic`.
- B1.2 The system shall store the background worker under a synthetic conversation key that maps to the main chat (so it is tracked, healed, and listed exactly like a live worker). A background conv shall never be produced from a Telegram message (it is internal-only).
- B1.3 A background worker shall appear in `tg-bridge_list_workers` with a marker that distinguishes it from a live (topic) worker.
- B1.4 The background worker's name shall be unique in the chat, enforced by the same `findWorker` check as live workers (so a background and a live worker can't share a name).

### B2 Relay (result delivery to the main chat)
- B2.1 When a background worker finishes, the system shall relay its done result — the worktree card (Diff/Merge/Delete/Review) or the review line — to the **main chat** (`chatOf(conv)`), not to a topic.
- B2.2 A background worker's done `[Bot event]` shall be delivered to the Manager exactly as a live worker's is (the existing `queueReport(orch, chatOf(conv), …)` path).
- B2.3 When a follow-up instruction is sent to a background worker, the "📨 Manager:" instruction display shall go to the main chat, not a topic.
- B2.4 A background worker's raw assistant text shall NOT be relayed to any Telegram conversation (kept quiet); the result reaches the user via B2.1 (card/review) and B2.2 (Manager relay of the [Bot event]). The raw-text sweep (`sweepUnrelayedReplies`) shall be skipped for a background conv. *(Alternative — redirect the raw text to the main chat — is noted in §3, decision R1.)*
- B2.5 For a background worker the system shall NOT call `closeForumTopic`, `editForumTopic`, or `createForumTopic` (no topic exists). The `setStatus` topic-title edit in particular shall be skipped.

### B3 Guards + integration
- B3.1 A background worker shall count toward the per-chat busy capacity exactly like a live worker (`workersOf` / `assertCapacity`).
- B3.2 A background writer in a shared repo shall get its own git worktree exactly like a live worker (the `workersOf`-based shared-repo check already covers it).
- B3.3 The Manager board's per-worker topic-jump buttons (`maybeOfferManagerBoard`) shall NOT include background workers (there is no topic to jump to).
- B3.4 `/stop`, `/clear`, the Review row, and context-overflow respawn shall all work for background workers, with their output relayed to the main chat.
- B3.5 After a restart, `healWorkers` shall settle a background worker whose session is actually idle (the existing `st.all()` sweep already covers it — no topic dependency).
- B3.6 All new user-facing text shall be available in Vietnamese and English via `tr()`.

## 3. Design

**Key mechanism — one redirect rule.** Every Telegram surface a worker touches is keyed by its conv. A live worker's conv is its topic (`chatId:threadId`); a background worker's conv is a **synthetic key `bg:<chatId>:<name>`**. A single helper decides where a worker's output goes:

```
relayConv(conv) = isBackgroundConv(conv) ? chatOf(conv) : conv
```

All Telegram output from a background worker (done card/review, follow-up display) goes to `relayConv(conv)` — the **main chat**. The raw assistant-text sweep is skipped for a background conv (B2.4). The `[Bot event]` is unchanged (already `chatOf(conv)`). The live path is byte-identical: `relayConv` returns `conv` for a topic conv, and no background conv is ever created on the live path.

**Conv format.** New helper `bgConvKey(chatId, name) = "bg:" + chatId + ":" + name`, and `parseConv` / `chatOf` (`src/conv.ts`) learn the `bg:` prefix: `parseConv("bg:<chatId>:<name>")` → `{ chatId, background: true, workerName: name }`; `chatOf` returns `chatId` unchanged. `isBackgroundConv(key) = key.startsWith("bg:")`. Real convs are numeric `chatId[:threadId]` and never start with `bg:`, so there is no collision. `bg:` keys are produced **only** internally by `spawnReserved` — `convOf` (Telegram message routing) never emits one.

### Integration points (all verified against current source)

| # | Item | Approach |
|---|---|---|
| I1 | Conv format | `src/conv.ts`: add `bgConvKey()`, extend `parseConv` (return `background`/`workerName`), add `isBackgroundConv()`. Pure, unit-tested. |
| I2 | `SpawnSpec` + tool | `src/orchestrator.ts` `SpawnSpec` (L161): add `background?: boolean`. `spawn_worker` tool (L1620): add `background` to `inputSchema` and pass it into the spec. |
| I3 | Spawn (skip topic) | `spawnReserved` (L679): when `spec.background`, do **not** call `createForumTopic` (L722); set `conv = bgConvKey(chatId, name)`; skip the intro message (L750–767) and the deep-link button (L788–797); still create the session, set the worktree, and `st.set(conv, { sessionID, worker, … })` (L774–783) so `bySession` routes events to the bg conv. |
| I4 | Done relay | `onWorkerFinished` (L1034): compute `relay = relayConv(conv)`; send the worktree card / review line to `relay` (currently `conv`, L1088–1103); keep the `[Bot event]` (`queueReport(this, chatOf(conv), …)`, L1104–1110) unchanged; **skip** `closeForumTopic` (L1126) and the `pendingTopicDelete` purge branch (L1045–1059) for a background conv. |
| I5 | Status title | `setStatus` (L978): guard the `editForumTopic` call (L985) with `!isBackgroundConv(conv)`. |
| I6 | Raw text sweep | `bot.ts` `sweepUnrelayedReplies` (L897) / `sendReply` (L1276): skip the raw assistant-text relay when the conv is a background worker conv (B2.4). |
| I7 | Follow-up display | `sendToWorker` (L808): render the "📨 Manager:" instruction to `relayConv(conv)` (currently `conv`, L820–825). |
| I8 | List + board | `list_workers` tool (L1597): append a `· bg` marker for background workers. `maybeOfferManagerBoard` (`bot.ts` L3031): exclude background convs from the per-worker jump rows (L3061 already filters on `introMessageId`; a bg worker has none). |
| I9 | Capacity / heal | **No change.** `workersOf` (L605) and `assertCapacity` (L672) are `chatOf`-based, so a bg conv (whose `chatOf` = main chat) is counted; the shared-repo worktree check (L692) and `healWorkers` (L333) already cover it. Verify, don't change. |
| I10 | Manager policy | `tg-manager.md`: add the background-vs-live auto-decision policy + "always say which you picked." (W4.) |

## 4. Tasks

> **Marker convention (all tasks):** do NOT mark a task `[x]` yourself — leave its checkbox **unchecked**. The pipeline's Accept step stamps the implementing commit's SHA automatically. A self-marked task corrupts the Accept's commit selection and stalls the auto-continue chain (happened to W2, 2026-11-20).

1. [x] (cb94dcf) **W0 Conv format (foundation).** `src/conv.ts` only: add `bgConvKey()`, extend `parseConv` (return `background`/`workerName`), add `isBackgroundConv()`, and the `relayConv` helper. Unit tests: parse/format round-trip, `chatOf` correctness, `isBackgroundConv` discrimination, `relayConv` for a topic vs a bg conv. *Checkpoint: typecheck + test:unit green.*
2. [x] (5aabd08) **W1 Spawn a background worker (I2 + I3).** `SpawnSpec.background` + `spawn_worker` tool `background` param + `spawnReserved` skip-topic branch (synthetic `bg:` conv, no intro/deep-link; session + worktree + state as today). A background spawn creates a session (+ worktree) with no topic, stores the worker under the bg conv, and `findWorker` rejects a duplicate name. *Checkpoint: focused harness — spawn with background:true against a mock Telegram (createForumTopic NOT called) + mock OpenCode (session created; st has the bg conv with worker + sessionID); off-mode (no background) byte-identical.*
3. [x] (f0b93ca) **W2 Relay to the main chat (I4 + I5 + I6 + I7).** Wire `relayConv`: `onWorkerFinished` (card/review to main chat; skip `closeForumTopic`/purge), `setStatus` (skip `editForumTopic`), `sweepUnrelayedReplies` (skip raw assistant text), `sendToWorker` (instruction display to main chat). A background worker's done card/review lands in the main chat, the [Bot event] fires to the Manager, no `closeForumTopic`/`editForumTopic` is called, and no raw assistant text is relayed. *Checkpoint: mock-Telegram harness — card sent to chatOf(bgConv) not the bg conv; closeForumTopic/editForumTopic not called; sweep skipped; live path unchanged.*
4. [x] (60c09c8) **W3 Worker-system integration (I8 + I9).** `list_workers` `· bg` marker; `maybeOfferManagerBoard` excludes bg convs; verify capacity/worktree/heal count bg workers (I9 — tests asserting a bg worker is in `workersOf`, counts toward busy, and gets a worktree in a shared repo). A bg worker is listed (marked), is not a board-jump target, and is capacity/worktree/heal-equivalent to a live worker. *Checkpoint: focused checks — bg worker listed with · bg marker, excluded from board jump, counted in capacity + shared-repo worktree + heal.*
5. [ ] **W4 Manager policy + E2E smoke (I10).** `tg-manager.md`: the background-vs-live auto-decision policy (background for small / well-scoped / low-risk; live for big / long / high-risk / watch-worthy) + "always announce the mode." Add a smoke scenario: spawn a background worker on a small task, assert (a) no topic, (b) the result is relayed to the main chat, (c) it is listed as `bg`, (d) `/stop` works. *Checkpoint: full test:unit + smoke (the background scenario must be inert-safe: skipped when the OpenCode service is unavailable, like the existing scenarios).*

## 5. Risks & open questions
- **R1 — main-chat noise (B2.4).** Suppressing the raw assistant text keeps the main chat quiet but means the user only sees the card + the Manager's relayed summary. If that feels too thin, the §3 alternative (redirect the raw text to the main chat) is a one-line change in `sweepUnrelayedReplies`. **Decision needed before W2.**
- **R2 — `purgeConv` / topic-delete paths.** Background convs have no topic, so the `onTopicDeleted` / `pendingTopicDelete` / `purgeConv` machinery must be a no-op for them. Confirm `purgeConv` (worktree removal, directory-based not topic-based) still runs for a bg worker removed via `/prune`; add a guard so it never attempts a topic delete.
- **R3 — `bg:` key handling.** No collision expected (real convs are numeric), but the `bg:` prefix must be handled in every place that parses a conv key. W0 adds the helpers; W1–W3 use only `isBackgroundConv`/`relayConv`/`bgConvKey`, never raw splits.
- **R4 — confirm-mode approval.** A background spawn still goes through the existing confirm/approval flow (`requestApproval`) when `auto()` is off — the approval card is sent to the chat (not a topic), so it works. Verify in W1.
- **Open — auto-decision tuning.** The background-vs-live heuristic lives in `tg-manager.md` (prompt-level). Expect to tune it after a few real spawns (like the quick-replies instruction tuning). The code side is mode-agnostic.
