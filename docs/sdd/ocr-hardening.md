# Spec: OCR hardening — deterministic gates + worker discipline

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-19
- **Scope:** `opencode-telegram-bot`
- **Format:** problem -> design -> tasks, human checkpoint after each task
- **Builds on:** `src/commands/spec.ts` (`specAccept`, `specRunSpawn`), `src/orchestrator.ts` (worker completion path), `src/checkpoint.ts` (checkpoint card), `.opencode/skills/review-code/SKILL.md`
- **Source of ideas:** `alibaba/open-code-review` (study report 2026-11-19, `/home/phatnd12/fpt/ocr-report.md`) — the "deterministic engineering × agent" philosophy: *for the parts that can't afford to go wrong, rely on engineering logic, not the language model.*

## 1. Problem

Three failure modes we have actually hit, all of which OCR's hybrid design addresses:

1. **Accept can pass without the host ever seeing a green build.** `specAccept` re-classifies checks from the worker session's shell history — but a session with *no* check items (fresh session, lost history after restart) produces no "errored check", so accept proceeds on commit checks alone. The decision to merge code (the one thing that "can't afford to go wrong") rests on the worker's self-reported history, not on a build the host ran itself.
2. **Worker results are free-form.** Coverage ("did it do everything?") is only discoverable by re-reading the diff; the final report format is whatever the LLM felt like; re-running a worker on inputs that changed nothing costs a full LLM turn with no guardrail.
3. **Review quality drifts.** The `review-code` skill is a pure language-driven review — the three failure modes OCR lists (incomplete coverage, position drift, unstable quality) apply to it unchanged.

## 2. Goals and non-goals

**Goals**
- Host-side, deterministic verification at accept: the bot runs the canonical checks itself in the worktree; a red gate refuses accept without any LLM verdict.
- A fixed, machine-parseable report schema for spec workers, plus tool-discipline lines in the worker brief (small token/loop savings, deterministic where possible).
- A coverage guardrail + citation-existence check for the `review-code` skill.
- A fail-closed re-run guard: identical inputs that already succeeded once are not re-spawned silently.

**Non-goals (v1)**
- No cost model / token budget gate (OCR item f) — only revisit if sessions actually run over budget.
- No LLM reflection pass over review findings (OCR's full review-filter) — borrow the spirit (precision, "only delete when provably wrong"), not the module.
- No auto-distillation of a toolset from tool-call traces — OCR hand-tuned its toolset; we just write the discipline lines.
- No summarization-recovery for oversized worker briefs — current briefs are small; add if they ever exceed ~24KB.
- Not installing/using the `ocr` CLI itself — that would be a separate "use the tool" decision, not borrowing the architecture.

## 3. Design

### T1 — Host-side deterministic accept gate

Borrow: OCR's "engineering logic guarantees the steps that must not go wrong".

`specAccept` (after the existing commit + freshness guards, before `markTask`) runs the canonical gate **itself**, in the worktree:

```
npm run typecheck && npm run test:unit
```

- exit 0 → continue exactly as today (behavior unchanged on green).
- non-zero → refuse: one message with the last ~15 lines of the failing output, no marker, no push, no `spec_accept` audit entry, worker entry untouched (so "Redo with note" still works).
- The gate is a hard prerequisite: no `runAnyway`-style bypass, no config flag to disable it (that would reopen the hole). It is cheap here (~1–3 min on this box) and runs only at accept time.
- Add `gate: { typecheck: "pass"|"fail", unit: "pass"|"fail" }` to the `spec_accept` audit meta on success.

Unit tests: a failing worktree (broken `.ts` file) → refuse with output tail; green worktree → accept as today; gate failure leaves no marker/commit/audit entry.

### T2 — Fixed worker report schema + coverage accounting

Borrow: OCR delegate mode's mandatory coverage accounting (`total/done/skipped(+reason)`) and fixed output schema.

- The spec worker brief gains a **Report** section: the final message MUST contain the fields `Status:` (DONE | BLOCKED | FAILED), `Coverage:` (each deliverable of the task with done / skipped(+reason)), `Files:` (changed paths), `Tests:` (commands + results), `Follow-ups:` (may be empty).
- Host side: when the spec worker's session ends, parse these fields from the final message; missing field → post a ⚠️ note in the spec topic listing what is missing (**soft** — never blocks accept; accept is governed by T1's gate). Parsed fields go onto the worker entry (`report?` field, optional → `state.json` backward compatible) and into the checkpoint card as a compact block.
- Unit tests: brief renders the schema; parser extracts all fields / reports what's missing; a non-spec worker is unaffected (no parsing attempt).

