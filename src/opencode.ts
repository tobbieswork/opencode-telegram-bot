import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
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
  private eventCbs?: { onEvent: (ev: any) => void; onError?: (e: any) => void };

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
    if (this.eventCbs) this.subscribeEvents(this.eventCbs.onEvent, this.eventCbs.onError);
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
        ep = await Service.ensure();
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
    this.modelsCache = arr.map((m) => ({ id: m.id, providerID: m.providerID, name: m.name }));
    return this.modelsCache;
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

  async createSession(directory: string): Promise<string> {
    this.ensureClient();
    const dir = isAbsolute(directory) ? directory : resolve(directory);
    if (!existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);
    const s = (await retryTransient(() => this.client.session.create({ location: { directory: dir } }))) as any;
    const id = unwrap<any>(s)?.id ?? s?.id;
    if (!id) throw new Error("Failed to create session (no id returned).");
    return id as string;
  }

  async setModel(sessionID: string, model: { id: string; providerID: string }): Promise<void> {
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
   * Send a prompt, block until the session goes idle, then return the latest
   * assistant text. If the passed signal aborts (e.g. /stop), we still read
   * whatever partial reply exists and report `interrupted: true`.
   */
  async promptAndWait(
    sessionID: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<PromptResult> {
    this.ensureClient();
    const t0 = Date.now();
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
    // failed". The prompt is a fresh request each attempt, so retrying it is
    // safe (a Transport error means the request did not complete). A small
    // number of retries is enough to ride out a transient blip.
    await retryTransient(
      () => this.client.session.prompt({ sessionID, text }),
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
    for (let attempt = 0; attempt < 4; attempt++) {
      const messages = (await this.listMessages(sessionID, 200).catch(() => [])) as any[];
      const fresh = messages.filter((m: any) => m && m.id && !beforeIds.has(m.id));
      for (const m of fresh) {
        if (m?.type !== "assistant") continue;
        const t = (m.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (t) {
          reply = t;
          break; // messages are newest-first, so the first hit is the latest
        }
      }
      if (reply || opts.signal?.aborted) break;
      await sleep(300);
    }
    let outcome: string | undefined;
    try {
      outcome = (await this.getSession(sessionID))?.outcome;
    } catch {
      /* ignore */
    }
    return { reply, outcome, interrupted, elapsedMs: Date.now() - t0 };
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
   * Subscribe to the OpenCode event stream and forward every event to
   * `onEvent`. The stream is live-only with no replay, so on a drop we
   * re-subscribe with backoff. Stops when `stopEvents()` is called.
   */
  subscribeEvents(onEvent: (ev: any) => void, onError?: (e: any) => void): void {
    this.eventCbs = { onEvent, onError };
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
