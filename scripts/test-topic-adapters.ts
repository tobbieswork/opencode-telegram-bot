import assert from "node:assert/strict";
import { Telegram } from "../src/telegram.js";
import { createServer } from "node:http";
import { OpenCodeCtl } from "../src/opencode.js";

const originalFetch = globalThis.fetch;
const methods: string[] = [];
let failure = "";
let manageTopics = false;
let requireDeadline = false;
globalThis.fetch = async (input, init) => {
  const method = String(input).split("/").at(-1)!;
  methods.push(method);
  if (requireDeadline && !init?.signal) throw new Error("Lifecycle operation has no bounded deadline");
  const result = method === "getMe" ? { id: 1 } : method === "getChat" ? { type: "supergroup", is_forum: true } :
    method === "getChatMember" ? { status: "administrator", can_manage_topics: manageTopics } :
    method === "createForumTopic" ? { message_thread_id: 101 } : true;
  return new Response(JSON.stringify(failure ? { ok: false, error_code: 400, description: failure } : { ok: true, result }),
    { status: failure ? 400 : 200, headers: { "content-type": "application/json" } });
};
try {
  const tg = new Telegram("test-token");
  await tg.openForumTopic("-1001:101");
  assert.equal(methods.at(-1), "reopenForumTopic");
  failure = "Bad Request: not enough rights";
  await assert.rejects(tg.closeForumTopic("-1001:101"), /not enough rights/);
  await assert.rejects(tg.openForumTopic("-1001:101"), /not enough rights/);
  failure = "Bad Request: TOPIC_NOT_MODIFIED";
  await tg.closeForumTopic("-1001:101");
  await tg.openForumTopic("-1001:101");
  console.log("ok: official reopen method; only idempotent no-op errors count as success");
  failure = "";
  await assert.rejects(tg.assertForumManagement(-1001), /Manage Topics/);
  manageTopics = true;
  await tg.assertForumManagement(-1001);
  console.log("ok: setup verifies forum type and the bot's actual management rights");
  requireDeadline = true;
  assert.equal(await tg.createForumTopic(-1001, "Deadline fixture"), 101);
  await tg.closeForumTopic("-1001:101");
  await tg.openForumTopic("-1001:101");
  console.log("ok: lifecycle requests have bounded deadlines, never leave creation pending forever");
} finally { globalThis.fetch = originalFetch; }

