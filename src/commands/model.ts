/**
 * Model / mode / variant feature: `/models`, `/model`, `/mode`, `/modes`,
 * `/variants`, `/variant` and their `mdl:` / `mode:` / `variant:` callbacks,
 * plus the shared primitives `resolveModel`, `applyModelAndVariant`,
 * `applyMode` and `applyVariant`. Moved out of bot.ts (docs/sdd/split-bot-ts.md,
 * T4). The feature talks to the bot only through the narrow `BotCtx`
 * interface; `Bot` satisfies it structurally so behaviour is unchanged.
 * `resolveModel` / `applyModelAndVariant` are shared across features
 * (session, rotation, browse, prompt-runner) and stay reachable via `BotCtx`
 * (thin delegates on `Bot`).
 */
import type { BotCtx } from "./ctx.js";
import type { CallbackQuery } from "../telegram.js";
import type { ConvKey } from "../conv.js";
import type { ChatState, Lang } from "../state.js";
import type { ModelInfo } from "../opencode.js";
import type { Btn, Keyboard } from "../shared.js";
import { esc, trunc } from "../format.js";
import { tr } from "../i18n.js";
import { warn, error } from "../logger.js";

/**
 * Curated modes — a friendly front-end over the OpenCode agent (the thing
 * that actually changes behaviour), so `/mode` is a higher-level front-end
 * over `/agent` for the two workflows people switch between most: planning
 * vs building. The current mode is derived from the session's agent, so
 * /agent and /mode can never disagree.
 */
const MODES: Record<string, { agent: string; hint: string; hintEn: string }> = {
  build: { agent: "build", hint: "mặc định — viết & sửa code theo permission", hintEn: "default — writes & edits code per permissions" },
  plan: { agent: "plan", hint: "chỉ phân tích & lên kế hoạch — không sửa code", hintEn: "analysis & planning only — no code edits" },
  general: { agent: "general", hint: "đa dụng: research, multi-step, chạy song song", hintEn: "general purpose: research, multi-step, parallel" },
  explore: { agent: "explore", hint: "duyệt codebase nhanh (tìm file/keyword)", hintEn: "fast codebase scan (find files/keywords)" },
};

/** Models shown per page in the /model button picker. */
const MODEL_PAGE_SIZE = 10;

/** Resolves which model to apply from state (shared primitive; also called by rotation/browse/session). */
export async function resolveModel(ctx: BotCtx, state: ChatState, sessionID?: string): Promise<{ id: string; providerID: string } | null> {
  if (state.model) return state.model;
  if (ctx.cfg.defaultModel) return ctx.cfg.defaultModel;
  if (sessionID) {
    const s = await ctx.oc.getSession(sessionID).catch(() => null);
    if (s?.model?.id && s?.model?.providerID) return { id: s.model.id, providerID: s.model.providerID };
  }
  return null;
}

/** Apply the chat's model + effective variant to a session (best-effort, non-fatal). */
export async function applyModelAndVariant(ctx: BotCtx, sessionID: string, state: ChatState): Promise<void> {
  const model = await resolveModel(ctx, state, sessionID);
  if (!model) return;
  const variant = state.variant ?? ctx.cfg.defaultVariant;
  await ctx.oc.setModel(sessionID, { ...model, variant }).catch((e) => warn("applyModelAndVariant:", e?.message));
}

/** `/models` — list available models. */
export async function cmdModels(ctx: BotCtx, conv: ConvKey): Promise<void> {
  const models = await ctx.oc.listModels();
  const cur = ctx.st.get(conv).model?.id;
  const max = ctx.cfg.replyMaxLen;
  const footer = "\n\nSet with /model &lt;id&gt;";
  // Show EVERY model, packed into ≤max-char pages on line boundaries so each
  // message is valid HTML with balanced tags (no mid-tag cuts → no 400s).
  const units = [
    `<b>Models (${models.length})</b>`,
    ...models.map((m) => `${cur === m.id ? "▶️ " : ""}<code>${m.id}</code>${m.name ? ` — ${esc(m.name)}` : ""}`),
  ];
  const pages: string[] = [];
  let page = "";
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const final = i === units.length - 1;
    const budget = max - (final ? footer.length : 0);
    if (page && (page + "\n" + unit).length > budget) {
      pages.push(page);
      page = unit;
    } else {
      page = page ? page + "\n" + unit : unit;
    }
  }
  if (page) pages.push(page + footer);
  for (const p of pages) await ctx.tg.sendMessage(conv, p);
}

