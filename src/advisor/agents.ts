/**
 * The agents an advisor daemon can run. Shared by the hub and the daemon
 * (advisor-daemon/ imports it) so both sides agree on the ids, the display
 * labels, and the words a user may type after /ask.
 *
 * The id is the CLI the daemon runs: `claude` (Claude Code) and `agy` (the
 * Antigravity CLI, Gemini). Users may also type an alias ("gemini").
 */
export type AgentId = "claude" | "agy";

export interface AgentInfo {
  id: AgentId;
  /** Shown in topic names and messages. */
  label: string;
  /** Extra words that select this agent (lowercase). */
  aliases: string[];
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: { id: "claude", label: "Claude", aliases: [] },
  agy: { id: "agy", label: "Gemini", aliases: ["gemini"] },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** A thread or registry entry written before agents existed was always Claude. */
export const LEGACY_AGENT: AgentId = "claude";

/** Map a word ("Gemini", "agy", "claude") to an agent id; undefined when unknown. */
export function resolveAgent(word: string | undefined): AgentId | undefined {
  const w = (word ?? "").trim().toLowerCase();
  if (!w) return undefined;
  for (const a of Object.values(AGENTS)) if (a.id === w || a.aliases.includes(w)) return a.id;
  return undefined;
}

/** Display label of an agent id (legacy/missing → Claude; unknown → the raw id). */
export function agentLabel(id: string | undefined): string {
  if (!id) return AGENTS[LEGACY_AGENT].label;
  const known = resolveAgent(id);
  return known ? AGENTS[known].label : id;
}

/**
 * Session ids reach a CLI argv and (for Claude) a file name, so only plain ids
 * are accepted — no path separators, no leading dash.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}
