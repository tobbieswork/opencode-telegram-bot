/**
 * Integration test for the advisor daemon (advisor-daemon/advisor.ts): spawns
 * the REAL daemon with fake `claude` and `agy` binaries + bearer token + a
 * temp workroot, then drives it over HTTP:
 *  - /health (agent list, no path leak), 401 without / with a wrong token
 *  - claude: new session, resume (proves --resume reached claude), /forget
 *  - agy: alias "gemini", the read-only flags in argv, resume routed by the
 *    session registry (--conversation), a prompt starting with "-", and the
 *    failure shapes agy really produces (denied_actions, non-SUCCESS, crash)
 *  - validation: unknown agent, bad sessionId, oversized body (413)
 *  - a registry entry written before agents existed resumes with claude
 *  - a second daemon: default bind 127.0.0.1, a disabled agent is a 400
 *
 * The fake agy prints the JSON shape captured from agy 1.4.2.
 *
 * Run:  npx tsx scripts/test-advisor.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGY_TEXT_ONLY } from "../advisor-daemon/agents/agy.js";

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
if [ -n "$resume" ]; then sid="$resume"; echo "$resume" >> "$ADVISOR_WORKROOT/work/resume.marker"; else sid="gen-$$-$RANDOM"; fi
printf '{"type":"system","session_id":"%s","subtype":"init"}\\n' "$sid"
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok-from-fake","session_id":"%s","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":7},"duration_ms":42}\\n' "$sid"
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Fake agy: records its argv (NUL-separated) and answers like agy 1.4.2.
 *  Keywords in the prompt pick a failure shape: DENY, FAILSTATUS, CRASH. */
function writeFakeAgy(workroot: string): string {
  const p = join(workroot, "fake-agy.sh");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$ADVISOR_WORKROOT/work/agy.argv"
conv=""
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--conversation" ]; then conv="$a"; fi
  case "$a" in --print=*) prompt="\${a#--print=}";; esac
  prev="$a"
done
[ -n "$conv" ] || conv="c0ffee-$$-$RANDOM"
case "$prompt" in
  *CRASH*) echo "boom: agy fell over" >&2; exit 3;;
  *DENY*) printf '{"conversation_id":"%s","status":"SUCCESS","response":"","duration_seconds":1.5,"num_turns":1,"usage":{"input_tokens":3,"output_tokens":4},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}\\n' "$conv"; exit 0;;
  *FAILSTATUS*) printf '{"conversation_id":"%s","status":"ERROR","response":"","duration_seconds":0.2,"num_turns":0,"usage":{}}\\n' "$conv"; exit 0;;
esac
printf '{"conversation_id":"%s","status":"SUCCESS","response":"agy-ok\\\\n","duration_seconds":2.25,"num_turns":1,"usage":{"input_tokens":11,"output_tokens":13,"thinking_tokens":9,"cache_read_tokens":0,"total_tokens":24}}\\n' "$conv"
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Resolve once the daemon has printed `needle`; returns the full stdout so far. */
function waitFor(daemon: ChildProcess, needle: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    daemon.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.includes(needle)) {
        clearTimeout(t);
        resolve(buf);
      }
    });
    daemon.on("exit", () => reject(new Error("daemon exited before ready")));
  });
}

