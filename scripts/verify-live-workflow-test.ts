import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { OpenCodeCtl } from "../src/opencode.js";
import { loadConfig, loadDotEnv } from "../src/config.js";

// Chỉ xem theo mặc định. Cờ đổi tên chỉ dành cho đúng phiên thử CV15 đã được cho phép.
loadDotEnv();
const cfg = loadConfig(resolve("."));
const id = process.argv[2];
assert.match(id ?? "", /^[a-f0-9]{16}$/);
const state = () => JSON.parse(readFileSync(cfg.stateFile, "utf8"));
const initial = state();
const link = initial.__machine__?.sessionTopics?.links?.[id];
assert.ok(link?.sessionID && link.conv && link.identity && link.title?.startsWith("CV15"), "Chỉ chấp nhận liên kết thử CV15 xác định rõ.");
assert.equal(initial[link.conv]?.sessionID, link.sessionID);
const endpoint = cfg.opencodeServiceUrl ? undefined : await Service.discover();
assert.ok(cfg.opencodeServiceUrl || endpoint, "Dịch vụ phải đang chạy; công cụ không tự mở dịch vụ khác.");
const headers = cfg.opencodeServiceUrl ? (cfg.opencodeServiceUser && cfg.opencodeServicePassword ? {
  authorization: `Basic ${Buffer.from(`${cfg.opencodeServiceUser}:${cfg.opencodeServicePassword}`).toString("base64")}`,
} : {}) : Service.headers(endpoint!);
const oc = new OpenCodeCtl();
const connection = await oc.connect(cfg.opencodeServiceUrl, cfg.opencodeServiceUser, cfg.opencodeServicePassword, { allowStart: false });
const matches = (info: Awaited<ReturnType<typeof oc.topicSession>>) => info.id === link.sessionID && info.projectID === link.identity.projectID && info.source === link.identity.source && info.createdAt === link.identity.createdAt;
let restore: (() => Promise<void>) | undefined;
try {
  const info = await oc.topicSession(link.sessionID);
  assert.ok(matches(info));
  const [forms, permissions] = await Promise.all([oc.listForms(link.sessionID, AbortSignal.timeout(3000)), oc.listPermissions(link.sessionID, AbortSignal.timeout(3000))]);
  let renamedEvent = false;
  if (process.argv.includes("--rename-opencode")) {
    assert.equal(link.phase, "open"); assert.equal(link.titlePolicy?.mode, "custom"); assert.equal(link.titleSync?.pending, false);
    assert.equal(info.busy, false); assert.equal(info.terminal, true); assert.equal(forms.length + permissions.length, 0);
    assert.ok(info.title);
    const client = OpenCode.make({ baseUrl: connection.url, headers });
    let connected = false;
    oc.subscribeEvents(event => { if (event.type === "session.renamed" && event.data?.sessionID === link.sessionID) renamedEvent = true; }, undefined, () => { connected = true; });
    const until = async (check: () => boolean) => {
      const end = Date.now() + 10_000;
      while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(check(), "Chưa nhận được sự kiện nguồn thật.");
    };
    await until(() => connected);
    restore = async () => {
      assert.ok(matches(await oc.topicSession(link.sessionID)), "Không khôi phục metadata nếu danh tính đã thay đổi.");
      await client.session.update({ sessionID: link.sessionID, title: info.title }, { signal: AbortSignal.timeout(5000) });
    };
    await client.session.update({ sessionID: link.sessionID, title: "CV15 kiểm tra tên nguồn OpenCode" }, { signal: AbortSignal.timeout(5000) });
    await until(() => renamedEvent);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const current = state().__machine__.sessionTopics.links[id];
    assert.equal(current.title, link.title, "Tên riêng không bị sự kiện tên nguồn ghi đè");
    assert.deepEqual(current.titlePolicy, link.titlePolicy);
    await restore(); restore = undefined;
  }
  const current = state();
  const pins = Object.values(current[link.chat]?.sessionPins?.users ?? {}).filter((value: any) => value.entries?.some((entry: any) => entry.id === id)).length;
  console.log(JSON.stringify({ dat: true, linkID: id, phase: current.__machine__.sessionTopics.links[id].phase, dangChoNguon: forms.length + permissions.length,
    ketQua: current[link.conv]?.sessionActivity?.result?.snippet, soDanhSachGhim: pins, suKienDoiTenThat: renamedEvent, khongGuiYeuCauMoHinh: true }));
} finally { if (restore) await restore(); oc.stopEvents(); }
