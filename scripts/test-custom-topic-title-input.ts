import assert from "node:assert/strict";
import { workflowBot } from "./fixtures/bot-workflow.js";
import { topicTitle } from "../src/format.js";
import type { Update } from "../src/telegram.js";

const f = workflowBot();
const writes: string[] = [];
f.oc.topicSessionTitle = async id => structuredClone(f.observations.get(id)!.info);
f.tg.editForumTopic = async (conv, name) => { assert.equal(conv, "-1001:200"); writes.push(name); };
const button = (suffix: string) => f.buttons().find(button => button.callback_data?.endsWith(suffix))!.callback_data!;
const reply = (text: string, id: number, user = 1, topic?: number): Update => {
  const update = f.message(text, user, -1001, topic);
  update.message!.reply_to_message = { message_id: id };
  return update;
};
try {
  await f.bot.handle(f.tap("tc:open:0000000000000001"));
  await f.bot.handle(f.tap(button(":custom")));
  const promptID = f.sent.length;
  assert.ok(f.sent.at(-1)?.text.includes("Trả lời trực tiếp tin nhắn này"));
  await f.bot.handle(reply("Không phải người mở", promptID, 2));
  await f.bot.handle(reply("Không phải General", promptID, 1, 203));
  assert.equal(writes.length, 0);
  const raw = " Tên <riêng>\n👨‍👩‍👧‍👦 ";
  await f.bot.handle(reply(raw, promptID));
  assert.ok(f.sent.at(-1)?.text.includes("Tên &lt;riêng&gt;"));
  const confirm = button(":confirm");
  assert.equal(writes.length, 0, "Nhập tên chỉ tạo xem trước");
  await f.bot.handle(f.tap(confirm, 2));
  assert.equal(writes.length, 0);
  await f.bot.handle(f.tap(confirm));
  const deadline = Date.now() + 3000;
  while (!writes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(writes, [topicTitle(raw)]);
  await f.bot.handle(f.tap(confirm));
  assert.equal(writes.length, 1);
  await f.bot.handle(f.tap("tc:open:0000000000000001"));
  await f.bot.handle(f.tap(button(":custom")));
  const cancelled = f.sent.length;
  await f.bot.handle(f.tap(button(":cancel-input")));
  await f.bot.handle(reply("Tên đã hủy", cancelled));
  assert.equal(writes.length, 1);
  assert.equal(f.st.sessionTopics()?.links["0000000000000001"].title, topicTitle(raw));
  await f.bot.handle(f.tap("tc:open:0000000000000001"));
  await f.bot.handle(f.tap(button(":custom")));
  const expired = f.sent.length;
  const realNow = Date.now;
  try { Date.now = () => realNow() + 11 * 60_000; await f.bot.handle(reply("Tên đã hết hạn", expired)); }
  finally { Date.now = realNow; }
  assert.ok(f.sent.at(-1)?.text.includes("hết hạn"));
  assert.equal(writes.length, 1);

  await f.bot.handle(f.tap("tc:open:0000000000000001"));
  await f.bot.handle(f.tap(button(":custom")));
  const staleInput = f.sent.length;
  await f.bot.handle(f.tap("tc:open:group"));
  await f.bot.handle(f.tap(button(":off")));
  await f.bot.handle(reply("Tên dưới phạm vi cũ", staleInput));
  assert.ok(f.sent.at(-1)?.text.includes("chính sách đã đổi"));
  assert.equal(writes.length, 1);
  assert.equal(f.effects.length, 0);
  console.log("Đạt: nhập tên gắn đúng người/General/tin đích, xem trước an toàn HTML, xác nhận một lần và hủy không đổi tên.");
} finally { f.dispose(); }
