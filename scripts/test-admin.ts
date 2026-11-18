/**
 * Unit test: the admin feature module (src/commands/admin.ts, moved out of
 * bot.ts — docs/sdd/split-bot-ts.md T4): the two-step /reboot flow (card +
 * reboot: callbacks, with the live-arming path covered only up to its guards —
 * the real token mint + sudo exec stays live-only, as in test-perm-relay.ts)
 * and the re-located /status, /context, /usage commands.
 *
 * Run:  npx tsx scripts/test-admin.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager, MACHINE_STATE_KEY } from "../src/state.js";
import { convKey } from "../src/conv.js";
import { QUESTIONS_PREAMBLE } from "../src/shared.js";
import { rebootGoData, SAFE_REBOOT_BIN } from "../src/uptime.js";
import { cmdReboot, handleRebootCallback, cmdStatus, cmdContext, cmdUsage } from "../src/commands/admin.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

interface Rec {
  sent: { conv: string; text: string; kb?: unknown }[];
  edits: { conv: string; msgId: number; text?: string; kb?: unknown }[];
  deleted: number[];
  answers: { id: string; text?: string }[];
  markupRemoved: number[];
}

function makeBot() {
  const base = mkdtempSync(join(tmpdir(), "tg-admin-"));
  const st = new StateManager(join(base, "state.json"));
  const rec: Rec = { sent: [], edits: [], deleted: [], answers: [], markupRemoved: [] };
  const tg: any = {
    sendMessage: async (conv: string, text: string, opts?: { reply_markup?: unknown }) => {
      rec.sent.push({ conv, text, kb: opts?.reply_markup });
      return rec.sent.length;
    },
    sendMessageId: async () => 1,
    editMessageText: async (conv: string, msgId: number, text?: string, opts?: { reply_markup?: unknown }) => {
      rec.edits.push({ conv, msgId, text, kb: opts?.reply_markup });
    },
    editMessageReplyMarkup: async (_conv: string, msgId: number) => {
      rec.markupRemoved.push(msgId);
    },
    deleteMessage: async (_conv: string, msgId: number) => {
      rec.deleted.push(msgId);
    },
    answerCallbackQuery: async (id: string, text?: string) => {
      rec.answers.push({ id, text });
    },
  };
  const getSessionCalls: string[] = [];
  const oc: any = {
    getSession: async (sid: string) => {
      getSessionCalls.push(sid);
      return { tokens: { input: 10, output: 20 }, time: { updated: Date.now() } };
    },
    latestAssistantInfo: async () => ({ model: { id: "m", providerID: "p" }, context: 5000 }),
    listModels: async () => [{ id: "m", providerID: "p", variants: [], contextLimit: 200000 }],
    serverInfo: async () => ({ version: "1.2.3", urls: ["http://127.0.0.1:4096"] }),
    getSessionModel: async () => ({ id: "m", providerID: "prov" }),
    getSessionReport: async () => null,
  };
  const cfg: any = {
    stateFile: join(base, "state.json"),
    maxSchedules: 10,
    remind: true,
    remindBaseMs: 60_000,
    remindFactor: 2,
    remindMax: 2,
    replyMaxLen: 4000,
    richReplies: false,
    react: false,
    advisor: false,
    defaultVariant: "default",
    opencodeDirectory: "/tmp/opencode",
    rotationConfirmFloorK: 80,
    rotationAutoFloorK: 100,
    usageWarnPct: 80,
    usageMaxRows: 10,
    usageActiveHours: 12,
  };
  const bot = new Bot(tg, oc, st, cfg);
  return { bot, st, rec, getSessionCalls };
}

const CONV = convKey(42);
const CONV_B = convKey(42) + ":7"; // a topic conv sharing a session with CONV
const CONV_C = convKey(43);
const CB = (data: string, id = "r1"): any => ({ id, data, from: { id: 42 } });

async function main(): Promise<void> {
  // ── /reboot — the confirmation card ────────────────────────────────────
  {
    const { bot, rec } = makeBot();
    await cmdReboot(bot, CONV);
    const kb = rec.sent[0]?.kb as any;
    const row = kb?.inline_keyboard?.[0] ?? [];
    check("cmdReboot: confirm card with go + cancel buttons", row.length === 2 && String(row[0].callback_data).startsWith("reboot:go:") && row[1].callback_data === "reboot:cancel", JSON.stringify(row));
  }

  // ── reboot:snooze / cancel / ask ───────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    await handleRebootCallback(bot, CB("reboot:snooze"), CONV, 777);
    check("reboot:snooze: records the reminder + clears the buttons", (st.get(MACHINE_STATE_KEY).lastRebootReminderMs ?? 0) > 0 && rec.markupRemoved.includes(777) && rec.answers[0].id === "r1");

    rec.sent.length = 0;
    await handleRebootCallback(bot, CB("reboot:cancel", "r2"), CONV, 778);
    check("reboot:cancel: answers + clears the buttons", ["Đã huỷ.", "Cancelled."].includes(rec.answers[1].text ?? "") && rec.markupRemoved.includes(778));

    rec.sent.length = 0;
    await handleRebootCallback(bot, CB("reboot:ask", "r3"), CONV, 779);
    const row = (rec.sent[0]?.kb as any)?.inline_keyboard?.[0] ?? [];
    check("reboot:ask: re-arms the confirmation card", row.some((b: any) => b.callback_data === "reboot:cancel") && rec.markupRemoved.includes(779));
  }

  // ── reboot:go — the guards (the live arm stays live-only) ──────────────
  {
    const { bot, rec } = makeBot();
    await handleRebootCallback(bot, CB(rebootGoData(Date.now() - 3_600_000)), CONV, 780); // 1h old
    check("reboot:go (stale): refuses + says it expired, never arms", rec.sent.length === 1 && rec.sent[0].text.includes("⌛") && bot.rebootArmed === false, rec.sent[0]?.text);

    // An arm already pending (double-tap) must not mint a second token.
    bot.rebootArmed = true;
    rec.sent.length = 0;
    await handleRebootCallback(bot, CB(rebootGoData(Date.now())), CONV, 781);
    check("reboot:go (already armed): no second reboot message", !rec.sent.some((s) => s.text.includes("🔄")) && bot.rebootArmed === true);
  }

  // ── /status ────────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { sessionID: "s1", agent: "plan", directory: "/tmp/opencode" });
    await cmdStatus(bot, CONV, st.get(CONV));
    const text = rec.sent[0]?.text ?? "";
    check("cmdStatus: renders bot + server + session lines", text.includes("<b>Bot</b>") && text.includes("v1.2.3") && text.includes("prov/m") && text.includes("<code>plan</code>"), text);
    check("cmdStatus: idle state line", text.includes("🟢 idle"));

    bot.inflight.set(CONV, new AbortController());
    rec.sent.length = 0;
    await cmdStatus(bot, CONV, st.get(CONV));
    check("cmdStatus: busy state line while inflight", (rec.sent[0]?.text ?? "").includes("⏳ busy"));
  }

  // ── /context ───────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    // no session yet
    st.set(CONV, {});
    await cmdContext(bot, CONV, st.get(CONV));
    check("cmdContext: no session → prompt /new", (rec.sent[0]?.text ?? "") === "No current session. Send /new.", rec.sent[0]?.text);

    // read failure → error line
    rec.sent.length = 0;
    st.set(CONV, { sessionID: "s1" });
    (bot as any).oc.getSessionReport = async () => { throw new Error("boom"); };
    await cmdContext(bot, CONV, st.get(CONV));
    check("cmdContext: read failure → error line", (rec.sent[0]?.text ?? "").startsWith("⚠️"), rec.sent[0]?.text);

    (bot as any).oc.getSessionReport = async () => ({
      id: "s1",
      title: "My session",
      directory: "/tmp/opencode/sub",
      agent: "build",
      tokens: { input: 1, output: 2, reasoning: 3, cache: 4 },
      cost: 0.5,
      messageCount: 7,
      created: Date.now() - 60_000,
      modifiedFiles: ["/tmp/opencode/sub/a.ts"],
      lastUserPrompt: QUESTIONS_PREAMBLE + "hello world",
    });
    rec.sent.length = 0;
    await cmdContext(bot, CONV, st.get(CONV));
    const text = rec.sent[0]?.text ?? "";
    check("cmdContext: renders the session photo", text.includes("📋 <b>Session</b>") && text.includes("My session") && text.includes("prov/m"), text);
    check("cmdContext: tokens + cost + message count", text.includes("tokens: in 1") && text.includes("$0.5000") && text.includes("7 messages"));
    check("cmdContext: relative file paths", text.includes("<code>a.ts</code>"));
    check("cmdContext: last prompt strips the headless preamble", text.includes("“hello world”") && !text.includes(QUESTIONS_PREAMBLE));
  }

  // ── /usage ─────────────────────────────────────────────────────────────
  {
    const { bot, st, rec, getSessionCalls } = makeBot();
    st.set(CONV, { sessionID: "s1" });
    st.set(CONV_B, { sessionID: "s1" }); // reattach: same session, second conv
    st.set(CONV_C, { sessionID: "s2", worker: { name: "w1" } });
    await cmdUsage(bot, CONV);
    check("cmdUsage: dedups convs sharing a session", getSessionCalls.length === 2, `getSession calls=${getSessionCalls.length}`);
    const text = rec.sent[0]?.text ?? "";
    check("cmdUsage: lists every tracked session by label", text.includes("42") && text.includes("w1"), text);
    check("cmdUsage: shows the model window", text.includes("200"), text);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll admin checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