function startDaemon(env: Record<string, string>): ChildProcess {
  return spawn(TSX, [ADVISOR], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

function agyArgv(workroot: string): string[] {
  return readFileSync(join(workroot, "work", "agy.argv"), "utf8").split("\0").filter(Boolean);
}

async function main(): Promise<void> {
  const workroot = await mkdtemp(join(tmpdir(), "advisor-"));
  mkdirSync(join(workroot, "work"), { recursive: true });
  const fakeClaude = writeFakeClaude(workroot);
  const fakeAgy = writeFakeAgy(workroot);
  // A session recorded before agents existed (no "agent" field).
  writeFileSync(join(workroot, "sessions.json"), JSON.stringify({ "legacy-sid": { lastActive: Date.now(), turns: 1 } }));

  const daemon = startDaemon({
    ADVISOR_TOKEN: TOKEN,
    ADVISOR_WORKROOT: workroot,
    ADVISOR_AGENTS: "claude,agy",
    MAC_ADVISOR_CLAUDE_BIN: fakeClaude, // the pre-rename name still works
    ADVISOR_AGY_BIN: fakeAgy,
    ADVISOR_PORT: String(PORT),
    ADVISOR_HOST: "127.0.0.1",
    ADVISOR_MAX_TURNS: "2",
  });
  let stderrBuf = "";
  daemon.stderr?.on("data", (c) => (stderrBuf += c.toString()));
  let daemon2: ChildProcess | undefined;

  const base = `http://127.0.0.1:${PORT}`;
  const auth = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const post = async (path: string, body: unknown, headers: Record<string, string> = auth): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  try {
    await waitFor(daemon, "advisor daemon started", 15_000);

    // /health
    const health = await (await fetch(`${base}/health`)).json();
    check("health ok", health.ok === true, JSON.stringify(health));
    check("health lists both agents", JSON.stringify(health.agents) === '["claude","agy"]', JSON.stringify(health.agents));
    check("health leaks no binary path / cwd", !("claude" in health) && !("cwd" in health), JSON.stringify(health));
    check("legacy registry entry loaded", health.sessions === 1, `sessions=${health.sessions}`);

    // auth
    const noauth = await post("/ask", { message: "hi" }, { "content-type": "application/json" });
    check("ask without token → 401", noauth.status === 401, `got ${noauth.status}`);
    const wrong = await post("/ask", { message: "hi" }, { "content-type": "application/json", authorization: "Bearer test-tokeX" });
    check("ask with wrong token (same length) → 401", wrong.status === 401, `got ${wrong.status}`);

    // claude: new session (default agent = first configured)
    const ask1 = (await post("/ask", { message: "hi", context: "ctx" })).json;
    check("ask returns answer", ask1.answer === "ok-from-fake", JSON.stringify(ask1));
    check("ask status done", ask1.status === "done");
    check("default agent is claude", ask1.agent === "claude", String(ask1.agent));
    check("ask returns sessionId", typeof ask1.sessionId === "string" && (ask1.sessionId as string).length > 0, String(ask1.sessionId));
    const sid = ask1.sessionId as string;

    // claude: resume — proves --resume reached claude
    const ask2 = (await post("/ask", { sessionId: sid, message: "again" })).json;
    check("resume keeps same sessionId", ask2.sessionId === sid, `got ${ask2.sessionId} want ${sid}`);
    check("resume status done", ask2.status === "done");
    check("--resume flag reached claude", existsSync(join(workroot, "work", "resume.marker")));

    // legacy session (no agent field) resumes with claude
    const legacy = (await post("/ask", { sessionId: "legacy-sid", message: "old thread" })).json;
    check("legacy session routes to claude", legacy.agent === "claude" && legacy.sessionId === "legacy-sid", JSON.stringify(legacy));

    // agy via the "gemini" alias
    const g1 = (await post("/ask", { agent: "gemini", message: "postgres or mongo?" })).json;
    check("agy answers (alias gemini)", g1.answer === "agy-ok" && g1.status === "done" && g1.agent === "agy", JSON.stringify(g1));
    check("agy tokens + duration parsed", g1.tokensIn === 11 && g1.tokensOut === 13 && g1.durationMs === 2250, JSON.stringify(g1));
    const gsid = g1.sessionId as string;
    check("agy returns conversation id", typeof gsid === "string" && gsid.startsWith("c0ffee-"), String(gsid));
    let argv = agyArgv(workroot);
    check("agy runs in plan mode", argv.join(" ").includes("--mode plan"), argv.join(" "));
    check("agy runs sandboxed", argv.includes("--sandbox"), argv.join(" "));
    const settings = argv[argv.indexOf("--settings") + 1] ?? "";
    let locked = false;
    try {
      const s = JSON.parse(settings);
      locked = Array.isArray(s.permissions?.allow) && s.permissions.allow.length === 0 && s.permissions.deny?.includes("command(*)");
    } catch {}
    check("agy settings override: empty allow + deny commands", locked, settings);
    check("agy never gets --dangerously-skip-permissions", !argv.some((a) => a.includes("dangerously")), argv.join(" "));
    const printArg = argv.find((a) => a.startsWith("--print=")) ?? "";
    check("agy prompt carries the text-only instruction", printArg.includes(AGY_TEXT_ONLY) && printArg.includes("postgres or mongo?"), printArg);

    // agy resume: no agent named — the registry knows the session is agy's
    const g2 = (await post("/ask", { sessionId: gsid, message: "why?" })).json;
    argv = agyArgv(workroot);
    check("agy resume routed by registry", g2.agent === "agy" && g2.sessionId === gsid, JSON.stringify(g2));
    check("agy resume passes --conversation", argv[argv.indexOf("--conversation") + 1] === gsid, argv.join(" "));

    // a prompt that starts with "-" stays one --print= argument
    const dash = (await post("/ask", { agent: "agy", message: "--version is what I want to ask about" })).json;
    argv = agyArgv(workroot);
    check("dash-prefixed prompt answered", dash.status === "done", JSON.stringify(dash));
    check("dash-prefixed prompt kept inside --print=", argv.filter((a) => a.startsWith("--version")).length === 0, argv.join(" "));

    // agy failure shapes
    const deny = (await post("/ask", { agent: "agy", message: "DENY please" })).json;
    check("denied_actions → failed + names the tool", deny.status === "failed" && String(deny.answer).includes("RunCommand") && String(deny.answer).includes("chỉ đọc"), JSON.stringify(deny));
    const bad = (await post("/ask", { agent: "agy", message: "FAILSTATUS" })).json;
    check("non-SUCCESS status → failed + status shown", bad.status === "failed" && String(bad.answer).includes("ERROR"), JSON.stringify(bad));
    const crash = (await post("/ask", { agent: "agy", message: "CRASH now" })).json;
    check("agy crash → failed + stderr shown", crash.status === "failed" && String(crash.answer).includes("boom"), JSON.stringify(crash));

    // validation
    const unknown = await post("/ask", { agent: "gpt", message: "x" });
    check("unknown agent → 400", unknown.status === 400, `${unknown.status} ${JSON.stringify(unknown.json)}`);
    const traversal = await post("/forget", { sessionId: "../../etc/x" });
    check("path-like sessionId → 400", traversal.status === 400, `${traversal.status} ${JSON.stringify(traversal.json)}`);
    const dashId = await post("/ask", { sessionId: "--dangerously-skip-permissions", message: "x" });
    check("flag-like sessionId → 400", dashId.status === 400, `${dashId.status}`);
    const huge = await post("/ask", { message: "x".repeat(300 * 1024) });
    check("oversized body → 413", huge.status === 413, `got ${huge.status}`);

    // /forget (failed agy runs still created a conversation, so they stay tracked for the TTL)
    const before = (await (await fetch(`${base}/health`)).json()).sessions as number;
    const forget = (await post("/forget", { sessionId: sid })).json;
    check("forget ok", forget.ok === true, JSON.stringify(forget));
    const gforget = (await post("/forget", { sessionId: gsid })).json;
    check("forget agy session ok", gforget.ok === true, JSON.stringify(gforget));
    const health2 = await (await fetch(`${base}/health`)).json();
    check("forgotten sessions removed from registry", health2.sessions === before - 2, `sessions=${health2.sessions} before=${before}`);

    // second daemon: no ADVISOR_HOST → loopback; claude only → agy is a 400
    const port2 = PORT + 1;
    const root2 = await mkdtemp(join(tmpdir(), "advisor2-"));
    daemon2 = startDaemon({
      ADVISOR_TOKEN: TOKEN,
      ADVISOR_WORKROOT: root2,
      ADVISOR_CLAUDE_BIN: fakeClaude,
      ADVISOR_PORT: String(port2),
      ADVISOR_HOST: "",
      MAC_ADVISOR_HOST: "",
      ADVISOR_AGENTS: "",
    });
    const out2 = await waitFor(daemon2, "advisor daemon started", 15_000);
    check("default bind is 127.0.0.1", out2.includes(`port ${port2}/127.0.0.1`), out2.trim());
    const r2 = await fetch(`http://127.0.0.1:${port2}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ agent: "agy", message: "x" }) });
    const j2 = (await r2.json()) as Record<string, unknown>;
    check("disabled agent → 400 naming it", r2.status === 400 && String(j2.error).includes("Gemini"), `${r2.status} ${JSON.stringify(j2)}`);
    rmSync(root2, { recursive: true, force: true });
  } finally {
    daemon.kill("SIGKILL");
    daemon2?.kill("SIGKILL");
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
