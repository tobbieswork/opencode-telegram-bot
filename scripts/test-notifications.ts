import assert from "node:assert/strict";
import { NOTICE_KINDS, Notifications, noticeDecision, noticeKey, noticeText, type Notice } from "../src/notifications.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
let deliveries = 0;
try {
  const center = new Notifications(f.st, { now: Date.now, deliver: async () => { deliveries++; return 1; } });
  const event: Notice = { chat: "-1001", conv: "-1001:200", linkID: "0000000000000001", sessionID: "ses_fixture_0", binding: "fixture",
    kind: "question", title: "<Phiên>", occurredAt: Date.now(), reference: { kind: "form", id: "form_1" } };
  for (const kind of NOTICE_KINDS) {
    assert.equal(noticeDecision(center.settings("-1001"), { ...event, kind }), "off");
    assert.equal(noticeDecision({ version: 1, enabled: true, revision: 1 }, { ...event, kind, direct: true }), "direct");
    assert.equal(noticeDecision({ version: 1, enabled: true, revision: 1 }, { ...event, kind }), kind === "progress" ? "drop" :
      ["question", "permission", "blocked", "reminder"].includes(kind) ? "immediate" : "batch");
  }
  assert.equal(noticeKey(event), noticeKey({ ...event, title: "Tên mới", occurredAt: Date.now() + 1 }));
  assert.notEqual(noticeKey(event), noticeKey({ ...event, chat: "-1002" }));
  assert.notEqual(noticeKey(event), noticeKey({ ...event, reference: { kind: "form", id: "form_2" } }));
  assert.notEqual(noticeKey({ ...event, reference: undefined }), noticeKey({ ...event, reference: undefined }));
  assert.ok(noticeText([event]).includes("&lt;Phiên&gt;"));
  assert.throws(() => noticeText([event, { ...event, chat: "-1002", conv: "-1002:200" }]));
  assert.throws(() => center.decision({ ...event, chat: "-1002" }));
  assert.equal(deliveries, 0);
  await f.bot.handle(f.tap("nt:rules"));
  assert.ok(f.sent.at(-1)?.text.includes("chưa bật; giữ cách nhận hiện tại"));
  assert.equal(f.effects.length, 0);
  console.log("Đạt: mọi loại/chế độ, ưu tiên xác định, khóa theo đúng nguồn không theo tên; phân loại/xem quy tắc không giao tin hoặc gọi mô hình.");
} finally { f.dispose(); }
