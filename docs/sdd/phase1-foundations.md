# Spec: Phase 1 Foundations (doc-sync, /health, audit log, token storage)

- **Status:** Draft, awaiting review (no code written)
- **Date:** 2026-11-10
- **Scope:** `opencode-telegram-bot`
- **Format:** requirements (EARS) -> design -> tasks, with a human checkpoint after each task

## 1. Problem

The bot has many background subsystems but no single place to see their health,
no record of what was run on the host, a README that lags the code, and a bot
token stored in plaintext. Each gap is small; together they limit trust and make
regressions hard to spot.

## 2. Requirements (EARS)

### R1 Doc-sync
- R1.1 When `npm run test:unit` runs, the system shall fail if any command in `src/commands.ts` is missing from the README command table.
- R1.2 When `npm run test:unit` runs, the system shall fail if any `OPENCODE_TG_*` variable read in `src/config.ts` is missing from the README config table.
- R1.3 The failure message shall name each missing item.

### R2 /health
- R2.1 When an authorized user sends `/health`, the system shall reply with one status line per subsystem: OpenCode connection, MCP bridge, scheduler, PR-watch, advisor, uptime monitor, DNS heal.
- R2.2 Each line shall show OK / WARN / FAIL and the time of the last successful activity.
- R2.3 If a subsystem is disabled by config, the system shall show it as "off", not FAIL.
- R2.4 `/health` shall be read-only and shall not trigger any subsystem action.
- R2.5 The reply shall follow the user's language preference (vi / en).

### R3 Audit log
- R3.1 When a prompt is accepted, a worker is spawned, or a dispatch is approved or rejected, the system shall append one JSON line to `data/audit.log`.
- R3.2 Each entry shall contain: timestamp, user id, chat id, action, session/worker id, directory, outcome.
- R3.3 The system shall redact secrets (reuse `src/redact.ts`) and shall truncate prompt text to a fixed length.
- R3.4 The log shall be append-only, created with mode `0o600`, and rotated at a size limit.
- R3.5 If writing the log fails, the bot shall keep working and log a warning.

### R4 Token storage
- R4.1 Where a Keychain item is configured, the system shall read the bot token from the macOS Keychain.
- R4.2 Otherwise the system shall fall back to the current `.env` behavior, unchanged.
- R4.3 The token shall never appear in logs, `/health`, or the audit log.

## 3. Design

| Item | Approach |
|---|---|
| R1 | New `scripts/test-doc-sync.ts` reads `src/commands.ts` (already the single source of truth for the command surface) and `src/config.ts`, then greps `README.md`. Added to the `test:unit` chain. |
| R2 | New `src/health.ts` exposing `collectHealth()`. Each subsystem registers a tiny `lastOk` timestamp getter, so no new polling. Rendered through the existing i18n helpers. The command is added to `src/commands.ts` so menu, help and grid update together. |
| R3 | New `src/audit.ts` with `audit(event)`. Call sites are few: prompt accept, spawn, dispatch approve/reject. Writes are fire-and-forget with a swallowed, logged error. |
| R4 | `src/config.ts` gains an optional `OPENCODE_TG_TOKEN_KEYCHAIN` item name. Reading uses `security find-generic-password` via `execFile` (no shell). The systemd deployment keeps `.env`, since Keychain is macOS-only. |

### Risks and open questions
- The bot runs under a **systemd user service** (per `AGENTS.md`), which is Linux. Keychain only helps when running on macOS. Confirm where production runs; if Linux, replace R4 with a systemd credential file (`LoadCredential=`) instead.
- R1.2 may flag variables that are intentionally undocumented. Allow an explicit ignore list.
- Audit log may capture sensitive prompt text. Truncation plus redaction mitigates, but confirm acceptable retention.

## 4. Tasks (each ends with a human checkpoint)

1. **T1 Doc-sync test** (R1). Add the test; fix the README drift it reveals. Verify: it fails before the README fix and passes after. *Checkpoint: review README diff.*
2. **T2 Audit module** (R3). Add `src/audit.ts` with a unit test for redaction, truncation, rotation and write-failure. *Checkpoint: review the entry schema.*
3. **T3 Audit wiring** (R3). Add the call sites. Verify with an existing flow test. *Checkpoint: review a sample log.*
4. **T4 Health collector** (R2). Add `src/health.ts` and unit tests with fake subsystems, including the "off" case. *Checkpoint: review output wording.*
5. **T5 /health command** (R2). Register in the catalog and wire the handler; extend `test:commands` and `test:i18n`. *Checkpoint: try it in Telegram.*
6. **T6 Token source** (R4). Decide macOS vs Linux first, then implement. *Checkpoint: confirm deployment target.*

Verification order for every task, per `AGENTS.md`: `npm run typecheck` and `npm run test:unit` first, `npm run smoke` once at the end. After editing `src/`, restart the service with `systemctl --user restart opencode-bot`.

## 5. Out of scope
Splitting `bot.ts`, per-repo memory, plan-then-approve dispatch, cost footer. These get their own specs.
