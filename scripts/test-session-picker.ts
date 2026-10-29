import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import type { Telegram, Update } from "../src/telegram.js";
import type { OpenCodeCtl } from "../src/opencode.js";

const root = mkdtempSync(join(tmpdir(), "session-picker-"));
let bot: Bot | undefined;
try {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    managerDir: join(root, "manager"), schedule: false, remind: false, activity: false,
    working: false, stream: false, uptimeMonitor: false, prWatch: false };
  const st = new StateManager(cfg.stateFile);
  st.set("-1001", { sessionID: "ses_legacy", directory: root });
  st.set("-1002", { sessionID: "ses_foreign" });
  st.set("-1001:90", { sessionID: "ses_conflict" });
  st.set("-1002:90", { sessionID: "ses_conflict" });
  const available = [
    { id: "ses_legacy", title: "Phiên cũ <b>", directory: join(root, "legacy"), updated: 10 },
    { id: "ses_free", title: "Phiên chưa gắn", directory: root, updated: 9 },
    { id: "ses_foreign", title: "Bí mật nhóm khác", directory: root, updated: 8 },
    { id: "ses_conflict", title: "Chủ sở hữu mâu thuẫn", directory: root, updated: 7 },
    { id: "ses_outside", title: "Dự án khác", directory: join(root, "outside"), updated: 6 },
    { id: "ses_archived", title: "Đã lưu trữ", directory: root, archived: true, updated: 5 },
    { id: "ses_child", title: "Phiên con", directory: root, parentID: "ses_free", updated: 4 },
    { id: "ses_unknown", title: "Không rõ thư mục", updated: 3 },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `ses_more_${index}`, title: `Phiên ${index}`, directory: root, updated: 2 - index })),
  ];
  let listingFails = false;
  let legacyBusy = false;
  let thread = 200;
  const titles: string[] = [];
  const sent: Array<{ text: string; opts?: any }> = [];
  const tg = { sendMessage: async (_conv: string, text: string, opts?: any) => { sent.push({ text, opts }); },
    answerCallbackQuery: async () => {}, assertForumManagement: async () => {}, setMyCommands: async () => {},
    createForumTopic: async (_chat: number, title: string) => { titles.push(title); return ++thread; },
    closeForumTopic: async () => {}, openForumTopic: async () => {}, editForumTopic: async () => {},
  } as unknown as Telegram;
  const oc = { listSessions: async () => { if (listingFails) throw new Error("Không kết nối được"); return available; },
    topicSession: async (id: string) => { const s = available.find((item) => item.id === id)!;
      return { id, title: s.title, directory: s.directory ?? root, projectID: "project", createdAt: 1,
        source: "test", busy: id === "ses_legacy" && legacyBusy, terminal: !(id === "ses_legacy" && legacyBusy), archived: Boolean(s.archived) }; },
    createTopicSession: async () => { throw new Error("Liệt kê hoặc gắn không được tạo phiên mới"); },
  } as unknown as OpenCodeCtl;
  bot = new Bot(tg, oc, st, cfg);
  let update = 0;
  const message = (text: string): Update => ({ update_id: ++update, message: { message_id: update,
    chat: { id: -1001, type: "supergroup", is_forum: true }, from: { id: 1 }, text } });
  const button = (data: string, topic?: number): Update => ({ update_id: ++update, callback_query: {
    id: `cb-${update}`, from: { id: 1 }, data, message: { message_id: update, chat: { id: -1001 },
      ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } } });
  const buttons = () => (sent.at(-1)?.opts?.reply_markup?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data: string }>;
  const hidden = ["ses_foreign", "ses_conflict", "ses_outside", "ses_archived", "ses_child", "ses_unknown"];
  await bot.handle(message("/setup"));
  for (const command of ["/sessions", "/ls", "/ls@opencode_blue_bot", "/attach", "/use"]) {
    await bot.handle(message(command));
    assert.ok(buttons().some((item) => item.callback_data === "use:ses_legacy"), `${command}: chọn phiên cũ bằng nút, không cần biết ID`);
    assert.ok(buttons().some((item) => item.callback_data === "use:ses_free"));
    assert.ok(buttons().some((item) => item.callback_data === "cmd:new"));
    assert.ok(!sent.at(-1)!.text.includes("Bí mật nhóm khác"));
    assert.ok(sent.at(-1)!.text.includes("Phiên cũ &lt;b&gt;"));
    assert.ok(buttons().every((item) => Buffer.byteLength(item.callback_data) <= 64));
    assert.ok(buttons().every((item) => !hidden.some((id) => item.callback_data === `use:${id}`)));
    assert.equal(thread, 200);
    assert.equal(st.peek("-1001")?.sessionID, "ses_legacy");
  }
  assert.ok(buttons().some((item) => item.callback_data === "st:list:1"));
  await bot.handle(button("st:list:1"));
  assert.ok(buttons().every((item) => !hidden.some((id) => item.callback_data === `use:${id}`)));
  assert.ok(buttons().some((item) => item.callback_data === "use:ses_more_11"));
  console.log("Đạt: danh sách có tên, nút chọn, phân trang; không lộ phiên nhóm/dự án khác hoặc phiên lưu trữ/con.");
  await bot.handle(button("use:ses_legacy", 99));
  assert.equal(thread, 200);
  available[0].archived = true;
  await bot.handle(button("use:ses_legacy"));
  assert.equal(thread, 200, "nút cũ không tự mở lại phiên vừa lưu trữ");
  available[0].archived = false;
  legacyBusy = true;
  await bot.handle(button("use:ses_legacy"));
  assert.equal(thread, 200, "phiên còn chạy không được gắn hoặc dừng ngầm");
  legacyBusy = false;
  await bot.handle(button("use:ses_legacy"));
  assert.equal(thread, 201);
  assert.equal(st.peek("-1001")?.sessionID, undefined);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_legacy");
  assert.equal(titles[0], "Phiên cũ <b>");
  await bot.handle(button("use:ses_legacy"));
  assert.equal(thread, 201);
  console.log("Đạt: chọn ở General gắn đúng phiên cũ, giữ tên; bấm lại không tạo thêm chủ đề/phiên.");
  st.set("-1002:91", { sessionID: "ses_free" });
  await bot.handle(button("use:ses_free"));
  assert.equal(thread, 201, "nút cũ không được chiếm phiên vừa chuyển sang nhóm khác");
  listingFails = true;
  await bot.handle(message("/attach"));
  assert.ok(buttons().some((item) => item.callback_data === "cmd:new"));
  assert.ok(sent.at(-1)!.text.includes("Không tải"));
  console.log("Đạt: kiểm tra lại chủ sở hữu khi chọn; lỗi kết nối vẫn có nút tạo mới và làm mới.");
} finally {
  bot?.stopScheduler();
  rmSync(root, { recursive: true, force: true });
}
