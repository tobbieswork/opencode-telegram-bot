import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Tool names that modify files (their input carries the target at `.path`). */
const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "delete_file", "create_file", "move"]);

export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  /** Variant ids the model offers (e.g. ["xhigh","high","medium","low"]); empty if unknown. */
  variants: string[];
  /** The model's context window in tokens (limit.context); unknown when the server omits it. */
  contextLimit?: number;
}
export interface AgentInfo {
  id: string;
  name?: string;
  description?: string;
}
export interface SessionBrief {
  id: string;
  title?: string;
  updated?: number;
}
export interface PromptResult {
  reply: string;
  outcome?: string;
  interrupted: boolean;
  elapsedMs: number;
  /** time.created of the assistant message that produced `reply` (0 if none). */
  replyTime?: number;
  /** Provider/turn error from the newest assistant/idle/compaction message (present on a failed turn). */
  error?: { type?: string; message?: string };
}

/** Cumulative token usage for a session (as reported by OpenCode). */
export interface SessionTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
}

/**
 * A snapshot of a session for `/context`: identity, cumulative usage, and the
 * files it most recently modified. OpenCode exposes no context-window-remaining
 * field, so this is cumulative tokens + observed file activity — not "how much
 * context is left".
 */
export interface SessionReport {
  id: string;
  title?: string;
  directory?: string;
  agent?: string;
  outcome?: string;
  created?: number;
  updated?: number;
  messageCount: number;
  tokens?: SessionTokens;
  cost?: number;
  /** Unique file paths most recently modified (newest first), capped. */
  modifiedFiles: string[];
  /** Text of the newest user prompt. */
  lastUserPrompt?: string;
}

/**
 * Some client methods return the `{data}` envelope, others unwrap it, and
 * paged responses put the array under `.data`. This handles all three.
 */
function unwrap<T = any>(x: any): T {
  if (x && typeof x === "object" && "data" in x) return (x as any).data as T;
  return x as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let idLastMs = 0;
let idCounter = 0;

/**
 * A client-chosen, time-sortable user message id (same shape OpenCode mints:
 * `msg_` + 12 hex time chars + 14 random). Passing it to `session.prompt`
 * makes the prompt idempotent: re-sending the same id returns the already
 * admitted input instead of queueing a duplicate turn — so a retry after a
 * transport blip can never run the same instruction twice.
 */
export function newMessageID(): string {
  const now = Date.now();
  if (now !== idLastMs) {
    idLastMs = now;
    idCounter = 0;
  }
  idCounter++;
  const v = BigInt(now) * 0x1000n + BigInt(idCounter);
  let time = "";
  for (let i = 0; i < 6; i++) time += Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => ID_CHARS[b % 62]).join("");
  return "msg_" + time + rnd;
}

