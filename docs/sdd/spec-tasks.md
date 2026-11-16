# Spec: Spec-to-tasks flow (`/spec`)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-16
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, human checkpoint after each task
- **Builds on:** `src/orchestrator.ts` (`spawn`, workers), `src/worktree.ts` (isolated branch per worker), `docs/sdd/phase1-foundations.md` (audit log), `docs/sdd/next-step-buttons.md` (button conventions)

## 1. Problem

Every spec in `docs/sdd/` ends with a numbered task list, and each task has a
human checkpoint (see `queue-and-steer.md`, section 4). Today a person turns
those tasks into prompts by hand: copy the task text, say which spec it belongs
to, remind the agent of the verify order, then remember which tasks are done.
Progress lives in the person's head and in chat history.

The bot already has the pieces: workers with their own worktree and branch,
inline buttons, an audit log. What is missing is the link from "a task in a
spec file" to "a worker run with the right prompt" and back to "task done".

## 2. Goals and non-goals

**Goals**
- List the specs in `docs/sdd/` with progress, and the tasks of one spec.
- Run one task at a time as a worker, with a prompt built from the spec.
- Stop at the task's checkpoint and report honestly what passed and what was not run.
- Record progress in the spec file itself, so it survives restarts and shows up in git.

**Non-goals (v1)**
- Writing specs from Telegram (`/spec new`). Specs are still written in a normal chat and committed as today.
- Running several tasks in parallel, or running the next task without a tap.
- Editing the spec's requirements or design from this flow. Only task status changes.
- Merging. The PR is merged by the user on GitHub.

## 3. Requirements (EARS)

### S1 Reading specs
- S1.1 When the user sends `/spec`, the system shall list every `docs/sdd/*.md` file of the conversation's current directory that has a `## ... Tasks` section, each with its title and progress (`3/8`).
- S1.2 When the user taps a spec, the system shall show its tasks, each as done, next, todo or blocked, and a **Run** button on the next runnable task.
- S1.3 If the directory is not a git repository or has no `docs/sdd/`, the system shall say so in one line and offer nothing else.
- S1.4 A task list that cannot be parsed shall produce a message naming the spec and the first line that failed. It shall never run a guessed task.

### S2 Running a task
- S2.1 When the user taps **Run** on a task, the system shall start a worker on the spec's branch `spec/<spec-name>` in its own worktree, creating the branch from the default branch if it does not exist; when markers are missing it adds them in that same branch-creation commit (S4.3).
- S2.2 The worker prompt shall contain: the full text of the task; the requirement IDs it names, each with its text copied from the spec; the spec's "Out of scope" section; and the verify order from `AGENTS.md` (typecheck and unit tests first, smoke last).
- S2.3 The prompt shall instruct the worker to write tests before code, make one conventional commit for the task, and stop. It shall not start the next task.
- S2.4 Only one task per spec shall run at a time. Tapping **Run** on a second task while one runs shall say which task is running.
- S2.5 Only allow-listed users shall be able to run a task, with the same check as normal prompts. The user id is recorded.
- S2.6 A task whose text contains a line starting `Needs:` (for example `Needs: live OpenCode service`) shall be shown as blocked with that reason. The system shall check what it can (for example, the service answers on its port) and let the user run it anyway with an explicit second tap.

### S3 Checkpoint
- S3.1 When the worker finishes, the system shall post a checkpoint message with: the task ID, the commit (short hash and subject), the files changed, the checks that were run with their result, the checks that were **not** run, and the task's checkpoint sentence from the spec.
- S3.2 The system shall build the "run / not run" lists from the worker's actual command results, not from the worker's own claim. A check with no recorded result counts as not run.
- S3.3 The checkpoint message shall carry three buttons: **Accept**, **Redo with note**, **Stop**.
- S3.4 **Accept** shall mark the task done in the spec file (S4), commit that change on the spec branch, and offer the next task.
- S3.5 **Redo with note** shall ask for a note, then send it to the same worker session so it keeps its context, and return to S3.1 when the worker finishes.
- S3.6 **Stop** shall stop the worker, keep its worktree and uncommitted work, and leave the task not done.
- S3.7 A worker that ends in an error, or without a commit, shall produce a checkpoint that says so and offers **Redo with note** and **Stop** only. It shall not offer Accept.

### S4 Status in the spec file
- S4.1 Task status shall live in the spec file as a marker after the task number: `[ ]` todo, `[x]` done. Done tasks shall end with the short commit hash in parentheses.
- S4.2 The system shall change only these markers and hashes. It shall not reformat or rewrap any other line.
- S4.3 A spec with no markers shall be treated as all todo. Markers are added when the spec's branch is created (S2.1), so every later marker change touches a single task line only.
- S4.4 Status changes shall be written on the spec branch only, never on the user's checked-out branch.

### S5 Pull request
- S5.1 After the first Accept on a spec, the system shall offer **Open draft PR**. The PR title shall be `feat: <spec title>` and the body shall list the tasks with their status.
- S5.2 Each later Accept shall push the branch and update the PR body.
- S5.3 When the last task is accepted, the system shall offer **Mark ready for review**. It shall never merge.
- S5.4 The system shall not push to `main` or any protected branch, and shall name the branch explicitly when pushing.
- S5.5 When the PR is merged (detected on the next `/spec` use), the system shall offer **Clean up**, which deletes the `spec/<spec-name>` branch and its worktree. It shall refuse while the branch has commits that are not in `main`.

