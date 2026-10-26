/**
 * Pure formatting logic for the /usage command (no I/O — testable like
 * reminders.ts).
 *
 * The question this answers: "how close is each session to its context
 * window?" Cumulative session tokens say how much was CONSUMED in total, but
 * what decides overflow is the CURRENT context size — the newest assistant
 * step's input+cache-read tokens versus the model's context limit. That is why
 * a row carries both numbers.
 */

export interface UsageRow {
  /** Display label: "manager", a worker name, or the short session id. */
  label: string;
  /** The session id this row was built from (dedup key; not rendered). */
  id: string;
  /** Current context size in tokens (newest LLM step); undefined when unknown. */
  current?: number;
  /** The model's context window in tokens; undefined when the model is unknown. */
  limit?: number;
  /** Cumulative input tokens for the whole session (context sent, all steps). */
  cumInput: number;
  /** Cumulative output tokens for the whole session. */
  cumOutput: number;
}

/** Model + context of the newest LLM step, extracted from a message list. */
export interface AssistantInfo {
  model?: { id: string; providerID: string };
  /**
   * The prompt size of that step in tokens: input + cache.read + cache.write.
   * All three are part of the prompt sent to the model, so all three count
   * against the context window (a step that just wrote the cache has a large
   * cache.write and a small input — reading only input+read would show 5%
   * where the prompt was actually near the limit).
   */
  context?: number;
}

/**
 * Model + context of the NEWEST assistant message carrying them, from a raw
 * `message.list` array in ANY order. The API's ordering is not a stable
 * contract (1.x returned oldest-first, 2.x newest-first), so the list is
 * sorted by time.created here instead of trusting positions. The newest
 * assistant message in flight may not have token stats yet — in that case the
 * context is the newest COMPLETED step, which is exactly "how full is the
 * context right now" (the in-flight step is at least that big).
 */
export function newestAssistantInfo(msgs: any[]): AssistantInfo {
  const created = (m: any) => m?.info?.time?.created ?? m?.time?.created ?? 0;
  const sorted = [...(msgs ?? [])].sort((a, b) => created(b) - created(a));
  const out: AssistantInfo = {};
  for (const m of sorted) {
    const info = m?.info ?? m;
    if (info?.type !== "assistant" && info?.role !== "assistant") continue;
    if (!out.model && info?.model?.id) out.model = { id: info.model.id, providerID: info.model.providerID ?? "?" };
    if (out.context === undefined) {
      const t = info?.tokens ?? m?.tokens;
      const n =
        (typeof t?.input === "number" ? t.input : 0) +
        (typeof t?.cache?.read === "number" ? t.cache.read : 0) +
        (typeof t?.cache?.write === "number" ? t.cache.write : 0);
      if (n > 0) out.context = n;
    }
    if (out.model && out.context !== undefined) break;
  }
  return out;
}

export interface UsageOpts {
  /** Percentage at/above which a row gets the warning mark (default 80). */
  warnPct?: number;
  /** Maximum number of rows in the report (default 10); extras are counted. */
  maxRows?: number;
}

const DEFAULT_WARN_PCT = 80;
const DEFAULT_MAX_ROWS = 10;

/** Percent of the context window in use; undefined when either side is unknown. */
export function pctOf(current?: number, limit?: number): number | undefined {
  if (!current || !limit || limit <= 0) return undefined;
  return Math.round((current / limit) * 100);
}

/** Compact token notation: 980 → "980", 12345 → "12.3K", 2400000 → "2.4M". */
export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  // Round BEFORE choosing the unit: switch to M exactly when the one-decimal
  // K form would overflow to "1000K" (999 950 → 1.0M), so the output is never
  // an out-of-range unit like "1000K" or a value rounded away from its unit.
  if (n >= 999_950) return trimTrailing((n / 1_000_000).toFixed(1)) + "M";
  if (n >= 1_000) return trimTrailing((n / 1_000).toFixed(1)) + "K";
  return String(Math.round(n));
}

function trimTrailing(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Sort for display: highest window pressure first (rows without a known
 * percentage go last), then by cumulative input so the biggest consumers are
 * still easy to find among the unknowns.
 */
export function sortUsage(rows: UsageRow[]): UsageRow[] {
  return [...rows].sort((a, b) => {
    const pa = pctOf(a.current, a.limit);
    const pb = pctOf(b.current, b.limit);
    if (pa !== undefined && pb !== undefined && pa !== pb) return pb - pa;
    if (pa === undefined && pb !== undefined) return 1;
    if (pa !== undefined && pb === undefined) return -1;
    return b.cumInput - a.cumInput;
  });
}

/**
 * Render the report as Telegram-HTML lines. `esc` is injected by the caller
 * (bot.ts owns the HTML-escaping helper) so this module stays dependency-free.
 */
export function formatUsageReport(
  rows: UsageRow[],
  esc: (s: string) => string,
  opts: UsageOpts = {},
): string[] {
  const warnPct = opts.warnPct ?? DEFAULT_WARN_PCT;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  if (rows.length === 0) {
    return ["📊 <b>Usage theo session</b>", "Chưa có session nào được theo dõi."];
  }

  const sorted = sortUsage(rows).slice(0, Math.max(1, maxRows));
  const hidden = rows.length - sorted.length;
  const warned = rows.filter((r) => (pctOf(r.current, r.limit) ?? 0) >= warnPct).length;

  const lines: string[] = [];
  lines.push(
    `📊 <b>Usage theo session</b> — ${rows.length} session${warned ? ` · ⚠️ ${warned} trên ${warnPct}%` : ""}`,
  );
  for (const r of sorted) {
    const p = pctOf(r.current, r.limit);
    const mark = p !== undefined && p >= warnPct ? "⚠️ " : "";
    const ctx =
      r.current !== undefined || r.limit !== undefined
        ? `${r.current !== undefined ? fmtTok(r.current) : "—"}/${r.limit !== undefined ? fmtTok(r.limit) : "—"}${p !== undefined ? ` (${p}%)` : ""}`
        : "—";
    lines.push(`${mark}<b>${esc(r.label)}</b> · ${ctx} · cum ${fmtTok(r.cumInput + r.cumOutput)}`);
  }
  if (hidden > 0) lines.push(`… +${hidden} session khác (ít áp lực hơn)`);

  const totalIn = rows.reduce((s, r) => s + r.cumInput, 0);
  const totalOut = rows.reduce((s, r) => s + r.cumOutput, 0);
  lines.push("");
  lines.push(`Tổng cumulative: ${fmtTok(totalIn)} in / ${fmtTok(totalOut)} out`);
  lines.push(`<i>ctx = context hiện tại / cửa sổ của model · cum = tổng tokens cả phiên</i>`);
  return lines;
}
