import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../../src/bot.js";
import { loadConfig } from "../../src/config.js";
import { StateManager } from "../../src/state.js";
import type { Telegram, Update } from "../../src/telegram.js";
import type { OpenCodeCtl } from "../../src/opencode.js";
import type { DashboardObservation } from "../../src/session-dashboard.js";
import { workflowFixture } from "./workflow.js";

export function workflowBot() {
  const root = mkdtempSync(join(tmpdir(), "bot-workflow-"));
  const fixture = workflowFixture();
  const st = new StateManager(join(root, "state.json"));
  for (const [conv, state] of Object.entries(fixture.states)) st.set(conv, state);
  st.commitSessionTopics(fixture.topics);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1,2";
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    schedule: false, remind: false, activity: false, working: false, stream: false, react: false,
    uptimeMonitor: false, prWatch: false };
  const sent: Array<{ conv: string; text: string; opts?: any }> = [];
  const answers: string[] = [];
  const effects: string[] = [];
  const observations = new Map<string, DashboardObservation>();
  const reads: string[] = [];
  for (const [id, info] of Object.entries(fixture.sessions)) {
    const link = Object.values(fixture.topics.links).find(link => link.sessionID === id)!;
    const prompts = fixture.states[link.conv!].pendingPrompts ?? {};
    observations.set(id, { info, work: info.busy ? "running" : "idle",
      forms: Object.entries(prompts).filter(([, value]) => value.kind === "form").map(([key]) => key),
      permissions: Object.entries(prompts).filter(([, value]) => value.kind === "permission").map(([key]) => key) });
  }
  const record = async (conv: string, text: string, opts?: any) => { sent.push({ conv, text, opts }); return sent.length; };
  const forbidden = async () => { effects.push("thay đổi tài nguyên"); throw new Error("Không được đổi tài nguyên khi đọc"); };
  const tg = { sendMessage: record, sendMessageId: record,
    editMessageText: async (conv: string, _id: number, text: string, opts?: any) => { await record(conv, text, opts); },
    answerCallbackQuery: async (_id: string, text?: string) => { if (text) answers.push(text); },
    setMyCommands: async () => {}, createForumTopic: forbidden, editForumTopic: forbidden,
    closeForumTopic: forbidden, openForumTopic: forbidden } as unknown as Telegram;
  const oc = { dashboardObservation: async (id: string) => { reads.push(id); return structuredClone(observations.get(id)!); },
    listForms: async (id: string) => {
      const forms = observations.get(id)?.forms;
      if (!forms) throw new Error("Chưa xác minh câu hỏi");
      return forms.map(form => ({ id: form, sessionID: id, fields: [{ key: "pick", type: "string", title: "Chọn",
        options: [{ label: "Một", value: "one" }], custom: true }] }));
    },
    listPermissions: async (id: string) => {
      const permissions = observations.get(id)?.permissions;
      if (!permissions) throw new Error("Chưa xác minh quyền");
      return permissions.map(permission => ({ id: permission, sessionID: id, action: "edit", resources: ["a.txt"] }));
    },
    replyForm: forbidden, cancelForm: forbidden, replyPermission: forbidden,
    listSessions: async () => [], createTopicSession: forbidden, promptAndWait: forbidden,
    archiveSession: forbidden, interruptTopicSession: forbidden } as unknown as OpenCodeCtl;
  const bot = new Bot(tg, oc, st, cfg);
  let update = 0;
  const message = (text: string, user = 1, chat = -1001): Update => ({ update_id: ++update,
    message: { message_id: update, chat: { id: chat, type: "supergroup", is_forum: true }, from: { id: user }, text } });
  const tap = (data: string, user = 1, chat = -1001, topic?: number): Update => ({ update_id: ++update,
    callback_query: { id: `cb-${update}`, data, from: { id: user }, message: { message_id: update,
      chat: { id: chat }, ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } } });
  const buttons = () => (sent.at(-1)?.opts?.reply_markup?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data?: string; url?: string }>;
  return { root, fixture, bot, st, sent, answers, effects, observations, reads, cfg, tg, oc,
    message, tap, buttons, dispose: () => { bot.stopScheduler(); rmSync(root, { recursive: true, force: true }); } };
}
