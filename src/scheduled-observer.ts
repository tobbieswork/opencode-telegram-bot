import type { RunEvidence, RunObservation, ScheduledRun } from "./scheduled-run.js";

export class ScheduledEvidenceError extends Error {}

export interface HistoryItem {
  type: string;
  aggregateID?: string;
  seq?: number;
  durable?: { aggregateID: string; seq: number };
  data?: { sessionID?: string; inboxID?: string; item?: { type: string } };
}

export interface ObserverTransport {
  source(): string;
  session(id: string): Promise<{ id: string; projectID: string; time: { created: number }; metadata?: Record<string, unknown>; location: { directory?: string } }>;
  active(): Promise<Record<string, unknown>>;
  inbox(id: string): Promise<Array<{ id: string }>>;
  message(sessionID: string, messageID: string): Promise<{ id: string; type: string } | undefined>;
  log(id: string, after?: number): AsyncIterable<HistoryItem>;
  interrupt(id: string): Promise<void>;
  cancel(id: string, messageID: string): Promise<void>;
}

export class ScheduledObserver {
  constructor(private readonly transport: ObserverTransport) {}

  async baseline(sessionID: string): Promise<number> {
    let sequence: number | undefined;
    for await (const item of this.transport.log(sessionID)) {
      if (item.type !== "log.synced") continue;
      if (item.aggregateID !== sessionID || !Number.isSafeInteger(item.seq)) throw new ScheduledEvidenceError("Không có watermark hợp lệ cho session.");
      sequence = item.seq;
      break;
    }
    if (sequence === undefined) throw new ScheduledEvidenceError("Máy chủ không xác nhận đã đọc đủ lịch sử session.");
    return sequence;
  }

  async inspect(run: ScheduledRun): Promise<RunObservation> {
    const b = run.binding;
    if (!b) throw new ScheduledEvidenceError("Lượt chạy chưa có session để tìm lại.");
    if (b.source !== this.transport.source()) return { state: "conflict", reason: "Nguồn OpenCode đã thay đổi." };
    const session = await this.transport.session(b.sessionID);
    if (session.id !== b.sessionID || session.projectID !== b.projectID || session.time.created !== b.createdAt ||
      session.metadata?.tgScheduledRun !== run.id || session.location.directory !== run.schedule.dir) {
      return { state: "conflict", reason: "Session/project/metadata không khớp lượt chạy." };
    }
    const evidence: RunEvidence = { sequence: b.sequence, ...run.evidence };
    let synced = false;
    for await (const item of this.transport.log(b.sessionID, evidence.sequence)) {
      if (item.type === "log.synced") {
        if (item.aggregateID !== b.sessionID || !Number.isSafeInteger(item.seq) || item.seq! < evidence.sequence) {
          evidence.conflict = "Watermark lịch sử không khớp checkpoint.";
        } else evidence.sequence = item.seq!;
        synced = true;
        break;
      }
      if (item.durable?.aggregateID !== b.sessionID || item.data?.sessionID !== b.sessionID ||
        !Number.isSafeInteger(item.durable.seq)) throw new ScheduledEvidenceError("Lịch sử chứa identity không hợp lệ.");
      if (item.durable.seq <= evidence.sequence) continue;
      evidence.sequence = item.durable.seq;
      const target = item.data.inboxID === run.messageID;
      if (item.type === "session.inbox.enqueued") {
        if (target) evidence.enqueued = true;
        else if (item.data.item?.type === "user") evidence.conflict = "Session có input ngoài lượt được quản lý.";
      } else if (item.type === "session.inbox.delivered" && target) {
        evidence.delivered = true;
      } else if (item.type === "session.inbox.cancelled" && target) {
        evidence.terminal = "interrupted";
      } else if (item.type === "session.execution.started") {
        if (!evidence.enqueued || evidence.started) evidence.conflict = "Có execution không xác định hoặc execution mới trong session.";
        evidence.started = true;
      } else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(item.type)) {
        if (!evidence.started || !evidence.delivered || evidence.terminal) evidence.conflict = "Terminal không khớp input/execution đã xác minh.";
        else evidence.terminal = item.type.slice("session.execution.".length) as RunEvidence["terminal"];
      }
    }
    if (!synced) throw new ScheduledEvidenceError("Chưa đọc đủ lịch sử đến watermark.");
    if (evidence.conflict) return { state: "conflict", evidence, reason: evidence.conflict };
    const [active, inbox, message] = await Promise.all([
      this.transport.active(), this.transport.inbox(b.sessionID), this.transport.message(b.sessionID, run.messageID),
    ]);
    if (message && (message.id !== run.messageID || message.type !== "user")) {
      return { state: "conflict", evidence, reason: "Message identity không khớp input." };
    }
    if (inbox.some((i) => i.id !== run.messageID)) return { state: "conflict", evidence, reason: "Session có input khác đang chờ." };
    if (evidence.terminal) {
      if (active[b.sessionID]) return { state: "conflict", evidence, reason: "Có execution active sau terminal của lượt này." };
      return { state: evidence.terminal, evidence };
    }
    if (evidence.started && evidence.delivered && active[b.sessionID] && message) return { state: "running", evidence };
    if (evidence.enqueued && !evidence.delivered && inbox.some((i) => i.id === run.messageID)) return { state: "pending", evidence };
    throw new ScheduledEvidenceError("Chưa đủ bằng chứng để xác nhận execution hoặc terminal; tiếp tục tìm lại.");
  }

  async stop(run: ScheduledRun, observed: RunObservation): Promise<void> {
    if (observed.state === "conflict") throw new Error("Identity mâu thuẫn; chưa xác minh được execution để dừng.");
    const current = await this.inspect(run);
    if (current.state === "conflict") throw new Error("Chưa xác minh ownership của execution để dừng.");
    if (current.state === "pending") await this.transport.cancel(run.binding!.sessionID, run.messageID);
    else if (current.state === "running" || current.state === "waiting") await this.transport.interrupt(run.binding!.sessionID);
  }
}
