import { randomBytes } from "node:crypto";
import type { ConvKey } from "./conv.js";
import type { Schedule } from "./schedule.js";
import { decideRun, nextRunAfter } from "./schedule.js";
import type { ScheduleStore } from "./scheduler.js";
import { warn } from "./logger.js";
import { ScheduledEvidenceError } from "./scheduled-observer.js";

export class ScheduledReadinessError extends Error {}

export interface RunBinding {
  conv: ConvKey;
  sessionID: string;
  source: string;
  projectID: string;
  createdAt: number;
  sequence: number;
}

export interface ScheduledRun {
  id: string;
  schedule: Schedule;
  mode: "automatic" | "manual";
  messageID: string;
  admittedAt: number;
  deadline: number;
  phase: "preparing" | "dispatching" | "active" | "recovering" | "stopping" | "blocked" | "succeeded" | "failed" | "interrupted" | "not-started";
  binding?: RunBinding;
  finishedAt?: number;
  recoveryStartedAt?: number;
  retryAt?: number;
  attempts?: number;
  escalated?: boolean;
  lastNotice?: string;
  lastVerifiedAt?: number;
  recoveryReason?: string;
  evidence?: RunEvidence;
}

export interface RunObservation {
  state: "pending" | "running" | "waiting" | "succeeded" | "failed" | "interrupted" | "conflict";
  evidence?: RunEvidence;
  reason?: string;
}

export interface RunEvidence {
  sequence: number;
  enqueued?: boolean;
  delivered?: boolean;
  started?: boolean;
  terminal?: "succeeded" | "failed" | "interrupted";
  conflict?: string;
}

export interface ScheduledExecution {
  ready(schedule: Schedule): Promise<void>;
  claim(schedule: Schedule, runID: string): void;
  release(run: ScheduledRun): void;
  restore(run: ScheduledRun): void;
  prepare(run: ScheduledRun): Promise<RunBinding>;
  submit(run: ScheduledRun): Promise<void>;
  inspect(run: ScheduledRun): Promise<RunObservation>;
  stop(run: ScheduledRun, observation: RunObservation): Promise<void>;
  settled(run: ScheduledRun): Promise<void>;
  matches?(run: ScheduledRun, conv: ConvKey): boolean;
}

export interface ScheduledRunDeps {
  store: ScheduleStore;
  execution: ScheduledExecution;
  now: () => number;
  enabled: () => boolean;
  isAllowed: (userID: number) => boolean;
  notify: (conv: ConvKey, text: string) => Promise<void>;
  timeoutMs: number;
  graceMs?: number;
}

export class ScheduledRuns {
  private working = new Set<string>();
  private checking = new Set<string>();
  private gateFailures = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private maintaining = false;
  private initialization?: Promise<void>;
  private nextTick = 0;
  private closed = false;

  constructor(private readonly deps: ScheduledRunDeps) {
    for (const run of deps.store.runs()) {
      if (run.finishedAt === undefined) deps.execution.restore(run);
    }
  }