### S6 Controls and visibility
- S6.1 `OPENCODE_TG_SPEC` shall enable the feature. Default on. When off, `/spec` replies that it is disabled and nothing else changes.
- S6.2 Each run, checkpoint, accept, redo, stop and PR action shall be written to the audit log as `spec_run`, `spec_checkpoint`, `spec_accept`, `spec_redo`, `spec_stop`, `spec_pr`.
- S6.3 All new user-facing text shall be available in Vietnamese and English via `tr()`.
- S6.4 State shall be rebuilt from the spec file and `git` on every use. Only the id of the running worker per spec is kept in `data/state.json`.

## 4. Design

### Parser
`src/spec.ts`, pure functions, no I/O.

- Finds the heading that matches `/^##\s+\d*\.?\s*Tasks/i`, reads numbered items until the next `## `.
- Item shape (matches current specs): `N. [marker] **ID Title.** body (REQ IDs). *Checkpoint: sentence.*`
- Returns `{ n, id, title, marker, commit?, body, reqIds, checkpoint, needs? }[]`.
- Requirement IDs (`Q1.2`, `W6.1`) are looked up in the spec's requirement section by line prefix, so the worker gets their text without reading the whole file.
- Rewrites status with a targeted line replace (S4.2), then re-parses to check the result is identical except for markers.

### Flow
```
/spec
  list specs (progress)
    tap spec -> task list, [Run Q3] on next runnable
      Run -> spawn worker on spec/<name> worktree
        worker: tests first, code, one commit, stop
      checkpoint card (S3.1)
        Accept       -> mark [x] + hash, commit, offer next / draft PR
        Redo + note  -> same session, back to checkpoint
        Stop         -> keep worktree, task stays todo
```

### Decisions (change any of them)
- **Status in the spec file,** not `state.json`: it shows in git and a restart loses nothing.
- **A person starts every task.** No auto-run after Accept. This matches the checkpoint habit in the existing specs.
- **Redo goes to the same session,** so the worker keeps what it learned.
- **One branch per spec, one commit per task,** plus one small commit per Accept for the marker. Each commit passes on its own.
- **Draft PR after the first accepted task,** ready after the last. Work is visible early and the user decides when it is review-ready.
- **Blocked is advisory.** The user can override, because a stale check should not trap a task.
- **The checkpoint lists come from recorded command results.** A worker saying "tests pass" does not count.
- **`/spec new` is deferred.** It needs its own design questions step and spec.

### Risks and open questions
- **Spec format drift.** Older specs may not match the item shape exactly. S1.4 makes a parse failure visible, and task S1 includes a golden test that parses every spec currently in `docs/sdd/`.
- **Recorded command results (S3.2).** Whether the worker's tool calls are available in a form the bot can read reliably is not yet checked. Task S0 settles it before anything is built.
- **Prompt size.** A long task plus requirement text can grow. Cap at about 6000 characters and say what was cut.
- **Worker on a dirty main checkout.** Using a worktree avoids it, but a repo with no commits or a detached HEAD needs a clear error.
- **Spec edited on `main` while the branch is open.** The branch may need a rebase before the PR. v1 reports the conflict and stops.

## 5. Tasks (each ends with a human checkpoint)

0. [ ] **S0 Spike.** Run one short real worker task by hand. Record in a Findings section whether the bot can read the worker's executed commands and their exit codes (S3.2), and whether a note can be sent to a finished worker's session (S3.5). *Checkpoint: confirm the answers before building S3.*
1. [ ] **S1 Parser** (S1.1, S1.4, S4.1 to S4.3). `src/spec.ts` and `test:spec`: parse, status rewrite, round trip, golden test over every file in `docs/sdd/`. *Checkpoint: review the parsed output for each spec.*
2. [ ] **S2 `/spec` list and detail** (S1.2, S1.3, S6.1, S6.3). Command, buttons, README row, `.env.example`. No running yet. *Checkpoint: browse the specs in Telegram.*
3. [ ] **S3 Prompt builder** (S2.2, S2.3). Pure function with unit tests, including the size cap. *Checkpoint: read the prompt built for three real tasks.*
4. [ ] **S4 Run** (S2.1, S2.4 to S2.6, S6.2). Spawn on `spec/<name>`, one running task per spec, audit events. *Checkpoint: run a trivial task end to end.*
5. [ ] **S5 Checkpoint card** (S3.1 to S3.3, S3.7). Built from recorded results. *Checkpoint: read a card for a passing run and a failing run.*
6. [ ] **S6 Accept, Redo, Stop** (S3.4 to S3.6, S4.4). *Checkpoint: accept one task and check the spec file diff is only a marker and a hash.*
7. [ ] **S7 Pull request** (S5.1 to S5.5). Draft PR, body update, ready button, post-merge cleanup offer. *Checkpoint: open a draft PR for a throwaway spec.*
8. [ ] **S8 End to end.** One extra scenario in `npm run smoke`: run a one-task spec, accept it. Smoke is the last step, as in `AGENTS.md`; restart the service afterwards.

Verification order for every task: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end.

## 6. Out of scope
- `/spec new` and writing specs from Telegram.
- Parallel tasks, auto-run of the next task, scheduled runs.
- Editing requirements or design from this flow.
- Merging PRs.
- Specs outside `docs/sdd/`.

## 7. Findings (filled in by task S0)
_Empty until S0 is done._
