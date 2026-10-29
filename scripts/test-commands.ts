/**
 * Checks the command catalog (src/commands.ts) — the single source of truth
 * for the Telegram autocomplete menu, the /help card, and the button grid.
 * The tests pin the golden command set (mirrors the dispatcher in bot.ts +
 * orchestrator.ts) and catch the drift class that already cost two fixes
 * (/agents missing from menu+help, /reboot menu-only).
 *
 * Run:  npx tsx scripts/test-commands.ts
 */
import { COMMANDS, CMD_GROUPS, myCommands, helpText, commandGrid, knownCommands } from "../src/commands.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// The golden set: every command the dispatcher actually accepts (bot.ts
// handleCommand + orchestrator.ts handleCommand), minus /start (Telegram
// built-in, not part of the surface). Update deliberately when adding a command.
const GOLDEN = new Set([
  // session
  "setup", "new", "ls", "use", "close", "restore", "sync", "dir", "browse",
  // model
  "mode", "models", "model", "agents", "agent", "variants", "variant",
  // manager
  "spawn", "board", "kill", "stopall", "manager", "auto", "wt", "prune",
  // control
  "stop", "note", "context", "usage", "history", "status", "reboot", "clear", "schedule", "help",
]);
const GOLDEN_ALIASES = new Set(["sessions", "attach", "b", "modes", "ctx", "workers"]);

const cmds = COMMANDS.map((c) => c.cmd);

{
  const topicHelp = helpText("topic");
  check("topic help does not advertise session replacement", !topicHelp.includes("/new ") && !topicHelp.includes("/use "));
  check("topic menu omits lifecycle actions", !commandGrid("topic").inline_keyboard.flat().some((button) => ["cmd:new", "cmd:clear", "cmd:browse", "cmd:schedule"].includes(button.callback_data)));
  check("General help describes management, not an implicit LLM session", helpText("general").includes("General manages"));
}

// ── catalog integrity ────────────────────────────────────────────────────────
{
  check("no duplicate canonical commands", new Set(cmds).size === cmds.length, cmds.join(","));
  check("catalog == golden set (size)", new Set(cmds).size === GOLDEN.size, `catalog=${cmds.length} golden=${GOLDEN.size}`);
  const missing = [...GOLDEN].filter((c) => !cmds.includes(c));
  check("catalog == golden set (no missing)", missing.length === 0, missing.join(","));
  const extra = cmds.filter((c) => !GOLDEN.has(c));
  check("catalog == golden set (no extra)", extra.length === 0, extra.join(","));

  const groupIds = new Set(CMD_GROUPS.map((g) => g.id));
  check("every command has a valid group", COMMANDS.every((c) => groupIds.has(c.group)),
    COMMANDS.filter((c) => !groupIds.has(c.group)).map((c) => c.cmd).join(","));

  const badDesc = COMMANDS.filter((c) => !c.desc || c.desc.length > 60);
  check("every desc non-empty and ≤60 chars", badDesc.length === 0, badDesc.map((c) => `${c.cmd}:${c.desc.length}`).join(","));

  // Aliases: unique, and never colliding with a canonical name or another alias.
  const allNames = new Set<string>();
  let aliasOk = true;
  for (const c of COMMANDS) {
    for (const a of c.aliases ?? []) {
      if (allNames.has(a)) aliasOk = false;
      allNames.add(a);
    }
    allNames.add(c.cmd);
  }
  check("aliases unique & non-colliding", aliasOk);
  const missingAlias = [...GOLDEN_ALIASES].filter((a) => !knownCommands().has(a));
  check("golden aliases all present", missingAlias.length === 0, missingAlias.join(","));
}

// ── myCommands() (autocomplete) ──────────────────────────────────────────────
{
  const m = myCommands();
  check("autocomplete has one entry per command", m.length === COMMANDS.length, `${m.length} vs ${COMMANDS.length}`);
  check("autocomplete starts with help", m[0]?.command === "help");
  check("autocomplete names are clean (no slash)", m.every((x) => !x.command.startsWith("/")));
  check("autocomplete names unique", new Set(m.map((x) => x.command)).size === m.length);
  check("autocomplete descs match catalog", m.every((x) => {
    const c = COMMANDS.find((y) => y.cmd === x.command);
    return c && c.desc === x.description;
  }));
}

// ── helpText() ───────────────────────────────────────────────────────────────
{
  const h = helpText();
  const missing = [...GOLDEN].filter((c) => !h.includes(`/${c} `) && !h.endsWith(`/${c}`));
  check("help mentions every canonical command", missing.length === 0, missing.join(","));
  check("help has all four group headings", CMD_GROUPS.every((g) => h.includes(`<b>${g.title}</b>`)));
  check("help has the tips line", h.includes("Mẹo"));
  check("help ends with the button prompt", h.trimEnd().endsWith("chạy lệnh ngay:"));
  // Telegram HTML sanity: balanced <b>, no raw < or > outside entities.
  const opens = (h.match(/<b>/g) ?? []).length;
  const closes = (h.match(/<\/b>/g) ?? []).length;
  check("balanced <b> tags", opens === closes, `${opens} vs ${closes}`);
  check("arg hints escaped (use → &lt;id&gt;)", h.includes("/use &lt;id&gt; —"));
  const body = h.replace(/<b>/g, "").replace(/<\/b>/g, "").replace(/<code>/g, "").replace(/<\/code>/g, "");
  check("no raw < in text (all escaped)", !body.includes("<"));
  const badGt = [...body.matchAll(/>/g)].filter((m) => !(m.index! >= 2 && body.slice(m.index! - 2, m.index!) === "&g"));
  check("raw > only inside &gt; entities", badGt.length === 0, body);
  check("help length < 4096 (Telegram limit)", h.length < 4096, `${h.length} chars`);
}

// ── commandGrid() (buttons) ──────────────────────────────────────────────────
{
  const grid = commandGrid();
  const buttons = grid.inline_keyboard.flat();
  const withButton = COMMANDS.filter((c) => c.button).length;
  check("grid has one button per catalog button", buttons.length === withButton, `${buttons.length} vs ${withButton}`);
  check("every grid button maps to a catalog command", buttons.every((b) => {
    const name = b.callback_data.replace(/^cmd:/, "");
    return COMMANDS.some((c) => c.cmd === name && c.button === b.text);
  }));
  check("every row has 1–2 buttons", grid.inline_keyboard.every((r) => r.length >= 1 && r.length <= 2));
  check("grid includes help", buttons.some((b) => b.callback_data === "cmd:help"));
  check("grid includes agents (regression: was missing)", buttons.some((b) => b.callback_data === "cmd:agents"));
  check("grid includes reboot (regression: menu-only before)", buttons.some((b) => b.callback_data === "cmd:reboot"));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll command-catalog checks passed.");
