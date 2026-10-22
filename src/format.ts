/** Escape text for Telegram HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * OpenCode prefixes assistant text with conversation tags like "§2§ ".
 * Strip those (at string start or after whitespace) so replies read cleanly.
 */
export function stripTags(s: string): string {
  return s.replace(/(?:^|(?<=[\s\n]))§\d+§\s*/g, "").trim();
}

/** Truncate a string, appending an ellipsis. */
export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** Compact number for display: "1.2K" / "3.4M" (plain if < 1000). */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1e6) return trim(n / 1e6) + "M";
  if (abs >= 1e3) return trim(n / 1e3) + "K";
  return String(Math.round(n));
}

/** Relative time from a Unix-epoch-ms timestamp ("3m ago" style). */
export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Split text into chunks of at most `max` chars, preferring line boundaries.
 * Safe for sending escaped plain text to Telegram (4096 char limit).
 */
export function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) out.push(rest);
  return out;
}

/**
 * Convert a single Markdown "block" into a self-contained Telegram-HTML
 * fragment. Input is raw text; it is HTML-escaped first, then a safe subset of
 * Markdown (bold/italic/strikethrough/code/headings/links/bullets) is mapped to
 * Telegram's supported HTML tags. Only balanced, supported tags are emitted, so
 * any fragment is safe to send on its own — this is what keeps long replies from
 * tripping Telegram's "can't parse entities" (400) when split across messages.
 */
function blockToHtml(raw: string): string {
  // A fenced code block: everything inside is literal (escaped, no transforms).
  if (raw.startsWith("```")) {
    const inner = raw
      .replace(/^```\w*\s?\n?/, "")
      .replace(/```\s*$/, "")
      .replace(/\n$/, "");
    return `<pre><code>${esc(inner)}</code></pre>`;
  }
  let out = esc(raw);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^_]+)__/g, "<b>$1</b>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // Single-star / single-underscore italic. The boundaries keep us from touching
  // a leading/trailing `*`/`_` (already bolded) or identifiers like snake_case
  // and file names (a letter is never a boundary).
  out = out.replace(/(^|[^*A-Za-z0-9])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^_A-Za-z0-9])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
  out = out.replace(/^#{1,6}\s+(.*)$/, "<b>$1</b>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/^(\s*)[-*]\s+/, "$1• ");
  return out;
}

/** Split a string into pieces of at most `max` chars on word boundaries. */
function hardSplit(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

const PRE_OPEN = "<pre><code>";
const PRE_CLOSE = "</code></pre>";

// ── Tables ─────────────────────────────────────────────────────────────────

/** Max total width (chars) for a table to render as an aligned monospace block. */
const TABLE_PRE_MAX_WIDTH = 40;
/** Max columns for the monospace form — beyond that columns squeeze a phone screen. */
const TABLE_PRE_MAX_COLS = 3;

/** Split a GFM table line into trimmed cells (honors escaped pipes `\|`). */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/g)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.indexOf("|", 1) !== -1;
}

function isTableSepLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.includes("-")) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/g);
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

interface ParsedTable {
  header: string[];
  rows: string[][];
}

function parseTable(lines: string[]): ParsedTable {
  const cells = lines.map(splitRow);
  const ncols = Math.max(...cells.map((r) => r.length));
  const norm = cells.map((r) => {
    const c = r.slice();
    while (c.length < ncols) c.push("");
    return c;
  });
  const header = norm[0];
  const rows = norm.slice(2).filter((r) => r.some((c) => c !== ""));
  return { header, rows };
}

/**
 * Render a parsed table as message-safe HTML units. Narrow tables (≤
 * TABLE_PRE_MAX_WIDTH chars, ≤ TABLE_PRE_MAX_COLS columns) become an aligned
 * monospace block so columns stay straight; wider tables become a bullet list
 * (first cell = row label, remaining columns as "header: value" pairs) which
 * wraps gracefully on a phone. A monospace table taller than one message is
 * split at row boundaries, repeating the header on continuation messages.
 */
