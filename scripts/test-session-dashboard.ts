import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../src/state.js";
import { SessionTopics } from "../src/session-topics.js";
import { SessionDashboard, type DashboardObservation } from "../src/session-dashboard.js";
import { workflowFixture, deferred } from "./fixtures/workflow.js";

const root = mkdtempSync(join(tmpdir(), "session-dashboard-"));
try {
  const fixture = workflowFixture();
  const st = new StateManager(join(root, "state.json"));
  for (const [conv, state] of Object.entries(fixture.states)) st.set(conv, state);
  st.commitSessionTopics(fixture.topics);
  const forbidden = async (): Promise<never> => { throw new Error("Danh sách không được đổi tài nguyên"); };
  const topics = new SessionTopics(st, { createSession: forbidden, session: forbidden, createTopic: forbidden,
    archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden });
  let now = fixture.now;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let failed = false;
  let unknownForms = false;
  let forms = ["form_fixture"];
  const gate = deferred<void>();
  let held = false;
  const dashboard = new SessionDashboard({ store: st, topics, now: () => now, ttlMs: 1000, concurrency: 2,
    observe: async id => {
      calls++; active++; maxActive = Math.max(active, maxActive);
      try {
        if (held) await gate.promise;
        if (failed) throw new Error("Mất kết nối");
        return { info: structuredClone(fixture.sessions[id]), work: "idle", forms: unknownForms ? undefined : forms,
          permissions: [] } satisfies DashboardObservation;
      } finally { active--; }
    } });
  const initial = await dashboard.read("-1001");
  assert.equal(calls, 0);
  assert.equal(initial.length, 7);
  assert.ok(initial.every(row => row.chat === "-1001" && row.work === "unknown"));
  assert.equal(initial.find(row => row.conv === "-1001:205")?.titleError, "Thiếu quyền đổi tên");
  assert.deepEqual(initial.find(row => row.conv === "-1001:202")?.pending.map(item => item.verified), [false, false]);
  const before = structuredClone(st.sessionTopics());
  const refreshed = await dashboard.read("-1001", { refresh: true, ids: ["0000000000000003"] });
  const waiting = refreshed.find(row => row.conv === "-1001:202")!;
  assert.equal(waiting.work, "idle");
  assert.deepEqual(waiting.pending.map(item => [item.id, item.verified]), [["form_fixture", true]]);
  assert.equal(waiting.pending[0].messageId, 300);
  assert.deepEqual(st.sessionTopics(), before);
  assert.equal(st.peek("-1001:202")?.pendingPrompts?.permission_fixture.remindersSent, 0);
  await dashboard.read("-1001", { refresh: true, ids: [waiting.id] });
  assert.equal(calls, 1, "Bấm lại trong hạn dùng lại dữ liệu đã đọc");
  unknownForms = true;
  now += 1100;
  const uncertain = (await dashboard.read("-1001", { refresh: true, ids: [waiting.id] })).find(row => row.id === waiting.id)!;
  assert.equal(uncertain.pending[0].verified, false);
  assert.equal(uncertain.pending[0].id, "form_fixture");
  assert.equal(uncertain.work, "idle", "Lỗi đọc câu hỏi không biến trạng thái thực thi thành lỗi");
  failed = true;
  now += 1100;
  const offline = (await dashboard.read("-1001", { refresh: true, ids: [waiting.id] })).find(row => row.id === waiting.id)!;
  assert.equal(offline.work, "unknown");
  assert.equal(offline.lastKnownWork, "idle");
  assert.ok(offline.reason?.includes("Mất kết nối"));
  assert.ok(offline.pending.some(item => item.id === "form_fixture" && !item.verified));
  assert.ok(!offline.pending.some(item => item.id === "permission_fixture"), "Không hồi sinh quyền đã được xác minh hết chờ chỉ vì lần đọc sau lỗi");
  failed = false; unknownForms = false; forms = [];
  now += 1100;
  const resolved = (await dashboard.read("-1001", { refresh: true, ids: [waiting.id] })).find(row => row.id === waiting.id)!;
  assert.deepEqual(resolved.pending, [], "Danh sách trống đã xác minh loại bỏ yêu cầu cũ khỏi mô hình đọc, không sửa lời nhắc");

  held = true;
  now += 1100;
  const refresh = dashboard.read("-1001", { refresh: true });
  for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r));
  assert.ok(maxActive <= 2);
  gate.resolve();
  await refresh;
  assert.ok(maxActive <= 2);
  assert.equal((await dashboard.read("-1002"))[0].work, "unknown");
  const corrupt = new SessionDashboard({ store: st, topics, observe: async id => ({
    info: { ...fixture.sessions[id], projectID: "khong-khop" }, work: "done", forms: [], permissions: [],
  }) });
  const conflict = (await corrupt.read("-1001", { refresh: true, ids: [waiting.id] })).find(row => row.id === waiting.id)!;
  assert.equal(conflict.work, "unknown");
  assert.ok(conflict.reason?.includes("Danh tính"));
  let aborted = false;
  const slow = new SessionDashboard({ store: st, topics, timeoutMs: 10, observe: (_id, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("Đã hủy truy vấn")); }, { once: true });
  }) });
  const timeout = (await slow.read("-1001", { refresh: true, ids: [waiting.id] })).find(row => row.id === waiting.id)!;
  assert.equal(aborted, true);
  assert.equal(timeout.work, "unknown");
  await assert.rejects(() => dashboard.read("-1001:202"), /General/);
  console.log("Đạt: mô hình đọc cách ly nhóm, không sửa tài nguyên, phân biệt chưa rõ/rỗng, độ mới từng chiều và giới hạn làm mới.");
} finally { rmSync(root, { recursive: true, force: true }); }
