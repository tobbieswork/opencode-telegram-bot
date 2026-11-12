/**
 * Quick-replies instruction TUNING harness (manual, not in test:unit).
 *
 * Tests instruction variants against the SAME prompts, each variant in a
 * FRESH session (no cross-contamination). Winner = highest expect-compliance
 * with zero trivial-spurious. Costs ~28 real model prompts; run it as:
 *   npx tsx scripts/tune-suggest.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeCtl } from "../src/opencode.js";
import { extractOptionsMarker } from "../src/choices.js";

const CONSTRAINTS =
  "Give 2 or 3 options. Each option is something the USER would say next: first person, in the user's language, " +
  "at most 8 words, specific and complete on its own, because it is sent as their next message exactly as written. " +
  "Never offer options for greetings, one-line answers, or error messages. Do not number the options, " +
  "do not mention this line, and write nothing after it.";

type Variant = { name: string; instruction: string };
const VARIANTS: Variant[] = [
  {
    name: "V0-baseline",
    instruction:
      "When it helps the user continue, end your reply with ONE final line: `[OPTIONS: first | second | third]`. " +
      CONSTRAINTS,
  },
  {
    name: "V1-triggers",
    instruction:
      "End your reply with ONE final line: `[OPTIONS: first | second | third]` when your reply " +
      "(a) presents two or more distinct choices or directions, (b) asks the user to decide or pick, or " +
      "(c) suggests what to do next. If none of these applies, do not add the line. " +
      CONSTRAINTS,
  },
  {
    name: "V2-triggers-example",
    instruction:
      "End your reply with ONE final line: `[OPTIONS: first | second | third]` when your reply " +
      "(a) presents two or more distinct choices or directions, (b) asks the user to decide or pick, or " +
      "(c) suggests what to do next. If none of these applies, do not add the line. " +
      "Example — user asks how to store data for a small app; after your recommendation, end with:\n" +
      "[OPTIONS: Use a SQLite file | Use Postgres | Keep it in memory]\n" +
      CONSTRAINTS,
  },
  {
    name: "V3-must",
    instruction:
      "Whenever your reply involves a choice, a decision, or a next step, you MUST end it with ONE final line: " +
      "`[OPTIONS: first | second | third]`. " +
      CONSTRAINTS,
  },
];

type Prompt = { label: string; band: "expect" | "trivial" | "gray"; text: string };
const PROMPTS: Prompt[] = [
  {
    label: "E1 design choice",
    band: "expect",
    text:
      "I'm building a small REST API for a todo app and need to decide how to store data. " +
      "Suggest 2-3 reasonable directions (e.g. SQLite file, Postgres, in-memory) with one line of trade-off each. " +
      "Then stop — I will pick.",
  },
  {
    label: "E2 sequencing",
    band: "expect",
    text:
      "I need to ship two small things this week: a settings page and a bugfix for a flaky test. " +
      "Suggest how you would split and sequence that work. Keep it to a few short lines, then stop.",
  },
  {
    label: "E3 next step",
    band: "expect",
    text:
      "I just finished wiring up authentication for my web app. What should I work on next? " +
      "Suggest the most sensible next steps.",
  },
  { label: "T1 fact", band: "trivial", text: "What is the capital of France? Answer in one sentence." },
  { label: "T2 greeting", band: "trivial", text: "Hi! How's it going?" },
  {
    label: "T3 error",
    band: "trivial",
    text:
      "A build failed with: \"TypeError: Cannot read properties of undefined (reading 'map')\". " +
      "In 2-3 sentences, explain what usually causes this. Do not offer to do anything else.",
  },
  {
    label: "G1 file task",
    band: "gray",
    text:
      "In this directory, create a new file tune-marker.txt containing the single line: tune ok. " +
      "Actually create it now. End with a one-line confirmation.",
  },
];

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const oc = new OpenCodeCtl();
  const conn = await oc.connect();
  console.log(`connected: ${conn.url} (v${conn.version})`);

  const results: Record<string, Record<string, { marker: boolean; valid: boolean; n: number; reply: string }>> = {};
  for (const v of VARIANTS) {
    console.log(`\n═══ ${v.name} ═══`);
    const cwd = mkdtempSync(join(tmpdir(), "ocbot-tune-"));
    const sid = await oc.createSession(cwd);
    await oc.setInstruction(sid, "tgbot.suggest", v.instruction);
    results[v.name] = {};
    for (const p of PROMPTS) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120_000);
      let res;
      try {
        res = await oc.promptAndWait(sid, p.text, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      const reply = (res.reply ?? "").trim();
      const marker = extractOptionsMarker(reply);
      const present = reply.includes("[OPTIONS:");
      const row = { marker: present, valid: !!(marker && marker.options.length > 0), n: marker?.options.length ?? 0, reply };
      results[v.name][p.label] = row;
      const flag = row.valid ? `✓ ${row.n} opts` : present ? "INVALID" : "–";
      console.log(`  ${p.label.padEnd(14)} ${flag.padEnd(10)} ${reply.split("\n")[0].slice(0, 70)}`);
      if (row.valid) for (const o of marker!.options) console.log(`                   · ${o}`);
      await waitMs(400);
    }
  }

  console.log("\n\n════ SUMMARY ════");
  const header = "variant".padEnd(20) + "expect   trivial   gray";
  console.log(header);
  for (const v of VARIANTS) {
    const e = PROMPTS.filter((p) => p.band === "expect").map((p) => results[v.name][p.label].valid).filter(Boolean).length;
    const t = PROMPTS.filter((p) => p.band === "trivial").map((p) => results[v.name][p.label].marker).filter(Boolean).length;
    const g = PROMPTS.filter((p) => p.band === "gray").map((p) => results[v.name][p.label].marker).filter(Boolean).length;
    console.log(`${v.name.padEnd(20)} ${e}/3      ${t}/3       ${g}/1`);
  }
  console.log("\nexpect: marker offered where a decision/next-step exists (want high)");
  console.log("trivial: marker on greeting/fact/error (want 0)");
  console.log("gray: confirmation-style task (either way)");
  process.exit(0);
}

main().catch((e) => {
  console.error("tune harness failed:", e);
  process.exit(1);
});
