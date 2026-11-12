/**
 * R0 spike (docs/sdd/quick-replies.md): MODEL COMPLIANCE for the quick-replies
 * instruction. Manual, NOT in test:unit — it costs a handful of real model
 * prompts against the live OpenCode service.
 *
 * Attaches the exact SUGGEST_INSTRUCTION to a fresh session (the same
 * setInstruction mechanism applySuggestPin uses — which also confirms session
 * instructions apply to Manager-style sessions) and runs six representative
 * prompts. For each it records: marker present, marker valid
 * (extractOptionsMarker), option count + lengths. Relevance is assessed by
 * eye — every reply is printed in full.
 *
 * Suggested bar to switch the default (spec section 5): valid, relevant
 * options on ≥80% of the SUBSTANTIVE replies (design question, code change,
 * manager-style), none on the trivial ones (greeting, error, simple fact).
 *
 * Run:  npx tsx scripts/spike-suggest.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeCtl } from "../src/opencode.js";
import { extractOptionsMarker } from "../src/choices.js";
import { SUGGEST_INSTRUCTION, SUGGEST_KEY } from "../src/suggest.js";

const PROMPTS: Array<{ label: string; kind: "substantive" | "trivial"; text: string }> = [
  {
    label: "design question (substantive)",
    kind: "substantive",
    text:
      "I'm building a small REST API for a todo app and need to decide how to store data. " +
      "Suggest 2-3 reasonable directions (e.g. SQLite file, Postgres, in-memory) with one line of trade-off each. " +
      "Then stop — I will pick.",
  },
  {
    label: "code change (substantive)",
    kind: "substantive",
    text:
      "In this directory, create a new file spike-marker.txt containing the single line: spike ok. " +
      "Actually create it now. End with a one-line confirmation.",
  },
  {
    label: "trivial fact question",
    kind: "trivial",
    text: "What is the capital of France? Answer in one sentence.",
  },
  {
    label: "greeting",
    kind: "trivial",
    text: "Hi! How's it going?",
  },
  {
    label: "error reply",
    kind: "trivial",
    text:
      'A build failed with: "TypeError: Cannot read properties of undefined (reading \'map\')". ' +
      "In 2-3 sentences, explain what usually causes this. Do not offer to do anything else.",
  },
  {
    label: "manager-style request (substantive)",
    kind: "substantive",
    text:
      "I need to ship two small things this week: a settings page and a bugfix for a flaky test. " +
      "Suggest how you would split and sequence that work. Keep it to a few short lines, then stop.",
  },
];

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const oc = new OpenCodeCtl();
  const conn = await oc.connect();
  console.log(`connected: ${conn.url} (v${conn.version})`);
  const cwd = mkdtempSync(join(tmpdir(), "ocbot-spike-"));
  const sid = await oc.createSession(cwd);
  await oc.setInstruction(sid, SUGGEST_KEY, SUGGEST_INSTRUCTION);
  console.log(`instruction "${SUGGEST_KEY}" applied to ${sid}\n`);

  let substantive = 0;
  let substantiveShown = 0;
  let trivialShown = 0;
  let trivialTotal = 0;
  for (const p of PROMPTS) {
    console.log(`── ${p.label} ──`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    let res;
    try {
      res = await oc.promptAndWait(sid, p.text, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    const reply = (res.reply ?? "").trim();
    for (const line of reply.split("\n")) console.log("  " + line);
    const marker = extractOptionsMarker(reply);
    const present = reply.includes("[OPTIONS:");
    if (marker && marker.options.length > 0) {
      if (p.kind === "substantive") substantiveShown++;
      else trivialShown++;
      console.log(
        `  → marker VALID: ${marker.options.length} option(s)` +
          marker.options.map((o, i) => `\n      [${i}] (${o.length} chars) ${o}`).join(""),
      );
    } else if (present) {
      console.log(`  → marker PRESENT but invalid (the reply is sent as-is, no buttons)`);
    } else {
      console.log(`  → no marker`);
    }
    if (p.kind === "substantive") substantive++;
    else trivialTotal++;
    console.log("");
    await waitMs(500);
  }
  console.log("── summary ──");
  console.log(`substantive replies:        ${substantiveShown}/${substantive} offered valid options`);
  console.log(`trivial replies with marker: ${trivialShown}/${trivialTotal} (spec expects ~0)`);
  console.log(`spec bar: ≥80% of substantive with valid, RELEVANT options (relevance: read above) and none on trivial`);
  process.exit(0);
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