  async run(id: string, mode: ScheduledRun["mode"], owner?: ConvKey): Promise<{ accepted: boolean; reason?: string }> {
    this.initialization ??= this.recover().then(() => {});
    await this.initialization;
    if (this.closed) return { accepted: false, reason: "Bot đang dừng; không nhận lượt mới." };
    if (!this.deps.enabled()) return { accepted: false, reason: "Chức năng lịch đang tắt." };
    let sch = this.deps.store.get(id);
    if (!sch || (owner && owner !== sch.conv)) return { accepted: false, reason: "Không tìm thấy lịch của chat này." };
    if (!this.deps.isAllowed(sch.createdBy)) return { accepted: false, reason: "Người tạo lịch không còn được phép chạy." };
    try {
      await this.deps.execution.ready(sch);
      this.gateFailures.delete(id);
    } catch (e) {
      const reason = e instanceof ScheduledReadinessError ? e.message : this.explain(e);
      if (!this.gateFailures.has(id)) {
        await this.deps.notify(sch.conv, `⛔ Lịch #${id}: ${reason} Không nhận lượt mới; kiểm tra kết nối/quyền OpenCode.`).catch(() => {});
        this.gateFailures.add(id);
      }
      return { accepted: false, reason: `${reason} Lịch chưa bị thay đổi.` };
    }
    sch = this.deps.store.get(id);
    if (this.closed || !this.deps.enabled() || !sch || (owner && owner !== sch.conv) || !this.deps.isAllowed(sch.createdBy) ||
      (mode === "automatic" && (!sch.enabled || sch.nextRunAt > this.deps.now()))) return { accepted: false };
    if (mode === "automatic" && decideRun(sch.nextRunAt, this.deps.now(), this.deps.graceMs ?? 3_600_000) === "skip") {
      this.consume(sch, "skipped-late");
      return { accepted: false, reason: "Đã bỏ lượt quá trễ." };
    }
    if (this.deps.store.runs().some((r) => r.schedule.id === id && r.finishedAt === undefined)) {
      if (mode === "automatic") this.consume(sch, "skipped-busy");
      return { accepted: false, reason: "Lịch đang có lượt chưa kết thúc." };
    }
    const now = this.deps.now();
    let run: ScheduledRun = {
      id: randomBytes(12).toString("hex"), schedule: sch, mode,
      messageID: "msg_" + now.toString(16).padStart(12, "0") + randomBytes(7).toString("hex"),
      admittedAt: now, deadline: now + this.deps.timeoutMs, phase: "preparing",
    };
    try {
      this.deps.execution.claim(sch, run.id);
    } catch {
      if (mode === "automatic") this.consume(sch, "skipped-busy");
      await this.deps.notify(sch.conv, `⏭ Lịch #${id}: bỏ lượt vì worker đang bận hoặc đã hết slot.`).catch(() => {});
      return { accepted: false, reason: "Worker đang bận hoặc đã hết slot." };
    }
    try {
      this.deps.store.admit(run, mode === "automatic" ? {
        nextRunAt: nextRunAfter(sch.spec, now, sch.tz), lastRunAt: now,
        ...(sch.spec.kind === "once" ? { enabled: false } : {}),
      } : {});
    } catch (e) {
      this.deps.execution.release(run);
      throw e;
    }
    this.working.add(run.id);
    try {
      const binding = await this.deps.execution.prepare(run);
      run = { ...this.current(run.id), binding };
      if (this.closed || run.phase === "stopping" || this.deps.now() >= run.deadline) {
        await this.finish(run, "not-started");
        return { accepted: false, reason: "Đã hết thời hạn trong lúc chuẩn bị; không gửi prompt." };
      }
      run.phase = "dispatching";
      this.deps.store.putRun(run);
      await this.deps.execution.submit(run);
      run = this.current(run.id);
      if (run.phase === "dispatching") run.phase = "active";
      this.deps.store.putRun(run);
      this.deps.store.set(id, { lastStatus: "ok" });
    } catch (e) {
      if (run.finishedAt !== undefined && this.current(run.id).finishedAt !== undefined) throw e;
      if (run.phase === "preparing") {
        run.phase = "failed";
        run.finishedAt = this.deps.now();
        this.deps.store.putRun(run);
        this.deps.store.set(id, { lastStatus: "error" });
        this.deps.execution.release(run);
        throw e;
      }
      run = this.current(run.id);
      await this.lost(run, this.explain(e));
      return { accepted: true, reason: "Đã nhận lượt chạy; đang tìm lại execution sau mất kết nối." };
    } finally {
      this.working.delete(run.id);
    }
    return { accepted: true };
  }

  async tick(): Promise<void> {
    if (!this.deps.enabled()) return;
    for (const id of this.deps.store.load().map((s) => s.id)) {
      const sch = this.deps.store.get(id);
      const now = this.deps.now();
      if (!sch?.enabled || sch.nextRunAt > now) continue;
      try {
        await this.run(id, "automatic");
      } catch {
        await this.deps.notify(sch.conv, `⚠️ Lịch #${id}: lỗi chuẩn bị hoặc ghi dữ liệu; không tự gửi lại prompt.`).catch(() => {});
      }
    }
  }

  private consume(sch: Schedule, status: Schedule["lastStatus"]): void {
    const now = this.deps.now();
    this.deps.store.set(sch.id, { nextRunAt: nextRunAfter(sch.spec, now, sch.tz), lastRunAt: now,
      lastStatus: status, ...(sch.spec.kind === "once" ? { enabled: false } : {}) });
  }