/**
 * `/model [id]` — set the model. Without a valid argument the user gets a
 * paged button picker (10 models/page) instead of the text list.
 */
export async function cmdModel(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  void state;
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  let models: ModelInfo[];
  try {
    models = await ctx.oc.listModels();
  } catch (e) {
    return ctx.tg.sendMessage(conv, tr(lang, `⚠️ Không liệt kê được model: ${(e as Error).message}`, `⚠️ Couldn't list models: ${(e as Error).message}`));
  }
  if (!arg) return showModelPicker(ctx, conv, models, 0, undefined, lang);
  const m = models.find((x) => x.id === arg || `${x.providerID}/${x.id}` === arg);
  if (!m) return showModelPicker(ctx, conv, models, 0, tr(lang, `❌ Unknown model: <code>${esc(arg)}</code>`, `❌ Unknown model: <code>${esc(arg)}</code>`), lang);
  await applyModelPick(ctx, conv, m);
  await ctx.tg.sendMessage(conv, tr(lang, `✅ Model → <code>${esc(m.id)}</code> (${ctx.st.get(conv).sessionID ? "đã áp dụng cho session hiện tại" : "áp dụng khi /new"})`, `✅ Model → <code>${esc(m.id)}</code> (${ctx.st.get(conv).sessionID ? "applied to current session" : "applies on /new"})`));
}

/** Apply the model choice (shared by the typed command and the picker buttons). */
export async function applyModelPick(ctx: BotCtx, conv: ConvKey, m: ModelInfo): Promise<void> {
  ctx.st.set(conv, { model: { id: m.id, providerID: m.providerID } });
  const sid = ctx.st.get(conv).sessionID;
  if (sid) await applyModelAndVariant(ctx, sid, ctx.st.get(conv));
}

