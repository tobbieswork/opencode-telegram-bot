import assert from "node:assert/strict";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { workflowBot } from "./fixtures/bot-workflow.js";
import type { Update } from "../src/telegram.js";
import { ScheduleStore } from "../src/scheduler.js";
import type { ScheduledRun } from "../src/scheduled-run.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

function setup() {
  const f = workflowBot();
  const at = Date.now() - 10_000;
  let input = "input_before_resume";
  const prompts: Array<{ sid: string; text: string; id: string }> = [];
  f.oc.activitySnapshot = async id => ({ info: structuredClone(f.observations.get(id)!.info), messages: [
    { id: "reply_before_resume", type: "assistant", content: [{ type: "text", text: "Kết quả đã quan sát" }], time: { created: at + 1 } },
    { id: input, type: "user", text: "Mục tiêu cũ", time: { created: at } },
  ] });
  f.oc.setInstruction = async () => {};
  f.oc.removeInstruction = async () => {};
  f.oc.promptAndWait = async (sid, text, opts) => { prompts.push({ sid, text, id: opts!.messageID! });
    throw new Error("Transport: fetch failed"); };
  f.oc.reconnect = async () => { throw new Error("Không được tự kết nối rồi gửi lại lượt tiếp tục"); };
  const button = (prefix: string) => f.buttons().find(button => button.callback_data?.startsWith(prefix))!.callback_data!;
  const start = async (replyToPrompt = true) => {
    await f.bot.handle(f.tap("sum:show:0000000000000001"));
    await f.bot.handle(f.tap(button("sum:refresh:")));
    await f.bot.handle(f.tap(button("sum:prepare:")));
    const replyID = f.sent.length;
    const update: Update = f.message("Tiếp tục: kiểm tra <đăng nhập> rồi báo kết quả");
    if (replyToPrompt) update.message!.reply_to_message = { message_id: replyID };
    await f.bot.handle(update);
    assert.ok(f.sent.at(-1)?.text.includes("Nội dung sẽ gửi"));
    return button("resume:yes:");
  };
  return { ...f, prompts, button, start, changeInput: () => { input = "input_newer"; } };
}

const f = setup();
let restored: Bot | undefined;
try {
  const yes = await f.start(false);
  assert.equal(f.prompts.length, 0);
  await f.bot.handle(f.tap(yes, 2));
  assert.equal(f.prompts.length, 0);
  await f.bot.handle(f.tap(yes, 1, -1002));
  assert.equal(f.prompts.length, 0);
  await Promise.all([f.bot.handle(f.tap(yes)), f.bot.handle(f.tap(yes))]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sid, "ses_fixture_0");
  assert.ok(f.prompts[0].text.endsWith("Tiếp tục: kiểm tra <đăng nhập> rồi báo kết quả"));
  assert.match(f.prompts[0].id, /^msg_/);
  assert.ok(f.st.peek("-1001:200")?.sessionActivity?.uncertainty);
  f.bot.stopScheduler();
  restored = new Bot(f.tg, f.oc, new StateManager(f.cfg.stateFile), f.cfg);
  await restored.handle(f.tap(yes));
  assert.equal(f.prompts.length, 1, "Mất phản hồi/khởi động lại không tự gửi lại");
  console.log("Đạt: xem/chuẩn bị không gửi; đúng người/nhóm; bấm đôi chỉ một mã qua bộ nhận công việc thật; mất phản hồi không phát lại.");
} finally { restored?.stopScheduler(); f.dispose(); }

const changed = setup();
try {
  const yes = await changed.start();
  changed.changeInput();
  await changed.bot.handle(changed.tap(yes));
  assert.equal(changed.prompts.length, 0);
  console.log("Đạt: có đầu vào mới thì xác nhận cũ không chạy.");
} finally { changed.dispose(); }

const full = setup();
try {
  full.cfg.maxWorkers = 1;
  const yes = await full.start();
  await full.bot.handle(full.tap(yes));
  assert.equal(full.prompts.length, 0, "Không vượt giới hạn công việc qua General");
  console.log("Đạt: tiếp tục đi qua giới hạn dung lượng hiện có.");
} finally { full.dispose(); }

