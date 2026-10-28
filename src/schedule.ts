/**
 * Pure helpers for the `/schedule` command: parse a natural-language spec,
 * compute the next fire time, and decide whether a due run should fire,
 * catch up, or be skipped. Deliberately side-effect free (like reminders.ts)
 * so slices 2–3 (the store + scheduler tick + bot wiring) can drive it with
 * injected time. No fs, no net, no Date.now() inside — every time is passed
 * in as an argument (afterMs / now / nextRunAt / nowMs).
 *
 * Timezones go through Intl.DateTimeFormat (no dependency): a tz-local target
 * is converted to a UTC epoch with a 2-pass offset adjustment so DST is right
 * (we never add a fixed UTC offset).
 */
import type { ConvKey } from "./conv.js";

/** A parsed schedule spec — the recurring/one-shot "when" (not the "what"). */
export interface SchedSpec {
  kind: "daily" | "weekdays" | "weekly" | "every" | "once";
  /** Local time-of-day for daily/weekdays/weekly/once (24h). */
  time?: { h: number; m: number };
  /** 0=Sun…6=Sat, `weekly` only. */
  day?: number;
  /** Hours, `every` only (1..168). */
  hours?: number;
  /** Concrete date, `once` only. */
  date?: { y: number; mo: number; d: number };
}

/**
 * A persisted schedule (slice 2 stores these in data/schedules.json). The
 * scheduler treats `nextRunAt` as the single source of truth for its tick.
 */
export interface Schedule {
  id: string;            // 4 base36 chars — fits callback_data 64-byte budget
  conv: ConvKey;         // chat/topic that created it (places buttons, receives reports)
  prompt: string;        // prompt text (option tokens already stripped)
  spec: SchedSpec;       // parsed "when"
  tz: string;            // IANA zone, captured at creation (does not change if env is edited)
  dir: string;           // vetted working directory (browse roots)
  agent: string;         // agent verified to run prompt-free (e.g. "plan")
  nextRunAt: number;     // ms epoch (UTC) — the tick's source of truth
  lastRunAt?: number;
  lastStatus?: "ok" | "skipped-busy" | "skipped-late" | "timeout" | "error";
  enabled: boolean;      // false for a fired `once` / when paused
  createdBy: number;     // user id — re-checked against the allowlist every run
  createdAt: number;
}

// ── parsing ──────────────────────────────────────────────────────────────────

const DOW_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_FULL: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function parseDow(tok: string | undefined): number {
  if (tok === undefined) throw new Error("schedule: thiếu thứ trong tuần (vd mon)");
  const t = tok.toLowerCase();
  if (t in DOW_ABBR) return DOW_ABBR[t];
  if (t in DOW_FULL) return DOW_FULL[t];
  throw new Error(`schedule: thứ trong tuần không hợp lệ '${tok}' (dùng mon/tue/… hoặc monday/…)`);
}

/** Strict `HH:MM`, hour 00–23, minute 00–59 (both 2-digit). */
function parseTime(tok: string | undefined): { h: number; m: number } {
  if (tok === undefined) throw new Error("schedule: thiếu giờ HH:MM");
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(tok);
  if (!m) throw new Error(`schedule: giờ không hợp lệ '${tok}' (dùng HH:MM, 00–23:00–59)`);
  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
}

/** `<Nh>` (integer hours), 1 ≤ N ≤ 168. */
function parseHours(tok: string | undefined): number {
  if (tok === undefined) throw new Error("schedule: thiếu khoảng cách (vd 6h)");
  const m = /^(\d+)h$/.exec(tok);
  if (!m) throw new Error(`schedule: khoảng cách không hợp lệ '${tok}' (dùng số giờ, vd 6h)`);
  const n = parseInt(m[1], 10);
  if (n < 1) throw new Error("schedule: 'every' phải ≥ 1h");
  if (n > 168) throw new Error("schedule: 'every' phải ≤ 168h (7 ngày)");
  return n;
}

/** `<YYYY-MM-DD>` that is a real calendar date. */
function parseDate(tok: string | undefined): { y: number; mo: number; d: number } {
  if (tok === undefined) throw new Error("schedule: thiếu ngày (vd 2026-12-01)");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tok);
  if (!m) throw new Error(`schedule: ngày không hợp lệ '${tok}' (dùng YYYY-MM-DD)`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    throw new Error(`schedule: ngày không tồn tại '${tok}'`);
  return { y, mo, d };
}

/**
 * Parse `/schedule <spec> [dir=… agent=…] <prompt>`.
 *
 * `nowMs` is optional: when supplied, a `once` whose time is already in the
 * past is rejected. It is tz-agnostic (we have no zone at parse time) so it
 * uses a safe ±14h bound (the max possible zone offset) — it never wrongly
 * rejects a genuinely-future `once`, and rejects clearly-past ones; the
 * tz-exact check happens at fire time (slice 2).
 */
