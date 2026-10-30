import assert from "node:assert/strict";
import { Notifications, noticeKey, type Notice } from "../src/notifications.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
let now = Date.now();
const base: Notice = { chat: "-1001", conv: "-1001:200", linkID: "0000000000000001", sessionID: "ses_fixture_0", binding: "fixture",
  kind: "completed", occurredAt: now, title: "Phiên <thử>", url: "https://t.me/c/1/200", reference: { kind: "input", id: "input_a" } };
const sent: Array<{ chat: string; text: string }> = [];
let limited = false;
let uncertain = false;
let resolved = false;
let edits = 0;
const ports = { now: () => now, deliver: async (chat: string, text: string) => {
  if (limited && chat === "-1001") throw Object.assign(new Error("Giới hạn"), { code: 429, retryAfter: 30 });
  sent.push({ chat, text });
  if (uncertain) throw new Error("Mất phản hồi sau khi có thể đã giao");
  return sent.length;
}, edit: async () => { edits++; }, resolve: async (event: Notice) => resolved && event.reference?.kind === "form" ? undefined : event };
const center = new Notifications(f.st, ports);
try {
  center.configure("-1001", 0, true);
  center.configure("-1002", 0, true);
  center.enqueue(base); center.enqueue(base);
  center.enqueue({ ...base, reference: { kind: "input", id: "input_b" } });
  await center.flush(); assert.equal(sent.length, 0);
  now += 5000;
  await center.flush();
  assert.equal(sent.length, 1);
  assert.equal((sent[0].text.match(/Lượt đã kết thúc/g) ?? []).length, 2);
  assert.ok(sent[0].text.includes("&lt;thử&gt;"));
  await center.flush(); assert.equal(sent.length, 1);

  limited = true;
  const ask = { ...base, kind: "question" as const, occurredAt: now, reference: { kind: "form" as const, id: "form_a" } };
  center.enqueue(ask);
  center.enqueue({ ...base, chat: "-1002", conv: "-1002:201", kind: "blocked", occurredAt: now, reference: { kind: "input", id: "other" } });
  await center.flush();
  assert.equal(sent.at(-1)?.chat, "-1002", "Nhóm lỗi không cản nhóm khác");
  const count = sent.length;
  limited = false;
  await center.flush(); assert.equal(sent.length, count);
  now += 30_000; resolved = true;
  await center.flush();
  assert.equal(sent.length, count, "Câu hỏi đã giải quyết không gửi lại sau 429");

  uncertain = true;
  const lost = { ...base, kind: "blocked" as const, occurredAt: now, reference: { kind: "input" as const, id: "input_lost" } };
  center.enqueue(lost); await center.flush();
  const afterLost = sent.length;
  assert.equal(center.enqueue(lost), "unknown");
  await center.flush(); assert.equal(sent.length, afterLost);
  const restarted = new Notifications(f.st, ports);
  await restarted.flush(); assert.equal(sent.length, afterLost);
  assert.throws(() => restarted.retryKnown("-1001", noticeKey(lost)));
  uncertain = false;

  const ack = { ...base, kind: "blocked" as const, occurredAt: now, reference: { kind: "input" as const, id: "input_ack" } };
  center.enqueue(ack);
  const save = f.st.setRequired.bind(f.st);
  let fail = true;
  f.st.setRequired = (chat, patch) => {
    if (fail && patch.notificationQueue?.items[noticeKey(ack)]?.state === "sent") { fail = false; throw new Error("Lỗi lưu sau giao"); }
    save(chat, patch);
  };
  await center.flush();
  const ackCount = sent.length;
  f.st.setRequired = save;
  const editRecovery = new Notifications(f.st, ports);
  editRecovery.retryKnown("-1001", noticeKey(ack));
  await editRecovery.flush();
  assert.equal(edits, 1); assert.equal(sent.length, ackCount, "Có mã tin thì sửa, không gửi tin mới");

  const before = { ...base, kind: "blocked" as const, occurredAt: now, reference: { kind: "input" as const, id: "before_send" } };
  center.enqueue(before);
  f.st.setRequired = (chat, patch) => {
    if (patch.notificationQueue?.items[noticeKey(before)]?.state === "sending") throw new Error("Lỗi lưu trước giao");
    save(chat, patch);
  };
  await center.flush(); assert.equal(sent.length, ackCount);
  f.st.setRequired = save;
  const data = f.st.peek("-1001")!.notificationQueue!;
  data.items[noticeKey(before)].state = "sending";
  f.st.setRequired("-1001", { notificationQueue: data });
  const crashed = new Notifications(f.st, ports);
  await crashed.flush();
  assert.equal(crashed.status("-1001").unknown >= 1, true);
  assert.equal(sent.length, ackCount, "Khởi động giữa giao không phát lại");

  const streamingStart = sent.length;
  for (let n = 0; n < 6; n++) { center.enqueue({ ...base, occurredAt: now, reference: { kind: "input", id: `stream_${n}` } }); now += 1000; }
  await center.flush(); assert.equal(sent.length, streamingStart + 1, "Dòng liên tục vẫn giao theo hạn đầu, không trượt vô hạn");
  console.log("Đạt: khóa theo lượt, gộp có hạn, nhiều nhóm/429, hết chờ, lỗi lưu trước/sau giao, mất phản hồi/khởi động và chỉnh sửa tin đã biết.");

  await f.bot.handle(f.tap("nt:preview"));
  const enable = f.buttons().find(button => button.callback_data?.startsWith("nt:enable:"))!.callback_data!;
  await f.bot.handle(f.tap(enable, 2));
  await f.bot.handle(f.tap(enable));
  f.cfg.guideLanguage = false;
  f.oc.removeInstruction = async () => {};
  f.oc.promptAndWait = async (_sid, _text, opts) => ({ reply: "KHONG_CHEP_PHAN_HOI", replyID: "reply_done", replyInputID: opts!.messageID,
    replyOutcome: "succeeded", replyTime: now, outcome: "succeeded", elapsedMs: 1, interrupted: false });
  await f.bot.handle(f.message("Kiểm tra việc mới", 1, -1001, 200));
  await new Promise<void>(resolve => setImmediate(resolve));
  const relay = f.st.peek("-1001:200")!.lastRelayedTime;
  assert.ok(Object.values(f.st.peek("-1001")!.notificationQueue!.items).some(item => item.event.binding !== "fixture"));
  now += 5000; await center.flush();
  assert.equal(f.st.peek("-1001:200")!.lastRelayedTime, relay);
  assert.ok(!sent.at(-1)!.text.includes("KHONG_CHEP_PHAN_HOI"));
  console.log("Đạt: đường Telegram phát ý định tóm lược, không gửi lại phản hồi hoặc sửa mốc chuyển tiếp.");
} finally { center.stop(); f.dispose(); }