for (const kind of ["closed", "restored", "permission", "form", "expired", "save-failed", "bind-failed", "scheduled", "scheduled-data-broken"] as const) {
  const guarded = setup();
  const clock = Date.now;
  try {
    const yes = await guarded.start();
    let scheduledDeadline: number | undefined;
    if (kind === "closed") { const data = guarded.st.sessionTopics()!; data.links["0000000000000001"].phase = "closed"; guarded.st.commitSessionTopics(data); }
    if (kind === "restored") { const data = guarded.st.sessionTopics()!; data.links["0000000000000001"].lifecycleRevision = 2; guarded.st.commitSessionTopics(data); }
    if (kind === "permission") guarded.observations.get("ses_fixture_0")!.permissions = ["permission_new"];
    if (kind === "form") guarded.observations.get("ses_fixture_0")!.forms = ["form_new"];
    if (kind === "expired") Date.now = () => clock() + 660_000;
    if (kind === "save-failed" || kind === "bind-failed") {
      const save = guarded.st.setRequired.bind(guarded.st);
      guarded.st.setRequired = (conv, patch) => {
        if (patch.resumeConfirmations && Object.values(patch.resumeConfirmations.records).some(item => item.state === "used" && (kind === "save-failed" || item.boundAt !== undefined))) throw new Error("Lỗi lưu xác nhận/mã đầu vào");
        save(conv, patch);
      };
    }
    if (kind === "scheduled") {
      const run: ScheduledRun = { id: "run_resume_owned", schedule: { id: "abcd", conv: "-1001", prompt: "Việc lịch", dir: "/projects/app",
        agent: "build", spec: { kind: "daily", time: { h: 9, m: 0 } }, tz: "UTC", enabled: false, nextRunAt: Date.now() + 86400_000, createdAt: 1, createdBy: 1 },
        mode: "manual", messageID: "msg_owned", admittedAt: Date.now(), deadline: Date.now() + 60_000, phase: "recovering",
        binding: { conv: "-1001:200", sessionID: "ses_fixture_0", source: "fixture", projectID: "project", createdAt: 1, sequence: 0 } };
      const store = new ScheduleStore(join(guarded.root, "schedules.json"), 10);
      store.add(run.schedule);
      store.admit(run, {});
      scheduledDeadline = run.deadline;
      assert.equal(store.runs()[0].binding?.conv, "-1001:200", "Ca thử phải thực sự tạo lượt đang sở hữu phiên");
    }
    if (kind === "scheduled-data-broken") writeFileSync(join(guarded.root, "schedules.json"), "{du-lieu-hong");
    await guarded.bot.handle(guarded.tap(yes));
    assert.equal(guarded.prompts.length, 0, kind);
    if (kind === "scheduled") {
      const stored = new ScheduleStore(join(guarded.root, "schedules.json"), 10).runs()[0];
      assert.equal(stored.deadline, scheduledDeadline);
      assert.equal(stored.finishedAt, undefined);
    }
    console.log(`Đạt: chặn xác nhận khi ${kind}.`);
  } finally { Date.now = clock; guarded.dispose(); }
}

const manager = setup();
try {
  manager.st.setRequired("-1001:200", { manager: true });
  let dispatched = 0;
  manager.oc.prompt = async (_sid, _text, opts) => { dispatched++; return opts!.messageID!; };
  const yes = await manager.start();
  await manager.bot.handle(manager.tap(yes));
  assert.equal(dispatched, 1);
  assert.equal(manager.prompts.length, 0, "Phiên quản lý không đi nhầm bộ gửi của phiên làm việc");
  assert.equal(manager.st.peek("-1001:200")?.sessionActivity?.input.source, "manager");
  console.log("Đạt: phiên quản lý đi qua cơ chế nhận việc riêng đang có.");
} finally { manager.dispose(); }

const stopped = setup();
try {
  const yes = await stopped.start();
  stopped.cfg.guideLanguage = true;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  stopped.oc.setInstruction = async () => { entered = true; await gate; };
  stopped.oc.topicSession = async id => structuredClone(stopped.observations.get(id)!.info);
  stopped.oc.interruptTopicSession = async () => true;
  const confirming = stopped.bot.handle(stopped.tap(yes));
  for (let i = 0; i < 20 && !entered; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(entered);
  await stopped.bot.handle(stopped.message("/stop", 1, -1001, 200));
  release();
  await confirming;
  assert.equal(stopped.prompts.length, 0, "Dừng khi chuẩn bị phải chặn trước khi gửi");
  console.log("Đạt: dừng trong lúc chuẩn bị không bị bỏ lỡ bởi cơ chế nhận việc.");
} finally { stopped.dispose(); }

const failure = setup();
try {
  failure.st.setRequired("-1001:200", { continueOfferedTurn: "input_before_resume" });
  failure.observations.get("ses_fixture_0")!.work = "failed";
  failure.tg.editMessageReplyMarkup = async () => {};
  await Promise.all([failure.bot.handle(failure.tap("cont:ses_fixture_0", 1, -1001, 200)), failure.bot.handle(failure.tap("cont:ses_fixture_0", 1, -1001, 200))]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(failure.prompts.length, 1, "Nút chạy tiếp cũ chia sẻ xác nhận dùng một lần");
  assert.ok(failure.prompts[0].text.endsWith("Tiếp tục phần còn lại, không hỏi lại."));
  console.log("Đạt: nút sau lỗi giữ nội dung cũ, kiểm tra mốc và không nhận hai lần.");
} finally { failure.dispose(); }

const readyBeforeRestart = setup();
let afterRestart: Bot | undefined;
try {
  const yes = await readyBeforeRestart.start();
  readyBeforeRestart.bot.stopScheduler();
  afterRestart = new Bot(readyBeforeRestart.tg, readyBeforeRestart.oc, new StateManager(readyBeforeRestart.cfg.stateFile), readyBeforeRestart.cfg);
  await afterRestart.handle(readyBeforeRestart.tap(yes));
  assert.equal(readyBeforeRestart.prompts.length, 0, "Thẻ chưa dùng trước khởi động lại phải được chuẩn bị mới");
  console.log("Đạt: xác nhận cũ chưa dùng cũng không tự sống lại sau khởi động.");
} finally { afterRestart?.stopScheduler(); readyBeforeRestart.dispose(); }
