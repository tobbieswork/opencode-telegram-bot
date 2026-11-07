# Zero-Context-Cost Worker Pipeline

**Status:** Proposed · **Date:** 2026-11-07

## 1. Background

Worker sessions die from context overflow on multi-step tasks. A typical
"read 10 files → extract → transform → write" task costs ~10 LLM turns, each
accumulating the full conversation history into the 160K-token window. Under
heavy work, worker sessions grow 100–570K tok/h; a single 20-step task can
cross the window before completion, triggering a litellm 400 that permanently
kills the session (follow-ups just 400 again — the session is unusable).

Current mitigation is reactive: worktree isolation (`src/worktree.ts`)
prevents file conflicts between parallel workers, and the orchestrator can
respawn a fresh worker when one dies. Neither prevents the overflow.

The insight (from Hermes Agent): **scripts call tools via RPC for
zero-context-cost turns.** If the worker writes one short script that invokes
tools over a local endpoint, the intermediate tool I/O never enters the LLM's
context — only the final result does.

## 2. Goals / Non-Goals

**Goals**

- Reduce multi-step task context cost from N turns to 1 turn
- Eliminate context overflow deaths on large feature tasks
- Reuse the existing MCP bridge pattern (`src/mcp-bridge.ts`) as the RPC transport
- Keep the sandbox simple: Node `worker_threads`, not a container

**Non-Goals**

- Not a general-purpose workflow engine (no DSL, no parallel/pipeline)
- Not replacing the LLM agent loop (LLM decides WHAT; script does HOW)
- Not exposing all 70+ OpenCode tools (only a safe subset)
- Not a security boundary (convenience, not a trust boundary)

## 3. Design

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Worker session (LLM)                                            │
│                                                                  │
│  1. LLM writes a script ──────────► runner.ts                    │
│  2. runner spawns worker_thread ──► script runs in isolation     │
│  3. script calls rpc("read",{path}) ──► rpc-server.ts            │
│  4. rpc-server validates + executes ──► result back to script    │
│  5. script returns final result ──► LLM sees ONE turn            │
└──────────────────────────────────────────────────────────────────┘
```

**RPC endpoint** — `src/sandbox/rpc-server.ts`, a new `ToolRpc` class
reusing the `McpBridge` pattern from `src/mcp-bridge.ts`:

- Binds to `127.0.0.1` with a per-run bearer token
  (same approach as `McpBridge.token`, `src/mcp-bridge.ts:29`)
- Exposes a whitelist of tools via plain HTTP POST JSON — simpler than
  full MCP JSON-RPC since the client is our own script, not an MCP client
- Tool execution delegates to the same OpenCode tool functions the worker
  would call natively

**Script sandbox** — `src/sandbox/runner.ts`, using Node `worker_threads`:

- Script runs in a worker thread with only
  `rpc(tool: string, params: object): Promise<string>` injected
- No `require`, no `process`, no `fs`, no network
- 60s hard timeout, 256MB memory cap (`resourceLimits`)
- Returns `{ result: string, error?: string, durationMs: number }`

**Script format** (what the LLM writes — pseudo-code, not implementation):

```js
// Runs in a worker thread. Only rpc() is available.
const files = ["a.ts", "b.ts", "c.ts"];
let names = [];
for (const f of files) {
  const content = await rpc("read", { path: f });
  const m = content.match(/export\s+function\s+(\w+)/);
  if (m) names.push(m[1]);
}
return names.join(", ");
```

**Worker integration** — a new instruction block appended to the worker
preamble (`src/orchestrator.ts:75–82`):

> "For tasks with 5+ sequential tool steps, write a script using `rpc()`
> instead of calling tools one-by-one. The script runs in a sandbox with a
> 60s timeout. Return only the final result."

### Safety

| Concern | Mitigation |
|---|---|
| Tool allowlist | `read`, `write` (worktree-only), `grep`, `glob`, `bash` (worktree-only, no shell metacharacters) — full native set in `src/activity.ts:22–44` |
| Sandboxing | `worker_threads` with no host globals; 60s timeout; 256MB `resourceLimits` |
| Path restriction | All file ops confined to the worker's worktree directory (validated in `allowlist.ts`) |
| No network | Script has no `fetch`, no `http`, no DNS — the only external call is `rpc()` |
| No self-replication | Script cannot spawn workers, cannot access the MCP bridge directly |
| Not a trust boundary | Runs with the same OS permissions as the worker process; allowlist is a convenience guard |

### File layout (proposed)

```
src/sandbox/
  runner.ts        — worker_threads sandbox: runScript(code, worktree, allowlist)
  rpc-server.ts    — HTTP endpoint the script's rpc() calls (localhost, token-gated)
  allowlist.ts     — tool whitelist + path validation
src/orchestrator/
  scriptPreamble.ts — instruction block injected into worker system prompt
scripts/
  test-sandbox.ts  — unit tests
```

## 4. Slices

| Slice | Task | Verify |
|---|---|---|
| 1 | RPC endpoint (`rpc-server.ts` + `allowlist.ts`) | Unit test: call endpoint → tool executes; non-whitelisted tool rejected; path escape blocked |
| 2 | Script sandbox (`runner.ts`) | Unit test: script calls `rpc()` 5× → correct result; 60s timeout kills hanging script; no `require`/`process` access |
| 3 | Worker integration (`scriptPreamble.ts` + orchestrator wiring) | Integration: spawn worker with "read 5 files, extract names, write summary" → verify it uses the script path (1 turn), not 5+ tool turns |

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Script infinite loop / memory blowup | Medium | 60s timeout + 256MB `resourceLimits` |
| Path escape outside worktree | Low | `allowlist.ts` validates every path against the worktree root |
| Script writes to wrong file | Low | Worktree isolation (same as current worker file access) |
| Script becomes a security hole | Low | Not a trust boundary; runs with worker process permissions |

## 6. Alternatives Considered

| Option | Why not |
|---|---|
| Increase context window (200K model) | Treats symptom, not cause; cost increases; still overflows on 20+ step tasks |
| Full Hermes-style RPC (Python scripts) | Wrong language for this Node.js codebase; adds Python dependency |
| Full workflow DSL (Omegacode-style) | Overkill; we need "one script per task", not a visual workflow builder |
| More aggressive compaction | Compaction loses intermediate context; the script approach preserves the LLM's attention on the final result, not the steps |

## References

- `src/mcp-bridge.ts` — `McpBridge` class, bearer-token auth (line 29), JSON-RPC 2.0 dispatch
- `src/orchestrator.ts:75–82` — `workerPreamble()` (where the script instruction block will be added)
- `src/orchestrator.ts:607` — worker agent selection (`build`/`plan`/`explore`/`general`)
- `src/activity.ts:22–44` — native tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`
- `src/worktree.ts` — git worktree isolation (existing)
- `advisor-daemon/agents/claude.ts:26` — precedent for tool allowlists (`["Read","Grep","Glob"]`)
