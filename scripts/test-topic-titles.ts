import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../src/state.js";
import { SessionTopics, type SessionTopicPorts, type TopicSession } from "../src/session-topics.js";

const root = mkdtempSync(join(tmpdir(), "topic-titles-"));
const instances: SessionTopics[] = [];
function fixture(name: string) {
  const file = join(root, name, "state.json");
  let st = new StateManager(file);
  const sessions = new Map<string, TopicSession>();
  const renamed: Array<{ conv: string; name: string }> = [];
  let now = 100_000;
  let failure: Error | undefined;
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  let lifecycleCalls = 0;
  let sid = 0;
  const ports: SessionTopicPorts = {
    createSession: async (input) => {
      const id = `ses_${++sid}`;
      sessions.set(id, { id, title: input.title, directory: root, source: "test", projectID: "p", createdAt: sid,
        archived: false, busy: false, terminal: true });
      return id;
    },
    session: async id => structuredClone(sessions.get(id)!),
    sessionTitle: async id => structuredClone(sessions.get(id)!),
    createTopic: async () => 200 + sid,
    closeTopic: async () => { lifecycleCalls++; }, openTopic: async () => { lifecycleCalls++; },
    archive: async () => { lifecycleCalls++; }, stop: async () => { lifecycleCalls++; return true; },
    renameTopic: async (conv, name) => {
      if (held) await held;
      if (failure) throw failure;
      renamed.push({ conv, name });
    }, now: () => now,
  };
  let topics = new SessionTopics(st, ports);
  instances.push(topics);
  topics.enable("-1001");
  return { sessions, renamed, ports, file, get st() { return st; }, get topics() { return topics; },
    tick: (ms = 2000) => { now += ms; }, fail: (e?: Error) => { failure = e; },
    hold: () => { held = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release?.(); held = undefined; },
    lifecycle: () => lifecycleCalls,
    reload: () => { topics.stopTitleSync(); st = new StateManager(file); topics = new SessionTopics(st, ports); instances.push(topics); },
  };
}
try {
  const f = fixture("normal");
  const link = await f.topics.create({ chat: "-1001", directory: root, title: "Tên cũ" });
  f.sessions.get(link.sessionID!)!.title = "Sửa lỗi đăng nhập";
  const preview = await f.topics.previewTitles("-1001");
  assert.equal(preview[0].before, "Tên cũ");
  assert.equal(preview[0].after, "Sửa lỗi đăng nhập");
  assert.equal(f.renamed.length, 0, "Xem trước không đổi tên và không bật chính sách");
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.length, 0, "Nhóm cũ chưa xác nhận không tự đổi tên");
  f.topics.enableTitleSync("-1001");
  await Promise.all([f.topics.syncTitle("-1001", link.id), f.topics.syncTitle("-1001", link.id)]);
  assert.deepEqual(f.renamed, [{ conv: link.conv, name: "Sửa lỗi đăng nhập" }]);
  assert.equal(f.topics.get(link.id)?.title, "Sửa lỗi đăng nhập");
  assert.equal(f.lifecycle(), 0);
  f.reload();
  assert.equal(f.topics.titleSyncEnabled("-1001"), true);
  f.tick();
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.length, 1, "Khởi động lại giữ tên đã xác nhận, không ghi trùng khi không ép đồng bộ");
  console.log("Đạt: xem trước không đổi tên; xác nhận bật theo nhóm; lưu chính sách và kết quả qua khởi động lại.");

  f.sessions.get(link.sessionID!)!.title = "  Tiếng Việt\n 👩🏽‍💻 " + "🙂".repeat(140);
  f.tick();
  await f.topics.syncTitle("-1001", link.id);
  const normalized = f.renamed.at(-1)!.name;
  assert.ok(normalized.startsWith("Tiếng Việt 👩🏽‍💻"));
  assert.ok(normalized.length <= 128);
  assert.ok(!/[\uD800-\uDBFF]$/.test(normalized));
  assert.equal(normalized, [...new Intl.Segmenter("vi", { granularity: "grapheme" }).segment(normalized)].map(x => x.segment).join(""));
  f.sessions.get(link.sessionID!)!.title = " \n ";
  f.tick();
  const beforeEmpty = f.renamed.length;
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.length, beforeEmpty);
  console.log("Đạt: chuẩn hóa khoảng trắng, tên dài, tiếng Việt và biểu tượng; tên trống không ghi đè.");

  f.sessions.get(link.sessionID!)!.title = "Tên mới nhất";
  f.tick();
  f.hold();
  const inFlight = f.topics.syncTitle("-1001", link.id);
  for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r));
  assert.equal(f.topics.canPrompt(link.conv!), true, "Đổi tên không khóa việc nhận yêu cầu");
  f.release();
  await inFlight;
  const second = await f.topics.create({ chat: "-1001", directory: root, title: "Phiên khác" });
  f.tick();
  f.fail(Object.assign(new Error("Quá giới hạn"), { code: 429, retryAfter: 20 }));
  f.sessions.get(link.sessionID!)!.title = "Tên đang chờ";
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.topics.get(link.id)?.phase, "open");
  assert.equal(f.topics.get(link.id)?.title, "Tên mới nhất");
  assert.equal(f.topics.get(link.id)?.titleSync?.pending, true);
  assert.ok(f.topics.get(link.id)?.titleSync?.retryAt);
  f.reload();
  f.fail();
  await f.topics.syncTitle("-1001", second.id, true);
  assert.equal(f.renamed.at(-1)?.name, "Tên mới nhất", "Sau khởi động lại, chủ đề khác vẫn tôn trọng retry_after của nhóm");
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.at(-1)?.name, "Tên mới nhất");
  f.tick(21_000);
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.at(-1)?.name, "Tên đang chờ");
  assert.equal(f.topics.get(link.id)?.titleSync?.error, undefined);
  console.log("Đạt: không khóa công việc; lỗi đổi tên không đổi vòng đời; giới hạn tần suất và lần thử lại được giữ sau khởi động lại.");

  f.sessions.get(link.sessionID!)!.projectID = "khac";
  f.sessions.get(link.sessionID!)!.title = "Không được áp dụng";
  f.tick();
  await f.topics.syncTitle("-1001", link.id);
  assert.equal(f.renamed.at(-1)?.name, "Tên đang chờ");
  assert.equal(f.topics.get(link.id)?.phase, "open");
  await assert.rejects(async () => f.topics.syncTitle("-1002", link.id));
  f.sessions.get(link.sessionID!)!.projectID = "p";
  const data = f.st.sessionTopics()!;
  data.links[link.id].phase = "closed";
  f.st.commitSessionTopics(data);
  f.tick(100_000);
  await f.topics.syncTitle("-1001", link.id, true);
  assert.equal(f.lifecycle(), 0, "Không mở lại chủ đề đã đóng chỉ để đổi tên");
  assert.equal(f.renamed.at(-1)?.name, "Tên đang chờ");
  console.log("Đạt: sai danh tính/nhóm không thể đổi tên; chủ đề đóng được hoãn, không mở lại hay thay phiên.");

  const brokenDisk = fixture("broken-disk");
  const diskLink = await brokenDisk.topics.create({ chat: "-1001", directory: root, title: "Tên cũ" });
  brokenDisk.topics.enableTitleSync("-1001");
  brokenDisk.sessions.get(diskLink.sessionID!)!.title = "Tên mới";
  const commit = brokenDisk.st.commitSessionTopics;
  brokenDisk.st.commitSessionTopics = () => { throw new Error("Không ghi được trạng thái"); };
  await assert.rejects(() => brokenDisk.topics.syncTitle("-1001", diskLink.id), /Không ghi được/);
  assert.equal(brokenDisk.renamed.length, 0, "Chưa lưu được ý định thì không đổi tên bên ngoài");
  brokenDisk.st.commitSessionTopics = commit;
  console.log("Đạt: lỗi lưu trạng thái chặn thao tác ngoài trước khi đổi tên.");
} finally {
  for (const topics of instances) topics.stopTitleSync?.();
  rmSync(root, { recursive: true, force: true });
}