/** The text + keyboard for one page of the /model picker. */
export function renderModelPage(models: ModelInfo[], page: number, errorNote?: string, curId?: string, lang: Lang = "vi"): { text: string; keyboard: Keyboard } {
  const pageCount = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
  const p = Math.max(0, Math.min(page, pageCount - 1));
  const slice = models.slice(p * MODEL_PAGE_SIZE, (p + 1) * MODEL_PAGE_SIZE);
  const rows: Btn[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(
      slice.slice(i, i + 2).map((m, j) => ({
        text: `${curId === m.id ? "▶️ " : ""}${trunc(m.id, 28)}`,
        callback_data: `mdl:sel:${p * MODEL_PAGE_SIZE + i + j}`,
      })),
    );
  }
  if (pageCount > 1) {
    const nav: Btn[] = [];
    if (p > 0) nav.push({ text: "⬅️", callback_data: `mdl:pg:${p - 1}` });
    nav.push({ text: `${p + 1}/${pageCount}`, callback_data: "mdl:noop" });
    if (p < pageCount - 1) nav.push({ text: "➡️", callback_data: `mdl:pg:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: "mdl:close" }]);
  return {
    text: [errorNote ?? tr(lang, "❓ <b>/model</b> cần tên model", "❓ <b>/model</b> needs a model name"), `<i>${tr(lang, "trang", "page")} ${p + 1}/${pageCount} · Hoặc gửi: <code>/model &lt;id&gt;</code></i>`].join("\n"),
    keyboard: { inline_keyboard: rows },
  };
}

/** Open the model picker (or re-show it after a bad argument) and remember the model list. */
export async function showModelPicker(ctx: BotCtx, conv: ConvKey, models: ModelInfo[], page: number, errorNote?: string, lang: Lang = "vi"): Promise<void> {
  const pageCount = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
  const p = Math.max(0, Math.min(page, pageCount - 1));
  ctx.modelPickers.set(conv, { models, page: p });
  const v = renderModelPage(models, p, errorNote, ctx.st.get(conv).model?.id, lang);
  await ctx.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
}

/** Handle a tap on the /model picker (data = `mdl:sel:<i>` / `mdl:pg:<n>` / `mdl:close` / `mdl:noop`). */
export async function handleModelCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number, answer: (toast?: string) => void = (t) => { void ctx.tg.answerCallbackQuery(cb.id, t).catch(() => {}); }): Promise<void> {
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const [, op, arg] = (cb.data ?? "").split(":");
  if (op === "close") {
    ctx.modelPickers.delete(conv);
    answer();
    if (messageId) await ctx.tg.deleteMessage(conv, messageId).catch(() => {});
    return;
  }
  const mp = ctx.modelPickers.get(conv);
  if (!mp) {
    answer(tr(lang, "Danh sách model đã đóng — gửi /model để mở lại.", "The model list was closed — send /model to open it again."));
    return;
  }
  try {
    if (op === "sel") {
      const m = mp.models[Number(arg)];
      if (!m) throw new Error(tr(lang, "Model không còn trong danh sách — gửi /model để mở lại.", "The model is no longer in the list — send /model to open it again."));
      await applyModelPick(ctx, conv, m);
      ctx.modelPickers.delete(conv);
      answer(`Model → ${trunc(m.id, 40)}`);
      if (messageId) await ctx.tg.editMessageText(conv, messageId, tr(lang, `✅ Model → <code>${esc(m.id)}</code> (${ctx.st.get(conv).sessionID ? "đã áp dụng" : "áp dụng khi /new"})`, `✅ Model → <code>${esc(m.id)}</code> (${ctx.st.get(conv).sessionID ? "applied" : "applies on /new"})`)).catch(() => {});
      return;
    }
    if (op === "pg") {
      answer();
      if (!messageId) return;
      const v = renderModelPage(mp.models, Number(arg) || 0, undefined, ctx.st.get(conv).model?.id, lang);
      ctx.modelPickers.set(conv, { ...mp, page: Math.max(0, Math.min(Number(arg) || 0, Math.ceil(mp.models.length / MODEL_PAGE_SIZE) - 1)) });
      await ctx.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard }).catch(() => {});
      return;
    }
    // "noop" or unknown
    answer();
  } catch (e) {
    answer(`⚠️ ${(e as Error).message}`);
  }
}

/** The current mode, derived from the session's agent (a curated label). */
export function currentMode(state: ChatState): string | undefined {
  return Object.entries(MODES).find(([, m]) => m.agent === state.agent)?.[0];
}

/** Switch the chat's mode (agent): persist it and apply to the open session. */
export async function applyMode(ctx: BotCtx, conv: ConvKey, state: ChatState, agent: string): Promise<void> {
  ctx.st.set(conv, { agent });
  if (state.sessionID) {
    await ctx.oc.setAgent(state.sessionID, agent).catch((e) => error("setAgent:", e?.message));
  }
}

/** Build the inline "pick a mode" message: a short header + one button per mode. */
export function renderModePicker(state: ChatState, lang: Lang = "vi"): { text: string; keyboard: Keyboard } {
  const cur = currentMode(state);
  const entries = Object.entries(MODES);
  const rows: Btn[][] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row: Btn[] = [];
    for (let j = i; j < Math.min(i + 2, entries.length); j++) {
      const [id] = entries[j];
      row.push({ text: `${cur === id ? "▶️ " : ""}${id}`, callback_data: `mode:${id}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: tr(lang, "❓ Vai trò", "❓ Roles"), callback_data: "mode:info" },
    { text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: "mode:close" },
  ]);
  const curLabel = cur ? `<b>${esc(cur)}</b>` : tr(lang, "<i>chưa chọn</i>", "<i>not set</i>");
  return {
    text: [tr(lang, `<b>Chọn mode</b> — ${curLabel}`, `<b>Choose a mode</b> — ${curLabel}`), tr(lang, "<i>bấm để đổi · mode hiện tại đánh dấu ▶️</i>", "<i>tap to switch · current mode is marked ▶️</i>"), "Hoặc gửi: <code>/mode &lt;id&gt;</code>"].join("\n"),
    keyboard: { inline_keyboard: rows },
  };
}

