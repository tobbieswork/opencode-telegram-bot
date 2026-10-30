import assert from "node:assert/strict";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
try {
  const data = f.st.sessionTopics()!;
  data.links["0000000000000001"].title = "CV15 kiểm tra nhập kế tiếp";
  f.st.commitSessionTopics(data);
  await f.bot.handle(f.tap("ss:start"));
  await f.bot.handle(f.message("CV15", 2));
  assert.ok(!f.sent.at(-1)!.text.includes("<b>Tìm phiên ·"), "Người khác không nhập thay");
  const otherReply = f.message("CV15"); otherReply.message!.reply_to_message = { message_id: 99999 };
  await f.bot.handle(otherReply);
  assert.ok(!f.sent.at(-1)!.text.includes("<b>Tìm phiên ·"), "Không lấy câu trả lời cho tin khác");
  await f.bot.handle(f.message("CV15", 1, -1001, 204));
  assert.ok(!f.sent.at(-1)!.text.includes("<b>Tìm phiên ·"), "Không lấy từ khóa ở chủ đề làm việc");
  await f.bot.handle(f.message("CV15"));
  assert.ok(f.sent.at(-1)!.text.includes("<b>Tìm phiên · Đang quản lý</b>"), `Bấm Tìm rồi gửi tin kế tiếp phải tìm, không rơi sang phản hồi khác: ${f.sent.at(-1)!.text}`);
  assert.equal(f.effects.length, 0);
  await f.bot.handle(f.message("CV15"));
  assert.ok(!f.sent.at(-1)!.text.includes("<b>Tìm phiên ·"), "Xong luồng không biến mọi tin General thành truy vấn");
  await f.bot.handle(f.tap("ss:start"));
  await f.bot.handle(f.tap("nt:quiet"));
  await f.bot.handle(f.message("23:00 07:00 UTC"));
  assert.ok(f.sent.at(-1)!.text.includes("Xem trước giờ yên lặng"), "Luồng nhập mới thay luồng cũ, không bị tìm kiếm lấy mất");
  assert.equal(f.st.peek("-1001")?.notificationSettings?.quiet, undefined, "Tin nhập chỉ xem trước, không tự áp dụng");
  await f.bot.handle(f.tap("ss:start"));
  await f.bot.handle(f.message("/cancel"));
  await f.bot.handle(f.message("CV15"));
  assert.ok(!f.sent.at(-1)!.text.includes("<b>Tìm phiên ·"));
  await f.bot.handle(f.tap("ss:start"));
  const clock = Date.now;
  try { Date.now = () => clock() + 11 * 60_000; await f.bot.handle(f.message("CV15")); }
  finally { Date.now = clock; }
  assert.ok(f.sent.at(-1)!.text.includes("hết hạn"));
  assert.equal(f.effects.length, 0);
  console.log("Đạt: tin kế tiếp của người mở tìm kiếm trong General được nhận đúng luồng, không gọi mô hình.");
} finally { f.dispose(); }
