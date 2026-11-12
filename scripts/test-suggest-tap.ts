/**
 * Quick-replies tap routing (docs/sdd/quick-replies.md, R3.1–R3.4 + R5.2):
 *   - R3.1: a tap goes through the typed-message entry point (runPrompt for
 *     plain sessions, promptManager for the Manager) with the option text —
 *     not the raw oc.prompt;
 *   - R3.2: a tap while a turn is running is refused ("A task is running"),
 *     keeps the buttons, and sends nothing;
 *   - R3.3: an accepted tap replaces the keyboard with a single inert ✓ button
 *     showing the chosen text; re-tapping it is a no-op;
 *   - R3.4: one-shot consumption; "expired" for an unknown id; "no longer
 *     applies" when the session changed;
 *   - R5.2: the suggest_tap audit event (option index + count).
 *
 * Runs against a mock Bot + a temp audit file (no live Telegram / OpenCode).
 *
 * Run:  npx tsx scripts/test-suggest-tap.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { configureAudit } from "../src/audit.js";
import { registry } from "../src/choices.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ocbot-qtap-"));
const auditFile = join(tmp, "audit.log");
configureAudit({ path: auditFile });

function makeBot() {
  const sent: string[] = [];
  const answers: string[] = [];
  const edits: Array<{ messageId: number; markup: Record<string, unknown> }> = [];
  const prompts: Array<{ conv: string; text: string; via: "runPrompt" | "promptManager" }> = [];
  const tg: any = {
    onThreadNotFound: undefined,
    onMessageReaction: undefined,
    sendMessage: async (_conv: string, text: string) => {
      sent.push(text);
      return 1;
    },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    openForumTopic: async () => {},
    setReaction: async () => true,
    editMessageText: async () => true,
    editMessageReplyMarkup: async (_conv: string, messageId: number, markup: Record<string, unknown>) => {
      edits.push({ messageId, markup });
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      answers.push(text ?? "");
    },
    stop: () => {},
  };
  const oc: any = {
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
    prompt: async () => {
      prompts.push({ conv: "", text: "", via: "runPrompt" }); // raw oc.prompt must NEVER be used (R3.1)
      return "msg_x";
    },
    interrupt: async () => {},
    createSession: async () => "ses_1",
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(tmp, "state.json"));
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, busyMode: "ask", suggest: true };
  const bot = new Bot(tg, oc, st, cfg);
  // Capture the routed turn instead of running one (R3.1 verifies the entry
  // point — runPrompt / promptManager — is used, not the raw oc.prompt).
  (bot as any).runPrompt = async (conv: string, text: string) => {
    prompts.push({ conv, text, via: "runPrompt" });
    return { busy: false };
  };
  (bot as any).orch.promptManager = async (conv: string, text: string) => {
    prompts.push({ conv, text, via: "promptManager" });
  };
  // Neutralize the reply/typing/stream machinery.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  return { bot, sent, answers, edits, prompts, st };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
function auditLines(): Array<Record<string, any>> {
  try {
    return readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const tap = () => auditLines().filter((l) => l.action === "suggest_tap").pop();

// ── R3.1: a tap is a typed message (plain session → runPrompt) ───────────────
{
  const { bot, st, prompts, answers, edits } = makeBot();
  const conv = "42";
  st.set(conv, { sessionID: "ses_1" });
  const id = registry.put(conv, "ses_1", ["alpha", "beta"]);
  const before = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c1", data: `ch:${id}:0` } as any, conv, 77);
  await tick();
  check("R3.1 tap routes through runPrompt with the option text", prompts[before]?.via === "runPrompt" && prompts[before]?.text === "alpha" && prompts[before]?.conv === conv, JSON.stringify(prompts.slice(before)));
  check("R3.1 callback answered (no refusal)", answers.pop() === "", JSON.stringify(answers));
  // R3.3: the keyboard is replaced by a single inert ✓ button on the tapped message.
  const edit = edits[edits.length - 1];
  const rows: any[][] = (edit?.markup as any)?.reply_markup?.inline_keyboard ?? [];
  check("R3.3 keyboard replaced on the tapped message", edit?.messageId === 77, JSON.stringify(edit));
  check("R3.3 exactly one inert row", rows.length === 1 && rows[0].length === 1, JSON.stringify(rows));
  check("R3.3 button shows ✓ + the chosen text", rows[0][0]?.text === "✓ alpha", JSON.stringify(rows[0]));
  check("R3.3 inert callback_data", rows[0][0]?.callback_data === "ch:inert", JSON.stringify(rows[0]));
  // R3.4: the record is consumed (one-shot).
  check("R3.4 the record is consumed after a tap", registry.get(id) === undefined);
  // R5.2: suggest_tap audited with the option index + count.
  const ev = tap();
  check("R5.2 suggest_tap audited (idx 0, count 2)", ev?.meta?.idx === 0 && ev?.meta?.count === 2, JSON.stringify(ev));
}

// ── R3.3: re-tapping the inert button is a no-op ─────────────────────────────
{
  const { bot, st, prompts, answers } = makeBot();
  const conv = "42";
  st.set(conv, { sessionID: "ses_1" });
  const before = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c2", data: "ch:inert" } as any, conv, 77);
  check("inert tap is a no-op (no prompt)", prompts.length === before, JSON.stringify(prompts.slice(before)));
  check("inert tap answers without a refusal", answers.pop() === "", JSON.stringify(answers));
}

// ── R3.4: re-tap (consumed) + unknown id → "expired"; session change → "no longer applies" ─
{
  const { bot, st, prompts, answers } = makeBot();
  const conv = "42";
  st.set(conv, { sessionID: "ses_1" });
  const id = registry.put(conv, "ses_1", ["one", "two"]);
  const before = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c3", data: `ch:${id}:1` } as any, conv, 77);
  await tick();
  check("first tap fires the choice", prompts[before]?.text === "two", JSON.stringify(prompts.slice(before)));
  await (bot as any).handleChoiceCallback({ id: "c4", data: `ch:${id}:1` } as any, conv, 77);
  check("re-tap of a consumed button is refused", prompts.length === before + 1);
  check("re-tap answers 'expired'", /hết hạn|expired/i.test(answers[answers.length - 1]), answers[answers.length - 1]);
  await (bot as any).handleChoiceCallback({ id: "c5", data: "ch:zzzz:0" } as any, conv, 77);
  check("unknown id answers 'expired'", /hết hạn|expired/i.test(answers[answers.length - 1]), answers[answers.length - 1]);
  const id2 = registry.put(conv, "ses_1", ["a", "b"]);
  st.set(conv, { sessionID: "ses_2" }); // /new — the session changed
  await (bot as any).handleChoiceCallback({ id: "c6", data: `ch:${id2}:0` } as any, conv, 77);
  check("session change answers 'no longer applies'", /không còn áp dụng|no longer applies/i.test(answers[answers.length - 1]), answers[answers.length - 1]);
  check("a stale tap fires no prompt", prompts.length === before + 1);
}

// ── R3.2: a busy plain turn is refused, buttons kept, nothing sent ───────────
{
  const { bot, st, prompts, sent, answers, edits } = makeBot();
  const conv = "42";
  st.set(conv, { sessionID: "ses_1" });
  (bot as any).inflight.set(conv, new AbortController());
  const id = registry.put(conv, "ses_1", ["x", "y"]);
  const before = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c7", data: `ch:${id}:0` } as any, conv, 77);
  check("R3.2 busy tap fires no prompt", prompts.length === before);
  check("R3.2 busy tap answers 'running'", /Đang chạy|running/i.test(answers[answers.length - 1]), answers[answers.length - 1]);
  check("R3.2 busy tap sends no message", sent.length === 0, JSON.stringify(sent));
  check("R3.2 busy tap keeps the buttons (no markup edit)", edits.length === 0, JSON.stringify(edits));
  check("R3.2 the record survives a busy tap", registry.get(id) !== undefined);
  (bot as any).inflight.delete(conv);
}

// ── R3.2 + R3.1: a busy Manager refuses; an idle Manager routes via promptManager ─
{
  const { bot, st, prompts, answers, edits } = makeBot();
  const conv = "42:9";
  st.set(conv, { sessionID: "ses_m", manager: true });
  (bot as any).orch.managerBusy.add(conv);
  const id = registry.put(conv, "ses_m", ["m1", "m2"]);
  const before = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c8", data: `ch:${id}:0` } as any, conv, 88);
  check("R3.2 busy Manager tap fires no prompt", prompts.length === before);
  check("R3.2 busy Manager tap answers 'running'", /Đang chạy|running/i.test(answers[answers.length - 1]), answers[answers.length - 1]);
  check("R3.2 busy Manager tap keeps the buttons", edits.length === 0);
  (bot as any).orch.managerBusy.delete(conv);
  const after = prompts.length;
  await (bot as any).handleChoiceCallback({ id: "c9", data: `ch:${id}:0` } as any, conv, 88);
  await tick();
  check("R3.1 idle Manager tap routes via promptManager with the option text", prompts[after]?.via === "promptManager" && prompts[after]?.text === "m1", JSON.stringify(prompts.slice(after)));
}

if (failures) {
  console.error(`\n${failures} suggest-tap check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll suggest-tap checks passed.");
