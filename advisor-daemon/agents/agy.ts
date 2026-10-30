/**
 * Run one consultation with the Antigravity CLI (`agy`, Gemini) headless:
 *
 *   agy --output-format json --mode plan --sandbox --settings <locked>
 *       [--conversation <id>] --print=<prompt>
 *
 * agy has no tool-allowlist flag, so read-only rests on these layers (tested
 * on agy 1.4.2 with a command the rules explicitly allow, `command(touch)`,
 * which does run without them):
 *  - `--mode plan`: with that allow rule, plan mode still did not run the
 *    command — the agent wrote a plan instead;
 *  - `--settings` replaces the GLOBAL permission scope for this run only (the
 *    user's settings.json is never written): an empty allow list, so the
 *    user's own global allow rules (e.g. `command(git commit)`) do not apply,
 *    and `deny: command(*)`, which beat a matching allow in the same test.
 *    agy's `project` and `shared` scopes are not replaced; the daemon runs in
 *    a neutral work dir, and plan mode applies regardless;
 *  - `--sandbox` restricts the terminal (not separately tested).
 * Headless mode cannot prompt, so an action with no matching allow rule is
 * refused and reported in `denied_actions` instead of hanging.
 *
 * The prompt goes in argv as `--print=<prompt>`: the `=` form keeps a prompt
 * starting with "-" from being read as a flag. Linux caps ONE argument at
 * 128 KiB (MAX_ARG_STRLEN), so a longer prompt is refused with a clear answer
 * (AGY_MAX_PROMPT_BYTES) instead of failing to spawn. Output is ONE JSON object:
 * {conversation_id, status, response, duration_seconds, usage, denied_actions?}.
 * agy reports tokens but no cost.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentAdapter, AgentResult, AgentRun } from "./types.js";
import { failedResult } from "./types.js";

/** Session-only settings: no allow rules, every command denied. */
export const AGY_LOCKED_SETTINGS = JSON.stringify({ permissions: { allow: [], deny: ["command(*)"] } });

/**
 * Without this, agy in plan mode sometimes reaches for a tool even for a
 * plain question, gets refused, and returns an empty response.
 */
export const AGY_TEXT_ONLY = "Answer in text only. Do not run commands, edit files, or write plans or artifacts.";

/** Under Linux's 128 KiB single-argument limit, with room for the instruction. */
export const AGY_MAX_PROMPT_BYTES = 100_000;

export function agyArgs(prompt: string, resumeSessionId?: string): string[] {
  return [
    "--output-format", "json",
    "--mode", "plan",
    "--sandbox",
    "--settings", AGY_LOCKED_SETTINGS,
    ...(resumeSessionId ? ["--conversation", resumeSessionId] : []),
    `--print=${AGY_TEXT_ONLY}\n\n${prompt}`,
  ];
}

/** Parse agy's JSON output into a result. Pure — unit-testable. */
export function parseAgyOutput(stdout: string, startedAt: number): AgentResult {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stdout.trim());
  } catch {
    return failedResult("❌ Gemini trả kết quả không đọc được (xem log daemon).", startedAt);
  }
  const usage = (o.usage as Record<string, unknown>) ?? {};
  const sessionId = typeof o.conversation_id === "string" ? o.conversation_id : "";
  const response = typeof o.response === "string" ? o.response.trim() : "";
  const ok = o.status === "SUCCESS";
  const denied = Array.isArray(o.denied_actions)
    ? o.denied_actions.map((d) => String((d as Record<string, unknown>)?.display_name ?? (d as Record<string, unknown>)?.action ?? "?"))
    : [];
  let report = response;
  if (!report) {
    report = denied.length
      ? `⚠️ Gemini không trả lời: nó muốn dùng công cụ bị chặn ở chế độ chỉ đọc (${denied.join(", ")}). Hỏi lại và yêu cầu trả lời bằng văn bản.`
      : ok
        ? "❌ Gemini kết thúc không có nội dung."
        : `❌ Gemini báo lỗi: ${String(o.status ?? "unknown")}`;
  }
  return {
    status: ok && response ? "done" : "failed",
    report,
    costUsd: 0,
    tokensIn: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    tokensOut: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    durationMs: typeof o.duration_seconds === "number" ? Math.round(o.duration_seconds * 1000) : Date.now() - startedAt,
    sessionId,
    incomplete: false,
  };
}

/** `maxTurns` is ignored: agy has no turn limit flag. */
export function runAgy(opts: AgentRun & { bin: string }): Promise<AgentResult> {
  const { bin, workdir, prompt, timeoutMs, resumeSessionId, log = () => {} } = opts;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > AGY_MAX_PROMPT_BYTES) {
      resolve(
        failedResult(
          `❌ Câu hỏi + ngữ cảnh quá dài cho Gemini (${Math.round(bytes / 1024)} KB, tối đa ${AGY_MAX_PROMPT_BYTES / 1000} KB) — rút gọn rồi hỏi lại.`,
          startedAt,
          resumeSessionId ?? "",
        ),
      );
      return;
    }
    const child: ChildProcess = spawn(bin, agyArgs(prompt, resumeSessionId), {
      cwd: workdir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const finish = (r: AgentResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // orphan guard for leftover subprocesses
      } catch {}
      resolve(r);
    };

    const timer = setTimeout(() => {
      log(`agy timeout after ${timeoutMs}ms — killing process group`);
      finish({
        ...failedResult(`⏱️ Gemini chưa trả lời sau ${Math.round(timeoutMs / 60000)} phút — đã dừng.`, startedAt, resumeSessionId ?? ""),
        status: "timeout",
      });
    }, timeoutMs);

    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < 4 * 1024 * 1024) out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      err = (err + c.toString()).slice(-2000);
    });
    child.on("error", (e) => finish(failedResult(`❌ Không chạy được agy: ${e.message}`, startedAt)));
    child.on("close", (code) => {
      if (err.trim()) log(`[agy:err] ${err.trim().slice(0, 300)}`);
      if (!out.trim()) {
        const why = err.trim().split("\n").pop()?.slice(0, 200) || `mã thoát ${code}`;
        return finish(failedResult(`❌ agy thoát trước khi có kết quả: ${why}`, startedAt, resumeSessionId ?? ""));
      }
      const r = parseAgyOutput(out, startedAt);
      finish(code === 0 ? r : { ...r, status: "failed" });
    });
  });
}

/**
 * The agy adapter. forget() only drops the daemon's registry entry: agy keeps
 * conversations in its own store and offers no CLI to delete one.
 */
export function agyAdapter(bin: string): AgentAdapter {
  return {
    id: "agy",
    bin,
    run: (opts) => runAgy({ ...opts, bin }),
    forget: () => false,
  };
}
