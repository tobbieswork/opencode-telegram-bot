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

/**
 * Turn a Markdown-ish reply into one or more Telegram-HTML messages, each at
 * most `max` chars with every tag balanced within its own message. Splits at
 * code-fence / line / word boundaries, so a long reply is never cut in the
 * middle of a tag (which would make Telegram reject the whole message).
 */
export function mdToHtmlChunks(text: string, max: number): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // Group lines into blocks: a fenced code block is one atomic unit; otherwise
  // each line is its own block (blank lines are kept for paragraph spacing).
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^```/.test(lines[i])) {
      const buf: string[] = [lines[i]];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(buf.join("\n"));
    } else {
      blocks.push(lines[i]);
      i++;
    }
  }

  const out: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };

  for (const block of blocks) {
    const html = blockToHtml(block);
    if (html.length > max) {
      // A single block bigger than one message: break it into safe sub-pieces.
      flush();
      if (block.startsWith("```")) {
        const inner = block
          .replace(/^```\w*\s?\n?/, "")
          .replace(/```\s*$/, "")
          .replace(/\n$/, "");
        const cap = max - "<pre><code>".length - "</code></pre>".length;
        for (const piece of hardSplit(esc(inner), cap)) out.push(`<pre><code>${piece}</code></pre>`);
      } else {
        for (const piece of hardSplit(block, max)) out.push(blockToHtml(piece));
      }
      continue;
    }
    if (cur && (cur + "\n" + html).length > max) flush();
    cur = cur ? cur + "\n" + html : html;
  }
  flush();
  return out;
}
