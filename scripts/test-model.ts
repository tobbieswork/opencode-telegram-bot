/**
 * Unit test: the model / mode / variant feature module (src/commands/model.ts,
 * moved out of bot.ts — docs/sdd/split-bot-ts.md T4).
 *
 * Covers the pure renderers (renderModelPage, renderModePicker, currentMode),
 * the shared primitives (resolveModel, applyModelAndVariant, applyMode,
 * applyVariant) and the command + callback glue, driven through a real `Bot`
 * with fake `tg`/`oc` — same harness as test-perm-relay.ts.
 *
 * Run:  npx tsx scripts/test-model.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { StateManager } from "../src/state.js";
import { convKey } from "../src/conv.js";
import type { ModelInfo } from "../src/opencode.js";
import {
  cmdModels,
  cmdModel,
  handleModelCallback,
  showModelPicker,
  renderModelPage,
  renderModePicker,
  currentMode,
  cmdMode,
  handleModeCallback,
  cmdVariants,
  cmdVariantSet,
  applyVariant,
  handleVariantCallback,
  resolveModel,
  applyModelAndVariant,
  applyMode,
} from "../src/commands/model.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const M = (id: string, providerID = "prov", name?: string): ModelInfo => ({ id, providerID, name, variants: [] });
const MODELS3 = [M("alpha"), M("beta"), M("gamma")];
const MODELS12 = Array.from({ length: 12 }, (_, i) => M(`m${i}`));

interface Rec {
  sent: { conv: string; text: string; kb?: unknown }[];
  edits: { conv: string; msgId: number; text?: string; kb?: unknown }[];
  deleted: number[];
  answers: { id: string; text?: string }[];
  markupRemoved: number[];
}

function makeBot() {
  const base = mkdtempSync(join(tmpdir(), "tg-model-"));
  const st = new StateManager(join(base, "state.json"));
  const rec: Rec = { sent: [], edits: [], deleted: [], answers: [], markupRemoved: [] };
  const tg: any = {
    sendMessage: async (conv: string, text: string, opts?: { reply_markup?: unknown }) => {
      rec.sent.push({ conv, text, kb: opts?.reply_markup });
      return rec.sent.length;
    },
    sendMessageId: async () => 1,
    editMessageText: async (conv: string, msgId: number, text?: string, opts?: { reply_markup?: unknown }) => {
      rec.edits.push({ conv, msgId, text, kb: opts?.reply_markup });
    },
    editMessageReplyMarkup: async (_conv: string, msgId: number) => {
      rec.markupRemoved.push(msgId);
    },
    deleteMessage: async (_conv: string, msgId: number) => {
      rec.deleted.push(msgId);
    },
    answerCallbackQuery: async (id: string, text?: string) => {
      rec.answers.push({ id, text });
    },
  };
  const setModelCalls: { sid: string; model: any }[] = [];
  const setAgentCalls: { sid: string; agent: string }[] = [];
  const getSessionCalls: string[] = [];
  const oc: any = {
    listModels: async () => MODELS3,
    getSession: async (sid: string) => {
      getSessionCalls.push(sid);
      return null;
    },
    getSessionModel: async () => undefined,
    getVariants: async () => ["low", "high"],
    setModel: async (sid: string, model: any) => {
      setModelCalls.push({ sid, model });
    },
    setAgent: async (sid: string, agent: string) => {
      setAgentCalls.push({ sid, agent });
    },
  };
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
    defaultVariant: "default",
    opencodeDirectory: "/tmp/opencode",
  };
  const bot = new Bot(tg, oc, st, cfg);
  return { bot, st, rec, setModelCalls, setAgentCalls, getSessionCalls };
}

const CONV = convKey(42);
const CONV2 = convKey(43);
const CONV3 = convKey(44);
const CB = (data: string, id = "cb1"): any => ({ id, data, from: { id: 42 } });

async function main(): Promise<void> {
  // ── renderModelPage (pure) ─────────────────────────────────────────────
  {
    const v = renderModelPage(MODELS12, 0, undefined, "m1");
    const rows = v.keyboard.inline_keyboard;
    check("renderModelPage: 5 model rows + nav + close", rows.length === 7, `rows=${rows.length}`);
    check("renderModelPage: sel callback_data", rows[0][0].callback_data === "mdl:sel:0" && rows[4][1].callback_data === "mdl:sel:9");
    check("renderModelPage: current model marked", rows[0][1].text === "▶️ m1", rows[0][1].text);
    check("renderModelPage: nav row (page 0: no prev)", rows[5][0].callback_data === "mdl:noop" && rows[5][1].callback_data === "mdl:pg:1");
    check("renderModelPage: close row", rows[6][0].callback_data === "mdl:close");
    check("renderModelPage: page hint", v.text.includes("1/2"));

    const last = renderModelPage(MODELS12, 99); // clamped to the last page
    const lrows = last.keyboard.inline_keyboard;
    check("renderModelPage: page clamped to last", last.text.includes("2/2") && lrows[1][0].callback_data === "mdl:pg:0", last.text);

    const one = renderModelPage(MODELS3, 0);
    check("renderModelPage: single page has no nav row", one.keyboard.inline_keyboard.length === 3);

    const err = renderModelPage(MODELS3, 0, "❌ boom");
    check("renderModelPage: error note wins over default text", err.text.startsWith("❌ boom"));
  }

  // ── renderModePicker / currentMode (pure) ──────────────────────────────
  {
    check("currentMode: derived from agent", currentMode({ agent: "plan" } as any) === "plan");
    check("currentMode: no agent → undefined", currentMode({} as any) === undefined);
    check("currentMode: unknown agent → undefined", currentMode({ agent: "nope" } as any) === undefined);

    const v = renderModePicker({ agent: "plan" } as any, "en");
    const rows = v.keyboard.inline_keyboard;
    check("renderModePicker: 2 mode rows + info/close row", rows.length === 3, `rows=${rows.length}`);
    check("renderModePicker: current mode marked", rows[0][1].text === "▶️ plan", JSON.stringify(rows[0]));
    check("renderModePicker: info + close buttons", rows[2][0].callback_data === "mode:info" && rows[2][1].callback_data === "mode:close");
    check("renderModePicker: header names the current mode", v.text.includes("Choose a mode") && v.text.includes("<b>plan</b>"));
  }

  // ── resolveModel / applyModelAndVariant (shared primitives) ────────────
  {
    const { bot, st, getSessionCalls } = makeBot();
    st.set(CONV, { model: { id: "explicit", providerID: "p" } });
    const r1 = await resolveModel(bot, st.get(CONV), "ses_1");
    check("resolveModel: explicit state.model wins", r1?.id === "explicit" && getSessionCalls.length === 0);

    (bot as any).cfg.defaultModel = { id: "dm", providerID: "p" };
    const r2 = await resolveModel(bot, {}, "ses_1");
    check("resolveModel: falls back to cfg.defaultModel", r2?.id === "dm");

    (bot as any).cfg.defaultModel = undefined;
    (bot as any).oc.getSession = async () => ({ model: { id: "sm", providerID: "sp" } });
    const r3 = await resolveModel(bot, {}, "ses_1");
    check("resolveModel: falls back to the session's live model", r3?.id === "sm" && r3?.providerID === "sp");

    (bot as any).oc.getSession = async () => null;
    const r4 = await resolveModel(bot, {}, "ses_1");
    check("resolveModel: nothing set → null", r4 === null);

    const b2 = makeBot();
    b2.st.set(CONV, { model: { id: "m1", providerID: "p" }, variant: "hi", sessionID: "ses_1" });
    await applyModelAndVariant(b2.bot, "ses_1", b2.st.get(CONV));
    check("applyModelAndVariant: sets model + explicit variant", b2.setModelCalls.length === 1 && b2.setModelCalls[0].model.variant === "hi", JSON.stringify(b2.setModelCalls));

    b2.st.set(CONV2, { model: { id: "m1", providerID: "p" }, sessionID: "ses_2" });
    await applyModelAndVariant(b2.bot, "ses_2", b2.st.get(CONV2));
    check("applyModelAndVariant: defaults to cfg.defaultVariant", b2.setModelCalls[1]?.model.variant === "default", JSON.stringify(b2.setModelCalls[1]));

    b2.st.set(CONV3, { sessionID: "ses_3" });
    (b2.bot as any).oc.getSession = async () => null;
    await applyModelAndVariant(b2.bot, "ses_3", b2.st.get(CONV3));
    check("applyModelAndVariant: no resolvable model → no setModel", b2.setModelCalls.length === 2, `len=${b2.setModelCalls.length}`);
  }

  // ── applyMode / applyVariant (shared primitives) ───────────────────────
  {
    const { bot, st, setAgentCalls, setModelCalls } = makeBot();
    st.set(CONV, { sessionID: "ses_1" });
    await applyMode(bot, CONV, st.get(CONV), "plan");
    check("applyMode: persists agent + sets it on the session", st.get(CONV).agent === "plan" && setAgentCalls.length === 1 && setAgentCalls[0].agent === "plan");

    st.set(CONV2, {});
    await applyMode(bot, CONV2, st.get(CONV2), "general");
    check("applyMode: no session → persist only", st.get(CONV2).agent === "general" && setAgentCalls.length === 1, `agent=${st.get(CONV2).agent} setAgent=${setAgentCalls.length}`);

    const h1 = await applyVariant(bot, CONV2, "low");
    check("applyVariant: no session → 'applies on /new', no setModel", h1 === "applies on /new" && st.get(CONV2).variant === "low" && setModelCalls.length === 0);
  }

  // ── /models ────────────────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { model: { id: "beta", providerID: "prov" } });
    await cmdModels(bot, CONV);
    check("cmdModels: single page, header + footer", rec.sent.length === 1 && rec.sent[0].text.startsWith("<b>Models (3)</b>") && rec.sent[0].text.includes("Set with /model &lt;id&gt;"));
    check("cmdModels: current model marked", rec.sent[0].text.includes("▶️ <code>beta</code>"), rec.sent[0].text);

    const b2 = makeBot();
    (b2.bot as any).cfg.replyMaxLen = 60; // force pagination
    await cmdModels(b2.bot, CONV);
    check("cmdModels: tight budget splits into pages", b2.rec.sent.length >= 2, `sends=${b2.rec.sent.length}`);
    check("cmdModels: footer only on the last page", !b2.rec.sent[0].text.includes("Set with /model") && b2.rec.sent[b2.rec.sent.length - 1].text.includes("Set with /model"));
  }

  // ── /model ─────────────────────────────────────────────────────────────
  {
    const { bot, st, rec, setModelCalls } = makeBot();
    await cmdModel(bot, CONV, "", {});
    check("cmdModel: no arg → picker opens", (bot as any).modelPickers.has(CONV) && rec.sent[0].kb !== undefined);

    rec.sent.length = 0;
    await cmdModel(bot, CONV, "zzz", {});
    check("cmdModel: unknown arg → picker with error note", rec.sent[0].text.includes("Unknown model") && (bot as any).modelPickers.has(CONV));

    (bot as any).modelPickers.clear();
    rec.sent.length = 0;
    st.set(CONV, { sessionID: "ses_2" });
    await cmdModel(bot, CONV, "beta", st.get(CONV));
    check("cmdModel: valid arg + session → model set + applied", st.get(CONV).model?.id === "beta" && setModelCalls.length === 1 && setModelCalls[0].sid === "ses_2" && rec.sent[0].text.includes("✅ Model → <code>beta</code>"));

    const b2 = makeBot();
    b2.st.set(CONV, {});
    await cmdModel(b2.bot, CONV, "alpha", b2.st.get(CONV));
    check("cmdModel: valid arg, no session → persisted for /new", b2.st.get(CONV).model?.id === "alpha" && b2.setModelCalls.length === 0 && b2.rec.sent[0].text.includes("✅ Model → <code>alpha</code>"));
  }

  // ── mdl: callbacks ─────────────────────────────────────────────────────
  {
    const { bot, st, rec, setModelCalls } = makeBot();
    st.set(CONV, { sessionID: "ses_3" });
    await showModelPicker(bot, CONV, MODELS12, 0);

    await handleModelCallback(bot, CB("mdl:pg:1"), CONV, 500);
    check("mdl:pg: re-renders the next page in place", rec.edits[0]?.msgId === 500 && rec.edits[0].text!.includes("2/2") && (bot as any).modelPickers.get(CONV)?.page === 1);

    await handleModelCallback(bot, CB("mdl:noop"), CONV, 500);
    check("mdl:noop: answered, nothing edited", rec.answers.length === 2 && rec.edits.length === 1);

    await handleModelCallback(bot, CB("mdl:sel:1"), CONV, 500);
    check("mdl:sel: applies the model, closes the picker, settles the card", st.get(CONV).model?.id === "m1" && setModelCalls.length === 1 && !(bot as any).modelPickers.has(CONV) && rec.edits[1]?.msgId === 500 && rec.answers[2].text === "Model → m1");

    await showModelPicker(bot, CONV, MODELS3, 0);
    await handleModelCallback(bot, CB("mdl:sel:99"), CONV, 500);
    check("mdl:sel: stale index → answered as an error, picker kept", rec.answers.length === 4 && rec.answers[3].text?.startsWith("⚠️") && (bot as any).modelPickers.has(CONV));

    await handleModelCallback(bot, CB("mdl:close"), CONV, 500);
    check("mdl:close: deletes the card, drops the picker", rec.deleted.includes(500) && !(bot as any).modelPickers.has(CONV));

    const b2 = makeBot();
    await handleModelCallback(b2.bot, CB("mdl:sel:0"), CONV2, 500);
    check("mdl:* with no open picker → friendly hint, no crash", b2.rec.answers.length === 1 && b2.rec.answers[0].text !== undefined);
  }

  // ── /mode ──────────────────────────────────────────────────────────────
  {
    const { bot, st, rec, setAgentCalls } = makeBot();
    await cmdMode(bot, CONV, "", {});
    check("cmdMode: no arg → picker card", rec.sent[0].kb !== undefined && JSON.stringify(rec.sent[0].kb).includes("mode:build"));

    st.set(CONV, { sessionID: "ses_4" });
    rec.sent.length = 0;
    await cmdMode(bot, CONV, "plan", st.get(CONV));
    check("cmdMode: valid → agent persisted + applied", st.get(CONV).agent === "plan" && setAgentCalls.length === 1 && rec.sent[0].text.includes("✅ Mode → <b>plan</b>"));

    rec.sent.length = 0;
    await cmdMode(bot, CONV, "bogus", st.get(CONV));
    check("cmdMode: unknown → error + picker kept", rec.sent[0].text.includes("Unknown mode") && rec.sent[0].kb !== undefined);
  }

  // ── mode: callbacks ────────────────────────────────────────────────────
  {
    const { bot, st, rec, setAgentCalls } = makeBot();
    st.set(CONV, { sessionID: "ses_5" });
    await handleModeCallback(bot, CB("mode:info"), CONV, 600);
    check("mode:info: sends the role list", rec.sent.length === 1 && rec.sent[0].text.includes("<code>build</code>"));

    await handleModeCallback(bot, CB("mode:explore"), CONV, 600);
    check("mode:explore: switches + settles the card", st.get(CONV).agent === "explore" && setAgentCalls.length === 1 && rec.edits.length === 1 && rec.answers[1].text === "Mode → explore");

    await handleModeCallback(bot, CB("mode:explore"), CONV, 600); // already current → no re-edit
    check("mode:* (already current): no duplicate edit", rec.edits.length === 1);

    await handleModeCallback(bot, CB("mode:close"), CONV, 600);
    check("mode:close: deletes the card", rec.deleted.includes(600));
  }

  // ── /variants ──────────────────────────────────────────────────────────
  {
    const { bot, st, rec, setModelCalls } = makeBot();
    st.set(CONV, { model: { id: "m1", providerID: "p" }, variant: "low", sessionID: "ses_6" });
    await cmdVariants(bot, CONV, "", st.get(CONV));
    check("cmdVariants: no arg → lists variants, marks current", rec.sent[0].text.includes("▶️ <code>low</code>") && rec.sent[0].text.includes("<code>high</code>") && rec.sent[0].text.includes("<code>m1</code>"));

    rec.sent.length = 0;
    await cmdVariants(bot, CONV, "high", st.get(CONV));
    check("cmdVariants: valid → persisted + applied", st.get(CONV).variant === "high" && setModelCalls.length === 1 && setModelCalls[0].model.variant === "high" && rec.sent[0].text.includes("✅ Variant → <code>high</code>"));

    rec.sent.length = 0;
    await cmdVariants(bot, CONV, "bogus", st.get(CONV));
    check("cmdVariants: unknown → lists available", rec.sent[0].text.includes("Unknown variant") && st.get(CONV).variant === "high");

    const b2 = makeBot();
    await cmdVariants(b2.bot, CONV2, "", {});
    check("cmdVariants: no model set → hint line", b2.rec.sent[0].text.includes("no variants reported") && b2.rec.sent[0].text.includes("no model set"));
  }

  // ── /variant (picker) ──────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { model: { id: "m1", providerID: "p" }, variant: "low", sessionID: "ses_7" });
    await cmdVariantSet(bot, CONV, "", st.get(CONV));
    const kb = JSON.stringify(rec.sent[0].kb);
    check("cmdVariantSet: no arg → picker card", kb.includes("variant:low") && kb.includes("variant:high"));

    rec.sent.length = 0;
    await cmdVariantSet(bot, CONV, "bogus", st.get(CONV));
    check("cmdVariantSet: unknown arg → picker with error note", rec.sent[0].text.includes("Unknown variant") && JSON.stringify(rec.sent[0].kb).includes("variant:high"));

    rec.sent.length = 0;
    await cmdVariantSet(bot, CONV, "high", st.get(CONV));
    check("cmdVariantSet: valid → applied directly (no picker)", st.get(CONV).variant === "high" && rec.sent[0].text.includes("✅ Variant → <code>high</code>"));

    const b2 = makeBot(); // model reports no variants → plain text path (delegates to /variants)
    (b2.bot as any).oc.getVariants = async () => [];
    b2.st.set(CONV2, { model: { id: "m1", providerID: "p" } });
    await cmdVariantSet(b2.bot, CONV2, "", b2.st.get(CONV2));
    check("cmdVariantSet: no variants for the model → plain text list", b2.rec.sent[0].kb === undefined);
  }

  // ── variant: callbacks ─────────────────────────────────────────────────
  {
    const { bot, st, rec } = makeBot();
    st.set(CONV, { model: { id: "m1", providerID: "p" }, sessionID: "ses_8" });
    await handleVariantCallback(bot, CB("variant:low"), CONV, 700);
    check("variant:<id>: applies + settles the card", st.get(CONV).variant === "low" && rec.edits[0]?.msgId === 700 && rec.answers[0].text === "Variant → low");

    await handleVariantCallback(bot, CB("variant:close"), CONV, 700);
    check("variant:close: deletes the card", rec.deleted.includes(700));
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll model checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
