import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { SessionTopics } from "../src/session-topics.js";
import type { OpenCodeCtl } from "../src/opencode.js";
import type { Telegram } from "../src/telegram.js";
import { workflowFixture, WorkflowClock, deferred } from "./fixtures/workflow.js";

const root = mkdtempSync(join(tmpdir(), "workflow-foundations-"));
let bot: Bot | undefined;
try {
  const fixture = workflowFixture();
  const file = join(root, "state.json");
  const st = new StateManager(file);
  for (const [conv, state] of Object.entries(fixture.states)) st.set(conv, state);
  st.commitSessionTopics(fixture.topics);
  let sideEffects = 0;
  const forbidden = async () => { sideEffects++; throw new Error("Không được thay đổi tài nguyên khi xem danh sách"); };
  const oc = { listSessions: async () => [], createTopicSession: forbidden, archiveSession: forbidden,
    promptAndWait: forbidden, interruptTopicSession: forbidden } as unknown as OpenCodeCtl;
  const messages: string[] = [];
  const tg = { sendMessage: async (_conv: string, text: string) => { messages.push(text); },
    createForumTopic: forbidden, editForumTopic: forbidden, closeForumTopic: forbidden,
    openForumTopic: forbidden, setMyCommands: async () => {} } as unknown as Telegram;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  const cfg = { ...loadConfig(root), stateFile: file, schedule: false, activity: false,
    working: false, stream: false, react: false, remind: false, uptimeMonitor: false, prWatch: false };
  bot = new Bot(tg, oc, st, cfg);
  const before = structuredClone(st.sessionTopics());
  await bot.handle({ update_id: 1, message: { chat: { id: -1001, type: "supergroup", is_forum: true },
    message_id: 1, from: { id: 1 }, text: "/sessions" } });
  assert.equal(sideEffects, 0);
  assert.deepEqual(st.sessionTopics(), before);
  assert.ok(messages.some(text => text.includes("Phiên đang quản lý")));
  assert.equal(st.peek("-1001:202")?.pendingPrompts?.form_fixture.remindersSent, 1);
  assert.equal(st.peek("-1001:206")?.worker?.spawnedBy, "schedule");
  assert.equal(fixture.runs[0].phase, "recovering");
  assert.equal(fixture.runs[0].finishedAt, undefined);
  assert.equal(fixture.runs[0].deadline, fixture.now + 90_000);
  console.log("Đạt: dữ liệu mẫu đi qua lệnh công khai mà không sửa liên kết, nhắc hoặc thực thi.");

  const clock = new WorkflowClock(1000);
  const seen: string[] = [];
  const canceled = clock.schedule(10, () => { seen.push("không được chạy"); });
  clock.cancel(canceled);
  clock.schedule(20, () => { seen.push("sau"); });
  clock.schedule(10, () => { seen.push("trước"); });
  await clock.advance(20);
  assert.deepEqual(seen, ["trước", "sau"]);
  assert.equal(clock.now, 1020);
  const pending = deferred<string>();
  pending.resolve("xong");
  assert.equal(await pending.promise, "xong");

  const unsupported = join(root, "unsupported.json");
  const raw = JSON.stringify({ __machine__: { sessionTopics: { version: 99, groups: {}, links: {} } } });
  writeFileSync(unsupported, raw);
  const owner = new SessionTopics(new StateManager(unsupported), {
    createSession: forbidden, session: forbidden, createTopic: forbidden, archive: forbidden,
    closeTopic: forbidden, openTopic: forbidden, stop: forbidden,
  });
  await assert.rejects(() => owner.create({ chat: "-1001", directory: root, title: "Không được tạo" }), /Unsupported/);
  assert.equal(readFileSync(unsupported, "utf8"), raw);
  assert.equal(sideEffects, 0);
  console.log("Đạt: đồng hồ điều khiển được; phiên bản trạng thái không hỗ trợ bị chặn và được giữ nguyên.");
} finally {
  bot?.stopScheduler();
  rmSync(root, { recursive: true, force: true });
}
