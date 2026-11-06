/**
 * Checks for the JSON-backed per-chat state store: merge-on-set, persistence
 * across restarts (reload), session->chat routing, and recovery from a
 * corrupted state file. Uses a throwaway file under /tmp/opencode.
 *
 * Run:  npx tsx scripts/test-state.ts
 */
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager, UserPrefsStore } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const file = join("/tmp/opencode", `state-test-${process.pid}.json`);

// ── fresh store: get/set/merge/persist/reload ─────────────────────────────
{
  await rm(file, { force: true });
  const st = new StateManager(file);
  check("get auto-creates empty state", st.get("1").sessionID === undefined);

  st.set("1", { sessionID: "ses_a" });
  st.set("1", { agent: "plan" }); // second set must merge, not clobber
  const s1 = st.get("1");
  check("set merges fields", s1.sessionID === "ses_a" && s1.agent === "plan");

  check("persists to disk", (await readFile(file, "utf8")).includes("ses_a"));

  const st2 = new StateManager(file); // simulate a bot restart
  check("reload restores state", st2.get("1").sessionID === "ses_a" && st2.get("1").agent === "plan");
  check("findChatBySession hit", st2.findChatBySession("ses_a") === "1");
  check("findChatBySession miss", st2.findChatBySession("ses_z") === undefined);

  st2.clear("1");
  check("clear removes the chat", st2.findChatBySession("ses_a") === undefined);
}

// ── corrupted state file must not crash the bot ───────────────────────────
{
  await writeFile(file, "{this is not json");
  const st = new StateManager(file);
  check("corrupt file -> empty store", Object.keys(st.all()).length === 0);
  st.set("9", { agent: "build" });
  check("recovers and persists", new StateManager(file).get("9").agent === "build");
}

// ── per-user language prefs ─────────────────────────────────────────────────────────
{
  const ufile = join("/tmp/opencode", `users-test-${process.pid}.json`);
  await rm(ufile, { force: true });
  const up = new UserPrefsStore(ufile);
  check("default lang is vi (no prefs)", up.getLang("123") === "vi");

  up.setLang("123", "en");
  check("setLang + getLang roundtrip", up.getLang("123") === "en");

  up.setLang("456", "vi");
  check("per-user isolation (456=vi, 123=en)", up.getLang("456") === "vi" && up.getLang("123") === "en");

  // Persistence across "restart"
  const up2 = new UserPrefsStore(ufile);
  check("prefs survive reload", up2.getLang("123") === "en" && up2.getLang("456") === "vi");
  check("unknown user still defaults to vi", up2.getLang("999") === "vi");

  // Overwrite
  up2.setLang("123", "vi");
  check("overwrite works", up2.getLang("123") === "vi");

  await rm(ufile, { force: true });
}

await rm(file, { force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
