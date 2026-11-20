/**
 * Read-only web dashboard with "Login with Telegram" (OIDC).
 *
 * The bot already keys every permission off the Telegram user id allow-list
 * (isUserAllowed). This server extends that to the web: the user logs in
 * through Telegram OAuth (authorization-code + PKCE), the id_token is
 * verified against Telegram JWKS (RS256/ES256), and its sub claim is checked
 * against the SAME allow-list the bot uses. A valid allow-listed uid gets a
 * session cookie; /api/state then serves the read-only snapshot (workers,
 * specs, health) that /board and /spec render in Telegram.
 *
 * Security posture (fail-closed):
 *  - binds 127.0.0.1 only; the public TLS edge is tailscale serve (tailnet only)
 *  - PKCE S256 + single-use state (10-min TTL); no implicit flow, no CSRF on login
 *  - id_token: signature (JWKS) + iss + aud + exp all verified; alg restricted to
 *    RS256/ES256 (anything else, incl. "none", is rejected)
 *  - unknown sub gets 403, no session (the allow-list is the gate, not the cookie)
 *  - cookie: HttpOnly, SameSite=Lax, 7-day TTL
 *
 * No new dependencies: node:http + node:crypto only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createPublicKey, createVerify, randomBytes, type KeyObject, type JsonWebKey } from "node:crypto";

// ── Snapshot types (what /api/state returns) ────────────────────────────────

export type DashboardWorkerGroup = "needs" | "busy" | "idle";

export interface DashboardWorker {
  name: string;
  status: string;
  /** Derived urgency bucket (boardGroup): what the worker needs from the human. */
  group: DashboardWorkerGroup;
  /** Short human reason inside its bucket (boardReason). */
  reason: string;
  agent?: string;
  branch?: string;
  directory?: string;
  /** Owner chat id (top level). */
  chat: number;
  updatedAt: number;
  /** Set when the worker is a spec worker with a run attached. */
  spec?: { spec: string; task: string; auto?: boolean };
  /** Short tail of the worker last reply (truncated by the provider). */
  lastResult?: string;
}

export interface DashboardSpec {
  name: string;
  title: string;
  done: number;
  total: number;
  /** Present when the spec file failed to parse (error message). */
  error?: string;
}

export interface DashboardHealth {
  id: string;
  status: "ok" | "warn" | "fail" | "off";
  detail?: string;
  lastOkAt?: number;
}

export interface DashboardState {
  workers: DashboardWorker[];
  specs: DashboardSpec[];
  health: DashboardHealth[];
  now: number;
}

// ── OIDC pieces ─────────────────────────────────────────────────────────────

export interface DashboardEndpoints {
  /** Authorization endpoint. */
  auth: string;
  /** Token endpoint (POST, form-encoded, Basic auth). */
  token: string;
  /** JWKS document (GET, JSON). */
  jwks: string;
}

const DEFAULT_ENDPOINTS: DashboardEndpoints = {
  auth: "https://oauth.telegram.org/auth",
  token: "https://oauth.telegram.org/token",
  jwks: "https://oauth.telegram.org/.well-known/jwks.json",
};

const STATE_TTL_MS = 10 * 60_000; // login links live 10 minutes
const SESSION_TTL_MS = 7 * 24 * 3600_000; // cookie lives one week
const JWKS_TTL_MS = 3600_000; // refresh keys at most hourly
/** The id_token iss must be exactly this. */
const ISSUER = "https://oauth.telegram.org";

/** A JWK (the fields we use; the rest are ignored). */
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface DashboardOptions {
  /** Port to bind (0 = pick a free one; tests use this). */
  port: number;
  /** Bind host. Default 127.0.0.1, never a public interface. */
  host?: string;
  /** OIDC client id: the bot numeric Telegram id. */
  clientId: number;
  /** OIDC client secret (BotFather, Login Widget). */
  clientSecret: string;
  allowedUserIds: number[];
  allowAny: boolean;
  /** Public base URL of the dashboard (no trailing slash), the redirect_uri origin. */
  publicUrl: string;
  /** What /api/state serves. */
  snapshot: () => DashboardState | Promise<DashboardState>;
  /** Test seam: point the OIDC calls at a local fake. */
  endpoints?: Partial<DashboardEndpoints>;
  /** Test seam: clock. */
  now?: () => number;
  /** Inject a fetch impl (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Base64url without padding. */
export function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** PKCE S256 pair: random verifier + its SHA-256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier, "utf8").digest());
  return { verifier, challenge };
}