/**
 * Show the mode picker (inline buttons), or switch straight to `/mode <name>`.
 * A mode is a friendly front-end over the agent; the current mode is derived
 * from the session's agent, so /agent and /mode can never disagree.
 */
export async function cmdMode(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  const want = arg.trim().toLowerCase();
  if (!want) {
    const v = renderModePicker(state, lang);
    await ctx.tg.sendMessage(conv, v.text, { reply_markup: v.keyboard });
    return;
  }
  const m = MODES[want];
  if (!m) {
    const v = renderModePicker(state, lang);
    await ctx.tg.sendMessage(conv, `❌ Unknown mode: <code>${esc(want)}</code>`, { reply_markup: v.keyboard });
    return;
  }
  await applyMode(ctx, conv, state, m.agent);
  const applied = tr(lang, "đã áp dụng", "applied");
  const appliedOnNew = tr(lang, "áp dụng khi /new", "applies on /new");
  const v = renderModePicker(state, lang);
  await ctx.tg.sendMessage(conv, `✅ Mode → <b>${esc(want)}</b> (${state.sessionID ? applied : appliedOnNew})`, { reply_markup: v.keyboard });
}

/** Handle a tap on the mode picker (switch in place, or close the picker). */
export async function handleModeCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId: number | undefined, answer: (toast?: string) => void = (t) => { void ctx.tg.answerCallbackQuery(cb.id, t).catch(() => {}); }): Promise<void> {
  const lang = ctx.userPrefs.getLang(cb.from?.id ?? "");
  const id = (cb.data ?? "").split(":")[1];
  if (id === "close") {
    answer();
    if (messageId) await ctx.tg.deleteMessage(conv, messageId);
    return;
  }
  if (id === "info") {
    answer();
    const lines = Object.entries(MODES).map(([mid, m]) => `• <code>${esc(mid)}</code> — ${esc(m.hintEn === undefined ? m.hint : tr(lang, m.hint, m.hintEn))}`);
    await ctx.tg.sendMessage(conv, tr(lang, "📖 <b>Vai trò các mode</b>", "📖 <b>What each mode does</b>") + "\n" + lines.join("\n"));
    return;
  }
  const m = MODES[id];
  if (!m) {
    answer(`❌ Unknown mode: ${esc(id)}`);
    return;
  }
  const state = ctx.st.get(conv);
  const wasCurrent = currentMode(state) === id;
  try {
    await applyMode(ctx, conv, state, m.agent);
  } catch (e) {
    answer(`⚠️ ${(e as Error).message}`);
    return;
  }
  answer(`Mode → ${id}`);
  if (messageId && !wasCurrent) {
    const v = renderModePicker(state, lang);
    await ctx.tg.editMessageText(conv, messageId, v.text, { reply_markup: v.keyboard });
  }
}

