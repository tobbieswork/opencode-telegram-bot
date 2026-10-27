import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { log, warn } from "./logger.js";

/** One tool exposed to the Manager agent over MCP. */
export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Returns the text the model sees. Throw to report a tool error. */
  run: (args: Record<string, any>) => Promise<string>;
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
          const text = await tool.run(params?.arguments ?? {});
          return rpcResult(id, { content: [{ type: "text", text }] });
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
