import assert from "node:assert/strict";
import { ScheduledObserver, type ObserverTransport, type HistoryItem } from "../src/scheduled-observer.js";
import type { ScheduledRun } from "../src/scheduled-run.js";

const sessionID = "ses_target";
const messageID = "msg_target";
const run: ScheduledRun = {
  id: "run_target", schedule: { id: "abcd", conv: "1", prompt: "Kiểm tra", dir: "/project", agent: "plan",
    spec: { kind: "daily", time: { h: 9, m: 0 } }, tz: "UTC", nextRunAt: 0,
    enabled: true, createdBy: 1, createdAt: 1 },
  messageID, mode: "manual", admittedAt: 10, deadline: 1000, phase: "recovering",
  binding: { sessionID, conv: "1:2", source: "server", projectID: "project", createdAt: 5, sequence: 1 },
};
const event = (seq: number, type: string, inboxID?: string): HistoryItem => ({
  type, durable: { aggregateID: sessionID, seq }, data: { sessionID, ...(inboxID ? { inboxID } : {}) },
});
const items: HistoryItem[] = [event(2, "session.inbox.enqueued", messageID),
  event(3, "session.execution.started"), event(4, "session.inbox.delivered", messageID),
  event(5, "session.execution.succeeded"), { type: "log.synced", aggregateID: sessionID, seq: 5 }];
let active = false;
let interrupted = 0;
const transport: ObserverTransport = {
  source: () => "server",
  session: async () => ({ id: sessionID, projectID: "project", time: { created: 5 },
    metadata: { tgScheduledRun: run.id }, location: { directory: "/project" } }),
  active: async () => active ? { [sessionID]: {} } : {},
  inbox: async () => [],
  message: async () => ({ id: messageID, type: "user" }),
  log: async function* (_id, after) { for (const item of items) if (!item.durable || item.durable.seq > (after ?? -1)) yield item; },
  interrupt: async () => { interrupted++; },
  cancel: async () => {},
};
const observer = new ScheduledObserver(transport);
const recovered = await observer.inspect(run);
assert.equal(recovered.state, "succeeded", "đọc bù terminal bị mất trên luồng trực tiếp");
assert.equal(recovered.evidence?.sequence, 5, "checkpoint dùng watermark đã xác nhận");
active = true;
items.splice(4, 0, event(6, "session.execution.started"));
const conflict = await observer.inspect(run);
assert.equal(conflict.state, "conflict", "không nhận execution mới là lượt cũ");
await assert.rejects(observer.stop(run, conflict), /xác minh|mâu thuẫn/, "không interrupt nhầm execution");
assert.equal(interrupted, 0);
console.log("Đạt: tìm đúng execution qua lịch sử và từ chối dừng khi identity mâu thuẫn.");
