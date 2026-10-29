import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { Orchestrator } from "../src/orchestrator.js";
import { BusyNoteStore } from "../src/notes.js";
import type { TopicSession } from "../src/session-topics.js";
import type { OpenCodeCtl } from "../src/opencode.js";
import type { Telegram, Update } from "../src/telegram.js";

const root = mkdtempSync(join(tmpdir(), "manager-entry-"));
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";

function fixture(name: string, existingState?: StateManager) {
  const directory = join(root, name);
  const cfg = { ...loadConfig(directory), stateFile: join(directory, "state.json"),
    opencodeDirectory: directory, managerDir: join(directory, "manager"), bridgePort: 0,
    browseRoots: [directory], schedule: false, activity: false, working: false, react: false,
    stream: false, uptimeMonitor: false, prWatch: false, remind: false, worktreeMode: "off" as const };
  const st = existingState ?? new StateManager(cfg.stateFile);
  st.commitSessionTopics(st.sessionTopics() ?? { version: 1, groups: { "-1001": true }, links: {} });
  const sent: Array<{ conv: string; text: string; opts?: any }> = [];
  const sessions = new Map<string, TopicSession>();
  const calls = { sessions: 0, topics: 0, prompts: 0, archives: 0, opens: 0, tooling: 0 };
  const toolingDirectories: string[] = [];
  let failTopic = false;
  let failCreate = false;
  let failOpen = false;
  let failInspect = false;
  let bridge: { url: string; headers: Record<string, string> } | undefined;
  const tg = { sendMessage: async (conv: string, text: string, opts?: any) => { sent.push({ conv, text, opts }); },
    answerCallbackQuery: async () => {}, setMyCommands: async () => {},
    createForumTopic: async () => { calls.topics++; if (failTopic) throw new Error("Mất kết nối sau khi tạo chủ đề"); return 200 + calls.topics; },
    closeForumTopic: async () => {}, openForumTopic: async () => { calls.opens++; if (failOpen) throw new Error("Không mở được chủ đề"); },
    sendChatAction: () => {}, editForumTopic: async () => {} } as unknown as Telegram;
  const oc = {
    createTopicSession: async (input: { directory: string }) => {
      const id = `ses_${++calls.sessions}`;
      sessions.set(id, session(id, input.directory));
      if (failCreate) throw new Error("Mất phản hồi sau khi tạo phiên");
      return id;
    },
    topicSession: async (id: string) => {
      if (failInspect) throw new Error("Không xác minh được phiên");
      if (!sessions.has(id)) throw Object.assign(new Error("Không tìm thấy phiên"), { name: "SessionNotFoundError" });
      return structuredClone(sessions.get(id)!);
    },
    archiveSession: async (id: string, archived: boolean) => { calls.archives++; sessions.get(id)!.archived = archived; },
    interruptTopicSession: async () => {},
    addRemoteMcp: async (dir: string, _name: string, url: string, headers: Record<string, string>) => {
      toolingDirectories.push(dir);
      calls.tooling++; bridge = { url, headers };
    }, mcpStatus: async () => ({ status: "connected" }),
    setModel: async () => {}, setAgent: async () => {}, listModels: async () => [], listSessions: async () => [],
    getSession: async () => null,
    promptAndWait: async () => { calls.prompts++; throw new Error("Không được tự gửi yêu cầu"); },
  } as unknown as OpenCodeCtl;
  const bot = new Bot(tg, oc, st, cfg);
  let update = 0;
  const message = (text: string, topic?: number, user = 1): Update => ({ update_id: ++update,
    message: { message_id: update, chat: { id: -1001, type: "supergroup", is_forum: true }, from: { id: user }, text,
      ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } });
  const tap = (topic?: number, user = 1): Update => ({ update_id: ++update,
    callback_query: { id: `cb-${update}`, from: { id: user }, data: "mgr:open",
      message: { message_id: update, chat: { id: -1001 }, ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } } });
  const tool = async () => {
    assert.ok(bridge);
    const response = await fetch(bridge.url, { method: "POST", headers: { ...bridge.headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workers", arguments: {} } }) });
    return (await response.json() as any).result;
  };
  return { bot, st, sent, sessions, calls, message, tap, tool, cfg, oc, tg, toolingDirectories,
    failTopic: () => { failTopic = true; }, failCreate: () => { failCreate = true; },
    failOpen: () => { failOpen = true; }, failInspect: () => { failInspect = true; } };
}

function session(id: string, directory: string): TopicSession {
  return { id, title: "Quản lý cũ", directory, projectID: "test", source: "test", createdAt: 1,
    archived: false, busy: false, terminal: true };
}

const fixtures: ReturnType<typeof fixture>[] = [];
const make = (name: string, st?: StateManager) => { const f = fixture(name, st); fixtures.push(f); return f; };
const navigation = (f: ReturnType<typeof fixture>) => f.sent.at(-1)?.opts?.reply_markup?.inline_keyboard?.flat().find((b: any) => b.url);
try {
  const f = make("normal");
  await f.bot.handle(f.message("Tôi muốn đổi tên chủ đề"));
  assert.ok(f.sent.at(-1)?.opts?.reply_markup?.inline_keyboard.flat().some((b: any) => b.text === "Mở phiên quản lý" && b.callback_data === "mgr:open"),
    "General phải đưa ra một nút mở phiên quản lý");
  assert.ok(f.sent.at(-1)?.text.includes("/sessions"));
  await f.bot.handle(f.message("/manager"));
  assert.equal(f.calls.sessions, 0, "Hiển thị lựa chọn không được tự tạo phiên");
  await Promise.all([f.bot.handle(f.tap()), f.bot.handle(f.tap()), f.bot.handle(f.message("/manager on"))]);
  assert.equal(f.calls.sessions, 1);
  assert.equal(f.calls.topics, 1);
  const link = Object.values(f.st.sessionTopics()!.links)[0];
  assert.equal(navigation(f)?.text, "Vào chủ đề quản lý", f.sent.at(-1)?.text);
  assert.ok(navigation(f)?.url.endsWith("/201"));
  assert.equal((await f.tool()).isError, undefined);
  await f.bot.handle(f.tap());
  assert.equal(f.calls.sessions, 1);
  assert.equal(f.calls.archives, 0);
  await f.bot.handle(f.message("/manager off"));
  assert.equal(f.sessions.get(link.sessionID!)!.archived, true);
  await f.bot.handle(f.tap());
  assert.equal(f.calls.sessions, 1);
  assert.equal(f.calls.topics, 1);
  assert.equal(f.sessions.get(link.sessionID!)!.archived, false);
  assert.equal(Object.values(f.st.sessionTopics()!.links)[0].sessionID, link.sessionID);
  assert.equal(f.calls.prompts, 0);
  const reloaded = make("normal", new StateManager(f.cfg.stateFile));
  reloaded.sessions.set(link.sessionID!, structuredClone(f.sessions.get(link.sessionID!)!));
  await reloaded.bot.handle(reloaded.tap());
  assert.equal(reloaded.calls.sessions + reloaded.calls.topics, 0);
  assert.ok(navigation(reloaded)?.url.endsWith("/201"));
  console.log("Đạt: một nút tạo/mở/khôi phục đúng phiên; bấm đồng thời không tạo trùng, không tự gửi yêu cầu.");

  for (const from of ["-1001", "-1001:1"]) {
    const legacy = make(`legacy-${from.replaceAll(":", "-")}`);
    legacy.sessions.set("ses_legacy", session("ses_legacy", join(root, "du-an-cu")));
    const selectedDirectory = join(root, from === "-1001" ? "du-an-cu" : "du-an-moi");
    legacy.st.set(from, { sessionID: "ses_legacy", manager: true, directory: selectedDirectory, agent: "tg-manager", lastRelayedTime: 123,
      notes: "Giữ ghi chú" });
    await legacy.bot.handle(legacy.tap());
    const adopted = Object.values(legacy.st.sessionTopics()!.links)[0];
    assert.equal(adopted.sessionID, "ses_legacy");
    assert.equal(legacy.st.peek(adopted.conv!)?.manager, true);
    assert.equal(legacy.st.peek(adopted.conv!)?.notes, "Giữ ghi chú");
    assert.equal(legacy.st.peek(adopted.conv!)?.lastRelayedTime, 123, "Không tua lại mốc chuyển tiếp của phiên cũ");
    assert.equal(legacy.st.peek(from)?.sessionID, undefined);
    assert.equal(legacy.st.peek(from)?.manager, false);
    assert.equal(legacy.st.peek(from)?.agent, undefined);
    assert.equal(legacy.st.peek(from)?.directory, from === "-1001" ? undefined : selectedDirectory);
    assert.equal(legacy.calls.sessions, 0);
    assert.equal((await legacy.tool()).isError, undefined);
    await legacy.bot.handle(legacy.tap());
    assert.equal(legacy.calls.topics, 1);
    const reconnect = new Orchestrator({ st: legacy.st, cfg: legacy.cfg, oc: legacy.oc, tg: legacy.tg,
      busyNotes: new BusyNoteStore(), sendHtml: async () => {}, applyModelAndVariant: async () => {},
      startTyping: () => {}, startWorking: () => {}, stopWorking: () => {} });
    const registrations = legacy.toolingDirectories.length;
    try {
      await reconnect.onConnect();
      assert.deepEqual(legacy.toolingDirectories.slice(registrations), [adopted.directory],
        "Kết nối lại phải đăng ký công cụ vào đúng thư mục phiên đã chuyển, không dùng thư mục quản lý mặc định");
    } finally { reconnect.shutdown(); }
  }
  console.log("Đạt: chuyển phiên quản lý cũ từ cả hai cách biểu diễn General, giữ nguyên phiên, ghi chú và mốc chuyển tiếp.");

  for (const mode of ["busy", "unknown", "inspect"] as const) {
    const blocked = make(mode);
    blocked.st.set("-1001", { manager: true, sessionID: "ses_old" });
    blocked.sessions.set("ses_old", { ...session("ses_old", root), busy: mode === "busy", terminal: mode !== "unknown" });
    if (mode === "inspect") blocked.failInspect();
    await blocked.bot.handle(blocked.tap());
    assert.equal(blocked.calls.sessions + blocked.calls.topics + blocked.calls.tooling, 0);
    assert.equal(blocked.st.peek("-1001")?.sessionID, "ses_old");
    assert.equal(navigation(blocked), undefined);
  }
  console.log("Đạt: phiên cũ đang chạy hoặc chưa xác minh được không bị chuyển, thay thế hay sửa công cụ.");

  const oldAmbiguous = make("old-ambiguous");
  oldAmbiguous.st.set("-1001", { manager: true, sessionID: "ses_old" });
  oldAmbiguous.sessions.set("ses_old", session("ses_old", oldAmbiguous.cfg.opencodeDirectory));
  oldAmbiguous.failTopic();
  await oldAmbiguous.bot.handle(oldAmbiguous.tap());
  await oldAmbiguous.bot.handle(oldAmbiguous.tap());
  assert.equal(oldAmbiguous.calls.sessions, 0);
  assert.equal(oldAmbiguous.calls.topics, 1);
  assert.equal(oldAmbiguous.st.peek("-1001")?.sessionID, "ses_old");

  const conflicting = make("conflicting");
  conflicting.st.set("-1001", { manager: true, sessionID: "ses_shared" });
  conflicting.st.set("-1002:201", { sessionID: "ses_shared" });
  conflicting.sessions.set("ses_shared", session("ses_shared", conflicting.cfg.opencodeDirectory));
  await conflicting.bot.handle(conflicting.tap());
  assert.equal(conflicting.calls.sessions + conflicting.calls.topics, 0);
  assert.equal(conflicting.st.peek("-1002:201")?.sessionID, "ses_shared");

  const ambiguous = make("ambiguous");
  ambiguous.failTopic();
  await ambiguous.bot.handle(ambiguous.tap());
  await ambiguous.bot.handle(ambiguous.tap());
  assert.equal(ambiguous.calls.sessions, 1);
  assert.equal(ambiguous.calls.topics, 1);
  assert.equal(navigation(ambiguous), undefined);
  ambiguous.bot.stopScheduler();
  const restarted = make("ambiguous", new StateManager(ambiguous.cfg.stateFile));
  await restarted.bot.handle(restarted.tap());
  assert.equal(restarted.calls.sessions + restarted.calls.topics, 0, "Khởi động lại không được tạo thay phiên chưa rõ kết quả");

  const lostSession = make("lost-session");
  lostSession.failCreate();
  await lostSession.bot.handle(lostSession.tap());
  await lostSession.bot.handle(lostSession.tap());
  assert.equal(lostSession.calls.sessions, 1, "Không tạo lại khi mất phản hồi dù chưa lưu được mã phiên");
  assert.equal(lostSession.calls.topics, 0);

  for (const phase of ["closing", "attention", "missing", "restoring"] as const) {
    const data = f.st.sessionTopics()!;
    data.links[link.id].phase = phase;
    f.st.commitSessionTopics(data);
    await f.bot.handle(f.tap());
    assert.equal(navigation(f), undefined);
    assert.ok(f.sent.at(-1)?.text.includes(phase));
    assert.equal((await f.tool()).isError, true);
  }
  console.log("Đạt: trạng thái chưa rõ và lỗi tạo chủ đề được giữ để kiểm tra, kể cả sau khởi động lại; công cụ vẫn bị chặn.");

  const failedOpen = make("failed-open");
  await failedOpen.bot.handle(failedOpen.tap());
  await failedOpen.bot.handle(failedOpen.message("/manager off"));
  failedOpen.failOpen();
  await failedOpen.bot.handle(failedOpen.tap());
  assert.equal(navigation(failedOpen), undefined);
  assert.equal(Object.values(failedOpen.st.sessionTopics()!.links)[0].phase, "restoring");
  assert.equal((await failedOpen.tool()).isError, true);

  const unavailable = make("unavailable");
  await unavailable.bot.handle(unavailable.tap());
  unavailable.failInspect();
  await unavailable.bot.handle(unavailable.tap());
  assert.equal(navigation(unavailable), undefined, "Không đưa liên kết thành công khi kiểm tra phiên thất bại");
  assert.equal((await unavailable.tool()).isError, true, "Lỗi xác minh phải đóng quyền gọi công cụ");

  const denied = make("denied");
  await denied.bot.handle(denied.tap(undefined, 2));
  await denied.bot.handle(denied.tap(201));
  assert.equal(denied.calls.sessions + denied.calls.topics, 0);
  console.log("Đạt: nút chỉ có hiệu lực với người được phép trong General.");
} finally {
  for (const f of fixtures) f.bot.stopScheduler();
  rmSync(root, { recursive: true, force: true });
}
