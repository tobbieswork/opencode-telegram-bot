/**
 * Deterministic secret redaction for all outbound Telegram message text.
 *
 * Agent output is relayed by the bot into Telegram (DM and group topics) — a
 * third-party channel the agent does not control. If a session leaks a token
 * into its output (env dumps, .env reads, credential-file contents, command
 * output), the relay must not carry it to that channel. Same class of incident
 * as the Claude Code User-Agent email leak (anthropics/claude-code#107757,
 * 2026-11-05): agent tooling leaking credentials into third-party traffic.
 *
 * The guard is a pure, always-on function with no config surface: it replaces
 * only strings matching KNOWN secret formats, keeping a first4…last4
 * fingerprint (the repo's secret-display convention) so the user can still tell
 * WHICH kind of credential was masked. Everything else passes through
 * byte-identical, and the replacements never re-match (idempotent).
 */

/** Replace one matched secret with its first4…last4 fingerprint. */
function mask(m: string): string {
  return m.length > 8 ? `${m.slice(0, 4)}…${m.slice(-4)}` : "***";
}

const PATTERNS: Array<[RegExp, (m: string) => string]> = [
  // Private key blocks: drop the whole block — the body IS the secret.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => "[REDACTED private key]"],
  // GitHub fine-grained PATs (github_pat_…), then classic PATs (ghp_/gho_/ghu_/ghr_/ghs_…).
  [/\bgithub_pat_[A-Za-z0-9_]{22,255}/g, mask],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}/g, mask],
  // Telegram bot tokens (chatId:secret).
  [/\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g, mask],
  // OpenAI / Anthropic API keys (sk-, sk-proj-, sk-ant-…).
  [/\bsk-[A-Za-z0-9_-]{16,255}\b/g, mask],
  // AWS access key IDs.
  [/\bAKIA[0-9A-Z]{16}\b/g, mask],
  // Slack bot/user/app tokens.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g, mask],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, mask],
];

/** Replace known secret formats with first4…last4 fingerprints. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
