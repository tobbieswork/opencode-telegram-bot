import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log, warn } from "./logger.js";
import { runScript, type RunScriptResult } from "./sandbox/runner.js";

/** One MCP tool result. A plain string is also accepted and wrapped as a single text block. */
export interface BridgeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** One tool exposed to the Manager agent over MCP. */
export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Returns the text the model sees, or a full result (e.g. for a sandbox timeout). Throw to report a tool error. */
  run: (args: Record<string, any>) => Promise<string | BridgeToolResult>;
}

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * A minimal MCP server (Streamable HTTP transport, JSON responses only) that
 * lets the Manager agent — itself an OpenCode session — call back into the bot
 * to spawn and steer worker sessions. Bound to 127.0.0.1 and guarded by a
 * bearer token; no dependency, the whole protocol surface is in this file:
 * initialize, ping, tools/list, tools/call (+ notifications, answered 202).
 *
 * Each endpoint `/mcp/<route>` serves its own tool set: the route names the
 * chat whose Manager is calling, since MCP requests carry no session id.
 */
export class McpBridge {
  private server?: Server;
  readonly token = randomBytes(24).toString("hex");
  port = 0;

  constructor(private toolsFor: (route: string) => BridgeTool[] | undefined, private name = "tg-bridge") {}

  url(route: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(route)}`;
  }

  async listen(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(port, "127.0.0.1", () => ok());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
    log(`MCP bridge listening on 127.0.0.1:${this.port}`);
  }

  close(): void {
    this.server?.close();
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${this.token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/mcp\/([^/?]+)/.exec(req.url ?? "");
    if (!m) return void res.writeHead(404).end();
    if (!this.authorized(req)) return void res.writeHead(401).end();
    const tools = this.toolsFor(decodeURIComponent(m[1]));
    if (!tools) return void res.writeHead(404).end();
    // No server-initiated stream and no session teardown to do.
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, rpcError(null, -32700, "Parse error"));
    }
    const batch = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(batch.map((msg) => this.dispatch(msg, tools)))).filter(Boolean);
    if (!replies.length) return void res.writeHead(202).end(); // notifications only
    json(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  private async dispatch(msg: any, tools: BridgeTool[]): Promise<unknown | undefined> {
    const isRequest = msg && msg.id !== undefined && msg.id !== null;
    if (!isRequest) return undefined; // notifications (e.g. notifications/initialized)
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: "0.1.0" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const out = await tool.run(params?.arguments ?? {});
          return rpcResult(id, typeof out === "string" ? { content: [{ type: "text", text: out }] } : out);
        } catch (e) {
          warn(`bridge tool ${tool.name} failed:`, (e as Error)?.message);
          return rpcResult(id, { content: [{ type: "text", text: `Error: ${(e as Error)?.message}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("body too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

// ── run_script tool (zero-context sandbox) ─────────────────────────────────
const RUN_SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;

/** Options for makeRunScriptTool. All optional; production defaults apply. */
export interface RunScriptToolOptions {
  /** Hard script timeout passed to runScript. Default 60000. */
  timeoutMs?: number;
  /** Handler-side safety timeout, strictly greater than timeoutMs. Default timeoutMs + 5000. */
  safetyMs?: number;
  /** Worktree used when the call omits `worktree`. Default process.cwd(). */
  defaultWorktree?: string;
}

function timeoutLabel(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
}

/**
 * The `run_script` tool: runs a user script in the isolated zero-context
 * sandbox (src/sandbox/runner.ts) and returns only its final result, so the
 * multi-step tool I/O never enters the calling session's context.
 *
 * The sandbox enforces its own timeout plus the tool/path/exec allowlist
 * guards; this handler adds a second, slightly longer safety timeout so a hung
 * runScript can never block the bridge.
 */
export function makeRunScriptTool(opts: RunScriptToolOptions = {}): BridgeTool {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? RUN_SCRIPT_DEFAULT_TIMEOUT_MS));
  const safetyMs = Math.max(timeoutMs + 1, Math.floor(opts.safetyMs ?? timeoutMs + 5_000));
  const label = timeoutLabel(timeoutMs);
  return {
    name: "run_script",
    description:
      "Execute a JavaScript script in an isolated sandbox with access to file/search tools via rpc(). Use for tasks with 5+ sequential tool steps to avoid context overflow. " +
      "Available tools in the script: read_file, write_file, grep, glob, exec. All paths are confined to the worker's worktree. 60s timeout.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The JavaScript script to execute. Must return a string (the final result summary, max 500 chars)." },
        worktree: { type: "string", description: "Absolute path to the worktree. If omitted, uses the session's default working directory." },
      },
      required: ["code"],
    },
    run: async (args) => {
      const code = args.code;
      if (typeof code !== "string" || code.length === 0) throw new Error("code must be a non-empty string");
      // Resolve the worktree. The bridge has no per-session working directory
      // (MCP requests carry no session id), so an omitted worktree falls back
      // to the configured default or the process cwd.
      const worktree = args.worktree === undefined ? (opts.defaultWorktree ?? process.cwd()) : String(args.worktree);
      if (!path.isAbsolute(worktree)) throw new Error(`worktree must be an absolute path (got: ${worktree})`);
      let isDir = false;
      try {
        isDir = fs.statSync(worktree).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new Error(`worktree is not an existing directory: ${worktree}`);

      // Handler-side safety timeout so a hung runScript cannot block the bridge.
      let safety: NodeJS.Timeout | undefined;
      const safetyPromise = new Promise<never>((_, reject) => {
        safety = setTimeout(() => reject(new Error("__run_script_safety__")), safetyMs);
      });
      let r: RunScriptResult;
      try {
        r = await Promise.race([runScript(code, { worktree, timeoutMs }), safetyPromise]);
      } catch (e) {
        if ((e as Error).message === "__run_script_safety__")
          return { content: [{ type: "text", text: `Script timed out after ${label}` }], isError: true };
        throw e;
      } finally {
        if (safety) clearTimeout(safety);
      }
      if (r.timedOut) return { content: [{ type: "text", text: `Script timed out after ${label}` }], isError: true };
      if (r.error !== undefined) return { content: [{ type: "text", text: `Script failed: ${r.error}` }], isError: true };
      return r.result;
    },
  };
}
