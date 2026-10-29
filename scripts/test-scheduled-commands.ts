import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { ScheduleStore } from "../src/scheduler.js";
import type { ScheduledRun } from "../src/scheduled-run.js";
import type { OpenCodeCtl } from "../src/opencode.js";
import type { Telegram, Update } from "../src/telegram.js";
import { SessionActivityLog } from "../src/session-activity.js";

mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "opencode/scheduled-commands-"));
try {
  process.env.TELEGRAM_BOT_TOKEN = "token-kiem-thu";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    managerDir: join(root, "manager"), browseRoots: [root], defaultModel: { id: "test", providerID: "test" },
    schedule: false, activity: false, working: false, react: false, autoClose: false, maxWorkers: 1 };
  const st = new StateManager(cfg.stateFile);
  st.set("1:9", { sessionID: "ses_old", directory: root, agent: "plan",
    worker: { name: "sch-abcd", status: "idle", spawnedBy: "schedule", writes: false, createdAt: 1, updatedAt: 1 } });
  const store = new ScheduleStore(join(root, "schedules.json"), 10);
  const nextRunAt = Date.now() + 86_400_000;
  store.add({ id: "abcd", conv: "1", prompt: "Kiểm tra dự án", dir: root, agent: "plan", spec: { kind: "daily", time: { h: 9, m: 0 } },
    tz: "UTC", nextRunAt, enabled: false, createdBy: 1, createdAt: 1 });
  const sent: string[] = [];
  let submitted = 0;
  let stopped = 0;
  let sid = 0;
  const tg = {
    sendMessage: async (_conv: string, text: string) => { sent.push(text); },
    answerCallbackQuery: async () => {}, editForumTopic: async () => {}, sendChatAction: () => {},
    openForumTopic: async () => {}, deleteMessage: async () => {},
  } as unknown as Telegram;
  const oc = {
    scheduledReady: async () => {}, createSession: async () => `ses_new_${++sid}`, removeSession: async () => {},
    retireScheduledSession: async () => {},
    setModel: async () => {}, setAgent: async () => {},
    scheduledBinding: async (_run: ScheduledRun, conv: string, sessionID: string) => ({
      conv, sessionID, source: "test", projectID: "project", createdAt: 1, sequence: 0,
    }),
    submitScheduled: async () => { submitted++; },
    observeScheduled: async () => ({ state: "running" }),
    scheduledObserver: () => ({ stop: async () => { stopped++; } }),
  } as unknown as OpenCodeCtl;
  const bot = new Bot(tg, oc, st, cfg);
  const message = (text: string, topic = false): Update => ({
    update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text,
      ...(topic ? { message_thread_id: 9, is_topic_message: true } : {}) },
  });
  const button: Update = { update_id: 2, callback_query: { id: "button", from: { id: 1 }, data: "sch:run:abcd",
    message: { message_id: 2, chat: { id: 1 } } } };
  await bot.handle(message("/schedule run abcd"));
  await bot.handle(button);
  assert.equal(submitted, 0, "master OFF chặn cả lệnh và nút");
  cfg.schedule = true;
  await bot.handle(message("/schedule run abcd"));
  await bot.handle(button);
  assert.equal(submitted, 1, "lệnh và nút cùng dùng guard chống trùng");
  const run = store.runs()[0];
  const activity = new SessionActivityLog(st).read(run.binding!.conv)!;
  assert.equal(activity.input.id, run.messageID);
  assert.equal(activity.input.source, "schedule");
  assert.equal(activity.input.snippet, "Kiểm tra dự án");
  assert.equal(store.get("abcd")?.enabled, false, "manual không bật lịch paused");
  assert.equal(store.get("abcd")?.nextRunAt, nextRunAt, "manual không thay lịch tự động");
  const bound = st.peek("1:9")?.sessionID;
  await bot.handle({ update_id: 3, callback_query: { id: "new", from: { id: 1 }, data: "cmd:new",
    message: { message_id: 3, chat: { id: 1 }, message_thread_id: 9, is_topic_message: true } } });
  assert.equal(st.peek("1:9")?.sessionID, bound, "nút tạo session không vượt guard của lượt chạy lịch");
  await bot.handle(message("/clear", true));
  assert.ok(st.peek("1:9")?.sessionID, "không xoá binding của lượt chưa terminal");
  await bot.handle(message("/stop", true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(stopped > 0, "stop đi qua recovery và xác minh execution");
  assert.equal(store.runs()[0].finishedAt, undefined, "không báo terminal trước xác nhận");
  assert.ok(sent.some((text) => text.includes("chưa xác nhận")), "thông báo rõ mức xác nhận");
  bot.stopScheduler();
  console.log("Đạt: lệnh/nút Telegram dùng chung admission và stop có xác nhận.");
} finally { rmSync(root, { recursive: true, force: true }); }
