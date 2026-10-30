import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { Telegram } from "../src/telegram.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function processes() {
  return run("ps", ["-axo", "pid=,ppid=,command="]).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}
function bots() {
  return processes().filter(row => row.command.includes(root) && row.command.includes("src/index.ts") &&
    (row.command.includes("node") || row.command.includes("tsx")));
}
function cwd(pid: number): string {
  return run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find(line => line.startsWith("n"))?.slice(1) ?? "";
}
async function until(check: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Hết thời gian xác nhận trạng thái bot; không tự chạy thêm tiến trình.");
    await wait(200);
  }
}

assert.equal(process.platform, "darwin", "Công cụ này dành cho bot cục bộ macOS; Linux dùng dịch vụ systemd đã cấu hình.");
assert.equal(process.cwd(), root, "Phải chạy từ đúng thư mục mã nguồn.");
loadDotEnv();
const cfg = loadConfig(root);
const current = bots();
const parents = new Set(current.map(row => row.parent));
const leaf = current.filter(row => !parents.has(row.pid));
assert.equal(leaf.length, 1, "Phải xác minh đúng một tiến trình bot trước khi khởi động lại.");
assert.equal(cwd(leaf[0].pid), root);
const output = run("lsof", ["-a", "-p", String(leaf[0].pid), "-d", "1", "-Fn"])
  .split("\n").find(line => line.startsWith("n"))?.slice(1);
assert.ok(output, "Không tìm được nhật ký của bot đang chạy.");
const priorLog = readFileSync(output, "utf8");
const expectedID = Number(priorLog.match(/Telegram bot:.*\(id (\d+)\)/)?.[1]);
assert.ok(expectedID, "Nhật ký cũ không đủ bằng chứng tài khoản bot.");
assert.equal(cfg.stateFile, priorLog.match(/State file: (.+)/)?.[1].trim());
assert.equal((await new Telegram(cfg.telegramToken).getMe()).id, expectedID);
const before = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
let priorLinks = before.__machine__?.sessionTopics?.links ?? {};
if (process.argv.includes("--check")) {
  console.log("Đạt: đúng một bot, đúng thư mục, tài khoản và tệp trạng thái; chưa khởi động lại.");
} else {
  const backupDir = join(dirname(cfg.stateFile), "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  writeFileSync(join(backupDir, `state-before-${stamp}.json`), JSON.stringify(before), { flag: "wx", mode: 0o600 });
  const old = new Set(current.map(row => row.pid));
  for (const row of current) {
    const parent = processes().find(item => item.pid === row.parent);
    if (parent?.command === "npm start" && cwd(parent.pid) === root) old.add(parent.pid);
  }
  process.kill(leaf[0].pid, "SIGTERM");
  await until(() => !processes().some(row => old.has(row.pid)) && bots().length === 0, 20_000);
  const stopped = readFileSync(cfg.stateFile, "utf8");
  const backup = join(backupDir, `state-stopped-${stamp}.json`);
  writeFileSync(backup, stopped, { flag: "wx", mode: 0o600 });
  priorLinks = JSON.parse(stopped).__machine__?.sessionTopics?.links ?? {};
  const logDir = join(tmpdir(), "opencode");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `opencode-telegram-bot-${Date.now()}.log`);
  const fd = openSync(log, "wx", 0o600);
  const child = spawn("npm", ["start"], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  closeSync(fd);
  await until(() => readFileSync(log, "utf8").includes("State file:"), 45_000);
  await wait(3000);
  const text = readFileSync(log, "utf8");
  assert.ok(text.includes(`(id ${expectedID})`));
  assert.ok(text.includes(`State file: ${cfg.stateFile}`));
  assert.ok(!/Fatal:|Unhandled rejection:|\b409\b/.test(text), "Nhật ký có lỗi sau khi khởi động lại.");
  const active = bots();
  const activeParents = new Set(active.map(row => row.parent));
  assert.equal(active.filter(row => !activeParents.has(row.pid)).length, 1);
  const after = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
  for (const [id, link] of Object.entries(priorLinks) as [string, { sessionID?: string; conv?: string }][]) {
    assert.equal(after.__machine__?.sessionTopics?.links?.[id]?.sessionID, link.sessionID);
    assert.equal(after.__machine__?.sessionTopics?.links?.[id]?.conv, link.conv);
  }
  const receipts = join(dirname(cfg.stateFile), "deployments");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = join(receipts, `deployment-${stamp}.json`);
  writeFileSync(receipt, JSON.stringify({ luc: new Date().toISOString(), commit: run("git", ["rev-parse", "HEAD"]).trim(),
    thayDoiChuaCommit: run("git", ["status", "--porcelain"]).trim().split("\n").filter(Boolean),
    taiKhoanBot: expectedID, stateFile: cfg.stateFile, motBot: true, khongLoi409: true,
    soLienKetDuocGiu: Object.keys(priorLinks).length, saoLuu: backup, nhatKy: log }, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ daKhoiDongLai: true, chiMotBot: true, soLienKetDuocGiu: Object.keys(priorLinks).length, saoLuu: backup, nhatKy: log, bienNhan: receipt }));
}
