/**
 * Rich-message (Telegram Bot API 10.1+) helpers for FINAL model replies.
 *
 * A single rich message holds up to 32 768 UTF-8 characters and 500 blocks, so
 * almost every model reply fits in one sendRichMessage — no chunking at all.
 * Only the rare >LIMIT tail is split, and we split at ~30 000 chars (a margin
 * under the 32 768 hard limit). JS `String.length` counts UTF-16 code units
 * while the limit counts code points, so that margin also absorbs astral emoji
 * (2 code units → 1 code point). The 500-block cap is deliberately NOT tracked:
 * a reply of ~500+ paragraphs/lists/tables would exceed it, but that is an
 * untested edge we accept for Phase 1 (eval doc §4.3).
 */
export const RICH_CHUNK_LIMIT = 30000;

/**
 * Split markdown into rich-message chunks. Short text (≤ `max`) is returned
 * whole as a single chunk; longer text is split into pieces of ≤ `max`,
 * preferring newline boundaries (the newline ends the chunk) and falling back
 * to a hard cut when no boundary is near. Never emits an empty chunk.
 */
export function richMarkdownChunks(text: string, max: number = RICH_CHUNK_LIMIT): string[] {
  if (text.length <= max) return text ? [text] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl > i) end = nl + 1; // break on the newline (newline stays in this chunk)
    }
    chunks.push(text.slice(i, end));
    i = end; // end > i always, so the loop always advances
  }
  return chunks.filter((c) => c.length > 0);
}
