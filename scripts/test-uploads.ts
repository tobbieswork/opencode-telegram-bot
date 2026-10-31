/**
 * Unit tests for src/uploads.ts (Telegram file upload, gate OPENCODE_TG_UPLOADS):
 *   1. sanitizeFileName — path traversal, Unicode, >100 chars, empty → fallback,
 *      collision → -1/-2.
 *   2. extractMedia — document, photo 3 sizes (largest wins),
 *      video/audio/voice/sticker/animation → null, plain text → null.
 *   3. buildPromptText — with/without caption; special chars in paths pass
 *      through untouched (data, not instructions).
 *   4. planCleanup — TTL (old deleted, fresh kept), byte cap (oldest → newest),
 *      ordering.
 *   5. Config flag parsing (gate default OFF, caps).
 *
 * I/O paths (downloadToFile, sweepUploads) are NOT unit-tested, per repo
 * convention (pure logic only).
 *
 * Run:  npx tsx scripts/test-uploads.ts
 */
import { loadConfig } from "../src/config.js";
import { extractMedia, sanitizeFileName, buildPromptText, planCleanup, humanBytes } from "../src/uploads.js";
import type { Message } from "../src/telegram.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── sanitizeFileName ─────────────────────────────────────────────────────────
const notExists = () => false;
const existing = new Set<string>();
const existsFn = (p: string) => existing.has(p);

// Traversal: only the basename survives — no separator or ".." can remain.
check("traversal → basename", sanitizeFileName("../../etc/passwd", "document", 0, notExists) === "passwd");
check("windows separators → basename", sanitizeFileName("C:\\Users\\bob\\report.pdf", "document", 0, notExists) === "report.pdf");
check("only dots → <kind>-<stamp> fallback", /^document-\d{8}-\d{6}$/.test(sanitizeFileName("...", "document", 1700000000000, notExists)));
// Unicode is kept.
check("unicode kept", sanitizeFileName("báo cáo mùa hè.pdf", "document", 0, notExists) === "báo cáo mùa hè.pdf");
// >100 chars → truncated to 100.
const longName = sanitizeFileName("a".repeat(150) + ".txt", "document", 0, notExists);
check(">100 chars → 100", longName.length === 100, String(longName.length));
// Empty → <kind>-<yyyyMMdd-HHmmss>[.<ext>] fallback.
const fbPhoto = sanitizeFileName("", "photo", 1700000000000, notExists);
check("empty → photo-<stamp>.jpg fallback", /^photo-\d{8}-\d{6}\.jpg$/.test(fbPhoto), fbPhoto);
const fbDoc = sanitizeFileName(undefined, "document", 1700000000000, notExists);
check("undefined name → document-<stamp> (no ext)", /^document-\d{8}-\d{6}$/.test(fbDoc), fbDoc);
// Collisions → -1, -2, …
existing.add("file.txt");
check("collision → -1 (before the extension)", sanitizeFileName("file.txt", "document", 0, existsFn) === "file-1.txt");
existing.add("file-1.txt");
check("collision → -2", sanitizeFileName("file.txt", "document", 0, existsFn) === "file-2.txt");
check("no collision → name unchanged", sanitizeFileName("other.txt", "document", 0, existsFn) === "other.txt");

// ── extractMedia ─────────────────────────────────────────────────────────────
const base = (m: Partial<Message>): Message => ({ chat: { id: 1 }, ...m });
const doc = extractMedia(base({ document: { file_id: "d1", file_name: "a.zip", file_size: 123, mime_type: "application/zip" } }));
check(
  "document → kind/fileId/name/size/mime",
  !!doc && doc.kind === "document" && doc.fileId === "d1" && doc.fileName === "a.zip" && doc.fileSize === 123 && doc.mimeType === "application/zip",
  JSON.stringify(doc),
);
const photo = extractMedia(
  base({ photo: [{ file_id: "s1", file_size: 1000 }, { file_id: "s2", file_size: 3000 }, { file_id: "s3", file_size: 2000 }] }),
);
check("photo 3 sizes → largest wins", !!photo && photo.kind === "photo" && photo.fileId === "s2" && photo.fileSize === 3000, JSON.stringify(photo));
check("video → null", extractMedia(base({ video: { file_id: "v1", file_size: 1 } })) === null);
check("audio → null", extractMedia(base({ audio: { file_id: "a1" } })) === null);
check("voice → null", extractMedia(base({ voice: { file_id: "v1" } })) === null);
check("sticker → null", extractMedia(base({ sticker: { file_id: "s1" } })) === null);
check("animation → null", extractMedia(base({ animation: { file_id: "a1" } })) === null);
check("plain text → null", extractMedia(base({ text: "hello" })) === null);

