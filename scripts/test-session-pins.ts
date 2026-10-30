import assert from "node:assert/strict";
import { SessionPins } from "../src/session-pins.js";
import { SessionTopics } from "../src/session-topics.js";
import { StateManager } from "../src/state.js";
import { searchManaged } from "../src/session-search.js";
import { SessionDashboard, dashboardPage } from "../src/session-dashboard.js";
import { workflowBot } from "./fixtures/bot-workflow.js";

const f = workflowBot();
const forbidden = async (): Promise<never> => { throw new Error("Ghim không được thay đổi tài nguyên"); };
const ports = { createSession: forbidden, session: forbidden, createTopic: forbidden, archive: forbidden, closeTopic: forbidden, openTopic: forbidden, stop: forbidden };
const topics = new SessionTopics(f.st, ports);
const pins = new SessionPins(f.st, topics);
try {
  const id = "0000000000000001";
  pins.set("-1001", 1, id, true, 0);
  pins.set("-1001", 1, id, true, 0);
  assert.equal(pins.user("-1001", 1).revision, 1);
  assert.equal(pins.user("-1001", 2).entries.length, 0);
  assert.throws(() => pins.set("-1002", 1, id, true, 0));
  const data = f.st.sessionTopics()!;
  data.links[id].title = "Tên mới <an toàn>";
  data.links[id].phase = "closed";
  f.st.commitSessionTopics(data);
  assert.ok(pins.ids("-1001", 1).has(id));
  data.links[id].phase = "open"; f.st.commitSessionTopics(data);
  assert.ok(pins.ids("-1001", 1).has(id));
  data.links[id].phase = "closed"; f.st.commitSessionTopics(data);
  const restarted = new SessionPins(new StateManager(f.cfg.stateFile), topics);
  assert.ok(restarted.ids("-1001", 1).has(id));
  const rows = await new SessionDashboard({ store: f.st, topics, observe: async key => f.observations.get(key)! }).read("-1001");
  assert.equal(dashboardPage(rows, "pinned", 0, pins.ids("-1001", 1)).rows[0].lifecycle, "closed");
  assert.equal(searchManaged("-1001", rows, "khong khop", "all", 0, true, pins.ids("-1001", 1)).total, 0);
  assert.equal(searchManaged("-1001", rows, "ten moi", "closed", 0, true, pins.ids("-1001", 1), true).total, 1);

  await f.bot.handle(f.tap(`pin:open:${id}`));
  const remove = f.buttons().find(button => button.callback_data?.startsWith("pin:set:"))!.callback_data!;
  await f.bot.handle(f.tap(remove, 2)); assert.equal(pins.user("-1001", 1).entries.length, 1);
  await Promise.all([f.bot.handle(f.tap(remove)), f.bot.handle(f.tap(remove))]);
  assert.equal(pins.user("-1001", 1).entries.length, 0);
  assert.equal(f.st.sessionTopics()!.links[id].phase, "closed");

  for (let n = 0; n < 21; n++) {
    const next = (100 + n).toString(16).padStart(16, "0");
    const link = { ...data.links[id], id: next, operationID: `pin-${n}`, conv: `-1001:${300 + n}`, sessionID: `ses_pin_${n}` };
    const current = f.st.sessionTopics()!; current.links[next] = link;
    f.st.setRequired(link.conv, { sessionID: link.sessionID, directory: link.directory }); f.st.commitSessionTopics(current);
    if (n < 20) pins.set("-1001", 1, next, true, pins.user("-1001", 1).revision);
    else assert.throws(() => pins.set("-1001", 1, next, true, pins.user("-1001", 1).revision), /20/);
  }
  assert.equal(pins.user("-1001", 1).entries.length, 20);
  const first = pins.user("-1001", 1).entries[0].id;
  const changed = f.st.sessionTopics()!; changed.links[first].chat = "-1002"; changed.links[first].conv = "-1002:900";
  f.st.setRequired("-1002:900", { sessionID: changed.links[first].sessionID, directory: changed.links[first].directory });
  f.st.setRequired("-1001:300", { sessionID: undefined }); f.st.commitSessionTopics(changed);
  const unavailable = pins.list("-1001", 1).find(entry => entry.id === first)!;
  assert.equal(unavailable.available, false); assert.equal(unavailable.link, undefined);
  await f.bot.handle(f.tap("pin:list"));
  assert.ok(f.sent.at(-1)!.text.includes("Không khả dụng"));
  pins.set("-1001", 1, first, false, pins.user("-1001", 1).revision);
  assert.equal(pins.user("-1001", 1).entries.length, 19);
  const save = f.st.setRequired.bind(f.st);
  f.st.setRequired = () => { throw new Error("Lỗi lưu ghim"); };
  const target = pins.user("-1001", 1).entries[0].id;
  assert.throws(() => pins.set("-1001", 1, target, false, pins.user("-1001", 1).revision));
  f.st.setRequired = save;
  assert.equal(pins.user("-1001", 1).entries.length, 19);
  const bad = f.st.peek("-1001")!.sessionPins!;
  bad.users["2"] = { revision: 0, entries: [{ id: "constructor", binding: "" }] };
  f.st.setRequired("-1001", { sessionPins: bad });
  await f.bot.handle(f.tap("pin:list", 2));
  assert.ok(f.sent.at(-1)!.text.includes("Không khả dụng"));
  const removeBad = f.buttons().find(button => button.callback_data?.startsWith("pin:set:"))!.callback_data!;
  await f.bot.handle(f.tap(removeBad, 2));
  assert.equal(pins.user("-1001", 2).entries.length, 0, "Ghim sai mã vẫn bỏ được mà không đọc nhầm thuộc tính đối tượng");
  assert.equal(f.effects.length, 0);
  console.log("Đạt: ghim đúng người/nhóm, lặp đồng thời không đảo trạng thái, giới hạn 20, đổi tên/đóng/khởi động giữ ghim, mất sở hữu không lộ dữ liệu, lỗi lưu không mất ghim.");
} finally { topics.stopTitleSync(); f.dispose(); }
