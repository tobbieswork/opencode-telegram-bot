import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { Telegram } from "../src/telegram.js";
import type { OpenCodeCtl } from "../src/opencode.js";

const root = mkdtempSync(join(tmpdir(), "telegram-command-html-"));
const originalFetch = globalThis.fetch;
const rejected: string[] = [];
const sent: string[] = [];
const keyboards: unknown[] = [];
const supported = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler", "a", "tg-emoji", "code", "pre", "blockquote"]);
let bot: Bot | undefined;
try {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://api.telegram.org");
    const method = url.pathname.split("/").at(-1);
    const payload = JSON.parse(String(init?.body ?? "{}"));
    let result: unknown = true;
    if (method === "getChat") result = { id: -1001, type: "supergroup", is_forum: true };
    else if (method === "getMe") result = { id: 42, is_bot: true, first_name: "Test" };
    else if (method === "getChatMember") result = { status: "administrator", can_manage_topics: true };
    else if (method === "sendMessage") {
      if (payload.parse_mode === "HTML") {
        for (const match of String(payload.text).matchAll(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g)) {
          if (supported.has(match[1])) continue;
          const offset = Buffer.byteLength(payload.text.slice(0, match.index));
          const description = `Bad Request: can't parse entities: Unsupported start tag "${match[1]}" at byte offset ${offset}`;
          rejected.push(description);
          return new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 });
        }
      }
      sent.push(payload.text);
      keyboards.push(payload.reply_markup);
      result = { message_id: sent.length, chat: { id: -1001 }, date: 1, text: payload.text };
    } else assert.equal(method, "setMyCommands");
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const cfg = { ...loadConfig(root), stateFile: join(root, "state.json"), opencodeDirectory: root,
    managerDir: join(root, "manager"), schedule: false, uptimeMonitor: false, prWatch: false,
    remind: false, activity: false, working: false, stream: false };
  const tg = new Telegram(cfg.telegramToken);
  let modelID = "model-test";
  const oc = { listModels: async () => [{ id: modelID, providerID: "test", name: "Tên <model>" }], listSessions: async () => [] } as unknown as OpenCodeCtl;
  bot = new Bot(tg, oc, new StateManager(cfg.stateFile), cfg);
  let update = 0;
  const run = (text: string) => bot!.handle({ update_id: ++update, message: { message_id: update,
    chat: { id: -1001, type: "supergroup", is_forum: true }, from: { id: 1 }, text } });
  await run("/setup");
  await tg.sendMessage("-1001", "<b>Kiểm tra</b> <code>/attach &lt;session-id&gt;</code>");
  assert.deepEqual(rejected, [], "HTML hợp lệ phải giữ nguyên khả năng định dạng");
  const failures: Array<{ command: string; errors: string[] }> = [];
  const workCommands = ["/stop", "/history", "/context", "/note"];
  for (const command of ["/sessions", "/ls", "/ls@opencode_blue_bot", "/use", "/attach", "/clear", "/models", "/models", ...workCommands]) {
    const before = rejected.length;
    try { await run(command); } catch (error) {
      if (rejected.length === before) throw error;
    }
    if (rejected.length > before) failures.push({ command, errors: rejected.slice(before) });
    else if (command === "/models") {
      assert.ok(sent.at(-1)?.includes("&lt;id&gt;"));
      assert.ok(sent.at(-1)?.includes(modelID === "model-test" ? "<code>model-test</code>" : "model&lt;test&gt;"));
      assert.ok(sent.at(-1)?.includes("Tên &lt;model&gt;"));
    } else if (workCommands.includes(command) || command === "/clear") {
      assert.ok(sent.at(-1)?.includes(command === "/clear" ? "&lt;session-id&gt;" : "&lt;worker&gt;"), `${command}: tham số hướng dẫn phải được mã hóa HTML`);
    } else assert.ok(JSON.stringify(keyboards.at(-1)).includes('"callback_data":"cmd:new"'), `${command}: danh sách rỗng vẫn phải có nút tạo phiên, không bắt nhập ID`);
    if (command === "/models") modelID = "model<test>";
  }
  assert.deepEqual(failures, [], "Các lệnh sau /setup không được gửi thẻ HTML không hỗ trợ");
  for (const text of ["/manager", "Tôi muốn đổi tên chủ đề theo tiêu đề phiên"]) {
    await run(text);
    assert.ok(sent.at(-1)?.includes("/sessions"));
    assert.ok(JSON.stringify(keyboards.at(-1)).includes('"callback_data":"mgr:open"'));
    assert.ok(JSON.stringify(keyboards.at(-1)).includes("Mở phiên quản lý"));
  }
  assert.deepEqual(rejected, [], "Hướng dẫn mở phiên quản lý phải gửi HTML hợp lệ qua adapter Telegram thật");
  console.log("Đạt: danh sách rỗng, bí danh, hướng dẫn và tên/model ID gửi HTML hợp lệ qua adapter Telegram thật.");
} finally {
  bot?.stopScheduler();
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