export function parseScheduleSpec(arg: string, nowMs?: number): { spec: SchedSpec; prompt: string } {
  const raw = (arg ?? "").trim();
  if (!raw) throw new Error("schedule: thiếu thông số");
  const tokens = raw.split(/\s+/);
  const kindTok = tokens[0];

  let spec: SchedSpec;
  let i = 1;
  switch (kindTok) {
    case "daily":
      spec = { kind: "daily", time: parseTime(tokens[i]) };
      i++;
      break;
    case "weekdays":
      spec = { kind: "weekdays", time: parseTime(tokens[i]) };
      i++;
      break;
    case "weekly": {
      const day = parseDow(tokens[i]);
      i++;
      spec = { kind: "weekly", day, time: parseTime(tokens[i]) };
      i++;
      break;
    }
    case "every":
      spec = { kind: "every", hours: parseHours(tokens[i]) };
      i++;
      break;
    case "once": {
      const date = parseDate(tokens[i]);
      i++;
      spec = { kind: "once", date, time: parseTime(tokens[i]) };
      i++;
      break;
    }
    default:
      throw new Error(`schedule: loại không hợp lệ '${kindTok}' (dùng daily/weekdays/weekly/every/once)`);
  }

  if (spec.kind === "once" && nowMs !== undefined) {
    const { y, mo, d } = spec.date!;
    const { h, m } = spec.time!;
    const MAX_TZ_OFFSET_MS = 14 * 3600 * 1000; // largest possible zone offset (UTC+14)
    const onceUtcLatest = Date.UTC(y, mo - 1, d, h, m, 0) + MAX_TZ_OFFSET_MS;
    if (nowMs > onceUtcLatest) throw new Error("schedule: 'once' không thể ở quá khứ");
  }

  // Free-form prompt = the rest, minus the `dir=`/`agent=` option tokens.
  const prompt = tokens
    .slice(i)
    .filter((t) => !/^dir=|^agent=/i.test(t))
    .join(" ")
    .trim();
  return { spec, prompt };
}

// ── timezone-safe conversion (Intl, 2-pass offset) ───────────────────────────

const WALL_OPTS = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
} as const;

function wallParts(instantMs: number, tz: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-US", { ...WALL_OPTS, timeZone: tz }).formatToParts(new Date(instantMs));
}

