/**
 * Hub-side client for the advisor daemon (advisor-daemon/advisor.ts), reached
 * over Tailscale. Pure HTTP — no side effects — so it's unit-testable against
 * a fake server. The daemon is a black box: it runs the requested agent
 * (Claude, Gemini/agy) headless and returns {answer, sessionId, cost, tokens, ms}.
 *
 * Failure model: AdvisorError with a `kind` so the caller can phrase a
 * user-facing message:
 *   - "offline"  → the daemon is unreachable (network / machine asleep)
 *   - "timeout"  → reached, but no answer in time (the agent may still be running)
 *   - "http"     → the daemon answered with a non-2xx (auth, bad request, …)
 *   - "parse"    → the daemon answered but the body was not what we expected
 */
import type { AgentId } from "./agents.js";

export interface AdvisorEndpoint {
  url: string;
  token: string;
}

export interface AdvisorAnswer {
  answer: string;
  status: string;
  /** The agent that answered ("" when an older daemon did not say). */
  agent: string;
  sessionId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  incomplete: boolean;
}

export class AdvisorError extends Error {
  kind: "offline" | "timeout" | "http" | "parse";
  constructor(kind: AdvisorError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * How long one /ask may take. The daemon stops an agent turn after 5 minutes,
 * and a request can first wait behind another turn of the same agent — so the
 * hub waits longer than both, and a slow answer is not mistaken for "offline".
 */
export const ASK_TIMEOUT_MS = 11 * 60 * 1000;

async function call(
  ep: AdvisorEndpoint,
  path: string,
  init: { method: string; body?: string },
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    res = await fetch(`${ep.url}${path}`, {
      method: init.method,
      body: init.body,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ep.token}`,
      },
    });
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new AdvisorError("timeout", `advisor chưa trả lời sau ${Math.round(timeoutMs / 1000)}s (có thể vẫn đang chạy)`);
    }
    throw new AdvisorError("offline", `không tới được advisor (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = String((JSON.parse(text) as { error?: unknown }).error ?? text);
    } catch {}
    throw new AdvisorError("http", `advisor trả ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new AdvisorError("parse", `phản hồi advisor không phải JSON (${String(e).slice(0, 120)})`);
  }
}

/** One advisor exchange. Pass `sessionId` to continue an existing thread. */
export async function askAdvisor(
  ep: AdvisorEndpoint,
  req: { agent?: AgentId; sessionId?: string; message: string; context?: string; maxTurns?: number },
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<AdvisorAnswer> {
  const body: Record<string, unknown> = { message: req.message };
  if (req.agent) body.agent = req.agent;
  if (req.sessionId) body.sessionId = req.sessionId;
  if (req.context) body.context = req.context;
  if (req.maxTurns) body.maxTurns = req.maxTurns;
  const raw = (await call(ep, "/ask", { method: "POST", body: JSON.stringify(body) }, timeoutMs)) as Record<string, unknown>;
  if (typeof raw.answer !== "string" || typeof raw.status !== "string") {
    throw new AdvisorError("parse", "phản hồi /ask thiếu trường answer/status");
  }
  return {
    answer: raw.answer,
    status: raw.status,
    agent: typeof raw.agent === "string" ? raw.agent : "",
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
    tokensIn: typeof raw.tokensIn === "number" ? raw.tokensIn : 0,
    tokensOut: typeof raw.tokensOut === "number" ? raw.tokensOut : 0,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
    incomplete: raw.incomplete === true,
  };
}

/** Ask the daemon to forget a session (called on /prune). Best-effort. */
export async function forgetAdvisor(ep: AdvisorEndpoint, agent: AgentId, sessionId: string, timeoutMs = 10_000): Promise<void> {
  await call(ep, "/forget", { method: "POST", body: JSON.stringify({ agent, sessionId }) }, timeoutMs);
}

/** Liveness probe. Returns null when the daemon is unreachable. */
export async function advisorHealth(
  ep: AdvisorEndpoint,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; sessions: number; agents: string[] } | null> {
  try {
    const raw = (await call(ep, "/health", { method: "GET" }, timeoutMs)) as Record<string, unknown>;
    return {
      ok: raw.ok === true,
      sessions: typeof raw.sessions === "number" ? raw.sessions : 0,
      // A daemon from before agents existed ran Claude only.
      agents: Array.isArray(raw.agents) ? raw.agents.map(String) : ["claude"],
    };
  } catch {
    return null;
  }
}
