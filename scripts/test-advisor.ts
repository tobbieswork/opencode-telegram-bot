/**
 * Integration test for the Claude advisor daemon (advisor-daemon/advisor.ts):
 * spawns the REAL daemon with a fake `claude` binary + bearer token + a temp
 * workroot, then drives it over HTTP — /health, /ask (new session), /ask
 * (resume — proves the --resume flag reached claude), /forget, and the 401
 * path when the token is missing.
 *
 * Run:  npx tsx scripts/test-advisor.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const ADVISOR = join(REPO, "advisor-daemon", "advisor.ts");
const TOKEN = "test-token";
const PORT = 18500 + Math.floor(Math.random() * 4000);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Fake claude: emits a system + result event. If --resume <id> is present it
 *  echoes that id back (continuing the session) and writes a marker file. */
function writeFakeClaude(workroot: string): string {
  const p = join(workroot, "fake-claude.sh");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
cat > /dev/null
resume=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ]; then resume="$a"; fi
  prev="$a"
done
if [ -n "$resume" ]; then sid="$resume"; echo resumed >> "$MAC_ADVISOR_WORKROOT/work/resume.marker"; else sid="gen-$$-$(date +%s%N)"; fi
printf '{"type":"system","session_id":"%s","subtype":"init"}\\n' "$sid"
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok-from-fake","session_id":"%s","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":7},"duration_ms":42}\\n' "$sid"
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}

function waitFor(daemon: ChildProcess, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    const onData = (c: Buffer): void => {
      daemon.stdout?.off("data", onData);
      if (c.toString().includes(needle)) {
        clearTimeout(t);
        resolve();
      } else {
        // keep listening for later chunks
        daemon.stdout?.on("data", onData);
      }
    };
    daemon.stdout?.on("data", onData);
    daemon.on("exit", () => reject(new Error("daemon exited before ready")));
  });
}

async function main(): Promise<void> {
  const workroot = await mkdtemp(join(tmpdir(), "advisor-"));
  rmSync(join(workroot, "work"), { recursive: true, force: true });
  const fake = writeFakeClaude(workroot);

  const daemon = spawn(TSX, [ADVISOR], {
    cwd: REPO,
    env: {
      ...process.env,
      MAC_ADVISOR_TOKEN: TOKEN,
      MAC_ADVISOR_WORKROOT: workroot,
      MAC_ADVISOR_CLAUDE_BIN: fake,
      MAC_ADVISOR_PORT: String(PORT),
      MAC_ADVISOR_HOST: "127.0.0.1",
      MAC_ADVISOR_MAX_TURNS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  daemon.stderr?.on("data", (c) => (stderrBuf += c.toString()));

  try {
    await waitFor(daemon, "advisor daemon started", 15_000);

    const base = `http://127.0.0.1:${PORT}`;
    const auth = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };

    // /health
    const health = await (await fetch(`${base}/health`)).json();
    check("health ok", health.ok === true, JSON.stringify(health));

    // /ask without token → 401
    const noauth = await fetch(`${base}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    check("ask without token → 401", noauth.status === 401, `got ${noauth.status}`);

    // /ask new session
    const ask1 = await (await fetch(`${base}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ message: "hi", context: "ctx" }) })).json();
    check("ask returns answer", ask1.answer === "ok-from-fake", JSON.stringify(ask1));
    check("ask status done", ask1.status === "done");
    check("ask returns sessionId", typeof ask1.sessionId === "string" && ask1.sessionId.length > 0, String(ask1.sessionId));
    const sid: string = ask1.sessionId;

    // /ask resume — proves --resume reached claude
    const ask2 = await (await fetch(`${base}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: sid, message: "again" }) })).json();
    check("resume keeps same sessionId", ask2.sessionId === sid, `got ${ask2.sessionId} want ${sid}`);
    check("resume status done", ask2.status === "done");
    check("--resume flag reached claude", existsSync(join(workroot, "work", "resume.marker")));

    // /forget
    const forget = await (await fetch(`${base}/forget`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: sid }) })).json();
    check("forget ok", forget.ok === true, JSON.stringify(forget));

    // registry dropped the session after forget
    const health2 = await (await fetch(`${base}/health`)).json();
    check("session removed from registry after forget", health2.sessions === 0, `sessions=${health2.sessions}`);
  } finally {
    daemon.kill("SIGKILL");
    rmSync(workroot, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\n  ALL OK (advisor)" : `\n  ${failures} FAILURE(S) (advisor)`);
  if (stderrBuf.trim()) console.error("[daemon stderr]\n" + stderrBuf.trim());
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("advisor test crashed:", e);
  process.exit(1);
});
