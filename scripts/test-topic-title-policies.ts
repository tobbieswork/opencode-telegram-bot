import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../src/state.js";
import { SessionTopics } from "../src/session-topics.js";
import { workflowFixture, deferred } from "./fixtures/workflow.js";

const root = mkdtempSync(join(tmpdir(), "title-policies-"));
const fixture = workflowFixture();
fixture.topics.titleRetryAt = { "-1001": fixture.now + 200 };
const file = join(root, "state.json");
const st = new StateManager(file);
for (const [conv, state] of Object.entries(fixture.states)) st.set(conv, state);
st.commitSessionTopics(fixture.topics);
let now = fixture.now;
let titleRead: (() => Promise<void>) | undefined;
const writes: string[] = [];
const forbidden = async (): Promise<never> => { throw new Error("Chính sách tên không đổi vòng đời"); };
const ports = { createSession: forbidden, session: forbidden, createTopic: forbidden, archive: forbidden,
  closeTopic: forbidden, openTopic: forbidden, stop: forbidden, now: () => now,
  sessionTitle: async (id: string) => { await titleRead?.(); return { ...fixture.sessions[id], title: "Tên từ OpenCode" }; },
  renameTopic: async (_conv: string, title: string) => { writes.push(title); } };
const topics = new SessionTopics(st, ports);
try {
  const id = "0000000000000001";
  const before = topics.get(id)!;
  assert.equal(topics.titleSyncEnabled("-1001"), true);
  assert.equal(topics.titlePolicy("-1001", id).mode, "follow");
  assert.equal(topics.followsOpenCode("-1001", id), true);
  assert.equal(st.sessionTopics()?.titlePolicies, undefined, "Đọc dữ liệu cũ không tự nâng hoặc bật chính sách");
  topics.setTitlePolicy("-1001", id, { mode: "keep" });
  assert.equal(topics.titleSyncEnabled("-1001"), true);
  assert.equal(topics.followsOpenCode("-1001", id), false);
  assert.deepEqual(st.sessionTopics()?.titleSyncGroups, {}, "Bản mã cũ phải nhìn thấy tự đồng bộ đã tắt khi có chính sách mới");
  assert.equal(st.sessionTopics()?.titleRetryAt?.["-1001"], fixture.now + 200, "Nâng dữ liệu không bỏ thời gian chờ Telegram");
  assert.equal((await topics.syncTitle("-1001", id)).status, "disabled");
  assert.equal(writes.length, 0);
  assert.equal(topics.canPrompt(before.conv!), true);
  topics.setTitlePolicy("-1001", id, { mode: "custom", customName: "  Tên riêng  " });
  assert.equal(topics.titlePolicy("-1001", id).customName, "Tên riêng");
  assert.equal(topics.followsOpenCode("-1001", id), false);
  topics.setTitlePolicy("-1001", id, { mode: "follow" });
  assert.equal(topics.followsOpenCode("-1001", id), true);
  topics.setTitleGroupSync("-1001", false);
  assert.equal(topics.followsOpenCode("-1001", id), false);
  topics.setTitleGroupSync("-1001", true);
  assert.equal(topics.followsOpenCode("-1001", id), true);
  for (const enabled of [false, true]) {
    topics.setTitleGroupSync("-1001", enabled);
    for (const mode of ["follow", "keep", "custom"] as const) {
      topics.setTitlePolicy("-1001", id, { mode, ...(mode === "custom" ? { customName: "Tên riêng" } : {}) });
      assert.equal(topics.followsOpenCode("-1001", id), enabled && mode === "follow");
      const revision = topics.titlePolicy("-1001", id).revision;
      topics.setTitlePolicy("-1001", id, { mode, ...(mode === "custom" ? { customName: "Tên riêng" } : {}) });
      assert.equal(topics.titlePolicy("-1001", id).revision, revision, "Bấm lặp cùng chính sách không sinh mốc mới");
    }
  }
  topics.setTitlePolicy("-1001", id, { mode: "follow" });
  assert.equal(topics.titleSyncEnabled("-1002"), false);
  now += 300;
  await topics.syncTitle("-1001", id);
  assert.deepEqual(writes, ["Tên từ OpenCode"]);
  const restored = new SessionTopics(new StateManager(file), ports);
  assert.equal(restored.titleSyncEnabled("-1001"), true);
  assert.equal(restored.titlePolicy("-1001", id).mode, "follow");
  assert.equal(restored.get(id)?.sessionID, before.sessionID);
  assert.equal(restored.get(id)?.conv, before.conv);
  assert.equal(restored.get(id)?.phase, before.phase);
  assert.throws(() => topics.setTitlePolicy("-1002", id, { mode: "keep" }));
  assert.throws(() => topics.setTitleGroupSync("-1001:200", false));

  now += 2000;
  const started = deferred<void>();
  const finish = deferred<void>();
  titleRead = async () => { started.resolve(); await finish.promise; };
  const pending = topics.syncTitle("-1001", id, true);
  await started.promise;
  assert.equal(topics.canPrompt(before.conv!), true);
  topics.setTitlePolicy("-1001", id, { mode: "keep" });
  finish.resolve();
  assert.equal((await pending).status, "disabled");
  assert.equal(writes.length, 1, "Đổi chính sách trong lúc đọc chặn công việc cũ trước khi ghi Telegram");
  assert.equal(topics.titlePolicy("-1001", id).mode, "keep");
  topics.setTitlePolicy("-1001", id, { mode: "follow" });
  now += 2000;
  const queuedStart = deferred<void>();
  const queuedEnd = deferred<void>();
  let queuedReads = 0;
  titleRead = async () => { queuedReads++; queuedStart.resolve(); await queuedEnd.promise; };
  const first = topics.syncTitle("-1001", id, true);
  await queuedStart.promise;
  const second = topics.syncTitle("-1001", "0000000000000002", true);
  topics.setTitleGroupSync("-1001", false);
  topics.setTitleGroupSync("-1001", true);
  queuedEnd.resolve();
  assert.equal((await first).status, "disabled");
  assert.equal((await second).status, "disabled");
  assert.equal(queuedReads, 1, "Công việc đã xếp hàng trước khi tắt/bật không được đọc lại rồi ghi dưới mốc mới");
  assert.equal(writes.length, 1);
  console.log("Đạt: chính sách nhóm/chủ đề, dữ liệu cũ, mặc định, khởi động lại, quay về mã cũ an toàn và chặn thao tác lỗi thời.");

  const invalidFile = join(root, "invalid.json");
  const data = st.sessionTopics()!;
  const badRaw = JSON.stringify({ __machine__: { sessionTopics: { ...data, titlePolicies: { version: 99, groups: {} } } } });
  writeFileSync(invalidFile, badRaw);
  const bad = new SessionTopics(new StateManager(invalidFile), ports);
  assert.throws(() => bad.setTitleGroupSync("-1001", true), /chính sách/);
  assert.equal(readFileSync(invalidFile, "utf8"), badRaw);
  assert.equal(writes.length, 1);
  const blocked = new StateManager(join(root, "disk", "state.json"));
  blocked.set(before.conv!, { sessionID: before.sessionID });
  blocked.commitSessionTopics({ version: 1, groups: { "-1001": true }, links: { [id]: before }, titleSyncGroups: { "-1001": true } });
  renameSync(join(root, "disk"), join(root, "disk-backup"));
  writeFileSync(join(root, "disk"), "Không phải thư mục");
  const disk = new SessionTopics(blocked, ports);
  assert.throws(() => disk.setTitlePolicy("-1001", id, { mode: "keep" }));
  assert.equal(disk.titlePolicy("-1001", id).mode, "follow");
  assert.equal(disk.titleSyncEnabled("-1001"), true);
  assert.equal(writes.length, 1);
  disk.stopTitleSync();
  restored.stopTitleSync();
} finally { topics.stopTitleSync(); rmSync(root, { recursive: true, force: true }); }
