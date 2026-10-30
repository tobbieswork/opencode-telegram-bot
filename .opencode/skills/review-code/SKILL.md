---
name: review-code
description: Read-only code review of this repo's changes (uncommitted diff, a branch, a commit, or a PR number). Use when the user asks to review code, check a diff/PR/commit, or says /review. Verifies with typecheck + unit tests and reports evidence-backed findings only.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: code-review
---

## What I do

Review a set of code changes in this repo and report findings backed by evidence. I am **read-only**: I never edit files, commit, push, or restart the bot service. I only propose fixes.

## Hard rules

- Do not modify any file, run `git commit/push/checkout/reset`, or run `systemctl` (restarting `opencode-bot` cuts in-flight turns of the live bot).
- Do not run `npm run smoke` (real LLM calls, minutes long, needs the live OpenCode service).
- Never print secrets (`.env` values, tokens, internal URLs) in the report, even if the diff contains them: flag the file:line and say "secret in diff".
- Reply in the language the user wrote in (Vietnamese by default for this repo).

## Workflow

1. Read `AGENTS.md` (and `CONTRIBUTING.md` if needed) for the project's rules.
2. **Resolve the target** (first match wins), and state the scope you chose at the top of the report:
   - Argument is a PR number (`84`, `#84`): `gh pr view <n>` + `gh pr diff <n>`
   - Argument is `staged`: `git diff --cached`
   - Argument is a commit sha: `git show <sha>`
   - Argument is a range (`a..b`, `a...b`) or branch name: `git diff <base>...<branch>`, where base is `origin/main` (fallback `main`)
   - No argument, uncommitted changes exist: `git diff HEAD` plus `git status --short` for untracked files (read the untracked source files too)
   - No argument, clean tree: `git diff origin/main...HEAD` (fallback `main...HEAD`); also `git log --oneline origin/main..HEAD`
   - Still empty: say "nothing to review" and stop. Do not invent findings.
3. Ignore noise: lockfiles, `CHANGELOG.md` and version bumps (release-please generates them), `.DS_Store`, mode-only changes, generated or vendored files.
4. Read the **full enclosing function** (and callers when behaviour depends on them) for every hunk. `src/bot.ts` (~150KB) and `src/orchestrator.ts` (~75KB) are too big to read whole: read by hunk plus surrounding function, and grep call sites. For a large diff, go file by file.
5. **Verify** (seconds, safe): `npm run typecheck`, then `npm run test:unit`. Report the real result. If a check fails, say so with the relevant output. If you could not run it, say that. Do not claim it passed.
6. Write the report (format below).

## Evidence rules

- Report a finding only if you traced it: the code path, the input, and the wrong outcome. If you could not confirm it, either drop it or mark it `Confidence: Low` and say what is unverified.
- Every **Critical** and **Warning** needs: `file:line`, a concrete failure scenario (input/state, then wrong result), and a suggested fix.
- Skip anything `tsc` or the formatter already catches, and pure taste. Max ~10 findings, ordered by severity. If there is nothing real, say "No issues found" and list what you checked.

## Checklist for this repo

### Operations and lifecycle
- The bot runs from source under systemd with no hot reload: changes need a restart to take effect. Flag changes that assume otherwise.
- Shutdown/restart paths: in-flight turns must drain (see `drain` in `src/bot.ts` / `src/index.ts`); no new work may start while draining; timers must be `unref()`ed or cleared so the process can exit.
- `data/state.json` survives restarts: any new state field needs a default/migration for old files, and must not break existing sessions on reattach.
- Never two pollers on one token (Telegram 409 conflicts).
- The unit pins an nvm Node path (`deploy/opencode-bot.service`): a Node version change must update it too.

### Concurrency and side effects
- Turn generation (`turnGen`), live preview state, and `inflight` maps: a late delta, retry, or concurrent handler must not resurrect a preview or double-send a final reply.
- Scheduler, reminders, PR watcher, recovery sweeps: duplicate fire after restart or retry, missing dedup, non-idempotent side effects (messages, topic create/delete, worktree merge/delete).
- State read before an `await` and written after it (stale overwrite). Re-read after the await.
- Commands that act on the machine or data (`/reboot`, `/clear`, `/prune`, `/kill`, `/wt` merge/delete) need confirmation or guards.

### Telegram and user-facing text
- Telegram HTML: untrusted text must go through `esc()`. Unbalanced tags or raw `<`/`>` make the whole message fail.
- Message limits (4096 chars), rate limits, errors swallowed where a failure should be visible to the user (or the reverse: a best-effort path that now throws).
- Only allowed users can run commands; check any new entry point (callback queries, reactions, topics) for the same gate as existing ones.
- Labels shown to users are Vietnamese; keep that consistent.

### Security
- Secrets/tokens/credentials, internal URLs, or `.env` values in code, logs, error messages, or docs.
- User text flowing into shell commands, git refs, file paths, or prompts for another agent without validation (path traversal, argument injection).
- File access broader than the configured working directory.

### Conventions and tests
- New command: added to `src/commands.ts` (single source for menu, `/help`, buttons) and to the `GOLDEN` set in `scripts/test-commands.ts`.
- New `scripts/test-*.ts`: registered in `package.json` and chained into `test:unit` (easy to forget).
- New logic with branches/error paths has a unit test; tests assert behaviour, not just "does not throw".
- Conventional Commits for the PR/commit title (`feat:` / `fix:` / `test:` / `docs:`).
- Matches the surrounding code's naming, comment density, and idiom. No new runtime dependencies (see `CONTRIBUTING.md`).

### General
- Logic: off-by-one, wrong comparison, missing guard, async/await misuse, unhandled rejection (`void promise` without `.catch`).
- Type safety: `any`, unsafe casts, non-null `!` on values that can be missing.
- Error handling: empty catch, swallowed errors, poor messages, unvalidated external input.
- Performance: blocking work on the event loop, unbounded growth of in-memory maps/arrays, N+1 API calls.

## Output format

```
## Code Review: <branch or target>
**Scope:** <what was reviewed, how it was resolved>
**Verification:** typecheck <pass|fail|not run> · test:unit <pass|fail|not run>

### Summary
<2-3 sentences: what changed, overall impression>

### Findings
#### Critical
- `file:line` [Confidence: High|Medium|Low] <issue>
  - Scenario: <input/state → wrong result>
  - Fix: <suggested change>

#### Warnings
- (same shape as Critical)

#### Suggestions
- `file:line` <improvement> (max 3, only if worth the reader's time)

### Checked / not checked
<areas reviewed; anything skipped or unverifiable and why>

### Verdict
Approve | Approve with comments | Request changes — <one line why>
```

Omit an empty severity section. If there are no findings, output Summary, Checked / not checked, and `Verdict: Approve`.

## Severity

| Level | Meaning |
|-------|---------|
| **Critical** | Will cause a bug, crash, data loss, duplicate side effect, or security problem |
| **Warning** | Likely issue, fragile pattern, or risk that should be addressed before merge |
| **Suggestion** | Readability/maintainability improvement; never blocks the merge |

## When to use me

When asked to review a diff, branch, commit, or PR in this repo. If the user wants a focus ("security", "restart behaviour"), weight that area first but still cover the rest briefly. Ask a clarifying question only if the target is ambiguous and the default scope would not make sense.