function tableToUnits(t: ParsedTable, max: number): string[] {
  const ncols = t.header.length;
  // Widths are measured on the escaped text: escaping happens before padding,
  // so padding on escaped widths keeps every rendered line exactly equal.
  const colW: number[] = [];
  for (let c = 0; c < ncols; c++) {
    let w = esc(t.header[c]).length;
    for (const r of t.rows) w = Math.max(w, esc(r[c]).length);
    colW.push(w);
  }
  const totalWidth = 2 + colW.reduce((s, w) => s + w + 2, 0);

  if (totalWidth > TABLE_PRE_MAX_WIDTH || ncols > TABLE_PRE_MAX_COLS) {
    const units: string[] = [];
    for (const r of t.rows) {
      let raw: string;
      if (ncols === 1) raw = `• ${r[0]}`;
      else if (ncols === 2) raw = `• **${r[0]}:** ${r[1]}`.replace(/\s+$/, "");
      else {
        const rest = r
          .slice(1)
          .map((c, i) => (t.header[i + 1] ? `${t.header[i + 1]}: ${c}` : c))
          .filter(Boolean)
          .join(" · ");
        raw = rest ? `• **${r[0]}** · ${rest}` : `• ${r[0]}`;
      }
      const html = blockToHtml(raw);
      if (html.length > max) for (const p of hardSplit(raw, max)) units.push(blockToHtml(p));
      else units.push(html);
    }
    return units;
  }

  const line = (cells: string[]) =>
    "| " + cells.map((c, i) => esc(c).padEnd(colW[i])).join(" | ") + " |";
  const headerLine = line(t.header);
  const sepLine = "|" + colW.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const cap = max - PRE_OPEN.length - PRE_CLOSE.length;
  const units: string[] = [];
  let group: string[] = [];
  let first = true;
  const push = (): void => {
    if (!group.length) return;
    const head = first ? headerLine + "\n" + sepLine : headerLine;
    units.push(PRE_OPEN + head + "\n" + group.join("\n") + PRE_CLOSE);
    group = [];
    first = false;
  };
  for (const l of t.rows.map(line)) {
    const headLen = first ? headerLine.length + 1 + sepLine.length + 1 : headerLine.length + 1;
    const groupLen = group.length ? group.join("\n").length + 1 : 0;
    if (headLen + groupLen + l.length > cap) push();
    group.push(l);
  }
  push();
  return units;
}

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Turn a Markdown-ish reply into one or more Telegram-HTML messages, each at
 * most `max` chars with every tag balanced within its own message. Splits at
 * code-fence / table-row / line / word boundaries, so a long reply is never
 * cut in the middle of a tag (which would make Telegram reject the whole
 * message) and a table is never rendered as ragged plain text.
 */
export function mdToHtmlChunks(text: string, max: number): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // Group lines into self-contained HTML units: a fenced code block is one
  // unit; a GFM table is one (or a few) units; otherwise each line is its own
  // unit (blank lines are kept for paragraph spacing).
  const units: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [line];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        buf.push(lines[i]);
        i++;
      }
      const inner = buf
        .join("\n")
        .replace(/^```\w*\s?\n?/, "")
        .replace(/```\s*$/, "")
        .replace(/\n$/, "");
      const pre = PRE_OPEN + esc(inner) + PRE_CLOSE;
      if (pre.length > max) {
        const cap = max - PRE_OPEN.length - PRE_CLOSE.length;
        for (const piece of hardSplit(esc(inner), cap)) units.push(PRE_OPEN + piece + PRE_CLOSE);
      } else {
        units.push(pre);
      }
    } else if (isTableRow(line) && i + 1 < lines.length && isTableSepLine(lines[i + 1])) {
      const run: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        run.push(lines[i]);
        i++;
      }
      units.push(...tableToUnits(parseTable(run), max));
    } else {
      const html = blockToHtml(line);
      if (html.length > max) for (const p of hardSplit(line, max)) units.push(blockToHtml(p));
      else units.push(html);
      i++;
    }
  }

  // Pack units into messages of at most `max` chars. Every unit is
  // self-contained (all tags balanced), so any concatenation is sendable.
  const out: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };
  for (const u of units) {
    if (u.length > max) {
      flush();
      out.push(u);
      continue;
    }
    if (cur && (cur + "\n" + u).length > max) flush();
    cur = cur ? cur + "\n" + u : u;
  }
  flush();
  return out;
}
