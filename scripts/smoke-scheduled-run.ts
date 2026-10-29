import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { OpenCodeCtl } from "../src/opencode.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StateManager } from "../src/state.js";
import { ScheduleStore } from "../src/scheduler.js";
import { ScheduledRuns } from "../src/scheduled-run.js";
import { BusyNoteStore } from "../src/notes.js";
import type { Telegram } from "../src/telegram.js";

mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode/smoke-scheduled-")));
process.env.TELEGRAM_BOT_TOKEN = "token-kiem-thu";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
  browseRoots: [root], managerDir: join(root, "manager"), maxWorkers: 1, worktreeMode: "off" as const, autoClose: false };
const oc = new OpenCodeCtl();
const st = new StateManager(cfg.stateFile);
const store = new ScheduleStore(join(root, "schedules.json"), 10);
const out: string[] = [];
const tg = { createForumTopic: async () => 9, editForumTopic: async () => {},
  closeForumTopic: async () => {}, deleteForumTopic: async () => {},
} as unknown as Telegram;
const orch = new Orchestrator({ tg, oc, st, cfg, busyNotes: new BusyNoteStore(),
  sendHtml: async (_conv, text) => { out.push(text); }, applyModelAndVariant: async () => {},
  startTyping: () => {}, startWorking: () => {}, stopWorking: () => {},
});
const runs = new ScheduledRuns({ store, execution: orch.scheduledExecution(), now: () => Date.now(),
  enabled: () => true, isAllowed: (id) => id === 1, timeoutMs: 90_000,
  notify: async (_conv, text) => { out.push(text); },
});
const marker = "SCHEDULED-PROBE-" + Date.now();
store.add({ id: "live", conv: "42", prompt: `Trả lời đúng chuỗi ${marker}. Không dùng công cụ, không hỏi thêm.`,
  dir: root, agent: "plan", spec: { kind: "daily", time: { h: 9, m: 0 } }, tz: "UTC",
  nextRunAt: Date.now() + 86_400_000, enabled: false, createdBy: 1, createdAt: Date.now() });

try {
  await oc.connect();
  console.log("=== KIỂM TRA LƯỢT CHẠY VỚI OPENCODE THẬT ===");
  console.log("Dữ liệu kiểm thử:", root);
  const result = await runs.run("live", "manual", "42");
  if (process.argv.includes("--expect-blocked")) {
    assert.equal(result.accepted, false, "máy chủ không hỗ trợ replay phải bị chặn trước admission");
    assert.match(result.reason ?? "", /lịch sử|phát lại/);
    assert.equal(store.runs().length, 0, "chưa nhận lượt và chưa thể gửi prompt");
    console.log("Đạt: máy chủ thiếu lịch sử bị chặn trước admission, không gửi prompt.");
  } else {
    assert.equal(result.accepted, true, result.reason);
    console.log("Đã nhận lượt; không đăng ký luồng sự kiện toàn cục để kiểm tra đọc bù lịch sử.");
    const until = Date.now() + 120_000;
    while (store.runs()[0].finishedAt === undefined && Date.now() < until) {
      await runs.recover();
      if (store.runs()[0].finishedAt === undefined) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const run = store.runs()[0];
    assert.equal(run.phase, "succeeded", JSON.stringify({ phase: run.phase, reason: run.recoveryReason, evidence: run.evidence }));
    assert.ok(run.evidence?.delivered && run.evidence.started && run.evidence.terminal === "succeeded");
    const reply = await oc.latestReply(run.binding!.sessionID, 0, { lastTurn: true });
    assert.ok(reply?.text.includes(marker), "đúng phản hồi của lượt chạy lịch");
    assert.equal(st.peek(run.binding!.conv)?.worker?.status, "done");
    assert.equal(store.get("live")?.enabled, false, "chạy thủ công không bật lại lịch đã tạm dừng");
    assert.equal(out.filter((text) => text.includes("Đã xác nhận execution kết thúc")).length, 1);
    console.log("Đạt: identity, đọc bù execution, terminal, phản hồi và worker status.");
  }
} finally {
  runs.stop();
  for (const run of store.runs()) {
    if (run.binding && run.finishedAt !== undefined) await oc.retireScheduledSession(run.binding.sessionID).catch(() => {});
    else if (run.binding) console.warn("Lượt chưa xác nhận kết thúc; giữ session và metadata để kiểm tra:", run.binding.sessionID);
  }
  oc.stopEvents();
}