### T3 — Tool-discipline lines in the worker brief

Borrow: OCR's scenario-tuned minimal toolset + tool-call budget (from its `MAIN_TASK` template).

Add to the spec worker brief (prompt-only, no infra):
- Files already shown in the brief are in context — do not re-read them.
- Max 2–3 tool calls per sub-step; batch independent calls in parallel.
- Do not re-run a verification command that already ran green in this session unless files it covers changed since.
- End with the Report section (T2) once all sub-steps are done/skipped — do not go looking for marginal extra work.

Checkpoint: typecheck + unit green; manager reads the rendered brief from a test snapshot.

### T4 — `review-code` skill: coverage guardrail + citation check

Borrow: OCR delegate's deterministic pre-step (file list + coverage checklist) and the portable core of its comment-positioning (a citation must exist where it claims to).

Edit `.opencode/skills/review-code/SKILL.md`:
- Pre-step: list changed files (`git diff --name-only <range>`); every file is either reviewed or explicitly skipped with a reason.
- Findings must cite `file:line`; after drafting, verify each cited line exists in the diff (the skill instructs the agent to grep the diff for the cited context — a citation that does not match is a finding about the review itself, not the code).
- Output ends with a coverage table: file → reviewed/skipped(+reason).

### T5 — Input-fingerprint re-run guard

Borrow: OCR action's content-addressed cache, fail-closed (OCR hashes the *content* of everything that can change the result, and re-runs when it can't prove sameness).

- At `specRunSpawn` time compute `fp = SHA256(task brief text + spec file content + base branch name + base commit)`, store it on the worker entry (`briefFp?`, optional).
- Before spawning: if a **previously completed** entry exists for the same spec+task with the identical `fp` → do not spawn; post a card: "🔁 <Task> đã chạy thành công với cùng input (worker <name>, commit <hash>, <time>)" with buttons **Chạy lại** (spawn anyway, recorded as `reRun: true` in audit) and **Hủy**.
- Fail-closed: any difference (or missing fingerprint on the old entry, or old entry not `done`) → spawn normally. No config flag.
- Unit tests: identical fp + done → card, no spawn; different fp → spawn; old entry `failed` → spawn; missing fp on old entry → spawn; "Chạy lại" → spawn with audit `reRun: true`.

## 4. Tasks

1. [x] (aa2dfb1) **T1 Accept gate.** Host-side `typecheck` + `test:unit` in the worktree before `specAccept` marks the task done; refuse with output tail on red; audit meta gains gate results. *Checkpoint: tests green + one real accept end-to-end (manager verifies the gate ran in the worktree, not the worker session).*
2. [ ] **T2 Report schema.** Fixed `Status/Coverage/Files/Tests/Follow-ups` block in the spec worker brief; host parses it on worker completion, warns on missing fields, shows it on the checkpoint card. *Checkpoint: tests green; on the next real spec run the card shows the block (manager checks live).*
3. [ ] **T3 Tool discipline.** Prompt-only budget lines in the spec worker brief. *Checkpoint: rendered brief reviewed in a test snapshot.*
4. [ ] **T4 Review skill guardrail.** Coverage checklist + citation-existence check in `.opencode/skills/review-code/SKILL.md`, coverage table in the output. *Checkpoint: run /review on a real commit; manager verifies the coverage table and that citations match the diff.*
5. [ ] **T5 Re-run guard.** `briefFp` fingerprint on spec worker entries; identical-inputs-already-succeeded → "Chạy lại / Hủy" card instead of silent re-spawn; fail-closed. *Checkpoint: tests green; a manual re-tap of a done task shows the card (manager checks live).*
