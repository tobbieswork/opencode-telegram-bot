/**
 * Checks for the JSON-backed per-chat state store: merge-on-set, persistence
 * across restarts (reload), session->chat routing, and recovery from a
 * corrupted state file (corrupt file is preserved as .corrupt-<ts> and a
 * warning is logged; save() failures are logged instead of swallowed).
 * Uses a throwaway file under /tmp/opencode.
 *
 * Run:  npx tsx scripts/test-state.ts
 */
import { mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** Run fn with console.warn/error captured; returns the joined log lines. */
function captured(method: "warn" | "error", fn: () => void): string[] {
  const out: string[] = [];
  const orig = console[method];
  console[method] = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console[method] = orig;
  }
  return out;
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

// ── corrupt state file: preserved, warned about, store starts empty ───────
{
  await writeFile(file, "{this is not json");
  let st!: StateManager;
  const warnings = captured("warn", () => (st = new StateManager(file)));
  check("corrupt file -> empty store", Object.keys(st.all()).length === 0);
  check("corrupt file -> warning with the path", warnings.some((w) => w.includes(file) && w.includes("corrupt")));
  const backups = (await readdir("/tmp/opencode")).filter((n) => n.startsWith(`state-test-${process.pid}.json.corrupt-`));
  check("corrupt file -> renamed to .corrupt-<ts>", backups.length === 1 && !existsSync(file));
  check(
    "corrupt evidence preserved verbatim",
    backups.length === 1 && (await readFile(join("/tmp/opencode", backups[0]), "utf8")) === "{this is not json",
  );
  st.set("9", { agent: "build" });
  check("recovers and persists", new StateManager(file).get("9").agent === "build");
  await rm(join("/tmp/opencode", backups[0]), { force: true });
}

// ── save() failure: logged once per distinct error, not swallowed ─────────
{
  const dfile = join("/tmp/opencode", `state-dir-${process.pid}.json`);
  const st = new StateManager(dfile); // file absent yet: fresh start, no logs
  await mkdir(dfile); // a DIRECTORY where the JSON file should be
  await writeFile(join(dfile, "occupied"), "x"); // non-empty: the atomic rename must fail
  const errs = captured("error", () => {
    st.set("1", { agent: "x" });
    st.set("1", { agent: "y" }); // same failure again: deduped, not re-logged
  });
  const hits = errs.filter((m) => m.includes("failed to write") && m.includes(dfile));
  check("save error -> logged once", hits.length === 1, `logged ${hits.length}: ${JSON.stringify(errs)}`);
  check("state kept in memory after save failure", st.get("1").agent === "y");
  await rm(dfile, { recursive: true, force: true });
  await rm(`${dfile}.${process.pid}.tmp`, { force: true });
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

  // Corrupt prefs file: same preserve + warn behaviour as state.json
  await writeFile(ufile, "{{{");
  let up3!: UserPrefsStore;
  const warnings = captured("warn", () => (up3 = new UserPrefsStore(ufile)));
  check("corrupt prefs -> empty store (defaults intact)", up3.getLang("123") === "vi");
  check("corrupt prefs -> warning with the path", warnings.some((w) => w.includes(ufile) && w.includes("corrupt")));
  const backups = (await readdir("/tmp/opencode")).filter((n) => n.startsWith(`users-test-${process.pid}.json.corrupt-`));
  check("corrupt prefs -> renamed to .corrupt-<ts>", backups.length === 1 && !existsSync(ufile));
  up3.setLang("123", "en");
  check("prefs recover and persist", new UserPrefsStore(ufile).getLang("123") === "en");
  if (backups[0]) await rm(join("/tmp/opencode", backups[0]), { force: true });
  await rm(ufile, { force: true });
}

await rm(file, { force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
