/**
 * Unit test for the hub advisor client (src/advisor/advisor-client.ts) against a
 * fake advisor HTTP server: /ask (new + resume), /forget, /health, and the
 * "offline" path when nothing is listening.
 *
 * Run:  npx tsx scripts/test-advisor-client.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { askClaude, forgetClaude, advisorHealth, AdvisorError } from "../src/advisor/advisor-client.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
void REPO;

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

interface Seen {
  auth: string;
  body: string;
}
const seen: Seen = { auth: "", body: "" };

function startFake(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        seen.auth = req.headers.authorization ?? "";
        seen.body = s;
        const url = new URL(req.url ?? "/", "http://x");
        const send = (code: number, obj: unknown): void => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (url.pathname === "/health") return send(200, { ok: true, sessions: 2 });
        if (!seen.auth) return send(401, { error: "unauthorized" });
        if (url.pathname === "/ask") {
          const q = JSON.parse(s || "{}");
          const sid = typeof q.sessionId === "string" ? q.sessionId : "new-sid";
          return send(200, {
            answer: "advice",
            status: "done",
            sessionId: sid,
            costUsd: 0.02,
            tokensIn: 10,
            tokensOut: 20,
            durationMs: 7,
            incomplete: false,
          });
        }
        if (url.pathname === "/forget") return send(200, { ok: true });
        return send(404, { error: "nf" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function main(): Promise<void> {
  const { base, close } = await startFake();
  const ep = { url: base, token: "t" };
  try {
    // health
    const h = await advisorHealth(ep);
    check("health ok", h !== null && h.ok === true && h.sessions === 2, JSON.stringify(h));

    // ask new
    const a1 = await askClaude(ep, { message: "hi", context: "ctx" });
    check("ask new → answer", a1.answer === "advice" && a1.status === "done", JSON.stringify(a1));
    check("ask new → sessionId", a1.sessionId === "new-sid", a1.sessionId);
    check("ask sends token", seen.auth === "Bearer t", seen.auth);
    check("ask sends context", JSON.parse(seen.body).context === "ctx", seen.body);

    // ask resume (sessionId passes through)
    const a2 = await askClaude(ep, { sessionId: "new-sid", message: "more" });
    check("ask resume keeps sessionId", a2.sessionId === "new-sid", a2.sessionId);
    check("ask resume passes sessionId", JSON.parse(seen.body).sessionId === "new-sid", seen.body);

    // forget
    await forgetClaude(ep, "new-sid");
    check("forget → sessionId in body", JSON.parse(seen.body).sessionId === "new-sid", seen.body);

    // offline (nothing on this port)
    const offline = await advisorHealth({ url: "http://127.0.0.1:1", token: "t" }, 1500);
    check("health offline → null", offline === null, JSON.stringify(offline));

    // offline /ask → AdvisorError kind offline
    let threw: unknown = null;
    try {
      await askClaude({ url: "http://127.0.0.1:1", token: "t" }, { message: "x" }, 1500);
    } catch (e) {
      threw = e;
    }
    check("ask offline → AdvisorError(offline)", threw instanceof AdvisorError && threw.kind === "offline", String(threw));
  } finally {
    await close();
  }

  console.log(failures === 0 ? "\n  ALL OK (advisor-client)" : `\n  ${failures} FAILURE(S) (advisor-client)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("advisor-client test crashed:", e);
  process.exit(1);
});
