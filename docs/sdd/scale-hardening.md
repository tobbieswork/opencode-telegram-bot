# Spec: Scale hardening — data SPOF, hidden dependencies, observability

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-19
- **Scope:** `opencode-telegram-bot`
- **Format:** problem -> design -> tasks, human checkpoint after each task
- **Builds on:** `src/audit.ts` (`rotateIfNeeded`), `src/health-probes.ts` (`buildProbes`), `deploy/bot-watchdog.{timer,service}` (systemd pattern)
- **Source:** `docs/research/bot-scale-and-risks.md` (scale assessment 2026-11-19) — this spec is its §4 roadmap items 1–5, scoped to the *"do now, <1 day each"* set. The mid/long-term items live in the **Watchlist** below (act only on signal).

## 1. Problem

The report's core finding: **the machine is not the ceiling — a single owner is — and the
number-1 *technical* risk is a cheap-to-fix data SPOF.** Concretely:

1. **`data/` has no automatic off-machine backup.** `state.json` (485 KB) is the
   conversation↔session map; the whole `data/` is 18 MB. Atomic write + corrupt-backup exist
   (`src/state.ts:360-372`) but there is no off-box copy. File death or disk death = the bot
   restarts with an empty state map: every topic loses its session, the manager loses its place.
   Code is safe (GitHub); what is *not* safe is exactly this 18 MB.
2. **`audit.log` keeps only one generation.** `rotateIfNeeded` does
   `renameSync(path, path + ".1")`, which **overwrites** the previous generation
   (`src/audit.ts:81`). The forensic record of 74+ accepted spec tasks is silently lost on each
   rotation. For an automated spec pipeline, the audit log *is* the acceptance evidence.
3. **The biggest hidden dependency is unpinned.** The magic-context plugin loads
   `@cortexkit/opencode-magic-context@latest` at runtime (`~/.config/opencode/opencode.jsonc:164`)
   — a version outside `package-lock.json` that can change compaction/memory behaviour between
   restarts with no changelog in this repo.
4. **Disk growth and data flow are invisible.** Nothing reports the size of `~/.opencode`
   (711 MB and growing) or `data/`, and there is no one-page record of where code/prompts/secrets
   flow (endpoint `code-agent.cads.live`) or who operates it.

## 2. Goals and non-goals