  async recover(force = true, sessionID?: string): Promise<void> {
    for (let run of this.deps.store.runs()) {
      if (sessionID && run.binding?.sessionID !== sessionID) continue;
      if (run.finishedAt !== undefined || this.working.has(run.id) || this.checking.has(run.id)) continue;
      if (!force && (run.retryAt ?? 0) > this.deps.now()) continue;
      this.checking.add(run.id);
      try {
        if (!run.binding) {
          await this.finish(run, "not-started");
          continue;
        }
        const observed = await this.deps.execution.inspect(run);
        run = this.current(run.id);
        if (run.finishedAt !== undefined) continue;
        if (observed.evidence) run.evidence = observed.evidence;
        run.lastVerifiedAt = this.deps.now();
        if (["succeeded", "failed", "interrupted"].includes(observed.state)) {
          await this.finish(run, observed.state as "succeeded" | "failed" | "interrupted");
        } else if (observed.state === "conflict") {
          run.phase = "blocked";
          run.recoveryReason = observed.reason ?? "Không xác minh được execution thuộc lượt này.";
          run.retryAt = this.deps.now() + 60_000;
          this.deps.store.putRun(run);
          const detail = observed.reason ? this.escape(observed.reason) : "Không xác minh được execution thuộc lượt này.";
          await this.notice(run, "conflict", `${detail} Cần kiểm tra session; giữ slot, không tự dừng hoặc chạy lại.`);
        } else if (this.deps.now() >= run.deadline || run.phase === "stopping") {
          run.phase = "stopping";
          run.retryAt = this.deps.now() + 1000;
          this.deps.store.putRun(run);
          await this.deps.execution.stop(run, observed);
          await this.notice(run, "stopping", "Đã yêu cầu dừng nhưng chưa xác nhận kết thúc; đang kiểm tra lại và vẫn giữ slot.");
        } else {
          const wasLost = run.recoveryStartedAt !== undefined;
          run.phase = "active";
          run.recoveryStartedAt = undefined;
          run.recoveryReason = undefined;
          run.retryAt = Math.min(this.deps.now() + 30_000, run.deadline);
          run.attempts = 0;
          run.escalated = false;
          this.deps.store.putRun(run);
          if (wasLost) await this.notice(run, "reconnected", "Đã tìm lại execution và nối lại theo dõi; giữ nguyên deadline.");
        }
      } catch (e) {
        if (run.finishedAt === undefined) await this.lost(run, this.explain(e));
        warn("khôi phục lượt chạy:", e instanceof Error ? e.name : "lỗi kết nối");
      } finally {
        this.checking.delete(run.id);
      }
    }
  }

