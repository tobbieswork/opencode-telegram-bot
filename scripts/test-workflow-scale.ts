import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StateManager, MACHINE_STATE_KEY, type ChatState } from "../src/state.js";
import { SessionTopics } from "../src/session-topics.js";
import { SessionDashboard, dashboardPage } from "../src/session-dashboard.js";
import { SessionPins, pinBinding } from "../src/session-pins.js";
import { searchManaged } from "../src/session-search.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
const data = structuredClone(f.fixture.topics);
const template = structuredClone(data.links["0000000000000001"]);
data.links = {}; data.groups = { "-1001": true };
const states: Record<string, ChatState> = {};
for (let n = 0; n < 1000; n++) {
  const id = (n + 1).toString(16).padStart(16, "0"), conv = `-1001:${1000 + n}`, sessionID = `ses_scale_${n}`;
  data.links[id] = { ...template, id, conv, sessionID, title: `Đăng nhập ${n}`, operationID: `scale-${n}`, phase: "open", configured: true };
  states[conv] = { sessionID, directory: template.directory };
}
states[MACHINE_STATE_KEY] = { sessionTopics: data };
states["-1001"] = { sessionPins: { version: 1, chat: "-1001", users: { "1": { revision: 1, entries: Object.values(data.links).slice(0, 20).map(link => ({ id: link.id, binding: pinBinding(link) })) } } } };
const file = join(f.root, "scale.json");
writeFileSync(file, JSON.stringify(states));
const before = readFileSync(file);
const store = new StateManager(file);
const forbidden = async (): Promise<never> => { throw new Error("Đọc nhiều phiên không được tạo/chạy/thay tài nguyên"); };
const topics = new SessionTopics(store, { createSession: forbidden, session: forbidden, createTopic: forbidden, archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden });
let reads = 0, active = 0, peak = 0;
const dashboard = new SessionDashboard({ store, topics, observe: async id => {
  reads++; active++; peak = Math.max(peak, active);
  try {
    await new Promise(resolve => setTimeout(resolve, 1));
    return { info: { ...f.observations.get("ses_fixture_0")!.info, id }, work: "idle", forms: [], permissions: [] };
  } finally { active--; }
} });
try {
  const started = performance.now();
  let rows = await dashboard.read("-1001");
  const readMs = performance.now() - started;
  assert.equal(rows.length, 1000); assert.equal(reads, 0);
  const pinStart = performance.now();
  const pins = new SessionPins(store, topics).ids("-1001", 1);
  assert.equal(pins.size, 20);
  const result = searchManaged("-1001", rows, "dang nhap", "all", 5, false, pins);
  assert.equal(result.total, 1000); assert.equal(result.rows.length, 10);
  assert.equal(dashboardPage(rows, "pinned", 0, pins).rows.length, 10);
  const searchMs = performance.now() - pinStart;
  rows = await dashboard.read("-1001", { refresh: true, ids: result.rows.map(row => row.id) });
  assert.equal(reads, 10, "Làm mới chỉ đọc 10 phiên đang xem, không đọc mọi phiên");
  assert.ok(peak <= 2, "Tối đa hai lời đọc nguồn đồng thời");
  await dashboard.read("-1001", { refresh: true, ids: result.rows.map(row => row.id) });
  assert.equal(reads, 10, "Làm mới thường giữ bộ nhớ tạm");
  assert.deepEqual(readFileSync(file), before, "Chiếu/tìm/đọc ghim không đổi trạng thái nguồn");
  assert.ok(readMs < 5000 && searchMs < 5000, "Không chặn giao diện nhiều giây với 1000 phiên cục bộ");
  console.log(JSON.stringify({ dat: true, soPhien: rows.length, docCucBoMs: Math.round(readMs), timVaGhimMs: Math.round(searchMs), docNguon: reads, dongThoiToiDa: peak, hangMoiTrang: result.rows.length }));
} finally { topics.stopTitleSync(); f.dispose(); }
