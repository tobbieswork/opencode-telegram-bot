/**
 * Focused harness for W4 / I10 (docs/sdd/background-workers.md): the
 * Manager's background-vs-live auto-decision policy lives in the prompt
 * that becomes data/manager/<chat>/.opencode/agents/tg-manager.md
 * (MANAGER_PROMPT in src/orchestrator.ts, written by ensureManagerTooling).
 *
 * Asserts the policy is present and complete:
 *  - BACKGROUND for small / well-scoped / low-risk tasks;
 *  - LIVE for big / long / high-risk / watch-worthy work;
 *  - when in doubt, LIVE;
 *  - the Manager ALWAYS announces which mode it picked;
 *  - the `background: true` spawn option is documented;
 *  - the frontmatter tool denials (execute/edit/shell/subagent) are intact
 *    (the policy must not loosen the Manager's own permissions).
 *
 * Run:  npx tsx scripts/test-manager-policy.ts
 */
import { MANAGER_PROMPT } from "../src/orchestrator.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const prompt = MANAGER_PROMPT(5);
const low = (s: string) => s.toLowerCase();

// The policy section: from the mode heading to the next section heading.
const after = prompt.split(/##\s+Mode/i)[1] ?? "";
const modeSection = after.split(/\n##\s/)[0] ?? after;
const lowMode = low(modeSection);

// ── the auto-decision criteria ──────────────────────────────────────────────
check("policy section exists in the Manager prompt", modeSection.length > 0);
check("background = small tasks", lowMode.includes("small"));
check("background = well-scoped tasks", lowMode.includes("well-scoped"));
check("background = low-risk tasks", lowMode.includes("low-risk"));
check("live = big tasks", /big\b/.test(lowMode));
check("live = long-running tasks", lowMode.includes("long"));
check("live = high-risk work", lowMode.includes("high-risk"));
check("live = watch-worthy work", lowMode.includes("watch"));
check("tie-break: when in doubt, pick live", /when in doubt/.test(lowMode) && /doubt.*live|live.*doubt/.test(lowMode.replace(/\n/g, " ")));

// ── "always announce the mode" ─────────────────────────────────────────────
const announces = /always[^\n]*(tell|say|announce)[^\n]*mode/i.test(prompt);
check("the Manager must ALWAYS announce the picked mode", announces, prompt.match(/always[^\n]*/gi)?.join(" | "));

// ── the spawn option is documented ──────────────────────────────────────────
check("the `background: true` spawn option is documented", lowMode.includes("background: true"));
check("background = no topic, result relayed to the main chat", /no (telegram )?topic/.test(lowMode.replace(/\n/g, " ")) && lowMode.includes("main chat"));

// ── frontmatter denials intact (the policy must not loosen permissions) ─────
for (const tool of ["execute", "edit", "shell", "subagent"]) {
  const denied = new RegExp(`action: ${tool}\\n[\\s\\S]*?effect: deny`).test(prompt);
  check(`frontmatter still denies ${tool}`, denied);
}

// ── the tool list is intact ─────────────────────────────────────────────────
for (const t of [
  "tg-bridge_list_directories",
  "tg-bridge_list_workers",
  "tg-bridge_spawn_worker",
  "tg-bridge_send_to_worker",
  "tg-bridge_get_worker_result",
  "tg-bridge_stop_worker",
]) {
  check(`tool list still documents ${t}`, prompt.includes(t));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
