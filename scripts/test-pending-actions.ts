import assert from "node:assert/strict";
import { workflowBot } from "./fixtures/bot-workflow.js";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";

const f = workflowBot();
try {
  const linkID = "0000000000000003";
  const view = `pa:list:${linkID}:0`;
  await f.bot.handle(f.tap(view));
  assert.ok(f.sent.at(-1)?.text.includes("2 yêu cầu"));
  assert.ok(f.buttons().some(button => button.text === "Đến câu hỏi" && button.url?.includes("/300?thread=202")));
  assert.ok(f.buttons().some(button => button.text === "Đến yêu cầu cấp quyền" && button.url?.includes("/301?thread=202")));
  const relays = f.buttons().filter(button => button.callback_data?.startsWith("pa:relay:"));
  assert.equal(relays.length, 2);
  assert.equal(f.effects.length, 0);
  await f.bot.handle(f.tap(relays[0].callback_data!, 2));
  assert.ok(f.sent.at(-1)?.text.includes("hết hạn"));
  await f.bot.handle(f.tap(relays[0].callback_data!));
  const question = f.sent.findLast(message => message.conv === "-1001:202" && message.text.includes("Câu 1/1"));
  assert.ok(question);
  assert.equal(f.st.peek("-1001:202")?.pendingPrompts?.form_fixture.remindersSent, 1);
  const formButton = question.opts.reply_markup.inline_keyboard.flat().find((button: any) => button.callback_data.includes(":o0:")).callback_data;
  await f.bot.handle(f.tap(formButton, 1, -1001, 201));
  assert.equal(f.effects.length, 0, "Không dùng thẻ câu hỏi ở chủ đề khác");
  f.observations.get("ses_fixture_2")!.forms = [];
  await f.bot.handle(f.tap(formButton, 1, -1001, 202));
  assert.equal(f.effects.length, 0, "Nút cũ không gửi câu trả lời cho yêu cầu đã hết chờ");
  await f.bot.handle(f.tap(relays[1].callback_data!));
  const permission = f.sent.findLast(message => message.conv === "-1001:202" && message.text.includes("xin quyền"));
  assert.ok(permission);
  assert.equal(f.st.peek("-1001:202")?.pendingPrompts?.permission_fixture.remindersSent, 0);
  const permit = permission.opts.reply_markup.inline_keyboard.flat().find((button: any) => button.callback_data.endsWith(":once")).callback_data;
  await f.bot.handle(f.tap(permit, 1, -1001, 201));
  assert.equal(f.effects.length, 0, "Không dùng thẻ quyền ở chủ đề khác");
  f.observations.get("ses_fixture_2")!.permissions = undefined;
  await f.bot.handle(f.tap(permit, 1, -1001, 202));
  assert.ok(f.st.peek("-1001:202")?.pendingPrompts?.permission_fixture, "Lỗi nguồn không chứng minh quyền đã được giải quyết");
  f.observations.get("ses_fixture_2")!.permissions = [];
  await f.bot.handle(f.tap(permit, 1, -1001, 202));
  assert.equal(f.effects.length, 0);
  assert.equal(f.st.peek("-1001:202")?.pendingPrompts?.permission_fixture, undefined);
  await f.bot.handle(f.tap(view));
  assert.ok(f.sent.at(-1)?.text.includes("0 yêu cầu"));
  console.log("Đạt: câu hỏi/quyền cùng phiên có liên kết riêng; hiển thị lại không tạo yêu cầu hoặc đặt lại lượt nhắc; chặn nút hết hạn/sai chủ đề.");
} finally { f.dispose(); }

const missing = workflowBot();
try {
  const state = missing.st.peek("-1001:202")!;
  for (const prompt of Object.values(state.pendingPrompts!)) delete prompt.messageId;
  missing.st.set("-1001:202", state);
  missing.observations.get("ses_fixture_2")!.forms = undefined;
  await missing.bot.handle(missing.tap("pa:list:0000000000000003:0"));
  assert.ok(missing.sent.at(-1)?.text.includes("Chưa xác minh"));
  assert.ok(missing.sent.at(-1)?.text.includes("Không có mã tin gốc"));
  assert.ok(missing.buttons().some(button => button.text === "Mở chủ đề"));
  assert.equal(missing.buttons().filter(button => button.callback_data?.startsWith("pa:relay:")).length, 1);
  const data = missing.st.sessionTopics()!;
  data.links["0000000000000003"].phase = "closed";
  missing.st.commitSessionTopics(data);
  await missing.bot.handle(missing.tap("pa:list:0000000000000003:0"));
  assert.ok(missing.sent.at(-1)?.text.includes("không tự mở lại"));
  assert.equal(missing.effects.length, 0);
  console.log("Đạt: nguồn lỗi khác danh sách trống, thiếu tin có đường vào chủ đề; phiên đóng không được mở lại để hiển thị câu hỏi.");
} finally { missing.dispose(); }

const multi = workflowBot();
let restored: Bot | undefined;
try {
  const form = { id: "form_fixture", sessionID: "ses_fixture_2", fields: [
    { key: "first", type: "string", options: [{ label: "Một", value: "one" }] },
    { key: "second", type: "string", options: [{ label: "Hai", value: "two" }] },
  ] };
  multi.oc.listForms = async () => [form];
  await multi.bot.handle(multi.tap("pa:list:0000000000000003:0"));
  const relay = multi.buttons().find(button => button.callback_data?.startsWith("pa:relay:"))!.callback_data!;
  await multi.bot.handle(multi.tap(relay));
  const card = multi.sent.findLast(message => message.conv === "-1001:202" && message.text.includes("Câu 1/2"))!;
  const old = card.opts.reply_markup.inline_keyboard.flat().find((button: any) => button.callback_data.includes(":o0:")).callback_data;
  await multi.bot.handle(multi.tap(old, 1, -1001, 202));
  assert.ok(multi.sent.some(message => message.text.includes("Câu 2/2")));
  await multi.bot.handle(multi.tap(old, 1, -1001, 202));
  assert.equal(multi.effects.length, 0, "Lựa chọn của câu trước không được dùng cho câu sau");
  const state = new StateManager(multi.cfg.stateFile);
  assert.ok(state.peek("-1001:202")?.pendingPrompts?.form_fixture.messageId);
  restored = new Bot(multi.tg, multi.oc, state, multi.cfg);
  await restored.handle(multi.tap("pa:list:0000000000000003:0"));
  assert.ok(multi.sent.at(-1)?.text.includes("2 yêu cầu"));
  console.log("Đạt: nút gắn đúng trường câu hỏi; mã tin vẫn lưu khi tắt nhắc; danh sách đối chiếu lại sau khởi động.");
} finally { restored?.stopScheduler(); multi.dispose(); }
