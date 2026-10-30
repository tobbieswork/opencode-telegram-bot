/**
 * Hub-side client for the Claude advisor daemon (advisor-daemon/advisor.ts),
 * reached over Tailscale. Pure HTTP — no side effects — so it's unit-testable
 * against a fake server. The daemon is a black box: it runs `claude -p` /
 * `claude --resume` and returns {answer, sessionId, cost, tokens, ms}.
 *
 * Failure model: AdvisorError with a `kind` so the caller can phrase a
 * user-facing message:
 *   - "offline"  → the Mac/daemon is unreachable (network / Mac asleep)
 *   - "http"     → the daemon answered with a non-2xx (auth, bad request, …)
 *   - "parse"    → the daemon answered but the body was not what we expected
 */

export interface AdvisorEndpoint {
  url: string;
  token: string;
}

export interface AdvisorAnswer {
  answer: string;
  status: string;
  sessionId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  incomplete: boolean;
}

export class AdvisorError extends Error {
  kind: "offline" | "http" | "parse";
  constructor(kind: AdvisorError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

async function call(
  ep: AdvisorEndpoint,
  path: string,
  init: { method: string; body?: string },
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    res = await fetch(`${ep.url}${path}`, {
      method: init.method,
      body: init.body,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ep.token}`,
      },
    });
    clearTimeout(t);
  } catch (e) {
    throw new AdvisorError("offline", `không tới được advisor (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AdvisorError("http", `advisor trả ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new AdvisorError("parse", `phản hồi advisor không phải JSON (${String(e).slice(0, 120)})`);
  }
}

/** One advisor exchange. Pass `sessionId` to continue an existing thread. */
export async function askClaude(
  ep: AdvisorEndpoint,
  req: { sessionId?: string; message: string; context?: string; maxTurns?: number },
  timeoutMs = 5 * 60 * 1000,
): Promise<AdvisorAnswer> {
  const body: Record<string, unknown> = { message: req.message };
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
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
    tokensIn: typeof raw.tokensIn === "number" ? raw.tokensIn : 0,
    tokensOut: typeof raw.tokensOut === "number" ? raw.tokensOut : 0,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
    incomplete: raw.incomplete === true,
  };
}

/** Ask the Mac to forget a session (called on /prune). Best-effort. */
export async function forgetClaude(ep: AdvisorEndpoint, sessionId: string, timeoutMs = 10_000): Promise<void> {
  await call(ep, "/forget", { method: "POST", body: JSON.stringify({ sessionId }) }, timeoutMs);
}

/** Liveness probe. Returns null when the daemon is unreachable. */
export async function advisorHealth(ep: AdvisorEndpoint, timeoutMs = 5_000): Promise<{ ok: boolean; sessions: number } | null> {
  try {
    const raw = (await call(ep, "/health", { method: "GET" }, timeoutMs)) as Record<string, unknown>;
    return { ok: raw.ok === true, sessions: typeof raw.sessions === "number" ? raw.sessions : 0 };
  } catch {
    return null;
  }
}
