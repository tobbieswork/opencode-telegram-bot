/**
 * Run one consultation with the Claude Code CLI in headless mode:
 *
 *   claude -p --output-format stream-json --verbose --max-turns N
 *
 * The prompt goes on STDIN (never argv) so long/special-character prompts
 * can't break quoting. Output is NDJSON; the final `result` event carries
 * the report, cost, tokens and the session id (follow-ups use
 * `claude --resume`). A wall-clock timeout kills the whole process
 * group (detached spawn + kill -pgid).
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface ClaudeResult {
  status: "done" | "failed" | "timeout";
  /** The final Claude message — becomes the report body. */
  report: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  sessionId: string;
  /** True when the run ended before producing a result event. */
  incomplete: boolean;
}

/**
 * Read-only profile for the advisor (pure consultation): the model answers from
 * the context the caller provides — it may peek at files but never edits or runs
 * commands. Same tools Claude needs for the future "read the repo" advisor role.
 */
export const CLAUDE_ADVISOR_TOOLS = ["Read", "Grep", "Glob"];

export function runClaude(opts: {
  bin: string;
  workdir: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  /** When set, `claude --resume <id>` continues that session instead of a new one. */
  resumeSessionId?: string;
  /** Defaults to "plan" (read-only). */
  permissionMode?: "plan";
  /** Defaults to CLAUDE_ADVISOR_TOOLS (read-only). */
  allowedTools?: string[];
  log?: (line: string) => void;
}): Promise<ClaudeResult> {
  const {
    bin,
    workdir,
    prompt,
    maxTurns,
    timeoutMs,
    resumeSessionId,
    permissionMode = "plan",
    allowedTools = CLAUDE_ADVISOR_TOOLS,
    log = () => {},
  } = opts;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child: ChildProcess = spawn(
      bin,
      [
        "-p",
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", String(maxTurns),
        "--permission-mode", permissionMode,
        ...(allowedTools.length ? ["--allowedTools", allowedTools.join(",")] : []),
      ],
      { cwd: workdir, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    let settled = false;
    const finish = (r: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onStdout);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // orphan guard for leftover subprocesses
      } catch {}
      resolve(r);
    };

    const onTimeout = (): void => {
      log(`claude timeout after ${timeoutMs}ms — killing process group`);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      finish({
        status: "timeout",
        report: `⏱️ Task quá thời gian (${Math.round(timeoutMs / 60000)} phút) — đã dừng.\nXem log để biết Claude đã làm được gì trước đó.`,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - startedAt,
        sessionId: "",
        incomplete: true,
      });
    };
    const timer = setTimeout(onTimeout, timeoutMs);

    let buf = "";
    let sessionId = "";
    const onStdout = (chunk: Buffer): void => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          log(`[claude] ${line.slice(0, 200)}`);
          continue;
        }
        if (ev.type === "system" && typeof ev.session_id === "string") sessionId = ev.session_id;
        if (ev.type === "result") {
          const usage = (ev.usage as Record<string, unknown>) ?? {};
          const r: ClaudeResult = {
            status: ev.is_error ? "failed" : "done",
            report:
              typeof ev.result === "string" && ev.result.trim()
                ? ev.result
                : ev.is_error
                  ? `❌ Claude báo lỗi: ${String(ev.subtype ?? "unknown error")}`
                  : "❌ Claude kết thúc không có nội dung.",
            costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
            tokensIn: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
            tokensOut: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
            durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : Date.now() - startedAt,
            sessionId: (typeof ev.session_id === "string" && ev.session_id) || sessionId,
            incomplete: false,
          };
          clearTimeout(timer);
          finish(r);
        }
      }
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (c: Buffer) => log(`[claude:err] ${c.toString().trim().slice(0, 300)}`));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({
        status: "failed",
        report: `❌ Không chạy được claude: ${e.message}`,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - startedAt,
        sessionId: "",
        incomplete: true,
      });
    });
    child.on("close", () => {
      // Process exited without a result event (crash / killed externally).
      clearTimeout(timer);
      finish({
        status: "failed",
        report: "❌ Claude thoát trước khi có kết quả (xem log daemon).",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - startedAt,
        sessionId,
        incomplete: true,
      });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
