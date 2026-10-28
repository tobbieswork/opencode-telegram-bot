/**
 * The scheduler engine for `/schedule`: a file-backed store of schedules plus a
 * tick loop that fires the due ones. Deliberately dependency-injected (clock,
 * dispatch, notify, allow/busy checks) so it is fully testable WITHOUT
 * Telegram or OpenCode — slice 3 supplies the real `dispatch` (spawn a worker
 * topic + prompt). This module must not import Telegram or OpenCode.
 *
 * Crash safety (the important part): when a schedule is due we PERSIST the
 * next-fire advance (nextRunAt / lastRunAt, and enabled=false for `once`)
 * BEFORE dispatching. A crash or restart between the persist and the dispatch
 * therefore never re-runs a turn — the schedule already points at the next
 * fire time, so the post-restart tick sees it as not-due.
 *
 * No stacking: if the schedule's worker is still running/waiting we skip the
 * turn (advance + lastStatus="skipped-busy") rather than pile up runs. One
 * schedule failing must never kill the loop — the per-schedule body is wrapped
 * so a throwing dispatch (including the capacity/contention case where the
 * real dispatch's spawn throws because max workers is full) is caught, logged,
 * reported, and the tick continues.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ConvKey } from "./conv.js";
import { nextRunAfter, decideRun, formatSchedule } from "./schedule.js";
import type { Schedule } from "./schedule.js";
import { warn } from "./logger.js";

/** On-disk shape of `data/schedules.json` (versioned so we can migrate later). */
export interface ScheduleStoreFile {
  v: 1;
  schedules: Schedule[];
}

/**
 * A tiny file-backed store of schedules in `data/schedules.json`. Writes are
 * atomic (temp file + rename, mode 0o600) so a crash mid-write can't leave a
 * truncated file; a corrupt/unreadable file is moved to `.bak` and the store
 * starts fresh (never loses silently). Kept in a SEPARATE file from state.json
 * on purpose: /clear and the per-chat sweeps must never touch schedules.
 */
export class ScheduleStore {
  constructor(
    private readonly file: string,
    private readonly maxSchedules: number,
  ) {}

  /** Read + parse. Missing file → []. Corrupt/unreadable → rename to .bak, warn, []. */
  load(): Schedule[] {
    if (!existsSync(this.file)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      this.quarantine(`unreadable: ${errText(e)}`);
      return [];
    }
    const arr = (parsed as ScheduleStoreFile)?.schedules;
    if (!Array.isArray(arr)) {
      this.quarantine("bad shape (no schedules array)");
      return [];
    }
    return arr as Schedule[];
  }

