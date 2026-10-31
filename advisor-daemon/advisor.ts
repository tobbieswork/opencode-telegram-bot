/**
 * Advisor daemon — runs on the machine that has the agent CLIs (a Mac or a
 * Linux box), reachable from the hub over Tailscale. The hub POSTs
 * /ask {agent?, sessionId?, message, context?}; we run that agent headless
 * (new session, or resume `sessionId`) in a neutral work dir and return
 * {answer, sessionId, cost, tokens, ms}.
 *
 * Agents (ADVISOR_AGENTS, e.g. "claude,agy"): see agents/. Every adapter is
 * read-only — the model answers from the context the caller provides and
 * never edits files or runs commands.
 *
 * Security:
 *  - bearer token (ADVISOR_TOKEN), compared in constant time; fail closed
 *    when unset;
 *  - listens on ADVISOR_HOST, default 127.0.0.1 — the installer sets the
 *    Tailscale IP, so the port is never open on a café Wi-Fi;
 *  - request body capped (MAX_BODY) and session ids validated before they
 *    reach an argv or a file name.
 *
 * ONE run per agent at a time (per-agent lock) so a resume can never race.
 * Sessions are tracked on disk and pruned after ADVISOR_TTL_MS idle; /forget
 * drops one immediately (the hub calls it on /prune). GET /exists?sessionId=
 * reports whether the agent's store still has a session — the hub checks it
 * before resuming, since a TTL-pruned Claude session would otherwise be
 * resumed blindly (fresh session or stuck error, CLI-version dependent).
 *
 * Env names: ADVISOR_*; the older MAC_ADVISOR_* names still work.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeAdapter } from "./agents/claude.js";
import { agyAdapter } from "./agents/agy.js";
import type { AgentAdapter, AgentResult } from "./agents/types.js";
import { AGENT_IDS, AGENTS, LEGACY_AGENT, isValidSessionId, resolveAgent, type AgentId } from "../src/advisor/agents.js";

/** ADVISOR_<name>, falling back to the pre-rename MAC_ADVISOR_<name>. */
function env(name: string): string {
  return (process.env[`ADVISOR_${name}`] ?? process.env[`MAC_ADVISOR_${name}`] ?? "").trim();
}

const PORT = Number(env("PORT") || "8391");
const HOST = env("HOST") || "127.0.0.1";
const TOKEN = env("TOKEN");
const WORKROOT = env("WORKROOT") || path.join(os.homedir(), "mac-advisor");
const WORK = path.join(WORKROOT, "work");
const REGISTRY = path.join(WORKROOT, "sessions.json");
const LOG_PATH = path.join(WORKROOT, "logs", "advisor.log");
const MAX_TURNS = Number(env("MAX_TURNS") || "8");
const TURN_TIMEOUT_MS = Number(env("TURN_TIMEOUT_MS") || String(5 * 60 * 1000));
const TTL_MS = Number(env("TTL_MS") || String(24 * 3600 * 1000));
/** Request bodies above this are refused (also keeps agy's argv prompt small). */
const MAX_BODY = 256 * 1024;

function log(line: string): void {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, msg);
  } catch {}
  process.stdout.write(msg);
}

class HttpError extends Error {
  code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

// -- agents ------------------------------------------------------------------
/** Parse ADVISOR_AGENTS; unknown names are a startup error (fail loudly). */
function loadAdapters(): Map<AgentId, AgentAdapter> {
  const words = (env("AGENTS") || "claude").split(",").map((w) => w.trim()).filter(Boolean);
  const adapters = new Map<AgentId, AgentAdapter>();
  for (const w of words) {
    const id = resolveAgent(w);
    if (!id) throw new Error(`ADVISOR_AGENTS: agent "${w}" không hỗ trợ (có: ${AGENT_IDS.join(", ")})`);
    if (adapters.has(id)) continue;
    adapters.set(id, id === "claude" ? claudeAdapter(env("CLAUDE_BIN") || "claude") : agyAdapter(env("AGY_BIN") || "agy"));
  }
  if (!adapters.size) throw new Error("ADVISOR_AGENTS rỗng");
  return adapters;
}
const ADAPTERS = loadAdapters();
/** The first configured agent answers when a request names none. */
const DEFAULT_AGENT = [...ADAPTERS.keys()][0];

/**
 * Which agent serves a request: the one it names, else the one that owns the
 * session (registry), else the default. Naming a disabled agent is a 400.
 */
function pickAgent(requested: unknown, sessionId?: string): AgentAdapter {
  let id: AgentId;
  if (typeof requested === "string" && requested.trim()) {
    const named = resolveAgent(requested);
    if (!named) throw new HttpError(400, `agent "${requested}" không hỗ trợ (có: ${AGENT_IDS.join(", ")})`);
    id = named;
  } else {
    const entry = sessionId ? registry[sessionId] : undefined;
    id = entry ? (entry.agent ?? LEGACY_AGENT) : DEFAULT_AGENT;
  }
  const a = ADAPTERS.get(id);
  if (!a) throw new HttpError(400, `${AGENTS[id].label} chưa bật trên daemon này (ADVISOR_AGENTS=${[...ADAPTERS.keys()].join(",")})`);
  return a;
}

// -- session registry (for TTL + /forget) -----------------------------------
interface Tracked {
  /** Missing on entries written before agents existed — those are Claude's. */
  agent?: AgentId;
  lastActive: number;
  turns: number;
}
let registry: Record<string, Tracked> = {};
function loadRegistry(): void {
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    registry = {};
  }
}
function saveRegistry(): void {
  try {
    fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));
  } catch (e) {
    log(`registry save failed: ${e}`);
  }
}