let archived = false;
let running = false;
let creates = 0;
let dropped = false;
const requests: string[] = [];
let prompted = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://test").pathname;
  requests.push(path);
  const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (path === "/api/info") return json({ version: "2.1.4", pid: 1, urls: [], paths: {} });
  if (path === "/api/session" && req.method === "GET") return json({ data: [{ id: "ses_topic", title: "Phiên gốc", parentID: "ses_parent",
    location: { directory: process.cwd() }, time: { created: 1, updated: 3, archived: 10 } }] });
  if (path === "/api/session" && req.method === "POST") {
    creates++;
    req.socket.destroy();
    return;
  }
  if (path === "/api/session/active") return json({ data: running ? { ses_topic: { started: 3 } } : {} });
  if (path === "/api/session/ses_topic/inbox") return json({ data: [] });
  if (path === "/api/session/ses_topic/form" || path === "/api/session/ses_topic/permission") return json({ data: [] });
  if (path === "/api/session/ses_topic/prompt") { prompted = true; return json({ data: { id: "input_own" } }); }
  if (path === "/api/experimental/session/ses_topic/wait") { res.statusCode = 204; res.end(); return; }
  if (path === "/api/session/ses_topic/message" && prompted) return json({ data: [
    { id: "idle_other", type: "idle", outcome: "failed", time: { created: 6 } },
    { id: "input_other", type: "user", text: "Yêu cầu khác", time: { created: 5 } },
    { id: "idle_own", type: "idle", outcome: "succeeded", time: { created: 4 } },
    { id: "reply_own", type: "assistant", content: [{ type: "text", text: "Kết quả đúng đầu vào" }], time: { created: 3 } },
    { id: "input_own", type: "user", text: "Yêu cầu gốc", time: { created: 2 } },
  ] });
  if (path === "/api/session/ses_topic/message") return json({ data: dropped ? [] : [
    { id: "msg_user", type: "user", time: { created: 2 }, text: "test" },
    { id: "msg_idle", type: "idle", time: { created: 3 }, outcome: "succeeded" },
  ] });
  if (path === "/api/session/ses_topic" && req.method === "PATCH") {
    let body = ""; for await (const chunk of req) body += chunk;
    archived = JSON.parse(body).archived;
    res.statusCode = 204; res.end(); return;
  }
  if (path === "/api/session/ses_topic") return json({ data: { id: "ses_topic", title: "Phiên gốc", projectID: "project", location: { directory: process.cwd() },
    time: { created: 1, updated: archived ? 10 : 3, idle: 3, ...(archived ? { archived: 10 } : {}) }, outcome: "succeeded" } });
  res.statusCode = 404; json({ message: "Unexpected test route" });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const oc = new OpenCodeCtl(); await oc.connect(`http://127.0.0.1:${address.port}`);
  assert.deepEqual(await oc.listSessions(), [{ id: "ses_topic", title: "Phiên gốc", parentID: "ses_parent", directory: process.cwd(), updated: 3, archived: true }]);
  assert.equal((await oc.topicSession("ses_topic")).title, "Phiên gốc");
  assert.equal((await oc.topicSession("ses_topic")).terminal, true);
  const beforeTitle = requests.length;
  const title = await oc.topicSessionTitle("ses_topic");
  assert.equal(title.id, "ses_topic");
  assert.equal(title.title, "Phiên gốc");
  assert.equal(title.projectID, "project");
  assert.deepEqual(requests.slice(beforeTitle), ["/api/session/ses_topic"], "Đọc tiêu đề chỉ lấy metadata, không tải lịch sử hoặc trạng thái thực thi");
  const beforeDashboard = requests.length;
  const observation = await oc.dashboardObservation("ses_topic", AbortSignal.timeout(1000));
  assert.equal(observation.info.id, "ses_topic");
  assert.equal(observation.work, "done");
  assert.deepEqual(observation.forms, []);
  assert.deepEqual(observation.permissions, []);
  assert.equal(requests.slice(beforeDashboard).length, 4);
  assert.ok(!requests.slice(beforeDashboard).some(path => /message|interrupt|prompt/.test(path)));
  const result = await oc.promptAndWait("ses_topic", "Yêu cầu gốc", { messageID: "input_own" });
  assert.equal(result.replyID, "reply_own");
  assert.equal(result.replyInputID, "input_own");
  assert.equal(result.replyOutcome, "succeeded", "Không lấy kết quả của đầu vào mới hơn để gán cho phản hồi cũ");
  const snapshotStart = requests.length;
  const activity = await oc.activitySnapshot("ses_topic", AbortSignal.timeout(1000));
  assert.equal(activity.messages[1].id, "input_other");
  assert.deepEqual(requests.slice(snapshotStart).sort(), ["/api/session/ses_topic", "/api/session/ses_topic/message"]);
  prompted = false;
  await oc.archiveSession("ses_topic", true);
  const snapshot = await oc.topicSession("ses_topic");
  assert.equal(snapshot.archived, true);
  assert.equal(snapshot.terminal, true, "metadata changes do not turn a finished session busy");
  running = true;
  assert.equal((await oc.topicSession("ses_topic")).terminal, false);
  running = false; dropped = true;
  assert.equal((await oc.topicSession("ses_topic")).terminal, true, "a never-started empty session can close");
  await assert.rejects(oc.createTopicSession({ chat: "-1001", directory: process.cwd(), title: "Test", linkID: "link" }));
  assert.equal(creates, 1, "non-idempotent session creation is not blindly retried");
  console.log("ok: real OpenCode client snapshots/archive; metadata is not execution; no create replay");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