/** `/variants [id]` — list the current model's reasoning variants, or set one. */
export async function cmdVariants(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  const want = arg.trim().toLowerCase();
  const model = await resolveModel(ctx, state, state.sessionID);
  const variants = model ? await ctx.oc.getVariants(model) : [];
  const cur = state.variant ?? ctx.cfg.defaultVariant;

  if (!want) {
    const lines = variants.length
      ? variants.map((v) => `${v === cur ? "▶️ " : ""}<code>${esc(v)}</code>`).join("\n")
      : "<i>(no variants reported for this model)</i>";
    const modelLabel = model ? ` — <code>${esc(model.id)}</code>` : " — <i>no model set</i>";
    await ctx.sendHtml(
      conv,
      `<b>Variants</b>${modelLabel}\n${lines}\n\n<i>current: ${esc(cur)}</i>\nSet with /variants &lt;id&gt;`,
    );
    return;
  }
  if (!model) {
    return ctx.tg.sendMessage(conv, "❌ No model set. Use /model first, then set a variant.");
  }
  if (variants.length && !variants.includes(want)) {
    return ctx.tg.sendMessage(
      conv,
      `❌ Unknown variant <code>${esc(want)}</code>. Available: ${esc(variants.join(", "))}`,
    );
  }
  const how = await applyVariant(ctx, conv, want);
  await ctx.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (${how})`);
}

/**
 * `/variant [id]` — set the reasoning variant, with a button picker when the
 * argument is missing (or unknown). Models without variants keep the plain
 * text answer (delegated to cmdVariants).
 */
export async function cmdVariantSet(ctx: BotCtx, conv: ConvKey, arg: string, state: ChatState): Promise<void> {
  const want = arg.trim().toLowerCase();
  let model: { id: string; providerID: string } | null = null;
  let variants: string[] = [];
  try {
    model = await resolveModel(ctx, state, state.sessionID);
    if (model) variants = await ctx.oc.getVariants(model);
  } catch (e) {
    warn("variant lookup:", (e as Error).message);
  }
  // No model, or the model reports no variants: keep the existing text output.
  if (!model || !variants.length) return cmdVariants(ctx, conv, arg, state);
  const cur = state.variant ?? ctx.cfg.defaultVariant;
  if (!want) return sendVariantPicker(ctx, conv, variants, cur, undefined, ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? ""));
  if (!variants.includes(want)) return sendVariantPicker(ctx, conv, variants, cur, `❌ Unknown variant <code>${esc(want)}</code>`, ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? ""));
  const how = await applyVariant(ctx, conv, want);
  await ctx.tg.sendMessage(conv, `✅ Variant → <code>${esc(want)}</code> (${how})`);
}

/** Apply the variant choice (shared by /variants, /variant and the picker buttons). */
export async function applyVariant(ctx: BotCtx, conv: ConvKey, want: string): Promise<"applied to current session" | "applies on /new"> {
  ctx.st.set(conv, { variant: want });
  const sid = ctx.st.get(conv).sessionID;
  if (sid) {
    await applyModelAndVariant(ctx, sid, ctx.st.get(conv));
    return "applied to current session";
  }
  return "applies on /new";
}

/** The /variant picker card: one button per variant + a hint line. */
export function sendVariantPicker(ctx: BotCtx, conv: ConvKey, variants: string[], cur: string, errorNote?: string, lang: Lang = "vi"): Promise<void> {
  const rows: Btn[][] = [];
  for (let i = 0; i < variants.length; i += 2) {
    rows.push(
      variants.slice(i, i + 2).map((v) => ({ text: `${v === cur ? "▶️ " : ""}${v}`, callback_data: `variant:${v}` })),
    );
  }
  rows.push([{ text: tr(lang, "❌ Đóng", "❌ Close"), callback_data: "variant:close" }]);
  return ctx.tg.sendMessage(
    conv,
    [errorNote ?? tr(lang, "❓ <b>/variant</b> cần tên variant", "❓ <b>/variant</b> needs a variant name"), "Hoặc gửi: <code>/variant &lt;id&gt;</code>"].join("\n"),
    { reply_markup: { inline_keyboard: rows } },
  );
}

/** Handle a tap on the /variant picker (data = `variant:<id|close>`). */
export async function handleVariantCallback(ctx: BotCtx, cb: CallbackQuery, conv: ConvKey, messageId?: number, answer: (toast?: string) => void = (t) => { void ctx.tg.answerCallbackQuery(cb.id, t).catch(() => {}); }): Promise<void> {
  const id = (cb.data ?? "").slice("variant:".length);
  if (id === "close") {
    answer();
    if (messageId) await ctx.tg.deleteMessage(conv, messageId).catch(() => {});
    return;
  }
  try {
    const how = await applyVariant(ctx, conv, id);
    answer(`Variant → ${id}`);
    if (messageId) await ctx.tg.editMessageText(conv, messageId, `✅ Variant → <code>${esc(id)}</code> (${how})`).catch(() => {});
  } catch (e) {
    answer(`⚠️ ${(e as Error).message}`);
  }
}
