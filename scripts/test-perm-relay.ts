/**
 * Unit test: the Telegram relay of OpenCode permission prompts in bot.ts.
 *
 *  B2 — settling the card on a failed reply: the bot must treat a failed
 *  `replyPermission` as "answered elsewhere" ONLY when the server says the
 *  request is no longer pending (the specific PermissionNotFoundError). A real
 *  "permission denied", an HTTP 403, or a transport blip must NOT be read that
 *  way — there the request is still pending and the card must stay retryable.
 *
 *  B3 — sending the card: a failed send (Telegram 429, network, HTML parse)
 *  must be retried; if every attempt fails the prompt is STILL registered
 *  (messageId 0) and a reminder is armed that re-sends the card. Without this,
 *  a send failure would silently lose the ask and the agent would hang until a
 *  restart.
 *
 * Run:  npx tsx scripts/test-perm-relay.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { convKey } from "../src/conv.js";
import { isAlreadyResolvedPermissionError } from "../src/perm.js";
import { onPermissionAsked } from "../src/commands/permission.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/**
 * The OpenCode client resolves an unknown/already-settled request id to a server
 * error whose wire tag is `PermissionNotFoundError` — carried both as `_tag` and
 * as `name` on the thrown Error, with message "Permission request not found: <id>".
 * Rebuild that exact shape here (as src/opencode.ts's declared() would).
 */
function makeResolvedError(id: string): Error {
  const e = new Error(`Permission request not found: ${id}`) as Error & { _tag?: string; name?: string; requestID?: string };
  e.name = "PermissionNotFoundError";
  e._tag = "PermissionNotFoundError";
  e.requestID = id;
  return e;
}

const CONV = convKey(456) as string; // plain chat → "456"

function makeBot(sendMessageId: () => Promise<number>) {
  const base = mkdtempSync(join(tmpdir(), "tg-perm-relay-"));
  const st = new StateManager(join(base, "state.json"));
  const tg: any = {};
  const oc: any = {};
  const cfg: any = {
    stateFile: join(base, "state.json"),
    maxSchedules: 10,
    remind: true,
    remindBaseMs: 60_000, // large → the reminder timer won't fire during the test
    remindFactor: 2,
    remindMax: 2,
    replyMaxLen: 4000,
    richReplies: false,
    react: false,
    advisor: false,
  };
  const bot = new Bot(tg, oc, st, cfg);
  let sends = 0;
  tg.sendMessageId = async () => {
    sends++;
    return sendMessageId();
  };
  tg.editMessageText = async () => {};
  tg.editMessageTextStrict = async () => {};
  oc.replyPermission = async () => {};
  return { bot, st, sent: () => sends };
}

async function main(): Promise<void> {
  // ── B2: isAlreadyResolvedPermissionError ──────────────────────────────
  {
    check(
      "B2: real already-resolved shape matches",
      isAlreadyResolvedPermissionError(makeResolvedError("perm_abc123")) === true,
    );
    const onlyName = Object.assign(new Error("Permission request not found: x"), { name: "PermissionNotFoundError" });
    check("B2: name-only PermissionNotFoundError matches", isAlreadyResolvedPermissionError(onlyName) === true);
    const onlyTag = Object.assign(new Error("Permission request not found: x"), {
      _tag: "PermissionNotFoundError",
      name: "Error",
    });
    check("B2: _tag-only PermissionNotFoundError matches", isAlreadyResolvedPermissionError(onlyTag) === true);

    // A REAL "permission denied" — the word "permission" must NOT trigger it.
    check("B2: 'permission denied' does NOT match", isAlreadyResolvedPermissionError(new Error("Permission denied: edit")) === false);
    // A transport / network error.
    const transport = Object.assign(new Error("fetch failed"), { name: "ClientError", _tag: "Transport" });
    check("B2: network/transport error does NOT match", isAlreadyResolvedPermissionError(transport) === false);
    check("B2: plain fetch-failed error does NOT match", isAlreadyResolvedPermissionError(new Error("Transport: fetch failed")) === false);
    // An HTTP 403 body that mentions permission.
    check(
      "B2: 403 'no permission' does NOT match",
      isAlreadyResolvedPermissionError(new Error("403 Forbidden: you do not have permission")) === false,
    );
    // Non-object / null inputs.
    check("B2: null does not match", isAlreadyResolvedPermissionError(null) === false);
    check("B2: string does not match", isAlreadyResolvedPermissionError("Permission request not found") === false);
  }

  // ── B3: retry-then-succeed ─────────────────────────────────────────────
  {
    let n = 0;
    const { bot, st } = makeBot(async () => {
      n++;
      if (n === 1) throw new Error("429 Too Many Requests"); // first send fails
      return 12345; // second send succeeds
    });
    st.set(CONV, { sessionID: "ses_perm_retry" });
    await onPermissionAsked(bot, { id: "perm_retry", sessionID: "ses_perm_retry", action: "edit", resources: ["f.ts"] });
    const p = (bot as any).permissionPrompts.get("perm_retry");
    check("B3 retry-then-succeed: retried, 2 send calls", n === 2, `calls=${n}`);
    check("B3 retry-then-succeed: messageId = success id", p?.messageId === 12345, JSON.stringify(p));
    check("B3 retry-then-succeed: reminder armed", (bot as any).reminders.has(`${CONV}::perm_retry`));
    (bot as any).cancelReminder(CONV, "perm_retry");
  }

  // ── B3: all attempts fail → register with sentinel + arm reminder ──────
  {
    let n = 0;
    const { bot, st } = makeBot(async () => {
      n++;
      throw new Error("429 Too Many Requests"); // every send fails
    });
    st.set(CONV, { sessionID: "ses_perm_fail" });
    await onPermissionAsked(bot, { id: "perm_fail", sessionID: "ses_perm_fail", action: "edit", resources: ["f.ts"] });
    const p = (bot as any).permissionPrompts.get("perm_fail");
    check("B3 all-fail: 3 send attempts (bounded)", n === 3, `calls=${n}`);
    check("B3 all-fail: registered with sentinel messageId 0", p?.messageId === 0, JSON.stringify(p));
    check("B3 all-fail: persisted with messageId 0", st.get(CONV).pendingPrompts?.["perm_fail"]?.messageId === 0);
    check("B3 all-fail: reminder armed to re-send the card", (bot as any).reminders.has(`${CONV}::perm_fail`));
    (bot as any).cancelReminder(CONV, "perm_fail");
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll perm-relay checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
