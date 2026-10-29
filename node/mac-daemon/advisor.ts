/**
 * Claude advisor daemon — runs on the Mac, reachable from the hub over
 * Tailscale. The hub's manager POSTs /ask {sessionId?, message, context?};
 * we run `claude -p` (new thread) or `claude --resume <id>` (follow-up) in a
 * neutral work dir and return {answer, sessionId, cost, tokens, ms}.
 *
 * Pure advice (v1): the model answers from the context the caller provides —
 * it does not read a repo. Read-only permission profile (plan + Read/Grep/
 * Glob) so it can never edit or run commands.
 *
 * Security: requires a bearer token (MAC_ADVISOR_TOKEN) and listens only on
 * the address the tailnet reaches. ONE claude runs at a time (global lock) so
 * `--resume` can never race. Sessions are tracked on disk and pruned after
 * ADVISOR_TTL_MS idle; /forget drops one immediately (the hub calls it on
 * /prune).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runClaude, CLAUDE_ADVISOR_TOOLS, type ClaudeResult } from "./claude.js";

const PORT = Number(process.env.MAC_ADVISOR_PORT ?? "8391");
const HOST = process.env.MAC_ADVISOR_HOST?.trim() || "0.0.0.0";
const TOKEN = process.env.MAC_ADVISOR_TOKEN?.trim() ?? "";
const WORKROOT = process.env.MAC_ADVISOR_WORKROOT?.trim() || path.join(os.homedir(), "mac-advisor");
const WORK = path.join(WORKROOT, "work");
const REGISTRY = path.join(WORKROOT, "sessions.json");
const LOG_PATH = path.join(WORKROOT, "logs", "advisor.log");
// Reuse the node daemon's resolved claude path if present (it's the same box).
const CLAUDE_BIN =
  process.env.MAC_ADVISOR_CLAUDE_BIN?.trim() ||
  process.env.MAC_NODE_CLAUDE_BIN?.trim() ||
  "claude";
const MAX_TURNS = Number(process.env.MAC_ADVISOR_MAX_TURNS ?? "8");
const TURN_TIMEOUT_MS = Number(process.env.MAC_ADVISOR_TURN_TIMEOUT_MS ?? String(5 * 60 * 1000));
const TTL_MS = Number(process.env.MAC_ADVISOR_TTL_MS ?? String(24 * 3600 * 1000));
const CLAUDE_HOME = process.env.CLAUDE_HOME?.trim() || path.join(os.homedir(), ".claude");

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

// -- session registry (for TTL + /forget) -----------------------------------
interface Tracked {
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

// Claude stores each session as <home>/.claude/projects/<encoded-cwd>/<id>.jsonl.
// Best-effort: returns the path if it exists, else null.
function claudeSessionFile(id: string): string | null {
  const projects = path.join(CLAUDE_HOME, "projects");
  if (!fs.existsSync(projects)) return null;
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// -- global lock: one claude at a time (avoids --resume races) --------------
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

// -- HTTP helpers ------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
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
  return (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
}

async function handleAsk(body: string): Promise<Record<string, unknown>> {
  let q: { sessionId?: string; message?: string; context?: string; maxTurns?: number };
  try {
    q = JSON.parse(body);
  } catch {
    throw new HttpError(400, "body phải là JSON");
  }
  const message = typeof q.message === "string" ? q.message.trim() : "";
  if (!message) throw new HttpError(400, "thiếu 'message'");
  const context = typeof q.context === "string" ? q.context.trim() : "";
  const maxTurns = Number.isInteger(q.maxTurns) && q.maxTurns! > 0 ? q.maxTurns! : MAX_TURNS;
  const resume = typeof q.sessionId === "string" && q.sessionId.trim() ? q.sessionId.trim() : undefined;

  // The hub already localizes the question; we just frame it as advice.
  const prompt = context
    ? `Đang cố vấn cho một quyết định kỹ thuật. Ngữ cảnh:\n\n${context}\n\nCâu hỏi:\n${message}\n\nTrả lời ngắn gọn, tập trung vào câu hỏi.`
    : message;

  const r: ClaudeResult = await withLock(() =>
    runClaude({
      bin: CLAUDE_BIN,
      workdir: WORK,
      prompt,
      maxTurns,
      timeoutMs: TURN_TIMEOUT_MS,
      resumeSessionId: resume,
      permissionMode: "plan",
      allowedTools: CLAUDE_ADVISOR_TOOLS,
      log,
    }),
  );

  if (r.sessionId) {
    const t = registry[r.sessionId] ?? { lastActive: 0, turns: 0 };
    t.lastActive = Date.now();
    t.turns += 1;
    registry[r.sessionId] = t;
    saveRegistry();
  }

  return {
    answer: r.report,
    status: r.status,
    sessionId: r.sessionId,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
    incomplete: r.incomplete,
  };
}

function handleForget(body: string): Record<string, unknown> {
  let q: { sessionId?: string };
  try {
    q = JSON.parse(body);
  } catch {
    throw new HttpError(400, "body phải là JSON");
  }
  const id = typeof q.sessionId === "string" ? q.sessionId.trim() : "";
  if (!id) throw new HttpError(400, "thiếu 'sessionId'");
  const f = claudeSessionFile(id);
  let deleted = false;
  if (f) {
    try {
      fs.rmSync(f);
      deleted = true;
    } catch {}
  }
  delete registry[id];
  saveRegistry();
  log(`forget ${id} (session file deleted: ${deleted})`);
  return { ok: true, deleted };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, claude: CLAUDE_BIN, cwd: WORK, sessions: Object.keys(registry).length });
    }
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && url.pathname === "/ask") {
      return send(res, 200, await handleAsk(await readBody(req)));
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

// Idle TTL: drop Claude sessions not used in TTL_MS.
function sweep(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of Object.entries(registry)) {
    if (now - t.lastActive > TTL_MS) {
      const f = claudeSessionFile(id);
      if (f) {
        try {
          fs.rmSync(f);
          log(`ttl-prune ${id}`);
        } catch {}
      }
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
  log(
    `advisor daemon started (port ${PORT}/${HOST}, work ${WORK}, claude ${CLAUDE_BIN}, ttl ${Math.round(TTL_MS / 3600000)}h)`,
  );
  if (!TOKEN) log("⚠ MAC_ADVISOR_TOKEN không được set — /ask & /forget sẽ từ chối tất cả");
});
const sweeper = setInterval(sweep, 30 * 60 * 1000);
sweeper.unref?.();
