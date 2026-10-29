import assert from "node:assert/strict";
import { workflowBot } from "./fixtures/bot-workflow.js";
import { dashboardPage, SessionDashboard } from "../src/session-dashboard.js";
import { SessionTopics } from "../src/session-topics.js";

const f = workflowBot();
try {
  await f.bot.handle(f.message("/sessions"));
  assert.equal(f.sent.length, 1, "Bảng điều khiển không gửi một thẻ cho từng liên kết");
  assert.ok(f.sent[0].text.includes("Phiên đang quản lý"));
  assert.ok(f.buttons().some(button => button.text === "Gắn phiên có sẵn"));
  const pendingFilter = f.buttons().find(button => button.text.startsWith("Đang chờ bạn"))!.callback_data!;
  const closedFilter = f.buttons().find(button => button.text.startsWith("Đã đóng"))!.callback_data!;
  const detail = f.buttons().find(button => button.callback_data?.includes(":detail:"))!.callback_data!;
  assert.ok(f.buttons().every(button => !button.callback_data || Buffer.byteLength(button.callback_data) <= 64));
  assert.ok(f.reads.every(id => id !== "ses_fixture_7"));
  assert.equal(f.effects.length, 0);
  const forbidden = async (): Promise<never> => { throw new Error("Không được đổi tài nguyên"); };
  const topics = new SessionTopics(f.st, { createSession: forbidden, session: forbidden, createTopic: forbidden,
    archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden });
  const projection = new SessionDashboard({ store: f.st, topics, observe: async id => f.observations.get(id)! });
  const templateRow = (await projection.read("-1001"))[0];
  for (const [count, pages, lastCount] of [[0, 1, 0], [1, 1, 1], [10, 1, 10], [11, 2, 1]]) {
    const rows = Array.from({ length: count }, (_, index) => ({ ...templateRow, id: `page_${index}` }));
    const page = dashboardPage(rows, "all", 100);
    assert.equal(page.pages, pages);
    assert.equal(page.rows.length, lastCount);
  }
  const before = f.sent.length;
  await f.bot.handle(f.tap(detail, 2));
  assert.ok(f.sent.at(-1)?.text.includes("không thuộc bạn"));
  await f.bot.handle(f.tap(detail, 1, -1002));
  assert.ok(f.sent.at(-1)?.text.includes("không thuộc bạn"));
  await f.bot.handle(f.tap(detail, 1, -1001, 202));
  assert.equal(f.sent.length, before + 2);
  await f.bot.handle(f.tap(pendingFilter));
  assert.ok(f.sent.at(-1)?.text.includes("1 phiên"));
  assert.equal(f.buttons().filter(button => button.callback_data?.includes(":detail:")).length, 1);
  await f.bot.handle(f.tap(closedFilter));
  assert.ok(f.sent.at(-1)?.text.includes("Đã đóng"));
  assert.equal(f.buttons().filter(button => button.callback_data?.includes(":detail:")).length, 1);
  await f.bot.handle(f.tap(detail));
  assert.ok(f.sent.at(-1)?.text.includes("Session:"));
  assert.equal(f.effects.length, 0);
  await f.bot.handle(f.message("/attach"));
  assert.ok(f.sent.at(-1)?.text.includes("Chọn phiên để gắn"));
  assert.ok(f.buttons().some(button => button.callback_data === "cmd:new"));
  console.log("Đạt: bảng điều khiển gọn, bộ lọc, thẻ chi tiết và lối gắn riêng; nút gắn đúng người/nhóm, không đổi tài nguyên.");

  const data = f.st.sessionTopics()!;
  const template = data.links["0000000000000001"];
  for (let i = 10; i < 22; i++) {
    const id = i.toString(16).padStart(16, "0");
    const sessionID = `ses_page_${i}`;
    const conv = `-1001:${300 + i}`;
    data.links[id] = { ...template, id, conv, sessionID, operationID: id, title: `Phiên trang ${i}` };
    f.st.set(conv, { sessionID });
    f.observations.set(sessionID, { info: { ...f.observations.get("ses_fixture_0")!.info, id: sessionID },
      work: "idle", forms: [], permissions: [] });
  }
  f.st.commitSessionTopics(data);
  await f.bot.handle(f.message("/sessions"));
  assert.equal(f.buttons().filter(button => button.callback_data?.includes(":detail:")).length, 10);
  const next = f.buttons().find(button => button.text === "Trang sau ➡️")!.callback_data!;
  await f.bot.handle(f.tap(next));
  assert.ok(f.sent.at(-1)?.text.includes("Trang 2/2"));
  assert.ok(f.buttons().filter(button => button.callback_data?.includes(":detail:")).length <= 10);
  console.log("Đạt: phân trang giới hạn 10 hàng, số trang và phạm vi ổn định sau khi thêm phiên.");
} finally { f.dispose(); }
