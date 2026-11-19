# Data flow: what leaves this machine, and where

- **Status:** T4 of `docs/sdd/scale-hardening.md` — one-pager
- **Date:** 2026-11-19
- **Related:** `src/redact.ts` (the guard), `src/advisor/` (advisor path), `advisor-daemon/README.md`

The LLM endpoint is **deployment-specific** (each host points OpenCode at
its own provider) and is *not* a fact of this repo. This doc describes the
flow generically and states, for each outbound path: what is sent, what is
not, and where the guard (`redactSecrets`) does and does not run.

Three outbound paths exist.

## 1. Main LLM path (bot → OpenCode → model)

```
Telegram (user text, worker prompts)
  → opencode-bot (systemd user service, this repo)
  → OpenCode service (local `opencode serve`, @opencode/client)
  → the host's LLM provider endpoint (deployment-specific)
  → model
```

**Sent to the endpoint:**
- The prompt: the user's Telegram text, or a built spec/worker prompt
  (`src/spec-prompt.ts`, size-capped at 6000 chars), plus the session history.
- Anything the agent reads while working: repo file contents, tool outputs,
  command output — file reads in the worktree become model context and are
  transmitted to the endpoint with it.

**Not sent:** bot-internal state (`data/state.json`), the audit log, the
systemd journal, and Telegram metadata (chat ids, user ids) — these never
enter an OpenCode session. What is sent is exactly what the agent works on.

**Config:** the endpoint lives outside this repo — the provider's `baseURL`
+ model in the host's `~/.config/opencode/opencode.jsonc` (one per
deployment). The bot's own `OPENCODE_SERVICE_URL` points at the *local*
OpenCode service, not at the LLM endpoint.

## 2. Redaction scope — and the prompt gap

`redactSecrets` (`src/redact.ts:46`) is a pure, always-on, deterministic
filter: it replaces known secret formats (GitHub PATs, Telegram bot tokens,
`sk-`/`sk-ant-` keys, AWS/Slack/Google keys, JWTs, private-key blocks) with
a first4…last4 fingerprint. Everything else passes through byte-identical.

**Where it runs (all outbound Telegram surfaces + on-disk traces):**
- Every send/edit/draft of message text and rich markdown (`src/telegram.ts`)
- Free-text fields of audit events (`src/audit.ts`)
- Worker report files written to disk (`src/bot.ts`)

**The explicit gap — read this:** redaction does **not** run on the prompt
sent to the LLM. A secret that exists in a repo file (or in command output)
reaches the LLM endpoint **intact** the moment the agent reads it — the
guard only sees text flowing back *out* to Telegram. This is intrinsic to a
coding agent (the model must see file contents to edit them) and not a
missed guard; it is listed here so the trust boundary is known: **the LLM
endpoint is a trusted party with full repo visibility**, including any
secret checked in or left in the worktree. This applies to *whatever*
endpoint a deployment configures — the trust decision is per-deployment, so
it belongs in that deployment's notes, not in this repo.

## 3. Advisor path (read-only second opinion)

```
/ask [claude|gemini] <question>   (Telegram) — or the manager's `consult` tool
  → hub: POST /ask {agent, sessionId?, message, context?}
       (bearer token, over Tailscale — no port exposed to the internet)
  → advisor daemon on the other machine:
       claude  → `claude -p`, plan mode + Read/Grep/Glob only
       gemini  → `agy --print`, plan mode + sandbox
  → {answer, sessionId, cost, tokens} → hub → dedicated "🧠 …" topic
```

The advisor agent **consults only**: it answers from the context sent to it;
it does not edit files and does not run commands. Off by default; enabled
only when both `ADVISOR_URL` and `ADVISOR_TOKEN` are set. Note: whatever
context is included in `/ask` follows this path to the *other* machine's
model (Claude/Gemini) — the same "context = what is sent" rule applies.

## 4. Per-deployment facts (not in this repo)

The LLM endpoint's **operator**, **access route**, and **log-retention
policy** are properties of a *specific deployment*, not of this codebase.
They are deliberately not recorded here (the repo is generic; a single
endpoint would be a false invariant for every other deployment). Record
them in the deployment that uses this bot, not in `docs/`.
