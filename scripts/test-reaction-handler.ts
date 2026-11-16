/**
 * Handler-level checks for the message-reaction handler (Bot.onMessageReaction,
 * src/bot.ts), run against a mock Bot like scripts/test-queue-cmd.ts —
 * FB-05: the handler must diff new_reaction against old_reaction instead of
 * reading new_reaction[0]:
 *   - REMOVING an emoji from a multi-reaction list must not fire the other
 *     one (no spurious spawn, no dedupe marker, no message sent);
 *   - a genuinely ADDED mapped emoji still fires exactly once (dedupe kept);
 *   - re-adding a removed emoji is diffed as an add but the once-ever
 *     reacted marker still blocks it (existing dedupe behaviour preserved).
 *
 * Run:  npx tsx scripts/test-reaction-handler.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager, MACHINE_STATE_KEY } from "../src/state.js";
import { reactedKey } from "../src/reactions.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const CHAT = 111;
const MSG = 222;

function makeBot() {
  const tmp = mkdtempSync(join(tmpdir(), "ocbot-rhandler-"));
  const sent: string[] = [];
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
    stop: () => {},
  };
  const oc: any = {
    promptAndWait: async () => ({ reply: "done", outcome: "succeeded", interrupted: false, elapsedMs: 1 }),
    prompt: async () => "msg_x",
    interrupt: async () => {},
    createSession: async () => "ses_1",
    setInstruction: async () => {},
    removeInstruction: async () => {},
  };
  const st = new StateManager(join(tmp, "state.json"));
  const cfg: any = { stateFile: join(tmp, "state.json"), maxSchedules: 5, react: true };
  const bot = new Bot(tg, oc, st, cfg);
  // Neutralize the reply/typing/stream machinery so only the reaction logic runs.
  (bot as any).sendReply = async () => {};
  (bot as any).sendHtml = async () => {};
  (bot as any).startTyping = () => {};
  (bot as any).stopTyping = () => {};
  (bot as any).startWorking = () => {};
  (bot as any).clearActivity = () => {};
  (bot as any).dropPreview = async () => {};
  (bot as any).offerContinueKeyboard = () => undefined;
  const spawns: Array<[string, string]> = [];
  (bot as any).orch.relaySpawnRequest = (conv: string, text: string) => spawns.push([conv, text]);
  (bot as any).orch.isManagerConv = () => true;
  // Seed the message index: one bot reply, long enough to be a spawn task.
  st.set(MACHINE_STATE_KEY, {
    msgIndex: {
      [`${CHAT}:${MSG}`]: { conv: String(CHAT), purpose: "reply", text: "Fix the login bug on the settings page", ts: Date.now() },
    },
  });
  const ev = (oldE: string[], newE: string[]) => ({
    chat: { id: CHAT },
    message_id: MSG,
    date: Date.now(),
    old_reaction: oldE.map((e) => ({ type: "emoji", emoji: e })),
    new_reaction: newE.map((e) => ({ type: "emoji", emoji: e })),
  });
  const reactedNow = (e: string) => Boolean((st.peek(MACHINE_STATE_KEY)?.reacted ?? {})?.[reactedKey(CHAT, MSG, e)]);
  return { bot, st, sent, spawns, ev, reactedNow };
}

// ── FB-05 spurious spawn: removing 👍 from [👍,🔥] must not fire 🔥 ──────
{
  const { bot, sent, spawns, ev, reactedNow } = makeBot();
  await (bot as any).onMessageReaction(ev(["👍", "🔥"], ["🔥"]));
  check("removal of 👍 from [👍,🔥] → no spawn", spawns.length === 0, `spawns=${JSON.stringify(spawns)}`);
  check("removal → no dedupe marker for 🔥", !reactedNow("🔥"));
  check("removal → nothing sent", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

// ── real add + dedupe: adding 🔥 beside 👍 fires exactly once ──────────────
{
  const { bot, sent, spawns, ev, reactedNow } = makeBot();
  await (bot as any).onMessageReaction(ev(["👍"], ["👍", "🔥"]));
  check("adding 🔥 beside 👍 → spawn fires once", spawns.length === 1, `spawns=${JSON.stringify(spawns)}`);
  check("spawn relayed the indexed message conv", spawns[0]?.[0] === String(CHAT));
  check("add → dedupe marker written for 🔥", reactedNow("🔥"));
  check("add → one ack message sent", sent.length === 1, `sent=${JSON.stringify(sent)}`);

  // a duplicated update for the same add is deduped (fired once, ever)
  await (bot as any).onMessageReaction(ev(["👍"], ["👍", "🔥"]));
  check("duplicated add update → deduped (still one spawn)", spawns.length === 1);

  // removing 👍 (back to [🔥]) adds nothing → still ignored
  await (bot as any).onMessageReaction(ev(["👍", "🔥"], ["🔥"]));
  check("removal of 👍 after the add → still no second spawn", spawns.length === 1);

  // re-adding 👍 after its removal: the diff sees an add, but the once-ever
  // marker for 🔥 keeps the existing dedupe behaviour (no second spawn)
  await (bot as any).onMessageReaction(ev(["👍"], ["👍", "🔥"]));
  check("re-add after removal → once-ever dedupe still holds", spawns.length === 1);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
