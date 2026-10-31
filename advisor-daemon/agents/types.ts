/**
 * The contract every advisor agent adapter implements. The daemon only talks
 * to adapters through this — adding an agent means one new file in agents/
 * plus an entry in src/advisor/agents.ts.
 */
import type { AgentId } from "../../src/advisor/agents.js";

export interface AgentResult {
  status: "done" | "failed" | "timeout";
  /** The agent's final message — becomes the answer. */
  report: string;
  /** 0 when the agent does not report cost (agy). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  /** The agent's own session/conversation id ("" when none came back). */
  sessionId: string;
  /** True when the run ended before producing a final result. */
  incomplete: boolean;
}

export interface AgentRun {
  workdir: string;
  prompt: string;
  /** Upper bound on agent turns, for agents that support it. */
  maxTurns: number;
  timeoutMs: number;
  /** Continue this session instead of starting a new one. */
  resumeSessionId?: string;
  log?: (line: string) => void;
}

export interface AgentAdapter {
  id: AgentId;
  /** The CLI binary (absolute path when the installer resolved it). */
  bin: string;
  run(opts: AgentRun): Promise<AgentResult>;
  /** Drop the agent's stored session, best-effort. True when something was deleted. */
  forget(sessionId: string): boolean;
  /** True when the agent's store still has this session (claude: its .jsonl file; agy: always). */
  exists(sessionId: string): boolean;
}

/** A failed result with no agent output (spawn error, crash, …). */
export function failedResult(report: string, startedAt: number, sessionId = ""): AgentResult {
  return {
    status: "failed",
    report,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: Date.now() - startedAt,
    sessionId,
    incomplete: true,
  };
}
