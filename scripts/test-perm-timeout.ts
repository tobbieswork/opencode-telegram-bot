/**
 * Unit test: when the reminder budget of a PENDING PERMISSION is exhausted,
 * the bot must AUTO-REJECT it (deny instead of stall) so an unattended worker
 * session never hangs forever on an unanswered ask. Question forms are NOT
 * auto-answered — they keep the previous "stay pending" behavior.
 *
 * Mirrors the pattern Claude Code shipped in 2.1.319 as
 * permissions.denyInsteadOfPrompting ("replaces a stalled prompt with a
 * denial" for unattended runs).
 *
 * Run:  npx tsx scripts/test-perm-timeout.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { convKey } from "../src/conv.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

interface Edit {
  to: unknown;
  id: unknown;
  text: string;
}

function makeBot() {
  const base = mkdtempSync(join(tmpdir(), "tg-perm-timeout-"));
  const st = new StateManager(join(base, "state.json"));
  const tg: any = {};
  const oc: any = {};
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
  };
  const bot = new Bot(tg, oc, st, cfg);
  const edits: Edit[] = [];
  const rejects: { sid: string; rid: string; reply: string }[] = [];
  tg.editMessageTextStrict = async () => {}; // card edit succeeds
  tg.editMessageText = async (to: unknown, id: unknown, text: string) => {
    edits.push({ to, id, text });
  };
  tg.sendMessageId = async () => -1; // card-edit-only path in these tests
  oc.replyPermission = async (sid: string, rid: string, reply: string) => {
    rejects.push({ sid, rid, reply });
  };
  return { bot, st, edits, rejects };
}

const CONV = convKey(456) as string; // plain chat → ConvKey
const NOW = 1_700_000_000_000;

function seedPrompt(bot: Bot, st: StateManager, promptId: string, kind: "form" | "permission", messageId?: number): void {
  // One reminder already sent; remindMax=2 → THIS fire is the last one.
  st.set(CONV as any, {
    pendingPrompts: {
      [promptId]: {
        kind,
        text: `<b>body</b>`,
        messageId,
        firstShownAt: NOW,
        remindersSent: 1,
        nextReminderAt: Date.now(),
        relayConv: CONV as any,
      },
    },
  });
  if (kind === "permission") {
    (bot as any).permissionPrompts.set(promptId, {
      requestID: promptId,
      sessionID: "ses_test",
      conv: CONV as any,
      relayConv: CONV as any,
      messageId,
    });
  } else {
    (bot as any).questionForms.set(promptId, { conv: CONV as any, formID: promptId });
  }
}

async function main(): Promise<void> {
  // ── A: permission budget exhausted → auto-reject, card explained ──────────
  {
    const { bot, st, edits, rejects } = makeBot();
    seedPrompt(bot, st, "p1", "permission", 777);
    await (bot as any).fireReminder(CONV as any, "p1");
    check("A: replyPermission called once", rejects.length === 1, JSON.stringify(rejects));
    check("A: reply is reject for the right session/request", rejects[0]?.sid === "ses_test" && rejects[0]?.rid === "p1" && rejects[0]?.reply === "reject", JSON.stringify(rejects[0]));
    check("A: in-memory permission prompt removed", !(bot as any).permissionPrompts.has("p1"));
    check("A: persisted reminder schedule removed", st.get(CONV as any).pendingPrompts?.["p1"] === undefined, JSON.stringify(st.get(CONV as any).pendingPrompts));
    const finalEdit = edits[edits.length - 1];
    check("A: card edited with the timeout explanation", !!finalEdit && finalEdit.id === 777 && /AUTO-DENIED|TỰ TỪ CHỐI/i.test(finalEdit.text), JSON.stringify(finalEdit));
  }

  // ── B: form budget exhausted → NO auto-answer, stays pending (spent bookkeeping) ──
  {
    const { bot, st, rejects } = makeBot();
    seedPrompt(bot, st, "f1", "form", 888);
    await (bot as any).fireReminder(CONV as any, "f1");
    check("B: no auto-reject for a question form", rejects.length === 0, JSON.stringify(rejects));
    const pp = st.get(CONV as any).pendingPrompts?.["f1"];
    check("B: form entry kept with spent count", pp?.remindersSent === 2, JSON.stringify(pp));
    check("B: in-memory form still live", (bot as any).questionForms.has("f1"));
  }

  // ── C: race — permission answered while the reminder was in flight ────────
  {
    const { bot, st, edits, rejects } = makeBot();
    seedPrompt(bot, st, "p2", "permission", 999);
    // Simulate a button tap settling the prompt mid-flight: the card edit
    // (first await inside fireReminder) deletes the in-memory entry.
    const tg: any = (bot as any).tg;
    tg.editMessageTextStrict = async () => {
      (bot as any).permissionPrompts.delete("p2");
    };
    await (bot as any).fireReminder(CONV as any, "p2");
    check("C: no double reply when settled in flight", rejects.length === 0, JSON.stringify(rejects));
    check("C: no timeout explanation edit sent", edits.length === 0, JSON.stringify(edits));
    // Entry may remain as spent bookkeeping (or be gone if the tap path ran);
    // it must not crash and must not re-arm a timer.
    check("C: no live timer left for the settled prompt", (bot as any).reminders.get(`${CONV}::p2`) === undefined);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll perm-timeout checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
