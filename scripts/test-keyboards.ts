/**
 * Checks for the inline-keyboard helpers (T3 of docs/sdd/message-layer.md,
 * src/ui/keyboards.ts). Pure functions only — no service or network needed.
 *
 * Covers:
 *   - confirmKeyboard: the [[yes, no]] shape, label clipping (M2.3).
 *   - singleButton: the [[button]] shape.
 *   - backCloseRow: the vi/en close labels + data (M2.1).
 *   - pickerKeyboard: cols 1/2 layout, the "▶️ " current marker, paging
 *     (nav row only while there is more than one page; the middle button
 *     re-requests the same page), the default/custom close row, label
 *     clipping (M2.1/M2.3).
 *   - Purity: same input twice → same output (M3.1).
 *
 * Run:  npx tsx scripts/test-keyboards.ts
 */
import { backCloseRow, BTN_LABEL_MAX, confirmKeyboard, pickerKeyboard, singleButton } from "../src/ui/keyboards.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── confirmKeyboard ─────────────────────────────────────────────────────────
{
  const kb = confirmKeyboard("vi", { text: "✅ Xác nhận", data: "y:1" }, { text: "❌ Huỷ", data: "n:1" });
  check("confirm: shape [[yes, no]]", kb.inline_keyboard.length === 1 && kb.inline_keyboard[0].length === 2);
  check("confirm: yes button", kb.inline_keyboard[0][0].text === "✅ Xác nhận" && kb.inline_keyboard[0][0].callback_data === "y:1");
  check("confirm: no button", kb.inline_keyboard[0][1].text === "❌ Huỷ" && kb.inline_keyboard[0][1].callback_data === "n:1");
  const long = confirmKeyboard("vi", { text: "x".repeat(50), data: "y" }, { text: "n", data: "n" });
  check("confirm: labels clipped to BTN_LABEL_MAX", long.inline_keyboard[0][0].text.length === BTN_LABEL_MAX && long.inline_keyboard[0][0].text.endsWith("…"));
}

// ── singleButton ────────────────────────────────────────────────────────────
{
  const kb = singleButton({ text: "🔨 Sang build", data: "pb:go" });
  check("single: shape [[button]]", kb.inline_keyboard.length === 1 && kb.inline_keyboard[0].length === 1);
  check("single: label + data", kb.inline_keyboard[0][0].text === "🔨 Sang build" && kb.inline_keyboard[0][0].callback_data === "pb:go");
}

// ── backCloseRow ────────────────────────────────────────────────────────────
{
  const vi = backCloseRow("vi", "use:close");
  check("close row: vi label + data", vi.length === 1 && vi[0].text === "❌ Đóng" && vi[0].callback_data === "use:close");
  const en = backCloseRow("en", "mdl:close");
  check("close row: en label", en[0].text === "❌ Close" && en[0].callback_data === "mdl:close");
}

// ── pickerKeyboard: layout ──────────────────────────────────────────────────
{
  const kb = pickerKeyboard("vi", { labels: ["a", "b", "c"], data: (i) => `p:${i}`, current: 1, closeData: "c" });
  check("picker: 2 per row by default", kb.inline_keyboard[0].length === 2 && kb.inline_keyboard[1].length === 1);
  check("picker: current marker", kb.inline_keyboard[0][1].text === "▶️ b");
  check("picker: non-current unmarked", kb.inline_keyboard[0][0].text === "a");
  check("picker: data per absolute index", kb.inline_keyboard[1][0].callback_data === "p:2");
  check("picker: close row last", kb.inline_keyboard[2].length === 1 && kb.inline_keyboard[2][0].text === "❌ Đóng" && kb.inline_keyboard[2][0].callback_data === "c");
  const one = pickerKeyboard("vi", { labels: ["a", "b"], data: (i) => `p:${i}`, cols: 1, close: false });
  check("picker: cols 1 → one per row", one.inline_keyboard.length === 2 && one.inline_keyboard.every((r) => r.length === 1));
  check("picker: close: false → no close row", !one.inline_keyboard.some((r) => r[0].text === "❌ Đóng"));
  let threw = false;
  try {
    pickerKeyboard("vi", { labels: ["a"], data: (i) => `p:${i}` });
  } catch {
    threw = true;
  }
  check("picker: close on without closeData throws", threw);
}

// ── pickerKeyboard: paging ──────────────────────────────────────────────────
{
  const labels = Array.from({ length: 25 }, (_, i) => `o${i}`);
  const pageData = (p: number) => `pg:${p}`;
  const kb = pickerKeyboard("vi", { labels, data: (i) => `o:${i}`, page: 1, pageData, closeData: "c" });
  const rows = kb.inline_keyboard;
  const flat = rows.slice(0, 5).flat();
  check("picker: 10 options on the page", flat.length === 10);
  check("picker: data uses absolute index", flat[0].callback_data === "o:10" && flat[9].callback_data === "o:19");
  const nav = rows[5];
  check("picker: nav row [⬅️, 2/3, ➡️]", nav.length === 3 && nav[0].text === "⬅️" && nav[0].callback_data === "pg:0" && nav[1].text === "2/3" && nav[1].callback_data === "pg:1" && nav[2].text === "➡️" && nav[2].callback_data === "pg:2");
  check("picker: close after nav", rows[6].length === 1 && rows[6][0].text === "❌ Đóng");
  const first = pickerKeyboard("vi", { labels, data: (i) => `o:${i}`, page: 0, pageData, closeData: "c" });
  check("picker: first page has no ⬅️", first.inline_keyboard[5].length === 2 && first.inline_keyboard[5][0].text === "1/3" && first.inline_keyboard[5][0].callback_data === "pg:0" && first.inline_keyboard[5][1].text === "➡️" && first.inline_keyboard[5][1].callback_data === "pg:1");
  const last = pickerKeyboard("vi", { labels, data: (i) => `o:${i}`, page: 2, pageData, closeData: "c" });
  const lastRows = last.inline_keyboard;
  check("picker: last page: 5 options, no ➡️", lastRows.slice(0, 3).flat().length === 5 && lastRows[3].length === 2 && lastRows[3][0].text === "⬅️" && lastRows[3][1].text === "3/3");
  const fits = pickerKeyboard("vi", { labels, data: (i) => `o:${i}`, pageSize: 25, pageData, closeData: "c" });
  check("picker: everything fits → no nav row", fits.inline_keyboard.length === 14 && !fits.inline_keyboard.some((r) => r.some((b) => /^\d+\/\d+$/.test(b.text))));
}

// ── pickerKeyboard: clipping ────────────────────────────────────────────────
{
  const clipped = pickerKeyboard("vi", { labels: ["x".repeat(50)], data: (i) => `p:${i}`, close: false });
  check("picker: labels clipped", clipped.inline_keyboard[0][0].text.length === BTN_LABEL_MAX && clipped.inline_keyboard[0][0].text.endsWith("…"));
  const marked = pickerKeyboard("vi", { labels: ["x".repeat(50)], data: (i) => `p:${i}`, current: 0, close: false });
  check("picker: marker prepended to the clipped label", marked.inline_keyboard[0][0].text === `▶️ ${"x".repeat(BTN_LABEL_MAX - 1)}…`);
}

// ── purity (M3.1) ───────────────────────────────────────────────────────────
{
  const a = pickerKeyboard("vi", { labels: ["a", "b"], data: (i) => `o:${i}`, closeData: "c" });
  const b = pickerKeyboard("vi", { labels: ["a", "b"], data: (i) => `o:${i}`, closeData: "c" });
  check("pure: same input twice → same output", JSON.stringify(a) === JSON.stringify(b));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