/** The tz-local wall clock of `instantMs`, reinterpreted as a UTC ms number. */
function wallAsUtcMs(instantMs: number, tz: string): number {
  const parts = wallParts(instantMs, tz);
  const g = (type: string): number => {
    const p = parts.find((q) => q.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  let h = g("hour");
  if (h === 24) h = 0; // some engines report 24 for midnight under h23
  return Date.UTC(g("year"), g("month") - 1, g("day"), h, g("minute"), g("second"));
}

/** Zone offset (ms) at `instantMs`: positive east of Greenwich. */
function tzOffsetMs(instantMs: number, tz: string): number {
  return wallAsUtcMs(instantMs, tz) - instantMs;
}

/**
 * tz-local wall clock (y,mo,d,h,m,s) → UTC ms. First pass uses the offset at
 * the wall time read as UTC; if that instant's wall clock does not come back
 * to the target (a DST transition moved it), the second pass re-derives the
 * offset at the corrected instant. A wall time that does not exist (spring
 * forward) has no exact match and maps to the post-gap instant (t1).
 */
function localToUtc(y: number, mo: number, d: number, h: number, m: number, s: number, tz: string): number {
  const W = Date.UTC(y, mo - 1, d, h, m, s);
  const t1 = W - tzOffsetMs(W, tz);
  if (wallAsUtcMs(t1, tz) === W) return t1;
  const t2 = W - tzOffsetMs(t1, tz);
  if (wallAsUtcMs(t2, tz) === W) return t2;
  return t1;
}

function localParts(instantMs: number, tz: string): { y: number; mo: number; d: number; h: number; m: number; s: number } {
  const parts = wallParts(instantMs, tz);
  const g = (type: string): number => {
    const p = parts.find((q) => q.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  let h = g("hour");
  if (h === 24) h = 0;
  return { y: g("year"), mo: g("month"), d: g("day"), h, m: g("minute"), s: g("second") };
}

/** Next calendar day (tz-local), normalising month/year rollover. */
function addDaysLocal(y: number, mo: number, d: number, days: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 0=Sun…6=Sat for a tz-local calendar date. */
function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// ── next fire time ───────────────────────────────────────────────────────────

/**
 * Next fire time (ms epoch, UTC) strictly after `afterMs` for `spec` in zone
 * `tz`.
 *
 * `every Nh` is anchored to the tz-local wall clock, NOT to creation: it fires
 * at the fixed local hours 0, N, 2N, … (all < 24) each day, so "created at
 * 14:30" → next fire 18:00 the same day for `every 6h`. (For N that does not
 * divide 24 the times-of-day are still fixed — e.g. `every 5h` runs 00/05/10/
 * 15/20, and the gap from 20:00 to the next day's 00:00 is 4h, not 5h — this
 * keeps the fire times predictable.)
 *
 * `once` returns its single fixed instant regardless of `afterMs`; the
 * scheduler marks a fired `once` disabled, so it is never evaluated again.
 */
export function nextRunAfter(spec: SchedSpec, afterMs: number, tz: string): number {
  switch (spec.kind) {
    case "daily": {
      const p = localParts(afterMs, tz);
      const t = spec.time!;
      let cand = localToUtc(p.y, p.mo, p.d, t.h, t.m, 0, tz);
      if (cand <= afterMs) {
        const nd = addDaysLocal(p.y, p.mo, p.d, 1);
        cand = localToUtc(nd.y, nd.mo, nd.d, t.h, t.m, 0, tz);
      }
      return cand;
    }
    case "weekdays": {
      const p = localParts(afterMs, tz);
      const t = spec.time!;
      let { y, mo, d } = p;
      for (let i = 0; i < 8; i++) {
        if (weekdayOf(y, mo, d) >= 1 && weekdayOf(y, mo, d) <= 5) {
          const cand = localToUtc(y, mo, d, t.h, t.m, 0, tz);
          if (cand > afterMs) return cand;
        }
        const nd = addDaysLocal(y, mo, d, 1);
        y = nd.y; mo = nd.mo; d = nd.d;
      }
      throw new Error("schedule: weekdays không tìm được lượt kế tiếp"); // unreachable
    }
    case "weekly": {
      const p = localParts(afterMs, tz);
      const t = spec.time!;
      const target = spec.day!;
      let { y, mo, d } = p;
      for (let i = 0; i < 8; i++) {
        if (weekdayOf(y, mo, d) === target) {
          const cand = localToUtc(y, mo, d, t.h, t.m, 0, tz);
          if (cand > afterMs) return cand;
        }
        const nd = addDaysLocal(y, mo, d, 1);
        y = nd.y; mo = nd.mo; d = nd.d;
      }
      throw new Error("schedule: weekly không tìm được lượt kế tiếp"); // unreachable
    }
    case "every": {
      const n = spec.hours!;
      const p = localParts(afterMs, tz);
      const slots: number[] = [];
      for (let k = 0; k * n < 24; k++) slots.push(k * n);
      for (const slotH of slots) {
        const cand = localToUtc(p.y, p.mo, p.d, slotH, 0, 0, tz);
        if (cand > afterMs) return cand;
      }
      const nd = addDaysLocal(p.y, p.mo, p.d, 1);
      return localToUtc(nd.y, nd.mo, nd.d, 0, 0, 0, tz);
    }
    case "once": {
      const { y, mo, d } = spec.date!;
      const t = spec.time!;
      return localToUtc(y, mo, d, t.h, t.m, 0, tz);
    }
  }
}

// ── due-run decision ─────────────────────────────────────────────────────────

/**
 * Decide how a due schedule should be handled at `now`:
 * - on time (`now <= nextRunAt`) → "run"
 * - late but within the grace window → "catchup" (run once, make up the miss)
 * - late beyond grace → "skip" (advance past it, report a line)
 */
export function decideRun(nextRunAt: number, now: number, graceMs: number): "run" | "catchup" | "skip" {
  if (now <= nextRunAt) return "run";
  if (now - nextRunAt <= graceMs) return "catchup";
  return "skip";
}

// ── display ──────────────────────────────────────────────────────────────────

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
const fmtTime = (t: { h: number; m: number }): string => `${pad(t.h)}:${pad(t.m)}`;

/** One short human line, e.g. `daily 08:00 · #a1b2`. */
export function formatSchedule(sch: Schedule): string {
  const { spec } = sch;
  let desc: string;
  switch (spec.kind) {
    case "daily":
      desc = `daily ${fmtTime(spec.time!)}`;
      break;
    case "weekdays":
      desc = `weekdays ${fmtTime(spec.time!)}`;
      break;
    case "weekly":
      desc = `weekly ${DOW_NAMES[spec.day!]} ${fmtTime(spec.time!)}`;
      break;
    case "every":
      desc = `every ${spec.hours}h`;
      break;
    case "once": {
      const { y, mo, d } = spec.date!;
      desc = `once ${y}-${pad(mo)}-${pad(d)} ${fmtTime(spec.time!)}`;
      break;
    }
  }
  return `${desc} · #${sch.id}`;
}

/**
 * Whether `uid` may run or manage a schedule: allow-any mode, or the uid is
 * on the allow-list. Shared by Bot.allowed() (the message gate) and the
 * scheduler's per-run isAllowed re-check — so OPENCODE_TG_ALLOW_ANY=1 with an
 * empty allow-list never silently skips a run.
 */
export const isUserAllowed = (
  cfg: { allowAny: boolean; allowedUserIds: number[] },
  uid?: number,
): boolean => cfg.allowAny || (uid !== undefined && cfg.allowedUserIds.includes(uid));
