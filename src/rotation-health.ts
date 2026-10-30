/**
 * Manager rotation — tracking + durability (Part 1).
 *
 * Deterministic bookkeeping so a later LLM durability-check can read a clean
 * snapshot and a user can see rotation health on demand (/rotation). No
 * rotation is triggered here — this only RECORDS what the rotation monitor
 * (bot.ts) does.
 *
 * Two persisted per-manager-conv fields (see state.ts ChatState):
 *   - rotationHistory: one entry per rotation attempt (success or fail), capped.
 *   - floorTrend: the manager's context floor (K) per local day, min/max, capped.
 *
 * Plus a machine-wide snapshot file (data/rotation-health.json), rewritten on
 * every rotation tick, that both the LLM durability-check and the /rotation
 * command read.
 *
 * The pure helpers are testable without I/O or the network; the two fs
 * functions (writeRotationHealth / readRotationHealth) are the only I/O, and
 * both are atomic/safe.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { esc, timeAgo } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** One rotation attempt, as recorded in ChatState.rotationHistory (newest last). */
export interface RotationHistoryEntry {
  /** epoch ms the attempt completed. */
  at: number;
  /** The manager's context floor (K) measured just before the attempt. */
  floorK: number;
  /** Which tier triggered it. */
  tier: "auto" | "confirm";
  /** Did the rotation land (fresh session bound) or fail (old session kept)? */
  outcome: "success" | "fail";
  /** The fresh session's floor (K), measured best-effort after a successful rotation; omitted when not measurable (a fresh session has none yet). */
  newFloorK?: number;
}

/** The manager's context floor (K) over one local day (min/max of the ticks). */
export interface FloorTrendEntry {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Lowest floor (K) measured that day. */
  min: number;
  /** Highest floor (K) measured that day. */
  max: number;
}

/** The machine-wide rotation health snapshot (data/rotation-health.json). */
export interface RotationHealthSnapshot {
  /** epoch ms the snapshot was written. */
  now: number;
  /** The manager's current context floor (K); null when not measured this tick. */
  currentFloorK: number | null;
  /** The 7-day floor trend (oldest → newest). */
  floorTrend: FloorTrendEntry[];
  /** The last SNAPSHOT_ROTATIONS attempts (oldest → newest). */
  rotations: RotationHistoryEntry[];
  /** epoch ms of the last rotation attempt; null when none. */
  lastRotationAt: number | null;
  /** The outcome of the last rotation attempt; null when none. */
  lastRotationOutcome: "success" | "fail" | null;
  /** true when the current floor is measured and below the unbounded threshold. */
  bounded: boolean;
  /** The configured thresholds (K) the snapshot was written against. */
  thresholds: { autoK: number; confirmK: number };
}

// ── Caps + thresholds ────────────────────────────────────────────────────────

/** Keep at most this many rotation attempts (oldest dropped). */
export const ROTATION_HISTORY_CAP = 30;
/** Keep at most this many days of floor trend (oldest pruned). */
export const FLOOR_TREND_DAYS = 7;
/** How many recent attempts the snapshot carries. */
export const SNAPSHOT_ROTATIONS = 10;
/** Floor (K) at/above which the /rotation verdict is "watch". */
export const ROTATION_WATCH_K = 100;
/** Floor (K) at/above which the manager is "unbounded" (and `bounded` is false). */
export const ROTATION_UNBOUNDED_K = 120;
/** The snapshot file name (written next to state.json, in the data dir). */
export const ROTATION_HEALTH_FILE = "rotation-health.json";

// ── Pure tracking helpers ────────────────────────────────────────────────────

/**
 * Append one rotation entry, keeping at most `cap` (the most recent). Returns a
 * NEW array (the caller persists it); the input is never mutated.
 */
export function appendRotationHistory(
  history: RotationHistoryEntry[] | undefined,
  entry: RotationHistoryEntry,
  cap = ROTATION_HISTORY_CAP,
): RotationHistoryEntry[] {
  const next = [...(history ?? []), entry];
  return next.length > cap ? next.slice(-cap) : next;
}

/** The local calendar day (YYYY-MM-DD) for an epoch-ms timestamp. */
export function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Upsert one day's floor into the trend: same day → widen min/max; new day →
 * insert. Days are YYYY-MM-DD, so a plain string sort is chronological; the
 * result keeps only the most recent `days` (oldest pruned). Returns a NEW array.
 */
export function upsertFloorTrend(
  trend: FloorTrendEntry[] | undefined,
  day: string,
  floorK: number,
  days = FLOOR_TREND_DAYS,
): FloorTrendEntry[] {
  const prev = (trend ?? []).find((e) => e.day === day);
  const entry: FloorTrendEntry = prev
    ? { day, min: Math.min(prev.min, floorK), max: Math.max(prev.max, floorK) }
    : { day, min: floorK, max: floorK };
  const next = (trend ?? []).filter((e) => e.day !== day);
  next.push(entry);
  next.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return next.length > days ? next.slice(-days) : next;
}

