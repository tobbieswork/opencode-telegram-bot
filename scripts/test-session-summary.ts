import assert from "node:assert/strict";
import { buildSessionSummary } from "../src/session-summary.js";
import { SessionDashboard, DASHBOARD_PHASE_LABELS } from "../src/session-dashboard.js";
import { SessionTopics } from "../src/session-topics.js";
import { SessionActivityLog } from "../src/session-activity.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
const forbidden = async (): Promise<never> => { throw new Error("Xem tóm tắt không được đổi tài nguyên"); };
const topics = new SessionTopics(f.st, { createSession: forbidden, session: forbidden, createTopic: forbidden,
  archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden });
const view = new SessionDashboard({ store: f.st, topics, observe: async id => f.observations.get(id)! });
try {
  const row = (await view.read("-1001"))[0];
  const empty = buildSessionSummary("-1001", row, { now: Date.now() });
  assert.ok(empty.text.includes("Chưa có yêu cầu gần nhất được đối chiếu"));
  assert.ok(empty.text.includes("Chưa có bước tiếp theo được ghi nhận"));
  assert.throws(() => buildSessionSummary("-1002", row, { now: Date.now() }));
  const log = new SessionActivityLog(f.st);
  log.begin("-1001:200", { sessionID: row.sessionID!, inputID: "input_summary", text: "Sửa <đăng nhập>", source: "topic" });
  log.complete("-1001:200", { sessionID: row.sessionID!, inputID: "input_summary", messageID: "reply_summary", text: "Tôi đã sửa và kiểm thử xong.", outcome: "succeeded" });
  const populated = (await view.read("-1001"))[0];
  const summary = buildSessionSummary("-1001", populated, { now: Date.now() });
  assert.ok(summary.text.includes("Sửa &lt;đăng nhập&gt;"));
  assert.ok(summary.text.includes("không phải bằng chứng độc lập"));
  assert.ok(summary.text.includes("Chưa có bước tiếp theo được ghi nhận"));
  assert.equal(buildSessionSummary("-1001", populated, { now: Date.now() + 9999 }).marker, summary.marker, "Thời điểm mở thẻ không phải mốc công việc");
  const malicious = { ...populated, activity: { ...populated.activity!, sessionID: "ses_other", input: { ...populated.activity!.input, snippet: "KHONG_DUOC_LO" } } };
  assert.ok(!buildSessionSummary("-1001", malicious, { now: Date.now() }).text.includes("KHONG_DUOC_LO"));
  const long = { ...populated, reason: "<".repeat(10_000), titleError: "&".repeat(10_000), activity: { ...populated.activity!,
    input: { ...populated.activity!.input, snippet: "<&".repeat(600) }, result: { ...populated.activity!.result!, snippet: "<&".repeat(900) } } };
  assert.ok(buildSessionSummary("-1001", long, { now: Date.now() }).text.length < 3900);

  await f.bot.handle(f.tap("sum:show:0000000000000001"));
  assert.ok(f.sent.at(-1)?.text.includes("Sửa &lt;đăng nhập&gt;"));
  const refresh = f.buttons().find(button => button.callback_data?.startsWith("sum:refresh:"))!.callback_data!;
  let snapshots = 0;
  f.oc.activitySnapshot = async id => { snapshots++; return { info: structuredClone(f.observations.get(id)!.info), messages: [
    { id: "reply_native", type: "assistant", content: [{ type: "text", text: "Đã quan sát kết quả mới" }], time: { created: Date.now() - 5000 } },
    { id: "input_native", type: "user", text: "Mục tiêu mới qua OpenCode", time: { created: Date.now() - 10000 } },
  ] }; };
  const before = structuredClone(f.st.all());
  const bindings = f.st.sessionTopics();
  await f.bot.handle(f.tap(refresh, 2));
  assert.equal(snapshots, 0);
  await f.bot.handle(f.tap(refresh));
  assert.equal(snapshots, 1);
  assert.ok(f.sent.at(-1)?.text.includes("Mục tiêu mới qua OpenCode"));
  assert.equal(f.st.peek("-1001:200")?.lastRelayedTime, before["-1001:200"].lastRelayedTime);
  assert.deepEqual(f.st.peek("-1001:200")?.worker, before["-1001:200"].worker);
  await f.bot.handle(f.tap("sum:show:0000000000000004"));
  assert.ok(f.sent.at(-1)?.text.includes("Đã đóng"));
  assert.ok(f.buttons().some(button => button.text === "Mở lại phiên"));
  const closedRefresh = f.buttons().find(button => button.callback_data?.startsWith("sum:refresh:"))!.callback_data!;
  await f.bot.handle(f.tap(closedRefresh));
  assert.equal(snapshots, 2, "Phiên đóng chỉ được đọc, không cần khôi phục");
  assert.equal(f.st.sessionTopics()?.links["0000000000000004"].phase, "closed");
  for (const item of await view.read("-1001", { refresh: true })) {
    const text = buildSessionSummary("-1001", item, { now: Date.now() }).text;
    assert.ok(text.includes(DASHBOARD_PHASE_LABELS[item.lifecycle]));
    assert.ok(text.includes("Chưa có bước tiếp theo được ghi nhận"));
    if (item.work === "running") assert.ok(text.includes("Đang chạy"));
    if (item.pending.some(prompt => prompt.verified)) assert.ok(text.includes("yêu cầu cấp quyền đã xác minh"));
  }
  f.oc.activitySnapshot = async () => { throw new Error("Nguồn lịch sử tạm thời lỗi"); };
  f.oc.dashboardObservation = async () => { throw new Error("Nguồn trạng thái tạm thời lỗi"); };
  await f.bot.handle(f.tap("sum:show:0000000000000002"));
  const failedRefresh = f.buttons().find(button => button.callback_data?.startsWith("sum:refresh:"))!.callback_data!;
  await f.bot.handle(f.tap(failedRefresh));
  assert.ok(f.sent.at(-1)?.text.includes("Làm mới chưa đầy đủ"));
  assert.ok(f.sent.at(-1)?.text.includes("Chưa xác minh"));
  assert.deepEqual(f.st.sessionTopics(), bindings);
  assert.equal(f.effects.length, 0);
  console.log("Đạt: tóm tắt có nguồn, không suy đoán kết quả/bước tiếp; giới hạn HTML; làm mới đúng người/phiên, không thực thi hoặc đổi vòng đời/mốc chuyển tiếp.");
} finally { topics.stopTitleSync(); f.dispose(); }