// -- per-agent lock: one run per agent at a time (avoids resume races) -------
const locks = new Map<AgentId, Promise<unknown>>();
function withLock<T>(agent: AgentId, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(agent) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(agent, run.catch(() => {}));
  return run;
}

// -- HTTP helpers ------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.removeAllListeners("data");
        req.resume(); // drain the rest so the 413 can be sent
        reject(new HttpError(413, `body quá lớn (tối đa ${MAX_BODY / 1024} KB)`));
        return;
      }
      s += c;
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return false; // fail closed when no token is configured
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "body phải là JSON");
  }
}
function sessionIdOf(raw: unknown): string | undefined {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return undefined;
  if (!isValidSessionId(id)) throw new HttpError(400, "sessionId không hợp lệ");
  return id;
}

async function handleAsk(body: string): Promise<Record<string, unknown>> {
  const q = parseJson<{ agent?: string; sessionId?: string; message?: string; context?: string; maxTurns?: number }>(body);
  const message = typeof q.message === "string" ? q.message.trim() : "";
  if (!message) throw new HttpError(400, "thiếu 'message'");
  const context = typeof q.context === "string" ? q.context.trim() : "";
  const maxTurns = Number.isInteger(q.maxTurns) && q.maxTurns! > 0 ? q.maxTurns! : MAX_TURNS;
  const resume = sessionIdOf(q.sessionId);
  const adapter = pickAgent(q.agent, resume);

  // The hub already localizes the question; we just frame it as advice.
  const prompt = context
    ? `Đang cố vấn cho một quyết định kỹ thuật. Ngữ cảnh:\n\n${context}\n\nCâu hỏi:\n${message}\n\nTrả lời ngắn gọn, tập trung vào câu hỏi.`
    : message;

  const r: AgentResult = await withLock(adapter.id, () =>
    adapter.run({
      workdir: WORK,
      prompt,
      maxTurns,
      timeoutMs: TURN_TIMEOUT_MS,
      resumeSessionId: resume,
      log: (l) => log(`[${adapter.id}] ${l}`),
    }),
  );

  if (r.sessionId) {
    const t = registry[r.sessionId] ?? { agent: adapter.id, lastActive: 0, turns: 0 };
    t.agent = adapter.id;
    t.lastActive = Date.now();
    t.turns += 1;
    registry[r.sessionId] = t;
    saveRegistry();
  }

  return {
    answer: r.report,
    status: r.status,
    agent: adapter.id,
    sessionId: r.sessionId,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
    incomplete: r.incomplete,
  };
}

function handleExists(url: URL): Record<string, unknown> {
  const id = sessionIdOf(url.searchParams.get("sessionId"));
  if (!id) throw new HttpError(400, "thiếu 'sessionId'");
  const adapter = pickAgent(url.searchParams.get("agent"), id);
  return { exists: adapter.exists(id) };
}

function handleForget(body: string): Record<string, unknown> {
  const q = parseJson<{ agent?: string; sessionId?: string }>(body);
  const id = sessionIdOf(q.sessionId);
  if (!id) throw new HttpError(400, "thiếu 'sessionId'");
  const adapter = pickAgent(q.agent, id);
  const deleted = adapter.forget(id);
  delete registry[id];
  saveRegistry();
  log(`forget ${adapter.id}/${id} (session deleted: ${deleted})`);
  return { ok: true, deleted };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, agents: [...ADAPTERS.keys()], sessions: Object.keys(registry).length });
    }
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && url.pathname === "/ask") {
      return send(res, 200, await handleAsk(await readBody(req)));
    }
    if (req.method === "GET" && url.pathname === "/exists") {
      return send(res, 200, handleExists(url));
    }
    if (req.method === "POST" && url.pathname === "/forget") {
      return send(res, 200, handleForget(await readBody(req)));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    const msg = e instanceof Error ? e.message : String(e);
    log(`HTTP ${code}: ${msg}`);
    return send(res, code, { error: msg });
  }
});

// Idle TTL: drop sessions not used in TTL_MS.
function sweep(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of Object.entries(registry)) {
    if (now - t.lastActive > TTL_MS) {
      const adapter = ADAPTERS.get(t.agent ?? LEGACY_AGENT);
      if (adapter && isValidSessionId(id) && adapter.forget(id)) log(`ttl-prune ${adapter.id}/${id}`);
      delete registry[id];
      changed = true;
    }
  }
  if (changed) saveRegistry();
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
loadRegistry();
server.listen(PORT, HOST, () => {
  const agents = [...ADAPTERS.values()].map((a) => `${a.id}=${a.bin}`).join(", ");
  log(`advisor daemon started (port ${PORT}/${HOST}, work ${WORK}, agents ${agents}, ttl ${Math.round(TTL_MS / 3600000)}h)`);
  if (!TOKEN) log("⚠ ADVISOR_TOKEN không được set — /ask & /forget sẽ từ chối tất cả");
  if (HOST === "0.0.0.0" || HOST === "::") log("⚠ đang nghe trên MỌI interface — đặt ADVISOR_HOST=<IP Tailscale> để chỉ tailnet vào được");
});
const sweeper = setInterval(sweep, 30 * 60 * 1000);
sweeper.unref?.();
