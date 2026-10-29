import type { ChatState } from "../../src/state.js";
import type { SessionTopicsData, TopicSession } from "../../src/session-topics.js";
import type { ScheduledRun } from "../../src/scheduled-run.js";

/** Dữ liệu độc lập, không đọc trạng thái hoặc thông tin xác thực của bot thật. */
export function workflowFixture() {
  const now = 1_800_000_000_000;
  const states: Record<string, ChatState> = { "-1003": { directory: "/projects/legacy" } };
  const topics: SessionTopicsData = { version: 1, groups: { "-1001": true, "-1002": true }, links: {},
    titleSyncGroups: { "-1001": true } };
  const sessions: Record<string, TopicSession> = {};
  for (const [index, name] of ["idle", "running", "waiting", "closed", "attention", "title-error", "schedule", "other-group"].entries()) {
    const id = (index + 1).toString(16).padStart(16, "0");
    const chat = name === "other-group" ? "-1002" : "-1001";
    const conv = `${chat}:${200 + index}`;
    const sessionID = `ses_fixture_${index}`;
    const phase = name === "closed" ? "closed" : name === "attention" ? "attention" : "open";
    const busy = ["running", "waiting", "schedule"].includes(name);
    topics.links[id] = { id, chat, conv, sessionID, operationID: `fixture:${name}`, directory: "/projects/app",
      title: "Sửa đăng nhập", phase, configured: true,
      identity: { projectID: "project-fixture", source: "fixture", createdAt: now - 100_000 + index },
      ...(name === "attention" ? { step: "verify-open", error: "Chưa xác minh được" } : {}),
      ...(name === "title-error" ? { titleSync: { pending: true, error: "Thiếu quyền đổi tên", retryAt: now + 5000 } } : {}) };
    sessions[sessionID] = { id: sessionID, directory: "/projects/app", title: "Sửa đăng nhập",
      ...topics.links[id].identity!, archived: name === "closed", busy, terminal: !busy };
    states[conv] = { sessionID, directory: "/projects/app", worker: { name,
      status: name === "waiting" ? "waiting" : busy ? "running" : "idle",
      spawnedBy: name === "schedule" ? "schedule" : "user", createdAt: now - 100_000, updatedAt: now - 1000 } };
    if (name === "waiting") states[conv].pendingPrompts = {
      form_fixture: { kind: "form", text: "Chọn cách xử lý", firstShownAt: now - 20_000, remindersSent: 1,
        nextReminderAt: now + 30_000, messageId: 300 },
      permission_fixture: { kind: "permission", text: "Cho phép sửa tệp?", firstShownAt: now - 10_000,
        remindersSent: 0, nextReminderAt: now + 40_000, messageId: 301 },
    };
  }
  const runs: ScheduledRun[] = [{ id: "run_fixture", messageID: "msg_fixture", mode: "automatic",
    admittedAt: now - 30_000, deadline: now + 90_000, phase: "recovering", recoveryReason: "Chưa xác nhận kết thúc",
    binding: { conv: "-1001:206", sessionID: "ses_fixture_6", source: "fixture", projectID: "project-fixture",
      createdAt: sessions.ses_fixture_6.createdAt, sequence: 10 },
    schedule: { id: "test", conv: "-1001", prompt: "Kiểm tra dự án", spec: { kind: "every", hours: 1 },
      tz: "Asia/Ho_Chi_Minh", dir: "/projects/app", agent: "plan", nextRunAt: now + 3_600_000,
      enabled: true, createdBy: 1, createdAt: now - 3_600_000 } }];
  return { now, states, topics, sessions, runs };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Đồng hồ và bộ hẹn giờ giả; thứ tự cùng thời điểm được xác định bằng mã tăng dần. */
export class WorkflowClock {
  private next = 0;
  private timers = new Map<number, { at: number; run: () => void | Promise<void> }>();
  constructor(public now: number) {}
  schedule(delay: number, run: () => void | Promise<void>): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + Math.max(0, delay), run });
    return id;
  }
  cancel(id: number): void { this.timers.delete(id); }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (let steps = 0; ; steps++) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      if (steps >= 10_000) throw new Error("Bộ hẹn giờ giả bị lặp không dừng.");
      this.timers.delete(entry[0]);
      this.now = entry[1].at;
      await entry[1].run();
    }
    this.now = target;
  }
}
