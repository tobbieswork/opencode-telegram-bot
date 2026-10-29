import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionActivityLog } from "../src/session-activity.js";
import { StateManager } from "../src/state.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const root = mkdtempSync(join(tmpdir(), "session-activity-"));
try {
  const st = new StateManager(join(root, "storage", "state.json"));
  st.set("-1001:20", { sessionID: "ses_a", worker: { name: "a", task: "Yêu cầu cũ", status: "idle", spawnedBy: "user", createdAt: 1, updatedAt: 1 } });
  st.set("-1002:20", { sessionID: "ses_b" });
  let now = 1000;
  const log = new SessionActivityLog(st, () => ++now);
  assert.equal(log.read("-1001:20"), undefined);
  assert.equal(log.begin("-1002:20", { sessionID: "ses_a", inputID: "input_a", text: "Không được lưu", source: "topic" }), false);
  log.begin("-1001:20", { sessionID: "ses_a", inputID: "input_a", text: "Sửa đăng nhập", source: "topic" });
  const prior = log.read("-1001:20")!;
  log.begin("-1001:20", { sessionID: "ses_a", inputID: "input_b", text: "Sửa thanh toán", source: "manager" });
  assert.equal(log.complete("-1001:20", { sessionID: "ses_a", inputID: "input_a", messageID: "reply_a", text: "Kết quả cũ", outcome: "succeeded" }), false);
  assert.equal(log.read("-1001:20")?.input.id, "input_b");
  assert.equal(log.observe("-1001:20", "ses_a", prior.revision, [{ id: "input_a", type: "user", text: "Cũ", time: { created: 2 } }]), false);
  const marker = String.fromCharCode(167) + "2" + String.fromCharCode(167);
  log.complete("-1001:20", { sessionID: "ses_a", inputID: "input_b", messageID: "reply_b", text: `${marker} Đã sửa thanh toán`, outcome: "succeeded" });
  const matched = log.read("-1001:20")!;
  assert.equal(matched.input.source, "manager");
  assert.equal(matched.result?.inputID, "input_b");
  assert.equal(matched.result?.snippet, "Đã sửa thanh toán");
  log.complete("-1001:20", { sessionID: "ses_a", inputID: "input_b", messageID: "reply_b", text: "Đã sửa thanh toán", outcome: "succeeded" });
  assert.equal(log.read("-1001:20")?.revision, matched.revision, "Đọc lặp cùng kết quả không làm mất hiệu lực xác nhận đang có");
  log.observe("-1001:20", "ses_a", matched.revision, [
    { id: "reply_external", type: "assistant", content: [{ type: "text", text: "Kết quả ngoài Telegram" }], time: { created: 20 } },
    { id: "external", type: "user", text: "Yêu cầu từ OpenCode", time: { created: 10 } },
    { id: "input_b", type: "user", text: "Sửa thanh toán", time: { created: 5 } },
  ]);
  const external = log.read("-1001:20")!;
  assert.equal(external.input.id, "external");
  assert.equal(external.input.source, "opencode");
  assert.equal(external.result?.inputID, "external");
  assert.equal(external.result?.snippet, "Kết quả ngoài Telegram");
  log.observe("-1001:20", "ses_a", external.revision, [{ id: "old_source", type: "user", text: "Dữ liệu cũ", time: { created: 1 } }]);
  assert.equal(log.read("-1001:20")?.input.id, "external", "Nguồn lùi mốc không thay đầu vào đã quan sát mới hơn");
  log.begin("-1001:20", { sessionID: "ses_a", inputID: "pending", text: "Mới nhận, chưa thấy trên máy chủ", source: "schedule" });
  const pending = log.read("-1001:20")!;
  log.observe("-1001:20", "ses_a", pending.revision, [{ id: "external", type: "user", text: "Cũ", time: { created: 10 } }]);
  assert.equal(log.read("-1001:20")?.input.id, "pending");
  assert.ok(log.read("-1001:20")?.uncertainty);
  log.begin("-1001:20", { sessionID: "ses_a", inputID: "long", text: `api_key=${"sk-" + "x".repeat(60)} ` + "a".repeat(5000), source: "topic" });
  const limited = log.read("-1001:20")!;
  assert.ok(limited.input.snippet.length <= 1200);
  assert.ok(!limited.input.snippet.includes("x".repeat(60)));
  assert.equal(new SessionActivityLog(new StateManager(join(root, "storage", "state.json"))).read("-1001:20")?.input.id, "long");
  renameSync(join(root, "storage"), join(root, "storage-backup"));
  writeFileSync(join(root, "storage"), "Không phải thư mục");
  assert.throws(() => log.begin("-1001:20", { sessionID: "ses_a", inputID: "must_not_save", text: "Không được ghi đè", source: "topic" }));
  assert.equal(log.read("-1001:20")?.input.id, "long");
  const badFile = join(root, "unsupported.json");
  const badRaw = JSON.stringify({ "1": { sessionID: "ses_bad", sessionActivity: { version: 99 } } });
  writeFileSync(badFile, badRaw);
  const invalid = new SessionActivityLog(new StateManager(badFile));
  assert.throws(() => invalid.read("1"), /không hỗ trợ/);
  assert.throws(() => invalid.begin("1", { sessionID: "ses_bad", inputID: "new", text: "Không được ghi đè", source: "topic" }));
  assert.equal(readFileSync(badFile, "utf8"), badRaw);
  console.log("Đạt: nguồn và mã đầu vào được giữ đúng, phản hồi/mốc cũ không ghi đè, dữ liệu có giới hạn, khởi động lại và lỗi ghi an toàn.");
} finally { rmSync(root, { recursive: true, force: true }); }

const f = workflowBot();
try {
  f.oc.setInstruction = async () => {};
  f.oc.promptAndWait = async (_sid, _text, opts) => ({ reply: "Đã xử lý yêu cầu mới", outcome: "succeeded",
    interrupted: false, elapsedMs: 1, replyTime: Date.now(), replyID: "reply_public", replyInputID: opts?.messageID });
  await f.bot.handle(f.message("Yêu cầu gần nhất từ người dùng", 1, -1001, 200));
  for (let i = 0; i < 20 && !f.sent.some(message => message.text === "Đã xử lý yêu cầu mới"); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.sent.some(message => message.text === "Đã xử lý yêu cầu mới"));
  const activity = new SessionActivityLog(f.st).read("-1001:200")!;
  assert.equal(activity.input.snippet, "Yêu cầu gần nhất từ người dùng");
  assert.equal(activity.input.source, "topic");
  assert.equal(activity.result?.snippet, "Đã xử lý yêu cầu mới");
  await f.bot.handle(f.message("/sessions"));
  const details = f.buttons().filter(button => button.callback_data?.includes(":detail:"));
  const detail = details.find(button => button.callback_data!.endsWith("0000000000000001"))!;
  await f.bot.handle(f.tap(detail.callback_data!));
  assert.ok(f.sent.at(-1)?.text.includes("Yêu cầu gần nhất từ người dùng"));
  assert.ok(f.sent.at(-1)?.text.includes("Đã xử lý yêu cầu mới"));
  console.log("Đạt: đường gửi công khai lưu yêu cầu gốc thay phần hướng dẫn; thẻ phiên hiển thị yêu cầu/kết quả đúng mã.");
} finally { f.dispose(); }
