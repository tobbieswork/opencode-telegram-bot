/**
 * Unit tests for the "long content as file" UX convention — Bot.sendContentSmart
 * (and the Telegram.sendDocument wiring it relies on). A long worker DONE report
 * is written to a temp `.md` file and sent as a document attachment with a
 * 2-line caption; a short reply is sent as a normal HTML message. The temp file
 * is cleaned up after a (shortened) delay, and a failed document send falls back
 * to HTML so the report is never lost.
 *
 * Run:  npx tsx scripts/test-ux-file.ts
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DocCall {
  to: unknown;
  file: string;
  caption?: string;
}

/**
 * A Bot wired with spies: `sendHtml` (the short path) and `tg.sendDocument`
 * (the long path) are captured instead of hitting Telegram. A real StateManager
 * in a fresh tmpdir keeps the constructor happy.
 */
function makeBot(): { bot: Bot; htmlCalls: string[]; docCalls: DocCall[] } {
  const base = mkdtempSync(join(tmpdir(), "tg-ux-file-"));
  const st = new StateManager(join(base, "state.json"));
  const tg: any = {};
  const oc: any = {};
  const cfg: any = {
    stateFile: join(base, "state.json"),
    maxSchedules: 10,
    replyMaxLen: 4000,
    richReplies: false,
    react: false,
    advisor: false,
  };
  const bot = new Bot(tg, oc, st, cfg);
  const htmlCalls: string[] = [];
  const docCalls: DocCall[] = [];
  bot.sendHtml = async (_conv: unknown, html: string) => {
    htmlCalls.push(html);
  };
  tg.sendDocument = async (to: unknown, file: string, caption?: string) => {
    docCalls.push({ to, file, caption });
  };
  return { bot, htmlCalls, docCalls };
}

async function main(): Promise<void> {
  // > LONG_CONTENT_THRESHOLD (1500). First two lines are distinct for the caption.
  const longContent = "Line one\nLine two\n" + "x".repeat(1600);
  const shortContent = "A short report.";

  // ── short content → normal HTML message, no document ──────────────────────
  {
    const { bot, htmlCalls, docCalls } = makeBot();
    await (bot as any).sendContentSmart("123", shortContent);
    check("short: sendHtml called once", htmlCalls.length === 1, `got ${htmlCalls.length}`);
    check("short: sendHtml got the content", htmlCalls[0] === shortContent, JSON.stringify(htmlCalls[0]));
    check("short: sendDocument NOT called", docCalls.length === 0, `got ${docCalls.length}`);
  }

  // ── long content → temp .md file + sendDocument, no HTML ───────────────────
  {
    const { bot, htmlCalls, docCalls } = makeBot();
    await (bot as any).sendContentSmart("123", longContent);
    check("long: sendDocument called once", docCalls.length === 1, `got ${docCalls.length}`);
    check("long: sendHtml NOT called", htmlCalls.length === 0, `got ${htmlCalls.length}`);
    const c = docCalls[0];
    check("long: sent to the conv", c.to === "123", JSON.stringify(c.to));
    check(
      "long: file is report-<timestamp>.md under tmpdir",
      /^report-\d+\.md$/.test(c.file.split("/").pop() ?? "") && c.file.startsWith(tmpdir()),
      c.file,
    );
    check("long: temp file exists right after send", existsSync(c.file));
    check("long: caption is the first 2 lines", (c.caption ?? "").startsWith("Line one\nLine two"), JSON.stringify(c.caption));
    check("long: caption carries the 📎 marker", (c.caption ?? "").includes("📎"), JSON.stringify(c.caption));
    check("long: caption within Telegram's 1024 cap", (c.caption ?? "").length <= 1024, `len ${(c.caption ?? "").length}`);
  }

  // ── a custom title overrides the caption ──────────────────────────────────
  {
    const { bot, docCalls } = makeBot();
    await (bot as any).sendContentSmart("123", longContent, "My Custom Title");
    const c = docCalls[0];
    check("title: caption starts with the title", (c.caption ?? "").startsWith("My Custom Title"), JSON.stringify(c.caption));
    check("title: caption does NOT fall back to the lines", !(c.caption ?? "").includes("Line one"), JSON.stringify(c.caption));
  }

  // ── the temp file is cleaned up after the (shortened) timeout ──────────────
  {
    const { bot, docCalls } = makeBot();
    bot.reportFileCleanupMs = 100;
    await (bot as any).sendContentSmart("123", longContent);
    const file = docCalls[0].file;
    check("cleanup: file present immediately after send", existsSync(file));
    await sleep(250);
    check("cleanup: file removed after the timeout", !existsSync(file));
  }

  // ── a failed document send falls back to HTML (report never lost) ──────────
  {
    const { bot, htmlCalls } = makeBot();
    let attempted = false;
    (bot.tg as any).sendDocument = async () => {
      attempted = true;
      throw new Error("simulated sendDocument failure");
    };
    await (bot as any).sendContentSmart("123", longContent);
    check("fallback: sendDocument was attempted", attempted);
    check("fallback: sendHtml used instead", htmlCalls.length === 1, `got ${htmlCalls.length}`);
    check("fallback: HTML carries the full content", htmlCalls[0] === longContent);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll ux-file checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
