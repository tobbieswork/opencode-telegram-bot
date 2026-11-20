/**
 * Dashboard (Login with Telegram, OIDC) - unit + fake-OAuth E2E.
 *
 * Covers:
 *  - b64url / pkcePair (S256 math)
 *  - verifyIdToken: RS256 + ES256 happy path, alg allowlist, signature,
 *    iss / aud / exp / sub, kid selection
 *  - full flow against a local fake of oauth.telegram.org:
 *    redirect (PKCE S256, state), token exchange (Basic auth + verifier),
 *    allow-list gate (403), session cookie, /api/state 200/401,
 *    single-use state, session TTL, logout
 *
 * No real network: the fake OAuth server runs on 127.0.0.1.
 * Run: npx tsx scripts/test-dashboard.ts
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { b64url, DashboardServer, pkcePair, verifyIdToken, type Jwk } from "../src/dashboard.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log("  ok  " + name);
  else {
    failures++;
    console.error("FAIL  " + name + (detail ? "\n      " + detail : ""));
  }
}

const T0 = 1_700_000_000_000;
const CLIENT_ID = 987654321;
const CLIENT_SECRET = "sekret123";
const ALLOWED = 111222333;
const OTHER = 999888777;

// ── Key + JWKS fixtures ─────────────────────────────────────────────────────

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaJwk: Jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Jwk), kid: "k-rsa" };
const ecJwk: Jwk = { ...(ec.publicKey.export({ format: "jwk" }) as Jwk), kid: "k-ec" };

function signToken(payload: Record<string, unknown>, key: KeyObject, kid: string, alg = "RS256"): string {
  const h64 = b64url(JSON.stringify({ alg, kid }));
  const p64 = b64url(JSON.stringify(payload));
  const signer = createSign(alg === "RS256" ? "RSA-SHA256" : "SHA256");
  signer.update(h64 + "." + p64);
  return h64 + "." + p64 + "." + b64url(signer.sign(key));
}

function tokenFor(sub: number, over: Record<string, unknown> = {}): string {
  const now = Math.floor(T0 / 1000);
  return signToken(
    { iss: "https://oauth.telegram.org", aud: String(CLIENT_ID), sub, iat: now, exp: now + 300, ...over },
    rsa.privateKey,
    "k-rsa",
  );
}

// ── Unit: b64url + pkcePair ─────────────────────────────────────────────────

console.log("b64url");
check("strips padding and goes url-safe", b64url(Buffer.from([0xfb, 0xff])) === "-_8", b64url(Buffer.from([0xfb, 0xff])));
{
  const v = b64url(Buffer.from([0xfb, 0xfb, 0xfb, 0xff]));
  check("no + or / chars", !v.includes("+") && !v.includes("/"), v);
}

console.log("pkcePair");
{
  const { verifier, challenge } = pkcePair();
  const expected = b64url(createHash("sha256").update(verifier, "utf8").digest());
  check("challenge = S256(verifier)", challenge === expected);
  check("verifier is 43 base64url chars", verifier.length === 43, String(verifier.length));
  check("verifiers differ", pkcePair().verifier !== verifier);
}

// ── Unit: verifyIdToken ─────────────────────────────────────────────────────

console.log("verifyIdToken");
{
  const keys = [rsaJwk];
  check("valid RS256 token", verifyIdToken(tokenFor(ALLOWED), keys, String(CLIENT_ID), T0).sub === ALLOWED);
  let threw = "";
  try { verifyIdToken(tokenFor(ALLOWED, { exp: Math.floor(T0 / 1000) - 10 }), keys, String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("expired rejected", threw === "token expired", threw);
  threw = "";
  try { verifyIdToken(tokenFor(ALLOWED, { aud: "123" }), keys, String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("wrong aud rejected", threw === "bad audience", threw);
  threw = "";
  try { verifyIdToken(tokenFor(ALLOWED, { iss: "https://evil.example" }), keys, String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("wrong iss rejected", threw === "bad issuer", threw);
  // Tamper: keep header + signature, swap the payload (sub flipped).
  const t = tokenFor(ALLOWED).split(".");
  const tampered = b64url(JSON.stringify({ iss: "https://oauth.telegram.org", aud: String(CLIENT_ID), sub: OTHER, iat: 0, exp: Math.floor(T0 / 1000) + 300 }));
  threw = "";
  try { verifyIdToken(t[0] + "." + tampered + "." + t[2], keys, String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("tampered payload rejected", threw === "bad signature", threw);
  // alg "none" must never verify.
  const noneTok = b64url(JSON.stringify({ alg: "none", kid: "k-rsa" })) + "." + t[1] + ".x";
  threw = "";
  try { verifyIdToken(noneTok, keys, String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("alg none rejected", threw.startsWith("unsupported alg"), threw);
  // ES256 (EC P-256).
  const now2 = Math.floor(T0 / 1000);
  const ecTok = signToken({ iss: "https://oauth.telegram.org", aud: String(CLIENT_ID), sub: ALLOWED, iat: now2, exp: now2 + 300 }, ec.privateKey, "k-ec", "ES256");
  check("valid ES256 token", verifyIdToken(ecTok, [ecJwk], String(CLIENT_ID), T0).sub === ALLOWED);
  // kid selection with two keys in the document.
  check("kid selection (two keys)", verifyIdToken(tokenFor(ALLOWED), [ecJwk, rsaJwk], String(CLIENT_ID), T0).sub === ALLOWED);
  threw = "";
  try { verifyIdToken(tokenFor(ALLOWED), [ecJwk, rsaJwk].map((k) => ({ ...k, kid: "k-x" })), String(CLIENT_ID), T0); } catch (e) { threw = (e as Error).message; }
  check("unknown kid rejected", threw === "no matching JWKS key", threw);
}

// ── E2E: full login flow against a local fake OAuth server ─────────────────

async function e2e(): Promise<void> {
  console.log("e2e (fake oauth.telegram.org)");
  const seen: { challenge: string | null; basic: string; verifier: string } = { challenge: null, basic: "", verifier: "" };
  let liveSub = ALLOWED;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [rsaJwk] }));
        return;
      }
      if (url.pathname === "/auth") {
        // The browser lands here; the test just records the PKCE challenge.
        seen.challenge = url.searchParams.get("code_challenge");
        res.writeHead(418, { "content-type": "text/plain" });
        res.end("stop: the test drives the redirect itself");
        return;
      }
      if (url.pathname === "/token") {
        seen.basic = req.headers.authorization ?? "";
        const form = new URLSearchParams(body);
        seen.verifier = form.get("code_verifier") ?? "";
        if (form.get("grant_type") !== "authorization_code") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unsupported_grant_type" }));
          return;
        }
        if (seen.challenge !== b64url(createHash("sha256").update(seen.verifier, "utf8").digest())) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "pkce mismatch" }));
          return;
        }
        const now = Math.floor(T0 / 1000);
        const id_token = signToken({ iss: "https://oauth.telegram.org", aud: String(CLIENT_ID), sub: liveSub, iat: now, exp: now + 300 }, rsa.privateKey, "k-rsa");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", id_token }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakeBase = "http://127.0.0.1:" + (fake.address() as { port: number }).port;

  let nowMs = T0;
  const snap = {
    workers: [{ name: "w1", status: "running", group: "busy" as const, reason: "", chat: 42, updatedAt: T0 }],
    specs: [{ name: "s1", title: "Spec One", done: 2, total: 5 }],
    health: [{ id: "opencode", status: "ok" as const }],
    now: T0,
  };
  const dash = new DashboardServer({
    port: 0,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicUrl: "https://dash.example",
    allowedUserIds: [ALLOWED],
    allowAny: false,
    snapshot: () => snap,
    endpoints: { auth: fakeBase + "/auth", token: fakeBase + "/token", jwks: fakeBase + "/.well-known/jwks.json" },
    now: () => nowMs,
  });
  const dashPort = await dash.listen();
  const base = "http://127.0.0.1:" + dashPort;

  const page = await fetch(base + "/");
  const pageText = await page.text();
  check("GET / serves the page", page.status === 200 && pageText.includes("Log in with Telegram"));

  const anon = await fetch(base + "/api/state");
  check("no cookie -> 401", anon.status === 401);

  // Redirect: 302 to the fake auth endpoint with PKCE S256 + state.
  const red = await fetch(base + "/auth/redirect", { redirect: "manual" });
  check("redirect 302", red.status === 302, String(red.status));
  const loc = new URL(red.headers.get("location") ?? "http://bad/");
  check("redirect target is the auth endpoint", loc.origin + loc.pathname === fakeBase + "/auth");
  check("client_id in redirect", loc.searchParams.get("client_id") === String(CLIENT_ID));
  check("response_type=code", loc.searchParams.get("response_type") === "code");
  check("code_challenge_method=S256", loc.searchParams.get("code_challenge_method") === "S256");
  check("redirect_uri from publicUrl", loc.searchParams.get("redirect_uri") === "https://dash.example/auth/callback");
  const state = loc.searchParams.get("state") ?? "";
  check("state present (32 hex)", state.length === 32, state);
  // Simulate the browser hitting the auth URL (records the challenge).
  await fetch(loc.toString(), { redirect: "manual" });
  check("challenge recorded by the fake", (seen.challenge ?? "").length > 40, String(seen.challenge));

  // Callback with the allow-listed sub: 302 + session cookie.
  const cb = await fetch(base + "/auth/callback?code=abc123&state=" + encodeURIComponent(state), { redirect: "manual" });
  check("callback 302", cb.status === 302, String(cb.status));
  const setCookie = cb.headers.get("set-cookie") ?? "";
  const cookieVal = (setCookie.match(/tg_sess=([0-9a-f]{64})/) ?? [])[1] ?? "";
  check("session cookie set (64 hex)", cookieVal.length === 64, setCookie);
  check("cookie HttpOnly + SameSite=Lax", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"), setCookie);
  check("Basic auth = client id:secret", seen.basic === "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"));
  check("verifier round-trips PKCE", seen.challenge === b64url(createHash("sha256").update(seen.verifier, "utf8").digest()));

  // Authed /api/state: 200, user = sub, snapshot passed through.
  const auth = await fetch(base + "/api/state", { headers: { cookie: "tg_sess=" + cookieVal } });
  const body = (await auth.json()) as { user?: number; workers?: unknown[]; specs?: unknown[] };
  check("authed state 200", auth.status === 200, String(auth.status));
  check("user = sub", body.user === ALLOWED, String(body.user));
  check("snapshot passes through", JSON.stringify(body.workers) === JSON.stringify(snap.workers) && (body.specs ?? []).length === 1);

  // The state is single-use.
  const cb2 = await fetch(base + "/auth/callback?code=abc123&state=" + encodeURIComponent(state), { redirect: "manual" });
  check("state single-use (400)", cb2.status === 400, String(cb2.status));

  // A bogus cookie is not a session.
  const bogus = await fetch(base + "/api/state", { headers: { cookie: "tg_sess=" + "f".repeat(64) } });
  check("bogus cookie -> 401", bogus.status === 401);

  // A sub outside the allow-list is 403 with no cookie.
  liveSub = OTHER;
  const red2 = await fetch(base + "/auth/redirect", { redirect: "manual" });
  const state2 = (new URL(red2.headers.get("location") ?? "http://bad/")).searchParams.get("state") ?? "";
  await fetch((new URL(red2.headers.get("location") ?? "http://bad/")).toString(), { redirect: "manual" });
  const cb3 = await fetch(base + "/auth/callback?code=xyz&state=" + encodeURIComponent(state2), { redirect: "manual" });
  check("disallowed sub -> 403", cb3.status === 403, String(cb3.status));
  check("no session cookie on 403", (cb3.headers.get("set-cookie") ?? "") === "", String(cb3.headers.get("set-cookie")));
  liveSub = ALLOWED;

  // Logout kills the session.
  await fetch(base + "/auth/logout", { method: "POST", headers: { cookie: "tg_sess=" + cookieVal } });
  const afterOut = await fetch(base + "/api/state", { headers: { cookie: "tg_sess=" + cookieVal } });
  check("logout -> 401", afterOut.status === 401);

  // Session TTL: fresh login, then advance the clock 8 days.
  const red3 = await fetch(base + "/auth/redirect", { redirect: "manual" });
  const loc3 = new URL(red3.headers.get("location") ?? "http://bad/");
  const state3 = loc3.searchParams.get("state") ?? "";
  await fetch(loc3.toString(), { redirect: "manual" });
  const cb4 = await fetch(base + "/auth/callback?code=q&state=" + encodeURIComponent(state3), { redirect: "manual" });
  const cv2 = ((cb4.headers.get("set-cookie") ?? "").match(/tg_sess=([0-9a-f]{64})/) ?? [])[1] ?? "";
  check("second login ok", cb4.status === 302 && cv2.length === 64, String(cb4.status));
  nowMs = T0 + 8 * 24 * 3600_000;
  const stale = await fetch(base + "/api/state", { headers: { cookie: "tg_sess=" + cv2 } });
  check("session expired after 7 days", stale.status === 401, String(stale.status));

  await dash.close();
  await new Promise<void>((r) => fake.close(() => r()));
}

void e2e()
  .then(() => {
    if (failures) {
      console.error(failures + " FAILURES");
      process.exit(1);
    }
    console.log("All dashboard checks passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("E2E crashed:", e);
    process.exit(1);
  });