  /**
   * Atomic write (tmp + rename, mode 0o600). Unlike StateManager.save this does
   * NOT swallow disk errors: a failed advance-persist must surface as a schedule
   * error (caught by the tick) rather than silently risk a double-run on restart.
   */
  save(schedules: Schedule[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body: ScheduleStoreFile = { v: 1, schedules };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(id: string): Schedule | undefined {
    return this.load().find((s) => s.id === id);
  }

  /** Append a schedule. Throws when the store is at `maxSchedules` or the id collides. */
  add(sch: Schedule): Schedule {
    const list = this.load();
    if (list.length >= this.maxSchedules) {
      throw new Error(`Đã đủ ${this.maxSchedules} lịch (giới hạn). Xoá bớt trước khi thêm.`);
    }
    if (list.some((s) => s.id === sch.id)) throw new Error(`Lịch #${sch.id} đã tồn tại.`);
    list.push(sch);
    this.save(list);
    return sch;
  }

  /** Remove by id. Returns whether anything was removed. */
  remove(id: string): boolean {
    const list = this.load();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }

  /** Partial update by id (the id itself is immutable). Returns the updated schedule, or undefined. */
  set(id: string, patch: Partial<Schedule>): Schedule | undefined {
    const list = this.load();
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    list[idx] = { ...list[idx], ...patch, id: list[idx].id };
    this.save(list);
    return list[idx];
  }

  /** Move a corrupt file aside so the store can start fresh (never loses silently). */
  private quarantine(reason: string): void {
    warn(`schedules store: ${this.file} ${reason} — moving to .bak and starting fresh`);
    try {
      if (existsSync(this.file)) renameSync(this.file, `${this.file}.bak`);
    } catch {
      /* best effort — we still start fresh in memory either way */
    }
  }
}

/**
 * The tick engine. Every collaborator is injected so tests run without
 * Telegram/OpenCode:
 *  - `now()`         injectable clock (ms epoch)
 *  - `store`         the file-backed schedule store (already size-capped on add)
 *  - `dispatch(sch)`  slice 3's real "run this schedule once" (spawn worker + prompt)
 *  - `isBusy(sch)`    is this schedule's worker still running/waiting (skip, no stacking)
 *  - `isAllowed(uid)` re-check the creator against cfg.allowedUserIds each run
 *  - `notify(conv,t)` one short 1-line report to the schedule's conv
 *  - `tickMs`        tick interval (default 30s)
 *  - `graceMs`       a due run late by at most this still fires once (default 60 min)
 */
export interface SchedulerDeps {
  now: () => number;
  store: ScheduleStore;
  dispatch: (sch: Schedule) => Promise<void>;
  isBusy: (sch: Schedule) => boolean;
  isAllowed: (userId: number) => boolean;
  notify: (conv: ConvKey, text: string) => Promise<void>;
  tickMs?: number;
  graceMs?: number;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_GRACE_MS = 60 * 60_000;

export class Scheduler {
  private readonly tickMs: number;
  private readonly graceMs: number;
  private timer?: ReturnType<typeof setInterval>;
  /** Re-entrancy guard: a slow dispatch must never let two ticks overlap. */
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** Begin the recurring tick (unref'd so it never holds the process open). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => warn("scheduler tick:", errText(e))),
      this.tickMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over all schedules. The ordering is the contract:
   *   1. skip schedules that are disabled or not due yet;
   *   2. classify a due one via decideRun (run / catchup / skip);
   *   3. for run/catchup, PERSIST the next-fire advance BEFORE dispatching
   *      (the double-run guard), then:
   *        busy → skip the turn (no stacking); not-allowed → log + skip;
   *        otherwise dispatch, catching any error so one bad schedule can't
   *        kill the loop (also covers the capacity/contention spawn throw).
   *   4. a `skip` (too late) advances past it and, for a `once`, disables it
   *      (its single instant has passed — it can never fire, so don't churn).
   */
  async tick(): Promise<void> {
    if (this.ticking) return; // a previous tick is still dispatching
    this.ticking = true;
    try {
      const now = this.deps.now();
      const { store } = this.deps;
      // The pass awaits dispatches that take seconds, during which /schedule
      // add|pause|rm may edit the file. So never write back a list loaded at the
      // start: re-read each schedule just before acting on it, and persist every
      // change as a per-id patch (store.set → fresh load) — a schedule removed or
      // paused meanwhile is neither resurrected nor un-paused, a new one is kept.
      for (const snap of store.load()) {
        const sch = store.get(snap.id);
        if (!sch || !sch.enabled) continue; // removed or paused since the snapshot
        if (sch.nextRunAt > now) continue; // not due yet
        const dec = decideRun(sch.nextRunAt, now, this.graceMs);
        if (dec === "skip") {
          // Too late to run: advance past it (don't pile up) and move on.
          this.mark(sch.id, {
            nextRunAt: nextRunAfter(sch.spec, now, sch.tz),
            lastStatus: "skipped-late",
            ...(sch.spec.kind === "once" ? { enabled: false } : {}),
          });
          continue;
        }
        // run / catchup: advance first, then dispatch.
        try {
          // Persist the advance BEFORE dispatch — the double-run guard. Not
          // swallowed: a failed write must surface as a schedule error.
          store.set(sch.id, {
            nextRunAt: nextRunAfter(sch.spec, now, sch.tz),
            lastRunAt: now,
            ...(sch.spec.kind === "once" ? { enabled: false } : {}),
          });

          if (this.deps.isBusy(sch)) {
            this.mark(sch.id, { lastStatus: "skipped-busy" });
            await this.safeNotify(sch.conv, `⏭ ${formatSchedule(sch)} — bỏ lượt (worker đang bận).`);
          } else if (!this.deps.isAllowed(sch.createdBy)) {
            // Creator was removed from the allowlist since creation.
            warn(`scheduler: #${sch.id} creator ${sch.createdBy} no longer allowed — skipped`);
          } else {
            await this.deps.dispatch(sch);
            this.mark(sch.id, { lastStatus: "ok" });
          }
        } catch (e) {
          this.mark(sch.id, { lastStatus: "error" });
          warn(`scheduler: #${sch.id} error: ${errText(e)}`);
          await this.safeNotify(sch.conv, `⚠️ ${formatSchedule(sch)} — lỗi khi chạy.`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Best-effort status/bookkeeping patch for one schedule (a gone id is a no-op; a disk error must not kill the pass). */
  private mark(id: string, patch: Partial<Schedule>): void {
    try {
      this.deps.store.set(id, patch);
    } catch (e) {
      warn(`scheduler: #${id} could not persist ${Object.keys(patch).join("/")}: ${errText(e)}`);
    }
  }

  /** A notify must never break the tick, so swallow (and log) its own errors. */
  private async safeNotify(conv: ConvKey, text: string): Promise<void> {
    try {
      await this.deps.notify(conv, text);
    } catch (e) {
      warn("scheduler notify:", errText(e));
    }
  }
}

/** A best-effort one-line description of a thrown value for logs/notify. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
