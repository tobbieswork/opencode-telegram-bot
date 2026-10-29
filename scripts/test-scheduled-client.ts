import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeCtl } from "../src/opencode.js";
import type { ScheduledRun } from "../src/scheduled-run.js";

const sessionID = "ses_client";
const directory = realpathSync(mkdtempSync(join(tmpdir(), "ocbot-client-")));
const paths: Record<string, object> = Object.fromEntries([
  "/api/session/active", "/api/experimental/session/{sessionID}/log", "/api/session/{sessionID}/message/{messageID}",
  "/api/session/{sessionID}/inbox", "/api/session/{sessionID}/inbox/{inboxID}", "/api/session/{sessionID}/interrupt",
].map((path) => [path, {}]));
let prompts = 0;
let interrupted = false;
let submittedID: string | undefined;
let historyAvailable = true;
let probeSequence = 0;
let probesRemoved = 0;
const now = Date.now();
const run: ScheduledRun = { id: "run_client", mode: "manual", phase: "dispatching", messageID: "msg_client",
  admittedAt: now, deadline: now + 60_000,
  schedule: { id: "abcd", conv: "1", prompt: "Kiểm tra", dir: directory, agent: "plan", spec: { kind: "daily", time: { h: 9, m: 0 } },
    tz: "UTC", nextRunAt: now, enabled: true, createdBy: 1, createdAt: now },
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://test").pathname;
  const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (path === "/api/info") return json({ version: "2.1.2", pid: 1, urls: [], paths: { tmp: "/test" } });
  if (path === "/openapi.json") return json({ paths });
  if (path === "/api/session" && req.method === "POST") { probeSequence = 0; return json({ data: { id: "ses_probe" } }); }
  if (path === "/api/session/ses_probe" && req.method === "PATCH") { probeSequence++; res.statusCode = 204; res.end(); return; }
  if (path === "/api/session/ses_probe" && req.method === "DELETE") { probesRemoved++; res.statusCode = 204; res.end(); return; }
  if (path === "/api/session/ses_probe/inbox") return json({ data: [] });
  if (path === "/api/experimental/session/ses_probe/log") {
    res.setHeader("content-type", "text/event-stream");
    if (probeSequence && historyAvailable) res.write(`data: ${JSON.stringify({ type: "session.renamed",
      durable: { aggregateID: "ses_probe", seq: 1 }, data: { sessionID: "ses_probe" } })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_probe", seq: probeSequence })}\n\n`);
    return;
  }
  if (path === "/api/session/active") return json({ data: prompts && !interrupted ? { [sessionID]: { started: now } } : {} });
  if (path === `/api/session/${sessionID}`) return json({ data: { id: sessionID, projectID: "project", time: { created: now },
    metadata: { tgScheduledRun: run.id }, location: { directory } } });
  if (path === `/api/session/${sessionID}/inbox`) return json({ data: [] });
  if (path === `/api/session/${sessionID}/message/${run.messageID}`) return json({ data: { id: run.messageID, type: "user" } });
  if (path === `/api/session/${sessionID}/prompt`) {
    let body = "";
    for await (const chunk of req) body += chunk;
    submittedID = (JSON.parse(body) as { id: string }).id;
    prompts++;
    req.socket.destroy();
    return;
  }
  if (path === `/api/session/${sessionID}/interrupt`) { interrupted = true; return json({ interrupted: true }); }
  if (path === `/api/experimental/session/${sessionID}/log`) {
    const after = Number(new URL(req.url!, "http://test").searchParams.get("after") ?? -1);
    const timeline = prompts ? [
      { type: "session.inbox.enqueued", data: { sessionID, inboxID: run.messageID, item: { type: "user" } } },
      { type: "session.execution.started", data: { sessionID } },
      { type: "session.inbox.delivered", data: { sessionID, inboxID: run.messageID } },
      ...(interrupted ? [{ type: "session.execution.interrupted", data: { sessionID, reason: "user" } }] : []),
    ] : [];
    res.setHeader("content-type", "text/event-stream");
    for (const [index, event] of timeline.entries()) {
      const seq = index + 2;
      if (seq > after) res.write(`data: ${JSON.stringify({ ...event, id: `evt_${seq}`, created: now, durable: { aggregateID: sessionID, seq, version: 1 } })}\n\n`);
    }
    res.end(`data: ${JSON.stringify({ type: "log.synced", aggregateID: sessionID, seq: timeline.length + 1 })}\n\n`);
    return;
  }
  res.statusCode = 404;
  json({ message: "Không tìm thấy đường dẫn kiểm thử" });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const oc = new OpenCodeCtl();
  await oc.connect(`http://127.0.0.1:${address.port}`);
  historyAvailable = false;
  await assert.rejects(oc.scheduledReady(sessionID, directory), /lịch sử|phát lại/, "watermark không chứng minh máy chủ giữ payload để khôi phục");
  assert.equal(prompts, 0, "không prompt khi replay chưa được chứng minh");
  historyAvailable = true;
  await oc.scheduledReady(sessionID);
  assert.equal(probesRemoved, 2, "probe không để lại session trên máy chủ");
  run.binding = await oc.scheduledBinding(run, "1:2", sessionID);
  await assert.rejects(oc.submitScheduled(run, "Kiểm tra"), "mô phỏng mất phản hồi sau admission");
  assert.equal(prompts, 1, "adapter không retry prompt khi mất phản hồi");
  assert.equal(submittedID, run.messageID);
  const observed = await oc.observeScheduled(run);
  assert.equal(observed.state, "running", "tìm lại execution qua adapter và client thật");
  await oc.scheduledObserver().stop(run, observed);
  const terminal = await oc.observeScheduled(run);
  assert.equal(terminal.state, "interrupted", "xác nhận dừng qua log thay vì suy từ request");
  assert.equal(prompts, 1);
  delete paths["/api/experimental/session/{sessionID}/log"];
  await assert.rejects(oc.scheduledReady(sessionID), /capability/, "phát hiện máy chủ thiếu log trước admission");
  console.log("Đạt: client thật với máy chủ giả lập khôi phục execution, không gửi lại prompt.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  rmSync(directory, { recursive: true, force: true });
}
