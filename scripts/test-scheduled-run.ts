import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleStore } from "../src/scheduler.js";
import { ScheduledRuns, type ScheduledExecution, type ScheduledRun } from "../src/scheduled-run.js";
import type { Schedule } from "../src/schedule.js";

const parent = join(tmpdir(), "opencode");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "scheduled-run-"));
const NOW = Date.UTC(2026, 9, 28, 2);
const schedule: Schedule = {
  id: "abcd", conv: "1:2", prompt: "Kiểm tra dự án", dir: root, agent: "plan",
  spec: { kind: "daily", time: { h: 9, m: 0 } }, tz: "Asia/Ho_Chi_Minh",
  nextRunAt: NOW, enabled: true, createdBy: 1, createdAt: NOW - 1000,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

try {
  const store = new ScheduleStore(join(root, "runs.json"), 10);
  store.add(schedule);
  const entered = deferred();
  const release = deferred();
  const claims = new Set<string>();
  let submitted = 0;
  const execution: ScheduledExecution = {
    ready: async () => {},
    claim: (_s, id) => { claims.add(id); },
    release: (run) => { claims.delete(run.id); },
    restore: (run) => { claims.add(run.id); },
    prepare: async () => {
      entered.resolve();
      await release.promise;
      return { conv: "1:9", sessionID: "ses_one", source: "test", projectID: "project", createdAt: NOW, sequence: 0 };
    },
    submit: async () => { submitted++; },
    inspect: async () => ({ state: "running" }),
    stop: async () => {},
    settled: async () => {},
  };
  const runs = new ScheduledRuns({ store, execution, now: () => NOW, enabled: () => true,
    isAllowed: () => true, timeoutMs: 60_000, notify: async () => {} });
  const automatic = runs.tick();
  await entered.promise;
  const manual = await runs.run(schedule.id, "manual", schedule.conv);
  assert.equal(manual.accepted, false, "lượt thủ công không vượt lượt tự động đang chuẩn bị");
  assert.equal(claims.size, 1, "một lượt chỉ giữ một slot");
  release.resolve();
  await automatic;
  assert.equal(submitted, 1, "chỉ gửi một prompt khi tick và manual cạnh tranh");
  runs.stop();
  console.log("Đạt: tick và manual dùng chung admission.");

  const timedStore = new ScheduleStore(join(root, "deadline.json"), 10);
  timedStore.add(schedule);
  let now = NOW;
  let stoppedSession: string | undefined;
  let outcome: "running" | "interrupted" = "running";
  const timedExecution: ScheduledExecution = {
    ...execution,
    prepare: async () => ({ conv: "1:10", sessionID: "ses_deadline", source: "test", projectID: "project", createdAt: NOW, sequence: 0 }),
    inspect: async () => ({ state: outcome }),
    stop: async (run) => { stoppedSession = run.binding?.sessionID; },
  };
  const timedDeps = { store: timedStore, execution: timedExecution, now: () => now,
    enabled: () => true, isAllowed: () => true, timeoutMs: 60_000, notify: async () => {} };
  const beforeRestart = new ScheduledRuns(timedDeps);
  await beforeRestart.run(schedule.id, "manual");
  beforeRestart.stop();
  now += 60_001;
  const afterRestart = new ScheduledRuns(timedDeps);
  await afterRestart.recover();
  assert.equal(stoppedSession, "ses_deadline", "khôi phục deadline và yêu cầu dừng đúng session");
  assert.equal(timedStore.runs()[0].finishedAt, undefined, "yêu cầu dừng chưa phải xác nhận kết thúc");
  assert.ok(claims.has(timedStore.runs()[0].id), "vẫn giữ slot khi chưa xác nhận dừng");
  outcome = "interrupted";
  await afterRestart.recover();
  assert.equal(timedStore.runs()[0].phase, "interrupted", "settle khi có bằng chứng terminal");
  assert.ok(!claims.has(timedStore.runs()[0].id), "nhả slot sau xác nhận terminal");
  afterRestart.stop();
  console.log("Đạt: khôi phục deadline, không báo dừng hoặc nhả slot quá sớm.");

  const lostStore = new ScheduleStore(join(root, "lost-response.json"), 10);
  lostStore.add(schedule);
  const notices: string[] = [];
  let connected = false;
  let sent = 0;
  now = NOW;
  const lost = new ScheduledRuns({ ...timedDeps, store: lostStore, timeoutMs: 600_000,
    notify: async (_conv, text) => { notices.push(text); },
    execution: { ...timedExecution,
      submit: async (run) => {
        assert.equal(lostStore.runs()[0].messageID, run.messageID, "lưu identity trước request");
        sent++;
        throw new Error("Mất phản hồi sau khi server nhận prompt");
      },
      inspect: async () => { if (!connected) throw new Error("Mất kết nối"); return { state: "running" }; },
    },
  });
  const accepted = await lost.run(schedule.id, "manual");
  assert.equal(accepted.accepted, true, "mất phản hồi không được báo chưa nhận chạy");
  await lost.recover();
  now += 300_001;
  await lost.recover();
  const count = notices.length;
  await lost.recover();
  assert.equal(notices.length, count, "không lặp cảnh báo mỗi lần retry");
  assert.ok(notices.some((text) => text.includes("5 phút")), "cảnh báo khi recovery quá năm phút");
  connected = true;
  await lost.recover();
  assert.equal(lostStore.runs()[0].phase, "active", "tìm lại đúng execution và nối lại theo dõi");
  assert.equal(sent, 1, "khôi phục observation không gửi lại prompt");
  lost.stop();
  console.log("Đạt: mất phản hồi, khôi phục chủ động và cảnh báo không lặp.");

  const guardedStore = new ScheduleStore(join(root, "guards.json"), 10);
  guardedStore.add({ ...schedule, nextRunAt: NOW - 10_000_000 });
  let enabled = false;
  let ready = true;
  const guarded = new ScheduledRuns({ ...timedDeps, store: guardedStore, now: () => NOW,
    enabled: () => enabled, execution: { ...timedExecution,
      ready: async () => { if (!ready) throw new Error("Thiếu khả năng đọc log"); },
    },
  });
  await guarded.tick();
  assert.equal(guardedStore.get(schedule.id)?.nextRunAt, NOW - 10_000_000, "master OFF không consume lịch");
  enabled = true;
  ready = false;
  const denied = await guarded.run(schedule.id, "manual");
  assert.equal(denied.accepted, false, "thiếu capability chặn admission");
  assert.equal(guardedStore.runs().length, 0, "readiness lỗi không tạo run");
  assert.equal(guardedStore.get(schedule.id)?.nextRunAt, NOW - 10_000_000, "readiness lỗi không đổi mốc");
  guarded.stop();
  console.log("Đạt: master switch và readiness chặn trước admission.");

  const preparingStore = new ScheduleStore(join(root, "stop-preparing.json"), 10);
  preparingStore.add(schedule);
  const preparation = deferred();
  const preparing = deferred();
  let preparedSends = 0;
  const stoppedBeforePrompt = new ScheduledRuns({ ...timedDeps, store: preparingStore, now: () => NOW,
    execution: { ...timedExecution,
      matches: (_run, conv) => conv === "1:10",
      prepare: async () => {
        preparing.resolve(); await preparation.promise;
        return { conv: "1:10", sessionID: "ses_preparing", source: "test", projectID: "project", createdAt: NOW, sequence: 0 };
      },
      submit: async () => { preparedSends++; },
    },
  });
  const pendingPreparation = stoppedBeforePrompt.run(schedule.id, "manual");
  await preparing.promise;
  assert.equal(await stoppedBeforePrompt.requestStop("1:10"), true, "stop nhận diện lượt đang chuẩn bị trước khi có binding");
  preparation.resolve();
  await pendingPreparation;
  assert.equal(preparedSends, 0, "không gửi prompt sau yêu cầu stop trong lúc chuẩn bị");
  assert.equal(preparingStore.runs()[0].phase, "not-started");
  stoppedBeforePrompt.stop();
  console.log("Đạt: stop trong lúc chuẩn bị không bị ghi đè hoặc gửi prompt muộn.");

  rmSync(join(root, "deadline.json"));
  assert.throws(() => timedStore.runs(), /dữ liệu|file|mất/, "không coi file biến mất là danh sách run rỗng");
  console.log("Đạt: mất file metadata không làm quên ownership một cách âm thầm.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
