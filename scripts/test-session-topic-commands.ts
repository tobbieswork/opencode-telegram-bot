import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager, MACHINE_STATE_KEY } from "../src/state.js";
import type { TopicSession } from "../src/session-topics.js";
import type { OpenCodeCtl } from "../src/opencode.js";
import type { Telegram, Update } from "../src/telegram.js";
import { ScheduleStore } from "../src/scheduler.js";
import type { ScheduledRun } from "../src/scheduled-run.js";
import { commandScope } from "../src/commands.js";

const root = mkdtempSync(join(tmpdir(), "session-topic-commands-"));
try {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    browseRoots: [root], managerDir: join(root, "manager"), defaultModel: { id: "test", providerID: "test" },
    schedule: false, activity: false, working: false, react: false, stream: false,
    uptimeMonitor: false, prWatch: false, remind: false, worktreeMode: "off" as const };
  const st = new StateManager(cfg.stateFile);
  const sent: Array<{ conv: string; text: string; opts?: any }> = [];
  const sessions = new Map<string, TopicSession>();
  let created = 0;
  let thread = 200;
  let forumAllowed = false;
  let events: ((event: unknown) => void) | undefined;
  let scheduledPrompts = 0;
  const removedSessions: string[] = [];
  const configuredSessions: string[] = [];
  const legacyInterrupts: string[] = [];
  const promptTargets: string[] = [];
  const closed: string[] = [];
  const tg = { sendMessage: async (conv: string, text: string, opts?: any) => { sent.push({ conv, text, opts }); },
    sendMessageId: async (conv: string, text: string, opts?: any) => { sent.push({ conv, text, opts }); return sent.length; },
    answerCallbackQuery: async () => {}, createForumTopic: async () => ++thread,
    closeForumTopic: async (conv: string) => { closed.push(conv); }, openForumTopic: async () => {}, editForumTopic: async () => {},
    editMessageText: async () => {},
    editMessageReplyMarkup: async () => {},
    setMyCommands: async () => {},
    assertForumManagement: async () => { if (!forumAllowed) throw new Error("Manage Topics is required"); },
    sendChatAction: () => {}, deleteMessage: async () => {} } as unknown as Telegram;
  const oc = { createTopicSession: async (input: { directory: string }) => {
    const id = `ses_${++created}`;
    sessions.set(id, { id, directory: input.directory, projectID: "project", createdAt: created,
      source: "test", archived: false, busy: false, terminal: true });
    return id;
  }, topicSession: async (id: string) => {
    if (!sessions.has(id)) throw Object.assign(new Error("Missing"), { name: "SessionNotFoundError" });
    return structuredClone(sessions.get(id)!);
  },
    archiveSession: async (id: string, archived: boolean) => { sessions.get(id)!.archived = archived; },
    interruptTopicSession: async () => {}, setModel: async (id: string) => { configuredSessions.push(id); },
    setAgent: async (id: string) => { configuredSessions.push(id); },
    listModels: async () => [{ id: "test", providerID: "test", variants: [] }], getVariants: async () => [],
    interrupt: async (id: string) => { legacyInterrupts.push(id); }, removeSession: async (id: string) => { removedSessions.push(id); },
    promptAndWait: async (id: string) => { promptTargets.push(id); return { outcome: "succeeded", reply: "Result", elapsedMs: 1 }; },
    setInstruction: async () => {}, removeInstruction: async () => {},
    subscribeEvents: (callback: (event: unknown) => void) => { events = callback; },
    latestReply: async () => ({ text: "Result", time: Date.now() }),
    sessionState: async () => ({ busy: false, outcome: "succeeded" }),
    listMessages: async () => [],
    listSessions: async () => [],
    scheduledReady: async () => {},
    scheduledBinding: async (_run: ScheduledRun, conv: string, sessionID: string) => ({ conv, sessionID,
      source: "test", projectID: "project", createdAt: sessions.get(sessionID)!.createdAt, sequence: 0 }),
    submitScheduled: async () => { scheduledPrompts++; },
    observeScheduled: async () => ({ state: "succeeded" }),
    addRemoteMcp: async () => {}, mcpStatus: async () => ({ status: "connected" }),
  } as unknown as OpenCodeCtl;
  const bot = new Bot(tg, oc, st, cfg);
  let update = 0;
  const message = (text: string, topic?: number): Update => ({ update_id: ++update,
    message: { message_id: update, chat: { id: -1001, type: "supergroup", is_forum: true }, from: { id: 1 }, text,
      ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } });
  await bot.handle(message("/setup"));
  assert.equal(st.sessionTopics()?.groups["-1001"], undefined, "missing rights must not enable or migrate the group");
  forumAllowed = true;
  sessions.set("ses_busy", { id: "ses_busy", directory: root, projectID: "project", createdAt: 100,
    source: "test", archived: false, busy: true, terminal: false });
  st.set("-1001", { sessionID: "ses_busy" });
  await bot.handle(message("/setup"));
  assert.equal(st.sessionTopics()?.groups["-1001"], undefined, "active legacy work cannot be silently cut over");
  assert.equal(st.peek("-1001")?.sessionID, "ses_busy");
  st.clear("-1001");
  await bot.handle(message("/setup"));
  assert.equal(st.sessionTopics()?.groups["-1001"], true);
  await bot.handle(message("/new"));
  const links = Object.values(st.sessionTopics()!.links);
  assert.equal(links.length, 1);
  assert.equal(links[0].conv, "-1001:201");
  assert.equal(st.peek("-1001")?.sessionID, undefined);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  await bot.handle(message("/new", 201));
  assert.equal(created, 1);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  assert.ok(sent.at(-1)?.text.includes("General"));
  console.log("ok: General creates a topic/session; /new inside the topic cannot replace it");
  const button = (data: string, topic?: number): Update => ({ update_id: ++update,
    callback_query: { id: `callback-${update}`, from: { id: 1 }, data,
      message: { message_id: update, chat: { id: -1001 },
        ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } } });
  for (const data of ["cmd:new", "cmd:clear", "bs:setsess", "use:ses_other", "use:ls"]) await bot.handle(button(data, 201));
  assert.equal(created, 1);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  await bot.handle(button("cmd:new"));
  assert.equal(created, 2);
  assert.equal(st.peek("-1001")?.sessionID, undefined);
  const first = Object.values(st.sessionTopics()!.links)[0];
  await bot.handle(button(`st:close:${first.id}`, 201));
  assert.equal(sessions.get("ses_1")!.archived, false);
  await bot.handle(button(`st:close:${first.id}`));
  assert.equal(sessions.get("ses_1")!.archived, true);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  await bot.handle(button(`st:restore:${first.id}`));
  assert.equal(sessions.get("ses_1")!.archived, false);
  assert.equal(thread, 202);
  console.log("ok: buttons obey the same General-only policy; close/restore preserve identity");
  await bot.handle(message("/browse"));
  await bot.handle(button("bs:setsess"));
  assert.equal(created, 3);
  assert.equal(st.peek("-1001")?.sessionID, undefined);
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  console.log("ok: the folder browser also creates a separate topic instead of a General session");
  bot.start();
  const closedNoticesBefore = sent.filter((item) => item.conv === "-1001" && item.text.includes("closed")).length;
  sessions.get("ses_1")!.archived = true;
  events!({ type: "session.archived", data: { sessionID: "ses_1" } });
  for (let i = 0; i < 30 && st.sessionTopics()?.links[first.id].phase !== "closed"; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(st.sessionTopics()?.links[first.id].phase, "closed");
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(sent.filter((item) => item.conv === "-1001" && item.text.includes("closed")).length > closedNoticesBefore);
  sessions.get("ses_1")!.archived = false;
  events!({ type: "session.unarchived", data: { sessionID: "ses_1" } });
  for (let i = 0; i < 30 && st.sessionTopics()?.links[first.id].phase !== "open"; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(st.sessionTopics()?.links[first.id].phase, "open");
  const closesBeforeFinish = closed.length;
  events!({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(closed.length, closesBeforeFinish, "finishing a turn must not close a managed topic");
  console.log("ok: live archive/restore events sync lifecycle; execution success leaves the topic open");
  const schedules = new ScheduleStore(join(root, "schedules.json"), 10);
  schedules.add({ id: "abcd", conv: "-1001", prompt: "Test", dir: root, agent: "plan",
    spec: { kind: "daily", time: { h: 9, m: 0 } }, tz: "UTC", enabled: false,
    nextRunAt: Date.now() + 86_400_000, createdAt: Date.now(), createdBy: 1 });
  cfg.schedule = true;
  await bot.handle(message("/schedule run abcd"));
  assert.equal(scheduledPrompts, 1);
  const runOne = schedules.runs().at(-1)!;
  assert.ok(runOne.binding);
  events!({ type: "session.execution.succeeded", data: { sessionID: runOne.binding!.sessionID } });
  for (let i = 0; i < 30 && !schedules.runs().find((item) => item.id === runOne.id)?.finishedAt; i++) await new Promise<void>((r) => setImmediate(r));
  await bot.handle(message("/schedule run abcd"));
  assert.equal(scheduledPrompts, 2);
  const runTwo = schedules.runs().at(-1)!;
  assert.notEqual(runTwo.binding!.conv, runOne.binding!.conv);
  assert.notEqual(runTwo.binding!.sessionID, runOne.binding!.sessionID);
  assert.equal(st.peek(runOne.binding!.conv)?.sessionID, runOne.binding!.sessionID);
  console.log("ok: every scheduled run has a fresh topic and session; previous bindings remain intact");
  const beforeManager = created;
  await bot.handle(message("/manager on"));
  const managerEntry = st.convsOfChat("-1001").find(([, value]) => value.manager);
  assert.ok(managerEntry && managerEntry[0] !== "-1001");
  assert.equal(st.peek("-1001")?.sessionID, undefined);
  assert.equal(created, beforeManager + 1);
  await bot.handle(message("/manager off"));
  assert.equal(sessions.get(managerEntry![1].sessionID!)!.archived, true);
  await bot.handle(message("/manager on"));
  assert.equal(created, beforeManager + 1);
  assert.equal(sessions.get(managerEntry![1].sessionID!)!.archived, false);
  console.log("ok: Manager has its own fixed session/topic; General remains a control surface");
  assert.equal(commandScope("/new"), "general");
  assert.equal(commandScope("/b"), "general");
  assert.equal(commandScope("/sessions"), "general");
  assert.equal(commandScope("/reboot"), "general");
  assert.equal(commandScope("/stop"), "topic");
  await bot.handle(message("/reboot", 201));
  assert.ok(sent.at(-1)?.text.includes("General"));
  console.log("ok: command scope and aliases are shared by menu, messages and callbacks");
  tg.onThreadNotFound!(-1001, 201);
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(st.peek("-1001:201")?.sessionID, "ses_1");
  assert.equal(st.sessionTopics()?.links[first.id].phase, "attention");
  assert.equal(removedSessions.length, 0);
  await bot.handle(message("hello", 201));
  assert.equal(created, beforeManager + 1);
  console.log("ok: a deleted Telegram topic never deletes its session or creates a replacement");
  const worker = st.peek("-1001:201")!.worker!;
  st.set("-1001:201", { worker: { ...worker, status: "done", updatedAt: Date.now() - 10 * 86_400_000 } });
  await bot.handle(message("/prune 1"));
  assert.ok(!JSON.stringify(sent.at(-1)?.opts ?? {}).includes("prune:"), "managed history is never offered to legacy destructive cleanup");
  console.log("ok: legacy pruning cannot delete managed session/topic history");
  st.set("-1001", { sessionID: "ses_legacy" });
  await bot.handle(message("/mode plan"));
  await bot.handle(message("/model test"));
  await bot.handle(message("/variant low"));
  assert.ok(!configuredSessions.includes("ses_legacy"));
  assert.equal(st.peek("-1001")?.sessionID, "ses_legacy", "legacy identity stays untouched until explicit migration");
  console.log("ok: General settings are defaults, never edits to a retained legacy session");
  await bot.handle(message("/stop"));
  await bot.handle(button("cont:ses_legacy"));
  await bot.handle(message("please run this"));
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(!legacyInterrupts.includes("ses_legacy"));
  assert.ok(!promptTargets.includes("ses_legacy"));
  console.log("ok: General cannot resume, prompt or interrupt its retained legacy session");
  const secondWorker = st.peek("-1001:202")!.worker!;
  st.set("-1001:202", { worker: { ...secondWorker, status: "running" } });
  Object.assign(sessions.get("ses_2")!, { busy: true, terminal: false });
  const beforeStopCloses = closed.length;
  await bot.handle(message(`/kill ${secondWorker.name}`));
  assert.equal(st.peek("-1001:202")?.worker?.status, "running", "unconfirmed stop keeps capacity occupied");
  assert.equal(closed.length, beforeStopCloses);
  Object.assign(sessions.get("ses_2")!, { busy: false, terminal: true });
  await bot.handle(message(`/kill ${secondWorker.name}`));
  assert.equal(st.peek("-1001:202")?.worker?.status, "stopped");
  assert.equal(closed.length, beforeStopCloses);
  assert.equal(sessions.get("ses_2")!.archived, false);
  console.log("ok: stopping work waits for proof and never archives or closes its topic");
  const configurationsBefore = configuredSessions.length;
  await bot.handle(message("/mode plan", 201));
  assert.equal(configuredSessions.length, configurationsBefore);
  console.log("ok: unavailable or closed topics cannot mutate their retained session");
  bot.stopScheduler();
  cfg.maxWorkers = 1;
  const occupied = st.peek(runTwo.binding!.conv)!.worker!;
  st.set(runTwo.binding!.conv, { worker: { ...occupied, status: "running" } });
  const promptsBeforeResume = promptTargets.length;
  await bot.handle(button("cont:ses_2", 202));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(promptTargets.length, promptsBeforeResume, "resume buttons must use the same worker admission as messages");
  console.log("ok: resume buttons cannot bypass shared worker capacity");
  const beforeNativeStop = legacyInterrupts.length;
  await bot.handle({ update_id: ++update, stopped_message_generation: { chat: { id: -1001 }, message_thread_id: 202, draft_id: 1 } });
  assert.equal(legacyInterrupts.length, beforeNativeStop, "draft stop uses the same lifecycle-aware stop path");
  console.log("ok: Telegram's native stop signal does not bypass confirmed-stop handling");
  cfg.react = true;
  st.set(MACHINE_STATE_KEY, { msgIndex: { "-1001:900": { conv: "-1001:202", purpose: "worker-done", workerConv: "-1001:202", text: "Result", ts: Date.now() } } });
  await tg.onMessageReaction!({ chat: { id: -1001 }, message_id: 900, user: { id: 1 }, date: 0,
    old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] });
  assert.equal(sent.at(-1)?.conv, "-1001");
  assert.ok(sent.at(-1)?.text.includes("General"));
  assert.equal(removedSessions.length, 0);
  console.log("ok: reactions cannot turn a work-topic message into a lifecycle-management action");
  events!({ type: "form.created", data: { form: { id: "form-live", sessionID: "ses_2",
    fields: [{ key: "choice", type: "select", title: "Choose", options: [{ value: "a", label: "A" }] }] } } });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent.at(-1)?.conv, "-1001:202");
  await bot.handle(message("/close ses_2"));
  const beforeLateInteractions = sent.length;
  for (const sessionID of ["ses_2", "ses_legacy"]) {
    events!({ type: "form.created", data: { form: { id: `late-${sessionID}`, sessionID,
      fields: [{ key: "choice", type: "select", options: [{ value: "a", label: "A" }] }] } } });
    events!({ type: "permission.asked", data: { id: `late-perm-${sessionID}`, sessionID, action: "shell", resources: ["*"] } });
  }
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent.length, beforeLateInteractions);
  console.log("ok: questions route to their work topic; late interactions cannot resurrect a closed topic or General");
  cfg.react = false;
  st.set("-1002:1", { sessionID: "ses_legacy_general", directory: root, guided: true });
  await bot.handle({ update_id: ++update, message: { message_id: update, chat: { id: -1002, type: "supergroup", is_forum: true },
    from: { id: 1 }, text: "Existing legacy work", message_thread_id: 1, is_topic_message: true } });
  for (let i = 0; i < 20 && !promptTargets.includes("ses_legacy_general"); i++) await new Promise<void>((r) => setImmediate(r));
  assert.ok(promptTargets.includes("ses_legacy_general"));
  assert.equal(st.peek("-1002")?.sessionID, undefined);
  console.log("ok: groups not opted in keep their existing General-thread session routing");
  cfg.maxWorkers = 5;
  await bot.handle(message("Work only in this session", 203));
  for (let i = 0; i < 30 && !sent.some((item) => item.conv === "-1001:203" && item.text.includes("Result")); i++) await new Promise<void>((r) => setImmediate(r));
  assert.ok(promptTargets.includes("ses_3"));
  assert.ok(sent.some((item) => item.conv === "-1001:203" && item.text.includes("Result")));
  events!({ type: "session.execution.succeeded", data: { sessionID: "ses_3" } });
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(st.peek("-1001:203")?.sessionID, "ses_3");
  assert.equal(st.peek("-1001:203")?.worker?.status, "done");
  console.log("ok: work-topic messages and replies use the fixed session; completion keeps that binding open");
  sessions.set("ses_untracked", { id: "ses_untracked", directory: root, projectID: "project", createdAt: 1000,
    source: "test", archived: false, busy: false, terminal: true });
  await bot.handle(message("/attach ses_untracked"));
  const attached = Object.values(st.sessionTopics()!.links).find((link) => link.sessionID === "ses_untracked")!;
  cfg.maxWorkers = 1;
  st.set(runTwo.binding!.conv, { worker: { ...st.peek(runTwo.binding!.conv)!.worker!, status: "running" } });
  const beforeAttachedPrompt = promptTargets.length;
  await bot.handle(message("Work in an attached session", Number(attached.conv!.split(":")[1])));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(promptTargets.length, beforeAttachedPrompt, "attached sessions share the same worker capacity");
  console.log("ok: attaching an existing session cannot bypass worker admission");
  cfg.maxWorkers = 5;
  let finishLate!: () => void;
  const delayed = new Promise<void>((resolve) => { finishLate = resolve; });
  oc.promptAndWait = async () => { await delayed; return { outcome: "succeeded", reply: "LATE-RESULT", interrupted: false, elapsedMs: 1 }; };
  await bot.handle(message("/new Delayed response"));
  const delayedLink = Object.values(st.sessionTopics()!.links).find((link) => link.title === "Delayed response")!;
  const delayedTopic = Number(delayedLink.conv!.split(":")[1]);
  await bot.handle(message("Work", delayedTopic));
  await new Promise<void>((r) => setImmediate(r));
  await bot.handle(message(`/close ${delayedLink.sessionID}`));
  const messagesAfterClose = sent.filter((item) => item.conv === delayedLink.conv).length;
  finishLate();
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent.filter((item) => item.conv === delayedLink.conv).length, messagesAfterClose);
  console.log("ok: a late prompt response cannot post into a session closed after confirmed stop");
  cfg.stream = true;
  cfg.activity = true;
  oc.listMessages = async (id) => id === delayedLink.sessionID ? [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "LATE-EVENT" }] }] : [];
  events!({ type: "session.execution.succeeded", data: { sessionID: delayedLink.sessionID } });
  events!({ type: "session.text.delta", data: { sessionID: delayedLink.sessionID, assistantMessageID: "late", delta: "Late preview ".repeat(20) } });
  events!({ type: "session.tool.input.started", data: { sessionID: delayedLink.sessionID, id: "late-tool", name: "read" } });
  events!({ type: "session.tool.called", data: { sessionID: delayedLink.sessionID, id: "late-tool", input: {} } });
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent.filter((item) => item.conv === delayedLink.conv).length, messagesAfterClose);
  console.log("ok: late execution, streaming and activity events do not resurrect closed-topic delivery");
  bot.stopScheduler();
} finally { rmSync(root, { recursive: true, force: true }); }