// ── buildPromptText ──────────────────────────────────────────────────────────
const withCap = buildPromptText("tóm tắt file này", { absPath: "/data/uploads/1/x.pdf", name: "x.pdf", size: 2048 });
check(
  "with caption → caption + file line",
  withCap === "tóm tắt file này\n(file gửi từ Telegram: x.pdf, 2.0KB — đã lưu tại /data/uploads/1/x.pdf)",
  withCap,
);
const noCap = buildPromptText(undefined, { absPath: "/data/uploads/1/x.pdf", name: "x.pdf", size: 2048 });
check(
  "no caption → default instruction",
  noCap === "Người dùng gửi file không kèm chỉ dẫn: x.pdf (2.0KB), đã lưu tại /data/uploads/1/x.pdf. Hãy xem nội dung file đó.",
  noCap,
);
// A path with special chars passes through untouched (data, not instructions).
const special = buildPromptText("hi", { absPath: "/data/uploads/a<b&c>.pdf", name: "a<b&c>.pdf", size: 5 });
check("special chars passed through", special.includes("/data/uploads/a<b&c>.pdf"), special);

// humanBytes — the spec's "25.4MB" style.
check("humanBytes MB", humanBytes(Math.round(25.4 * 1024 * 1024)) === "25.4MB", humanBytes(Math.round(25.4 * 1024 * 1024)));
check("humanBytes KB", humanBytes(2048) === "2.0KB", humanBytes(2048));
check("humanBytes B", humanBytes(10) === "10B", humanBytes(10));

// ── planCleanup ──────────────────────────────────────────────────────────────
const NOW = 1_000_000_000_000;
const day = 86_400_000;
// TTL: the expired file is deleted, the fresh one kept (cap far above).
let plan = planCleanup(
  [
    { path: "old", mtime: NOW - 8 * day, size: 100 },
    { path: "new", mtime: NOW - 1 * day, size: 100 },
  ],
  NOW,
  { ttlMs: 7 * day, maxBytes: 1_000_000 },
);
check("TTL: expired deleted, fresh kept", JSON.stringify(plan) === JSON.stringify(["old"]), JSON.stringify(plan));
// Byte cap: total 1500 > 1000 → delete oldest (c) → total 1000 ≤ 1000, stop.
plan = planCleanup(
  [
    { path: "c", mtime: NOW - 3 * day, size: 500 },
    { path: "a", mtime: NOW - 1 * day, size: 500 },
    { path: "b", mtime: NOW - 2 * day, size: 500 },
  ],
  NOW,
  { ttlMs: 7 * day, maxBytes: 1000 },
);
check("cap: oldest deleted until total ≤ max", JSON.stringify(plan) === JSON.stringify(["c"]), JSON.stringify(plan));
// TTL + cap together: old (expired) + b (oldest survivor, over cap).
plan = planCleanup(
  [
    { path: "old", mtime: NOW - 8 * day, size: 100 },
    { path: "b", mtime: NOW - 2 * day, size: 600 },
    { path: "a", mtime: NOW - 1 * day, size: 600 },
  ],
  NOW,
  { ttlMs: 7 * day, maxBytes: 600 },
);
check("TTL + cap combined, input order kept", JSON.stringify(plan) === JSON.stringify(["old", "b"]), JSON.stringify(plan));
// Nothing to delete.
plan = planCleanup([{ path: "x", mtime: NOW, size: 10 }], NOW, { ttlMs: 7 * day, maxBytes: 100 });
check("nothing to delete → []", plan.length === 0, JSON.stringify(plan));

// ── flag parsing (default OFF) ───────────────────────────────────────────────
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";

delete process.env.OPENCODE_TG_UPLOADS;
delete process.env.OPENCODE_TG_UPLOAD_MAX_MB;
delete process.env.OPENCODE_TG_UPLOAD_TTL_DAYS;
let cfg = loadConfig(process.cwd());
check("OPENCODE_TG_UPLOADS unset → uploads false", cfg.uploads === false);
check("default uploadMaxBytes = 20MB", cfg.uploadMaxBytes === 20 * 1024 * 1024, String(cfg.uploadMaxBytes));
check("default uploadTtlDays = 7", cfg.uploadTtlDays === 7, String(cfg.uploadTtlDays));
process.env.OPENCODE_TG_UPLOADS = "1";
check('OPENCODE_TG_UPLOADS="1" → uploads true', loadConfig(process.cwd()).uploads === true);
process.env.OPENCODE_TG_UPLOADS = "true";
check('OPENCODE_TG_UPLOADS="true" → uploads true', loadConfig(process.cwd()).uploads === true);
process.env.OPENCODE_TG_UPLOADS = "0";
check('OPENCODE_TG_UPLOADS="0" → uploads false', loadConfig(process.cwd()).uploads === false);
process.env.OPENCODE_TG_UPLOAD_MAX_MB = "50";
check("OPENCODE_TG_UPLOAD_MAX_MB=50 → 50MB", loadConfig(process.cwd()).uploadMaxBytes === 50 * 1024 * 1024);
process.env.OPENCODE_TG_UPLOAD_TTL_DAYS = "30";
check("OPENCODE_TG_UPLOAD_TTL_DAYS=30 → 30", loadConfig(process.cwd()).uploadTtlDays === 30);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