/**
 * Verify a Telegram id_token against a JWKS document.
 * Returns the numeric sub (the Telegram user id) or throws.
 * Checks in order: alg allowlist, matching key, signature, iss, aud, exp, sub.
 */
export function verifyIdToken(idToken: string, jwks: Jwk[], expectedAud: string, nowMs: number): { sub: number } {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h64, p64, s64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; sub?: string | number };
  try {
    header = JSON.parse(Buffer.from(h64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p64, "base64url").toString("utf8"));
  } catch {
    throw new Error("undecodable token");
  }
  // Fail closed on anything we cannot verify with node:crypto.
  if (header.alg !== "RS256" && header.alg !== "ES256") throw new Error("unsupported alg " + (header.alg ?? "?"));
  const key = jwks.find((k) => k.kid === header.kid) ?? (jwks.length === 1 ? jwks[0] : undefined);
  if (!key) throw new Error("no matching JWKS key");
  let pub: KeyObject;
  try {
    pub = createPublicKey({ key: key as unknown as JsonWebKey, format: "jwk" });
  } catch {
    throw new Error("undecodable JWKS key");
  }
  const verify = createVerify(header.alg === "RS256" ? "RSA-SHA256" : "SHA256");
  verify.update(h64 + "." + p64);
  let ok = false;
  try {
    ok = verify.verify(pub, Buffer.from(s64, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("bad signature");
  if (payload.iss !== ISSUER) throw new Error("bad issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expectedAud)) throw new Error("bad audience");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) throw new Error("token expired");
  const sub = typeof payload.sub === "string" ? Number(payload.sub) : payload.sub;
  if (typeof sub !== "number" || !Number.isInteger(sub)) throw new Error("bad sub");
  return { sub };
}

/** Single-page UI: a login gate, then three auto-refreshing panels (15 s). */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Bot</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e;--red:#f85149;--green:#3fb950;--yellow:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border)}
h1{font-size:15px;margin:0}
.dim{color:var(--dim)}
main{max-width:880px;margin:0 auto;padding:16px 20px 60px}
section{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:16px}
section h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 10px}
.gtitle{font-size:12px;font-weight:600;margin:8px 0 4px}
.w{padding:6px 0;border-top:1px solid var(--border)}
.w:first-of-type{border-top:0}
.badge{display:inline-block;padding:0 7px;border-radius:10px;font-size:11px;border:1px solid var(--border);color:var(--dim);margin-left:4px;white-space:nowrap}
.ok{color:var(--green)} .warn{color:var(--yellow)} .fail{color:var(--red)} .off{color:var(--dim)}
.row{padding:4px 0;border-top:1px solid var(--border)}
.row:first-child{border-top:0}
.login{padding:90px 0;text-align:center}
.login p{color:var(--dim);margin:14px 0 0}
button.primary{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:9px 20px;font-size:14px;cursor:pointer}
button.ghost{background:none;border:1px solid var(--border);color:var(--dim);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dim);margin:4px 0 0}
</style></head><body>
<header><h1>OpenCode Bot</h1><div id="who"></div></header>
<main id="main"><div class="login"><button class="primary">Log in with Telegram</button><p>Sign in with the Telegram account on the bot allow-list.</p></div></main>
<script>
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
function ago(ms){var s=Math.max(0,Math.floor((Date.now()-ms)/1000));if(s<60)return s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago";}
var GROUPS=[["needs","Needs you"],["busy","In progress"],["idle","Done / idle"]];
var ICON={needs:"\\u{1F534}",busy:"\\u{1F7E2}",idle:"\\u{26AA}"};
function logout(){fetch("/auth/logout",{method:"POST"}).then(function(){location.reload();});}
function render(d){
  var who=document.getElementById("who");
  who.innerHTML="<span class=\"dim\">uid "+esc(d.user)+"</span> <button class=\"ghost\" id=\"out\">Log out</button>";
  document.getElementById("out").addEventListener("click",logout);
  var m=document.getElementById("main");
  var h="<section><h2>Workers ("+d.workers.length+")</h2>";
  GROUPS.forEach(function(g){
    var rows=d.workers.filter(function(x){return x.group===g[0];});
    if(!rows.length)return;
    h+="<div class=\"gtitle\">"+ICON[g[0]]+" "+g[1]+"</div>";
    rows.forEach(function(x){
      var s="<div class=\"w\"><b>"+esc(x.name)+"</b><span class=\"badge\">"+esc(x.status)+"</span>";
      if(x.spec)s+=" <span class=\"badge\">spec "+esc(x.spec.spec)+" \\u00B7 "+esc(x.spec.task)+(x.spec.auto?" \\u00B7 auto":"")+"</span>";
      var meta=[];
      if(x.agent)meta.push(esc(x.agent));
      if(x.branch)meta.push("\\u{1F33F} "+esc(x.branch));
      if(x.directory)meta.push(esc(String(x.directory).slice(-40)));
      meta.push("updated "+ago(x.updatedAt));
      s+="<div class=\"dim\">"+meta.join(" \\u00B7 ")+"</div>";
      if(x.reason)s+="<div class=\"dim\">"+esc(x.reason)+"</div>";
      if(x.lastResult)s+="<pre>"+esc(x.lastResult)+"</pre>";
      h+=s+"</div>";
    });
  });
  h+="</section>";
  var active=d.specs.filter(function(s){return !s.error&&s.done<s.total;});
  var done=d.specs.filter(function(s){return !s.error&&s.done>=s.total;});
  var broken=d.specs.filter(function(s){return !!s.error;});
  h+="<section><h2>Specs (docs/sdd)</h2>";
  function blk(t,ls){if(!ls.length)return "";return "<div class=\"gtitle\">"+t+"</div>"+ls.map(function(x){return "<div class=\"row\"><b>"+esc(x.title)+"</b> <span class=\"dim\">"+(x.error?"\\u26A0 "+esc(x.error):x.done+"/"+x.total)+"</span></div>";}).join("");}
  h+=blk("In progress",active)+blk("Done",done)+blk("Parse errors",broken);
  if(!d.specs.length)h+="<div class=\"dim\">No specs.</div>";
  h+="</section>";
  h+="<section><h2>Health</h2>"+d.health.map(function(x){return "<div class=\"row\"><span class=\""+x.status+"\">"+x.status.toUpperCase()+"</span> <b>"+esc(x.id)+"</b>"+(x.detail?" <span class=\"dim\">"+esc(x.detail)+"</span>":"")+"</div>";}).join("")+"</section>";
  m.innerHTML=h;
}
function refresh(){
  fetch("/api/state",{credentials:"same-origin"}).then(function(r){
    if(r.status===401){location.reload();return null;}
    if(!r.ok)return null;
    return r.json().then(render);
  }).catch(function(){});
}
document.querySelector("button.primary").addEventListener("click",function(){location.href="/auth/redirect";});
refresh();
setInterval(refresh,15000);
</script></body></html>`;

// ── The server ──────────────────────────────────────────────────────────────

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

interface Session {
  uid: number;
  createdAt: number;
}

export class DashboardServer {
  private readonly server: Server;
  private readonly opts: DashboardOptions;
  private readonly endpoints: DashboardEndpoints;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  /** state to pending PKCE verifier (single-use). */
  private readonly pending = new Map<string, PendingAuth>();
  /** cookie value to session. */
  private readonly sessions = new Map<string, Session>();
  private jwksCache?: { keys: Jwk[]; fetchedAt: number };

  constructor(opts: DashboardOptions) {
    this.opts = opts;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...opts.endpoints };
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Bind and return the actual port (port 0 = ephemeral, for tests). */
  async listen(): Promise<number> {
    const host = this.opts.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, host, () => resolve());
    });
    const addr = this.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : this.opts.port;
    return port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((e) => (e ? reject(e) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (req.method === "GET" && path === "/auth/redirect") {
        this.redirectLogin(res);
        return;
      }
      if (req.method === "GET" && path === "/auth/callback") {
        await this.handleCallback(url, res);
        return;
      }
      if ((req.method === "POST" || req.method === "GET") && path === "/auth/logout") {
        this.logout(req, res);
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        await this.handleState(req, res);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error: " + msg);
      } else {
        res.end();
      }
    }
  }

  // ── Auth flow ─────────────────────────────────────────────────────────────

  private redirectLogin(res: ServerResponse): void {
    // Drop stale logins.
    for (const [s, p] of this.pending) if (this.now() - p.createdAt > STATE_TTL_MS) this.pending.delete(s);
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { verifier, createdAt: this.now() });
    const q = new URLSearchParams({
      client_id: String(this.opts.clientId),
      redirect_uri: this.opts.publicUrl + "/auth/callback",
      response_type: "code",
      scope: "openid",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.writeHead(302, { location: this.endpoints.auth + "?" + q.toString() });
    res.end();
  }

  private cookieValue(req: IncomingMessage): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=");
      const k = idx >= 0 ? part.slice(0, idx).trim() : part.trim();
      if (k === "tg_sess") return idx >= 0 ? part.slice(idx + 1) : "";
    }
    return undefined;
  }

  private sessionFor(req: IncomingMessage): Session | undefined {
    const v = this.cookieValue(req);
    if (!v) return undefined;
    const s = this.sessions.get(v);
    if (!s) return undefined;
    if (this.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(v);
      return undefined;
    }
    return s;
  }

  private async handleCallback(url: URL, res: ServerResponse): Promise<void> {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing state or code");
      return;
    }
    const pending = this.pending.get(state);
    this.pending.delete(state); // single-use, even on failure
    if (!pending || this.now() - pending.createdAt > STATE_TTL_MS) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("login expired: tap Log in again");
      return;
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.publicUrl + "/auth/callback",
      client_id: String(this.opts.clientId),
      code_verifier: pending.verifier,
    });
    const tr = await this.fetchImpl(this.endpoints.token, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(String(this.opts.clientId) + ":" + this.opts.clientSecret).toString("base64"),
      },
      body: form.toString(),
    });
    if (!tr.ok) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("token exchange failed (" + tr.status + ")");
      return;
    }
    const tok = (await tr.json()) as { id_token?: string };
    if (!tok.id_token) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("no id_token in token response");
      return;
    }
    const keys = await this.fetchJwks();
    let sub: number;
    try {
      sub = verifyIdToken(tok.id_token, keys, String(this.opts.clientId), this.now()).sub;
    } catch (e) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("id_token rejected: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!this.opts.allowAny && !this.opts.allowedUserIds.includes(sub)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("not on the bot allow-list");
      return;
    }
    const value = randomBytes(32).toString("hex");
    this.sessions.set(value, { uid: sub, createdAt: this.now() });
    res.writeHead(302, {
      location: "/",
      "set-cookie": "tg_sess=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000),
    });
    res.end();
  }

  private logout(req: IncomingMessage, res: ServerResponse): void {
    const v = this.cookieValue(req);
    if (v) this.sessions.delete(v);
    res.writeHead(302, { location: "/", "set-cookie": "tg_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    res.end();
  }

  private async handleState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const s = this.sessionFor(req);
    if (!s) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    const snap = await this.opts.snapshot();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...snap, user: s.uid }));
  }

  private async fetchJwks(): Promise<Jwk[]> {
    const c = this.jwksCache;
    if (c && this.now() - c.fetchedAt < JWKS_TTL_MS) return c.keys;
    const r = await this.fetchImpl(this.endpoints.jwks);
    if (!r.ok) throw new Error("JWKS fetch failed (" + r.status + ")");
    const doc = (await r.json()) as { keys?: Jwk[] };
    if (!Array.isArray(doc.keys) || doc.keys.length === 0) throw new Error("JWKS has no keys");
    this.jwksCache = { keys: doc.keys, fetchedAt: this.now() };
    return this.jwksCache.keys;
  }
}
