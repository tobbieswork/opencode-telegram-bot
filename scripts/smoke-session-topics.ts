import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { OpenCodeCtl } from "../src/opencode.js";
import { SessionTopics, type SessionTopicPorts } from "../src/session-topics.js";
import { StateManager } from "../src/state.js";

// OpenCode is real; Telegram is isolated. No prompts, polling, or service starts.
mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode/smoke-session-topics-")));
const endpoint = await Service.discover();
assert.ok(endpoint, "Start the OpenCode service explicitly before this check.");
const auth = Service.headers(endpoint)?.authorization;
let user: string | undefined;
let password: string | undefined;
if (auth) {
  assert.ok(auth.startsWith("Basic "), "Unsupported discovery authentication; no service changes performed.");
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  assert.ok(separator >= 0);
  user = decoded.slice(0, separator);
  password = decoded.slice(separator + 1);
}
const oc = new OpenCodeCtl();
await oc.connect(endpoint.url, user, password);
let sessionID: string | undefined;
let failClose = true;
const titleEdits: string[] = [];
const titleOwners: SessionTopics[] = [];
const ports: SessionTopicPorts = {
  createSession: async (input) => { sessionID = await oc.createTopicSession(input); return sessionID; },
  session: (id) => oc.topicSession(id), archive: (id, archived) => oc.archiveSession(id, archived),
  sessionTitle: id => oc.topicSessionTitle(id),
  renameTopic: async (_conv, name) => { titleEdits.push(name); },
  createTopic: async () => 101,
  closeTopic: async () => { if (failClose) throw new Error("Isolated Telegram outage"); },
  openTopic: async () => {}, stop: async (link) => {
    const snapshot = await oc.topicSession(link.sessionID!);
    return !snapshot.busy && snapshot.terminal;
  },
};
try {
  const file = join(root, "state.json");
  const first = new SessionTopics(new StateManager(file), ports);
  titleOwners.push(first);
  first.enable("-1001");
  const link = await first.create({ chat: "-1001", directory: root, title: "Session/topic compatibility probe", operationID: "live-empty-session" });
  const listed = (await oc.listSessions()).find((session) => session.id === link.sessionID);
  assert.ok(listed, "Phiên vừa tạo phải có trong danh sách OpenCode.");
  assert.equal(listed.directory, root);
  assert.equal(listed.title, link.title);
  assert.equal(listed.archived, false);
  assert.equal((await oc.topicSession(link.sessionID!)).title, link.title);
  assert.equal(first.canPrompt(link.conv!), true);
  assert.equal((await oc.topicSessionTitle(link.sessionID!)).title, link.title);
  assert.equal(titleEdits.length, 0, "Chưa xác nhận chính sách thì không đổi tên.");
  first.enableTitleSync("-1001");
  let connected = false;
  let renamedEvent = false;
  oc.subscribeEvents(event => {
    if (event.type === "session.renamed" && event.data?.sessionID === link.sessionID) {
      renamedEvent = true;
      first.requestTitleSync(link.sessionID);
    }
  }, undefined, () => { connected = true; });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(check(), "Hết thời gian chờ sự kiện/đồng bộ tiêu đề thật.");
  };
  await waitFor(() => connected);
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await client.session.update({ sessionID: link.sessionID!, title: "Đồng bộ tên phiên thử nghiệm" });
  await waitFor(() => renamedEvent && titleEdits.includes("Đồng bộ tên phiên thử nghiệm"));
  assert.equal(first.get(link.id)?.title, "Đồng bộ tên phiên thử nghiệm");
  assert.equal(first.canPrompt(link.conv!), true);
  first.stopTitleSync();
  const pending = await first.close("-1001", link.id);
  assert.equal(pending.phase, "closing");
  assert.equal((await oc.topicSession(link.sessionID!)).archived, true);
  failClose = false;
  const restarted = new SessionTopics(new StateManager(file), ports);
  titleOwners.push(restarted);
  assert.equal(restarted.titleSyncEnabled("-1001"), true);
  await restarted.reconcile();
  assert.equal(restarted.get(link.id)?.phase, "closed");
  const restored = await restarted.restore("-1001", link.id);
  assert.equal(restored.phase, "open");
  assert.equal(restored.sessionID, link.sessionID);
  assert.equal(restored.conv, link.conv);
  const snapshot = await oc.topicSession(link.sessionID!);
  assert.equal(snapshot.archived, false);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.terminal, true);
  await oc.removeSession(link.sessionID!);
  sessionID = undefined;
  await restarted.reconcile();
  assert.equal(restarted.get(link.id)?.phase, "missing");
  console.log("PASS: real OpenCode create/archive/restore/delete, partial close and bot-state restart; no LLM prompts.");
  console.log("Đạt: metadata nhẹ, sự kiện V2 session.renamed thật và đồng bộ tên sau xác nhận; chính sách tồn tại qua khởi động lại.");
  console.log("Telegram transport contract is tested offline; no real Telegram topic was changed.");
  console.log("Fixture:", root);
} finally {
  for (const owner of titleOwners) owner.stopTitleSync();
  if (sessionID) {
    const own = await oc.topicSession(sessionID).catch(() => undefined);
    if (own?.directory === root && own.terminal && !own.busy) await oc.removeSession(sessionID);
    else console.warn("Unconfirmed fixture retained for inspection:", sessionID);
  }
  oc.stopEvents();
}
