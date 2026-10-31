import { mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, Telegram } from "./telegram.js";

/** The media kinds this feature accepts — exactly what the model can read. */
export interface UploadMedia {
  kind: "document" | "photo";
  fileId: string;
  fileName?: string; // document only
  fileSize?: number; // bytes (metadata from Telegram)
  mimeType?: string;
}

/** Total cap on data/uploads; the startup sweep trims to this (v1: not configurable). */
export const UPLOADS_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/**
 * The one media payload the model can consume: a document (text/PDF/code/zip)
 * or a photo (the read tool attaches images to the model). Photos arrive as an
 * array of sizes — the LARGEST (by file_size) is picked. Everything else
 * (video/audio/voice/sticker/animation) returns null → the existing
 * noteNonText decline path, unchanged.
 */
export function extractMedia(m: Message): UploadMedia | null {
  if (m.document) {
    const d = m.document;
    const fileId = typeof d.file_id === "string" ? d.file_id : "";
    if (!fileId) return null;
    return {
      kind: "document",
      fileId,
      fileName: typeof d.file_name === "string" ? d.file_name : undefined,
      fileSize: typeof d.file_size === "number" ? d.file_size : undefined,
      mimeType: typeof d.mime_type === "string" ? d.mime_type : undefined,
    };
  }
  if (m.photo && m.photo.length > 0) {
    const p = m.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
    const fileId = typeof p.file_id === "string" ? p.file_id : "";
    if (!fileId) return null;
    return {
      kind: "photo",
      fileId,
      fileSize: typeof p.file_size === "number" ? p.file_size : undefined,
      mimeType: "image/jpeg",
    };
  }
  return null;
}

/**
 * A safe basename for saving an upload: no path separator survives (so no
 * traversal is possible), no `..`/`.` segments, Unicode kept, max 100 chars.
 * Empty/odd names fall back to `<kind>-<yyyyMMdd-HHmmss>[.<ext>]`; a name
 * already on disk (per `exists`) gets `-1`, `-2`, … appended.
 */
export function sanitizeFileName(
  name: string | undefined,
  kind: string,
  ts: number,
  exists: (p: string) => boolean,
): string {
  let base = (name ?? "")
    .split(/[/\\]+/) // path segments (either separator)
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .pop()
    ?.trim() ?? "";
  if (!base || /^\.*$/.test(base)) base = fallbackName(kind, ts, name);
  base = base.slice(0, 100);
  if (!exists(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const cand = `${stem}-${i}${ext}`.slice(0, 100);
    if (!exists(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`.slice(0, 100);
}

/** `<kind>-<yyyyMMdd-HHmmss>[.<ext>]` — the fallback for empty/odd file names. */
function fallbackName(kind: string, ts: number, originalName: string | undefined): string {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let ext = "";
  const m = (originalName ?? "").match(/\.([A-Za-z0-9]{1,10})$/);
  if (m) ext = `.${m[1].toLowerCase()}`;
  else if (kind === "photo") ext = ".jpg";
  return `${kind}-${stamp}${ext}`;
}

/**
 * The prompt text for an uploaded file: the caption plus a file line, or the
 * default instruction when there is no caption. The caption/file are DATA, not
 * instructions — never parsed or exec'd, passed to the model as-is (same threat
 * model as a pasted text).
 */
export function buildPromptText(
  caption: string | undefined,
  f: { absPath: string; name: string; size?: number },
): string {
  if (caption) {
    return `${caption}\n(file gửi từ Telegram: ${f.name}, ${humanBytes(f.size ?? 0)} — đã lưu tại ${f.absPath})`;
  }
  return `Người dùng gửi file không kèm chỉ dẫn: ${f.name} (${humanBytes(f.size ?? 0)}), đã lưu tại ${f.absPath}. Hãy xem nội dung file đó.`;
}

/** "25.4MB" / "512KB" / "10B" — compact sizes for user-facing strings. */
export function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * Pure cleanup plan: files past their TTL first, then the oldest → newest
 * until the survivors total ≤ `maxBytes`. Returns the paths to delete (input
 * order). Testable without touching the disk.
 */
export function planCleanup(
  files: { path: string; mtime: number; size: number }[],
  now: number,
  opts: { ttlMs: number; maxBytes: number },
): string[] {
  const doomed = new Set<string>();
  const alive: { path: string; mtime: number; size: number }[] = [];
  for (const f of files) {
    if (now - f.mtime >= opts.ttlMs) doomed.add(f.path);
    else alive.push(f);
  }
  alive.sort((a, b) => a.mtime - b.mtime);
  let total = alive.reduce((s, f) => s + f.size, 0);
  for (const f of alive) {
    if (total <= opts.maxBytes) break;
    doomed.add(f.path);
    total -= f.size;
  }
  return files.filter((f) => doomed.has(f.path)).map((f) => f.path);
}

/**
 * The only I/O part: getFile(file_id) → stream the file to `destPath` via
 * Telegram.downloadFile (size + timeout guards live there).
 */
export async function downloadToFile(
  tg: Telegram,
  media: UploadMedia,
  destPath: string,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<{ bytes: number }> {
  if (!media.fileId) throw new Error("upload: missing file_id");
  const info = await tg.getFile(media.fileId);
  if (!info?.file_path) throw new Error("upload: getFile returned no file_path");
  return { bytes: await tg.downloadFile(info.file_path, destPath, opts) };
}

/**
 * The bot-owned uploads dir for a conversation: `<dataDir>/uploads/<chatId>[_<topicId>]/`.
 * One point of cleanup (the startup sweep), no user-repo pollution; the agent
 * reads the files by absolute path (same machine).
 */
export function uploadDirFor(dataDir: string, conv: string): string {
  const [chatId, threadId] = conv.split(":");
  const convSafe = threadId ? `${chatId}_${threadId}` : chatId;
  return join(dataDir, "uploads", convSafe);
}

/**
 * Startup sweep of the uploads dir: stat every file, run planCleanup, delete
 * the doomed files, then the conv dirs left empty. Never throws — the sweep
 * must not block startup.
 */
export function sweepUploads(
  root: string,
  now: number,
  opts: { ttlMs: number; maxBytes: number },
): { files: number; bytes: number } {
  const found: { path: string; mtime: number; size: number }[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing / unreadable — nothing to sweep
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = statSync(p);
          found.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* gone mid-walk */
        }
      }
    }
  };
  walk(root);
  if (!found.length) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const p of planCleanup(found, now, opts)) {
    try {
      const st = statSync(p);
      unlinkSync(p);
      files++;
      bytes += st.size;
    } catch {
      /* already gone */
    }
  }
  // Conv dirs left empty after the deletes (the root itself is kept).
  let subdirs: string[];
  try {
    subdirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    subdirs = [];
  }
  for (const d of subdirs) {
    try {
      rmdirSync(join(root, d));
    } catch {
      /* not empty (or already gone) — leave it */
    }
  }
  return { files, bytes };
}

/** Ensure a conversation's uploads dir exists; returns its path. */
export function ensureUploadDir(dataDir: string, conv: string): string {
  const dir = uploadDirFor(dataDir, conv);
  mkdirSync(dir, { recursive: true });
  return dir;
}
