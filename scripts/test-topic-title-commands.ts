import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { Telegram, type Update } from "../src/telegram.js";
import type { OpenCodeCtl } from "../src/opencode.js";
import type { TopicSession } from "../src/session-topics.js";

const root = mkdtempSync(join(tmpdir(), "topic-title-commands-"));
const originalFetch = globalThis.fetch;
const sent: Array<{ chat_id: number; text: string; reply_markup?: any }> = [];
const edits: Array<{ chat_id: number; message_thread_id: number; name: string }> = [];
const sessions = new Map<string, TopicSession>();
let events: ((event: unknown) => void) | undefined;
let thread = 200;
let update = 0;
let bot: Bot | undefined;
let errorDescription: string | undefined;
let metadataReads = 0;
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(check(), "Hết thời gian chờ đồng bộ tên");
}
try {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1,2";
  globalThis.fetch = async (_input, init) => {
    const url = new URL(String(_input));
    assert.equal(url.origin, "https://api.telegram.org");
    const method = url.pathname.split("/").at(-1);
    const data = JSON.parse(String(init?.body ?? "{}"));
    let result: unknown = true;
    if (method === "getChat") result = { id: data.chat_id, type: "supergroup", is_forum: true };
    else if (method === "getMe") result = { id: 42, is_bot: true };
    else if (method === "getChatMember") result = { status: "administrator", can_manage_topics: true };
    else if (method === "createForumTopic") result = { message_thread_id: ++thread };
    else if (method === "sendMessage") {
      const allowed = new Set(["b", "code", "i", "a", "pre"]);
      for (const match of data.text.matchAll(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g)) assert.ok(allowed.has(match[1]), `HTML không hợp lệ: ${match[1]}`);
      sent.push(data);
      result = { message_id: sent.length, chat: { id: data.chat_id } };
    } else if (method === "editForumTopic") {
      assert.ok(init?.signal, "Đổi tên phải có thời hạn yêu cầu");
      if (errorDescription) return new Response(JSON.stringify({ ok: false, error_code: 400, description: errorDescription }), { status: 400 });
      edits.push(data);
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    schedule: false, activity: false, working: false, react: false, stream: false, remind: false,
    uptimeMonitor: false, prWatch: false, defaultModel: { id: "test", providerID: "test" } };
  const st = new StateManager(cfg.stateFile);
  const tg = new Telegram(cfg.telegramToken);
  const oc = { createTopicSession: async (input: { title: string }) => {
    const id = `ses_${sessions.size + 1}`;
    sessions.set(id, { id, title: input.title, directory: root, source: "test", projectID: "p", createdAt: sessions.size + 1,
      busy: false, terminal: true, archived: false });
    return id;
  }, topicSession: async (id: string) => structuredClone(sessions.get(id)!),
    topicSessionTitle: async (id: string) => { metadataReads++; return structuredClone(sessions.get(id)!); },
    listSessions: async () => [], listForms: async () => [], listPermissions: async () => [],
    subscribeEvents: (callback: (event: unknown) => void) => { events = callback; },
    setModel: async () => {}, listModels: async () => [],
    latestReply: async () => ({ text: "Hoàn tất", time: Date.now() }),
    listMessages: async () => [],
  } as unknown as OpenCodeCtl;
  bot = new Bot(tg, oc, st, cfg);
  const message = (text: string, chat = -1001): Update => ({ update_id: ++update,
    message: { message_id: update, from: { id: 1 }, chat: { id: chat, type: "supergroup", is_forum: true }, text } });
  const tap = (data: string, chat = -1001, topic?: number, user = 1): Update => ({ update_id: ++update,
    callback_query: { id: `cb-${update}`, from: { id: user }, data,
      message: { chat: { id: chat }, message_id: update, ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } } });
  const button = (prefix: string) => sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.startsWith(prefix))?.callback_data as string;

  await bot.handle(message("/setup"));
  await bot.handle(message("/new Tên <cũ>"));
  const link = Object.values(st.sessionTopics()!.links)[0];
  sessions.get(link.sessionID!)!.title = "Sửa <đăng nhập> & kiểm tra";
  await bot.handle(message("/sessions"));
  assert.ok(button("st:title-preview:"));
  await bot.handle(tap("st:title-preview:0"));
  assert.ok(sent.at(-1)?.text.includes("Tên &lt;cũ&gt; → Sửa &lt;đăng nhập&gt; &amp; kiểm tra"));
  const confirmation = button("st:title-enable:");
  assert.ok(confirmation);
  assert.equal(edits.length, 0);
  assert.equal(st.sessionTopics()?.titleSyncGroups?.["-1001"], undefined);
  await bot.handle(tap(confirmation, -1001, undefined, 2));
  await bot.handle(tap(confirmation, -1002));
  await bot.handle(tap(confirmation, -1001, 201));
  assert.equal(st.sessionTopics()?.titleSyncGroups?.["-1001"], undefined);
  await bot.handle(tap(confirmation));
  assert.equal(st.sessionTopics()?.titlePolicies?.groups["-1001"].enabled, true);
  assert.equal(st.sessionTopics()?.titleSyncGroups?.["-1001"], undefined);
  await waitFor(() => edits.length === 1);
  assert.equal(edits[0].name, "Sửa <đăng nhập> & kiểm tra");
  assert.equal(st.peek("-1001")?.sessionID, undefined, "Đồng bộ tên không cần phiên quản lý/phiên General");
  console.log("Đạt: xem trước và xác nhận qua nút thật; HTML an toàn; người khác, nhóm khác hoặc chủ đề làm việc không thể xác nhận thay.");

  bot.start();
  await waitFor(() => edits.length >= 2);
  const beforeEvent = edits.length;
  sessions.get(link.sessionID!)!.title = "Tiêu đề mới nhất";
  events!({ type: "session.renamed", data: { sessionID: link.sessionID, title: "Payload cũ" } });
  events!({ type: "session.renamed", data: { sessionID: link.sessionID, title: "Payload trùng" } });
  await waitFor(() => edits.length > beforeEvent);
  assert.equal(edits.at(-1)?.name, "Tiêu đề mới nhất");
  const beforeStatus = edits.length;
  const worker = { name: "ten-noi-bo", status: "running" as const, spawnedBy: "user" as const, createdAt: 1, updatedAt: 1 };
  st.set(link.conv!, { worker });
  events!({ type: "session.execution.succeeded", data: { sessionID: link.sessionID } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(edits.length, beforeStatus, "Đổi trạng thái tác vụ không được ghi đè tên chủ đề quản lý");
  await bot.handle({ update_id: ++update, message: { message_id: update, chat: { id: -1001 },
    message_thread_id: 201, is_topic_message: true, forum_topic_edited: { name: "Tên sửa tay" } } });
  await waitFor(() => edits.length > beforeStatus);
  assert.equal(edits.at(-1)?.name, "Tiêu đề mới nhất");
  assert.ok(metadataReads > 0);
  console.log("Đạt: sự kiện session.renamed đọc tên mới nhất, gộp payload cũ/trùng; trạng thái không ghi đè; sửa tay Telegram được đưa về tên chuẩn.");

  await bot.handle(message("/setup", -1002));
  for (let i = 0; i < 11; i++) await bot.handle(message(`/new Nhóm khác ${i}`, -1002));
  await bot.handle(tap("st:title-preview:0", -1002));
  assert.ok(sent.at(-1)?.text.includes("Trang 1/2"));
  assert.ok(!sent.at(-1)?.text.includes("Tiêu đề mới nhất"));
  const cancel = button("st:title-cancel:");
  await bot.handle(tap(button("st:title-page:"), -1002));
  assert.ok(sent.at(-1)?.text.includes("Trang 2/2"));
  await bot.handle(tap(cancel, -1002));
  assert.equal(st.sessionTopics()?.titleSyncGroups?.["-1002"], undefined);
  console.log("Đạt: xem trước có phân trang, cách ly nhóm và hủy không bật chính sách.");

  await bot.handle(tap(`tc:open:${link.id}`));
  assert.ok(sent.at(-1)?.text.includes("Theo OpenCode"));
  sessions.get(link.sessionID!)!.title = "Tên <mới> & an toàn";
  const previewControl = sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.endsWith(":preview"))?.callback_data;
  await bot.handle(tap(previewControl));
  assert.ok(sent.at(-1)?.text.includes("Tên &lt;mới&gt; &amp; an toàn"));
  await bot.handle(tap(sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.endsWith(":cancel"))?.callback_data));
  console.log("Đạt: thiết lập và xem trước từng chủ đề đi qua adapter Telegram thật, giữ an toàn HTML.");

  await bot.handle(tap(`tc:open:${link.id}`));
  await bot.handle(tap(sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.endsWith(":custom"))?.callback_data));
  const promptID = sent.length;
  await bot.handle({ update_id: ++update, message: { message_id: update, from: { id: 1 }, chat: { id: -1001, type: "supergroup", is_forum: true },
    reply_to_message: { message_id: promptID }, text: "  Tên <riêng> &\n👨‍👩‍👧‍👦  " } });
  assert.ok(sent.at(-1)?.text.includes("Tên &lt;riêng&gt; &amp;"));
  await bot.handle(tap(sent.at(-1)?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.endsWith(":confirm"))?.callback_data));
  await waitFor(() => edits.at(-1)?.name === "Tên <riêng> & 👨‍👩‍👧‍👦");
  assert.equal(sessions.get(link.sessionID!)!.title, "Tên <mới> & an toàn");
  const customEdits = edits.length;
  events!({ type: "session.renamed", data: { sessionID: link.sessionID } });
  await bot.handle({ update_id: ++update, message: { message_id: update, chat: { id: -1001 }, message_thread_id: 201,
    is_topic_message: true, forum_topic_edited: { name: "Tên đổi thủ công ở Telegram" } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(edits.length, customEdits);
  assert.equal(st.sessionTopics()?.links[link.id].titlePolicy?.mode, "custom");
  console.log("Đạt: tên riêng tiếng Việt/biểu tượng qua adapter thật, không cập nhật ngược OpenCode.");

  errorDescription = "TOPIC_NOT_MODIFIED";
  await tg.editForumTopic("-1001:201", "Tên");
  errorDescription = "Bad Request: not enough rights to manage topics";
  await assert.rejects(() => tg.editForumTopic("-1001:201", "Tên"), /not enough rights/);
  errorDescription = "Bad Request: message thread not found";
  await assert.rejects(() => tg.editForumTopic("-1001:201", "Tên"), /thread not found/);
  console.log("Đạt: adapter thật chỉ coi TOPIC_NOT_MODIFIED là thành công; lỗi 400 khác không bị nuốt.");
} finally {
  bot?.stopScheduler();
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
