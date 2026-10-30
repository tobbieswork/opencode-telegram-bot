import assert from "node:assert/strict";
import { rankedSearch, searchManaged, searchQuery, searchText } from "../src/session-search.js";
import { SessionDashboard } from "../src/session-dashboard.js";
import { SessionTopics } from "../src/session-topics.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

assert.equal(searchText("ĐĂNG NHẬP"), "dang nhap");
assert.equal(searchText("Đăng nhập"), "dang nhap");
assert.throws(() => searchQuery("   "));
assert.throws(() => searchQuery("x".repeat(121)));
const entries = [
  { id: "a", title: "Đăng nhập", directory: "/a", at: 1 },
  { id: "b", title: "Sửa đăng nhập", directory: "/b", at: 100 },
  { id: "c", title: "Khác", directory: "/dang-nhap", summary: "đăng nhập", at: 1000 },
];
assert.deepEqual(rankedSearch(entries, "dang nhap").map(entry => entry.id), ["a", "b", "c"]);
assert.equal(rankedSearch([{ id: "emoji", title: "👩‍💻 <tên>", directory: "/", at: 0 }], "👩‍💻").length, 1);
const f = workflowBot();
const forbidden = async (): Promise<never> => { throw new Error("Tìm không được đổi tài nguyên"); };
const topics = new SessionTopics(f.st, { createSession: forbidden, session: forbidden, createTopic: forbidden, archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden });
try {
  const rows = await new SessionDashboard({ store: f.st, topics, observe: async id => f.observations.get(id)! }).read("-1001");
  const duplicates = Array.from({ length: 23 }, (_, n) => ({ ...rows[0], id: `${n}`.padStart(16, "0"), title: "Đăng nhập", lastActivityAt: 1 }));
  const result = searchManaged("-1001", [...duplicates, { ...duplicates[0], chat: "-1002", title: "Đăng nhập bí mật" }], "dang nhap", "all", 1);
  assert.equal(result.rows.length, 10); assert.equal(result.total, 23);
  assert.equal(new Set(result.rows.map(row => row.id)).size, 10);
  const changedPage = searchManaged("-1001", duplicates.map((row, n) => n === 10 ? { ...row, title: "Không còn khớp" } : row), "dang nhap", "all", 1);
  assert.equal(changedPage.total, 22);
  assert.ok(!changedPage.rows.some(row => row.id === duplicates[10].id), "Đổi dữ liệu giữa trang phải tính lại kết quả");
  assert.ok(result.rows.every(row => row.chat === "-1001"));
  assert.equal(searchManaged("-1001", [{ ...rows[0], lifecycle: "closed", title: "Đăng nhập" }], "dang nhap", "all").total, 0);
  assert.equal(searchManaged("-1001", [{ ...rows[0], lifecycle: "closed", title: "Đăng nhập" }], "dang nhap", "closed").total, 1);
  const data = f.st.sessionTopics()!;
  for (const link of Object.values(data.links)) if (link.chat === "-1001") link.title = "Đăng nhập <thử>";
  f.st.commitSessionTopics(data);
  await f.bot.handle(f.tap("ss:start"));
  const prompt = f.sent.length;
  const reply = f.message("dang nhap"); reply.message!.reply_to_message = { message_id: prompt };
  await f.bot.handle(reply);
  assert.ok(f.sent.at(-1)?.text.includes("Đăng nhập &lt;thử&gt;"));
  const pick = f.buttons().find(button => button.callback_data?.startsWith("ss:pick:"))!.callback_data!;
  await f.bot.handle(f.tap(pick, 2)); assert.ok(f.sent.at(-1)?.text.includes("không thuộc bạn"));
  await f.bot.handle(f.tap(pick)); assert.ok(f.buttons().some(button => button.text === "Xem tóm tắt"));
  assert.equal(f.effects.length, 0);
  assert.equal(f.reads.length, 0, "Tìm dữ liệu đã lưu không đọc mọi phiên hoặc lịch sử");
  f.st.setRequired("-1001", { directory: "/projects/app" });
  f.st.setRequired("-1002:300", { sessionID: "ses_foreign", directory: "/projects/app" });
  f.oc.listSessions = async () => [
    { id: "ses_free", title: "Đăng nhập có thể gắn", directory: "/projects/app", updated: 1 },
    { id: "ses_child", title: "Đăng nhập phiên con", directory: "/projects/app", parentID: "ses_parent" },
    { id: "ses_archived", title: "Đăng nhập lưu trữ", directory: "/projects/app", archived: true },
    { id: "ses_foreign", title: "Đăng nhập nhóm khác", directory: "/projects/app" },
  ];
  await f.bot.handle(f.tap("ss:start"));
  const nextReply = f.message("dang nhap"); nextReply.message!.reply_to_message = { message_id: f.sent.length };
  await f.bot.handle(nextReply);
  const mode = f.buttons().find(button => button.callback_data?.includes(":attach"))!.callback_data!;
  await f.bot.handle(f.tap(mode));
  const list = f.sent.at(-1)!.text;
  assert.ok(list.includes("Đăng nhập có thể gắn"));
  assert.ok(!list.includes("Đăng nhập phiên con") && !list.includes("Đăng nhập lưu trữ") && !list.includes("Đăng nhập nhóm khác"));
  const attach = f.buttons().find(button => button.callback_data?.startsWith("ss:pick:"))!.callback_data!;
  f.st.setRequired("-1001", { directory: "/projects/other" });
  await f.bot.handle(f.tap(attach));
  assert.ok(f.sent.at(-1)!.text.includes("đã đổi"));
  f.st.setRequired("-1001", { directory: "/projects/app" });
  f.st.setRequired("-1002:301", { sessionID: "ses_free", directory: "/projects/app" });
  await f.bot.handle(f.tap(attach)); assert.ok(f.sent.at(-1)!.text.includes("đã đổi"));
  f.st.setRequired("-1002:301", { sessionID: undefined });
  let inspected = 0;
  f.oc.topicSession = async id => { inspected++; return { ...f.observations.get("ses_fixture_0")!.info, id, busy: true, directory: "/projects/app" }; };
  await f.bot.handle(f.tap(attach));
  assert.equal(inspected, 1, "Không tin trạng thái nghỉ từ danh sách cũ");
  f.oc.listSessions = async () => { throw new Error("Mất kết nối nguồn"); };
  await f.bot.handle(f.tap(mode));
  assert.ok(f.sent.at(-1)!.text.includes("Nguồn đang lỗi"));
  assert.equal(f.effects.length, 0, "Chọn kết quả bận vẫn bị chặn tại attach thật, không tạo tài nguyên");
  console.log("Đạt: tìm Unicode/không dấu, xếp hạng ổn định, phạm vi nhóm, phân trang, phiên đóng và thẻ đúng người; liệt kê không thực thi.");
} finally { topics.stopTitleSync(); f.dispose(); }
