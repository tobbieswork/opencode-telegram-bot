import assert from "node:assert/strict";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { SessionTopics } from "../src/session-topics.js";
import { SessionPins } from "../src/session-pins.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
const st = new StateManager(join(f.root, "acceptance.json"));
const info = { ...f.observations.get("ses_fixture_0")!.info, id: "ses_acceptance", title: "CV15-nghiệm-thu", directory: f.root,
  createdAt: Date.now(), busy: false, terminal: true, archived: false };
let emit: Parameters<typeof f.oc.subscribeEvents>[0] = () => {};
let inputID = "", completed = false, waiting = false, prompts = 0, replies = 0, closed = 0, opened = 0;
let finish: (result: Awaited<ReturnType<typeof f.oc.promptAndWait>>) => void = () => {};
const response = new Promise<Awaited<ReturnType<typeof f.oc.promptAndWait>>>(resolve => { finish = resolve; });
const form = () => ({ id: "form_acceptance", sessionID: info.id, fields: [{ key: "pick", type: "string", title: "Chọn A hoặc B", options: [{ label: "A", value: "A" }, { label: "B", value: "B" }] }] });
f.oc.subscribeEvents = callback => { emit = callback; };
f.oc.createTopicSession = async input => { info.title = input.title; return info.id; };
f.oc.topicSession = async () => structuredClone(info);
f.oc.topicSessionTitle = async () => structuredClone(info);
f.oc.getSession = async () => { throw new Error("Mô hình mặc định không đặt trong bộ thử cô lập"); };
f.oc.setInstruction = async () => {};
f.oc.removeInstruction = async () => {};
f.oc.listForms = async () => waiting ? [form()] : [];
f.oc.listPermissions = async () => [];
f.oc.activitySnapshot = async () => ({ info: structuredClone(info), messages: inputID ? [
  ...(completed ? [{ id: "reply_acceptance", type: "assistant" as const, content: [{ type: "text", text: "CV15_OK A" }], time: { created: info.createdAt + 2 } }] : []),
  { id: inputID, type: "user", text: "Mục tiêu nghiệm thu, không sửa tệp", time: { created: info.createdAt + 1 } },
] : [] });
f.oc.dashboardObservation = async () => ({ info: structuredClone(info), work: info.busy ? "running" : completed ? "done" : "idle", forms: waiting ? [form().id] : [], permissions: [] });
f.oc.promptAndWait = async (_sid, _text, options) => {
  prompts++; inputID = options!.messageID!; info.busy = true; info.terminal = false; waiting = true;
  emit({ type: "form.created", data: { form: form() } });
  return response;
};
f.oc.replyForm = async (sid, id) => {
  assert.equal(sid, info.id); assert.equal(id, form().id); replies++; waiting = false; completed = true; info.busy = false; info.terminal = true;
  emit({ type: "form.replied", data: { id } });
  finish({ reply: "CV15_OK A", replyID: "reply_acceptance", replyInputID: inputID, outcome: "succeeded", interrupted: false, elapsedMs: 1, replyTime: Date.now() });
};
f.oc.archiveSession = async (_id, archived) => { info.archived = archived; };
f.tg.createForumTopic = async () => 400;
f.tg.closeForumTopic = async () => { closed++; };
f.tg.openForumTopic = async () => { opened++; };
const forbid = async (): Promise<never> => { throw new Error("Không gọi cổng tạo ngoài đường Bot"); };
const owner = new SessionTopics(st, { createSession: forbid, session: async () => info, createTopic: forbid, archive: forbid, closeTopic: forbid, openTopic: forbid, stop: forbid });
owner.enable("-1001");
const bot = new Bot(f.tg, f.oc, st, { ...f.cfg, stateFile: join(f.root, "acceptance.json") });
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), `Hết thời gian chờ bước nghiệm thu cô lập: ${JSON.stringify({ prompts, replies, sent: f.sent.map(item => item.text.slice(0, 350)) })}`);
}
try {
  bot.start();
  await bot.handle(f.message("/new CV15-nghiệm-thu"));
  const link = Object.values(st.sessionTopics()!.links)[0];
  assert.ok(link); assert.equal(prompts, 0, "Tạo phiên không tự gửi yêu cầu");
  assert.equal(link.phase, "open", JSON.stringify(link));
  assert.ok(f.buttons().some(button => button.callback_data?.startsWith("pin:set:")), "Thẻ do người dùng mở phải có Ghim trực tiếp, không bắt tìm thêm thẻ cá nhân");
  await bot.handle(f.tap("nt:preview"));
  await bot.handle(f.tap(f.buttons().find(button => button.callback_data?.startsWith("nt:enable:"))!.callback_data!));
  await bot.handle(f.message("Mục tiêu nghiệm thu, không sửa tệp", 1, -1001, 400));
  await until(() => Boolean(st.peek(link.conv!)?.pendingPrompts?.[form().id]?.messageId));
  const questionMessageID = st.peek(link.conv!)!.pendingPrompts![form().id].messageId!;
  assert.ok(Object.values(st.peek("-1001")!.notificationQueue!.items).some(item => item.event.kind === "question" && item.event.url?.includes("?thread=400")), "Liên kết câu hỏi chính thức phải vào được hàng đợi thật");
  const answer = f.sent.flatMap(message => message.opts?.reply_markup?.inline_keyboard?.flat() ?? []).find(button => button.text.endsWith(" A") && button.callback_data?.startsWith("fq:"))!.callback_data;
  await bot.handle(f.message("/sessions"));
  const waitingButton = f.buttons().find(button => button.callback_data?.includes(":waiting:0"))!.callback_data!;
  await bot.handle(f.tap(waitingButton));
  assert.ok(f.sent.at(-1)!.text.includes("CV15-nghiệm-thu"));
  const update = f.tap(answer, 1, -1001, 400);
  update.callback_query!.message!.message_id = questionMessageID;
  await bot.handle(update);
  await until(() => Boolean(st.peek(link.conv!)?.sessionActivity?.result?.snippet.includes("CV15_OK")));
  await bot.handle(f.tap(`sum:show:${link.id}`));
  assert.ok(f.sent.at(-1)!.text.includes("CV15_OK"));
  await bot.handle(f.tap("ss:start"));
  const search = f.message("CV15"); search.message!.reply_to_message = { message_id: f.sent.length };
  await bot.handle(search);
  await bot.handle(f.tap(f.buttons().find(button => button.callback_data?.startsWith("ss:pick:"))!.callback_data!));
  await bot.handle(f.tap(f.buttons().find(button => button.callback_data?.startsWith("pin:set:") && button.callback_data.endsWith(":1"))!.callback_data!));
  assert.ok(new SessionPins(st, owner).ids("-1001", 1).has(link.id));
  await bot.handle(f.tap(`st:close:${link.id}`));
  assert.equal(st.sessionTopics()!.links[link.id].phase, "closed");
  await bot.handle(f.tap(`st:restore:${link.id}`));
  assert.equal(st.sessionTopics()!.links[link.id].phase, "open");
  assert.ok(f.buttons().some(button => button.text === "Bỏ ghim"));
  assert.equal(st.sessionTopics()!.links[link.id].sessionID, info.id);
  assert.equal(st.sessionTopics()!.links[link.id].conv, "-1001:400");
  assert.ok(new SessionPins(st, owner).ids("-1001", 1).has(link.id));
  assert.equal(prompts, 1); assert.equal(replies, 1); assert.equal(closed, 1); assert.equal(opened, 1);
  console.log("Đạt xuyên suốt: tạo → một yêu cầu → câu hỏi → Đang chờ bạn → trả lời đúng thẻ/chủ đề → kết quả → tóm tắt → tìm/ghim → đóng/mở đúng phiên, không tự chạy thêm.");
} finally { bot.stopScheduler(); owner.stopTitleSync(); f.dispose(); }