/**
 * Assemble the snapshot object. `rotations` is the last SNAPSHOT_ROTATIONS of
 * `rotationHistory`; `bounded` is derived from the current floor. Pure.
 */
export function buildRotationSnapshot(input: {
  now: number;
  currentFloorK: number | null;
  floorTrend: FloorTrendEntry[];
  rotationHistory: RotationHistoryEntry[];
  lastRotationAt: number | null;
  lastRotationOutcome: "success" | "fail" | null;
  autoK: number;
  confirmK: number;
}): RotationHealthSnapshot {
  return {
    now: input.now,
    currentFloorK: input.currentFloorK,
    floorTrend: input.floorTrend,
    rotations: input.rotationHistory.slice(-SNAPSHOT_ROTATIONS),
    lastRotationAt: input.lastRotationAt,
    lastRotationOutcome: input.lastRotationOutcome,
    bounded: input.currentFloorK !== null && input.currentFloorK < ROTATION_UNBOUNDED_K,
    thresholds: { autoK: input.autoK, confirmK: input.confirmK },
  };
}

/** The /rotation verdict for a snapshot's current state. Pure. */
export type RotationVerdict = "bounded" | "watch" | "unbounded";
export function rotationVerdict(
  currentFloorK: number | null,
  lastOutcome: "success" | "fail" | null,
): RotationVerdict {
  if (lastOutcome === "fail") return "unbounded";
  if (currentFloorK === null) return "watch";
  if (currentFloorK > ROTATION_UNBOUNDED_K) return "unbounded";
  if (currentFloorK >= ROTATION_WATCH_K) return "watch";
  return "bounded";
}

// ── File I/O (atomic, safe) ──────────────────────────────────────────────────

/** The snapshot's absolute path: next to state.json, in the data dir. */
export function rotationHealthPath(stateFile: string): string {
  return join(dirname(stateFile), ROTATION_HEALTH_FILE);
}

/**
 * Atomic write (tmp + rename, mode 0o600) of the snapshot. Throws on failure —
 * the CALLER decides whether that is fatal (the monitor catches + warns; the
 * /rotation read path never writes).
 */
export function writeRotationHealth(file: string, snap: RotationHealthSnapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Read + parse the snapshot. Missing or unreadable file → null (never throws). */
export function readRotationHealth(file: string): RotationHealthSnapshot | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as RotationHealthSnapshot;
  } catch {
    return null;
  }
}

// ── Rendering (/rotation report) ─────────────────────────────────────────────

/**
 * The /rotation report body (Telegram HTML) for one snapshot. Read-only — it
 * renders the snapshot; it never triggers a rotation.
 */
export function renderRotationReport(snap: RotationHealthSnapshot): string {
  const lines: string[] = [];
  lines.push("🧹 <b>Rotation Manager</b>");
  lines.push(
    snap.currentFloorK === null
      ? "Nền hiện tại: chưa đo được"
      : `Nền hiện tại: ~${Math.round(snap.currentFloorK)}K`,
  );
  lines.push(`Ngưỡng: confirm &gt;${snap.thresholds.confirmK}K · auto &gt;${snap.thresholds.autoK}K`);

  lines.push("");
  lines.push("📊 <b>Xu hướng nền 7 ngày</b> (min–max):");
  if (snap.floorTrend.length === 0) lines.push("  chưa có dữ liệu");
  else for (const d of snap.floorTrend) lines.push(`  ${esc(d.day)}: ${Math.round(d.min)}–${Math.round(d.max)}K`);

  lines.push("");
  lines.push("🔄 <b>Xoay gần đây</b> (5):");
  const recent = snap.rotations.slice(-5);
  if (recent.length === 0) lines.push("  chưa có");
  else
    for (const r of recent) {
      const to = r.newFloorK !== undefined ? ` → ~${r.newFloorK}K` : "";
      lines.push(`  ${r.outcome === "success" ? "✅" : "❌"} ${esc(r.tier)} · ~${r.floorK}K${to} · ${timeAgo(r.at)}`);
    }

  const v = rotationVerdict(snap.currentFloorK, snap.lastRotationOutcome);
  const verdict =
    v === "bounded"
      ? "✅ bounded — nền &lt;100K, ổn định"
      : v === "watch"
        ? snap.currentFloorK === null
          ? "⚠️ theo dõi — chưa đo được nền"
          : "⚠️ theo dõi — nền 100–120K"
        : "❌ vượt ngưỡng — nền &gt;120K hoặc lần xoay cuối thất bại";
  lines.push("");
  lines.push(`🎯 <b>Đánh giá</b>: ${verdict}`);

  return lines.join("\n");
}