**Goals**
- Automatic nightly off-machine backup of `data/` with a tested restore path (kills risks #2, #3, #11 of the report at once).
- Preserve the audit log across rotations as dated archives with bounded retention.
- Surface disk usage of `~/.opencode`, `data/`, and free space on `/health`.
- A one-page `data-flow.md` so the LLM/endpoint data path is documented, not folklore.

**Non-goals (explicitly over-engineering for a 1-owner system — do NOT do, per report §4/§5)**
- SQLite, HA / multi-active, Kubernetes, per-user RBAC or cost metering, OpenCode load balancing, microservicizing the bot.
- Worker sandboxing (container/namespace) — long-term, only if the bot starts running repos that are not the owner's, or after a real injection event.
- Multiple OpenCode servers — only if the single server measures >6–8 GB RSS or >8 concurrent workers become routine.
- The mid-term items in the **Watchlist** (handoff note, global outbox rate limiter, per-task token budget, risk-based accept gating) — each has a trigger condition; they are not "do now".

## 3. Design

### T1 — Nightly off-machine backup of `data/`

A committed, self-contained backup path plus a systemd user timer (mirrors the existing
`deploy/bot-watchdog.timer` pattern).

- New `deploy/backup-state.sh`:
  - Snapshots the durable state files: `state.json`, `users.json`, `schedules.json`,
    `rotation-health.json`, `audit.log`, and the small dirs `data/notes`, `data/manager`,
    `data/research`, `data/ai-improve`. **Excludes `data/uploads`** (ephemeral, TTL 7 days, up to 500 MB — regenerable, not worth off-box).
  - Ships the snapshot **off this machine** to a dedicated **private GitHub repo**
    (default `tobbieswork/opencode-bot-state-backup`), using the existing owner `gh` credential.
    Creates the repo if absent (`gh repo create --private`). Each run = one commit adding
    `state-<UTC-YYYYMMDD-HHMMSS>.tar.gz`; prunes old tarballs beyond **7** generations.
  - **Snapshots the bot's real `data/` dir** (fixed deploy path `/home/phatnd12/fpt/opencode-telegram-bot/data`, overridable via `DATA_DIR` env) — NOT a worktree-relative `data/` (which is gitignored/empty), so an end-to-end run from the worktree backs up the live state.
  - `set -euo pipefail`, logs to stderr, non-zero exit on failure. Header documents the **restore**
    procedure (extract tarball → drop into `data/` → `systemctl --user restart opencode-bot`).
- New `deploy/backup-state.service` + `deploy/backup-state.timer` (daily, `Persistent=true`).
- **Manual (one-time, not a worker step):** `systemctl --user daemon-reload && systemctl --user enable --now backup-state.timer`.
- **Decision (confirm before running):** the backup destination. Default = private GitHub repo
  (most self-contained, no new infra, same trust boundary as the code repo). Alternatives: an
  rsync remote or external disk — changes only the script's transport layer.
- Unit/integration: the script runs end-to-end once. Manager verifies: (a) the snapshot exists in
  the remote repo, (b) extracting it yields a `state.json` that parses as JSON, (c) generation
  pruning keeps ≤7.

### T2 — Archive `audit.log` before rotation

- In `rotateIfNeeded` (`src/audit.ts`), **before** `renameSync(path, path + ".1")`, copy the
  current log to a dated archive `data/audit-archive/audit.log.<YYYY-MM-DD>` (append `.1`, `.2`…
  if the date already exists, so a day with two rotations is not lost).
- Bounded retention: keep the **14** most recent archive files, delete older.
- Behaviour of `.1` is unchanged (current single-generation tail still available); this adds a
  durable, dated history on top.
- Unit tests: a rotation archives the pre-rotation content under a dated name and does not
  clobber an existing same-day archive; retention prunes the oldest beyond 14; an empty/missing
  log is a no-op.
- Checkpoint: tests green; force a rotation with a tiny `maxBytes` and confirm a dated archive
  file appears with the right content and the prior `.1` is preserved.

### T3 — `/health` disk probe

- Add a `disk` probe to `buildProbes` (`src/health-probes.ts`):
  - Reports sizes of `~/.opencode` and the bot `data/` dir, plus free space on `/`.
  - `ok` while free space on `/` is above a warn threshold (e.g. **<10% free → ok:false** with the
    numbers in `detail`). Sizes are informational in `detail`.
  - **No sudo, no network**: `du` + `df` only. A SMART check is **optional** — present only if
    `smartctl` is installed (it is not on this box); absent → skipped, never a failure.
- Wire the two paths into `HealthSources` (Bot fills them from the dirs it already knows) rather
  than hardcoding home.
- Unit tests: probe reports sizes; low free space → `ok:false`; `smartctl` absent → probe still
  `ok` (disk-size path) with no SMART line.
- Checkpoint: tests green; a live `/health` shows the disk line.

### T4 — Data-flow + endpoint-owner doc

- New `docs/data-flow.md`, one page:
  - The path: repo code + prompts + read file contents → `https://code-agent.cads.live/v1`
    (provider DC5, model `qwen/qwen3.8-27b`) → model. What is sent, what is **not** sent.
  - Where redaction applies: Telegram text + audit (`src/redact.ts:46`) — and the explicit gap:
    **redaction does NOT run on the prompt sent to the LLM** (a secret in a repo file reaches the
    endpoint intact — intrinsic to a coding agent, but must be known).
  - Advisor path: `/ask` → Tailscale → other machine, read-only.
  - **`[TODO]` sections for the owner to fill:** who operates the endpoint, and its log-retention
    policy. (The report cannot answer these from code.)
- Checkpoint: doc reviewed; owner fills the two `[TODO]` fields.

## 4. Manual ops (one-time, NOT spec worker tasks — no repo commit, so not pipeline-able)

- **Pin the magic-context plugin** (report risk #7): in `~/.config/opencode/opencode.jsonc`,
  change line 164 `@cortexkit/opencode-magic-context@latest` → `@cortexkit/opencode-magic-context@0.49.63`
  (the version `@latest` currently resolves to, 2026-11-19). Bump deliberately on future updates.
- **Enable the backup timer** (T1): `systemctl --user daemon-reload && systemctl --user enable --now backup-state.timer`.
- **(Optional) SMART visibility:** `sudo apt install smartmontools` to activate T3's optional SMART line.

## 5. Tasks

1. [x] (bc32011) **T1 State backup.** `deploy/backup-state.sh` + `deploy/backup-state.{service,timer}`: nightly snapshot of durable `data/` files to a private GitHub repo, 7-generation pruning, documented restore. *Checkpoint: one real run — snapshot present in the remote repo, extraction yields a parseable `state.json`, ≤7 generations kept. (Owner confirms the destination first.)*
2. [x] (9f265ea) **T2 Audit archive.** Dated `audit.log` archive before rotation in `src/audit.ts`, same-day collision-safe, 14-file retention. *Checkpoint: tests green + a forced rotation produces a dated archive with correct content.*
3. [x] (0eaccac) **T3 Health disk probe.** `disk` probe in `src/health-probes.ts`: sizes of `~/.opencode` + `data/`, free-space warn threshold, optional SMART, no sudo. *Checkpoint: tests green + a live `/health` shows the disk line.*
4. [ ] **T4 Data-flow doc.** `docs/data-flow.md` one-pager: LLM/endpoint path, redaction scope + the prompt gap, advisor path, `[TODO]` owner fields. *Checkpoint: doc reviewed + owner fills the two `[TODO]`s.*

## 6. Watchlist (mid/long-term — act only on signal; full detail in the research report §3/§4)

| Item | Trigger (act when…) | Early-warning signal | Cheap mitigation |
|---|---|---|---|
| Manager handoff note | manager re-asks already-settled decisions; rotation trend climbs | `data/rotation-health.json` floor trend; repeated questions | template in the manager prompt (S–M) |
| Global outbox rate limiter | 429s rise with 4+ workers streaming | scattered 429s in journal; edit-preview lag | token-bucket for all send/edit (M) |
| Per-task token budget | running 5+ workers for hours | token/task trending up via `/usage` | over-budget → worker stop + card (M) |
| Risk-based accept gating | backlog grows again → human accept bottleneck | avg card→accept time rising; `/auto` rate rising | class "safe" tasks (test/doc-only) auto-accept **with log** (M, do slowly — derive classes from the 74 accepted tasks) |
| Pin OpenCode binary version | smoke E2E fails after a bump | `opencode --version` (binary) ≠ client (node_modules) | drop caret, pin exact; smoke in CI with pinned binary |
| Release-pipeline watchdog | a release PR not auto-merged within 1 h | release PR sitting `action_required` | "no new tag in 14 days → Telegram ping" (2 h) |
| Machine-rebuild runbook | — (write once, use when the machine dies) | — | 1 page: Node pin, systemd, sudoers, state mapping (2 h) |
| Worker sandbox | bot starts running non-owner repos, or a real injection event | — | container/namespace (L) |
| Multiple OpenCode servers | single server >6–8 GB RSS, or >8 concurrent workers routine | `ps` RSS of `opencode serve` | per-server data dir + `OPENCODE_SERVICE_URL` mapping (M) |

> **Scale target (report §5):** 1 owner + 1–2 trusted people, 3–6 small repos, 4–6 workers, 1 machine.
> Beyond that (8+ workers, 5+ users, 30-min-gate big repos, multi-machine) — stop and re-ask whether
> it is needed, because every fix past that line is L and mostly over-engineering for this profile.
