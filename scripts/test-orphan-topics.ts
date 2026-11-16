/**
 * Tests for the orphan-topic maintenance hook: parseOrphanTopicDeletes
 * (config) + deleteOrphanTopicsAtStartup (orchestrator/topics). The hook
 * deletes the topics listed in OPENCODE_TG_DELETE_TOPICS at startup —
 * orphaned topics the bot lost track of (no longer in state.json), which the
 * Bot API cannot enumerate. The safety invariant under test: an entry whose
 * conv is still tracked in state is NEVER deleted.
 *
 * Run:  npx tsx scripts/test-orphan-topics.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOrphanTopicDeletes } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { Orchestrator } from "../src/orchestrator.js";
import { BusyNoteStore } from "../src/notes.js";
import { deleteOrphanTopicsAtStartup } from "../src/orchestrator/topics.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function makeOrch(
  list: { chatId: number; threadId: number }[],
  st: StateManager,
  deleted: string[],
  failOn: string[] = [],
): Orchestrator {
  return new Orchestrator({
    tg: {
      deleteForumTopic: async (conv: string) => {
        if (failOn.includes(conv)) throw new Error("message thread not found");
        deleted.push(conv);
      },
    },
    oc: { removeSession: async () => {} },
    st,
    cfg: { orphanTopicDeletes: list },
    busyNotes: new BusyNoteStore(),
    sendHtml: async () => {},
    applyModelAndVariant: async () => {},
    startTyping: () => {},
    advisor: { listThreads: () => [], startThread: async () => { throw new Error("unused"); }, followUp: async () => { throw new Error("unused"); }, forget: async () => {} },
  } as any);
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tg-orphan-topics-"));
  try {
    // ── parseOrphanTopicDeletes ──
    check("undefined → []", parseOrphanTopicDeletes(undefined).length === 0);
    check("empty → []", parseOrphanTopicDeletes("").length === 0);
    check(
      "single entry",
      JSON.stringify(parseOrphanTopicDeletes("1470953552:10408")) ===
        JSON.stringify([{ chatId: 1470953552, threadId: 10408 }]),
    );
    check(
      "multiple entries, whitespace tolerated",
      JSON.stringify(parseOrphanTopicDeletes(" 1470953552:10408 , -1004495820706:475")) ===
        JSON.stringify([
          { chatId: 1470953552, threadId: 10408 },
          { chatId: -1004495820706, threadId: 475 },
        ]),
    );
    check(
      "malformed entries skipped, valid kept",
      JSON.stringify(parseOrphanTopicDeletes("abc:1, 1470953552:10408, 1470953552, :1")) ===
        JSON.stringify([{ chatId: 1470953552, threadId: 10408 }]),
    );

    // ── deleteOrphanTopicsAtStartup ──
    const st = new StateManager(join(base, "state.json"));
    const deleted: string[] = [];

    // 1. empty list → no calls, no throw.
    await deleteOrphanTopicsAtStartup(makeOrch([], st, deleted));
    check("empty list: no calls", deleted.length === 0);

    // 2. untracked convs → deleted.
    const orch1 = makeOrch(
      [
        { chatId: 1470953552, threadId: 10408 },
        { chatId: 1470953552, threadId: 10406 },
      ],
      st,
      deleted,
    );
    await deleteOrphanTopicsAtStartup(orch1);
    check(
      "untracked topics deleted",
      deleted.includes("1470953552:10408") && deleted.includes("1470953552:10406"),
      JSON.stringify(deleted),
    );

    // 3. an entry still tracked in state → NEVER deleted (the core safety invariant).
    const deleted2: string[] = [];
    st.set("1470953552:10388", { sessionID: "ses_keep" });
    await deleteOrphanTopicsAtStartup(
      makeOrch([{ chatId: 1470953552, threadId: 10388 }], st, deleted2),
    );
    check("tracked conv skipped (not deleted)", deleted2.length === 0, JSON.stringify(deleted2));
    check("tracked conv state untouched", st.peek("1470953552:10388")?.sessionID === "ses_keep");

    // 4. mixed: tracked + untracked → only the untracked one is deleted.
    const deleted3: string[] = [];
    await deleteOrphanTopicsAtStartup(
      makeOrch(
        [
          { chatId: 1470953552, threadId: 10388 },
          { chatId: 1470953552, threadId: 99999 },
        ],
        st,
        deleted3,
      ),
    );
    check(
      "mixed: only the untracked topic deleted",
      deleted3.length === 1 && deleted3[0] === "1470953552:99999",
      JSON.stringify(deleted3),
    );

    // 5. a delete failure (already gone / not the bot's) → logged, no throw, next entry still processed.
    const deleted4: string[] = [];
    await deleteOrphanTopicsAtStartup(
      makeOrch(
        [
          { chatId: 1470953552, threadId: 10408 },
          { chatId: 1470953552, threadId: 77777 },
        ],
        st,
        deleted4,
        ["1470953552:10408"],
      ),
    );
    check(
      "failure on one entry does not stop the rest",
      deleted4.length === 1 && deleted4[0] === "1470953552:77777",
      JSON.stringify(deleted4),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