/** Join the text parts of an assistant message. */
export function assistantText(m: any): string {
  return ((m?.content ?? []) as any[])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * Join the text of a *user* message. User messages carry their text either as a
 * plain `m.text` string or (less commonly) as text parts in `m.content` — handle
 * both so follow-up extraction works regardless of the server's exact shape.
 */
export function userText(m: any): string {
  if (typeof m?.text === "string") return m.text;
  return ((m?.content ?? []) as any[])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * True when an error is a *network-level* fetch failure — connection refused,
 * reset, timeout, DNS, or the undici "fetch failed" wrapper. These are
 * transient blips that are safe to retry. They surface as a `ClientError` with
 * `reason: "Transport"` (possibly nested under `.cause`).
 *
 * An HTTP error *status* (4xx/5xx) is NOT transient here: the server answered,
 * so retrying the same request would not help — those are rethrown immediately.
 */
function isTransientNetworkError(e: any): boolean {
  if (!e) return false;
  if (e.reason === "Transport" || e.cause?.reason === "Transport") return true;
  const msg = `${e.cause?.message ?? ""} ${e.message ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|EPROTO|ETIMEDOUT|EAI_AGAIN|socket hang up|network .*unreachable|UND_ERR_[A-Z]+/i.test(
    msg,
  );
}

/**
 * Run `fn`, retrying on transient network failures with exponential backoff.
 * An abort (user /stop) or a non-transient error is rethrown immediately — we
 * never retry something the caller cancelled or something a retry can't fix.
 */
async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 750;
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const aborted = opts.signal?.aborted || (e as any)?.name === "AbortError";
      if (aborted || !isTransientNetworkError(e) || attempt >= attempts) throw e;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/**
 * Thin wrapper over the OpenCode HTTP client. All long-running work is
 * awaited here; concurrency/abort handling lives in the bot. Every call is
 * wrapped in {@link retryTransient} so a one-off connection blip ("Transport:
 * fetch failed") is retried instead of failing the whole turn.
 */
export class OpenCodeCtl {
  private client: any;
  private modelsCache?: ModelInfo[];
  private eventRunning = false;
  private eventAbort?: AbortController;
  /** Bumped on every stop/subscribe so a stale event loop knows to exit. */
  private eventGen = 0;
  private url?: string;
  private version?: string;
  private discoverArgs?: { serviceUrl?: string; user?: string; password?: string };
  private eventCbs?: { onEvent: (ev: any) => void; onError?: (e: any) => void; onConnect?: () => void };

  /** Discover the shared background service (or start one), or use an explicit URL. */
  async connect(
    serviceUrl?: string,
    user?: string,
    password?: string,
  ): Promise<{ url: string; version?: string }> {
    this.discoverArgs = { serviceUrl, user, password };
    await this.establishClient();
    return { url: this.url as string, version: this.version };
  }

  /**
   * Re-discover the service and rebuild the client. The OpenCode service can
   * restart on a new port, which leaves the stored URL dead (every request
   * then fails with "Transport: fetch failed"). Call this when a request fails
   * persistently; it also restarts the event subscription so the question relay
   * keeps working after the reconnect.
   */
  async reconnect(): Promise<void> {
    if (!this.discoverArgs) return;
    this.stopEvents();
    await this.establishClient();
    this.modelsCache = undefined; // the service may have restarted; refetch models
    if (this.eventCbs) this.subscribeEvents(this.eventCbs.onEvent, this.eventCbs.onError, this.eventCbs.onConnect);
  }

  private async establishClient(): Promise<void> {
    const { serviceUrl, user, password } = this.discoverArgs ?? {};
    let url: string;
    let headers: Record<string, string>;
    if (serviceUrl) {
      url = serviceUrl;
      headers =
        user && password
          ? { authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") }
          : {};
    } else {
      let ep: any;
      try {
        ep = await Service.discover();
      } catch {
        ep = undefined;
      }
      // discover() resolves to undefined (it does not throw) when the
      // registered service is not running. Fall back to ensure(), which
      // spawns `opencode serve --service` when missing and waits (up to
      // ~2 min) for it to become ready — this is what brings the bot back
      // after a machine reboot without any manual intervention.
      if (!ep) {
        ep = await Service.ensure();
      }
      if (!ep) {
        throw new Error("OpenCode service unavailable: discover() and ensure() both returned no endpoint");
      }
      url = ep.url;
      headers = Service.headers(ep) as Record<string, string>;
    }
    this.url = url;
    this.client = OpenCode.make({ baseUrl: url, headers });
    const info = (await retryTransient(() => this.client.server.info(), { attempts: 3 })) as any;
    this.version = (info?.data ?? info)?.version;
  }

  private ensureClient(): void {
    if (!this.client) throw new Error("Not connected. Call connect() first.");
  }

  async serverInfo(): Promise<any> {
    this.ensureClient();
    const i = (await retryTransient(() => this.client.server.info())) as any;
    return unwrap<any>(i) ?? i;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.ensureClient();
    if (this.modelsCache) return this.modelsCache;
    const arr = (unwrap<any[]>(await retryTransient(() => this.client.model.list())) ?? []) as any[];
    this.modelsCache = arr.map((m) => ({
      id: m.id,
      providerID: m.providerID,
      name: m.name,
      variants: ((m.variants ?? []) as any[]).map((v) => v?.id).filter(Boolean) as string[],
      contextLimit: typeof m.limit?.context === "number" ? m.limit.context : undefined,
    }));
    return this.modelsCache;
  }

  /** Variant ids a model offers (drives the /variants command). Empty if the model has none. */
  async getVariants(model: { id: string; providerID: string }): Promise<string[]> {
    const models = await this.listModels();
    const m =
      models.find((x) => x.id === model.id && x.providerID === model.providerID) ??
      models.find((x) => x.id === model.id);
    return m?.variants ?? [];
  }

  async listAgents(): Promise<AgentInfo[]> {
    this.ensureClient();
    const arr = (unwrap<any[]>(await retryTransient(() => this.client.agent.list())) ?? []) as any[];
    return arr.map((a) => ({ id: a.id, name: a.name, description: a.description }));
  }

  async listSessions(): Promise<SessionBrief[]> {
    this.ensureClient();
    const arr = (unwrap<any[]>(await retryTransient(() => this.client.session.list())) ?? []) as any[];
    return arr.map((s) => ({ id: s.id, title: s.title, updated: s.time?.updated }));
  }

  async createSession(
    directory: string,
    opts: { title?: string; agent?: string; metadata?: Record<string, string | number | boolean> } = {},
  ): Promise<string> {
    this.ensureClient();
    const dir = isAbsolute(directory) ? directory : resolve(directory);
    if (!existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);
    const input: any = { location: { directory: dir } };
    if (opts.title) input.title = opts.title;
    if (opts.agent) input.agent = opts.agent;
    if (opts.metadata) input.metadata = opts.metadata;
    // Create is not idempotent; a retried create may leave one extra empty
    // session behind, which is harmless (nothing runs in it).
    const s = (await retryTransient(() => this.client.session.create(input))) as any;
    const id = unwrap<any>(s)?.id ?? s?.id;
    if (!id) throw new Error("Failed to create session (no id returned).");
    return id as string;
  }

  /** Delete a session on the server (used by /prune to retire a finished worker's session). */
  async removeSession(sessionID: string): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.remove({ sessionID }));
  }

  async setModel(sessionID: string, model: { id: string; providerID: string; variant?: string }): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.switchModel({ sessionID, model }));
  }

  async setAgent(sessionID: string, agent: string): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.switchAgent({ sessionID, agent }));
  }

  async interrupt(sessionID: string): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.interrupt({ sessionID }));
  }

  async listMessages(sessionID: string, limit?: number): Promise<any[]> {
    this.ensureClient();
    const input: any = { sessionID };
    if (limit) input.limit = limit;
    const arr = (unwrap<any[]>(await retryTransient(() => this.client.message.list(input))) ?? []) as any[];
    return arr;
  }

  async getSession(sessionID: string): Promise<any> {
    this.ensureClient();
    const s = (await retryTransient(() => this.client.session.get({ sessionID }))) as any;
    return unwrap<any>(s) ?? s;
  }

  /**
   * The model actually used by the newest assistant message. The session object
   * carries no model field, so this is the only way to observe which model the
   * session is running on (explicitly set or server-resolved default).
   */
  async getSessionModel(sessionID: string): Promise<{ id: string; providerID: string } | undefined> {
    const msgs = ((await this.listMessages(sessionID, 10).catch(() => [])) as any[]) ?? [];
    for (const m of msgs) {
      if (m?.type === "assistant" && m.model?.id) {
        return { id: m.model.id, providerID: m.model.providerID ?? "?" };
      }
    }
    return undefined;
  }

  /**
   * The context size of the newest LLM step (input + cache-read tokens) — the
   * number that actually decides overflow, unlike the session's CUMULATIVE
   * tokens. Scans the newest messages backwards for the first assistant turn
   * that carries token stats. `message.list` items carry tokens under
   * `info.tokens` on 2.1.x; `tokens` is kept as a fallback for older shapes.
   */
  async lastAssistantContext(sessionID: string): Promise<number | undefined> {
    const msgs = ((await this.listMessages(sessionID, 20).catch(() => [])) as any[]) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const isAssistant = m?.type === "assistant" || m?.role === "assistant";
      if (!isAssistant) continue;
      const t = m.info?.tokens ?? m.tokens;
      const n = (typeof t?.input === "number" ? t.input : 0) + (typeof t?.cache?.read === "number" ? t.cache.read : 0);
      if (n > 0) return n;
    }
    return undefined;
  }

  /**
   * Put / list / remove a per-session instruction entry. OpenCode namespaces
   * these as `api/<key>` and injects them into the session's system context
   * (the same channel as AGENTS.md), so this is a clean way to steer the model
   * WITHOUT polluting the user's actual prompt text.
   */
  async setInstruction(sessionID: string, key: string, value: unknown): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.instructions.entry.put({ sessionID, key, value }));
  }

  async listInstructions(sessionID: string): Promise<any[]> {
    this.ensureClient();
    const raw = (await retryTransient(() => this.client.session.instructions.entry.list({ sessionID }))) as any;
    return (Array.isArray(raw) ? raw : (raw?.data ?? [])) as any[];
  }

  async removeInstruction(sessionID: string, key: string): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.instructions.entry.remove({ sessionID, key }));
  }

  /**
   * Snapshot for `/context`: identity, cumulative usage, message count, the
   * files the session most recently modified, and the newest user prompt.
   * Tool parts carry their input under `state.input`; file tools put the
   * target at `state.input.path`.
   */
  async getSessionReport(sessionID: string): Promise<SessionReport> {
    const s = ((await this.getSession(sessionID).catch(() => null)) ?? {}) as any;
    const msgs = ((await this.listMessages(sessionID).catch(() => [])) as any[]) ?? [];

    // File-modification events in message order (each hit is one write/edit/...).
    const events: string[] = [];
    let lastUserPrompt: string | undefined;
    for (const m of msgs) {
      if (m?.type === "user") lastUserPrompt = typeof m.text === "string" ? m.text : lastUserPrompt;
      for (const c of m?.content ?? []) {
        if (c?.type !== "tool") continue;
        if (!MUTATING_TOOLS.has(c.name)) continue;
        const p = c.state?.input?.path;
        if (typeof p === "string") events.push(p);
      }
    }

    // Newest-first, de-duplicated, capped.
    const seen = new Set<string>();
    const modifiedFiles: string[] = [];
    for (let i = events.length - 1; i >= 0 && modifiedFiles.length < 8; i--) {
      if (seen.has(events[i])) continue;
      seen.add(events[i]);
      modifiedFiles.push(events[i]);
    }

    return {
      id: s.id ?? sessionID,
      title: s.title,
      directory: s.location?.directory,
      agent: s.agent,
      outcome: s.outcome,
      created: s.time?.created,
      updated: s.time?.updated,
      messageCount: msgs.length,
      tokens: s.tokens
        ? {
            input: s.tokens.input ?? 0,
            output: s.tokens.output ?? 0,
            reasoning: s.tokens.reasoning ?? 0,
            cache: s.tokens.cache?.read ?? 0,
          }
        : undefined,
      cost: typeof s.cost === "number" ? s.cost : undefined,
      modifiedFiles,
      lastUserPrompt,
    };
  }

  /**
   * Send a prompt, block until the session goes idle, then return the latest
   * assistant text. If the passed signal aborts (e.g. /stop), we still read
   * whatever partial reply exists and report `interrupted: true`.
   */
  async promptAndWait(
    sessionID: string,
    text: string,
    opts: { signal?: AbortSignal; messageID?: string } = {},
  ): Promise<PromptResult> {
    this.ensureClient();
    const t0 = Date.now();
    // A stable id makes every re-send of this prompt (here, or by a caller that
    // retries the whole turn after a reconnect) resolve to the same input.
    const id = opts.messageID ?? newMessageID();
    // Snapshot the messages that already exist so the reply we return is scoped
    // to THIS turn. (Reading "the last assistant message in the session" leaked
    // the PREVIOUS turn's answer: message.list is paged, newest-first, so a turn
    // that produced no new text echoed the earlier reply back to the user.)
    const beforeIds = new Set<string>(
      ((await this.listMessages(sessionID, 200).catch(() => [])) as any[])
        .map((m: any) => m?.id)
        .filter(Boolean),
    );
    // A dropped/blipped connection here is the classic "Transport: fetch
    // failed". A transport error does NOT prove the request never reached the
    // server, so retrying is only safe because the input id is fixed: the
    // server dedupes on it.
    await retryTransient(
      () => this.client.session.prompt({ sessionID, id, text }),
      { attempts: 3, baseMs: 1000, signal: opts.signal },
    );
    let interrupted = false;
    try {
      // The wait is an SSE stream that blocks until the session is idle. If the
      // connection drops mid-wait, re-arming it simply waits again.
      await retryTransient(
        () => this.client.session.wait({ sessionID }, opts.signal ? { signal: opts.signal } : undefined),
        { attempts: 3, baseMs: 1000, signal: opts.signal },
      );
    } catch (e) {
      if (opts.signal?.aborted || (e as any)?.name === "AbortError") {
        interrupted = true;
      } else {
        throw e;
      }
    }
    // The reply is the newest assistant message created after the snapshot
    // (i.e. produced by THIS turn). The session can go idle a moment before the
    // final message is listed, so re-check a few times before giving up.
    let reply = "";
    let replyTime = 0;
    let error: { type?: string; message?: string } | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const messages = (await this.listMessages(sessionID, 200).catch(() => [])) as any[];
      const fresh = messages.filter((m: any) => m && m.id && !beforeIds.has(m.id));
      for (const m of fresh) {
        // A failed turn leaves the provider/turn error NOT only on the assistant
        // message but on the "idle" (outcome + error) and "compaction" messages
        // too — grab the first of these types that carries an error.
        if (!error && (m.type === "assistant" || m.type === "idle" || m.type === "compaction") && m.error) {
          error = typeof m.error === "string" ? { message: m.error } : { type: m.error?.type, message: m.error?.message };
        }
        if (m?.type !== "assistant") continue;
        const t = assistantText(m);
        if (t) {
          reply = t;
          replyTime = m.time?.created ?? 0;
          break; // messages are newest-first, so the first hit is the latest
        }
      }
      if (reply || error || opts.signal?.aborted) break;
      await sleep(300);
    }
    let outcome: string | undefined;
    try {
      outcome = (await this.getSession(sessionID))?.outcome;
    } catch {
      /* ignore */
    }
    return { reply, outcome, interrupted, elapsedMs: Date.now() - t0, replyTime, error };
  }

  /**
   * Admit a prompt and return immediately; the turn runs on the server and its
   * end is observed through `session.execution.*` events. Used for worker and
   * Manager turns, which must never block the bot. Idempotent via `messageID`.
   */
  async prompt(sessionID: string, text: string, opts: { messageID?: string } = {}): Promise<string> {
    this.ensureClient();
    const id = opts.messageID ?? newMessageID();
    await retryTransient(() => this.client.session.prompt({ sessionID, id, text }), { attempts: 3, baseMs: 1000 });
    return id;
  }

  /**
   * Newest assistant text in a session created after `afterTime` (0 = any),
   * with its time. With `lastTurn`, only replies after the newest user message
   * count — so a turn that ended without text never returns the previous
   * turn's answer.
   */
  async latestReply(
    sessionID: string,
    afterTime = 0,
    opts: { lastTurn?: boolean } = {},
  ): Promise<{ text: string; time: number } | undefined> {
    const msgs = (await this.listMessages(sessionID, 50).catch(() => [] as any[])) as any[];
    if (opts.lastTurn) {
      const lastUser = Math.max(0, ...msgs.filter((m: any) => m?.type === "user").map((m: any) => m.time?.created ?? 0));
      afterTime = Math.max(afterTime, lastUser);
    }
    const newest = msgs
      .filter((m: any) => m?.type === "assistant" && (m.time?.created ?? 0) > afterTime && assistantText(m))
      .sort((a: any, b: any) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
    return newest ? { text: assistantText(newest), time: newest.time?.created ?? 0 } : undefined;
  }

  /**
   * Whether a session's turn is still running, and how the last one ended.
   * There is no status endpoint: a session is idle once `time.idle` has caught
   * up with `time.updated` (while busy, `updated` moves past `idle` and
   * `outcome` still describes the previous turn).
   */
  async sessionState(sessionID: string): Promise<{ busy: boolean; outcome?: string }> {
    const s = await this.getSession(sessionID);
    const idle = s?.time?.idle;
    const busy = !idle || (s?.time?.updated ?? 0) > idle;
    return { busy, outcome: busy ? undefined : s?.outcome };
  }

  /** Pending permission requests of one session (to re-surface after a missed event). */
  async listPermissions(sessionID: string): Promise<any[]> {
    this.ensureClient();
    const raw = (await retryTransient(() => this.client.permission.list({ sessionID }))) as any;
    return (Array.isArray(raw) ? raw : (raw?.data ?? [])) as any[];
  }

  // ── MCP (the Manager's tool bridge) ──────────────────────────────────────
  /**
   * Register a remote MCP server for one location only (runtime, not written to
   * any config file — so it must be re-added after the service restarts).
   * Code Mode is off so the tools stay on the model's native tool list.
   */
  async addRemoteMcp(directory: string, name: string, url: string, headers: Record<string, string>): Promise<void> {
    this.ensureClient();
    const location = { directory };
    await this.client.mcp.remove({ server: name, location }).catch(() => {});
    await retryTransient(() =>
      this.client.mcp.add({ server: name, location, config: { type: "remote", url, headers, oauth: false, codemode: false } }),
    );
    await retryTransient(() => this.client.mcp.connect({ server: name, location })).catch(() => {});
  }

  /** Connection status of one MCP server at a location ("connected", "failed", …) plus its error. */
  async mcpStatus(directory: string, name: string): Promise<{ status: string; error?: string }> {
    this.ensureClient();
    const raw = (await retryTransient(() => this.client.mcp.list({ location: { directory } }))) as any;
    const s = ((raw?.data ?? raw ?? []) as any[]).find((x) => x?.name === name)?.status;
    return { status: s?.status ?? "missing", error: s?.error };
  }

  // ── questions / forms ────────────────────────────────────────────────────
  /**
   * A *form* is how OpenCode surfaces the agent's `question` tool (and other
   * interactive prompts) to a client. The form stays PENDING until we answer it
   * with `replyForm` (or `cancelForm`). While pending, `session.wait` blocks —
   * so a bot that ignores forms hangs (this is the root cause of the stuck
   * "transport" error). The bot therefore subscribes to events and relays each
   * form to Telegram.
   */
  async listForms(sessionID: string): Promise<any[]> {
    this.ensureClient();
    const raw = (await retryTransient(() => this.client.session.form.list({ sessionID }))) as any;
    return (Array.isArray(raw) ? raw : (raw?.data ?? [])) as any[];
  }

  async replyForm(sessionID: string, formID: string, answer: Record<string, any>): Promise<void> {
    this.ensureClient();
    await retryTransient(() => this.client.session.form.reply({ sessionID, formID, answer }));
  }

   async cancelForm(sessionID: string, formID: string, message?: string): Promise<void> {
     this.ensureClient();
     await retryTransient(() =>
       this.client.session.form.cancel({
         sessionID,
         formID,
         ...(message ? { message } : {}),
       }),
     );
   }

   /**
    * Answer a pending permission request (what the TUI does when you press a
    * key). `decision`: "once" (allow just this call), "always" (save a rule
    * so this is never asked again), or "reject".
    */
   async replyPermission(
     sessionID: string,
     requestID: string,
     decision: "once" | "always" | "reject",
     message?: string,
   ): Promise<void> {
     this.ensureClient();
     await retryTransient(() =>
       this.client.permission.reply({
         sessionID,
         requestID,
         decision,
         ...(message ? { message } : {}),
       }),
     );
   }

   /**
    * Create a permission request on a session, the same way a tool call would.
    * Returns the request id and its resolved effect ("ask" = pending, fires
    * the `permission.asked` event; "allow"/"deny" = settled by saved rules).
    * Used by the smoke test to drive the permission relay end-to-end.
    */
   async createPermission(
     sessionID: string,
     action: string,
     resources: string[],
   ): Promise<{ id: string; effect: string }> {
     this.ensureClient();
     const raw = (await retryTransient(() =>
       this.client.permission.create({ sessionID, action, resources }),
     )) as any;
     return { id: String(raw?.id ?? ""), effect: String(raw?.effect ?? "") };
   }
  /**
   * Subscribe to the OpenCode event stream and forward every event to
   * `onEvent`. The stream is live-only with no replay, so on a drop we
   * re-subscribe with backoff. Stops when `stopEvents()` is called.
   */
  subscribeEvents(onEvent: (ev: any) => void, onError?: (e: any) => void, onConnect?: () => void): void {
    this.eventCbs = { onEvent, onError, onConnect };
    if (this.eventRunning) return;
    this.eventRunning = true;
    this.eventAbort = new AbortController();
    const gen = ++this.eventGen;
    void this.eventLoop(gen, onEvent, onError);
  }

  stopEvents(): void {
    this.eventRunning = false;
    this.eventGen++;
    this.eventAbort?.abort();
  }

  private async eventLoop(
    gen: number,
    onEvent: (ev: any) => void,
    onError?: (e: any) => void,
  ): Promise<void> {
    let delay = 1000;
    const alive = () => this.eventRunning && this.eventGen === gen;
    while (alive()) {
      try {
        const stream = this.client.event.subscribe({ signal: this.eventAbort?.signal }) as AsyncIterable<any>;
        delay = 1000; // reset backoff after a clean (re)connect
        // The stream has no replay: anything emitted while we were away (a
        // question, a permission ask, a finished turn) is gone. Let the bot
        // reconcile from the API on every (re)connect.
        try {
          this.eventCbs?.onConnect?.();
        } catch (e) {
          onError?.(e);
        }
        for await (const ev of stream) {
          if (!alive()) break;
          try {
            onEvent(ev);
          } catch (e) {
            onError?.(e);
          }
        }
      } catch (e) {
        if (!alive()) break;
        onError?.(e);
      }
      if (!alive()) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
    if (this.eventGen === gen) this.eventRunning = false;
  }
}
