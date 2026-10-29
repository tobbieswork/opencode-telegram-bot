/** Lưu cấu hình và lượt chạy trong cùng một lần ghi; vòng đời nằm ở scheduled-run.ts. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Schedule } from "./schedule.js";
import { warn } from "./logger.js";
import type { ScheduledRun } from "./scheduled-run.js";

/** On-disk shape of `data/schedules.json` (versioned so we can migrate later). */
export interface ScheduleStoreFile {
  v: 1;
  schedules: Schedule[];
  runs?: ScheduledRun[];
}

/**
 * A tiny file-backed store of schedules in `data/schedules.json`. Writes are
 * atomic (temp file + rename, mode 0o600) so a crash mid-write can't leave a
 * truncated file; a corrupt/unreadable file is moved to `.bak` and the store
 * starts fresh (never loses silently). Kept in a SEPARATE file from state.json
 * on purpose: /clear and the per-chat sweeps must never touch schedules.
 */
export class ScheduleStore {
  private runsRequired = false;
  private fileSeen = false;
  constructor(
    private readonly file: string,
    private readonly maxSchedules: number,
  ) {}

  /** Read + parse. Missing file → []. Corrupt/unreadable → rename to .bak, warn, []. */
  load(): Schedule[] {
    if (this.runsRequired) return this.readRunsFile().schedules;
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
    this.write({ ...this.readRunsFile(), schedules });
  }

  private write(body: ScheduleStoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.fileSeen = true;
  }

  private readRunsFile(): ScheduleStoreFile {
    if (!existsSync(this.file)) {
      if (this.runsRequired && this.fileSeen) throw new Error("File dữ liệu lượt chạy đã mất; cần khôi phục trước khi tiếp tục.");
      return { v: 1, schedules: [], runs: [] };
    }
    this.fileSeen = true;
    const body = JSON.parse(readFileSync(this.file, "utf8")) as ScheduleStoreFile;
    if (body.v !== 1 || !Array.isArray(body.schedules) || (body.runs !== undefined && !Array.isArray(body.runs))) {
      throw new Error("Không đọc được lịch và thông tin lượt chạy; cần kiểm tra file dữ liệu.");
    }
    const phases = ["preparing", "dispatching", "active", "recovering", "stopping", "blocked", "succeeded", "failed", "interrupted", "not-started"];
    const ids = new Set<string>();
    const active = new Set<string>();
    for (const run of body.runs ?? []) {
      if (!run || typeof run.id !== "string" || typeof run.schedule?.id !== "string" || typeof run.schedule?.conv !== "string" ||
        typeof run.messageID !== "string" || !Number.isFinite(run.admittedAt) || !Number.isFinite(run.deadline) || !phases.includes(run.phase)) {
        throw new Error("Thông tin lượt chạy không hợp lệ; giữ nguyên file và chặn admission để kiểm tra.");
      }
      if (ids.has(run.id) || (run.finishedAt === undefined && active.has(run.schedule.id)) ||
        (run.finishedAt !== undefined && !Number.isFinite(run.finishedAt))) throw new Error("Identity lượt chạy trùng hoặc dữ liệu terminal không hợp lệ.");
      ids.add(run.id);
      if (run.finishedAt === undefined) active.add(run.schedule.id);
    }
    return body;
  }

  runs(): ScheduledRun[] {
    this.runsRequired = true;
    return this.readRunsFile().runs ?? [];
  }

  admit(run: ScheduledRun, patch: Partial<Schedule>): void {
    const body = this.readRunsFile();
    const index = body.schedules.findIndex((s) => s.id === run.schedule.id && s.conv === run.schedule.conv);
    if (index < 0) throw new Error("Lịch không còn tồn tại.");
    if ((body.runs ?? []).some((r) => r.schedule.id === run.schedule.id && r.finishedAt === undefined)) {
      throw new Error("Lịch đã có lượt đang chạy.");
    }
    body.schedules[index] = { ...body.schedules[index], ...patch, id: run.schedule.id };
    body.runs = [...(body.runs ?? []), run];
    this.write(body);
  }

  putRun(run: ScheduledRun): void {
    const body = this.readRunsFile();
    body.runs = (body.runs ?? []).map((r) => r.id === run.id && !(r.finishedAt !== undefined && run.finishedAt === undefined) ? run : r);
    this.write(body);
  }

  patchRun(id: string, patch: Partial<ScheduledRun>): ScheduledRun {
    const body = this.readRunsFile();
    const found = body.runs?.find((r) => r.id === id);
    if (!found) throw new Error("Không còn dữ liệu lượt chạy để xác minh.");
    Object.assign(found, patch, { id: found.id });
    this.write(body);
    return found;
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

/** A best-effort one-line description of a thrown value for logs/notify. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