  private async lost(run: ScheduledRun, reason = "Chưa xác minh được kết nối hoặc execution."): Promise<void> {
    run.phase = run.phase === "stopping" ? "stopping" : "recovering";
    run.recoveryStartedAt ??= this.deps.now();
    run.attempts = (run.attempts ?? 0) + 1;
    run.recoveryReason = reason;
    const escalated = this.deps.now() - run.recoveryStartedAt >= 300_000;
    run.retryAt = this.deps.now() + (escalated ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(run.attempts - 1, 5)) * (1 + Math.random() * 0.1));
    this.deps.store.putRun(run);
    if (escalated && !run.escalated) {
      const sent = await this.notice(run, "escalated", `${this.escape(reason)} Chưa khôi phục được sau 5 phút. Cần kiểm tra kết nối/quyền OpenCode; vẫn giữ slot và thử lại mỗi phút, không gửi lại prompt.`);
      run.escalated = sent;
      this.deps.store.patchRun(run.id, { escalated: sent });
    } else if (!escalated) {
      await this.notice(run, "lost", `${this.escape(reason)} Mất quan sát execution; chưa xác nhận đã dừng. Đang tìm lại đúng session/input và đọc bù sự kiện.`);
    }
  }

  private async notice(run: ScheduledRun, key: string, text: string): Promise<boolean> {
    if (run.lastNotice === key) return true;
    const label = `⏰ #${this.escape(run.schedule.id)} · lượt <code>${this.escape(run.id)}</code>\n` +
      `Worker: sch-${this.escape(run.schedule.id)} · topic: ${this.escape(run.binding?.conv ?? "đang chuẩn bị")}\n` +
      `Session: <code>${this.escape(run.binding?.sessionID ?? "chưa tạo")}</code> · hạn: ${new Date(run.deadline).toISOString()}\n` +
      `Kiểm tra cuối: ${run.lastVerifiedAt ? new Date(run.lastVerifiedAt).toISOString() : "chưa có"}\n` +
      `Bằng chứng: ${run.evidence?.terminal ? "đã khớp kết thúc" : run.evidence?.delivered && run.evidence.started ? "đã khớp đầu vào và lượt thực thi" : run.evidence?.enqueued ? "đã khớp đầu vào trong hàng chờ" : "chưa khớp đầu vào/lượt thực thi"}\n`;
    try {
      await this.deps.notify(run.schedule.conv, label + text);
      run.lastNotice = key;
      this.deps.store.patchRun(run.id, { lastNotice: key });
      return true;
    } catch {
      warn("Không gửi được thông báo trạng thái lượt chạy", run.id);
      return false;
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private explain(error: unknown): string {
    if (error instanceof ScheduledEvidenceError || error instanceof ScheduledReadinessError) return error.message;
    const name = (error as { name?: string })?.name ?? "";
    if (/Unauthorized|Forbidden/.test(name)) return "OpenCode từ chối quyền truy cập; cần kiểm tra xác thực và quyền đọc session/log.";
    if (/NotFound/.test(name)) return "Không tìm thấy session hoặc input trên đúng máy chủ; cần kiểm tra dữ liệu, không tự chạy lại.";
    return "Không đọc được thông tin execution; cần kiểm tra kết nối và quyền truy cập OpenCode.";
  }

  private async finish(run: ScheduledRun, phase: "succeeded" | "failed" | "interrupted" | "not-started"): Promise<void> {
    run.phase = phase;
    run.finishedAt = this.deps.now();
    this.deps.store.putRun(run);
    if (run.mode === "automatic" && this.deps.store.get(run.schedule.id)?.lastRunAt === run.admittedAt) {
      this.deps.store.set(run.schedule.id, { lastStatus: phase === "succeeded" ? "ok" :
        this.deps.now() >= run.deadline ? "timeout" : "error" });
    }
    try {
      await this.deps.execution.settled(run);
      await this.notice(run, "terminal", phase === "not-started" ? "Lượt chưa gửi prompt đã kết thúc; không tự chạy lại." :
        `Đã xác nhận execution kết thúc: ${phase === "succeeded" ? "thành công" : phase === "failed" ? "thất bại" : "bị ngắt"}.`);
    } finally {
      this.deps.execution.release(run);
    }
  }

  owns(conv: ConvKey): boolean {
    return this.deps.store.runs().some((r) => r.finishedAt === undefined && (r.binding?.conv === conv || this.deps.execution.matches?.(r, conv)));
  }

  async requestStop(conv: ConvKey): Promise<boolean> {
    const run = this.deps.store.runs().find((r) => r.finishedAt === undefined && (r.binding?.conv === conv || this.deps.execution.matches?.(r, conv)));
    if (!run) return false;
    run.phase = "stopping";
    run.retryAt = 0;
    this.deps.store.putRun(run);
    await this.notice(run, "stop-requested", "Đã ghi nhận yêu cầu dừng; đang xác minh đúng execution trước khi dừng, chưa xác nhận kết thúc.");
    void this.recover(false).catch(() => {});
    return true;
  }

  private current(id: string): ScheduledRun {
    const run = this.deps.store.runs().find((r) => r.id === id);
    if (!run) throw new Error("Không tìm thấy thông tin lượt chạy đã nhận.");
    return run;
  }

  start(): void {
    if (this.timer) return;
    this.closed = false;
    const maintenance = async () => {
      if (this.maintaining || this.closed) return;
      this.maintaining = true;
      try {
        await this.recover(false);
        if (this.deps.now() >= this.nextTick && !this.closed) {
          this.nextTick = this.deps.now() + 30_000;
          await this.tick();
        }
      } catch (e) {
        warn("Không hoàn tất lượt kiểm tra lịch:", e instanceof Error ? e.name : "lỗi dữ liệu");
      } finally { this.maintaining = false; }
    };
    void maintenance();
    this.timer = setInterval(() => { void maintenance(); }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
